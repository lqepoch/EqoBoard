"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useStore } from "zustand";
import {
  useWidgetActionClient,
  useWidgetDataClient,
  useMarketDataReader,
} from "../features/data/MarketDataHost";
import { useWorkspaceCommandRegistration } from "../components/shell/WorkspaceCommandContext";
import type { AuthUiSnapshot } from "../lib/contracts/auth";
import { createWorkspaceStore, type WorkspaceStoreHook } from "../stores/workspace/store";
import {
  WORKSPACE_LIMITS,
  type WorkspaceDocumentV1,
  type WorkspaceTabV1,
  type WorkspaceV1,
} from "./model";
import type { WidgetRegistry } from "../widgets/registry/types";
import { createWidgetEventBus } from "../widgets/sdk/events";
import { WorkspaceGrid } from "../components/workspace/WorkspaceGrid";
import { WorkspaceTransferControls } from "../components/workspace/WorkspaceTransferControls";
import { LegacyWorkspaceImportPanel } from "../components/workspace/LegacyWorkspaceImportPanel";
import {
  bindActiveWorkspaceSymbolSelector,
  canRegisterActiveWorkspaceSymbolSelector,
} from "./command-selector";
import "../components/workspace/workspace.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

export type WorkspaceRootProps = Readonly<{
  auth: AuthUiSnapshot;
  registry: WidgetRegistry;
}>;

function activeWorkspace(document: WorkspaceDocumentV1 | null): WorkspaceV1 | null {
  return (
    document?.workspaces.find((workspace) => workspace.id === document.activeWorkspaceId) ?? null
  );
}

function activeTab(workspace: WorkspaceV1 | null): WorkspaceTabV1 | null {
  return workspace?.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
}

function useAuthScopedStore(auth: AuthUiSnapshot, registry: WidgetRegistry): WorkspaceStoreHook {
  const permissions = auth.permissions.join("|");
  return useMemo(
    () => createWorkspaceStore(auth, registry),
    [
      auth.status,
      auth.authenticated,
      auth.displayName,
      auth.storagePartition,
      permissions,
      registry,
    ],
  );
}

function useHydrateStore(store: WorkspaceStoreHook): void {
  const hydratedStores = useRef<WeakSet<WorkspaceStoreHook> | null>(null);
  const disposalTokens = useRef<WeakMap<WorkspaceStoreHook, number> | null>(null);
  if (!hydratedStores.current) hydratedStores.current = new WeakSet();
  if (!disposalTokens.current) disposalTokens.current = new WeakMap();

  useEffect(() => {
    if (!hydratedStores.current!.has(store)) {
      hydratedStores.current!.add(store);
      void store.getState().hydrate();
    }
    const tokens = disposalTokens.current!;
    const current = (tokens.get(store) ?? 0) + 1;
    tokens.set(store, current);
    return () => {
      const scheduledDisposal = current + 1;
      tokens.set(store, scheduledDisposal);
      queueMicrotask(() => {
        if (tokens.get(store) === scheduledDisposal) store.getState().dispose();
      });
    };
  }, [store]);
}

