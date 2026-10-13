import { scopesForRoles } from "./permissions";

/** Explicit workstation mode; never enabled by the absence of OIDC settings. */
export function localAccessOrigin(env = process.env): string | null {
  if (env.EQO_LOCAL_ACCESS !== "true" || env.EQO_BFF_MODE === "research" ||
      env.EQO_LOCAL_BIND !== "127.0.0.1") return null;
  try {
    const url = new URL(env.EQO_PUBLIC_ORIGIN ?? "");
    if (url.origin !== env.EQO_PUBLIC_ORIGIN || url.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        new URL(env.NEXTAUTH_URL ?? "").origin !== url.origin) return null;
    return url.origin;
  } catch { return null; }
}

export function localRequestAllowed(request: Request): boolean {
  const origin = localAccessOrigin();
  if (!origin) return false;
  const expected = new URL(origin);
  const host = request.headers.get("host");
  const xForwardedHost = request.headers.get("x-forwarded-host");
  const reqOrigin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");

  const portSuffix = expected.port ? `:${expected.port}` : "";
  const allowedHosts = new Set([
    expected.host,
    `127.0.0.1${portSuffix}`,
    `localhost${portSuffix}`,
  ]);

  const allowedOrigins = new Set([
    origin,
    `http://127.0.0.1${portSuffix}`,
    `http://localhost${portSuffix}`,
  ]);

  const isHostAllowed = host ? allowedHosts.has(host) : false;
  const isForwardedAllowed = !xForwardedHost || allowedHosts.has(xForwardedHost);
  const isOriginAllowed = !reqOrigin || allowedOrigins.has(reqOrigin);
  const isSiteAllowed = !site || site === "same-origin" || site === "none";

  return isHostAllowed && isForwardedAllowed && isOriginAllowed && isSiteAllowed;
}

export const LOCAL_ROLES = [
  "eqoboard-market-reader", "eqoboard-workspace-editor",
  "eqoboard-private-research-reader", "eqoboard-order-reviewer",
  "eqoboard-paper-operator",
] as const;
export const localScopes = () => scopesForRoles(LOCAL_ROLES);
