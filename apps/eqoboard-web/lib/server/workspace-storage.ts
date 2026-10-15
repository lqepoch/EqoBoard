import "server-only";

import type Database from "better-sqlite3";
import type { WorkspaceDocumentV1 } from "../../workspace/model";
import { parseWorkspaceDocument } from "../../workspace/schema";

const OWNER_KEY = /^[0-9a-f]{64}$/u;
const MAX_DOCUMENT_BYTES = 64 * 1024;

export type WorkspaceStorageSnapshot = Readonly<{
  schemaVersion: 1;
  revision: string;
  document: WorkspaceDocumentV1 | null;
}>;

export type WorkspaceSaveResult =
  | Readonly<{ kind: "saved"; snapshot: WorkspaceStorageSnapshot }>
  | Readonly<{ kind: "conflict"; revision: string }>;

type WorkspaceRow = Readonly<{ revision: number; document_json: string }>;

function requireOwnerKey(ownerKey: string): void {
  if (!OWNER_KEY.test(ownerKey)) throw new TypeError("Invalid workspace owner key.");
}

function parseStoredDocument(row: WorkspaceRow): WorkspaceDocumentV1 {
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 ||
      Buffer.byteLength(row.document_json, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error("Stored workspace row is invalid.");
  }
  const parsed = parseWorkspaceDocument(JSON.parse(row.document_json) as unknown);
  if (!parsed.ok) throw new Error("Stored workspace row failed schema validation.");
  return parsed.value;
}

export function workspaceEtag(revision: string): string {
  return `"${revision}"`;
}

export function loadWorkspaceDocument(db: Database.Database, ownerKey: string): WorkspaceStorageSnapshot {
  requireOwnerKey(ownerKey);
  const row = db.prepare(
    "SELECT revision, document_json FROM workspace_documents WHERE owner_key = ?",
  ).get(ownerKey) as WorkspaceRow | undefined;
  if (!row) return { schemaVersion: 1, revision: "0", document: null };
  const document = parseStoredDocument(row);
  return { schemaVersion: 1, revision: String(row.revision), document };
}

/** Atomically compare the quoted current revision and write the next snapshot. */
export function saveWorkspaceDocument(
  db: Database.Database,
  ownerKey: string,
  expectedEtag: string | null,
  document: WorkspaceDocumentV1,
): WorkspaceSaveResult {
  requireOwnerKey(ownerKey);
  const serialized = JSON.stringify(document);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new RangeError("Workspace document exceeds its byte limit.");
  }

  const transaction = db.transaction((): WorkspaceSaveResult => {
    const row = db.prepare(
      "SELECT revision, document_json FROM workspace_documents WHERE owner_key = ?",
    ).get(ownerKey) as WorkspaceRow | undefined;
    const revision = row?.revision ?? 0;
    const rawRevision = String(revision);
    if (expectedEtag !== workspaceEtag(rawRevision) || !Number.isSafeInteger(revision + 1)) {
      return { kind: "conflict", revision: rawRevision };
    }

    const nextRevision = revision + 1;
    if (row) {
      const updated = db.prepare(`
        UPDATE workspace_documents
        SET revision = ?, document_json = ?, updated_at = ?
        WHERE owner_key = ? AND revision = ?
      `).run(nextRevision, serialized, new Date().toISOString(), ownerKey, revision);
      if (updated.changes !== 1) return { kind: "conflict", revision: rawRevision };
    } else {
      db.prepare(`
        INSERT INTO workspace_documents (owner_key, revision, document_json, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(ownerKey, nextRevision, serialized, new Date().toISOString());
    }

    return {
      kind: "saved",
      snapshot: { schemaVersion: 1, revision: String(nextRevision), document },
    };
  });

  return transaction.immediate();
}
