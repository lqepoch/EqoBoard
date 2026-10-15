import type { WorkspaceV1 } from "../../workspace/model";
import { createId } from "../../workspace/model";
import { hasControlCharacters, parseWorkspaceDocument } from "../../workspace/schema";

const DATABASE_NAME = "eqoboard-native-workspace-recovery";
const DATABASE_VERSION = 2;
const STORE_NAME = "snapshots";
const MAX_RECOVERY_POINTS_PER_WORKSPACE = 10;
const MAX_RECOVERY_POINTS_PER_PARTITION = 120;
const RECOVERY_REASONS = new Set<RecoveryReason>([
  "save",
  "replace",
  "reset",
  "delete",
  "import",
  "restore",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type RecoveryReason = "save" | "replace" | "reset" | "delete" | "import" | "restore";

export type WorkspaceRecoveryPoint = Readonly<{
  id: string;
  partition: string;
  workspaceId: string;
  createdAt: number;
  reason: RecoveryReason;
  workspace: WorkspaceV1;
}>;

export interface WorkspaceBackupStore {
  save(partition: string, workspace: WorkspaceV1, reason: RecoveryReason): Promise<void>;
  list(partition: string, workspaceId: string): Promise<readonly WorkspaceRecoveryPoint[]>;
  get(partition: string, recoveryPointId: string): Promise<WorkspaceRecoveryPoint | null>;
}

function isValidPartition(value: unknown): value is string {
  if (typeof value !== "string" || hasControlCharacters(value)) return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= 256;
}

function validatedWorkspace(value: unknown): WorkspaceV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const workspace = value as WorkspaceV1;
  const parsed = parseWorkspaceDocument({
    schemaVersion: 1,
    activeWorkspaceId: workspace.id,
    workspaces: [workspace],
    userTemplates: [],
  });
  return parsed.ok ? (parsed.value.workspaces[0] ?? null) : null;
}

function parseRecoveryPoint(value: unknown): WorkspaceRecoveryPoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  const allowedKeys = ["id", "partition", "workspaceId", "createdAt", "reason", "workspace"];
  if (
    Object.keys(point).length !== allowedKeys.length ||
    Object.keys(point).some((key) => !allowedKeys.includes(key))
  )
    return null;
  const workspace = validatedWorkspace(point.workspace);
  if (
    typeof point.id !== "string" ||
    !UUID_PATTERN.test(point.id) ||
    !isValidPartition(point.partition) ||
    typeof point.workspaceId !== "string" ||
    !UUID_PATTERN.test(point.workspaceId) ||
    !Number.isSafeInteger(point.createdAt) ||
    (point.createdAt as number) < 0 ||
    typeof point.reason !== "string" ||
    !RECOVERY_REASONS.has(point.reason as RecoveryReason) ||
    !workspace ||
    workspace.id !== point.workspaceId
  )
    return null;
  return {
    id: point.id,
    partition: point.partition,
    workspaceId: point.workspaceId,
    createdAt: point.createdAt as number,
    reason: point.reason as RecoveryReason,
    workspace,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("IndexedDB is unavailable."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) {
        db.close();
        reject(new Error("Could not start workspace recovery storage upgrade."));
        return;
      }
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? transaction.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains("partition-workspace")) {
        store.createIndex("partition-workspace", ["partition", "workspaceId"], { unique: false });
      }
      if (!store.indexNames.contains("partition-created")) {
        store.createIndex("partition-created", ["partition", "createdAt"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open workspace recovery storage."));
    request.onblocked = () =>
      reject(new Error("Workspace recovery storage is blocked by another tab."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Workspace recovery transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Workspace recovery transaction was aborted."));
  });
}

export class IndexedDbWorkspaceBackupStore implements WorkspaceBackupStore {
  async save(partition: string, workspace: WorkspaceV1, reason: RecoveryReason): Promise<void> {
    const validated = validatedWorkspace(workspace);
    if (!isValidPartition(partition) || !validated || !RECOVERY_REASONS.has(reason)) {
      throw new Error("A valid cache partition and bounded workspace are required for recovery.");
    }
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const completed = transactionComplete(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const point: WorkspaceRecoveryPoint = {
        id: createId(),
        partition,
        workspaceId: validated.id,
        createdAt: Date.now(),
        reason,
        workspace: validated,
      };
      store.add(point);
      const byWorkspace = store.index("partition-workspace");
      const existingWorkspacePoints = await new Promise<WorkspaceRecoveryPoint[]>(
        (resolve, reject) => {
          const request = byWorkspace.getAll(IDBKeyRange.only([partition, validated.id]));
          request.onsuccess = () =>
            resolve(
              request.result
                .map(parseRecoveryPoint)
                .filter((point): point is WorkspaceRecoveryPoint => point !== null),
            );
          request.onerror = () =>
            reject(request.error ?? new Error("Could not list workspace recovery points."));
        },
      );
      const newestWorkspaceFirst = existingWorkspacePoints.sort(
        (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
      );
      for (const stale of newestWorkspaceFirst.slice(MAX_RECOVERY_POINTS_PER_WORKSPACE))
        store.delete(stale.id);
      const byPartition = store.index("partition-created");
      const allPartitionPoints = await new Promise<WorkspaceRecoveryPoint[]>((resolve, reject) => {
        const request = byPartition.getAll(
          IDBKeyRange.bound([partition, 0], [partition, Number.MAX_SAFE_INTEGER]),
        );
        request.onsuccess = () =>
          resolve(
            request.result
              .map(parseRecoveryPoint)
              .filter((point): point is WorkspaceRecoveryPoint => point !== null),
          );
        request.onerror = () =>
          reject(request.error ?? new Error("Could not list partition recovery points."));
      });
      const newestPartitionFirst = allPartitionPoints.sort(
        (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
      );
      for (const stale of newestPartitionFirst.slice(MAX_RECOVERY_POINTS_PER_PARTITION))
        store.delete(stale.id);
      await completed;
    } finally {
      db.close();
    }
  }

  async list(partition: string, workspaceId: string): Promise<readonly WorkspaceRecoveryPoint[]> {
    if (
      !isValidPartition(partition) ||
      typeof workspaceId !== "string" ||
      !UUID_PATTERN.test(workspaceId)
    )
      return [];
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const completed = transactionComplete(transaction);
      const request = transaction
        .objectStore(STORE_NAME)
        .index("partition-workspace")
        .getAll(IDBKeyRange.only([partition, workspaceId]));
      const result = await new Promise<WorkspaceRecoveryPoint[]>((resolve, reject) => {
        request.onsuccess = () =>
          resolve(
            request.result
              .map(parseRecoveryPoint)
              .filter((point): point is WorkspaceRecoveryPoint => point !== null),
          );
        request.onerror = () =>
          reject(request.error ?? new Error("Could not read workspace recovery points."));
      });
      await completed;
      return result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    } finally {
      db.close();
    }
  }

  async get(partition: string, recoveryPointId: string): Promise<WorkspaceRecoveryPoint | null> {
    if (!isValidPartition(partition) || !recoveryPointId) return null;
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const completed = transactionComplete(transaction);
      const request = transaction.objectStore(STORE_NAME).get(recoveryPointId);
      const result = await new Promise<WorkspaceRecoveryPoint | null>((resolve, reject) => {
        request.onsuccess = () => {
          const candidate = parseRecoveryPoint(request.result);
          resolve(candidate?.partition === partition ? candidate : null);
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Could not read the workspace recovery point."));
      });
      await completed;
      return result;
    } finally {
      db.close();
    }
  }
}
