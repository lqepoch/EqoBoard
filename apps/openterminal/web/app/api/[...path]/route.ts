import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getResearchServiceKey } from "@/lib/api-key";
import { authorizeBffRequest, readBoundedJson } from "@/lib/eqo-auth";
import { eqoChain, eqoHistory, eqoStatus, EqoUpstreamError } from "@/lib/eqo-market";
import { readLimitedResponse } from "@/lib/http-response";
import type { ActionScope } from "@/lib/permissions";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";
type RouteContext = { params: Promise<{ path: string[] }> };
type Method = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
type ProxyPolicy = { scope: ActionScope; audience: "openterminal-research" };

const RESEARCH_READ_ROOTS = new Set([
  "quotes", "history", "search", "news", "econ-calendar", "options", "crypto",
  "macro", "heatmap", "screener", "sectors", "recap", "calendar", "earnings-history",
  "short-volume", "insider",
]);
const MARKET_READ_ROOTS = new Set([
  "quotes", "history", "macro", "heatmap", "screener", "sectors", "recap", "earnings-history",
]);

function isSafePath(parts: string[]): boolean {
  return parts.length > 0 && parts.length <= 4 && parts.every((part) =>
    part.length > 0 && part.length <= 80 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part),
  );
}

function portfolioPolicy(method: Method, path: string[]): ProxyPolicy | null {
  const validRead = method === "GET" && (
    path.length === 1 ||
    (path.length === 3 && path[2] === "transactions") ||
    (path.length === 3 && path[2] === "positions")
  );
  const validWrite = method === "POST" && (
    path.length === 1 || (path.length === 3 && path[2] === "transactions")
  );
  const validDelete = method === "DELETE" && (
    path.length === 2 || (path.length === 4 && path[2] === "transactions")
  );
  if (validRead) return { scope: "workspace:read", audience: "openterminal-research" };
  if (validWrite || validDelete) return { scope: "workspace:write", audience: "openterminal-research" };
  return null;
}

function researchPolicy(method: Method, path: string[]): ProxyPolicy | null {
  if (!isSafePath(path)) return null;
  if (path[0] === "portfolios") return portfolioPolicy(method, path);
  if (path.length === 2 && path[0] === "ai" && path[1] === "chat" && method === "POST") {
    return { scope: "research:ai", audience: "openterminal-research" };
  }
  if (method === "GET" && path.length === 1 && path[0] === "status") {
    return { scope: "research:read", audience: "openterminal-research" };
  }
  if (method === "GET" && RESEARCH_READ_ROOTS.has(path[0]) && path.length <= 2) {
    return {
      scope: MARKET_READ_ROOTS.has(path[0]) ? "market:read" : "research:read",
      audience: "openterminal-research",
    };
  }
  return null;
}

async function proxy(request: NextRequest, path: string[]): Promise<NextResponse> {
  const method = request.method.toUpperCase() as Method;
  const directMarket = method === "GET" && (
    (path.length === 1 && path[0] === "status") ||
    (path.length === 2 && ["history", "options"].includes(path[0]))
  );
  if (directMarket) {
    if (request.nextUrl.search.length > 4096) return NextResponse.json({ error: "query_too_large" }, { status: 414 });
    const auth = await authorizeBffRequest(request, "market:read", "eqoboard-gateway");
    if (!auth.ok) return auth.response;
    try {
      if (path.length === 1 && path[0] === "status") return NextResponse.json(await eqoStatus(auth.token));
      if (path.length === 2 && path[0] === "history") {
        return NextResponse.json(await eqoHistory(path[1], request.nextUrl.searchParams.get("range") ?? "6M", auth.token));
      }
      if (path.length === 2 && path[0] === "options") {
        return NextResponse.json(await eqoChain(path[1], request.nextUrl.searchParams.get("expiry") ?? undefined, auth.token));
      }
    } catch (error) {
      const status = error instanceof EqoUpstreamError ? error.status : 502;
      const message = error instanceof EqoUpstreamError ? error.message : "market_data_unavailable";
      return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
    }
  }

  const policy = researchPolicy(method, path);
  if (!policy) {
    const supported = ["GET", "POST", "DELETE"].includes(method);
    return NextResponse.json({ error: supported ? "route_not_available" : "method_not_allowed" }, { status: supported ? 404 : 405 });
  }
  if (request.nextUrl.search.length > 4096) return NextResponse.json({ error: "query_too_large" }, { status: 414 });

  const auth = await authorizeBffRequest(request, policy.scope, policy.audience);
  if (!auth.ok) return auth.response;

  let body: string | undefined;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const json = await readBoundedJson(request);
    if (!json.ok) return json.response;
    body = json.text;
  }

  const key = getResearchServiceKey();
  if (!key || key.length < 32) return NextResponse.json({ error: "research_service_unavailable" }, { status: 503 });
  const url = `${API_URL.replace(/\/+$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${auth.token}`,
    "x-api-key": key,
    "x-request-id": randomUUID(),
  });
  if (body !== undefined) headers.set("content-type", "application/json");

  try {
    const upstream = await fetch(url, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = await readLimitedResponse(upstream);
    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "research_service_unavailable" }, { status: 502 });
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
