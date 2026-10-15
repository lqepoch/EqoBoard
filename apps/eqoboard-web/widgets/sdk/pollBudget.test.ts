import { describe, expect, it, vi } from "vitest";
import { createWidgetLifecycleController } from "./lifecycle";
import { createWidgetPollBudget, type WidgetPollBudgetConfig, type WidgetPollRequest } from "./pollBudget";
import { WidgetDataReadError } from "./data";

const config: WidgetPollBudgetConfig = {
  maxConcurrentGlobal: 4,
  maxConcurrentPerOperation: 2,
  maxConcurrentPerWidget: 1,
  maxRequestsPerMinuteGlobal: 20,
  maxRequestsPerMinutePerUser: 20,
  maxRequestsPerMinutePerOperation: 10,
  maxRequestsPerMinutePerWidget: 10,
  minimumIntervalMs: 0,
};

const pollRequest = (
  instanceId: string,
  lifecycle = createWidgetLifecycleController(),
  overrides: Partial<WidgetPollRequest> = {},
): WidgetPollRequest => ({
  scopeKey: "opaque-user-partition-a",
  instanceId,
  operationId: "market.quotes",
  input: { symbols: ["SPY"] },
  policy: {
    mode: "poll",
    minIntervalMs: 250,
    maxRequestsPerMinute: 10,
    maxConcurrentRequests: 1,
    whenHidden: "pause",
  },
  lifecycle,
  hidden: false,
  ...overrides,
});

describe("widget poll budget", () => {
  it("rejects unbounded host budget configuration", () => {
    expect(() => createWidgetPollBudget({ ...config, maxRequestsPerMinuteGlobal: Number.MAX_SAFE_INTEGER }))
      .toThrowError(TypeError);
    expect(() => createWidgetPollBudget({ ...config, maxConcurrentGlobal: 129 }))
      .toThrowError(TypeError);
  });

  it("rejects runtime policy values that bypass a parsed manifest ceiling", async () => {
    const budget = createWidgetPollBudget(config);
    const malformed = pollRequest("instance-bad-policy", undefined, {
      policy: { mode: "poll", minIntervalMs: 0, maxRequestsPerMinute: 10_000,
        maxConcurrentRequests: 1, whenHidden: "continue" } as WidgetPollRequest["policy"],
    });
    await expect(budget.run(malformed, async () => "unreachable"))
      .rejects.toMatchObject({ code: "request-failed" });
  });

  it("rejects data inputs with accessors without invoking them", async () => {
    const budget = createWidgetPollBudget(config);
    let called = false;
    const input = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("must not run");
      },
    });
    await expect(budget.run(pollRequest("instance-accessor", undefined, { input }), async () => "unreachable"))
      .rejects.toMatchObject({ code: "request-failed" });
    expect(called).toBe(false);
  });

  it("deduplicates equivalent in-flight reads for one active widget generation", async () => {
    const budget = createWidgetPollBudget(config);
    let resolve: (value: string) => void = () => undefined;
    const deferred = new Promise<string>((done) => { resolve = done; });
    const operation = vi.fn(() => deferred);
    const request = pollRequest("instance-a");

    const first = budget.run(request, operation);
    const duplicate = budget.run(request, operation);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    resolve("decoded");
    await expect(Promise.all([first, duplicate])).resolves.toEqual(["decoded", "decoded"]);
  });

  it("keeps deduplication and per-user limits isolated by opaque auth partition", async () => {
    const budget = createWidgetPollBudget({ ...config, maxRequestsPerMinutePerUser: 1 });
    const pending: Array<(value: string) => void> = [];
    const operation = vi.fn(() => new Promise<string>((resolve) => pending.push(resolve)));
    const request = pollRequest("instance-shared");
    const first = budget.run(request, operation);
    const second = budget.run({ ...request, scopeKey: "opaque-user-partition-b" }, operation);
    await Promise.resolve();

    expect(operation).toHaveBeenCalledTimes(2);
    pending.forEach((resolve, index) => resolve(`result-${index}`));
    await expect(Promise.all([first, second])).resolves.toEqual(["result-0", "result-1"]);

    const limiter = createWidgetPollBudget({ ...config, maxRequestsPerMinutePerUser: 1 });
    await limiter.run(request, async () => "first");
    await expect(limiter.run(request, async () => "blocked")).rejects.toMatchObject({ code: "rate-limited" });
    await expect(limiter.run({ ...request, scopeKey: "opaque-user-partition-b" }, async () => "other-user"))
      .resolves.toBe("other-user");
  });

  it("pauses hidden widgets and enforces a per-instance ceiling", async () => {
    const budget = createWidgetPollBudget(config);
    await expect(budget.run(pollRequest("instance-hidden", undefined, { hidden: true }), async () => "x"))
      .rejects.toMatchObject({ code: "hidden" });

    let resolve: (value: string) => void = () => undefined;
    const pending = new Promise<string>((done) => { resolve = done; });
    const first = budget.run(pollRequest("instance-a"), () => pending);
    await Promise.resolve();
    await expect(budget.run(pollRequest("instance-a", undefined, { input: { symbols: ["QQQ"] } }), async () => "x"))
      .rejects.toMatchObject({ code: "concurrency-limited" });
    resolve("done");
    await first;
  });

  it("rejects late results after suspend and bounds retry metadata", async () => {
    const budget = createWidgetPollBudget(config);
    const lifecycle = createWidgetLifecycleController();
    let resolve: (value: string) => void = () => undefined;
    const pending = new Promise<string>((done) => { resolve = done; });
    const result = budget.run(pollRequest("instance-a", lifecycle), () => pending);
    await Promise.resolve();
    lifecycle.suspend();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    resolve("late");

    const limiter = createWidgetPollBudget({ ...config, maxRequestsPerMinutePerWidget: 1 }, () => 1000);
    await limiter.run(pollRequest("instance-rate"), async () => "first");
    await expect(limiter.run(pollRequest("instance-rate"), async () => "second"))
      .rejects.toMatchObject({ code: "rate-limited" });
    expect(new WidgetDataReadError("rate-limited", 70_000).retryAfterMs).toBe(70_000);
  });
});
