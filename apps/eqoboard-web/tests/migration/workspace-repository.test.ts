import { describe, expect, it, vi } from "vitest";
import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import {
  createWorkspaceClientRepository,
  type WorkspaceBackupStore,
} from "../../stores/workspace/repository";
import type { WorkspaceDocumentV1, WorkspaceV1 } from "../../workspace/model";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const tabId = "22222222-2222-4222-8222-222222222222";

function document(): WorkspaceDocumentV1 {
  return {
    schemaVersion: 1,
    activeWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name: "Review",
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

function auth(overrides: Partial<AuthUiSnapshot> = {}): AuthUiSnapshot {
  return {
    status: "authenticated",
    authenticated: true,
    displayName: "Test User",
    permissions: ["workspace:read", "workspace:write"],
    storagePartition: "opaque-test-partition-a",
    ...overrides,
  };
}

function snapshotResponse(
  revision: string,
  etag: string,
  currentDocument: WorkspaceDocumentV1 | null,
) {
  return new Response(JSON.stringify({ schemaVersion: 1, revision, document: currentDocument }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: etag },
  });
}

function noOpBackups(): WorkspaceBackupStore {
  return {
    save: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
  };
}

describe("owner workspace repository boundary", () => {
  it("does not call the server for anonymous or unauthorized reads and writes", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const backups = noOpBackups();
    const anonymous = createWorkspaceClientRepository(
      auth({
        status: "sign-in-required",
        authenticated: false,
        displayName: null,
        permissions: [],
        storagePartition: null,
      }),
      { fetcher, backups },
    );

    expect(await anonymous.load()).toMatchObject({ ok: false, code: "sign-in-required" });
    expect(await anonymous.save(document(), '"0"')).toMatchObject({
      ok: false,
      code: "sign-in-required",
    });
    expect(anonymous.partition).toBeNull();
    expect(await anonymous.recoveryPoints(workspaceId)).toEqual([]);

    const noWorkspacePermission = createWorkspaceClientRepository(
      auth({ permissions: ["market:read"] }),
      {
        fetcher,
        backups,
      },
    );
    expect(await noWorkspacePermission.load()).toMatchObject({
      ok: false,
      code: "permission-denied",
    });
    expect(await noWorkspacePermission.save(document(), '"0"')).toMatchObject({
      ok: false,
      code: "permission-denied",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only same-origin no-store requests and binds writes to the loaded ETag", async () => {
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return init?.method === "PUT"
        ? snapshotResponse("1", '"1"', document())
        : snapshotResponse("0", '"0"', document());
    };
    const repository = createWorkspaceClientRepository(auth(), { fetcher, backups: noOpBackups() });

    const loaded = await repository.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.etag).toBe('"0"');

    const saved = await repository.save(document(), loaded.value.etag);
    expect(saved).toMatchObject({ ok: true, snapshot: { revision: "1", etag: '"1"' } });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(calls[1]).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "If-Match": '"0"',
      }),
    });
    expect(JSON.parse(String(calls[1].body))).toEqual({ schemaVersion: 1, document: document() });
  });

  it("surfaces a compare-and-swap conflict and reloads the current server revision", async () => {
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      if (init?.method === "PUT") return new Response(null, { status: 412 });
      return snapshotResponse("1", '"1"', null);
    };
    const repository = createWorkspaceClientRepository(auth(), { fetcher, backups: noOpBackups() });

    const result = await repository.save(document(), '"stale-revision"');
    expect(result).toMatchObject({
      ok: false,
      code: "conflict",
      current: {
        schemaVersion: 1,
        revision: "1",
        document: null,
        etag: '"1"',
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
  });

  it("rejects unbounded or malformed response state instead of trusting it", async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          revision: "0",
          document: null,
          owner: "forged",
        }),
        { headers: { ETag: '"0"' } },
      );
    const repository = createWorkspaceClientRepository(auth(), { fetcher, backups: noOpBackups() });
    expect(await repository.load()).toMatchObject({ ok: false, code: "invalid-response" });

    const missingEtag: typeof fetch = async () => snapshotResponse("0", "", null);
    const invalidRepository = createWorkspaceClientRepository(auth(), {
      fetcher: missingEtag,
      backups: noOpBackups(),
    });
    expect(await invalidRepository.load()).toMatchObject({ ok: false, code: "invalid-response" });

    const mismatchedEtag: typeof fetch = async () => snapshotResponse("1", '"0"', null);
    const mismatchedRepository = createWorkspaceClientRepository(auth(), {
      fetcher: mismatchedEtag,
      backups: noOpBackups(),
    });
    expect(await mismatchedRepository.load()).toMatchObject({
      ok: false,
      code: "invalid-response",
    });
  });

  it("partitions recovery reads and writes by the opaque auth snapshot namespace", async () => {
    const calls: string[] = [];
    const point = {
      id: "recovery-point-a",
      partition: "opaque-test-partition-a",
      workspaceId,
      createdAt: 1,
      reason: "save" as const,
      workspace: document().workspaces[0] as WorkspaceV1,
    };
    const backups: WorkspaceBackupStore = {
      save: vi.fn(async (partition: string) => {
        calls.push(`save:${partition}`);
      }),
      list: vi.fn(async (partition: string) => {
        calls.push(`list:${partition}`);
        return [point];
      }),
      get: vi.fn(async (partition: string) => {
        calls.push(`get:${partition}`);
        return partition === point.partition ? point : null;
      }),
    };
    const repository = createWorkspaceClientRepository(auth(), {
      fetcher: vi.fn<typeof fetch>(),
      backups,
    });

    await repository.backup(point.workspace, "save");
    expect(await repository.recoveryPoints(workspaceId)).toEqual([point]);
    expect(await repository.recoveryPoint(point.id)).toEqual(point);
    expect(calls).toEqual([
      "save:opaque-test-partition-a",
      "list:opaque-test-partition-a",
      "get:opaque-test-partition-a",
    ]);

    const otherIdentity = createWorkspaceClientRepository(
      auth({ storagePartition: "opaque-test-partition-b" }),
      {
        fetcher: vi.fn<typeof fetch>(),
        backups,
      },
    );
    expect(await otherIdentity.recoveryPoint(point.id)).toBeNull();
  });
});
