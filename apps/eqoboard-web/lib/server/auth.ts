import "server-only";

import { createHash, createHmac, hkdfSync } from "node:crypto";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { isPermission, type AuthUiSnapshot, type Permission } from "../contracts/auth";
import {
  authCookieName,
  currentOidcIssuer,
  isLocalWorkstationRequestAllowed,
  isOidcConfigured,
  localWorkstationOrigin,
  localWorkstationModeEnabled,
  localWorkstationModeRequested,
  publicAppOrigin,
} from "../../auth";
import { allowlistedRoles, permissionsForRoles } from "./permissions";
import {
  getNativeRuntimeMode,
  nativeResearchPublicOrigin,
  nativeRuntimeReadiness,
  type NativeRuntimeMode,
} from "./runtime-mode";
import { containsControlCharacters } from "./text-validation";

export type ServerPrincipal = Readonly<{
  identityIssuer: string;
  subject: string;
  permissions: readonly Permission[];
  sessionExpiresAt: number;
}>;

export type PrincipalClaims = Readonly<{
  nativeIssuer: unknown;
  nativeSubject: unknown;
  nativeRoles: unknown;
  nativeExpiresAt: unknown;
  nativeProviderExpiresAt?: unknown;
  exp: unknown;
}>;

const RESEARCH_UI_PERMISSIONS: readonly Permission[] = [
  "market:read",
  "research:read",
  "research:private-read",
];

const LOCAL_WORKSTATION_PERMISSIONS: readonly Permission[] = [
  "market:read",
  "market:stream",
  "market:subscribe",
  "orders:preview",
  "research:read",
  "workspace:read",
  "workspace:write",
];

export function principalFromClaims(
  claims: PrincipalClaims | null,
  now = Date.now(),
): ServerPrincipal | null {
  const issuer = currentOidcIssuer();
  if (
    !claims ||
    !issuer ||
    claims.nativeIssuer !== issuer ||
    typeof claims.nativeSubject !== "string" ||
    claims.nativeSubject.length === 0 ||
    claims.nativeSubject.length > 255 ||
    containsControlCharacters(claims.nativeSubject) ||
    typeof claims.nativeExpiresAt !== "number" ||
    !Number.isSafeInteger(claims.nativeExpiresAt) ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp)
  )
    return null;

  const providerExpiresAt = claims.nativeProviderExpiresAt;
  if (
    providerExpiresAt !== undefined &&
    providerExpiresAt !== null &&
    (typeof providerExpiresAt !== "number" || !Number.isSafeInteger(providerExpiresAt))
  )
    return null;
  const sessionExpiresAt = Math.min(
    claims.nativeExpiresAt,
    claims.exp * 1000,
    typeof providerExpiresAt === "number" ? providerExpiresAt : Number.POSITIVE_INFINITY,
  );
  if (sessionExpiresAt <= now + 1_000) return null;
  const roles = allowlistedRoles(claims.nativeRoles);
  return {
    identityIssuer: issuer,
    subject: claims.nativeSubject,
    permissions: permissionsForRoles(roles),
    sessionExpiresAt,
  };
}

function requestForServerComponent(headerValues: Headers): NextRequest {
  const origin = publicAppOrigin() ?? "http://localhost";
  return new NextRequest(origin, { headers: headerValues });
}

function requestForNextAuth(request: Request): NextRequest {
  if (request instanceof NextRequest) return request;
  return new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
  });
}

async function getSessionClaims(request?: Request): Promise<PrincipalClaims | null> {
  if (!isOidcConfigured() || !process.env.NEXTAUTH_SECRET) return null;
  try {
    const req = request ? requestForNextAuth(request) : requestForServerComponent(await headers());
    const token = await getToken({
      req,
      secret: process.env.NEXTAUTH_SECRET,
      cookieName: authCookieName(),
      secureCookie: publicAppOrigin()?.startsWith("https://") ?? false,
    });
    return token as PrincipalClaims | null;
  } catch {
    return null;
  }
}

