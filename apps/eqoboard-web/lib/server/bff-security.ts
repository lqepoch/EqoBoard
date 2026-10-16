import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { isPermission, type Permission } from "../contracts/auth";
import {
  isLocalWorkstationRequestAllowed,
  isOidcConfigured,
  localWorkstationModeEnabled,
  localWorkstationModeRequested,
  publicAppOrigin,
} from "../../auth";
import { getServerPrincipal, type ServerPrincipal } from "./auth";
import {
  getNativeRuntimeMode,
  nativeRuntimeAllowsAuthorizedRoute,
  nativeRuntimeReadiness,
} from "./runtime-mode";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_BODY_READ_MS = 5_000;
const RESEARCH_RUNTIME_PERMISSIONS: readonly Permission[] = [
  "market:read",
  "research:read",
  "research:private-read",
];

export type AuthorizationResult =
  | Readonly<{ ok: true; principal: ServerPrincipal }>
  | Readonly<{ ok: false; response: NextResponse }>;

export type GatewayDelegationResult =
  | Readonly<{ ok: true; principal: ServerPrincipal; token: string; expiresAt: number }>
  | Readonly<{ ok: false; response: NextResponse }>;

export type BoundedJsonResult =
  | Readonly<{ ok: true; value: unknown; text: string }>
  | Readonly<{ ok: false; response: NextResponse }>;

export type BoundedBodyResult =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; response: NextResponse }>;

function responseHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  new Headers(extra).forEach((value, name) => {
    headers.set(name, value);
  });
  return headers;
}

function jsonError(status: number, error: string, headers: HeadersInit = {}): NextResponse {
  return NextResponse.json(
    { error },
    {
      status,
      headers: responseHeaders(headers),
    },
  );
}

function maxBodyBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_MAX_BODY_BYTES;
  return Math.min(value, 1024 * 1024);
}

function isWriteMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function validateLocalWorkstationBoundary(request: Request): NextResponse | null {
  if (!localWorkstationModeRequested()) return null;
  if (!localWorkstationModeEnabled()) return jsonError(503, "identity_unavailable");
  if (!isLocalWorkstationRequestAllowed(request)) return jsonError(403, "origin_rejected");
  return null;
}

/** Enforce browser origin/site isolation before any identity or downstream work. */
export function validateRequestBoundary(
  request: Request,
  options: { requireJson?: boolean } = {},
): NextResponse | null {
  const localBoundaryError = validateLocalWorkstationBoundary(request);
  if (localBoundaryError) return localBoundaryError;
  const method = request.method.toUpperCase();
  const isWrite = isWriteMethod(method);
  const expectedOrigin = publicAppOrigin();
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const mode = request.headers.get("sec-fetch-mode");
  const localMode = localWorkstationModeRequested();

  if (origin !== null && (!expectedOrigin || origin !== expectedOrigin))
    return jsonError(403, "origin_rejected");
  if (site !== null && site !== "same-origin") return jsonError(403, "origin_rejected");
  if (mode !== null && isWrite && mode !== "same-origin" && !(localMode && mode === "cors")) {
    return jsonError(403, "origin_rejected");
  }
  if (isWrite && (!expectedOrigin || origin !== expectedOrigin))
    return jsonError(403, "origin_rejected");

  // Native routes never accept compressed request bodies or transfer-coded
  // bodies. This keeps the byte cap meaningful across the Next runtime and
  // avoids disagreement between the framework parser and our bounded reader.
  if (request.headers.has("content-encoding") || request.headers.has("transfer-encoding")) {
    return jsonError(400, "invalid_request");
  }

  if (options.requireJson || ["POST", "PUT", "PATCH"].includes(method)) {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return jsonError(415, "json_required");
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > DEFAULT_MAX_BODY_BYTES)
  ) {
    return jsonError(413, "request_too_large");
  }
  return null;
}

export function validateSameOriginWrite(request: Request): NextResponse | null {
  const localBoundaryError = validateLocalWorkstationBoundary(request);
  if (localBoundaryError) return localBoundaryError;
  if (!isWriteMethod(request.method)) return null;
  const expectedOrigin = publicAppOrigin();
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (!expectedOrigin || origin !== expectedOrigin || (site !== null && site !== "same-origin")) {
    return jsonError(403, "origin_rejected");
  }
  return null;
}

export async function authorizeRequest(
  request: Request,
  permission: Permission,
): Promise<AuthorizationResult> {
  const boundaryError = validateRequestBoundary(request);
  if (boundaryError) return { ok: false, response: boundaryError };
  const runtime = nativeRuntimeReadiness();
  if (!runtime.ready) return { ok: false, response: jsonError(503, "identity_unavailable") };
  const pathname = new URL(request.url).pathname;
  if (
    !runtime.mode ||
    !nativeRuntimeAllowsAuthorizedRoute(runtime.mode, request.method, pathname) ||
    (runtime.mode === "research" && !RESEARCH_RUNTIME_PERMISSIONS.includes(permission))
  ) {
    return { ok: false, response: jsonError(404, "not_found") };
  }
  const localMode = localWorkstationModeRequested();
  if (
    !isPermission(permission) ||
    (localMode ? !localWorkstationModeEnabled() : !isOidcConfigured())
  ) {
    return { ok: false, response: jsonError(503, "identity_unavailable") };
  }
  const principal = await getServerPrincipal(request);
  if (!principal) return { ok: false, response: jsonError(401, "unauthenticated") };
  if (!principal.permissions.includes(permission)) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return { ok: true, principal };
}

