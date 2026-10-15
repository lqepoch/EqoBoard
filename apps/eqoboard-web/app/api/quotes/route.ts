import type { NextRequest, NextResponse } from "next/server";
import { authorizeGatewayRequest, noStoreJson } from "@/lib/server/bff-security";
import { fetchGateway, relayGatewayJson } from "@/lib/server/gateway";
import { TICKER_PATTERN } from "@/lib/server/market-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseSymbols(request: NextRequest): string[] | null {
  if (
    request.nextUrl.search.length > 2_048 ||
    [...request.nextUrl.searchParams.keys()].some((key) => key !== "symbols")
  )
    return null;
  const values = request.nextUrl.searchParams.getAll("symbols");
  if (values.length !== 1) return null;
  const symbols = values[0].split(",");
  if (
    symbols.length < 1 ||
    symbols.length > 50 ||
    symbols.some((symbol) => !TICKER_PATTERN.test(symbol)) ||
    new Set(symbols).size !== symbols.length
  )
    return null;
  return symbols;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authorization = await authorizeGatewayRequest(request, "market:read");
  if (!authorization.ok) return authorization.response;
  const symbols = parseSymbols(request);
  if (!symbols) return noStoreJson({ error: "invalid_symbols" }, 400);
  const upstream = await fetchGateway(request, "/api/v1/stocks/snapshots", {
    token: authorization.token,
    query: { symbols: symbols.join(",") },
  });
  if (!upstream.ok)
    return noStoreJson({ error: upstream.error }, upstream.error === "gateway_timeout" ? 504 : 503);
  return relayGatewayJson(upstream.response);
}
