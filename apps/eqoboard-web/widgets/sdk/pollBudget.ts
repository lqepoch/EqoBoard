import type { WidgetLifecycle, WidgetRefreshPolicyV1 } from "./contracts";
import { WidgetDataReadError } from "./data";

const WINDOW_MS = 60_000;
const MAX_CONCURRENT_GLOBAL = 128;
const MAX_CONCURRENT_PER_OPERATION = 32;
const MAX_REQUESTS_PER_MINUTE = 120;
const MAX_INTERVAL_MS = 3_600_000;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATION_ID = /^[A-Za-z][A-Za-z0-9.-]{0,95}$/u;

export type WidgetPollBudgetConfig = Readonly<{
  /** Host-owned ceilings. Manifest policy can only lower these limits. */
  maxConcurrentGlobal: number;
  maxConcurrentPerOperation: number;
  maxConcurrentPerWidget: 1;
  maxRequestsPerMinuteGlobal: number;
  maxRequestsPerMinutePerUser: number;
  maxRequestsPerMinutePerOperation: number;
  maxRequestsPerMinutePerWidget: number;
  minimumIntervalMs: number;
}>;

export type WidgetPollRequest = Readonly<{
  /** Opaque auth/cache partition supplied by the host; never a credential or ownership proof. */
  scopeKey: string;
  instanceId: string;
  operationId: string;
  input: unknown;
  policy: Extract<WidgetRefreshPolicyV1, { mode: "poll" }>;
  lifecycle: WidgetLifecycle;
  hidden: boolean;
}>;

export interface WidgetPollBudget {
  run<T>(request: WidgetPollRequest, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

function validConfig(config: WidgetPollBudgetConfig): boolean {
  return Number.isSafeInteger(config.maxConcurrentGlobal) && config.maxConcurrentGlobal >= 1 &&
    config.maxConcurrentGlobal <= MAX_CONCURRENT_GLOBAL &&
    Number.isSafeInteger(config.maxConcurrentPerOperation) && config.maxConcurrentPerOperation >= 1 &&
    config.maxConcurrentPerOperation <= MAX_CONCURRENT_PER_OPERATION &&
    config.maxConcurrentPerWidget === 1 &&
    [
      config.maxRequestsPerMinuteGlobal,
      config.maxRequestsPerMinutePerUser,
      config.maxRequestsPerMinutePerOperation,
      config.maxRequestsPerMinutePerWidget,
    ].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_REQUESTS_PER_MINUTE) &&
    Number.isSafeInteger(config.minimumIntervalMs) && config.minimumIntervalMs >= 0 &&
    config.minimumIntervalMs <= MAX_INTERVAL_MS;
}

function validPollPolicy(policy: WidgetRefreshPolicyV1): boolean {
  return policy.mode === "poll" && Number.isSafeInteger(policy.minIntervalMs) &&
    policy.minIntervalMs >= 250 && policy.minIntervalMs <= MAX_INTERVAL_MS &&
    Number.isSafeInteger(policy.maxRequestsPerMinute) &&
    policy.maxRequestsPerMinute >= 1 && policy.maxRequestsPerMinute <= MAX_REQUESTS_PER_MINUTE &&
    policy.maxConcurrentRequests === 1 &&
    (policy.whenHidden === "pause" || policy.whenHidden === "continue");
}

type StableKeyBudget = { nodes: number; chars: number };

function stableKey(value: unknown, depth = 0, budget: StableKeyBudget = { nodes: 0, chars: 0 }): string | null {
  budget.nodes += 1;
  if (budget.nodes > 4096 || depth > 16 || budget.chars > 32_768) return null;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > 8_192) return null;
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    budget.chars += encoded.length;
    return budget.chars <= 32_768 ? encoded : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const encoded = JSON.stringify(value);
    budget.chars += encoded.length;
    return budget.chars <= 32_768 ? encoded : null;
  }
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.length > 4_097) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > 4_096) return null;
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1) return null;
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) return null;
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      }
      const parts: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) return null;
        const part = stableKey(descriptor.value, depth + 1, budget);
        if (part === null) return null;
        parts.push(part);
      }
      budget.chars += 2 + Math.max(0, parts.length - 1);
      return budget.chars <= 32_768 ? `[${parts.join(",")}]` : null;
    }
    if (typeof value !== "object") return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 256 || keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const parts: string[] = [];
    for (const key of (keys as string[]).sort()) {
      if (key.length > 256 || ["__proto__", "constructor", "prototype"].includes(key)) return null;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      const part = stableKey(descriptor.value, depth + 1, budget);
      if (part === null) return null;
      const encodedKey = JSON.stringify(key);
      budget.chars += encodedKey.length + 1;
      if (budget.chars > 32_768) return null;
      parts.push(`${encodedKey}:${part}`);
    }
    budget.chars += 2 + Math.max(0, parts.length - 1);
    return budget.chars <= 32_768 ? `{${parts.join(",")}}` : null;
  } catch {
    return null;
  }
}

