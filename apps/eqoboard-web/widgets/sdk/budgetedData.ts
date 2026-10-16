import type { WidgetLifecycle, WidgetRefreshPolicyV1 } from "./contracts";
import type { WidgetDataClient, WidgetOperationDefinition, WidgetOperationMap } from "./data";
import type { WidgetPollBudget, WidgetPollRequest } from "./pollBudget";

const DIRECT_READ_DEFAULTS: Omit<WidgetPollRequest["policy"], "mode" | "maxConcurrentRequests"> =
  Object.freeze({
    minIntervalMs: 1_000,
    maxRequestsPerMinute: 30,
    whenHidden: "pause" as const,
  });
const MAX_MANUAL_DIRECT_READS = 3 as const;
const budgetedClients = new WeakSet<object>();

/** Host-derived, non-secret namespace plus one widget's manifest/runtime scope. */
export type WidgetBudgetedReadScope = Readonly<{
  scopeKey: string;
  instanceId: string;
  manifestRefresh: WidgetRefreshPolicyV1;
  lifecycle: WidgetLifecycle;
  hidden: boolean;
}>;

/** Runtime identity check used to make unbudgeted scoped host wiring fail closed. */
export function isBudgetedWidgetDataClient(value: unknown): boolean {
  return value !== null && typeof value === "object" && budgetedClients.has(value);
}

function directReadPolicy(manifestRefresh: WidgetRefreshPolicyV1): WidgetPollRequest["policy"] {
  if (manifestRefresh.mode === "poll") {
    return {
      mode: "poll",
      minIntervalMs: manifestRefresh.minIntervalMs,
      maxRequestsPerMinute: manifestRefresh.maxRequestsPerMinute,
      maxConcurrentRequests: 1,
      // Explicit reads are UI-driven. Hidden tabs pause them even when a manifest
      // opts into continued host-scheduled refreshes.
      whenHidden: "pause",
    };
  }
  return {
    mode: "poll",
    ...DIRECT_READ_DEFAULTS,
    // Manual widgets may fan out to three independent reads. Shared-market
    // direct reads retain single-request concurrency.
    maxConcurrentRequests: manifestRefresh.mode === "none" ? MAX_MANUAL_DIRECT_READS : 1,
  };
}

/**
 * Applies the shared host budget to direct reads from one widget instance.
 * Refresh schedulers keep their own single budget call and must use the raw
 * host client, not this wrapper, to avoid double-counting.
 */
export function createBudgetedWidgetDataClient<
  TOperations extends {
    readonly [K in keyof TOperations]: WidgetOperationDefinition;
  } = WidgetOperationMap,
>(
  data: WidgetDataClient<TOperations>,
  budget: WidgetPollBudget,
  scope: WidgetBudgetedReadScope,
): WidgetDataClient<TOperations> {
  const policy = directReadPolicy(scope.manifestRefresh);
  const { scopeKey, instanceId, lifecycle, hidden } = scope;
  const client: WidgetDataClient<TOperations> = Object.freeze({
    read<K extends keyof TOperations & string>(
      operationId: K,
      input: TOperations[K]["input"],
      options: Readonly<{ signal: AbortSignal }>,
    ): Promise<TOperations[K]["output"]> {
      return budget.run(
        {
          scopeKey,
          instanceId,
          operationId,
          input,
          policy,
          lifecycle,
          hidden,
          signal: options.signal,
        },
        (signal) => data.read(operationId, input, { signal }),
      );
    },
  });
  budgetedClients.add(client);
  return client;
}
