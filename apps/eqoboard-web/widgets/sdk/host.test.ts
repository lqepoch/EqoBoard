import { describe, expect, it, vi } from "vitest";
import type { WidgetActionMap } from "./actions";
import type { WidgetHostContext, WidgetInstanceV1, WidgetManifestV1 } from "./contracts";
import type { WidgetDataClient, WidgetScheduledReadState } from "./data";
import { createWidgetLifecycleController } from "./lifecycle";
import { createWidgetEventBus } from "./events";
import { createBudgetedWidgetDataClient } from "./budgetedData";
import { createWidgetPollBudget } from "./pollBudget";
import { resolveWidgetInputs, scopeWidgetHostContext, type WidgetHostCapabilities } from "./host";

const manifest: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: "eqoboard.test-symbol-widget",
  version: "1.0.0",
  title: "Symbol widget",
  description: "Inputs fixture.",
  category: "market",
  rendererId: "eqoboard.test-symbol-widget.v1",
  configSchemaId: "eqoboard.test-symbol-widget.config.v1",
  defaultSize: { w: 4, h: 4, minW: 2, minH: 2, maxW: 8, maxH: 12 },
  inputs: [
    { name: "symbol", kind: "symbol", source: "symbol-binding", required: true },
    { name: "watchlist", kind: "symbol-list", source: "workspace.watchlist", required: true },
  ],
  requiredPermissions: [],
  refresh: { mode: "none" },
  symbolBinding: "active-or-fixed",
  provenanceId: "eqoboard.native03.symbol-test.v1",
  provenancePolicy: "surface-response-evidence",
};

const instance: WidgetInstanceV1 = {
  instanceId: "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
  manifestId: manifest.id,
  manifestVersion: manifest.version,
  configSchemaId: manifest.configSchemaId,
  config: {},
};

describe("widget resolved inputs", () => {
  it("resolves active or fixed symbol bindings and filters noncanonical watchlist values", () => {
    expect(resolveWidgetInputs(manifest, instance, "SPY", ["SPY", "spy", "QQQ"])).toEqual({
      symbol: "SPY",
      watchlist: ["SPY", "QQQ"],
    });
    expect(
      resolveWidgetInputs(
        manifest,
        {
          ...instance,
          symbolBinding: { mode: "fixed", symbol: "BRK.B" },
        },
        "SPY",
        ["SPY"],
      ),
    ).toEqual({
      symbol: "BRK.B",
      watchlist: ["SPY"],
    });
  });

  it("does not expose undeclared or malformed workspace inputs", () => {
    expect(resolveWidgetInputs(manifest, instance, "spy", ["bad symbol", "QQQ"])).toEqual({
      watchlist: ["QQQ"],
    });
    const noInputs = { ...manifest, inputs: [], symbolBinding: "unsupported" as const };
    expect(resolveWidgetInputs(noInputs, instance, "SPY", ["QQQ"])).toEqual({});
  });
});

type ScopedTestOperations = {
  "safe.read": { input: Readonly<{ query: string }>; output: string };
  "blocked.read": { input: Readonly<Record<string, never>>; output: string };
};

type ScopedTestActions = WidgetActionMap & {
  "research.ai": { input: Readonly<{ prompt: string }>; output: string };
  "portfolio.delete": { input: Readonly<{ id: number }>; output: undefined };
};

function budgetedTestData(
  read: WidgetDataClient<ScopedTestOperations>["read"],
  lifecycle: ReturnType<typeof createWidgetLifecycleController>,
) {
  return createBudgetedWidgetDataClient(
    { read },
    createWidgetPollBudget({
      maxConcurrentGlobal: 4,
      maxConcurrentPerOperation: 2,
      maxConcurrentPerWidget: 1,
      maxRequestsPerMinuteGlobal: 20,
      maxRequestsPerMinutePerUser: 20,
      maxRequestsPerMinutePerOperation: 10,
      maxRequestsPerMinutePerWidget: 10,
      minimumIntervalMs: 0,
    }),
    {
      scopeKey: "opaque-test-user-partition",
      instanceId: "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
      manifestRefresh: { mode: "none" },
      lifecycle,
      hidden: false,
    },
  );
}

