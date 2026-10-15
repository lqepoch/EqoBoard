import type { AuthUiSnapshot, Permission } from "../../lib/contracts/auth";
import { WidgetDataReadError } from "../../widgets/sdk/data";
import type { WidgetDataClient } from "../../widgets/sdk/data";
import { buildNativeReadRequest, type NativeDataOperationId, type NativeDataOperationMap } from "./operations";
import { decodePortfolioList, decodePortfolioPositions, decodePortfolioTransactions } from "./portfolio-decoder";
import { isNativeReadAllowedInRuntime } from "./runtime-policy";

const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;
const MAX_CONCURRENT = 8;
const MAX_CONCURRENT_PER_OPERATION = 3;
const MAX_BYTES_BY_OPERATION: Readonly<Record<NativeDataOperationId, number>> = Object.freeze({
  "market.quotes": 1024 * 1024,
  "market.options.chain": 2 * 1024 * 1024,
  "market.status": 512 * 1024,
  "market.history.core-bars": 4 * 1024 * 1024,
  "market.archive.diagnostic-bars": 4 * 1024 * 1024,
  "research.yahoo.daily": 4 * 1024 * 1024,
  "research.predictions": 512 * 1024,
  "engine.status": 16 * 1024,
  "engine.preview": 16 * 1024,
  "research.news": 2 * 1024 * 1024,
  "research.macro": 2 * 1024 * 1024,
  "research.economicCalendar": 2 * 1024 * 1024,
  "research.earningsCalendar": 2 * 1024 * 1024,
  "research.earningsHistory": 2 * 1024 * 1024,
  "research.insider": 2 * 1024 * 1024,
  "research.screener": 4 * 1024 * 1024,
  "research.heatmap": 4 * 1024 * 1024,
  "research.crypto": 2 * 1024 * 1024,
  "research.cryptoGlobal": 2 * 1024 * 1024,
  "portfolio.list": 2 * 1024 * 1024,
  "portfolio.positions": 2 * 1024 * 1024,
  "portfolio.transactions": 4 * 1024 * 1024,
});

export type NativeFetch = (input: string, init: RequestInit) => Promise<Response>;

type SharedRead = {
  readonly controller: AbortController;
  readonly operationId: NativeDataOperationId;
  readonly key: string;
  readonly consumers: Set<symbol>;
  promise: Promise<unknown>;
  settled: boolean;
};

function permissionGranted(auth: AuthUiSnapshot, permission: Permission): boolean {
  return auth.authenticated && auth.permissions.includes(permission);
}

export async function readNativeJsonResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) throw new WidgetDataReadError("request-failed");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new WidgetDataReadError("request-failed");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new WidgetDataReadError("request-failed");
  }
  if (!response.body) throw new WidgetDataReadError("request-failed");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new WidgetDataReadError("cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WidgetDataReadError("request-failed");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) throw new WidgetDataReadError("cancelled");
    if (error instanceof WidgetDataReadError) throw error;
    throw new WidgetDataReadError("request-failed");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new WidgetDataReadError("request-failed");
  }
}

function decodeNativeReadOutput<Id extends NativeDataOperationId>(
  operationId: Id,
  value: unknown,
): NativeDataOperationMap[Id]["output"] {
  if (operationId === "portfolio.list") {
    const decoded = decodePortfolioList(value);
    if (!decoded) throw new WidgetDataReadError("request-failed");
    return decoded as NativeDataOperationMap[Id]["output"];
  }
  if (operationId === "portfolio.positions") {
    const decoded = decodePortfolioPositions(value);
    if (!decoded) throw new WidgetDataReadError("request-failed");
    return decoded as NativeDataOperationMap[Id]["output"];
  }
  if (operationId === "portfolio.transactions") {
    const decoded = decodePortfolioTransactions(value);
    if (!decoded) throw new WidgetDataReadError("request-failed");
    return decoded as NativeDataOperationMap[Id]["output"];
  }
  return value as NativeDataOperationMap[Id]["output"];
}

