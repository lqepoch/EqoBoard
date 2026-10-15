import { describe, expect, it } from "vitest";

import type { NativeDataOperationMap } from "./operations";
import { createNativeRefreshScheduler } from "./refresh-scheduler";
import { createWidgetPollBudget } from "../../widgets/sdk/pollBudget";
import { createWidgetLifecycleController } from "../../widgets/sdk/lifecycle";
import type { WidgetDataClient } from "../../widgets/sdk/data";

const POLICY = Object.freeze({
  mode: "poll",
  minIntervalMs: 30_000,
  maxRequestsPerMinute: 4,
  maxConcurrentRequests: 1,
  whenHidden: "pause",
} as const);

const INSTANCE_ID = "d23a76c1-89f4-4e33-982f-35d8f2ac8124";

describe("native refresh scheduler", () => {
  it("serializes concurrent per-widget observers through the shared one-request budget", async () => {
    let activeReads = 0;
    let maximumConcurrentReads = 0;
    const read = async (): Promise<unknown> => {
      activeReads += 1;
      maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
      activeReads -= 1;
      return { ok: true };
    };
    const data = { read } as unknown as WidgetDataClient<NativeDataOperationMap>;
    const lifecycle = createWidgetLifecycleController();
    const budget = createWidgetPollBudget({
      maxConcurrentGlobal: 8,
      maxConcurrentPerOperation: 3,
      maxConcurrentPerWidget: 1,
      maxRequestsPerMinuteGlobal: 120,
      maxRequestsPerMinutePerUser: 90,
      maxRequestsPerMinutePerOperation: 30,
      maxRequestsPerMinutePerWidget: 30,
      minimumIntervalMs: 1_000,
    });
    const scheduler = createNativeRefreshScheduler(
      data,
      POLICY,
      lifecycle,
      { instanceId: INSTANCE_ID, hidden: false },
      budget,
      "scope-test",
    );
    const firstStates: string[] = [];
    const secondStates: string[] = [];
    const unsubscribeQuotes = scheduler.observe(
      "market.quotes",
      { symbols: ["SPY"] },
      { refreshIntervalMs: 30_000 },
      (state) => firstStates.push(state.status),
    );
    const unsubscribeOptions = scheduler.observe(
      "market.options.chain",
      { symbol: "SPY", expiry: "2027-01-15" },
      { refreshIntervalMs: 30_000 },
      (state) => secondStates.push(state.status),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribeQuotes();
    unsubscribeOptions();
    lifecycle.dispose();

    expect(maximumConcurrentReads).toBe(1);
    expect(firstStates).toContain("ready");
    expect(secondStates).toContain("ready");
  });
});
