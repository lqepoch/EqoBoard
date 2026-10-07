import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, isAuthRuntimeConfigured, isCurrentOidcIssuer, publicAppOrigin } from "@/auth";
import { scopesForRoles, type ActionScope } from "@/lib/permissions";

export type GatewayAudience = "eqoboard-gateway" | "openterminal-research";
export type VerifiedWebPrincipal = {
  subject: string;
  identityIssuer: string;
  scopes: readonly ActionScope[];
  sessionExpiresAt: number;
};

export type AuthorizationResult =
  | { ok: true; principal: VerifiedWebPrincipal; token: string }
  | { ok: false; response: NextResponse };

const MAX_REQUEST_BYTES = 64 * 1024;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function validRequestHeaders(request: Request): NextResponse | null {
  const method = request.method.toUpperCase();
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (!isWrite) return null;

  const origin = request.headers.get("origin");
  const expectedOrigin = publicAppOrigin();
  if (!expectedOrigin || origin !== expectedOrigin) return jsonError(403, "origin_rejected");

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return jsonError(403, "origin_rejected");

  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return jsonError(415, "json_required");
    const size = request.headers.get("content-length");
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_REQUEST_BYTES)) {
      return jsonError(413, "request_too_large");
    }
  }
  return null;
}

export async function authorizeBffRequest(
  request: Request,
  requiredScope: ActionScope,
  audience: GatewayAudience,
): Promise<AuthorizationResult> {
  const boundaryError = validRequestHeaders(request);
  if (boundaryError) return { ok: false, response: boundaryError };
  if (!isAuthRuntimeConfigured()) return { ok: false, response: jsonError(503, "identity_service_unavailable") };

  let session;
  try {
    session = await getServerSession(authOptions);
  } catch {
    return { ok: false, response: jsonError(503, "identity_service_unavailable") };
  }

  if (!session) return { ok: false, response: jsonError(401, "authentication_required") };
  const user = session.user;
  if (!user?.id || !user.issuer || !isCurrentOidcIssuer(user.issuer)) {
    return { ok: false, response: jsonError(401, "authentication_required") };
  }
  const sessionExpiresAt = Date.parse(session.expires);
  if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now() + 1_000) {
    return { ok: false, response: jsonError(401, "authentication_required") };
  }
  const scopes = scopesForRoles(user.roles);
  if (!scopes.includes(requiredScope)) return { ok: false, response: jsonError(403, "action_forbidden") };

  const secret = audience === "eqoboard-gateway"
    ? process.env.EQO_GATEWAY_JWT_SECRET
    : process.env.EQO_RESEARCH_JWT_SECRET;
  if (!secret || secret.length < 64) return { ok: false, response: jsonError(503, "identity_service_unavailable") };
  const principal: VerifiedWebPrincipal = {
    subject: user.id,
    identityIssuer: user.issuer,
    scopes,
    sessionExpiresAt,
  };
  const token = await new SignJWT({
    idp_iss: principal.identityIssuer,
    scope: [requiredScope],
    jti: randomUUID(),
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "JWT",
      kid: audience === "eqoboard-gateway" ? "bff" : "research-bff",
    })
    .setIssuer("eqoboard-openterminal")
    .setAudience(audience)
    .setSubject(principal.subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Math.min(Date.now() + 60_000, sessionExpiresAt) / 1000))
    .sign(new TextEncoder().encode(secret));

  return { ok: true, principal, token };
}

export type JsonBodyResult =
  | { ok: true; text: string; value: unknown }
  | { ok: false; response: NextResponse };

export async function readBoundedJson(request: Request): Promise<JsonBodyResult> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, response: jsonError(415, "json_required") };

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
    return { ok: false, response: jsonError(413, "request_too_large") };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, response: jsonError(400, "invalid_json") };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return { ok: false, response: jsonError(413, "request_too_large") };
      }
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { ok: true, text, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: jsonError(400, "invalid_json") };
  }
}

export function authenticationFailure(status: number, error: string): NextResponse {
  return jsonError(status, error);
}
