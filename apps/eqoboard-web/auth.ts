import "server-only";

import type { NextAuthOptions } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import { allowlistedRoles } from "@/lib/server/permissions";
import { containsControlCharacters } from "@/lib/server/text-validation";

type OidcProfile = Record<string, unknown> & {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  roles?: unknown;
};

const NATIVE_E2E_ISSUER = "http://native-mock-oidc:4450";

/** Return the exact loopback origin selected by the launcher, or fail closed. */
export function localWorkstationOrigin(): string | null {
  if (
    process.env.EQO_LOCAL_ACCESS !== "true" ||
    process.env.EQO_BFF_MODE !== "terminal" ||
    process.env.EQO_LOCAL_BIND !== "127.0.0.1" ||
    process.env.HOSTNAME !== "127.0.0.1"
  ) {
    return null;
  }

  const rawPort = process.env.PORT;
  const configuredPort = rawPort === undefined || rawPort === "" ? "3000" : rawPort;
  if (!/^[1-9][0-9]{0,4}$/u.test(configuredPort)) return null;
  const port = Number(configuredPort);
  if (!Number.isSafeInteger(port) || port > 65_535) return null;

  const expectedOrigin = new URL(`http://127.0.0.1:${port}`).origin;
  if (
    process.env.EQO_PUBLIC_ORIGIN !== expectedOrigin ||
    process.env.NEXTAUTH_URL !== expectedOrigin ||
    typeof process.env.NEXTAUTH_SECRET !== "string" ||
    process.env.NEXTAUTH_SECRET.length < 32
  ) {
    return null;
  }
  return expectedOrigin;
}

/** A non-empty local-access setting opts into local mode and must be exact. */
export function localWorkstationModeRequested(): boolean {
  const value = process.env.EQO_LOCAL_ACCESS;
  return typeof value === "string" && value.length > 0 && value !== "false";
}

/** Local access is deliberately tied to the launcher’s one loopback endpoint. */
export function localWorkstationModeEnabled(): boolean {
  return localWorkstationOrigin() !== null;
}

/**
 * Validate the direct local request boundary without trusting proxy headers.
 * Next.js 15.5.27 adds its x-forwarded-* defaults before route handlers, so the
 * authority-bearing values must agree with Host and the fixed local origin.
 */
export function isLocalWorkstationRequestAllowed(request: Request): boolean {
  const configuredOrigin = localWorkstationOrigin();
  if (!configuredOrigin) return false;
  const expected = new URL(configuredOrigin);
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  // Next.js 15.5.27 normalizes IPv4 loopback URLs to `localhost` in NextURL.
  // The original Host and forwarded authority are still checked below, so this
  // accepts only that framework-internal URL representation of the same request.
  const nextNormalizedOrigin = new URL(configuredOrigin);
  nextNormalizedOrigin.hostname = "localhost";
  if (requestUrl.origin !== configuredOrigin && requestUrl.origin !== nextNormalizedOrigin.origin) {
    return false;
  }
  if (request.headers.get("host") !== expected.host) return false;

  let invalidForwardingHeader = false;
  request.headers.forEach((value, name) => {
    if (name === "forwarded" || name.startsWith("x-original-")) {
      invalidForwardingHeader = true;
      return;
    }
    if (!name.startsWith("x-forwarded-") || name === "x-forwarded-for") return;
    const expectedValue =
      name === "x-forwarded-host"
        ? expected.host
        : name === "x-forwarded-proto"
          ? "http"
          : name === "x-forwarded-port"
            ? process.env.PORT || "3000"
            : null;
    if (expectedValue === null || value !== expectedValue) invalidForwardingHeader = true;
  });
  if (invalidForwardingHeader) return false;

  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const mode = request.headers.get("sec-fetch-mode");
  const method = request.method.toUpperCase();
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (origin !== null && origin !== configuredOrigin) return false;
  if (site !== null && site !== "same-origin" && !(site === "none" && !isWrite)) return false;
  if (
    isWrite &&
    (origin !== configuredOrigin || (mode !== null && mode !== "same-origin" && mode !== "cors"))
  ) {
    return false;
  }
  if (isWrite && mode === "cors" && site !== "same-origin") return false;
  return true;
}

function validIssuer(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const approvedNativeE2eIssuer = process.env.EQO_NATIVE_E2E === "1" && raw === NATIVE_E2E_ISSUER;
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && loopback) &&
      !approvedNativeE2eIssuer
    )
      return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

function validPublicOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== raw ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    const callbackOrigin = process.env.NEXTAUTH_URL;
    if (callbackOrigin && new URL(callbackOrigin).origin !== url.origin) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function sessionLifetimeSeconds(): number | null {
  const raw = process.env.EQO_SESSION_TTL_SECONDS;
  if (raw === undefined || raw === "") return 60 * 60;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 24 * 60 * 60 ? seconds : null;
}

export function currentOidcIssuer(): string | null {
  return validIssuer(process.env.EQO_OIDC_ISSUER);
}

export function publicAppOrigin(): string | null {
  return validPublicOrigin(process.env.EQO_PUBLIC_ORIGIN);
}

export function isCurrentOidcIssuer(candidate: string): boolean {
  return currentOidcIssuer() !== null && candidate === currentOidcIssuer();
}

