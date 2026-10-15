import { describe, expect, it, vi } from "vitest";
import type { WidgetActionMap } from "./actions";
import type { WidgetHostContext, WidgetInstanceV1, WidgetManifestV1 } from "./contracts";
import type { WidgetScheduledReadState } from "./data";
import { createWidgetLifecycleController } from "./lifecycle";
import { createWidgetEventBus } from "./events";
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

describe("per-registration host capability scope", () => {
  it("limits reads, refresh scheduling, and actions before any underlying dispatch", async () => {
    const readDispatch = vi.fn(async (operationId: string) => `read:${operationId}`);
    const actionDispatch = vi.fn(async (actionId: string) => `action:${actionId}`);
    const refreshDispatch = vi.fn(() => () => undefined);
    const eventBus = createWidgetEventBus({ onCommand: () => ({ accepted: true }) });
    const base = {
      auth: { authenticated: true, permissions: [] },
      lifecycle: createWidgetLifecycleController(),
      events: eventBus.forInstance("80e310b0-4a9e-4b0b-b500-01a1a5d06e0d"),
      data: { read: readDispatch },
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
