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
  // Next may normalize the internal request URL to 127.0.0.1; Host remains
  // the exact public authority. Do not accept forwarded host assertions.
  const site = request.headers.get("sec-fetch-site");
  return request.headers.get("host") === expected.host &&
    (!request.headers.get("x-forwarded-host") || request.headers.get("x-forwarded-host") === expected.host) &&
    (!request.headers.get("origin") || request.headers.get("origin") === origin) &&
    (!site || site === "same-origin" || site === "none");
}

export const LOCAL_ROLES = [
  "eqoboard-market-reader", "eqoboard-workspace-editor",
  "eqoboard-private-research-reader", "eqoboard-order-reviewer",
  "eqoboard-paper-operator",
] as const;
export const localScopes = () => scopesForRoles(LOCAL_ROLES);
