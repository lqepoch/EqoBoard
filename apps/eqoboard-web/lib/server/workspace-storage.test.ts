import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { default: Database } = await import("better-sqlite3");
const { loadWorkspaceDocument, saveWorkspaceDocument } = await import("./workspace-storage");

const ownerA = "a".repeat(64);
const ownerB = "b".repeat(64);
const document = {
  schemaVersion: 1 as const,
  activeWorkspaceId: "00000000-0000-4000-8000-000000000001",
  workspaces: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Workspace 1",
      activeTabId: "00000000-0000-4000-8000-000000000002",
      marketContext: { activeSymbol: "SPY", watchlist: ["SPY"] },
      tabs: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          name: "Overview",
          widgets: [],
          placements: [],
          maximizedInstanceId: null,
        },
      ],
    },
  ],
  userTemplates: [],
};

describe("workspace owner storage CAS", () => {
  let db: InstanceType<typeof Database>;

  afterEach(() => db.close());

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE workspace_documents (
      owner_key TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  });

  it("starts at revision zero, saves with a strong ETag and rejects stale writes", () => {
    expect(loadWorkspaceDocument(db, ownerA)).toEqual({
      schemaVersion: 1,
      revision: "0",
      document: null,
    });
    const first = saveWorkspaceDocument(db, ownerA, '"0"', document);
    expect(first.kind).toBe("saved");
    if (first.kind !== "saved") return;
    expect(first.snapshot.revision).toBe("1");
    expect(saveWorkspaceDocument(db, ownerA, '"0"', document)).toEqual({
      kind: "conflict",
      revision: "1",
    });

    const second = saveWorkspaceDocument(db, ownerA, '"1"', document);
    expect(second.kind).toBe("saved");
    expect(loadWorkspaceDocument(db, ownerA).revision).toBe("2");
  });

  it("isolates revisions by owner key", () => {
    saveWorkspaceDocument(db, ownerA, '"0"', document);
    expect(loadWorkspaceDocument(db, ownerB)).toEqual({
      schemaVersion: 1,
      revision: "0",
      document: null,
    });
    expect(saveWorkspaceDocument(db, ownerB, '"0"', document).kind).toBe("saved");
    expect(loadWorkspaceDocument(db, ownerA).revision).toBe("1");
  });
});
