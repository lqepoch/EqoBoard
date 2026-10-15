import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import type { WidgetInstanceV1 } from "../../widgets/sdk/contracts";
import type { WidgetRegistry } from "../../widgets/registry/types";
import {
  createEmptyWorkspaceDocument,
  createId,
  WORKSPACE_LIMITS,
  WORKSPACE_SCHEMA_VERSION,
  type GridPlacementV1,
  type WorkspaceDocumentV1,
  type WorkspaceMarketContextV1,
  type WorkspaceTabV1,
  type WorkspaceV1,
} from "../../workspace/model";
import {
  byPosition,
  constraintsForManifest,
  findNextFreePlacement,
  fromGridCallback,
  keyboardMove,
  keyboardResize,
} from "../../workspace/grid";
import {
  cloneDocumentWorkspaces,
  cloneTab,
  cloneWorkspace,
  createEmptyTab,
  createTemplateFromWorkspace,
  createWorkspaceFromTemplate,
  replaceWorkspaceInDocument,
} from "../../workspace/transforms";
import { hasControlCharacters, parseWorkspaceDocument } from "../../workspace/schema";
import {
  createWorkspaceClientRepository,
  type WorkspaceClientRepository,
  type WorkspaceClientSnapshot,
} from "./repository";
import type { WorkspaceRecoveryPoint } from "./backups";

export type WorkspaceLoadStatus = "loading" | "ready" | "error";
export type WorkspaceSyncStatus =
  | "loading"
  | "saved"
  | "pending"
  | "saving"
  | "conflict"
  | "failed";

export type WorkspaceStoreState = Readonly<{
  document: WorkspaceDocumentV1 | null;
  revision: string | null;
  etag: string | null;
  loadStatus: WorkspaceLoadStatus;
  syncStatus: WorkspaceSyncStatus;
  dirty: boolean;
  error: string | null;
  remoteConflict: WorkspaceClientSnapshot | null;
  canEdit: boolean;
  hydrate(): Promise<void>;
  dispose(): void;
  saveNow(): Promise<void>;
  reloadRemote(): Promise<void>;
  saveLocalCopy(): Promise<boolean>;
  selectWorkspace(workspaceId: string): boolean;
  createWorkspace(name?: string): boolean;
  renameWorkspace(workspaceId: string, name: string): boolean;
  deleteWorkspace(workspaceId: string): Promise<boolean>;
  selectTab(workspaceId: string, tabId: string): boolean;
  createTab(workspaceId: string, name?: string): boolean;
  renameTab(workspaceId: string, tabId: string, name: string): boolean;
  duplicateTab(workspaceId: string, tabId: string): boolean;
  deleteTab(workspaceId: string, tabId: string): Promise<boolean>;
  addWidget(workspaceId: string, tabId: string, manifestId: string): string | null;
  duplicateWidget(workspaceId: string, tabId: string, instanceId: string): string | null;
  removeWidget(workspaceId: string, tabId: string, instanceId: string): Promise<boolean>;
  updateWidgetConfig(
    workspaceId: string,
    tabId: string,
    instanceId: string,
    nextConfig: unknown,
  ): boolean;
  setSymbolBinding(
    workspaceId: string,
    tabId: string,
    instanceId: string,
    binding: WidgetInstanceV1["symbolBinding"],
  ): boolean;
  setActiveSymbol(workspaceId: string, symbol: string): boolean;
  setWatchlist(workspaceId: string, symbols: readonly string[]): boolean;
  commitGrid(workspaceId: string, tabId: string, layout: readonly GridPlacementV1[]): boolean;
  moveWidget(
    workspaceId: string,
    tabId: string,
    instanceId: string,
    key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  ): boolean;
  resizeWidget(
    workspaceId: string,
    tabId: string,
    instanceId: string,
    key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  ): boolean;
  maximizeWidget(workspaceId: string, tabId: string, instanceId: string | null): boolean;
  resetTab(workspaceId: string, tabId: string): Promise<boolean>;
  saveTemplate(workspaceId: string, name: string): boolean;
  deleteTemplate(templateId: string): boolean;
  createWorkspaceFromTemplate(templateId: string, name?: string): boolean;
  applyTemplateToActiveTab(workspaceId: string, templateId: string): Promise<boolean>;
  importDocument(document: WorkspaceDocumentV1, mode: "copy" | "replace"): Promise<boolean>;
  recoveryPoints(workspaceId: string): Promise<readonly WorkspaceRecoveryPoint[]>;
  restoreRecoveryPoint(recoveryPointId: string): Promise<boolean>;
}>;

