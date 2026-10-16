import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { AuthUiSnapshot, Permission } from "../../lib/contracts/auth";
import type { NativeActionMap, NativeDataOperationMap } from "../../features/data/operations";
import type { MarketHostSnapshot } from "../../stores/market/market-store";
import type { WorkspaceStoreHook } from "../../stores/workspace/store";
import type {
  AnyWidgetRegistration,
  BuiltinProvenance,
  WidgetRegistry,
} from "../../widgets/registry/types";
import type {
  ConfigParseResult,
  WidgetInstanceV1,
  WidgetLifecycle,
  WidgetManifestV1,
  WidgetProps,
  WidgetRefreshPolicyV1,
} from "../../widgets/sdk/contracts";
import type {
  WidgetDataClient,
  WidgetMarketReader,
  WidgetRefreshScheduler,
} from "../../widgets/sdk/data";
import { createWidgetEventBus } from "../../widgets/sdk/events";
import {
  createWidgetLifecycleController,
  type WidgetLifecycleController,
} from "../../widgets/sdk/lifecycle";
import { createBudgetedWidgetDataClient } from "../../widgets/sdk/budgetedData";
import {
  createWidgetPollBudget,
  type WidgetPollBudget,
  type WidgetPollRequest,
} from "../../widgets/sdk/pollBudget";
import type { WorkspaceTabV1, WorkspaceV1 } from "../../workspace/model";
import type { RefreshScope } from "../../features/data/refresh-scheduler";
import {
  createWidgetLifecycleForVisibility,
  syncWidgetLifecycleVisibility,
  WorkspaceGrid,
  type WorkspaceGridProps,
} from "./WorkspaceGrid";

type DirectReadHook = (
  policy: WidgetRefreshPolicyV1,
  lifecycle: WidgetLifecycle,
  scope: RefreshScope,
) => WidgetDataClient<NativeDataOperationMap>;
type RefreshHook = (
  policy: WidgetRefreshPolicyV1,
  lifecycle: WidgetLifecycle,
  scope: RefreshScope,
) => WidgetRefreshScheduler<NativeDataOperationMap>;

const hookMocks = vi.hoisted(() => ({
  directDataHook: vi.fn<DirectReadHook>(),
  refreshHook: vi.fn<RefreshHook>(),
  refreshObserve: vi.fn(),
}));

vi.mock("react-grid-layout", () => ({
  default: ({ children }: Readonly<{ children: ReactNode }>) => <>{children}</>,
}));

vi.mock("../../features/data/MarketDataHost", () => ({
  useWidgetDirectReadClient: hookMocks.directDataHook,
  useWidgetRefreshScheduler: hookMocks.refreshHook,
}));

const INSTANCE_ID = "d23a76c1-89f4-4e33-982f-35d8f2ac8124";
const REFRESH_POLICY = Object.freeze({ mode: "shared-market" } as const);
const MANIFEST: WidgetManifestV1 = {
  manifestVersion: 1,
  sdkVersion: 1,
  id: "test.budget-probe",
  version: "1.0.0",
  title: "Budget probe",
  description: "Workspace host wiring fixture.",
  category: "market",
  rendererId: "test.budget-probe",
  configSchemaId: "test.budget-probe.v1",
  defaultSize: { w: 4, h: 3, minW: 1, minH: 1, maxW: 12, maxH: 40 },
  inputs: [],
  requiredPermissions: ["market:read"],
  refresh: REFRESH_POLICY,
  symbolBinding: "unsupported",
  provenanceId: "test.budget-probe",
  provenancePolicy: "no-market-data",
};

type ProbeWidgetProps = WidgetProps<
  WidgetInstanceV1["config"],
  NativeDataOperationMap,
  NativeActionMap,
  MarketHostSnapshot
>;

let capturedHost: ProbeWidgetProps["host"] | null = null;

function ProbeWidget({ host }: ProbeWidgetProps) {
  capturedHost = host;
  return <output>Budget probe mounted</output>;
}

const PROVENANCE = Object.freeze({
  provenanceId: "test.budget-probe",
  origin: "first-party",
  sourceRepository: "EqoBoard",
  sourcePath: "components/workspace/WorkspaceGrid.test.tsx",
  sourceCommit: null,
  license: null,
  noticePath: null,
  auditReference: "workspace direct-read host wiring test",
} satisfies BuiltinProvenance);