function callerPromise<T>(
  shared: SharedRead,
  callerSignal: AbortSignal,
): Promise<T> {
  const token = Symbol("market-read-consumer");
  shared.consumers.add(token);
  if (callerSignal.aborted) {
    shared.consumers.delete(token);
    if (shared.consumers.size === 0 && !shared.settled) shared.controller.abort();
    return Promise.reject(new WidgetDataReadError("cancelled"));
  }

  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      callerSignal.removeEventListener("abort", onAbort);
      shared.consumers.delete(token);
      if (shared.consumers.size === 0 && !shared.settled) shared.controller.abort();
    };
    const onAbort = () => {
      release();
      reject(new WidgetDataReadError("cancelled"));
    };
    callerSignal.addEventListener("abort", onAbort, { once: true });
    shared.promise.then(
      (value) => {
        if (finished) return;
        release();
        resolve(value as T);
      },
      (error: unknown) => {
        if (finished) return;
        release();
        reject(error);
      },
    );
  });
}

/**
 * One host-owned bounded read client. It compiles a closed operation ID into a
 * fixed same-origin route and shares identical in-flight requests across widgets.
 */
export function createNativeDataReadClient(
  getAuth: () => AuthUiSnapshot,
  fetcher: NativeFetch = fetch,
  now: () => number = Date.now,
): WidgetDataClient<NativeDataOperationMap> {
  const inflight = new Map<string, SharedRead>();
  const requestTimes: number[] = [];
  const operationCounts = new Map<NativeDataOperationId, number>();
  let concurrentCount = 0;

  const start = (operationId: NativeDataOperationId, key: string, path: string): SharedRead => {
    const controller = new AbortController();
    const shared: SharedRead = {
      controller,
      operationId,
      key,
      consumers: new Set(),
      promise: Promise.resolve(undefined),
      settled: false,
    };
    concurrentCount += 1;
    operationCounts.set(operationId, (operationCounts.get(operationId) ?? 0) + 1);
    requestTimes.push(now());

    shared.promise = Promise.resolve()
      .then(() => fetcher(path, {
        method: "GET",
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      }))
      .then(async (response) => decodeNativeReadOutput(
        operationId,
        await readNativeJsonResponse(response, MAX_BYTES_BY_OPERATION[operationId], controller.signal),
      ))
      .catch((error: unknown) => {
        if (controller.signal.aborted) throw new WidgetDataReadError("cancelled");
        if (error instanceof WidgetDataReadError) throw error;
        throw new WidgetDataReadError("request-failed");
      })
      .finally(() => {
        shared.settled = true;
        concurrentCount = Math.max(0, concurrentCount - 1);
        const current = operationCounts.get(operationId) ?? 0;
        if (current <= 1) operationCounts.delete(operationId);
        else operationCounts.set(operationId, current - 1);
        if (inflight.get(key) === shared) inflight.delete(key);
      });
    inflight.set(key, shared);
    // A cancelled last subscriber can abort while the fetch is being scheduled.
    void shared.promise.catch(() => undefined);
    return shared;
  };

  return Object.freeze({
    async read<Id extends keyof NativeDataOperationMap & string>(
      operationId: Id,
      input: NativeDataOperationMap[Id]["input"],
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<NativeDataOperationMap[Id]["output"]> {
      if (options.signal.aborted) throw new WidgetDataReadError("cancelled");
      const request = buildNativeReadRequest(operationId, input);
      if (!request) throw new WidgetDataReadError("request-failed");
      const auth = getAuth();
      if (!isNativeReadAllowedInRuntime(operationId, auth.runtimeMode) ||
          !permissionGranted(auth, request.permission)) throw new WidgetDataReadError("request-failed");

      // An identical URL requested after an account switch must not join the
      // prior identity's promise, even while its fetch is still draining.
      const requestKey = `${auth.storagePartition ?? "anonymous"}\u001f${request.path}`;

      const current = inflight.get(requestKey);
      if (current) return callerPromise(current, options.signal) as Promise<NativeDataOperationMap[Id]["output"]>;

      const time = now();
      while (requestTimes.length > 0 && time - requestTimes[0]! >= RATE_WINDOW_MS) requestTimes.shift();
      if (requestTimes.length >= MAX_REQUESTS_PER_WINDOW) {
        throw new WidgetDataReadError("rate-limited", Math.max(1, requestTimes[0]! + RATE_WINDOW_MS - time));
      }
      if (concurrentCount >= MAX_CONCURRENT || (operationCounts.get(operationId) ?? 0) >= MAX_CONCURRENT_PER_OPERATION) {
        throw new WidgetDataReadError("concurrency-limited");
      }

      return callerPromise(start(operationId, requestKey, request.path), options.signal) as Promise<NativeDataOperationMap[Id]["output"]>;
    },
  });
}
