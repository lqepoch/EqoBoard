"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType, KeyboardEvent, RefObject } from "react";
import GridLayout, { type Layout } from "react-grid-layout";
import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import type { WorkspaceTabV1, WorkspaceV1 } from "../../workspace/model";
import type { WorkspaceStoreHook } from "../../stores/workspace/store";
import type { WidgetRegistry, WidgetInstanceResolution } from "../../widgets/registry/types";
import type { NativeActionMap, NativeDataOperationMap } from "../../features/data/operations";
import type { MarketHostSnapshot } from "../../stores/market/market-store";
import {
  useWidgetDirectReadClient,
  useWidgetRefreshScheduler,
} from "../../features/data/MarketDataHost";
import { resolveWidgetInputs } from "../../widgets/sdk/host";
import { projectWidgetAuthorization } from "../../widgets/sdk/auth";
import { WidgetErrorBoundary } from "../../widgets/sdk/WidgetErrorBoundary";
import {
  createWidgetLifecycleController,
  type WidgetLifecycleController,
} from "../../widgets/sdk/lifecycle";
import type { WidgetInstanceV1, WidgetProps } from "../../widgets/sdk/contracts";
import type { WidgetActionClient } from "../../widgets/sdk/actions";
import type { WidgetDataClient, WidgetMarketReader } from "../../widgets/sdk/data";
import type { WidgetEventBusHost } from "../../widgets/sdk/events";
import { toRglLayout } from "../../workspace/grid";
import { createWorkspaceWidgetHostContext } from "../../workspace/widget-host";
import { WORKSPACE_LIMITS } from "../../workspace/model";

export type WorkspaceGridProps = Readonly<{
  auth: AuthUiSnapshot;
  registry: WidgetRegistry;
  workspace: WorkspaceV1;
  tab: WorkspaceTabV1;
  store: WorkspaceStoreHook;
  eventBus: WidgetEventBusHost;
  data: WidgetDataClient<NativeDataOperationMap>;
  actions: WidgetActionClient<NativeActionMap>;
  market: WidgetMarketReader<MarketHostSnapshot>;
  onWidgetError(errorCode: string): void;
}>;

const DRAG_CANCEL =
  "button,input,textarea,select,a,[contenteditable='true'],.workspace-widget__actions,.workspace-widget__binding";
const KEY_ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

function useContainerWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(Math.max(0, Math.floor(node.getBoundingClientRect().width)));
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function useDocumentHidden(): boolean {
  const subscribe = useCallback((listener: () => void) => {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }, []);
  const getSnapshot = useCallback(
    () => typeof document === "undefined" || document.visibilityState === "hidden",
    [],
  );
  const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function useWidgetLifecycle(): WidgetLifecycleController {
  const lifecycle = useRef<WidgetLifecycleController | null>(null);
  const disposalToken = useRef(0);
  if (!lifecycle.current) lifecycle.current = createWidgetLifecycleController();
  useEffect(() => {
    const token = ++disposalToken.current;
    return () => {
      const scheduledToken = token + 1;
      disposalToken.current = scheduledToken;
      queueMicrotask(() => {
        if (disposalToken.current === scheduledToken) lifecycle.current?.dispose();
      });
    };
  }, []);
  return lifecycle.current;
}

function resolutionMessage(resolution: WidgetInstanceResolution): string {
  switch (resolution.status) {
    case "invalid-instance":
      return "This saved widget instance is malformed and cannot be opened.";
    case "unsupported-manifest":
      return "This widget type is not installed in the native registry.";
    case "unsupported-manifest-version":
      return "This widget version is not supported by the installed registry.";
    case "unsupported-config-schema":
      return "This widget configuration version is not supported.";
    case "unsupported-symbol-binding":
      return "This widget has a symbol binding the installed version cannot use.";
    case "config-invalid":
      return "This widget configuration did not pass its registered schema.";
    case "ready":
      return "";
  }
}

function WidgetRenderer({
  auth,
  instance,
  resolution,
  workspace,
  eventBus,
  actions,
  market,
  onConfigChange,
  onWidgetError,
}: {
  auth: AuthUiSnapshot;
  instance: WidgetInstanceV1;
  resolution: Extract<WidgetInstanceResolution, { status: "ready" }>;
  workspace: WorkspaceV1;
  eventBus: WidgetEventBusHost;
  actions: WidgetActionClient<NativeActionMap>;
  market: WidgetMarketReader<MarketHostSnapshot>;
  onConfigChange(next: unknown): void;
  onWidgetError(errorCode: string): void;
}) {
  const lifecycle = useWidgetLifecycle();
  const events = useMemo(
    () => eventBus.forInstance(instance.instanceId),
    [eventBus, instance.instanceId],
  );
  const documentHidden = useDocumentHidden();
  const refresh = useWidgetRefreshScheduler(resolution.registration.manifest.refresh, lifecycle, {
    instanceId: instance.instanceId,
    hidden: documentHidden,
  });
  const directData = useWidgetDirectReadClient(
    resolution.registration.manifest.refresh,
    lifecycle,
    { instanceId: instance.instanceId, hidden: documentHidden },
  );
  const authProjection = useMemo(() => projectWidgetAuthorization(auth), [auth]);
  const host = useMemo(
    () =>
      createWorkspaceWidgetHostContext(
        {
          auth: authProjection,
          events,
          data: directData,
          actions,
          refresh,
          market,
          reportError(error) {
            onWidgetError(error.code);
          },
        },
        lifecycle,
        resolution.registration,
      ),
    [
      authProjection,
      events,
      directData,
      actions,
      refresh,
      market,
      lifecycle,
      onWidgetError,
      resolution.registration,
    ],
  );
  const inputs = resolveWidgetInputs(
    resolution.registration.manifest,
    instance,
    workspace.marketContext.activeSymbol,
    workspace.marketContext.watchlist,
  );
  type NativeWidgetProps = WidgetProps<
    WidgetInstanceV1["config"],
    NativeDataOperationMap,
    NativeActionMap,
    MarketHostSnapshot
  >;
  const Component = resolution.registration.Component as ComponentType<NativeWidgetProps>;
  const props: NativeWidgetProps = {
    instance,
    config: resolution.config as WidgetInstanceV1["config"],
    inputs,
    host,
    onConfigChange,
  };
  return (
    <WidgetErrorBoundary
      onError={(error) => onWidgetError(error.code)}
      title={resolution.registration.manifest.title}
    >
      <Component {...props} />
    </WidgetErrorBoundary>
  );
}

function WidgetCard({
  auth,
  canEdit,
  instance,
  workspace,
  tab,
  registry,
  store,
  eventBus,
  actions,
  market,
  onWidgetError,
}: Omit<WorkspaceGridProps, "data"> & Readonly<{ instance: WidgetInstanceV1; canEdit: boolean }>) {
  const resolution = registry.resolveInstance(instance);
  const [fixedSymbol, setFixedSymbol] = useState(
    instance.symbolBinding?.mode === "fixed" ? instance.symbolBinding.symbol : "",
  );
  const title =
    resolution.status === "ready" ? resolution.registration.manifest.title : "Unsupported widget";
  const missingPermissions =
    resolution.status === "ready"
      ? resolution.registration.manifest.requiredPermissions.filter(
          (permission) => !auth.permissions.includes(permission),
        )
      : [];
  const bindingSupported =
    resolution.status === "ready" &&
    resolution.registration.manifest.symbolBinding === "active-or-fixed";
  const activeWorkspaceId = workspace.id;
  const tabId = tab.id;
  const manifestId = instance.manifestId;

  function move(key: (typeof KEY_ARROWS)[number]): void {
    store.getState().moveWidget(activeWorkspaceId, tabId, instance.instanceId, key);
  }

  function resize(key: (typeof KEY_ARROWS)[number]): void {
    store.getState().resizeWidget(activeWorkspaceId, tabId, instance.instanceId, key);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (!event.ctrlKey && !event.altKey) return;
    if (!event.shiftKey || !KEY_ARROWS.includes(event.key as (typeof KEY_ARROWS)[number])) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("input,textarea,select,[contenteditable='true']")
    )
      return;
    event.preventDefault();
    if (event.ctrlKey) move(event.key as (typeof KEY_ARROWS)[number]);
    else resize(event.key as (typeof KEY_ARROWS)[number]);
  }

  return (
    <article
      aria-label={title}
      className="workspace-widget"
      data-widget-instance-id={instance.instanceId}
      onKeyDown={onKeyDown}
    >
      <header className="workspace-widget__header workspace-widget__handle">
        <div className="workspace-widget__heading">
          <h3>{title}</h3>
          <span className="workspace-widget__kind">{manifestId}</span>
        </div>
        <section
          aria-label={`${title} controls`}
          className="workspace-widget__actions"
        >
          {canEdit && (
            <>
              <button
                aria-label={`Maximize ${title}`}
                onClick={() =>
                  store.getState().maximizeWidget(activeWorkspaceId, tabId, instance.instanceId)
                }
                type="button"
              >
                Maximize
              </button>
              <button
                aria-label={`Duplicate ${title}`}
                onClick={() =>
                  store.getState().duplicateWidget(activeWorkspaceId, tabId, instance.instanceId)
                }
                type="button"
              >
                Duplicate
              </button>
              <button
                aria-label={`Remove ${title}`}
                onClick={() =>
                  void store.getState().removeWidget(activeWorkspaceId, tabId, instance.instanceId)
                }
                type="button"
              >
                Remove
              </button>
            </>
          )}
        </section>
      </header>
      {canEdit && (
        <section
          aria-label={`${title} layout controls`}
          className="workspace-widget__layout-controls"
        >
          <button aria-label={`Move ${title} left`} onClick={() => move("ArrowLeft")} type="button">
            ←
          </button>
          <button aria-label={`Move ${title} up`} onClick={() => move("ArrowUp")} type="button">
            ↑
          </button>
          <button aria-label={`Move ${title} down`} onClick={() => move("ArrowDown")} type="button">
            ↓
          </button>
          <button
            aria-label={`Move ${title} right`}
            onClick={() => move("ArrowRight")}
            type="button"
          >
            →
          </button>
          <button aria-label={`Narrow ${title}`} onClick={() => resize("ArrowLeft")} type="button">
            − width
          </button>
          <button aria-label={`Widen ${title}`} onClick={() => resize("ArrowRight")} type="button">
            + width
          </button>
          <button aria-label={`Shorten ${title}`} onClick={() => resize("ArrowUp")} type="button">
            − height
          </button>
          <button
            aria-label={`Lengthen ${title}`}
            onClick={() => resize("ArrowDown")}
            type="button"
          >
            + height
          </button>
        </section>
      )}
      {bindingSupported && canEdit && (
        <form
          className="workspace-widget__binding"
          onSubmit={(event) => {
            event.preventDefault();
            store
              .getState()
              .setSymbolBinding(activeWorkspaceId, tabId, instance.instanceId, {
                mode: "fixed",
                symbol: fixedSymbol.trim().toUpperCase(),
              });
          }}
        >
          <span>Symbol:</span>
          <button
            onClick={() =>
              store
                .getState()
                .setSymbolBinding(activeWorkspaceId, tabId, instance.instanceId, undefined)
            }
            type="button"
          >
            Follow {workspace.marketContext.activeSymbol}
          </button>
          <label>
            <span className="workspace-visually-hidden">Fixed symbol for {title}</span>
            <input
              maxLength={24}
              onChange={(event) => setFixedSymbol(event.currentTarget.value)}
              value={fixedSymbol}
            />
          </label>
          <button type="submit">Set fixed</button>
        </form>
      )}
      <div className="workspace-widget__body">
        {resolution.status !== "ready" ? (
          <div className="workspace-widget__inert" role="status">
            <p>{resolutionMessage(resolution)}</p>
            <p>
              Saved data is retained. Add a supported widget from the toolbar or remove this tile.
            </p>
          </div>
        ) : missingPermissions.length > 0 ? (
          <div className="workspace-widget__inert" role="status">
            <p>This widget needs {missingPermissions.join(", ")}.</p>
            <p>Its server routes still enforce access independently of this display.</p>
          </div>
        ) : (
          <WidgetRenderer
            actions={actions}
            auth={auth}
            eventBus={eventBus}
            instance={instance}
            market={market}
            onConfigChange={(next) => {
              store
                .getState()
                .updateWidgetConfig(activeWorkspaceId, tabId, instance.instanceId, next);
            }}
            onWidgetError={onWidgetError}
            resolution={resolution}
            workspace={workspace}
          />
        )}
      </div>
      <p className="workspace-widget__keyboard-hint">
        Ctrl+Shift+arrows move · Alt+Shift+arrows resize
      </p>
    </article>
  );
}

