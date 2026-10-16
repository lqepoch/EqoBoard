import type { AuthUiSnapshot } from "../../lib/contracts/auth";
import {
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceDocumentV1,
  type WorkspaceRepositorySnapshot,
  type WorkspaceV1,
} from "../../workspace/model";
import { hasControlCharacters, parseWorkspaceDocument } from "../../workspace/schema";
import {
  IndexedDbWorkspaceBackupStore,
  type RecoveryReason,
  type WorkspaceBackupStore,
  type WorkspaceRecoveryPoint,
} from "./backups";

export type { WorkspaceBackupStore, WorkspaceRecoveryPoint } from "./backups";

export type WorkspaceRepositoryErrorCode =
  | "sign-in-required"
  | "identity-unavailable"
  | "permission-denied"
  | "authentication-required"
  | "action-forbidden"
  | "service-unavailable"
  | "invalid-response"
  | "network-error"
  | "save-failed";

export type WorkspaceClientSnapshot = WorkspaceRepositorySnapshot & Readonly<{ etag: string }>;

export type WorkspaceRepositoryResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: WorkspaceRepositoryErrorCode; message: string }>;

export type WorkspaceSaveResult =
  | Readonly<{ ok: true; snapshot: WorkspaceClientSnapshot }>
  | Readonly<{ ok: false; code: WorkspaceRepositoryErrorCode; message: string }>
  | Readonly<{ ok: false; code: "conflict"; current: WorkspaceClientSnapshot | null }>;

export type WorkspaceClientRepository = Readonly<{
  partition: string | null;
  canRead: boolean;
  canWrite: boolean;
  load(): Promise<WorkspaceRepositoryResult<WorkspaceClientSnapshot>>;
  save(document: WorkspaceDocumentV1, expectedEtag: string): Promise<WorkspaceSaveResult>;
  backup(workspace: WorkspaceV1, reason: RecoveryReason): Promise<void>;
  recoveryPoints(workspaceId: string): Promise<readonly WorkspaceRecoveryPoint[]>;
  recoveryPoint(id: string): Promise<WorkspaceRecoveryPoint | null>;
  dispose?(): void;
}>;

type RepositoryOptions = Readonly<{
  fetcher?: typeof fetch;
  backups?: WorkspaceBackupStore;
  endpoint?: string;
}>;

const NO_STORE_HEADERS = Object.freeze({ Accept: "application/json" });

function hasPermission(
  auth: AuthUiSnapshot,
  permission: "workspace:read" | "workspace:write",
): boolean {
  return auth.authenticated && auth.permissions.includes(permission);
}

function parseRevision(value: unknown): string | null {
  return typeof value === "string" && /^(0|[1-9]\d{0,255})$/u.test(value) ? value : null;
}