/** Read only the signed, encrypted NextAuth cookie; never trust browser identity headers. */
export async function getServerPrincipal(request?: Request): Promise<ServerPrincipal | null> {
  if (localWorkstationModeRequested()) {
    const issuerOrigin = localWorkstationOrigin();
    if (!issuerOrigin || !localWorkstationModeEnabled() || !nativeRuntimeReadiness().ready)
      return null;
    const localRequest = request ?? requestForServerComponent(await headers());
    if (!isLocalWorkstationRequestAllowed(localRequest)) return null;
    return {
      identityIssuer: `${issuerOrigin}/local-workstation`,
      subject: "local-workstation",
      permissions: LOCAL_WORKSTATION_PERMISSIONS,
      sessionExpiresAt: Date.now() + 60_000,
    };
  }
  return principalFromClaims(await getSessionClaims(request));
}

export function ownerKeyForPrincipal(
  principal: Pick<ServerPrincipal, "identityIssuer" | "subject">,
): string {
  return createHash("sha256")
    .update(principal.identityIssuer)
    .update("\0")
    .update(principal.subject)
    .digest("hex");
}

function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 120 && !containsControlCharacters(name) ? name : null;
}

function storagePartition(principal: ServerPrincipal, mode: NativeRuntimeMode): string {
  const sessionSecret = process.env.NEXTAUTH_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("Native UI storage partition secret is unavailable.");
  }

  // Derive a purpose-specific key so a browser-visible partition cannot be
  // guessed from the public issuer/subject pair or reused as the DB owner key.
  const partitionKey = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(sessionSecret, "utf8"),
      Buffer.from("eqoboard.native.ui-storage-partition.salt.v1", "utf8"),
      Buffer.from("eqoboard.native.ui-storage-partition.key.v1", "utf8"),
      32,
    ),
  );
  const digest = createHmac("sha256", partitionKey)
    .update("eqoboard.native.ui-storage-partition.identity.v1\0", "utf8")
    .update(mode, "utf8")
    .update("\0", "utf8")
    .update(principal.identityIssuer, "utf8")
    .update("\0", "utf8")
    .update(principal.subject, "utf8")
    .digest("hex");
  return `native-${mode}-v1-${digest}`;
}

function anonymousSnapshot(
  status: AuthUiSnapshot["status"],
  mode: NativeRuntimeMode | null,
): AuthUiSnapshot {
  return {
    status,
    authenticated: false,
    displayName: null,
    permissions: [],
    storagePartition: null,
    ...(mode === null ? {} : { runtimeMode: mode }),
    researchOrigin:
      localWorkstationModeRequested() || mode !== "terminal"
        ? null
        : nativeResearchPublicOrigin(),
  };
}

/** Server-rendered, non-authoritative UI state. This value never authorizes an API call. */
export async function getAuthUiSnapshot(): Promise<AuthUiSnapshot> {
  const mode = getNativeRuntimeMode();
  if (mode === null || !nativeRuntimeReadiness().ready) {
    return anonymousSnapshot("identity-unavailable", mode);
  }
  if (localWorkstationModeRequested()) {
    const principal = await getServerPrincipal();
    if (!principal) return anonymousSnapshot("identity-unavailable", mode);
    return {
      status: "authenticated",
      authenticated: true,
      displayName: "Local workstation",
      identityType: "local-workstation",
      permissions: [...principal.permissions],
      storagePartition: storagePartition(principal, mode),
      runtimeMode: mode,
      researchOrigin: null,
    };
  }
  if (!isOidcConfigured()) return anonymousSnapshot("identity-unavailable", mode);
  const claims = await getSessionClaims();
  if (!claims) return anonymousSnapshot("sign-in-required", mode);
  const principal = principalFromClaims(claims);
  if (!principal) return anonymousSnapshot("policy-rejected", mode);
  const permissions = principal.permissions.filter(
    (permission): permission is Permission =>
      isPermission(permission) &&
      (mode === "terminal" || RESEARCH_UI_PERMISSIONS.includes(permission)),
  );
  if (permissions.length === 0) return anonymousSnapshot("policy-rejected", mode);
  return {
    status: "authenticated",
    authenticated: true,
    identityType: "oidc",
    displayName: cleanDisplayName(
      (claims as PrincipalClaims & { nativeDisplayName?: unknown }).nativeDisplayName,
    ),
    permissions,
    storagePartition: storagePartition(principal, mode),
    runtimeMode: mode,
    researchOrigin: mode === "terminal" ? nativeResearchPublicOrigin() : null,
  };
}