export function configuredSessionLifetime(): number | null {
  return sessionLifetimeSeconds();
}

export function isOidcConfigured(): boolean {
  if (localWorkstationModeRequested()) return false;
  const issuer = currentOidcIssuer();
  const publicOrigin = publicAppOrigin();
  const nextAuthUrl = process.env.NEXTAUTH_URL;
  return Boolean(
    issuer &&
      process.env.EQO_OIDC_CLIENT_ID?.trim() &&
      process.env.EQO_OIDC_CLIENT_SECRET?.trim() &&
      process.env.NEXTAUTH_SECRET &&
      process.env.NEXTAUTH_SECRET.length >= 32 &&
      publicOrigin &&
      nextAuthUrl === publicOrigin &&
      sessionLifetimeSeconds() !== null,
  );
}

function safeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 120 || containsControlCharacters(name)) return null;
  return name;
}

function secureCookies(): NonNullable<NextAuthOptions["cookies"]> {
  const secure = publicAppOrigin()?.startsWith("https://") ?? false;
  const hostPrefix = secure ? "__Host-" : "";
  const cookiePrefix = process.env.EQO_BFF_MODE === "research" ? "eqoboard-research" : "eqoboard";
  const base = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };
  const flow = { ...base, maxAge: 15 * 60 };
  const lifetime = sessionLifetimeSeconds() ?? 60 * 60;
  return {
    sessionToken: {
      name: `${hostPrefix}${cookiePrefix}.session-token`,
      options: { ...base, maxAge: lifetime },
    },
    callbackUrl: { name: `${hostPrefix}${cookiePrefix}.callback-url`, options: flow },
    csrfToken: { name: `${hostPrefix}${cookiePrefix}.csrf-token`, options: flow },
    pkceCodeVerifier: { name: `${hostPrefix}${cookiePrefix}.pkce-code-verifier`, options: flow },
    state: { name: `${hostPrefix}${cookiePrefix}.state`, options: flow },
    nonce: { name: `${hostPrefix}${cookiePrefix}.nonce`, options: flow },
  };
}

export function authCookieName(): string {
  const sessionToken = secureCookies().sessionToken;
  if (!sessionToken?.name) throw new Error("NextAuth session cookie is not configured.");
  return sessionToken.name;
}

const issuer = currentOidcIssuer();
const provider: OAuthConfig<OidcProfile> = {
  id: "eqo-oidc",
  name: "Organization sign-in",
  type: "oauth",
  wellKnown: `${issuer ?? "https://invalid.eqoboard.invalid"}/.well-known/openid-configuration`,
  clientId: process.env.EQO_OIDC_CLIENT_ID ?? "unconfigured",
  clientSecret: process.env.EQO_OIDC_CLIENT_SECRET ?? "unconfigured",
  authorization: { params: { scope: "openid profile email" } },
  idToken: true,
  checks: ["pkce", "state", "nonce"],
  profile(profile) {
    if (typeof profile.sub !== "string" || profile.sub.length === 0 || profile.sub.length > 255) {
      throw new Error("OIDC subject is invalid");
    }
    return {
      id: profile.sub,
      name: safeDisplayName(profile.name),
      email:
        typeof profile.email === "string" && profile.email.length <= 254 ? profile.email : null,
      image:
        typeof profile.picture === "string" && profile.picture.length <= 2048
          ? profile.picture
          : null,
      eqoRoles: allowlistedRoles(profile.roles),
    };
  },
};

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [provider],
  cookies: secureCookies(),
  session: {
    strategy: "jwt",
    maxAge: sessionLifetimeSeconds() ?? 60 * 60,
    updateAge: Math.min(5 * 60, sessionLifetimeSeconds() ?? 60 * 60),
  },
  jwt: { maxAge: sessionLifetimeSeconds() ?? 60 * 60 },
  useSecureCookies: publicAppOrigin()?.startsWith("https://") ?? false,
  callbacks: {
    async jwt({ token, user, account, profile, trigger }) {
      // A client-triggered session update can never replace verified identity claims.
      if (trigger === "update") return token;
      if (account && user && profile && issuer) {
        const oidcProfile = profile as OidcProfile;
        const verifiedSubject = typeof oidcProfile.sub === "string" ? oidcProfile.sub : user.id;
        if (verifiedSubject && verifiedSubject.length <= 255) {
          const lifetime = sessionLifetimeSeconds() ?? 60 * 60;
          token.nativeSubject = verifiedSubject;
          token.nativeIssuer = issuer;
          token.nativeRoles = allowlistedRoles(oidcProfile.roles ?? user.eqoRoles);
          token.nativeDisplayName = safeDisplayName(oidcProfile.name ?? user.name);
          const localExpiry = Date.now() + lifetime * 1000;
          const providerExpiry =
            typeof account.expires_at === "number" && Number.isSafeInteger(account.expires_at)
              ? account.expires_at * 1000
              : null;
          token.nativeProviderExpiresAt = providerExpiry;
          token.nativeExpiresAt =
            providerExpiry === null ? localExpiry : Math.min(localExpiry, providerExpiry);
        }
      }
      return token;
    },
    async session({ session }) {
      // The /api/auth/session response intentionally contains no user identity, roles or JWT claims.
      return { expires: session.expires };
    },
  },
};
