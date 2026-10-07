import { NextRequest, NextResponse } from "next/server";

const NO_STORE = { "Cache-Control": "no-store" };
const AUTH_ENDPOINT = /^(providers|csrf|session|signin(?:\/[A-Za-z0-9_-]+)?|callback\/[A-Za-z0-9_-]+|signout|verify-request|error)$/;
const OPENBB_ENDPOINT = /^\/api\/openbb\/(?:widgets\.json|apps\.json|openbb\/v1\/(?:stocks|bars|options))$/;

function rejected(): NextResponse {
  return NextResponse.json({ error: "route_not_available" }, { status: 404, headers: NO_STORE });
}

function researchPathAllowed(request: NextRequest): boolean {
  const rawPath = new URL(request.url).pathname;
  if (rawPath.includes("\\") || rawPath.includes("//") || /%(?:2f|5c|2e)/i.test(rawPath)) return false;
  const pathname = request.nextUrl.pathname;
  const method = request.method.toUpperCase();

  if (pathname === "/api/healthz" || pathname === "/api/readyz") {
    return method === "GET" || method === "HEAD";
  }
  if (pathname === "/api/research/auth-check") return method === "GET";
  if (pathname.startsWith("/api/auth/")) {
    const endpoint = pathname.slice("/api/auth/".length);
    return AUTH_ENDPOINT.test(endpoint) && ["GET", "POST"].includes(method);
  }
  return OPENBB_ENDPOINT.test(pathname) && method === "GET";
}

export function middleware(request: NextRequest): NextResponse {
  if (process.env.EQO_BFF_MODE !== "research") return NextResponse.next();
  return researchPathAllowed(request) ? NextResponse.next() : rejected();
}

export const config = {
  matcher: ["/:path*"],
};