const REGISTRATION: AnyWidgetRegistration = Object.freeze({
  manifest: MANIFEST,
  Component: ProbeWidget,
  allowedReadOperations: ["market.quotes"],
  allowedActions: [],
  parseConfig: (value: unknown): ConfigParseResult<unknown> => ({ ok: true, value }),
  createDefaultConfig: () => ({}),
  provenance: PROVENANCE,
});

const INSTANCE: WidgetInstanceV1 = Object.freeze({
  instanceId: INSTANCE_ID,
  manifestId: MANIFEST.id,
  manifestVersion: MANIFEST.version,
  configSchemaId: MANIFEST.configSchemaId,
  config: {},
});

const TAB: WorkspaceTabV1 = Object.freeze({
  id: "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d",
  name: "Overview",
  widgets: [INSTANCE],
  placements: [{ i: INSTANCE_ID, x: 0, y: 0, w: 4, h: 3 }],
  maximizedInstanceId: null,
});

const WORKSPACE: WorkspaceV1 = Object.freeze({
  id: "c6e5c418-2cf8-433b-9a42-9b05d46b8262",
  name: "Test workspace",
  activeTabId: TAB.id,
  marketContext: { activeSymbol: "SPY", watchlist: ["SPY"] },
  tabs: [TAB],
});

const TEST_PERMISSIONS: readonly Permission[] = Object.freeze(["market:read"]);

const AUTH: AuthUiSnapshot = Object.freeze({
  status: "authenticated",
  authenticated: true,
  displayName: "Test reader",
  permissions: TEST_PERMISSIONS,
  storagePartition: "opaque-test-partition",
});

function createGridProps(data: WidgetDataClient<NativeDataOperationMap>): WorkspaceGridProps {
  const registry = {
    resolveInstance: () => ({ status: "ready", registration: REGISTRATION, config: {} }),
  } as unknown as WidgetRegistry;
  const store = { getState: () => ({ canEdit: false }) } as unknown as WorkspaceStoreHook;
  const actions = { invoke: vi.fn() } as unknown as WorkspaceGridProps["actions"];
  const market = {
    getSnapshot: () => null,
    subscribe: () => () => undefined,
  } as unknown as WidgetMarketReader<MarketHostSnapshot>;
  const eventBus = createWidgetEventBus({ onCommand: () => ({ accepted: true }) });

  return {
    auth: AUTH,
    registry,
    workspace: WORKSPACE,
    tab: TAB,
    store,
    eventBus,
    data,
    actions,
    market,
    onWidgetError: () => undefined,
  };
}

