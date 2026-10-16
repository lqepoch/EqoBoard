import { describe, expect, it, vi } from "vitest";
import type { WidgetRefreshPolicyV1 } from "./contracts";
import { WidgetDataReadError, type WidgetDataClient } from "./data";
import { createWidgetLifecycleController } from "./lifecycle";
import { createBudgetedWidgetDataClient, type WidgetBudgetedReadScope } from "./budgetedData";
import { createWidgetPollBudget, type WidgetPollBudgetConfig } from "./pollBudget";

type TestOperations = {
  "market.quotes": { input: Readonly<{ symbols: readonly string[] }>; output: string };
};

const config: WidgetPollBudgetConfig = {
  maxConcurrentGlobal: 4,
  maxConcurrentPerOperation: 2,
  maxConcurrentPerWidget: 3,
  maxRequestsPerMinuteGlobal: 20,
  maxRequestsPerMinutePerUser: 20,
  maxRequestsPerMinutePerOperation: 10,
  maxRequestsPerMinutePerWidget: 10,
  minimumIntervalMs: 0,
};

const instanceId = "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d";

function scope(
  lifecycle = createWidgetLifecycleController(),
  overrides: Partial<WidgetBudgetedReadScope> = {},
): WidgetBudgetedReadScope {
  return {
    scopeKey: "opaque-user-partition-a",
    instanceId,
    manifestRefresh: { mode: "none" },
    lifecycle,
    hidden: false,
    ...overrides,
  };
}

function testData(
  read: WidgetDataClient<TestOperations>["read"],
): WidgetDataClient<TestOperations> {
  return Object.freeze({ read });
}

