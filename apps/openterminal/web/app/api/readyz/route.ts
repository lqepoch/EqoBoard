import { NextResponse } from "next/server";
import { isCurrentRuntimeReady } from "@/auth";

export const dynamic = "force-dynamic";

export function GET() {
  const identityConfigured = isCurrentRuntimeReady();
  return NextResponse.json({
    ready: identityConfigured,
    identity_configured: identityConfigured,
    runtime_mode: process.env.EQO_BFF_MODE === "research" ? "research" : "terminal",
    execution_enabled: false,
  }, {
    status: identityConfigured ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
