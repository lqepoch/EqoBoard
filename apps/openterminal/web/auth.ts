import type { NextAuthOptions } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import { allowlistedRoles } from "@/lib/permissions";

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

export function isOidcConfigured(): boolean {
  return Boolean(
    validIssuer(process.env.EQO_OIDC_ISSUER) &&
      process.env.EQO_OIDC_CLIENT_ID?.trim() &&
      process.env.EQO_OIDC_CLIENT_SECRET?.trim() &&
      process.env.NEXTAUTH_SECRET && process.env.NEXTAUTH_SECRET.length >= 32 &&
      publicAppOrigin(),
  );
}

function validHmacSecret(value: string | undefined): value is string {
  return Boolean(value && value.length >= 64 && /^[\x21-\x7e]+$/.test(value));
}

export function isAuthRuntimeConfigured(): boolean {
  return isOidcConfigured() &&
    validHmacSecret(process.env.EQO_GATEWAY_JWT_SECRET) &&
    validHmacSecret(process.env.EQO_RESEARCH_JWT_SECRET) &&
    Boolean(process.env.EQO_RESEARCH_API_KEY && process.env.EQO_RESEARCH_API_KEY.length >= 32);
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

const sessionLifetimeSeconds = 60 * 60;

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: oidcProvider ? [oidcProvider] : [],
  session: { strategy: "jwt", maxAge: sessionLifetimeSeconds, updateAge: 5 * 60 },
  jwt: { maxAge: sessionLifetimeSeconds },
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
      if (session.user) {
        session.user.id = typeof token.sub === "string" ? token.sub : "";
        session.user.roles = allowlistedRoles(token.eqoRoles);
        session.user.issuer = typeof token.eqoIssuer === "string" ? token.eqoIssuer : "";
      }
      return session;
    },
  },
};