describe("budgeted widget direct reads", () => {
  it("rejects hidden and suspended reads before transport dispatch", async () => {
    const budget = createWidgetPollBudget(config);
    const read = vi.fn(async () => "decoded");
    const data = testData(read);
    const hidden = createBudgetedWidgetDataClient(data, budget, scope(undefined, { hidden: true }));
    const suspendedLifecycle = createWidgetLifecycleController();
    suspendedLifecycle.suspend();
    const suspended = createBudgetedWidgetDataClient(data, budget, scope(suspendedLifecycle));
    const signal = new AbortController().signal;

    await expect(
      hidden.read("market.quotes", { symbols: ["SPY"] }, { signal }),
    ).rejects.toMatchObject({ code: "hidden" });
    await expect(
      suspended.read("market.quotes", { symbols: ["SPY"] }, { signal }),
    ).rejects.toMatchObject({ code: "suspended" });
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels a direct read across generation changes and rejects its late result", async () => {
    const budget = createWidgetPollBudget(config);
    const lifecycle = createWidgetLifecycleController();
    let resolveRead: (value: string) => void = () => undefined;
    let transportSignal: AbortSignal | undefined;
    const pending = new Promise<string>((resolve) => {
      resolveRead = resolve;
    });
    const read = vi.fn(
      (
        _operationId: "market.quotes",
        _input: TestOperations["market.quotes"]["input"],
        options: { signal: AbortSignal },
      ) => {
        transportSignal = options.signal;
        return pending;
      },
    );
    const data = createBudgetedWidgetDataClient(testData(read), budget, scope(lifecycle));
    const result = data.read(
      "market.quotes",
      { symbols: ["SPY"] },
      {
        signal: new AbortController().signal,
      },
    );
    await Promise.resolve();
    lifecycle.suspend();
    lifecycle.resume();

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(transportSignal?.aborted).toBe(true);
    resolveRead("late");
    await Promise.resolve();
  });

  it("enforces per-instance concurrency and manifest RPM limits for direct reads", async () => {
    let now = 0;
    const budget = createWidgetPollBudget(config, () => now);
    let resolveRead: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      resolveRead = resolve;
    });
    const read = vi.fn(async () => pending);
    const policy: WidgetRefreshPolicyV1 = {
      mode: "poll",
      minIntervalMs: 250,
      maxRequestsPerMinute: 2,
      maxConcurrentRequests: 1,
      whenHidden: "continue",
    };
    const data = createBudgetedWidgetDataClient(
      testData(read),
      budget,
      scope(undefined, { manifestRefresh: policy }),
    );
    const signal = new AbortController().signal;
    const first = data.read("market.quotes", { symbols: ["SPY"] }, { signal });
    await Promise.resolve();
    now = 250;
    await expect(
      data.read("market.quotes", { symbols: ["QQQ"] }, { signal }),
    ).rejects.toMatchObject({ code: "concurrency-limited" });
    resolveRead("first");
    await expect(first).resolves.toBe("first");

    now = 500;
    await expect(data.read("market.quotes", { symbols: ["QQQ"] }, { signal })).resolves.toBe(
      "first",
    );
    now = 750;
    await expect(
      data.read("market.quotes", { symbols: ["IWM"] }, { signal }),
    ).rejects.toMatchObject({ code: "rate-limited" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("allows three manual reads, rejects a fourth, and keeps poll concurrency at one", async () => {
    type ManualOperations = {
      "market.quotes": { input: Readonly<Record<string, never>>; output: string };
      "portfolio.list": { input: Readonly<Record<string, never>>; output: string };
      "portfolio.positions": { input: Readonly<{ portfolioId: number }>; output: string };
      "portfolio.transactions": { input: Readonly<{ portfolioId: number }>; output: string };
    };
    const pendingResolvers: Array<(value: string) => void> = [];
    const dispatched: string[] = [];
    const manualData: WidgetDataClient<ManualOperations> = {
      read<K extends keyof ManualOperations & string>(
        operationId: K,
        _input: ManualOperations[K]["input"],
        _options: Readonly<{ signal: AbortSignal }>,
      ): Promise<ManualOperations[K]["output"]> {
        dispatched.push(operationId);
        return new Promise((resolve) => pendingResolvers.push(resolve));
      },
    };
    const lifecycle = createWidgetLifecycleController();
    const budget = createWidgetPollBudget(config);
    const manual = createBudgetedWidgetDataClient(
      manualData,
      budget,
      scope(lifecycle, { manifestRefresh: { mode: "none" } }),
    );
    const signal = new AbortController().signal;
    const initialReads = [
      manual.read("portfolio.list", {}, { signal }),
      manual.read("portfolio.positions", { portfolioId: 1 }, { signal }),
      manual.read("portfolio.transactions", { portfolioId: 1 }, { signal }),
    ];
    await Promise.resolve();
    expect(dispatched).toEqual(["portfolio.list", "portfolio.positions", "portfolio.transactions"]);
    await expect(manual.read("market.quotes", {}, { signal })).rejects.toMatchObject({
      code: "concurrency-limited",
    });
    expect(dispatched).toHaveLength(3);
    for (const [index, resolve] of pendingResolvers.entries()) resolve(`result-${index}`);
    await expect(Promise.all(initialReads)).resolves.toEqual(["result-0", "result-1", "result-2"]);

    let now = 0;
    const pollBudget = createWidgetPollBudget(config, () => now);
    let resolvePoll: (value: string) => void = () => undefined;
    const pollRead = testData(() => new Promise<string>((resolve) => (resolvePoll = resolve)));
    const poll = createBudgetedWidgetDataClient(
      pollRead,
      pollBudget,
      scope(createWidgetLifecycleController(), {
        manifestRefresh: {
          mode: "poll",
          minIntervalMs: 250,
          maxRequestsPerMinute: 10,
          maxConcurrentRequests: 1,
          whenHidden: "pause",
        },
      }),
    );
    const firstPoll = poll.read("market.quotes", { symbols: ["SPY"] }, { signal });
    await Promise.resolve();
    now = 250;
    await expect(
      poll.read("market.quotes", { symbols: ["QQQ"] }, { signal }),
    ).rejects.toMatchObject({ code: "concurrency-limited" });
    resolvePoll("poll-result");
    await expect(firstPoll).resolves.toBe("poll-result");
  });

  it("uses the bounded host default for non-poll manifest direct reads", async () => {
    let now = 0;
    const budget = createWidgetPollBudget(config, () => now);
    const read = vi.fn(async () => "decoded");
    const lifecycle = createWidgetLifecycleController();
    const data = createBudgetedWidgetDataClient(
      testData(read),
      budget,
      scope(lifecycle, { manifestRefresh: { mode: "shared-market" } }),
    );
    const signal = new AbortController().signal;

    await expect(data.read("market.quotes", { symbols: ["SPY"] }, { signal })).resolves.toBe(
      "decoded",
    );
    now = 500;
    await expect(
      data.read("market.quotes", { symbols: ["QQQ"] }, { signal }),
    ).rejects.toMatchObject({ code: "rate-limited", retryAfterMs: 500 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("isolates per-user direct-read budgets by opaque auth partition", async () => {
    const budget = createWidgetPollBudget({ ...config, maxRequestsPerMinutePerUser: 1 });
    const read = vi.fn(async () => "decoded");
    const lifecycle = createWidgetLifecycleController();
    const userA = createBudgetedWidgetDataClient(
      testData(read),
      budget,
      scope(lifecycle, { scopeKey: "opaque-user-partition-a" }),
    );
    const userB = createBudgetedWidgetDataClient(
      testData(read),
      budget,
      scope(lifecycle, { scopeKey: "opaque-user-partition-b" }),
    );
    const signal = new AbortController().signal;

    await expect(userA.read("market.quotes", { symbols: ["SPY"] }, { signal })).resolves.toBe(
      "decoded",
    );
    await expect(userB.read("market.quotes", { symbols: ["SPY"] }, { signal })).resolves.toBe(
      "decoded",
    );
    await expect(
      userA.read("market.quotes", { symbols: ["QQQ"] }, { signal }),
    ).rejects.toMatchObject({ code: "rate-limited" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("honors caller cancellation before dispatch", async () => {
    const budget = createWidgetPollBudget(config);
    const read = vi.fn(async () => "unreachable");
    const data = createBudgetedWidgetDataClient(testData(read), budget, scope());
    const controller = new AbortController();
    controller.abort();

    await expect(
      data.read("market.quotes", { symbols: ["SPY"] }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(WidgetDataReadError);
    expect(read).not.toHaveBeenCalled();
  });
});
