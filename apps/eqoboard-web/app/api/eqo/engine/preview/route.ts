import { NextResponse, type NextRequest } from "next/server";
import { proxyEngineRead } from "@/lib/server/engine-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return proxyEngineRead(request, "preview");
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