describe("per-registration host capability scope", () => {
  it("limits reads, refresh scheduling, and actions before any underlying dispatch", async () => {
    const readDispatch = vi.fn(async (operationId: string) => `read:${operationId}`);
    const actionDispatch = vi.fn(async (actionId: string) => `action:${actionId}`);
    const refreshDispatch = vi.fn(() => () => undefined);
    const lifecycle = createWidgetLifecycleController();
    const eventBus = createWidgetEventBus({ onCommand: () => ({ accepted: true }) });
    const base = {
      auth: { authenticated: true, permissions: [] },
      lifecycle,
      events: eventBus.forInstance("80e310b0-4a9e-4b0b-b500-01a1a5d06e0d"),
      data: budgetedTestData(readDispatch, lifecycle),
      actions: { invoke: actionDispatch },
      refresh: { observe: refreshDispatch },
      market: { getSnapshot: () => "snapshot", subscribe: () => () => undefined },
      reportError: () => undefined,
    } as unknown as WidgetHostContext<ScopedTestOperations, ScopedTestActions, string>;
    const scoped = scopeWidgetHostContext(base, {
      allowedReadOperations: ["safe.read"],
      allowedActions: ["research.ai"],
    });
    const signal = new AbortController().signal;

    await expect(scoped.data.read("safe.read", { query: "SPY" }, { signal })).resolves.toBe(
      "read:safe.read",
    );
    await expect(
      scoped.actions.invoke("research.ai", { prompt: "summary" }, { signal }),
    ).resolves.toBe("action:research.ai");
    expect(readDispatch).toHaveBeenCalledTimes(1);
    expect(actionDispatch).toHaveBeenCalledTimes(1);
    expect(scoped.market.getSnapshot()).toBe("snapshot");

    await expect(
      (
        scoped.data.read as unknown as (
          id: string,
          input: unknown,
          options: { signal: AbortSignal },
        ) => Promise<unknown>
      )("blocked.read", {}, { signal }),
    ).rejects.toMatchObject({ code: "request-failed" });
    await expect(
      (
        scoped.actions.invoke as unknown as (
          id: string,
          input: unknown,
          options: { signal: AbortSignal },
        ) => Promise<unknown>
      )("portfolio.delete", { id: 1 }, { signal }),
    ).rejects.toMatchObject({ code: "request-failed" });
    expect(readDispatch).toHaveBeenCalledTimes(1);
    expect(actionDispatch).toHaveBeenCalledTimes(1);

    let deniedRefresh: WidgetScheduledReadState<string> | undefined;
    const unsubscribe = (
      scoped.refresh.observe as unknown as (
        id: string,
        input: unknown,
        options: Readonly<{ refreshIntervalMs: number }>,
        listener: (state: WidgetScheduledReadState<string>) => void,
      ) => () => void
    )("blocked.read", {}, { refreshIntervalMs: 1_000 }, (state) => {
      deniedRefresh = state;
    });
    unsubscribe();
    expect(deniedRefresh).toEqual({ status: "error", code: "request-failed" });
    expect(refreshDispatch).not.toHaveBeenCalled();

    lifecycle.suspend();
    await expect(scoped.data.read("safe.read", { query: "QQQ" }, { signal })).rejects.toMatchObject(
      { code: "suspended" },
    );
    await expect(
      scoped.actions.invoke("research.ai", { prompt: "summary" }, { signal }),
    ).rejects.toMatchObject({ code: "suspended" });
    expect(readDispatch).toHaveBeenCalledTimes(1);
    expect(actionDispatch).toHaveBeenCalledTimes(1);
  });

  it("aborts active reads and actions on generation changes and rejects late results", async () => {
    const readLifecycle = createWidgetLifecycleController();
    let resolveRead: (value: string) => void = () => undefined;
    let readSignal: AbortSignal | undefined;
    const readPending = new Promise<string>((resolve) => {
      resolveRead = resolve;
    });
    const readDispatch = vi.fn(
      (_operationId: string, _input: unknown, options: { signal: AbortSignal }) => {
        readSignal = options.signal;
        return readPending;
      },
    );
    const actionLifecycle = createWidgetLifecycleController();
    let resolveAction: (value: string) => void = () => undefined;
    let actionSignal: AbortSignal | undefined;
    const actionPending = new Promise<string>((resolve) => {
      resolveAction = resolve;
    });
    const actionDispatch = vi.fn(
      (_actionId: string, _input: unknown, options: { signal: AbortSignal }) => {
        actionSignal = options.signal;
        return actionPending;
      },
    );
    const eventBus = createWidgetEventBus({ onCommand: () => ({ accepted: true }) });
    const createBase = (lifecycle: ReturnType<typeof createWidgetLifecycleController>) =>
      ({
        auth: { authenticated: true, permissions: [] },
        lifecycle,
        events: eventBus.forInstance("80e310b0-4a9e-4b0b-b500-01a1a5d06e0d"),
        data: budgetedTestData(readDispatch, lifecycle),
        actions: { invoke: actionDispatch },
        refresh: { observe: vi.fn(() => () => undefined) },
        market: { getSnapshot: () => "snapshot", subscribe: () => () => undefined },
        reportError: () => undefined,
      }) as unknown as WidgetHostContext<ScopedTestOperations, ScopedTestActions, string>;
    const capabilities = {
      allowedReadOperations: ["safe.read"],
      allowedActions: ["research.ai"],
    } as const;
    const readHost = scopeWidgetHostContext(createBase(readLifecycle), capabilities);
    const actionHost = scopeWidgetHostContext(createBase(actionLifecycle), capabilities);
    const signal = new AbortController().signal;

    const readResult = readHost.data.read("safe.read", { query: "SPY" }, { signal });
    const actionResult = actionHost.actions.invoke(
      "research.ai",
      { prompt: "summary" },
      { signal },
    );
    await Promise.resolve();
    readLifecycle.suspend();
    actionLifecycle.suspend();
    readLifecycle.resume();
    actionLifecycle.resume();

    await expect(readResult).rejects.toMatchObject({ code: "cancelled" });
    await expect(actionResult).rejects.toMatchObject({ code: "cancelled" });
    expect(readSignal?.aborted).toBe(true);
    expect(actionSignal?.aborted).toBe(true);
    resolveRead("late read");
    resolveAction("late action");
    await Promise.resolve();
  });

  it("fails closed before dispatch when the host data port is not budget-wrapped", async () => {
    const readDispatch = vi.fn(async () => "unreachable");
    const lifecycle = createWidgetLifecycleController();
    const base = {
      auth: { authenticated: true, permissions: [] },
      lifecycle,
      events: createWidgetEventBus({ onCommand: () => ({ accepted: true }) }).forInstance(
        "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
      ),
      data: { read: readDispatch },
      actions: { invoke: vi.fn() },
      refresh: { observe: vi.fn(() => () => undefined) },
      market: { getSnapshot: () => "snapshot", subscribe: () => () => undefined },
      reportError: () => undefined,
    } as unknown as WidgetHostContext<ScopedTestOperations, ScopedTestActions, string>;
    const scoped = scopeWidgetHostContext(base, {
      allowedReadOperations: ["safe.read"],
      allowedActions: [],
    });

    await expect(
      scoped.data.read("safe.read", { query: "SPY" }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "request-failed" });
    expect(readDispatch).not.toHaveBeenCalled();
  });

  it("defaults malformed capability metadata to deny-all", async () => {
    const readDispatch = vi.fn(async () => "should-not-run");
    const base = {
      auth: { authenticated: true, permissions: [] },
      lifecycle: createWidgetLifecycleController(),
      events: createWidgetEventBus({ onCommand: () => ({ accepted: true }) }).forInstance(
        "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
      ),
      data: { read: readDispatch },
      actions: { invoke: vi.fn() },
      refresh: { observe: vi.fn(() => () => undefined) },
      market: { getSnapshot: () => "snapshot", subscribe: () => () => undefined },
      reportError: () => undefined,
    } as unknown as WidgetHostContext<ScopedTestOperations, ScopedTestActions, string>;
    const malformedCapabilities = Object.defineProperty({}, "allowedReadOperations", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    const scoped = scopeWidgetHostContext<
      ScopedTestOperations,
      ScopedTestActions,
      string,
      never,
      never
    >(
      base,
      malformedCapabilities as unknown as WidgetHostCapabilities<
        ScopedTestOperations,
        ScopedTestActions,
        never,
        never
      >,
    );
    await expect(
      (
        scoped.data.read as unknown as (
          id: string,
          input: unknown,
          options: { signal: AbortSignal },
        ) => Promise<unknown>
      )("safe.read", { query: "SPY" }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "request-failed" });
    expect(readDispatch).not.toHaveBeenCalled();
  });
});