function validSigningKey(value: string | undefined): value is string {
  return Boolean(value && value.length >= 64 && /^[\x21-\x7e]+$/u.test(value));
}

function distinctServiceKey(secret: string, ownName: string): boolean {
  const serviceKeys = [
    "NEXTAUTH_SECRET",
    "EQO_OIDC_CLIENT_SECRET",
    "EQO_GATEWAY_JWT_SECRET",
    "EQO_RESEARCH_JWT_SECRET",
    "MDP_TERMINAL_JWT_SECRET",
    "MDP_RESEARCH_JWT_SECRET",
    "QUANT_TERMINAL_JWT_SECRET",
    "QUANT_RESEARCH_JWT_SECRET",
    "ENGINE_TERMINAL_JWT_SECRET",
    "ENGINE_RESEARCH_JWT_SECRET",
    "EQO_OPENBB_OIDC_CLIENT_SECRET",
    "EQO_RESEARCH_API_KEY",
    "ANTHROPIC_API_KEY",
    "ALPACA_KEY",
    "ALPACA_SECRET",
    "EQO_ADAPTER_ALPACA_TOKEN",
    "EQO_ADAPTER_IBKR_TOKEN",
    "EQO_ADAPTER_SCHWAB_TOKEN",
  ];
  for (const name of serviceKeys) {
    if (name === ownName) continue;
    const candidate = process.env[name];
    if (!candidate) continue;
    const left = Buffer.from(secret);
    const right = Buffer.from(candidate);
    if (left.length === right.length && timingSafeEqual(left, right)) return false;
  }
  return true;
}

export async function signGatewayDelegation(
  principal: ServerPrincipal,
  permission: Permission,
): Promise<GatewayDelegationResult> {
  if (getNativeRuntimeMode() !== "terminal") {
    return { ok: false, response: jsonError(404, "not_found") };
  }
  if (!isPermission(permission) || !principal.permissions.includes(permission)) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  const secret = process.env.EQO_GATEWAY_JWT_SECRET;
  if (!validSigningKey(secret) || !distinctServiceKey(secret, "EQO_GATEWAY_JWT_SECRET")) {
    return { ok: false, response: jsonError(503, "identity_unavailable") };
  }
  return signDelegation(principal, {
    secret,
    secretName: "EQO_GATEWAY_JWT_SECRET",
    issuer: "eqoboard-openterminal",
    keyId: "bff",
    audience: "eqoboard-gateway",
    scope: [permission],
  });
}

export async function signResearchGatewayReadDelegation(
  principal: ServerPrincipal,
): Promise<GatewayDelegationResult> {
  if (getNativeRuntimeMode() !== "research") {
    return { ok: false, response: jsonError(404, "not_found") };
  }
  if (
    !principal.permissions.includes("research:read") ||
    !principal.permissions.includes("market:read")
  ) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  const secret = process.env.EQO_RESEARCH_JWT_SECRET;
  if (!validSigningKey(secret) || !distinctServiceKey(secret, "EQO_RESEARCH_JWT_SECRET")) {
    return { ok: false, response: jsonError(503, "identity_unavailable") };
  }
  return signDelegation(principal, {
    secret,
    secretName: "EQO_RESEARCH_JWT_SECRET",
    issuer: "openterminal-research",
    keyId: "research",
    audience: "eqoboard-gateway",
    scope: ["market:read"],
  });
}

/** Mint the existing MDP terminal identity for a fixed native market read. */
export async function signMdpMarketReadDelegation(
  principal: ServerPrincipal,
): Promise<GatewayDelegationResult> {
  const mode = getNativeRuntimeMode();
  if (mode !== "terminal" && mode !== "research") {
    return { ok: false, response: jsonError(404, "not_found") };
  }
  if (!principal.permissions.includes("market:read")) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  const research = mode === "research";
  return signDelegation(principal, {
    secret: process.env[research ? "MDP_RESEARCH_JWT_SECRET" : "MDP_TERMINAL_JWT_SECRET"] ?? "",
    secretName: research ? "MDP_RESEARCH_JWT_SECRET" : "MDP_TERMINAL_JWT_SECRET",
    issuer: research ? "openterminal-research" : "eqoboard-openterminal",
    keyId: research ? "mdp-research" : "mdp-terminal",
    audience: "lqepoch-market-data",
    scope: ["market:read"],
  });
}

