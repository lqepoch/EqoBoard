import type { AuthUiSnapshot, Permission } from "../../lib/contracts/auth";
import { parseResearchAiResponse } from "../research/ai";
import { WidgetDataReadError } from "../../widgets/sdk/data";
import type { WidgetActionClient, WidgetActionId } from "../../widgets/sdk/actions";
import { buildNativeActionRequest, type NativeActionMap } from "./operations";
import type { NativeFetch } from "./read-client";
import { decodePortfolio, decodePortfolioTransaction } from "./portfolio-decoder";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;

async function readActionJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) throw new WidgetDataReadError("request-failed");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json"))
    throw new WidgetDataReadError("request-failed");
  const reader = response.body?.getReader();
  if (!reader) throw new WidgetDataReadError("request-failed");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new WidgetDataReadError("cancelled");
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WidgetDataReadError("request-failed");
      }
      chunks.push(result.value);
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new WidgetDataReadError("request-failed");
  }
}

/** The only client action transport. Actions are bounded POSTs, never arbitrary URLs. */
export function createNativeActionClient(
  getAuth: () => AuthUiSnapshot,
  fetcher: NativeFetch = fetch,
  now: () => number = Date.now,
): WidgetActionClient<NativeActionMap> {
  const requestTimes: number[] = [];
  const actionTimes = new Map<keyof NativeActionMap, number[]>();
  return Object.freeze({
    async invoke<ActionId extends keyof NativeActionMap & WidgetActionId>(
      actionId: ActionId,
      input: NativeActionMap[ActionId]["input"],
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<NativeActionMap[ActionId]["output"]> {
      if (options.signal.aborted) throw new WidgetDataReadError("cancelled");
      const request = buildNativeActionRequest(actionId, input);
      if (!request) throw new WidgetDataReadError("request-failed");
      const auth = getAuth();
      if (
        auth.runtimeMode === "research" ||
        !auth.authenticated ||
        !auth.permissions.includes(request.permission as Permission)
      ) {
        throw new WidgetDataReadError("request-failed");
      }
      let body: string;
      try {
        body = request.body === undefined ? "" : JSON.stringify(request.body);
      } catch {
        throw new WidgetDataReadError("request-failed");
      }
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      const maxBodyBytes =
        actionId === "research.ai"
          ? 16 * 1024
          : actionId === "portfolio.create"
            ? 4 * 1024
            : actionId === "portfolio.transaction.create"
              ? 8 * 1024
              : 32 * 1024;
      if (bodyBytes > maxBodyBytes) throw new WidgetDataReadError("request-failed");

      const time = now();
      while (requestTimes.length > 0 && time - requestTimes[0]! >= WINDOW_MS) requestTimes.shift();
      const priorActionTimes = (actionTimes.get(actionId) ?? []).filter(
        (entry) => time - entry < WINDOW_MS,
      );
      const limit = actionId === "research.ai" ? 10 : MAX_REQUESTS;
      if (requestTimes.length >= MAX_REQUESTS || priorActionTimes.length >= limit) {
        const oldest =
          requestTimes.length >= MAX_REQUESTS ? requestTimes[0]! : priorActionTimes[0]!;
        throw new WidgetDataReadError("rate-limited", Math.max(1, oldest + WINDOW_MS - time));
      }
      requestTimes.push(time);
      actionTimes.set(actionId, [...priorActionTimes, time]);
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (request.body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetcher(request.path, {
          method: request.method,
          credentials: "same-origin",
          mode: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers,
          ...(request.body !== undefined ? { body } : {}),
          signal: options.signal,
        });
        if (request.method === "DELETE") {
          if (
            response.status !== 204 ||
            (response.headers.has("content-length") &&
              response.headers.get("content-length") !== "0")
          ) {
            throw new WidgetDataReadError("request-failed");
          }
          return undefined as NativeActionMap[ActionId]["output"];
        }
        const result = await readActionJson(response, 64 * 1024, options.signal);
        if (actionId === "research.ai") {
          const decoded = parseResearchAiResponse(result);
          if (!decoded) throw new WidgetDataReadError("request-failed");
          return decoded as NativeActionMap[ActionId]["output"];
        }
        if (actionId === "portfolio.create") {
          const decoded = decodePortfolio(result);
          if (!decoded) throw new WidgetDataReadError("request-failed");
          return decoded as NativeActionMap[ActionId]["output"];
        }
        if (actionId === "portfolio.transaction.create") {
          const decoded = decodePortfolioTransaction(result);
          if (!decoded) throw new WidgetDataReadError("request-failed");
          return decoded as NativeActionMap[ActionId]["output"];
        }
        return result as NativeActionMap[ActionId]["output"];
      } catch (error) {
        if (options.signal.aborted) throw new WidgetDataReadError("cancelled");
        if (error instanceof WidgetDataReadError) throw error;
        throw new WidgetDataReadError("request-failed");
      }
    },
  });
}
