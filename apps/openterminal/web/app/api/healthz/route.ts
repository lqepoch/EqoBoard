import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: process.env.EQO_BFF_MODE === "research" ? "eqoboard-research-bff" : "openterminal-web",
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
