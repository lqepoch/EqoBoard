import { NextRequest, NextResponse } from "next/server";
import { authorizeGatewayRequest, noStoreJson } from "@/lib/server/bff-security";
import { fetchGateway, relayGatewayJson } from "@/lib/server/gateway";
import { TICKER_PATTERN } from "@/lib/server/market-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ symbol: string }> };

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const authorization = await authorizeGatewayRequest(request, "market:read");
  if (!authorization.ok) return authorization.response;
  const { symbol: rawSymbol } = await context.params;
  const symbol = rawSymbol.toUpperCase();
  const params = request.nextUrl.searchParams;
  if (request.nextUrl.search.length > 256 || [...params.keys()].some((key) => key !== "expiry") ||
      !TICKER_PATTERN.test(symbol) || params.getAll("expiry").length !== 1 || !validDate(params.get("expiry") ?? "")) {
    return noStoreJson({ error: "invalid_options_query" }, 400);
  }
  const upstream = await fetchGateway(request, "/api/v1/options/chain", {
    token: authorization.token,
    query: { underlying: symbol, expiration: params.get("expiry") as string },
  });
  if (!upstream.ok) return noStoreJson({ error: upstream.error }, upstream.error === "gateway_timeout" ? 504 : 503);
  return relayGatewayJson(upstream.response);
}
