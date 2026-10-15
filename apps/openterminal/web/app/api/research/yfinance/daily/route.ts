import { NextRequest, NextResponse } from "next/server";
import { getYfinanceResearchDaily } from "@/lib/yfinance-research-bff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return getYfinanceResearchDaily(request);
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json({ error: "method_not_allowed" }, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store" },
  });
}

export function HEAD(): NextResponse {
  return methodNotAllowed();
}

export function OPTIONS(): NextResponse {
  return methodNotAllowed();
}