function isStrongEntityTag(value: string | null): value is string {
  const opaqueTag = value?.slice(1, -1);
  return (
    value !== null &&
    value.length >= 2 &&
    value.length <= 512 &&
    value.startsWith('"') &&
    value.endsWith('"') &&
    opaqueTag !== undefined &&
    !hasControlCharacters(opaqueTag) &&
    !opaqueTag.includes('"')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function parseSnapshotResponse(body: unknown, etag: string | null): WorkspaceClientSnapshot | null {
  if (!isRecord(body) || body.schemaVersion !== WORKSPACE_SCHEMA_VERSION) return null;
  const revision = parseRevision(body.revision);
  if (!revision || !isStrongEntityTag(etag) || etag !== `"${revision}"`) return null;
  const allowed = new Set(["schemaVersion", "revision", "document"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (body.document === null)
    return { schemaVersion: WORKSPACE_SCHEMA_VERSION, revision, document: null, etag };
  const parsed = parseWorkspaceDocument(body.document);
  if (!parsed.ok) return null;
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, revision, document: parsed.value, etag };
}

function publicError(responseStatus?: number): WorkspaceRepositoryErrorCode {
  switch (responseStatus) {
    case 401:
      return "authentication-required";
    case 403:
      return "action-forbidden";
    case 503:
      return "service-unavailable";
    default:
      return responseStatus === undefined ? "network-error" : "save-failed";
  }
}

/** Same-origin owner-scoped API client. storagePartition is used only for local backups. */
export function createWorkspaceClientRepository(
  auth: AuthUiSnapshot,
  options: RepositoryOptions = {},
): WorkspaceClientRepository {
  const fetcher = options.fetcher ?? fetch;
  const endpoint = options.endpoint ?? "/api/workspaces";
  const backupStore = options.backups ?? new IndexedDbWorkspaceBackupStore();
  const requestController = new AbortController();
  const canRead = hasPermission(auth, "workspace:read");
  const canWrite = hasPermission(auth, "workspace:write");
  const partition =
    auth.authenticated &&
    typeof auth.storagePartition === "string" &&
    auth.storagePartition.length > 0
      ? auth.storagePartition
      : null;

  async function load(): Promise<WorkspaceRepositoryResult<WorkspaceClientSnapshot>> {
    if (!auth.authenticated)
      return {
        ok: false,
        code: "sign-in-required",
        message: "Sign in to load the owner workspace.",
      };
    if (!partition)
      return {
        ok: false,
        code: "identity-unavailable",
        message: "The signed-in workspace partition is unavailable.",
      };
    if (!canRead)
      return {
        ok: false,
        code: "permission-denied",
        message: "This account cannot read workspace data.",
      };
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "GET",
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: requestController.signal,
        headers: NO_STORE_HEADERS,
      });
    } catch {
      return {
        ok: false,
        code: "network-error",
        message: "Workspace storage could not be reached.",
      };
    }
    if (!response.ok)
      return {
        ok: false,
        code: publicError(response.status),
        message: "Workspace storage rejected the read request.",
      };
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      return {
        ok: false,
        code: "invalid-response",
        message: "Workspace storage returned invalid JSON.",
      };
    }
    const snapshot = parseSnapshotResponse(body, response.headers.get("ETag"));
    return snapshot
      ? { ok: true, value: snapshot }
      : {
          ok: false,
          code: "invalid-response",
          message: "Workspace storage returned an invalid revision or document.",
        };
  }

  async function save(
    document: WorkspaceDocumentV1,
    expectedEtag: string,
  ): Promise<WorkspaceSaveResult> {
    if (!auth.authenticated)
      return { ok: false, code: "sign-in-required", message: "Sign in before saving a workspace." };
    if (!partition)
      return {
        ok: false,
        code: "identity-unavailable",
        message: "The signed-in workspace partition is unavailable.",
      };
    if (!canWrite)
      return {
        ok: false,
        code: "permission-denied",
        message: "This account cannot save workspace data.",
      };
    if (!isStrongEntityTag(expectedEtag)) {
      return {
        ok: false,
        code: "invalid-response",
        message: "The workspace save revision is invalid.",
      };
    }
    const parsed = parseWorkspaceDocument(document);
    if (!parsed.ok)
      return {
        ok: false,
        code: "save-failed",
        message: "The workspace document failed local validation.",
      };

    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "PUT",
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: requestController.signal,
        headers: {
          ...NO_STORE_HEADERS,
          "Content-Type": "application/json",
          "If-Match": expectedEtag,
        },
        body: JSON.stringify({ schemaVersion: WORKSPACE_SCHEMA_VERSION, document: parsed.value }),
      });
    } catch {
      return {
        ok: false,
        code: "network-error",
        message: "Workspace storage could not be reached.",
      };
    }
    if (response.status === 412) {
      const latest = await load();
      return { ok: false, code: "conflict", current: latest.ok ? latest.value : null };
    }
    if (!response.ok)
      return {
        ok: false,
        code: publicError(response.status),
        message: "Workspace storage rejected the save request.",
      };
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      return {
        ok: false,
        code: "invalid-response",
        message: "Workspace storage returned invalid JSON after saving.",
      };
    }
    const snapshot = parseSnapshotResponse(body, response.headers.get("ETag"));
    return snapshot?.document
      ? { ok: true, snapshot }
      : {
          ok: false,
          code: "invalid-response",
          message: "Workspace storage did not confirm the saved document.",
        };
  }

  return {
    partition,
    canRead,
    canWrite,
    load,
    save,
    backup: (workspace, reason) =>
      partition
        ? backupStore.save(partition, workspace, reason)
        : Promise.reject(new Error("A local recovery partition is unavailable.")),
    recoveryPoints: (workspaceId) =>
      partition ? backupStore.list(partition, workspaceId) : Promise.resolve([]),
    recoveryPoint: (id) => (partition ? backupStore.get(partition, id) : Promise.resolve(null)),
    dispose: () => requestController.abort(),
  };
}
