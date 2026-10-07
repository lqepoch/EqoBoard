import { NextResponse } from "next/server";
import { isAuthRuntimeConfigured } from "@/auth";

export const dynamic = "force-dynamic";

export function GET() {
  const identityConfigured = isAuthRuntimeConfigured();
  return NextResponse.json({
    ready: identityConfigured,
    identity_configured: identityConfigured,
    execution_enabled: false,
  }, {
    status: identityConfigured ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