/** Mint the isolated NativeResearch MDP identity after the research:read role check. */
export async function signMdpResearchReadDelegation(
  principal: ServerPrincipal,
): Promise<GatewayDelegationResult> {
  if (getNativeRuntimeMode() !== "research") {
    return { ok: false, response: jsonError(404, "not_found") };
  }
  if (!principal.permissions.includes("research:read")) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return signDelegation(principal, {
    secret: process.env.MDP_RESEARCH_JWT_SECRET ?? "",
    secretName: "MDP_RESEARCH_JWT_SECRET",
    issuer: "openterminal-research",
    keyId: "mdp-research",
    audience: "lqepoch-market-data",
    scope: ["market:read"],
  });
}

/** Mint the existing private Quant read identity; no artifact is returned by this signer. */
export async function signQuantPredictionReadDelegation(
  principal: ServerPrincipal,
): Promise<GatewayDelegationResult> {
  const mode = getNativeRuntimeMode();
  if (mode !== "terminal" && mode !== "research") {
    return { ok: false, response: jsonError(404, "not_found") };
  }
  if (!principal.permissions.includes("research:private-read")) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  const research = mode === "research";
  return signDelegation(principal, {
    secret: process.env[research ? "QUANT_RESEARCH_JWT_SECRET" : "QUANT_TERMINAL_JWT_SECRET"] ?? "",
    secretName: research ? "QUANT_RESEARCH_JWT_SECRET" : "QUANT_TERMINAL_JWT_SECRET",
    issuer: research ? "openterminal-research" : "eqoboard-openterminal",
    keyId: research ? "quant-research" : "quant-terminal",
    audience: "lqepoch-quant-research",
    scope: ["research:private-read"],
  });
}

/** Mint the existing terminal-only offline Engine read identity. */
export async function signEngineOfflineReadDelegation(
  principal: ServerPrincipal,
): Promise<GatewayDelegationResult> {
  if (getNativeRuntimeMode() !== "terminal") {
    return { ok: false, response: jsonError(404, "not_found") };
  }
  if (!principal.permissions.includes("engine:offline-read")) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return signDelegation(principal, {
    secret: process.env.ENGINE_TERMINAL_JWT_SECRET ?? "",
    secretName: "ENGINE_TERMINAL_JWT_SECRET",
    issuer: "eqoboard-openterminal",
    keyId: "engine-terminal",
    audience: "lqepoch-trading-engine",
    scope: ["engine:offline-read"],
  });
}

async function signDelegation(
  principal: ServerPrincipal,
  options: Readonly<{
    secret: string;
    secretName: string;
    issuer: string;
    keyId: string;
    audience: string;
    scope: readonly string[];
  }>,
): Promise<GatewayDelegationResult> {
  if (
    !validSigningKey(options.secret) ||
    !nativeRuntimeReadiness().ready ||
    !isOidcConfigured() ||
    !distinctServiceKey(options.secret, options.secretName)
  ) {
    return { ok: false, response: jsonError(503, "identity_unavailable") };
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt =
    Math.floor(Math.min(Date.now() + 60_000, principal.sessionExpiresAt) / 1000) * 1000;
  if (expiresAt <= issuedAt * 1000)
    return { ok: false, response: jsonError(401, "unauthenticated") };
  try {
    const token = await new SignJWT({
      idp_iss: principal.identityIssuer,
      scope: [...options.scope],
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: options.keyId })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setSubject(principal.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(new TextEncoder().encode(options.secret));
    return { ok: true, principal, token, expiresAt };
  } catch {
    return { ok: false, response: jsonError(503, "identity_unavailable") };
  }
}

export async function authorizeGatewayRequest(
  request: Request,
  permission: Permission,
): Promise<GatewayDelegationResult> {
  const authorization = await authorizeRequest(request, permission);
  if (!authorization.ok) return authorization;
  return signGatewayDelegation(authorization.principal, permission);
}

export async function readBoundedBody(
  request: Request,
  requestedMaxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<BoundedBodyResult> {
  const maxBytes = maxBodyBytes(requestedMaxBytes);
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    return { ok: false, response: jsonError(413, "request_too_large") };
  }
  if (!request.body) return { ok: false, response: jsonError(400, "invalid_json") };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("body_timeout")), MAX_BODY_READ_MS);
    });
    const readAll = async (): Promise<Uint8Array> => {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > maxBytes) throw new RangeError("body_too_large");
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    };
    const bytes = await Promise.race([readAll(), timeout]);
    return { ok: true, bytes };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    return {
      ok: false,
      response:
        error instanceof RangeError
          ? jsonError(413, "request_too_large")
          : jsonError(
              error instanceof Error && error.message === "body_timeout" ? 408 : 400,
              error instanceof Error && error.message === "body_timeout"
                ? "request_body_timeout"
                : "request_body_invalid",
            ),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    reader.releaseLock();
  }
}

export async function readBoundedJson(
  request: Request,
  requestedMaxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<BoundedJsonResult> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json")
    return { ok: false, response: jsonError(415, "json_required") };
  const body = await readBoundedBody(request, requestedMaxBytes);
  if (!body.ok) return body;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
  } catch {
    return { ok: false, response: jsonError(400, "invalid_json") };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown, text };
  } catch {
    return { ok: false, response: jsonError(400, "invalid_json") };
  }
}

export function noStoreJson(
  data: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: responseHeaders(extraHeaders),
  });
}