export function WorkspaceGrid(props: WorkspaceGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const maximized = props.tab.maximizedInstanceId;
  const visibleWidgets = maximized
    ? props.tab.widgets.filter((instance) => instance.instanceId === maximized)
    : props.tab.widgets;
  const isStacked = width > 0 && width < 720;
  const layout = useMemo(() => toRglLayout(props.tab.placements), [props.tab.placements]);
  const widgetCardProps = {
    auth: props.auth,
    registry: props.registry,
    workspace: props.workspace,
    tab: props.tab,
    store: props.store,
    eventBus: props.eventBus,
    actions: props.actions,
    market: props.market,
    onWidgetError: props.onWidgetError,
  };

  function commitLayout(next: Layout[]): void {
    const current = props.store.getState().document;
    const workspace = current?.workspaces.find((candidate) => candidate.id === props.workspace.id);
    const tab = workspace?.tabs.find((candidate) => candidate.id === props.tab.id);
    if (!tab) return;
    props.store.getState().commitGrid(
      props.workspace.id,
      props.tab.id,
      next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
    );
  }

  return (
    <div
      className={`workspace-grid-shell${isStacked ? " workspace-grid-shell--stacked" : ""}`}
      ref={containerRef}
    >
      {props.tab.widgets.length === 0 ? (
        <div className="workspace-empty-grid">
          <h2>This tab is ready for widgets</h2>
          <p>Choose a widget from the toolbar to start a focused workspace.</p>
        </div>
      ) : maximized ? (
        <div className="workspace-maximized-grid">
          <button
            aria-label="Restore widget grid"
            className="workspace-restore-grid"
            onClick={() =>
              props.store.getState().maximizeWidget(props.workspace.id, props.tab.id, null)
            }
            type="button"
          >
            Restore grid
          </button>
          {visibleWidgets.map((instance) => (
            <WidgetCard
              key={instance.instanceId}
              {...widgetCardProps}
              canEdit={props.store.getState().canEdit}
              instance={instance}
            />
          ))}
        </div>
      ) : isStacked ? (
        <div className="workspace-stacked-grid">
          {visibleWidgets.map((instance) => (
            <WidgetCard
              key={instance.instanceId}
              {...widgetCardProps}
              canEdit={props.store.getState().canEdit}
              instance={instance}
            />
          ))}
        </div>
      ) : (
        <GridLayout
          className="workspace-grid"
          cols={WORKSPACE_LIMITS.gridColumns}
          compactType={null}
          containerPadding={[0, 0]}
          draggableCancel={DRAG_CANCEL}
          draggableHandle=".workspace-widget__handle"
          isBounded
          isDraggable={props.store.getState().canEdit}
          isResizable={props.store.getState().canEdit}
          layout={layout}
          margin={[8, 8]}
          maxRows={WORKSPACE_LIMITS.gridMaxRows}
          onDragStop={commitLayout}
          onResizeStop={commitLayout}
          preventCollision={false}
          resizeHandles={["se"]}
          rowHeight={28}
          width={width}
        >
          {visibleWidgets.map((instance) => (
            <div key={instance.instanceId} className="workspace-grid__item">
              <WidgetCard
                {...widgetCardProps}
                canEdit={props.store.getState().canEdit}
                instance={instance}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
