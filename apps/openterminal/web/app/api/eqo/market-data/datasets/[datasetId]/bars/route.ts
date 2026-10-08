import { NextRequest, NextResponse } from "next/server";
import { proxyMdpBars } from "@/lib/mdp-market-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ datasetId: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { datasetId } = await context.params;
  return proxyMdpBars(request, datasetId);
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