function prune(timestamps: number[], now: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
}

function nextWindowDelay(timestamps: readonly number[], now: number): number {
  return Math.max(1, Math.min(...timestamps) + WINDOW_MS - now);
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

/**
 * Host-side poll gate. It owns no timers and does not perform transport; the host
 * schedules refresh attempts and supplies the already-closed operation callback.
 */
export function createWidgetPollBudget(
  config: WidgetPollBudgetConfig,
  now: () => number = Date.now,
): WidgetPollBudget {
  if (!validConfig(config)) throw new TypeError("Invalid widget poll budget configuration.");
  const globalTimes: number[] = [];
  const operationTimes = new Map<string, number[]>();
  const widgetTimes = new Map<string, number[]>();
  const lastReadAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<unknown>>();
  const operationCounts = new Map<string, number>();
  const widgetCounts = new Map<string, number>();
  const scopedUserTimes = new Map<string, number[]>();
  const lifecycleIds = new WeakMap<WidgetLifecycle, number>();
  let nextLifecycleId = 1;
  let globalCount = 0;

  return Object.freeze({
    async run<T>(request: WidgetPollRequest, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (!request || typeof request.instanceId !== "string" || !INSTANCE_ID.test(request.instanceId) ||
          typeof request.operationId !== "string" || !OPERATION_ID.test(request.operationId) ||
          !validPollPolicy(request.policy)) {
        throw new WidgetDataReadError("request-failed");
      }
      const snapshot = request.lifecycle.getSnapshot();
      if (snapshot.phase === "disposed") throw new WidgetDataReadError("disposed");
      if (snapshot.phase !== "active" || snapshot.signal.aborted) throw new WidgetDataReadError("suspended");
      if (request.hidden && request.policy.whenHidden === "pause") throw new WidgetDataReadError("hidden");
      if (typeof request.scopeKey !== "string" || request.scopeKey.length === 0 ||
          request.scopeKey.length > 256 || request.scopeKey !== request.scopeKey.trim() ||
          /[\u0000-\u001f\u007f]/u.test(request.scopeKey)) {
        throw new WidgetDataReadError("request-failed");
      }

      const inputKey = stableKey({
        scopeKey: request.scopeKey,
        instanceId: request.instanceId,
        operationId: request.operationId,
        input: request.input,
      });
      if (inputKey === null) throw new WidgetDataReadError("request-failed");
      let lifecycleId = lifecycleIds.get(request.lifecycle);
      if (lifecycleId === undefined) {
        lifecycleId = nextLifecycleId;
        nextLifecycleId += 1;
        lifecycleIds.set(request.lifecycle, lifecycleId);
      }
      const dedupeKey = `${lifecycleId}:${snapshot.generation}:${inputKey}`;
      const existing = inFlight.get(dedupeKey);
      if (existing) return existing as Promise<T>;

      const time = now();
      const operationKey = request.operationId;
      const widgetKey = stableKey({ scopeKey: request.scopeKey, instanceId: request.instanceId });
      if (widgetKey === null) throw new WidgetDataReadError("request-failed");
      const rateLimit = Math.min(
        request.policy.maxRequestsPerMinute,
        config.maxRequestsPerMinuteGlobal,
        config.maxRequestsPerMinutePerUser,
        config.maxRequestsPerMinutePerOperation,
        config.maxRequestsPerMinutePerWidget,
      );
      const global = prune(globalTimes, time);
      const user = prune(scopedUserTimes.get(request.scopeKey) ?? [], time);
      const perOperation = prune(operationTimes.get(operationKey) ?? [], time);
      const perWidget = prune(widgetTimes.get(widgetKey) ?? [], time);
      globalTimes.splice(0, globalTimes.length, ...global);
      scopedUserTimes.set(request.scopeKey, user);
      operationTimes.set(operationKey, perOperation);
      widgetTimes.set(widgetKey, perWidget);

      const rateCeilings = [
        [global, config.maxRequestsPerMinuteGlobal],
        [user, config.maxRequestsPerMinutePerUser],
        [perOperation, Math.min(config.maxRequestsPerMinutePerOperation, rateLimit)],
        [perWidget, Math.min(config.maxRequestsPerMinutePerWidget, rateLimit)],
      ] as const;
      for (const [timestamps, limit] of rateCeilings) {
        if (timestamps.length >= limit) throw new WidgetDataReadError("rate-limited", nextWindowDelay(timestamps, time));
      }

      const interval = Math.max(config.minimumIntervalMs, request.policy.minIntervalMs);
      const prior = lastReadAt.get(`${widgetKey}:${operationKey}`);
      if (prior !== undefined && time - prior < interval) {
        throw new WidgetDataReadError("rate-limited", interval - (time - prior));
      }

      if (globalCount >= config.maxConcurrentGlobal ||
          (operationCounts.get(operationKey) ?? 0) >= config.maxConcurrentPerOperation ||
          (widgetCounts.get(widgetKey) ?? 0) >= config.maxConcurrentPerWidget) {
        throw new WidgetDataReadError("concurrency-limited");
      }

      globalTimes.push(time);
      user.push(time);
      perOperation.push(time);
      perWidget.push(time);
      lastReadAt.set(`${widgetKey}:${operationKey}`, time);
      globalCount += 1;
      bump(operationCounts, operationKey, 1);
      bump(widgetCounts, widgetKey, 1);

      const execute = async (): Promise<T> => {
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new WidgetDataReadError("cancelled"));
          abortListener = onAbort;
          if (snapshot.signal.aborted) onAbort();
          else snapshot.signal.addEventListener("abort", onAbort, { once: true });
        });
        const work = Promise.resolve().then(() => {
          if (snapshot.signal.aborted) throw new WidgetDataReadError("cancelled");
          return operation(snapshot.signal);
        });
        // If the signal wins, a late work rejection is still observed.
        void work.catch(() => undefined);
        try {
          const result = await Promise.race([work, aborted]);
          const after = request.lifecycle.getSnapshot();
          if (after.phase !== "active" || after.generation !== snapshot.generation || snapshot.signal.aborted) {
            throw new WidgetDataReadError("cancelled");
          }
          return result;
        } catch (error) {
          if (snapshot.signal.aborted) throw new WidgetDataReadError("cancelled");
          throw error;
        } finally {
          if (abortListener) snapshot.signal.removeEventListener("abort", abortListener);
          globalCount -= 1;
          bump(operationCounts, operationKey, -1);
          bump(widgetCounts, widgetKey, -1);
          inFlight.delete(dedupeKey);
        }
      };

      const promise = execute();
      inFlight.set(dedupeKey, promise);
      return promise;
    },
  });
}
