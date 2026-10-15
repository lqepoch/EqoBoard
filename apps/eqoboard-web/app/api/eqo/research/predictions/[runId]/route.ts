import { NextResponse, type NextRequest } from "next/server";
import { proxyRegisteredPrediction } from "@/lib/server/quant-predictions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Readonly<{ params: Promise<{ runId: string }> }>;

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { runId } = await context.params;
  return proxyRegisteredPrediction(request, runId);
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: "method_not_allowed" },
    {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  );
}

export function HEAD(): NextResponse {
  return methodNotAllowed();
}

export function OPTIONS(): NextResponse {
  return methodNotAllowed();
}