describe("WorkspaceGrid direct-read budget wiring", () => {
  it("starts an initially hidden widget suspended before child effects", () => {
    const lifecycle = createWidgetLifecycleForVisibility(true);
    const initial = lifecycle.getSnapshot();

    expect(initial.phase).toBe("suspended");
    expect(initial.signal.aborted).toBe(true);

    syncWidgetLifecycleVisibility(lifecycle, false);
    const resumed = lifecycle.getSnapshot();
    expect(resumed.phase).toBe("active");
    expect(resumed.generation).toBe(initial.generation + 1);
    expect(resumed.signal).not.toBe(initial.signal);
  });

  beforeEach(() => {
    capturedHost = null;
    hookMocks.directDataHook.mockClear();
    hookMocks.refreshHook.mockClear();
    hookMocks.refreshObserve.mockClear();
    hookMocks.refreshObserve.mockReturnValue(() => undefined);
    const refreshScheduler = {
      observe: hookMocks.refreshObserve,
    } as unknown as WidgetRefreshScheduler<NativeDataOperationMap>;
    hookMocks.refreshHook.mockReturnValue(refreshScheduler);
  });

  it("routes direct reads through the manifest-scoped budget client and refresh through its scheduler", async () => {
    const rawRead = vi.fn(async () => "unbudgeted raw result");
    const rawData = { read: rawRead } as unknown as WidgetDataClient<NativeDataOperationMap>;
    const requests: WidgetPollRequest[] = [];
    const baseBudget = createWidgetPollBudget({
      maxConcurrentGlobal: 8,
      maxConcurrentPerOperation: 3,
      maxConcurrentPerWidget: 1,
      maxRequestsPerMinuteGlobal: 120,
      maxRequestsPerMinutePerUser: 90,
      maxRequestsPerMinutePerOperation: 30,
      maxRequestsPerMinutePerWidget: 30,
      minimumIntervalMs: 1_000,
    });
    const recordingBudget: WidgetPollBudget = {
      run<T>(request: WidgetPollRequest, operation: (signal: AbortSignal) => Promise<T>) {
        requests.push(request);
        return baseBudget.run(request, operation);
      },
    };
    hookMocks.directDataHook.mockImplementation((policy, lifecycle, scope) =>
      createBudgetedWidgetDataClient(rawData, recordingBudget, {
        scopeKey: AUTH.storagePartition ?? "anonymous",
        instanceId: scope.instanceId,
        manifestRefresh: policy,
        lifecycle,
        hidden: scope.hidden,
      }),
    );
    const html = renderToStaticMarkup(<WorkspaceGrid {...createGridProps(rawData)} />);

    expect(html).toContain("Budget probe mounted");
    expect(hookMocks.directDataHook).toHaveBeenCalledTimes(1);
    expect(hookMocks.refreshHook).toHaveBeenCalledTimes(1);

    const host = capturedHost;
    if (!host) throw new Error("The ready widget did not receive its workspace host context.");

    expect(hookMocks.directDataHook.mock.calls[0]?.[0]).toBe(REFRESH_POLICY);
    expect(hookMocks.refreshHook.mock.calls[0]?.[0]).toBe(REFRESH_POLICY);
    expect(hookMocks.directDataHook.mock.calls[0]?.[1]).toBe(host.lifecycle);
    expect(hookMocks.refreshHook.mock.calls[0]?.[1]).toBe(host.lifecycle);
    expect(hookMocks.directDataHook.mock.calls[0]?.[2]).toEqual({
      instanceId: INSTANCE_ID,
      hidden: true,
    });

    const lifecycleInterface = hookMocks.directDataHook.mock.calls[0]?.[1];
    if (!lifecycleInterface) throw new Error("The read client did not receive a widget lifecycle.");
    const lifecycle = lifecycleInterface as WidgetLifecycleController;
    const initialLifecycle = lifecycle.getSnapshot();
    expect(initialLifecycle.phase).toBe("suspended");

    const signal = new AbortController().signal;
    await expect(
      host.data.read("market.quotes", { symbols: ["SPY"] }, { signal }),
    ).rejects.toMatchObject({ code: "suspended" });

    expect(requests).toHaveLength(0);
    expect(rawRead).not.toHaveBeenCalled();

    lifecycle.resume();
    const resumedLifecycle = lifecycle.getSnapshot();
    expect(resumedLifecycle.phase).toBe("active");
    expect(resumedLifecycle.generation).toBe(initialLifecycle.generation + 1);

    await expect(
      host.data.read("market.quotes", { symbols: ["SPY"] }, { signal }),
    ).rejects.toMatchObject({ code: "hidden" });
    host.refresh.observe(
      "market.quotes",
      { symbols: ["SPY"] },
      { refreshIntervalMs: 30_000 },
      () => undefined,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      scopeKey: AUTH.storagePartition,
      instanceId: INSTANCE_ID,
      hidden: true,
      policy: {
        mode: "poll",
        minIntervalMs: 1_000,
        maxRequestsPerMinute: 30,
        maxConcurrentRequests: 1,
        whenHidden: "pause",
      },
    });
    expect(hookMocks.refreshObserve).toHaveBeenCalledTimes(1);
    expect(rawRead).not.toHaveBeenCalled();
  });

  it("suspends hidden widget work and resumes it with a fresh generation", () => {
    const lifecycle = createWidgetLifecycleController();
    const visible = lifecycle.getSnapshot();

    syncWidgetLifecycleVisibility(lifecycle, true);
    syncWidgetLifecycleVisibility(lifecycle, true);
    expect(lifecycle.getSnapshot().phase).toBe("suspended");
    expect(visible.signal.aborted).toBe(true);

    syncWidgetLifecycleVisibility(lifecycle, false);
    const resumed = lifecycle.getSnapshot();
    syncWidgetLifecycleVisibility(lifecycle, false);
    const stillResumed = lifecycle.getSnapshot();
    expect(resumed.phase).toBe("active");
    expect(resumed.generation).toBe(visible.generation + 1);
    expect(resumed.signal).not.toBe(visible.signal);
    expect(stillResumed.generation).toBe(resumed.generation);
    expect(stillResumed.signal).toBe(resumed.signal);
    expect(lifecycle.isCurrent(resumed.generation)).toBe(true);
  });
});
