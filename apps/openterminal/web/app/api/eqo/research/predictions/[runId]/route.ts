import { NextRequest, NextResponse } from "next/server";
import { proxyRegisteredPrediction } from "@/lib/quant-predictions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { runId } = await context.params;
  return proxyRegisteredPrediction(request, runId);
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