function SymbolControls({
  workspace,
  store,
  canEdit,
}: {
  workspace: WorkspaceV1;
  store: WorkspaceStoreHook;
  canEdit: boolean;
}) {
  const [symbolDraft, setSymbolDraft] = useState(workspace.marketContext.activeSymbol);
  const [watchlistDraft, setWatchlistDraft] = useState(
    workspace.marketContext.watchlist.join(", "),
  );
  useEffect(() => {
    setSymbolDraft(workspace.marketContext.activeSymbol);
    setWatchlistDraft(workspace.marketContext.watchlist.join(", "));
  }, [workspace.id, workspace.marketContext.activeSymbol, workspace.marketContext.watchlist]);

  function updateSymbol(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    store.getState().setActiveSymbol(workspace.id, symbolDraft);
  }

  function updateWatchlist(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const symbols = watchlistDraft
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    store.getState().setWatchlist(workspace.id, symbols);
  }

  return (
    <div className="workspace-market-controls">
      <form
        aria-label="Active market symbol"
        className="workspace-market-form"
        onSubmit={updateSymbol}
      >
        <label htmlFor="workspace-active-symbol">Active symbol</label>
        <input
          disabled={!canEdit}
          id="workspace-active-symbol"
          maxLength={24}
          onChange={(event) => setSymbolDraft(event.currentTarget.value)}
          value={symbolDraft}
        />
        <button disabled={!canEdit} type="submit">
          Apply
        </button>
      </form>
      <form
        aria-label="Workspace watchlist"
        className="workspace-market-form workspace-watchlist-form"
        onSubmit={updateWatchlist}
      >
        <label htmlFor="workspace-watchlist">Watchlist</label>
        <input
          disabled={!canEdit}
          id="workspace-watchlist"
          maxLength={WORKSPACE_LIMITS.maxWatchlistSymbols * (WORKSPACE_LIMITS.maxSymbolLength + 2)}
          onChange={(event) => setWatchlistDraft(event.currentTarget.value)}
          value={watchlistDraft}
        />
        <button disabled={!canEdit} type="submit">
          Save list
        </button>
      </form>
    </div>
  );
}

