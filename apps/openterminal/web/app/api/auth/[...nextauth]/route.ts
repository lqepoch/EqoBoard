import NextAuth from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/auth";
import { readBoundedBody } from "@/lib/eqo-auth";
import { isResearchRouteAllowed } from "@/lib/research-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = NextAuth(authOptions);

type RouteContext = { params: Promise<{ nextauth: string[] }> };

async function boundedAuthRequest(request: NextRequest): Promise<NextRequest | NextResponse> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return request;
  const bounded = await readBoundedBody(request);
  if (!bounded.ok) {
    return NextResponse.json({ error: bounded.error }, {
      status: bounded.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: Buffer.from(bounded.bytes),
    signal: request.signal,
  });
}

async function dispatch(request: NextRequest, context: RouteContext) {
  if (process.env.EQO_BFF_MODE === "research" &&
      !isResearchRouteAllowed(request.url, request.nextUrl.pathname, request.method)) {
    return NextResponse.json({ error: "route_not_available" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const bounded = await boundedAuthRequest(request);
  if (bounded instanceof NextResponse) return bounded;
  return handler(bounded, context);
}

export function OPTIONS() {
  if (process.env.EQO_BFF_MODE === "research") {
    return NextResponse.json({ error: "route_not_available" }, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(null, {
    status: 204,
    headers: { Allow: "GET, HEAD, OPTIONS, POST", "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}
