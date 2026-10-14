import { NextRequest, NextResponse } from "next/server";
import { getMarketBars } from "@/lib/market-bars-bff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ symbol: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { symbol } = await context.params;
  return getMarketBars(request, symbol);
}

export function HEAD(): NextResponse {
  return NextResponse.json({ error: "method_not_allowed" }, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}

export function OPTIONS(): NextResponse {
  return NextResponse.json({ error: "method_not_allowed" }, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}