export type WorkspaceStoreHook = UseBoundStore<StoreApi<WorkspaceStoreState>>;

type CreateStoreOptions = Readonly<{
  repository?: WorkspaceClientRepository;
  debounceMs?: number;
}>;

const SAVE_DEBOUNCE_MS = 250;
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= WORKSPACE_LIMITS.maxNameLength &&
    !hasControlCharacters(trimmed)
    ? trimmed
    : null;
}

function validSymbol(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 &&
    normalized.length <= WORKSPACE_LIMITS.maxSymbolLength &&
    /^(?=.*[A-Z0-9])[A-Z0-9.\-^=&]{1,24}$/u.test(normalized)
    ? normalized
    : null;
}

function activeWorkspace(
  document: WorkspaceDocumentV1 | null,
  workspaceId: string,
): WorkspaceV1 | null {
  return document?.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

function activeTab(workspace: WorkspaceV1 | null, tabId: string): WorkspaceTabV1 | null {
  return workspace?.tabs.find((tab) => tab.id === tabId) ?? null;
}

function replaceTab(workspace: WorkspaceV1, tab: WorkspaceTabV1): WorkspaceV1 {
  return {
    ...workspace,
    tabs: workspace.tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate)),
  };
}

function uniqueWorkspaceName(document: WorkspaceDocumentV1, requested: string): string {
  const base = validName(requested) ?? "Workspace";
  const existing = new Set(document.workspaces.map((workspace) => workspace.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  for (let index = 2; index <= WORKSPACE_LIMITS.maxWorkspaces + 1; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${base.slice(0, WORKSPACE_LIMITS.maxNameLength - suffix.length)}${suffix}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function parseRemoteMessage(
  value: unknown,
): value is { type: "workspace.changed.v1"; workspaceId: string; revision: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.type === "workspace.changed.v1" &&
    typeof record.workspaceId === "string" &&
    WORKSPACE_ID_PATTERN.test(record.workspaceId) &&
    typeof record.revision === "string" &&
    record.revision.length > 0 &&
    record.revision.length <= 256
  );
}

function compareRevisions(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Per-auth-snapshot Zustand store. The browser partition is cache-only; the BFF owns identity. */
export function createWorkspaceStore(
  auth: AuthUiSnapshot,
  registry: WidgetRegistry,
  options: CreateStoreOptions = {},
): WorkspaceStoreHook {
  const repository = options.repository ?? createWorkspaceClientRepository(auth);
  const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
  let store: WorkspaceStoreHook;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let saveAgain = false;
  let mutationVersion = 0;
  let hydrateSequence = 0;
  let remoteReadSequence = 0;
  let disposed = false;
  let channel: BroadcastChannel | null = null;

  function clearSaveTimer(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
  }

  function scheduleSave(): void {
    clearSaveTimer();
    if (!repository.canWrite || disposed) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void store.getState().saveNow();
    }, debounceMs);
  }

  function persist(next: WorkspaceDocumentV1): boolean {
    if (!repository.canWrite || disposed) return false;
    const parsed = parseWorkspaceDocument(next);
    if (!parsed.ok) {
      store.setState({ error: "Workspace change was rejected by the v1 document validator." });
      return false;
    }
    mutationVersion += 1;
    const current = store.getState();
    const conflictUnresolved = current.syncStatus === "conflict" || current.remoteConflict !== null;
    store.setState({
      document: parsed.value,
      dirty: true,
      syncStatus: conflictUnresolved ? "conflict" : "pending",
      error: conflictUnresolved ? current.error : null,
      remoteConflict: current.remoteConflict,
    });
    if (!conflictUnresolved) scheduleSave();
    return true;
  }

  async function backupWorkspaces(
    workspaces: readonly WorkspaceV1[],
    reason: "replace" | "reset" | "delete" | "import" | "restore",
  ): Promise<boolean> {
    if (!repository.canWrite || disposed) return false;
    for (const workspace of workspaces) {
      try {
        await repository.backup(workspace, reason);
      } catch {
        store.setState({
          error: "The local recovery copy could not be written; the change was not applied.",
        });
        return false;
      }
    }
    return true;
  }

  async function refreshAfterRemoteRevision(): Promise<void> {
    const sequence = ++remoteReadSequence;
    const latest = await repository.load();
    if (disposed || sequence !== remoteReadSequence) return;
    if (!latest.ok) {
      clearSaveTimer();
      saveAgain = false;
      store.setState({
        syncStatus: "conflict",
        error: "Another tab saved this workspace. Reload the latest version to continue.",
      });
      return;
    }
    const current = store.getState();
    const knownRevision =
      current.remoteConflict !== null &&
      (current.revision === null ||
        compareRevisions(current.remoteConflict.revision, current.revision) > 0)
        ? current.remoteConflict.revision
        : current.revision;
    if (knownRevision !== null && compareRevisions(latest.value.revision, knownRevision) <= 0)
      return;
    if (current.dirty || current.syncStatus === "saving") {
      clearSaveTimer();
      saveAgain = false;
      store.setState({
        remoteConflict: latest.value,
        syncStatus: "conflict",
        error:
          "This workspace changed in another tab. Keep your edits as a new workspace or reload.",
      });
      return;
    }
    if (latest.value.document) {
      store.setState({
        document: latest.value.document,
        revision: latest.value.revision,
        etag: latest.value.etag,
        dirty: false,
        syncStatus: "saved",
        error: null,
        remoteConflict: null,
      });
    }
  }

  store = create<WorkspaceStoreState>()((set, get) => ({
    document: null,
    revision: null,
    etag: null,
    loadStatus: "loading",
    syncStatus: "loading",
    dirty: false,
    error: null,
    remoteConflict: null,
    canEdit: repository.canWrite,

    async hydrate() {
      const sequence = ++hydrateSequence;
      set({ loadStatus: "loading", syncStatus: "loading", error: null });
      if (!auth.authenticated) {
        set({
          loadStatus: "error",
          syncStatus: "failed",
          error: "Sign in to load or edit a workspace.",
        });
        return;
      }
      if (!repository.canRead) {
        set({
          loadStatus: "error",
          syncStatus: "failed",
          error: "This account cannot read workspace data.",
        });
        return;
      }
      const result = await repository.load();
      if (disposed || sequence !== hydrateSequence) return;
      if (!result.ok) {
        set({ loadStatus: "error", syncStatus: "failed", error: result.message });
        return;
      }
      if (result.value.document) {
        set({
          document: result.value.document,
          revision: result.value.revision,
          etag: result.value.etag,
          loadStatus: "ready",
          syncStatus: "saved",
          dirty: false,
          error: null,
          remoteConflict: null,
        });
        return;
      }
      const initialDocument = createEmptyWorkspaceDocument();
      set({
        document: initialDocument,
        revision: result.value.revision,
        etag: result.value.etag,
        loadStatus: "ready",
        syncStatus: repository.canWrite ? "pending" : "saved",
        dirty: repository.canWrite,
        error: null,
        remoteConflict: null,
      });
      if (repository.canWrite) {
        mutationVersion += 1;
        scheduleSave();
      }
    },

    dispose() {
      disposed = true;
      hydrateSequence += 1;
      remoteReadSequence += 1;
      clearSaveTimer();
      channel?.close();
      channel = null;
      repository.dispose?.();
    },

    async saveNow() {
      clearSaveTimer();
      const current = get();
      if (!current.dirty || !current.document || !current.etag || !repository.canWrite || disposed)
        return;
      if (inFlight) {
        saveAgain = true;
        return;
      }
      inFlight = true;
      const version = mutationVersion;
      const documentToSave = current.document;
      const workspaceToSave = activeWorkspace(documentToSave, documentToSave.activeWorkspaceId);
      set({ syncStatus: "saving", error: null });
      if (workspaceToSave) {
        try {
          await repository.backup(workspaceToSave, "save");
        } catch {
          set({ error: "The latest workspace could not be added to local recovery storage." });
        }
      }
      if (disposed) {
        inFlight = false;
        return;
      }
      let result: Awaited<ReturnType<WorkspaceClientRepository["save"]>>;
      try {
        result = await repository.save(documentToSave, current.etag);
      } catch {
        inFlight = false;
        set({ syncStatus: "failed", error: "Workspace storage could not be reached." });
        return;
      }
      inFlight = false;
      if (disposed) return;
      if (!result.ok) {
        if (result.code === "conflict") {
          set({
            syncStatus: "conflict",
            remoteConflict: result.current,
            error:
              "Another tab saved a newer workspace version. Reload it or save your edits as a new workspace.",
          });
        } else {
          set({ syncStatus: "failed", error: result.message });
        }
        if (saveAgain) {
          saveAgain = false;
          return;
        }
        return;
      }
      const now = get();
      const currentRevisionIsNewer =
        now.revision !== null && compareRevisions(now.revision, result.snapshot.revision) > 0;
      const conflictRevisionIsNewer =
        now.remoteConflict !== null &&
        compareRevisions(now.remoteConflict.revision, result.snapshot.revision) > 0 &&
        (now.revision === null ||
          compareRevisions(now.remoteConflict.revision, now.revision) >= 0);
      if (conflictRevisionIsNewer) {
        clearSaveTimer();
        saveAgain = false;
        set({
          syncStatus: "conflict",
          error:
            "Another tab saved a newer workspace version. Reload it or save your edits as a new workspace.",
        });
        return;
      }
      if (currentRevisionIsNewer) {
        const shouldResave = now.dirty;
        saveAgain = false;
        clearSaveTimer();
        if (now.syncStatus === "saving") {
          set({ syncStatus: shouldResave ? "pending" : "saved" });
        }
        if (shouldResave && get().syncStatus !== "conflict") {
          if (get().syncStatus !== "pending") set({ syncStatus: "pending" });
          scheduleSave();
        }
        return;
      }
      const unchanged = version === mutationVersion;
      set({
        revision: result.snapshot.revision,
        etag: result.snapshot.etag,
        ...(unchanged
          ? { document: result.snapshot.document, dirty: false, syncStatus: "saved" as const }
          : { dirty: true, syncStatus: "pending" as const }),
        error: now.error,
        remoteConflict: null,
      });
      const savedWorkspaceId = result.snapshot.document?.activeWorkspaceId;
      if (savedWorkspaceId && channel) {
        channel.postMessage({
          type: "workspace.changed.v1",
          workspaceId: savedWorkspaceId,
          revision: result.snapshot.revision,
        });
      }
      if (!unchanged || saveAgain) {
        saveAgain = false;
        scheduleSave();
      }
    },

    async reloadRemote() {
      const sequence = ++remoteReadSequence;
      const currentDocument = get().document;
      const startingVersion = mutationVersion;
      const currentWorkspace =
        currentDocument && activeWorkspace(currentDocument, currentDocument.activeWorkspaceId);
      if (currentWorkspace) {
        try {
          await repository.backup(currentWorkspace, "restore");
        } catch {
          set({
            error: "The local recovery copy could not be written; remote data was not loaded.",
          });
          return;
        }
      }
      if (
        disposed ||
        sequence !== remoteReadSequence ||
        get().document !== currentDocument ||
        mutationVersion !== startingVersion
      ) {
        set({ error: "The workspace changed while reload was preparing; nothing was replaced." });
        return;
      }
      const latest = await repository.load();
      if (
        disposed ||
        sequence !== remoteReadSequence ||
        get().document !== currentDocument ||
        mutationVersion !== startingVersion
      ) {
        set({ error: "The workspace changed while reload was in progress; nothing was replaced." });
        return;
      }
      if (!latest.ok) {
        set({ error: latest.message, syncStatus: "failed" });
        return;
      }
      const document = latest.value.document ?? createEmptyWorkspaceDocument();
      set({
        document,
        revision: latest.value.revision,
        etag: latest.value.etag,
        loadStatus: "ready",
        syncStatus: "saved",
        dirty: false,
        error: null,
        remoteConflict: null,
      });
    },

    async saveLocalCopy() {
      if (!repository.canWrite || disposed) return false;
      const localDocument = get().document;
      const localWorkspace =
        localDocument && activeWorkspace(localDocument, localDocument.activeWorkspaceId);
      if (!localDocument || !localWorkspace) return false;
      const startingVersion = mutationVersion;
      try {
        await repository.backup(localWorkspace, "save");
      } catch {
        set({ error: "The local recovery copy could not be written; no copy was created." });
        return false;
      }
      const latest = await repository.load();
      if (disposed || startingVersion !== mutationVersion || get().document !== localDocument)
        return false;
      if (!latest.ok) {
        set({ error: latest.message, syncStatus: "failed" });
        return false;
      }
      const baseDocument = latest.value.document ?? createEmptyWorkspaceDocument();
      if (baseDocument.workspaces.length >= WORKSPACE_LIMITS.maxWorkspaces) {
        set({
          error:
            "The workspace limit is full. Remove or export a workspace before saving this copy.",
        });
        return false;
      }
      const copy = cloneWorkspace(
        localWorkspace,
        uniqueWorkspaceName(baseDocument, `${localWorkspace.name} copy`),
      );
      const merged: WorkspaceDocumentV1 = {
        ...baseDocument,
        activeWorkspaceId: copy.id,
        workspaces: [...baseDocument.workspaces, copy],
      };
      set({
        document: baseDocument,
        revision: latest.value.revision,
        etag: latest.value.etag,
        dirty: false,
        syncStatus: "saved",
        remoteConflict: null,
      });
      return persist(merged);
    },

    selectWorkspace(workspaceId) {
      const document = get().document;
      if (!document?.workspaces.some((workspace) => workspace.id === workspaceId)) return false;
      return persist({ ...document, activeWorkspaceId: workspaceId });
    },

    createWorkspace(requestedName = "Workspace") {
      const document = get().document;
      if (!document || document.workspaces.length >= WORKSPACE_LIMITS.maxWorkspaces) return false;
      const source = activeWorkspace(document, document.activeWorkspaceId);
      const context: WorkspaceMarketContextV1 = source?.marketContext ?? {
        activeSymbol: "SPY",
        watchlist: ["SPY"],
      };
      const tab = createEmptyTab();
      const workspace: WorkspaceV1 = {
        id: createId(),
        name: uniqueWorkspaceName(document, requestedName),
        activeTabId: tab.id,
        marketContext: { activeSymbol: context.activeSymbol, watchlist: [...context.watchlist] },
        tabs: [tab],
      };
      return persist({
        ...document,
        activeWorkspaceId: workspace.id,
        workspaces: [...document.workspaces, workspace],
      });
    },

    renameWorkspace(workspaceId, requestedName) {
      const document = get().document;
      const name = validName(requestedName);
      if (
        !document ||
        !name ||
        !document.workspaces.some((workspace) => workspace.id === workspaceId)
      )
        return false;
      return persist({
        ...document,
        workspaces: document.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, name } : workspace,
        ),
      });
    },

    async deleteWorkspace(workspaceId) {
      const document = get().document;
      const startingVersion = mutationVersion;
      if (!document || document.workspaces.length <= 1) return false;
      const removed = activeWorkspace(document, workspaceId);
      if (!removed || !(await backupWorkspaces([removed], "delete"))) return false;
      if (disposed || get().document !== document || startingVersion !== mutationVersion)
        return false;
      const workspaces = document.workspaces.filter((workspace) => workspace.id !== workspaceId);
      const activeWorkspaceId =
        document.activeWorkspaceId === workspaceId ? workspaces[0].id : document.activeWorkspaceId;
      return persist({ ...document, workspaces, activeWorkspaceId });
    },

    selectTab(workspaceId, tabId) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      if (!document || !workspace?.tabs.some((tab) => tab.id === tabId)) return false;
      return persist(replaceWorkspaceInDocument(document, { ...workspace, activeTabId: tabId }));
    },

    createTab(workspaceId, requestedName = "New tab") {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      if (!document || !workspace || workspace.tabs.length >= WORKSPACE_LIMITS.maxTabsPerWorkspace)
        return false;
      const tab = createEmptyTab(validName(requestedName) ?? "New tab");
      return persist(
        replaceWorkspaceInDocument(document, {
          ...workspace,
          activeTabId: tab.id,
          tabs: [...workspace.tabs, tab],
        }),
      );
    },

    renameTab(workspaceId, tabId, requestedName) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const name = validName(requestedName);
      if (!document || !workspace || !name || !workspace.tabs.some((tab) => tab.id === tabId))
        return false;
      const tabs = workspace.tabs.map((tab) => (tab.id === tabId ? { ...tab, name } : tab));
      return persist(replaceWorkspaceInDocument(document, { ...workspace, tabs }));
    },

    duplicateTab(workspaceId, tabId) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const source = activeTab(workspace, tabId);
      if (
        !document ||
        !workspace ||
        !source ||
        workspace.tabs.length >= WORKSPACE_LIMITS.maxTabsPerWorkspace
      )
        return false;
      const tab = cloneTab(source, uniqueTabName(workspace, `${source.name} copy`));
      return persist(
        replaceWorkspaceInDocument(document, {
          ...workspace,
          activeTabId: tab.id,
          tabs: [...workspace.tabs, tab],
        }),
      );
    },

    async deleteTab(workspaceId, tabId) {
      const document = get().document;
      const startingVersion = mutationVersion;
      const workspace = activeWorkspace(document, workspaceId);
      if (!document || !workspace || workspace.tabs.length <= 1) return false;
      const removed = activeTab(workspace, tabId);
      if (!removed || !(await backupWorkspaces([workspace], "delete"))) return false;
      if (disposed || get().document !== document || startingVersion !== mutationVersion)
        return false;
      const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId = workspace.activeTabId === tabId ? tabs[0].id : workspace.activeTabId;
      return persist(replaceWorkspaceInDocument(document, { ...workspace, tabs, activeTabId }));
    },

    addWidget(workspaceId, tabId, manifestId) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      const registration = registry.get(manifestId);
      if (
        !document ||
        !workspace ||
        !tab ||
        !registration ||
        tab.widgets.length >= WORKSPACE_LIMITS.maxWidgetsPerTab
      )
        return null;
      const config = registry.parseConfig(
        registration.manifest.configSchemaId,
        registration.createDefaultConfig(),
      );
      if (!config.ok) return null;
      const instanceId = createId();
      const instance: WidgetInstanceV1 = {
        instanceId,
        manifestId: registration.manifest.id,
        manifestVersion: registration.manifest.version,
        configSchemaId: registration.manifest.configSchemaId,
        config: config.value as WidgetInstanceV1["config"],
      };
      const constraints = constraintsForManifest(registry, manifestId);
      const placement = findNextFreePlacement(
        tab.placements,
        instanceId,
        registration.manifest.defaultSize,
        constraints,
      );
      if (!placement) return null;
      const updatedTab: WorkspaceTabV1 = {
        ...tab,
        widgets: [...tab.widgets, instance],
        placements: [...tab.placements, placement].sort(byPosition),
      };
      return persist(replaceWorkspaceInDocument(document, replaceTab(workspace, updatedTab)))
        ? instanceId
        : null;
    },

    duplicateWidget(workspaceId, tabId, instanceId) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      const source = tab?.widgets.find((widget) => widget.instanceId === instanceId);
      if (
        !document ||
        !workspace ||
        !tab ||
        !source ||
        tab.widgets.length >= WORKSPACE_LIMITS.maxWidgetsPerTab
      )
        return null;
      const registration = registry.get(source.manifestId);
      const config = registry.parseConfig(source.configSchemaId, source.config);
      if (!registration || !config.ok) return null;
      const duplicate: WidgetInstanceV1 = {
        ...source,
        instanceId: createId(),
        config: structuredClone(config.value) as WidgetInstanceV1["config"],
      };
      const sourcePlacement = tab.placements.find((placement) => placement.i === instanceId);
      if (!sourcePlacement) return null;
      const placement = findNextFreePlacement(
        tab.placements,
        duplicate.instanceId,
        sourcePlacement,
        constraintsForManifest(registry, duplicate.manifestId),
      );
      if (!placement) return null;
      const updatedTab = {
        ...tab,
        widgets: [...tab.widgets, duplicate],
        placements: [...tab.placements, placement].sort(byPosition),
      };
      return persist(replaceWorkspaceInDocument(document, replaceTab(workspace, updatedTab)))
        ? duplicate.instanceId
        : null;
    },

    async removeWidget(workspaceId, tabId, instanceId) {
      const document = get().document;
      const startingVersion = mutationVersion;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      if (
        !document ||
        !workspace ||
        !tab?.widgets.some((widget) => widget.instanceId === instanceId)
      )
        return false;
      if (!(await backupWorkspaces([workspace], "delete"))) return false;
      if (disposed || get().document !== document || startingVersion !== mutationVersion)
        return false;
      const updatedTab = {
        ...tab,
        widgets: tab.widgets.filter((widget) => widget.instanceId !== instanceId),
        placements: tab.placements.filter((placement) => placement.i !== instanceId),
        maximizedInstanceId:
          tab.maximizedInstanceId === instanceId ? null : tab.maximizedInstanceId,
      };
      return persist(replaceWorkspaceInDocument(document, replaceTab(workspace, updatedTab)));
    },

    updateWidgetConfig(workspaceId, tabId, instanceId, nextConfig) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      const widget = tab?.widgets.find((candidate) => candidate.instanceId === instanceId);
      if (!document || !workspace || !tab || !widget) return false;
      const parsed = registry.parseConfig(widget.configSchemaId, nextConfig);
      if (!parsed.ok) return false;
      const widgets = tab.widgets.map((candidate) =>
        candidate.instanceId === instanceId
          ? { ...candidate, config: parsed.value as WidgetInstanceV1["config"] }
          : candidate,
      );
      return persist(
        replaceWorkspaceInDocument(document, replaceTab(workspace, { ...tab, widgets })),
      );
    },

    setSymbolBinding(workspaceId, tabId, instanceId, binding) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      const widget = tab?.widgets.find((candidate) => candidate.instanceId === instanceId);
      if (!document || !workspace || !tab || !widget) return false;
      if (registry.get(widget.manifestId)?.manifest.symbolBinding !== "active-or-fixed")
        return false;
      if (binding?.mode === "fixed" && !validSymbol(binding.symbol)) return false;
      const widgets = tab.widgets.map((candidate) => {
        if (candidate.instanceId !== instanceId) return candidate;
        const { symbolBinding: _oldBinding, ...rest } = candidate;
        return binding ? { ...rest, symbolBinding: binding } : rest;
      });
      return persist(
        replaceWorkspaceInDocument(document, replaceTab(workspace, { ...tab, widgets })),
      );
    },

    setActiveSymbol(workspaceId, rawSymbol) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const symbol = validSymbol(rawSymbol);
      if (!document || !workspace || !symbol) return false;
      return persist(
        replaceWorkspaceInDocument(document, {
          ...workspace,
          marketContext: { ...workspace.marketContext, activeSymbol: symbol },
        }),
      );
    },

    setWatchlist(workspaceId, rawSymbols) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      if (!document || !workspace || rawSymbols.length > WORKSPACE_LIMITS.maxWatchlistSymbols)
        return false;
      const symbols = rawSymbols.map(validSymbol);
      if (symbols.some((symbol) => symbol === null)) return false;
      const normalized = symbols as string[];
      if (new Set(normalized.map((symbol) => symbol.toUpperCase())).size !== normalized.length)
        return false;
      return persist(
        replaceWorkspaceInDocument(document, {
          ...workspace,
          marketContext: { ...workspace.marketContext, watchlist: normalized },
        }),
      );
    },

    commitGrid(workspaceId, tabId, layout) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      if (!document || !workspace || !tab) return false;
      const normalized = fromGridCallback(layout, tab, registry);
      if (!normalized.ok) return false;
      return persist(
        replaceWorkspaceInDocument(
          document,
          replaceTab(workspace, { ...tab, placements: normalized.placements }),
        ),
      );
    },

    moveWidget(workspaceId, tabId, instanceId, key) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      if (!document || !workspace || !tab) return false;
      const result = keyboardMove(tab.placements, instanceId, key);
      return (
        result.ok &&
        persist(
          replaceWorkspaceInDocument(
            document,
            replaceTab(workspace, { ...tab, placements: result.placements }),
          ),
        )
      );
    },

    resizeWidget(workspaceId, tabId, instanceId, key) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      const widget = tab?.widgets.find((candidate) => candidate.instanceId === instanceId);
      if (!document || !workspace || !tab || !widget) return false;
      const result = keyboardResize(
        tab.placements,
        instanceId,
        key,
        constraintsForManifest(registry, widget.manifestId),
      );
      return (
        result.ok &&
        persist(
          replaceWorkspaceInDocument(
            document,
            replaceTab(workspace, { ...tab, placements: result.placements }),
          ),
        )
      );
    },

    maximizeWidget(workspaceId, tabId, instanceId) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      if (
        !document ||
        !workspace ||
        !tab ||
        (instanceId !== null && !tab.widgets.some((widget) => widget.instanceId === instanceId))
      )
        return false;
      return persist(
        replaceWorkspaceInDocument(
          document,
          replaceTab(workspace, { ...tab, maximizedInstanceId: instanceId }),
        ),
      );
    },

    async resetTab(workspaceId, tabId) {
      const document = get().document;
      const startingVersion = mutationVersion;
      const workspace = activeWorkspace(document, workspaceId);
      const tab = activeTab(workspace, tabId);
      if (!document || !workspace || !tab || !(await backupWorkspaces([workspace], "reset")))
        return false;
      if (disposed || get().document !== document || startingVersion !== mutationVersion)
        return false;
      const reset = { ...tab, widgets: [], placements: [], maximizedInstanceId: null };
      return persist(replaceWorkspaceInDocument(document, replaceTab(workspace, reset)));
    },

    saveTemplate(workspaceId, requestedName) {
      const document = get().document;
      const workspace = activeWorkspace(document, workspaceId);
      const name = validName(requestedName);
      if (
        !document ||
        !workspace ||
        !name ||
        document.userTemplates.length >= WORKSPACE_LIMITS.maxUserTemplates
      )
        return false;
      const template = createTemplateFromWorkspace(workspace, name);
      return persist({ ...document, userTemplates: [...document.userTemplates, template] });
    },

    deleteTemplate(templateId) {
      const document = get().document;
      if (!document?.userTemplates.some((template) => template.id === templateId)) return false;
      return persist({
        ...document,
        userTemplates: document.userTemplates.filter((template) => template.id !== templateId),
      });
    },

    createWorkspaceFromTemplate(templateId, requestedName) {
      const document = get().document;
      const template = document?.userTemplates.find((candidate) => candidate.id === templateId);
      if (!document || !template || document.workspaces.length >= WORKSPACE_LIMITS.maxWorkspaces)
        return false;
      const workspace = createWorkspaceFromTemplate(
        template,
        uniqueWorkspaceName(document, requestedName ?? template.name),
      );
      return persist({
        ...document,
        activeWorkspaceId: workspace.id,
        workspaces: [...document.workspaces, workspace],
      });
    },

    async applyTemplateToActiveTab(workspaceId, templateId) {
      const document = get().document;
      const startingVersion = mutationVersion;
      const workspace = activeWorkspace(document, workspaceId);
      const template = document?.userTemplates.find((candidate) => candidate.id === templateId);
      const currentTab = workspace && activeTab(workspace, workspace.activeTabId);
      if (
        !document ||
        !workspace ||
        !template ||
        !currentTab ||
        !(await backupWorkspaces([workspace], "replace"))
      )
        return false;
      if (disposed || get().document !== document || startingVersion !== mutationVersion)
        return false;
      const cloned = cloneTab(template.tab, currentTab.name);
      const nextWorkspace = replaceTab(workspace, cloned);
      return persist(
        replaceWorkspaceInDocument(document, {
          ...nextWorkspace,
          activeTabId: cloned.id,
          marketContext: {
            activeSymbol: template.marketContext.activeSymbol,
            watchlist: [...template.marketContext.watchlist],
          },
        }),
      );
    },

    async importDocument(imported, mode) {
      const parsed = parseWorkspaceDocument(imported);
      const current = get().document;
      const startingVersion = mutationVersion;
      if (!parsed.ok || !current) return false;
      if (mode === "replace") {
        if (!(await backupWorkspaces(current.workspaces, "import"))) return false;
        if (disposed || get().document !== current || startingVersion !== mutationVersion)
          return false;
        return persist(cloneDocumentWorkspaces(parsed.value));
      }
      if (
        current.workspaces.length + parsed.value.workspaces.length >
          WORKSPACE_LIMITS.maxWorkspaces ||
        current.userTemplates.length + parsed.value.userTemplates.length >
          WORKSPACE_LIMITS.maxUserTemplates
      )
        return false;
      const cloned = cloneDocumentWorkspaces(parsed.value);
      const workspaces: WorkspaceV1[] = [];
      for (const workspace of cloned.workspaces) {
        const namespace = { ...current, workspaces: [...current.workspaces, ...workspaces] };
        workspaces.push({ ...workspace, name: uniqueWorkspaceName(namespace, workspace.name) });
      }
      const userTemplates = [
        ...current.userTemplates,
        ...cloned.userTemplates.map((template) => ({
          ...template,
          name: validName(template.name) ?? "Imported template",
        })),
      ];
      const document: WorkspaceDocumentV1 = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        activeWorkspaceId: workspaces[0].id,
        workspaces: [...current.workspaces, ...workspaces],
        userTemplates,
      };
      return persist(document);
    },

    async recoveryPoints(workspaceId) {
      return repository.recoveryPoints(workspaceId);
    },

    async restoreRecoveryPoint(recoveryPointId) {
      const current = get().document;
      const point = await repository.recoveryPoint(recoveryPointId);
      const startingVersion = mutationVersion;
      if (
        !current ||
        !point ||
        disposed ||
        get().document !== current ||
        startingVersion !== mutationVersion
      )
        return false;
      const existing = activeWorkspace(current, point.workspaceId);
      if (existing && !(await backupWorkspaces([existing], "restore"))) return false;
      if (disposed || get().document !== current || startingVersion !== mutationVersion)
        return false;
      if (existing) {
        const restored = { ...point.workspace, id: existing.id };
        return persist(replaceWorkspaceInDocument(current, restored));
      }
      if (current.workspaces.length >= WORKSPACE_LIMITS.maxWorkspaces) return false;
      const restored = cloneWorkspace(
        point.workspace,
        uniqueWorkspaceName(current, point.workspace.name),
      );
      return persist({
        ...current,
        activeWorkspaceId: restored.id,
        workspaces: [...current.workspaces, restored],
      });
    },
  }));

  if (
    typeof window !== "undefined" &&
    typeof BroadcastChannel !== "undefined" &&
    auth.authenticated &&
    repository.partition
  ) {
    channel = new BroadcastChannel(`eqoboard-workspace-v1:${repository.partition}`);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!parseRemoteMessage(event.data)) return;
      const current = store.getState();
      if (event.data.revision === current.revision) return;
      void refreshAfterRemoteRevision();
    };
  }

  return store;
}

function uniqueTabName(workspace: WorkspaceV1, requested: string): string {
  const base = validName(requested) ?? "Tab";
  const existing = new Set(workspace.tabs.map((tab) => tab.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  for (let index = 2; index <= WORKSPACE_LIMITS.maxTabsPerWorkspace + 1; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${base.slice(0, WORKSPACE_LIMITS.maxNameLength - suffix.length)}${suffix}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