function WorkspaceSyncControls({
  store,
  state,
}: {
  store: WorkspaceStoreHook;
  state: ReturnType<WorkspaceStoreHook>;
}) {
  const [recovery, setRecovery] = useState<
    readonly { id: string; createdAt: number; reason: string }[]
  >([]);
  const [recoveryId, setRecoveryId] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const workspaceId = state.document?.activeWorkspaceId;

  async function showRecovery(): Promise<void> {
    if (!workspaceId) return;
    setRecoveryError(null);
    try {
      const points = await state.recoveryPoints(workspaceId);
      setRecovery(points.map(({ id, createdAt, reason }) => ({ id, createdAt, reason })));
      setRecoveryId(points[0]?.id ?? "");
    } catch {
      setRecovery([]);
      setRecoveryId("");
      setRecoveryError("Local recovery copies could not be loaded.");
    }
  }

  async function restore(): Promise<void> {
    if (
      !recoveryId ||
      recovering ||
      !window.confirm(
        "Restore this local recovery copy? The current workspace will be backed up first.",
      )
    )
      return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      await state.restoreRecoveryPoint(recoveryId);
    } catch {
      setRecoveryError("The selected local recovery copy could not be restored.");
    } finally {
      setRecovering(false);
    }
  }

  const statusLabel: Record<typeof state.syncStatus, string> = {
    loading: "Loading workspace",
    saved: "All changes saved",
    pending: "Changes waiting to save",
    saving: "Saving workspace",
    conflict: "Workspace conflict",
    failed: "Save failed",
  };

  return (
    <div
      aria-label="Workspace sync status"
      className={`workspace-sync workspace-sync--${state.syncStatus}`}
    >
      <span aria-live="polite">{statusLabel[state.syncStatus]}</span>
      {state.error && (
        <span className="workspace-sync__error" role="status">
          {state.error}
        </span>
      )}
      {state.syncStatus === "conflict" && (
        <div className="workspace-conflict-actions">
          <button onClick={() => void state.reloadRemote()} type="button">
            Reload latest
          </button>
          <button onClick={() => void state.saveLocalCopy()} type="button">
            Save my edits as a new workspace
          </button>
        </div>
      )}
      <details className="workspace-recovery">
        <summary>Recovery copies</summary>
        <button onClick={() => void showRecovery()} type="button">
          Load local recovery copies
        </button>
        {recoveryError && <p role="alert">{recoveryError}</p>}
        {recovery.length > 0 && (
          <div className="workspace-recovery__controls">
            <label>
              <span>Saved recovery point</span>
              <select
                onChange={(event) => setRecoveryId(event.currentTarget.value)}
                value={recoveryId}
              >
                {recovery.map((point) => (
                  <option key={point.id} value={point.id}>
                    {new Date(point.createdAt).toLocaleString()} · {point.reason}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!state.canEdit || recovering}
              onClick={() => void restore()}
              type="button"
            >
              Restore
            </button>
          </div>
        )}
        {recovery.length === 0 && (
          <p className="workspace-muted">
            Recovery copies are stored in this browser and scoped to this opaque account partition.
          </p>
        )}
      </details>
    </div>
  );
}

function WidgetPalette({
  registry,
  workspace,
  tab,
  store,
  auth,
  open,
  setOpen,
}: {
  registry: WidgetRegistry;
  workspace: WorkspaceV1;
  tab: WorkspaceTabV1;
  store: WorkspaceStoreHook;
  auth: AuthUiSnapshot;
  open: boolean;
  setOpen(value: boolean): void;
}) {
  return (
    <div className="workspace-widget-palette">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        type="button"
      >
        Add widget
      </button>
      {open && (
        <div aria-label="Available widgets" className="workspace-widget-palette__menu" role="menu">
          {registry.list().map((registration) => {
            const missing = registration.manifest.requiredPermissions.filter(
              (permission) => !auth.permissions.includes(permission),
            );
            return (
              <button
                disabled={
                  !store.getState().canEdit ||
                  missing.length > 0 ||
                  tab.widgets.length >= WORKSPACE_LIMITS.maxWidgetsPerTab
                }
                key={registration.manifest.id}
                onClick={() => {
                  store.getState().addWidget(workspace.id, tab.id, registration.manifest.id);
                  setOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <span>{registration.manifest.title}</span>
                <small>
                  {missing.length
                    ? `Requires ${missing.join(", ")}`
                    : registration.manifest.category}
                </small>
              </button>
            );
          })}
          {registry.list().length === 0 && <p>No native widgets are registered yet.</p>}
        </div>
      )}
    </div>
  );
}

export function WorkspaceRoot({ auth, registry }: WorkspaceRootProps) {
  const store = useAuthScopedStore(auth, registry);
  useHydrateStore(store);
  const state = useStore(store);
  const data = useWidgetDataClient();
  const actions = useWidgetActionClient();
  const market = useMarketDataReader();
  const { registerActiveSymbolSelector } = useWorkspaceCommandRegistration();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [widgetError, setWidgetError] = useState<string | null>(null);

  const workspace = activeWorkspace(state.document);
  const tab = activeTab(workspace);
  const canEdit = state.canEdit;
  const activeSymbol = workspace?.marketContext.activeSymbol ?? null;
  const activeWorkspaceIdRef = useRef(workspace?.id ?? null);
  const activeTabIdRef = useRef(tab?.id ?? null);
  const eventBusRef = useRef<ReturnType<typeof createWidgetEventBus> | null>(null);
  const lastPublishedSymbol = useRef<string | null>(null);
  activeWorkspaceIdRef.current = workspace?.id ?? null;
  activeTabIdRef.current = tab?.id ?? null;

  const handleWidgetError = useCallback((errorCode: string) => {
    setWidgetError(
      `A widget reported ${errorCode.replace(/[^a-z-]/gu, "") || "an error"}. Its data boundary remains active.`,
    );
  }, []);

  const setActiveSymbol = useCallback(
    (symbol: string, originInstanceId: string | null) => {
      const currentWorkspaceId = activeWorkspaceIdRef.current;
      const accepted = currentWorkspaceId
        ? store.getState().setActiveSymbol(currentWorkspaceId, symbol)
        : false;
      if (!accepted) return { accepted: false as const, reason: "host-rejected" as const };
      const normalizedSymbol = symbol.trim().toUpperCase();
      lastPublishedSymbol.current = normalizedSymbol;
      eventBusRef.current?.publishActiveSymbol(normalizedSymbol, originInstanceId);
      return { accepted: true as const };
    },
    [store],
  );

  const eventBus = useMemo(
    () =>
      createWidgetEventBus({
        onCommand(command) {
          const accepted = setActiveSymbol(command.symbol, command.originInstanceId);
          return accepted;
        },
      }),
    [setActiveSymbol],
  );
  eventBusRef.current = eventBus;

  useEffect(() => {
    if (activeSymbol && lastPublishedSymbol.current !== activeSymbol) {
      lastPublishedSymbol.current = activeSymbol;
      eventBus.publishActiveSymbol(activeSymbol, null);
    }
  }, [activeSymbol, eventBus]);

  const permissionKey = auth.permissions.join("|");
  const authReady = auth.status === "authenticated" && auth.authenticated;
  const hasWorkspaceWritePermission = auth.permissions.includes("workspace:write");
  useEffect(() => {
    if (
      !workspace ||
      !tab ||
      !canRegisterActiveWorkspaceSymbolSelector({
        authReady,
        hasWorkspaceWritePermission,
        canEdit,
        loadStatus: state.loadStatus,
        workspaceId: workspace.id,
        tabId: tab.id,
      })
    )
      return;
    const registeredWorkspaceId = workspace.id;
    const registeredTabId = tab.id;
    return registerActiveSymbolSelector(
      bindActiveWorkspaceSymbolSelector(
        { workspaceId: registeredWorkspaceId, tabId: registeredTabId },
        () => ({ workspaceId: activeWorkspaceIdRef.current, tabId: activeTabIdRef.current }),
        (symbol) => {
          setActiveSymbol(symbol, null);
        },
      ),
    );
  }, [
    authReady,
    auth.storagePartition,
    permissionKey,
    hasWorkspaceWritePermission,
    canEdit,
    state.loadStatus,
    workspace?.id,
    tab?.id,
    registerActiveSymbolSelector,
    setActiveSymbol,
  ]);

  useEffect(() => {
    function handleShortcuts(event: KeyboardEvent): void {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input,textarea,select,[contenteditable='true']")
      )
        return;
      const digit = event.key;
      if (!/^[1-9]$/u.test(digit) || !workspace || !tab || !canEdit) return;
      const shortcut = `Alt+${digit}` as `Alt+${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
      const registration = registry.getByShortcut(shortcut);
      if (!registration) return;
      event.preventDefault();
      store.getState().addWidget(workspace.id, tab.id, registration.manifest.id);
    }
    window.addEventListener("keydown", handleShortcuts);
    return () => window.removeEventListener("keydown", handleShortcuts);
  }, [canEdit, registry, store, tab, workspace]);

  if (state.loadStatus === "loading" || !state.document) {
    return (
      <div className="workspace-root workspace-root--loading" data-testid="workspace-root">
        <div className="workspace-loading" role="status">
          {state.loadStatus === "loading"
            ? "Loading your owner-scoped workspace…"
            : (state.error ?? "Workspace is unavailable.")}
        </div>
        {state.loadStatus === "error" && (
          <button onClick={() => void state.hydrate()} type="button">
            Retry
          </button>
        )}
        <LegacyWorkspaceImportPanel registry={registry} canImport={false} />
      </div>
    );
  }

  if (!workspace || !tab) {
    return (
      <div className="workspace-root" data-testid="workspace-root">
        <p role="alert">
          The saved workspace selection is invalid. Reload the latest owner version.
        </p>
        <button onClick={() => void state.reloadRemote()} type="button">
          Reload latest
        </button>
      </div>
    );
  }

  return (
    <div className="workspace-root" data-testid="workspace-root">
      <header className="workspace-topbar">
        <div className="workspace-title-block">
          <p className="workspace-eyebrow">EqoBoard · Native workspace</p>
          <h1>Market workspace</h1>
        </div>
        <label className="workspace-select-label">
          <span>Workspace</span>
          <select
            aria-label="Workspace"
            data-testid="workspace-selector"
            onChange={(event) => store.getState().selectWorkspace(event.currentTarget.value)}
            value={workspace.id}
          >
            {state.document.workspaces.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!canEdit || state.document.workspaces.length >= WORKSPACE_LIMITS.maxWorkspaces}
          onClick={() =>
            store.getState().createWorkspace(`Workspace ${state.document!.workspaces.length + 1}`)
          }
          type="button"
        >
          New workspace
        </button>
        <button
          disabled={!canEdit || state.document.workspaces.length <= 1}
          onClick={() => {
            if (
              window.confirm(
                `Delete “${workspace.name}”? A local recovery copy will be written first.`,
              )
            )
              void store.getState().deleteWorkspace(workspace.id);
          }}
          type="button"
        >
          Delete workspace
        </button>
        <WorkspaceSyncControls state={state} store={store} />
      </header>

      {state.loadStatus === "error" && (
        <div className="workspace-error-banner" role="alert">
          {state.error}{" "}
          <button onClick={() => void state.hydrate()} type="button">
            Retry
          </button>
        </div>
      )}
      {!canEdit && (
        <p className="workspace-readonly-banner" role="status">
          This workspace is read-only for the current session.
        </p>
      )}
      {widgetError && (
        <p className="workspace-error-banner" role="status">
          {widgetError}{" "}
          <button onClick={() => setWidgetError(null)} type="button">
            Dismiss
          </button>
        </p>
      )}

      <SymbolControls canEdit={canEdit} store={store} workspace={workspace} />

      <section aria-label="Workspace tabs and widgets" className="workspace-tab-section">
        <div className="workspace-tab-row">
          <div
            aria-label="Workspace tabs"
            className="workspace-tabs"
            data-testid="workspace-tabs"
            onKeyDown={(event) => {
              if (!workspace.tabs.length) return;
              const currentIndex = workspace.tabs.findIndex(
                (candidate) => candidate.id === workspace.activeTabId,
              );
              const nextIndex =
                event.key === "ArrowRight"
                  ? (currentIndex + 1) % workspace.tabs.length
                  : event.key === "ArrowLeft"
                    ? (currentIndex - 1 + workspace.tabs.length) % workspace.tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? workspace.tabs.length - 1
                        : currentIndex;
              if (
                nextIndex !== currentIndex &&
                (event.key === "ArrowRight" ||
                  event.key === "ArrowLeft" ||
                  event.key === "Home" ||
                  event.key === "End")
              ) {
                event.preventDefault();
                const nextTab = workspace.tabs[nextIndex];
                store.getState().selectTab(workspace.id, nextTab.id);
                window.requestAnimationFrame(() =>
                  document.getElementById(`workspace-tab-${nextTab.id}`)?.focus(),
                );
              }
            }}
            role="tablist"
          >
            {workspace.tabs.map((candidate) => (
              <button
                aria-controls={`workspace-panel-${candidate.id}`}
                aria-selected={candidate.id === tab.id}
                className={
                  candidate.id === tab.id ? "workspace-tab workspace-tab--active" : "workspace-tab"
                }
                id={`workspace-tab-${candidate.id}`}
                key={candidate.id}
                onClick={() => store.getState().selectTab(workspace.id, candidate.id)}
                role="tab"
                tabIndex={candidate.id === tab.id ? 0 : -1}
                type="button"
              >
                {candidate.name}
              </button>
            ))}
          </div>
          <div className="workspace-tab-actions">
            <button
              aria-label="Add tab"
              data-testid="workspace-add-tab"
              disabled={!canEdit || workspace.tabs.length >= WORKSPACE_LIMITS.maxTabsPerWorkspace}
              onClick={() => store.getState().createTab(workspace.id)}
              type="button"
            >
              + Tab
            </button>
            <button
              aria-label="Duplicate tab"
              data-testid="workspace-duplicate-tab"
              disabled={!canEdit || workspace.tabs.length >= WORKSPACE_LIMITS.maxTabsPerWorkspace}
              onClick={() => store.getState().duplicateTab(workspace.id, tab.id)}
              type="button"
            >
              Duplicate
            </button>
            <button
              aria-label={`Close ${tab.name} tab`}
              data-testid="workspace-delete-tab"
              disabled={!canEdit || workspace.tabs.length <= 1}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete “${tab.name}”? A local recovery copy will be written first.`,
                  )
                )
                  void store.getState().deleteTab(workspace.id, tab.id);
              }}
              type="button"
            >
              Close tab
            </button>
            <input
              aria-label="Rename active tab"
              maxLength={48}
              onBlur={(event) =>
                store.getState().renameTab(workspace.id, tab.id, event.currentTarget.value)
              }
              key={tab.id}
              defaultValue={tab.name}
            />
          </div>
        </div>

        <div className="workspace-widget-toolbar">
          <WidgetPalette
            auth={auth}
            open={paletteOpen}
            registry={registry}
            setOpen={setPaletteOpen}
            store={store}
            tab={tab}
            workspace={workspace}
          />
          <details className="workspace-templates">
            <summary>Templates</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (store.getState().saveTemplate(workspace.id, templateName)) setTemplateName("");
              }}
            >
              <label htmlFor="workspace-template-name">Save active workspace as a template</label>
              <input
                id="workspace-template-name"
                maxLength={48}
                onChange={(event) => setTemplateName(event.currentTarget.value)}
                value={templateName}
              />
              <button
                disabled={
                  !canEdit ||
                  state.document.userTemplates.length >= WORKSPACE_LIMITS.maxUserTemplates ||
                  !templateName.trim()
                }
                type="submit"
              >
                Save template
              </button>
            </form>
            {state.document.userTemplates.length > 0 && (
              <div className="workspace-template-actions">
                <label htmlFor="workspace-template-choice">Saved templates</label>
                <select
                  id="workspace-template-choice"
                  onChange={(event) => setSelectedTemplateId(event.currentTarget.value)}
                  value={selectedTemplateId}
                >
                  <option value="">Choose a template</option>
                  {state.document.userTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
                <button
                  disabled={
                    !canEdit ||
                    !selectedTemplateId ||
                    state.document.workspaces.length >= WORKSPACE_LIMITS.maxWorkspaces
                  }
                  onClick={() =>
                    selectedTemplateId &&
                    store.getState().createWorkspaceFromTemplate(selectedTemplateId)
                  }
                  type="button"
                >
                  Create workspace
                </button>
                <button
                  disabled={!canEdit || !selectedTemplateId}
                  onClick={() =>
                    selectedTemplateId &&
                    void store.getState().applyTemplateToActiveTab(workspace.id, selectedTemplateId)
                  }
                  type="button"
                >
                  Replace active tab
                </button>
                <button
                  disabled={!canEdit || !selectedTemplateId}
                  onClick={() =>
                    selectedTemplateId && store.getState().deleteTemplate(selectedTemplateId)
                  }
                  type="button"
                >
                  Delete template
                </button>
              </div>
            )}
          </details>
          <button
            disabled={!canEdit}
            onClick={() => {
              if (
                window.confirm(
                  `Reset “${tab.name}” to an empty tab? A recovery copy will be written first.`,
                )
              )
                void store.getState().resetTab(workspace.id, tab.id);
            }}
            type="button"
          >
            Reset tab
          </button>
          <WorkspaceTransferControls
            canEdit={canEdit}
            document={state.document}
            onImport={(document, mode) => store.getState().importDocument(document, mode)}
          />
        </div>
        <div
          aria-labelledby={`workspace-tab-${tab.id}`}
          className="workspace-active-tab"
          id={`workspace-panel-${tab.id}`}
          role="tabpanel"
        >
          <WorkspaceGrid
            actions={actions}
            auth={auth}
            data={data}
            eventBus={eventBus}
            market={market}
            onWidgetError={handleWidgetError}
            registry={registry}
            store={store}
            tab={tab}
            workspace={workspace}
          />
        </div>
        {workspace.tabs
          .filter((candidate) => candidate.id !== tab.id)
          .map((candidate) => (
            <div
              aria-labelledby={`workspace-tab-${candidate.id}`}
              hidden
              id={`workspace-panel-${candidate.id}`}
              key={candidate.id}
              role="tabpanel"
            />
          ))}
      </section>

      <footer className="workspace-footer">
        <LegacyWorkspaceImportPanel
          canImport={canEdit}
          disabledLabel={auth.authenticated ? "Workspace access is read only" : "Sign in to import"}
          onImport={(document) => store.getState().importDocument(document, "copy")}
          registry={registry}
        />
      </footer>
    </div>
  );
}
