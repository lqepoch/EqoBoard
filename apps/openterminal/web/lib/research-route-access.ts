const AUTH_ENDPOINT = /^(providers|csrf|session|signin(?:\/[A-Za-z0-9_-]+)?|callback\/[A-Za-z0-9_-]+|signout|verify-request|error)$/;
const OPENBB_ENDPOINT = /^\/api\/openbb\/(?:widgets\.json|apps\.json|openbb\/v1\/(?:stocks|bars|options))$/;

/** Shared fail-closed research route allowlist for middleware and body-reading auth handlers. */
export function isResearchRouteAllowed(rawUrl: string, pathname: string, method: string): boolean {
  const rawPath = new URL(rawUrl).pathname;
  if (rawPath !== pathname || rawPath.includes("\\") || rawPath.includes("//") || /%(?:2f|5c|2e)/i.test(rawPath)) {
    return false;
  }

  const normalizedMethod = method.toUpperCase();
  if (pathname === "/api/healthz" || pathname === "/api/readyz") {
    return normalizedMethod === "GET" || normalizedMethod === "HEAD";
  }
  if (pathname === "/api/research/auth-check") return normalizedMethod === "GET";
  if (pathname.startsWith("/api/auth/")) {
    const endpoint = pathname.slice("/api/auth/".length);
    return AUTH_ENDPOINT.test(endpoint) && ["GET", "POST"].includes(normalizedMethod);
  }
  return OPENBB_ENDPOINT.test(pathname) && normalizedMethod === "GET";
}
