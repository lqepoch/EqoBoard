import NextAuth from "next-auth";
import { NextRequest } from "next/server";
import { authOptions, isOidcConfigured } from "@/auth";
import { noStoreJson, readBoundedBody, validateSameOriginWrite } from "@/lib/server/bff-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = NextAuth(authOptions);
type RouteContext = { params: Promise<{ nextauth: string[] }> };

async function dispatch(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isOidcConfigured()) return noStoreJson({ error: "identity_unavailable" }, 503);
  const originFailure = validateSameOriginWrite(request);
  if (originFailure) return originFailure;

  let boundedRequest = request;
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    const bounded = await readBoundedBody(request, 64 * 1024);
    if (!bounded.ok) return bounded.response;
    boundedRequest = new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
      body: bounded.bytes,
      signal: request.signal,
    });
  }
  try {
    const response = await handler(boundedRequest, context);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch {
    return noStoreJson({ error: "identity_unavailable" }, 503);
  }
}

export function GET(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export function POST(request: NextRequest, context: RouteContext) {
  return dispatch(request, context);
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: { Allow: "GET, HEAD, OPTIONS, POST", "Cache-Control": "no-store" },
  });
}
