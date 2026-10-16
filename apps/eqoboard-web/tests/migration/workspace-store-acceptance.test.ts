import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import { createWidgetRegistry } from "../../widgets/registry/create";
import type { WorkspaceDocumentV1 } from "../../workspace/model";
import { createWorkspaceStore } from "../../stores/workspace/store";
import type {
  WorkspaceClientRepository,
  WorkspaceClientSnapshot,
  WorkspaceSaveResult,
} from "../../stores/workspace/repository";

function document(
  name: string,
  workspaceId = "11111111-1111-4111-8111-111111111111",
): WorkspaceDocumentV1 {
  const tabId = "22222222-2222-4222-8222-222222222222";
  return {
    schemaVersion: 1,
    activeWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name,
        activeTabId: tabId,
        marketContext: { activeSymbol: "SPY", watchlist: ["SPY", "QQQ"] },
        tabs: [
          { id: tabId, name: "Overview", widgets: [], placements: [], maximizedInstanceId: null },
        ],
      },
    ],
    userTemplates: [],
  };
}

function auth(permissions: AuthUiSnapshot["permissions"], authenticated = true): AuthUiSnapshot {
  return {
    status: authenticated ? "authenticated" : "sign-in-required",
    authenticated,
    displayName: authenticated ? "Acceptance User" : null,
    permissions,
    storagePartition: authenticated ? "opaque-acceptance-partition" : null,
  };
}

function fakeRepository(
  initial: WorkspaceDocumentV1 | null,
  canWrite: boolean,
  backup: WorkspaceClientRepository["backup"] = vi.fn(async () => undefined),
): WorkspaceClientRepository {
  let current: WorkspaceClientSnapshot = {
    schemaVersion: 1,
    revision: "0",
    document: initial,
    etag: '"0"',
  };
  return {
    partition: "opaque-acceptance-partition",
    canRead: true,
    canWrite,
    load: vi.fn(async () => ({ ok: true as const, value: current })),
    save: vi.fn(async (next: WorkspaceDocumentV1) => {
      current = {
        schemaVersion: 1,
        revision: String(Number(current.revision) + 1),
        document: next,
        etag: `"${Number(current.revision) + 1}"`,
      };
      return { ok: true as const, snapshot: current };
    }),
    backup,
    recoveryPoints: vi.fn(async () => []),
    recoveryPoint: vi.fn(async () => null),
  };
}

function clientSnapshot(document: WorkspaceDocumentV1, revision: string): WorkspaceClientSnapshot {
  return { schemaVersion: 1, revision, document, etag: `"${revision}"` };
}

function deferredSaveRepository(initial: WorkspaceDocumentV1) {
  let current = clientSnapshot(initial, "0");
  let completeSave: ((result: WorkspaceSaveResult) => void) | null = null;
  let shouldDeferLoad = false;
  let completeLoad:
    | ((result: Awaited<ReturnType<WorkspaceClientRepository["load"]>>) => void)
    | null = null;
  const save = vi.fn<WorkspaceClientRepository["save"]>(
    () =>
      new Promise<WorkspaceSaveResult>((resolve) => {
        completeSave = resolve;
      }),
  );
  const load = vi.fn<WorkspaceClientRepository["load"]>(() => {
    if (shouldDeferLoad) {
      shouldDeferLoad = false;
      return new Promise<Awaited<ReturnType<WorkspaceClientRepository["load"]>>>((resolve) => {
        completeLoad = resolve;
      });
    }
    return Promise.resolve({ ok: true as const, value: current });
  });
  const repository: WorkspaceClientRepository = {
    partition: "opaque-acceptance-partition",
    canRead: true,
    canWrite: true,
    load,
    save,
    backup: vi.fn(async () => undefined),
    recoveryPoints: vi.fn(async () => []),
    recoveryPoint: vi.fn(async () => null),
  };

  return {
    repository,
    save,
    setCurrent(snapshot: WorkspaceClientSnapshot) {
      current = snapshot;
    },
    deferNextLoad() {
      shouldDeferLoad = true;
    },
    resolveLoad(snapshot: WorkspaceClientSnapshot) {
      if (!completeLoad) throw new Error("The deferred workspace read has not started.");
      const resolve = completeLoad;
      completeLoad = null;
      resolve({ ok: true, value: snapshot });
    },
    completeSave(snapshot: WorkspaceClientSnapshot) {
      if (!completeSave) throw new Error("The workspace save has not started.");
      const resolve = completeSave;
      completeSave = null;
      resolve({ ok: true, snapshot });
    },
  };
}

