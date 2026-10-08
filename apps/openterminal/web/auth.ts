import type { NextAuthOptions } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import { allowlistedRoles } from "@/lib/permissions";
import { validatePublicResearchOrigin } from "@/lib/research-origin";

type OidcProfile = Record<string, unknown> & {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
};

function validIssuer(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function configuredSessionLifetime(): number | null {
  const raw = process.env.EQO_SESSION_TTL_SECONDS;
  if (raw === undefined || raw === "") return 60 * 60;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 24 * 60 * 60 ? seconds : null;
}

const sessionLifetimeSeconds = configuredSessionLifetime();

export function publicAppOrigin(): string | null {
  const raw = process.env.EQO_PUBLIC_ORIGIN;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== raw || url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    const nextAuthUrl = process.env.NEXTAUTH_URL;
    if (nextAuthUrl && new URL(nextAuthUrl).origin !== url.origin) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hasSeparateResearchHostname(): boolean {
  const researchRaw = process.env.EQO_PUBLIC_ORIGIN;
  const terminalRaw = process.env.EQO_TERMINAL_PUBLIC_ORIGIN;
  if (!researchRaw || !terminalRaw) return false;

  try {
    const research = new URL(researchRaw);
    const terminal = new URL(terminalRaw);
    const isAllowedOrigin = (url: URL, raw: string) => {
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return url.origin === raw && !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === "https:" || (url.protocol === "http:" && loopback));
    };

    // Cookies are scoped to a hostname, not a port. A second port on the same
    // hostname would still receive host-only Terminal cookies.
    return isAllowedOrigin(research, researchRaw) &&
      isAllowedOrigin(terminal, terminalRaw) &&
      research.hostname !== terminal.hostname;
  } catch {
    return false;
  }
}

/**
 * Optional public OpenBB Workspace origin. It is navigation-only: the browser
 * starts its own OpenBB session and never receives Gateway or BFF credentials.
 */
export function publicResearchOrigin(): string | null {
  return validatePublicResearchOrigin(process.env.EQO_RESEARCH_PUBLIC_ORIGIN, publicAppOrigin());
}

export function isOidcConfigured(): boolean {
  return Boolean(
    validIssuer(process.env.EQO_OIDC_ISSUER) &&
      process.env.EQO_OIDC_CLIENT_ID?.trim() &&
      process.env.EQO_OIDC_CLIENT_SECRET?.trim() &&
      process.env.NEXTAUTH_SECRET && process.env.NEXTAUTH_SECRET.length >= 32 &&
      publicAppOrigin() && sessionLifetimeSeconds !== null,
  );
}

function validHmacSecret(value: string | undefined): value is string {
  return Boolean(value && value.length >= 64 && /^[\x21-\x7e]+$/.test(value));
}

export function isAuthRuntimeConfigured(): boolean {
  const nextAuthSecret = process.env.NEXTAUTH_SECRET;
  const gatewaySecret = process.env.EQO_GATEWAY_JWT_SECRET;
  const researchSecret = process.env.EQO_RESEARCH_JWT_SECRET;
  const signingSecrets = [nextAuthSecret, gatewaySecret, researchSecret];
  return isOidcConfigured() &&
    validHmacSecret(gatewaySecret) &&
    validHmacSecret(researchSecret) &&
    new Set(signingSecrets).size === signingSecrets.length &&
    Boolean(process.env.EQO_RESEARCH_API_KEY && process.env.EQO_RESEARCH_API_KEY.length >= 32);
}

/**
 * The isolated OpenBB BFF can sign only Gateway research tokens. It must not
 * receive the terminal BFF key, the Node research API's static service key,
 * or any provider market credentials.
 */
export function isResearchAuthRuntimeConfigured(): boolean {
  const nextAuthSecret = process.env.NEXTAUTH_SECRET;
  const researchSecret = process.env.EQO_RESEARCH_JWT_SECRET;
  return process.env.EQO_BFF_MODE === "research" &&
    isOidcConfigured() &&
    hasSeparateResearchHostname() &&
    validHmacSecret(researchSecret) &&
    researchSecret !== nextAuthSecret &&
    !process.env.EQO_GATEWAY_JWT_SECRET &&
    !process.env.EQO_RESEARCH_API_KEY &&
    !process.env.ALPACA_KEY &&
    !process.env.ALPACA_SECRET;
}

export type MdpMarketDataRuntimeMode = "terminal" | "research";
export type MdpMarketDataSigner = {
  secret: string;
  issuer: "eqoboard-openterminal" | "openterminal-research";
  kid: "mdp-terminal" | "mdp-research";
};

/**
 * Return only the MDP delegation key assigned to this BFF runtime. MDP keys
 * stay distinct from NextAuth and both legacy Gateway signing keys; a key for
 * the opposite hostname is a configuration error, not a fallback.
 */
export function mdpMarketDataSigner(mode: MdpMarketDataRuntimeMode): MdpMarketDataSigner | null {
  const nextAuthSecret = process.env.NEXTAUTH_SECRET;
  const gatewaySecret = process.env.EQO_GATEWAY_JWT_SECRET;
  const researchGatewaySecret = process.env.EQO_RESEARCH_JWT_SECRET;

  if (mode === "terminal") {
    const secret = process.env.MDP_TERMINAL_JWT_SECRET;
    if (process.env.EQO_BFF_MODE === "research" ||
        Object.hasOwn(process.env, "MDP_RESEARCH_JWT_SECRET") ||
        !isAuthRuntimeConfigured() || !validHmacSecret(secret) ||
        [nextAuthSecret, gatewaySecret, researchGatewaySecret].includes(secret)) {
      return null;
    }
    return { secret, issuer: "eqoboard-openterminal", kid: "mdp-terminal" };
  }

  const secret = process.env.MDP_RESEARCH_JWT_SECRET;
  if (process.env.EQO_BFF_MODE !== "research" ||
      Object.hasOwn(process.env, "MDP_TERMINAL_JWT_SECRET") ||
      !isResearchAuthRuntimeConfigured() || !validHmacSecret(secret) ||
      [nextAuthSecret, gatewaySecret, researchGatewaySecret].includes(secret)) {
    return null;
  }
  return { secret, issuer: "openterminal-research", kid: "mdp-research" };
}

export function isCurrentRuntimeReady(): boolean {
  return process.env.EQO_BFF_MODE === "research"
    ? isResearchAuthRuntimeConfigured()
    : isAuthRuntimeConfigured();
}

function researchCookies(): NonNullable<NextAuthOptions["cookies"]> | undefined {
  if (process.env.EQO_BFF_MODE !== "research") return undefined;
  const secure = publicAppOrigin()?.startsWith("https://") ?? false;
  const prefix = "eqo-research-";
  const hostPrefix = secure ? "__Host-" : "";
  const options = { httpOnly: true, sameSite: "lax" as const, path: "/", secure };
  const flowOptions = { ...options, maxAge: 15 * 60 };
  return {
    sessionToken: { name: `${hostPrefix}${prefix}session-token`, options },
    callbackUrl: { name: `${hostPrefix}${prefix}callback-url`, options: flowOptions },
    csrfToken: { name: `${hostPrefix}${prefix}csrf-token`, options },
    pkceCodeVerifier: { name: `${hostPrefix}${prefix}pkce-code-verifier`, options: flowOptions },
    state: { name: `${hostPrefix}${prefix}state`, options: flowOptions },
    nonce: { name: `${hostPrefix}${prefix}nonce`, options: flowOptions },
  };
}

const issuer = validIssuer(process.env.EQO_OIDC_ISSUER);

export function isCurrentOidcIssuer(candidate: string): boolean {
  return issuer !== null && candidate === issuer;
}

const oidcProvider: OAuthConfig<OidcProfile> | null = issuer &&
  process.env.EQO_OIDC_CLIENT_ID && process.env.EQO_OIDC_CLIENT_SECRET
  ? {
      id: "eqo-oidc",
      name: "Organization sign-in",
      type: "oauth",
      wellKnown: `${issuer}/.well-known/openid-configuration`,
      clientId: process.env.EQO_OIDC_CLIENT_ID,
      clientSecret: process.env.EQO_OIDC_CLIENT_SECRET,
      authorization: { params: { scope: "openid profile email" } },
      idToken: true,
      checks: ["pkce", "state"],
      profile(profile) {
        return {
          id: profile.sub,
          name: typeof profile.name === "string" ? profile.name : null,
          email: typeof profile.email === "string" ? profile.email : null,
          image: typeof profile.picture === "string" ? profile.picture : null,
          eqoRoles: allowlistedRoles(profile.roles),
        };
      },
    }
  : null;

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: oidcProvider ? [oidcProvider] : [],
  cookies: researchCookies(),
  session: {
    strategy: "jwt",
    maxAge: sessionLifetimeSeconds ?? 60 * 60,
    updateAge: Math.min(5 * 60, sessionLifetimeSeconds ?? 60 * 60),
  },
  jwt: { maxAge: sessionLifetimeSeconds ?? 60 * 60 },
  useSecureCookies: publicAppOrigin()?.startsWith("https://") ?? false,
  callbacks: {
    async jwt({ token, user, account }) {
      // Roles are copied only from the verified OIDC profile on sign-in.
      // The client session update callback never replaces these claims.
      if (account && user) {
        token.sub = user.id;
        token.eqoRoles = allowlistedRoles(user.eqoRoles);
        token.eqoIssuer = issuer ?? undefined;
      }
      return token;
    },
    async session({ session, token }) {
      session.sessionExpiresAt = typeof token.exp === "number" ? token.exp * 1000 : 0;
      if (session.user) {
        session.user.id = typeof token.sub === "string" ? token.sub : "";
        session.user.roles = allowlistedRoles(token.eqoRoles);
        session.user.issuer = typeof token.eqoIssuer === "string" ? token.eqoIssuer : "";
      }
      return session;
    },
  },
};
