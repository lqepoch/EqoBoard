import { NextResponse, type NextRequest } from "next/server";
import { requireRuntimeMode } from "@/lib/server/runtime-mode";
import { getYfinanceDaily } from "@/lib/server/yfinance-daily";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return getYfinanceDaily(request);
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json({ error: "method_not_allowed" }, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function researchModeNotAllowed(request: Request): NextResponse {
  return requireRuntimeMode("research", request) ?? methodNotAllowed();
}

export function POST(request: Request): NextResponse {
  return researchModeNotAllowed(request);
}

export function PUT(request: Request): NextResponse {
  return researchModeNotAllowed(request);
}

export function PATCH(request: Request): NextResponse {
  return researchModeNotAllowed(request);
}

export function DELETE(request: Request): NextResponse {
  return researchModeNotAllowed(request);
}

export function HEAD(request: Request): NextResponse {
  return researchModeNotAllowed(request);
}

export function OPTIONS(request: Request): NextResponse {
  return researchModeNotAllowed(request);
}