class TestWorkspaceBroadcastChannel {
  static latest: TestWorkspaceBroadcastChannel | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  static getLatest(): TestWorkspaceBroadcastChannel | null {
    return TestWorkspaceBroadcastChannel.latest;
  }

  constructor() {
    TestWorkspaceBroadcastChannel.latest = this;
  }

  close(): void {}

  postMessage(): void {}

  dispatch(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe("workspace migration store acceptance", () => {
  let nextId = 1;

  beforeEach(() => {
    nextId = 1;
    vi.stubGlobal("crypto", {
      randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps anonymous workspace data closed and does not issue an owner read", async () => {
    const repository = fakeRepository(null, false);
    const store = createWorkspaceStore(auth([], false), createWidgetRegistry([]), { repository });

    await store.getState().hydrate();
    expect(store.getState().loadStatus).toBe("error");
    expect(store.getState().document).toBeNull();
    expect(repository.load).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    store.getState().dispose();
  });

  it("does not auto-import anonymous legacy storage when a signed-in owner has no document", async () => {
    const repository = fakeRepository(null, false);
    const store = createWorkspaceStore(auth(["workspace:read"]), createWidgetRegistry([]), {
      repository,
    });

    await store.getState().hydrate();
    expect(store.getState().loadStatus).toBe("ready");
    expect(store.getState().document?.workspaces).toHaveLength(1);
    expect(store.getState().document?.workspaces[0].tabs[0].widgets).toEqual([]);
    expect(store.getState().document?.workspaces[0].marketContext).toEqual({
      activeSymbol: "SPY",
      watchlist: ["SPY", "QQQ", "AAPL"],
    });
    expect(repository.save).not.toHaveBeenCalled();
    store.getState().dispose();
  });

  it("allows read-only owners to switch workspaces and tabs without saving selection state", async () => {
    const current = document("Current");
    const secondWorkspaceId = "33333333-3333-4333-8333-333333333333";
    const secondTabId = "44444444-4444-4444-8444-444444444444";
    const otherTabId = "55555555-5555-4555-8555-555555555555";
    const readOnlyDocument: WorkspaceDocumentV1 = {
      ...current,
      workspaces: [
        ...current.workspaces,
        {
          id: secondWorkspaceId,
          name: "Second workspace",
          activeTabId: secondTabId,
          marketContext: { activeSymbol: "DIA", watchlist: ["DIA"] },
          tabs: [
            {
              id: secondTabId,
              name: "Overview",
              widgets: [],
              placements: [],
              maximizedInstanceId: null,
            },
            {
              id: otherTabId,
              name: "Research",
              widgets: [],
              placements: [],
              maximizedInstanceId: null,
            },
          ],
        },
      ],
    };
    const repository = fakeRepository(readOnlyDocument, false);
    const store = createWorkspaceStore(auth(["workspace:read"]), createWidgetRegistry([]), {
      repository,
    });
    await store.getState().hydrate();

    expect(store.getState().canEdit).toBe(false);
    expect(store.getState().selectWorkspace(secondWorkspaceId)).toBe(true);
    expect(store.getState().document?.activeWorkspaceId).toBe(secondWorkspaceId);
    expect(store.getState().selectTab(secondWorkspaceId, otherTabId)).toBe(true);
    expect(
      store
        .getState()
        .document?.workspaces.find((workspace) => workspace.id === secondWorkspaceId)?.activeTabId,
    ).toBe(otherTabId);
    expect(store.getState()).toMatchObject({ dirty: false, syncStatus: "saved", revision: "0" });
    expect(repository.save).not.toHaveBeenCalled();
    store.getState().dispose();
  });

  it("imports a copied document with fresh server-owned workspace, tab, and widget IDs", async () => {
    const current = document("Current", "11111111-1111-4111-8111-111111111111");
    const imported = document("Imported", "33333333-3333-4333-8333-333333333333");
    const importedWithWidget: WorkspaceDocumentV1 = {
      ...imported,
      workspaces: imported.workspaces.map((workspace) => ({
        ...workspace,
        tabs: workspace.tabs.map((tab) => ({
          ...tab,
          widgets: [
            {
              instanceId: "44444444-4444-4444-8444-444444444444",
              manifestId: "vendor.unavailable-widget",
              manifestVersion: "9.0.0",
              configSchemaId: "vendor.unavailable-widget.v1",
              config: { preserved: true },
            },
          ],
          placements: [{ i: "44444444-4444-4444-8444-444444444444", x: 0, y: 0, w: 2, h: 2 }],
        })),
      })),
    };
    const repository = fakeRepository(current, true);
    const store = createWorkspaceStore(
      auth(["workspace:read", "workspace:write"]),
      createWidgetRegistry([]),
      { repository, debounceMs: 60_000 },
    );
    await store.getState().hydrate();

    expect(await store.getState().importDocument(importedWithWidget, "copy")).toBe(true);
    const afterImport = store.getState().document;
    expect(afterImport?.workspaces).toHaveLength(2);
    expect(afterImport?.activeWorkspaceId).not.toBe(importedWithWidget.activeWorkspaceId);
    expect(afterImport?.workspaces[1].id).not.toBe(importedWithWidget.workspaces[0].id);
    expect(afterImport?.workspaces[1].tabs[0].id).not.toBe(
      importedWithWidget.workspaces[0].tabs[0].id,
    );
    expect(afterImport?.workspaces[1].tabs[0].widgets[0].instanceId).not.toBe(
      importedWithWidget.workspaces[0].tabs[0].widgets[0].instanceId,
    );
    expect(afterImport?.workspaces[1].tabs[0].placements[0].i).toBe(
      afterImport?.workspaces[1].tabs[0].widgets[0].instanceId,
    );
    expect(repository.save).not.toHaveBeenCalled();

    await store.getState().saveNow();
    expect(repository.save).toHaveBeenCalledTimes(1);
    store.getState().dispose();
  });

  it("leaves the current document unchanged when replacement backup fails", async () => {
    const current = document("Current");
    const backup = vi.fn(async () => {
      throw new Error("simulated local backup failure");
    });
    const repository = fakeRepository(current, true, backup);
    const store = createWorkspaceStore(
      auth(["workspace:read", "workspace:write"]),
      createWidgetRegistry([]),
      { repository, debounceMs: 60_000 },
    );
    await store.getState().hydrate();

    expect(
      await store
        .getState()
        .importDocument(document("Replacement", "55555555-5555-4555-8555-555555555555"), "replace"),
    ).toBe(false);
    expect(store.getState().document).toEqual(current);
    expect(repository.save).not.toHaveBeenCalled();
    expect(backup).toHaveBeenCalledWith(current.workspaces[0], "import");
    store.getState().dispose();
  });

  it("keeps a reloaded newer revision when an older save response arrives late", async () => {
    const initial = document("Initial");
    const latest = document("Latest from another tab");
    const deferred = deferredSaveRepository(initial);
    const store = createWorkspaceStore(
      auth(["workspace:read", "workspace:write"]),
      createWidgetRegistry([]),
      { repository: deferred.repository, debounceMs: 60_000 },
    );
    await store.getState().hydrate();

    expect(store.getState().setActiveSymbol(initial.activeWorkspaceId, "AAPL")).toBe(true);
    const saveRequest = store.getState().saveNow();
    await Promise.resolve();
    const saveCall = deferred.save.mock.calls[0];
    expect(saveCall).toBeDefined();
    if (!saveCall) throw new Error("The workspace save did not start.");

    deferred.setCurrent(clientSnapshot(latest, "2"));
    await store.getState().reloadRemote();
    expect(store.getState()).toMatchObject({ revision: "2", etag: '"2"', document: latest });
    expect(store.getState().setActiveSymbol(initial.activeWorkspaceId, "DIA")).toBe(true);

    deferred.completeSave(clientSnapshot(saveCall[0], "1"));
    await saveRequest;

    expect(store.getState()).toMatchObject({
      revision: "2",
      etag: '"2"',
      dirty: true,
      syncStatus: "pending",
      remoteConflict: null,
    });
    expect(
      store
        .getState()
        .document?.workspaces.find((workspace) => workspace.id === initial.activeWorkspaceId)
        ?.marketContext.activeSymbol,
    ).toBe("DIA");
    store.getState().dispose();
  });

  it("keeps a newer observed conflict when an older successful save response arrives", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("BroadcastChannel", TestWorkspaceBroadcastChannel);
    TestWorkspaceBroadcastChannel.latest = null;
    const initial = document("Initial");
    const latest = document("Latest from another tab");
    const deferred = deferredSaveRepository(initial);
    const store = createWorkspaceStore(
      auth(["workspace:read", "workspace:write"]),
      createWidgetRegistry([]),
      { repository: deferred.repository, debounceMs: 60_000 },
    );
    await store.getState().hydrate();

    expect(store.getState().setActiveSymbol(initial.activeWorkspaceId, "AAPL")).toBe(true);
    const saveRequest = store.getState().saveNow();
    await Promise.resolve();
    const saveCall = deferred.save.mock.calls[0];
    expect(saveCall).toBeDefined();
    if (!saveCall) throw new Error("The workspace save did not start.");

    deferred.setCurrent(clientSnapshot(latest, "2"));
    const channel = TestWorkspaceBroadcastChannel.getLatest();
    expect(channel).not.toBeNull();
    channel?.dispatch({
      type: "workspace.changed.v1",
      workspaceId: initial.activeWorkspaceId,
      revision: "2",
    });
    await Promise.resolve();
    expect(store.getState()).toMatchObject({
      syncStatus: "conflict",
      remoteConflict: { revision: "2", document: latest },
    });
    expect(store.getState().setActiveSymbol(initial.activeWorkspaceId, "DIA")).toBe(true);

    deferred.completeSave(clientSnapshot(saveCall[0], "1"));
    await saveRequest;

    expect(store.getState()).toMatchObject({
      revision: "0",
      etag: '"0"',
      syncStatus: "conflict",
      dirty: true,
      remoteConflict: { revision: "2", document: latest },
    });
    expect(
      store
        .getState()
        .document?.workspaces.find((workspace) => workspace.id === initial.activeWorkspaceId)
        ?.marketContext.activeSymbol,
    ).toBe("DIA");
    store.getState().dispose();
  });

  it("ignores a delayed cross-tab read after this tab has saved a higher revision", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("BroadcastChannel", TestWorkspaceBroadcastChannel);
    TestWorkspaceBroadcastChannel.latest = null;
    const initial = document("Initial");
    const deferred = deferredSaveRepository(initial);
    deferred.setCurrent(clientSnapshot(initial, "1"));
    const store = createWorkspaceStore(
      auth(["workspace:read", "workspace:write"]),
      createWidgetRegistry([]),
      { repository: deferred.repository, debounceMs: 60_000 },
    );
    await store.getState().hydrate();

    deferred.deferNextLoad();
    TestWorkspaceBroadcastChannel.getLatest()?.dispatch({
      type: "workspace.changed.v1",
      workspaceId: initial.activeWorkspaceId,
      revision: "2",
    });
    await Promise.resolve();

    expect(store.getState().setActiveSymbol(initial.activeWorkspaceId, "AAPL")).toBe(true);
    const saveRequest = store.getState().saveNow();
    await Promise.resolve();
    const saveCall = deferred.save.mock.calls[0];
    expect(saveCall).toBeDefined();
    if (!saveCall) throw new Error("The workspace save did not start.");
    const savedSnapshot = clientSnapshot(saveCall[0], "2");
    deferred.setCurrent(savedSnapshot);
    deferred.completeSave(savedSnapshot);
    await saveRequest;

    deferred.resolveLoad(clientSnapshot(initial, "1"));
    await Promise.resolve();

    expect(store.getState()).toMatchObject({
      revision: "2",
      etag: '"2"',
      document: saveCall[0],
      dirty: false,
      syncStatus: "saved",
      remoteConflict: null,
    });
    store.getState().dispose();
  });
});
