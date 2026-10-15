import { describe, expect, it, vi } from "vitest";
import type { WidgetActionMap } from "../widgets/sdk/actions";
import type { WidgetHostContext } from "../widgets/sdk/contracts";
import type { WidgetDataClient, WidgetScheduledReadState } from "../widgets/sdk/data";
import { createBudgetedWidgetDataClient } from "../widgets/sdk/budgetedData";
import { createWidgetEventBus } from "../widgets/sdk/events";
import { createWidgetLifecycleController } from "../widgets/sdk/lifecycle";
import { createWidgetPollBudget } from "../widgets/sdk/pollBudget";
import { createWorkspaceWidgetHostContext } from "./widget-host";

type WorkspaceHostTestOperations = {
  "allowed.read": { input: Readonly<{ symbol: string }>; output: string };
  "denied.read": { input: Readonly<Record<string, never>>; output: string };
};

type WorkspaceHostTestActions = WidgetActionMap & {
  "research.ai": { input: Readonly<{ prompt: string }>; output: string };
  "portfolio.delete": { input: Readonly<{ portfolioId: number }>; output: undefined };
};

describe("workspace per-widget host join", () => {
  it("limits host dispatch to the resolved registration declarations", async () => {
    const readDispatch = vi.fn(async (operationId: string) => operationId);
    const actionDispatch = vi.fn(async (actionId: string) => actionId);
    const refreshDispatch = vi.fn(() => () => undefined);
    const lifecycle = createWidgetLifecycleController();
    const instanceId = "80e310b0-4a9e-4b0b-b500-01a1a5d06e0d";
    const rawData = {
      read: async <K extends keyof WorkspaceHostTestOperations & string>(
        operationId: K,
        _input: WorkspaceHostTestOperations[K]["input"],
        _options: Readonly<{ signal: AbortSignal }>,
      ): Promise<WorkspaceHostTestOperations[K]["output"]> => readDispatch(operationId),
    } satisfies WidgetDataClient<WorkspaceHostTestOperations>;
    const data = createBudgetedWidgetDataClient(
      rawData,
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
        scopeKey: "opaque-workspace-host-test-partition",
        instanceId,
        manifestRefresh: { mode: "none" },
        lifecycle,
        hidden: false,
      },
    );
    const eventBus = createWidgetEventBus({ onCommand: () => ({ accepted: true }) });
    const services = {
      auth: { authenticated: true, permissions: [] },
      events: eventBus.forInstance(instanceId),
      data,
      actions: { invoke: actionDispatch },
      refresh: { observe: refreshDispatch },
      market: { getSnapshot: () => "snapshot", subscribe: () => () => undefined },
      reportError: () => undefined,
    } as unknown as Omit<
      WidgetHostContext<WorkspaceHostTestOperations, WorkspaceHostTestActions, string>,
      "lifecycle"
    >;
    const registrationCapabilities = {
      allowedReadOperations: ["allowed.read"] as const,
      allowedActions: ["research.ai"] as const,
    };
    const host = createWorkspaceWidgetHostContext(
      services,
      lifecycle,
      registrationCapabilities,
    );
    const signal = new AbortController().signal;

    await expect(host.data.read("allowed.read", { symbol: "SPY" }, { signal })).resolves.toBe(
      "allowed.read",
    );
    await expect(
      host.actions.invoke("research.ai", { prompt: "summary" }, { signal }),
    ).resolves.toBe("research.ai");
    expect(readDispatch).toHaveBeenCalledTimes(1);
    expect(actionDispatch).toHaveBeenCalledTimes(1);

    await expect(
      (
        host.data.read as unknown as (
          id: string,
          input: unknown,
          options: Readonly<{ signal: AbortSignal }>,
        ) => Promise<unknown>
      )("denied.read", {}, { signal }),
    ).rejects.toMatchObject({ code: "request-failed" });
    await expect(
      (
        host.actions.invoke as unknown as (
          id: string,
          input: unknown,
          options: Readonly<{ signal: AbortSignal }>,
        ) => Promise<unknown>
      )("portfolio.delete", { portfolioId: 7 }, { signal }),
    ).rejects.toMatchObject({ code: "request-failed" });

    let deniedRefresh: WidgetScheduledReadState<string> | undefined;
    (
      host.refresh as unknown as WidgetHostContext<
        WorkspaceHostTestOperations,
        WorkspaceHostTestActions,
        string
      >["refresh"]
    ).observe("denied.read", {}, { refreshIntervalMs: 1_000 }, (state) => {
      deniedRefresh = state;
    });
    expect(deniedRefresh).toEqual({ status: "error", code: "request-failed" });
    expect(readDispatch).toHaveBeenCalledTimes(1);
    expect(actionDispatch).toHaveBeenCalledTimes(1);
    expect(refreshDispatch).not.toHaveBeenCalled();
  });
});
