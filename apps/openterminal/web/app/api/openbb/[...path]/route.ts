import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeResearchGatewayRequest } from "@/lib/eqo-auth";
import { readLimitedResponse } from "@/lib/http-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };
// OpenBB's configured source URL is /api/openbb and its manifest endpoints
// begin with openbb/v1. Preserve that URL contract, then map it to Gateway.
type MarketRoute = "openbb/v1/stocks" | "openbb/v1/bars" | "openbb/v1/options";
const MAX_QUERY_LENGTH = 4_096;
const SYMBOL = /^[A-Z.\-]{1,12}$/;
const TIMEFRAMES = new Set(["1Min", "5Min", "15Min", "1Hour", "1Day", "1Week", "1Month"]);

function error(status: number, name: string): NextResponse {
  return NextResponse.json({ error: name }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function gatewayBase(): URL | null {
  const raw = process.env.EQO_RUST_URL ?? "http://127.0.0.1:8080";
  try {
    const url = new URL(raw);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return new URL(url.origin);
  } catch {
    return null;
  }
}

function normalizedQuery(route: MarketRoute, request: NextRequest): URLSearchParams | null {
  const allowed = route === "openbb/v1/stocks"
    ? ["symbols"]
    : route === "openbb/v1/bars"
      ? ["symbol", "timeframe", "days", "limit"]
      : ["underlying", "expiration"];
  const query = request.nextUrl.searchParams;
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) return null;
  }

  const result = new URLSearchParams();
  if (route === "openbb/v1/stocks") {
    const raw = query.get("symbols");
    if (raw === null) return null;
    const symbols = raw.split(",").map((symbol) => symbol.trim().toUpperCase());
    if (symbols.length < 1 || symbols.length > 50 || symbols.some((symbol) => !SYMBOL.test(symbol))) return null;
    result.set("symbols", [...new Set(symbols)].join(","));
    return result;
  }

  if (route === "openbb/v1/bars") {
    const symbol = query.get("symbol")?.trim().toUpperCase();
    const timeframe = query.get("timeframe") ?? "1Day";
    const daysText = query.get("days") ?? "30";
    const limitText = query.get("limit") ?? "500";
    const days = Number(daysText);
    const limit = Number(limitText);
    if (!symbol || !SYMBOL.test(symbol) || !TIMEFRAMES.has(timeframe) ||
        !/^\d+$/.test(daysText) || !Number.isSafeInteger(days) || days < 1 || days > 11_000 ||
        !/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) return null;
    result.set("symbol", symbol);
    result.set("timeframe", timeframe);
    result.set("days", String(days));
    result.set("limit", String(limit));
    return result;
  }

  const underlying = query.get("underlying")?.trim().toUpperCase();
  const expiration = query.get("expiration");
  if (!underlying || !SYMBOL.test(underlying) || !expiration || !isIsoDate(expiration)) {
    return null;
  }
  result.set("underlying", underlying);
  result.set("expiration", expiration);
  return result;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function responseHeaders(response: Response): HeadersInit {
  return {
    "Content-Type": response.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-store",
  };
}

async function forwardMetadata(path: "widgets.json" | "apps.json", request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.search !== "") return error(400, "invalid_parameters");
  const base = gatewayBase();
  if (!base) return error(503, "market_gateway_unavailable");
  try {
    const upstream = await fetch(new URL(`/${path}`, base), {
      headers: { Accept: "application/json", "X-Request-ID": randomUUID() },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readLimitedResponse(upstream, 1_000_000);
    if (!upstream.ok) {
      return new NextResponse(body, { status: upstream.status, headers: responseHeaders(upstream) });
    }
    if (upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return error(502, "invalid_market_gateway_response");
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));
    if (path === "widgets.json") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return error(502, "invalid_market_gateway_response");
      }
    } else if (!Array.isArray(value)) {
      return error(502, "invalid_market_gateway_response");
    }
    return new NextResponse(body, { status: upstream.status, headers: responseHeaders(upstream) });
  } catch {
    return error(502, "market_gateway_unavailable");
  }
}

async function forwardMarket(route: MarketRoute, request: NextRequest): Promise<NextResponse> {
  const authorization = await authorizeResearchGatewayRequest(request);
  if (!authorization.ok) return authorization.response;
  if (request.nextUrl.search.length > MAX_QUERY_LENGTH) return error(414, "query_too_large");
  const query = normalizedQuery(route, request);
  if (!query) return error(400, "invalid_parameters");
  const base = gatewayBase();
  if (!base) return error(503, "market_gateway_unavailable");

  const upstreamUrl = new URL(`/${route}`, base);
  upstreamUrl.search = query.toString();
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authorization.token}`,
        "X-Request-ID": randomUUID(),
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readLimitedResponse(upstream);
    if (upstream.ok) {
      if (upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return error(502, "invalid_market_gateway_response");
      }
      const value: unknown = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));
      if (!Array.isArray(value) || value.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
        return error(502, "invalid_market_gateway_response");
      }
    }
    return new NextResponse(body, { status: upstream.status, headers: responseHeaders(upstream) });
  } catch {
    return error(502, "market_gateway_unavailable");
  }
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (process.env.EQO_BFF_MODE !== "research") return error(404, "route_not_available");
  const path = (await context.params).path.join("/");
  if (path === "widgets.json" || path === "apps.json") return forwardMetadata(path, request);
  if (path === "openbb/v1/stocks" || path === "openbb/v1/bars" || path === "openbb/v1/options") {
    return forwardMarket(path, request);
  }
  return error(404, "route_not_available");
}
