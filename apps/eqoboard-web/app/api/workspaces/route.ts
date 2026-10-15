import { NextResponse, type NextRequest } from "next/server";
import { parseWorkspaceDocument } from "@/workspace/schema";
import { consumePrincipalRateLimit } from "@/lib/server/rate-limit";
import { getNativeDb, secureNativeDbFilesForRequest } from "@/lib/server/native-db";
import { loadWorkspaceDocument, saveWorkspaceDocument, workspaceEtag } from "@/lib/server/workspace-storage";
import { authorizeRequest, noStoreJson, readBoundedJson } from "@/lib/server/bff-security";
import { ownerKeyForPrincipal, type ServerPrincipal } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidQuery(request: Request): boolean {
  const url = new URL(request.url);
  return url.search !== "" || request.headers.has("content-encoding") || request.headers.has("transfer-encoding");
}

function invalidReadRequest(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  if (request.body !== null) {
    void request.body.cancel().catch(() => undefined);
    return true;
  }
  return invalidQuery(request) || (contentLength !== null && contentLength !== "0");
}

function enforceLimit(principal: ServerPrincipal) {
  const result = consumePrincipalRateLimit(principal, { bucket: "workspace", maxRequests: 120, windowMs: 60_000 });
  return result.allowed ? null : noStoreJson({ error: "rate_limit_exceeded" }, 429, {
    "Retry-After": String(result.retryAfterSeconds),
  });
}

function etag(revision: string): string {
  return workspaceEtag(revision);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authorization = await authorizeRequest(request, "workspace:read");
  if (!authorization.ok) return authorization.response;
  if (invalidReadRequest(request)) return noStoreJson({ error: "invalid_request" }, 400);
  const limited = enforceLimit(authorization.principal);
  if (limited) return limited;

  const db = getNativeDb();
  if (!db) return noStoreJson({ error: "workspace_storage_unavailable" }, 503);
  try {
    const snapshot = loadWorkspaceDocument(db, ownerKeyForPrincipal(authorization.principal));
    if (!secureNativeDbFilesForRequest()) return noStoreJson({ error: "workspace_storage_unavailable" }, 503);
    return noStoreJson(snapshot, 200, { ETag: etag(snapshot.revision) });
  } catch {
    return noStoreJson({ error: "workspace_storage_unavailable" }, 503);
  }
}

function hasExactEnvelope(value: unknown): value is { schemaVersion: 1; document: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length === 2 && object.schemaVersion === 1 && Object.hasOwn(object, "document");
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const authorization = await authorizeRequest(request, "workspace:write");
  if (!authorization.ok) return authorization.response;
  if (invalidQuery(request)) return noStoreJson({ error: "invalid_request" }, 400);
  const limited = enforceLimit(authorization.principal);
  if (limited) return limited;

  const db = getNativeDb();
  if (!db) return noStoreJson({ error: "workspace_storage_unavailable" }, 503);
  const body = await readBoundedJson(request, 64 * 1024);
  if (!body.ok) return body.response;
  if (!hasExactEnvelope(body.value)) return noStoreJson({ error: "invalid_workspace_envelope" }, 400);
  const parsed = parseWorkspaceDocument(body.value.document);
  if (!parsed.ok) return noStoreJson({ error: "invalid_workspace_document" }, 422);

  try {
    const result = saveWorkspaceDocument(
      db,
      ownerKeyForPrincipal(authorization.principal),
      request.headers.get("if-match"),
      parsed.value,
    );
    if (!secureNativeDbFilesForRequest()) return noStoreJson({ error: "workspace_storage_unavailable" }, 503);
    if (result.kind === "conflict") {
      return noStoreJson(
        { error: "workspace_revision_conflict", revision: result.revision },
        412,
        { ETag: etag(result.revision) },
      );
    }
    return noStoreJson(result.snapshot, 200, { ETag: etag(result.snapshot.revision) });
  } catch (error) {
    return error instanceof RangeError
      ? noStoreJson({ error: "workspace_document_too_large" }, 413)
      : noStoreJson({ error: "workspace_storage_unavailable" }, 503);
  }
}
