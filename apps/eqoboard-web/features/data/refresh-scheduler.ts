import type {
  WidgetLifecycle,
  WidgetRefreshPolicyV1,
} from "../../widgets/sdk/contracts";
import {
  WidgetDataReadError,
  type WidgetDataClient,
  type WidgetOperationDefinition,
  type WidgetRefreshScheduler,
  type WidgetScheduledReadState,
} from "../../widgets/sdk/data";
import type { WidgetPollBudget } from "../../widgets/sdk/pollBudget";

const GLOBAL_MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60 * 60 * 1_000;

export type RefreshScope = Readonly<{ instanceId: string; hidden: boolean }>;

/** Creates a per-widget timer view while all requests still pass through one host client. */
export function createNativeRefreshScheduler<
  TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition },
>(
  data: WidgetDataClient<TOperations>,
  policy: WidgetRefreshPolicyV1,
  lifecycle: WidgetLifecycle,
  scope: RefreshScope,
  budget: WidgetPollBudget,
  scopeKey: string,
): WidgetRefreshScheduler<TOperations> {
  let readQueue: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = readQueue.then(operation, operation);
    readQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({
    observe<K extends keyof TOperations & string>(
      operationId: K,
      input: TOperations[K]["input"],
      options: Readonly<{ refreshIntervalMs: number }>,
      listener: (state: WidgetScheduledReadState<TOperations[K]["output"]>) => void,
    ): () => void {
      if (policy.mode !== "poll" || (scope.hidden && policy.whenHidden === "pause")) return () => undefined;
      const maxPerMinuteInterval = Math.ceil(60_000 / Math.max(1, policy.maxRequestsPerMinute));
      const refreshIntervalMs = Number.isSafeInteger(options.refreshIntervalMs) && options.refreshIntervalMs > 0
        ? options.refreshIntervalMs
        : policy.minIntervalMs;
      // Browser timers overflow near 2^31ms and can fire immediately. The host
      // clamps every widget request to a finite, reviewable ceiling.
      const interval = Math.min(MAX_INTERVAL_MS, Math.max(
        GLOBAL_MIN_INTERVAL_MS,
        policy.minIntervalMs,
        maxPerMinuteInterval,
        refreshIntervalMs,
      ));
      let active = true;
      let inFlight = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      let unsubscribeLifecycle: (() => void) | null = null;

      const publish = (state: WidgetScheduledReadState<TOperations[K]["output"]>) => {
        try {
          listener(state);
        } catch {
          // A view listener cannot stop future host refreshes.
        }
      };

      const stopTimer = () => {
        if (timer) clearInterval(timer);
        timer = null;
      };

      const schedule = () => {
        stopTimer();
        if (!active || lifecycle.getSnapshot().phase !== "active") return;
        timer = setInterval(() => void run(), interval);
      };

      const run = async () => {
        if (!active || inFlight) return;
        const snapshot = lifecycle.getSnapshot();
        if (snapshot.phase !== "active" || snapshot.signal.aborted) return;
        inFlight = true;
        publish({ status: "pending" });
        try {
          const value = await enqueue(() => {
            if (!active) throw new WidgetDataReadError("cancelled");
            return budget.run({
              scopeKey,
              instanceId: scope.instanceId,
              operationId,
              input,
              policy,
              lifecycle,
              hidden: scope.hidden,
            }, (signal) => data.read(operationId, input, { signal }));
          });
          const current = lifecycle.getSnapshot();
          if (!active || current.phase !== "active" || current.generation !== snapshot.generation || snapshot.signal.aborted) return;
          publish({ status: "ready", value });
        } catch (error) {
          const current = lifecycle.getSnapshot();
          if (!active || current.phase !== "active" || current.generation !== snapshot.generation) return;
          if (error instanceof WidgetDataReadError && ["cancelled", "suspended", "disposed", "hidden"].includes(error.code)) return;
          const rateLimited = error instanceof WidgetDataReadError && error.code === "rate-limited";
          publish({
            status: "error",
            code: rateLimited ? "rate-limited" : "request-failed",
            ...(rateLimited && error.retryAfterMs ? { retryAfterMs: Math.min(error.retryAfterMs, interval) } : {}),
          });
        } finally {
          inFlight = false;
        }
      };

      const lifecycleChanged = () => {
        const phase = lifecycle.getSnapshot().phase;
        if (phase === "active") {
          schedule();
          void run();
        } else {
          stopTimer();
          publish({ status: "pending" });
        }
      };

      publish({ status: "pending" });
      unsubscribeLifecycle = lifecycle.subscribe(lifecycleChanged);
      if (lifecycle.getSnapshot().phase === "active") {
        schedule();
        void run();
      }

      return () => {
        if (!active) return;
        active = false;
        stopTimer();
        unsubscribeLifecycle?.();
        unsubscribeLifecycle = null;
      };
    },
  });
}
