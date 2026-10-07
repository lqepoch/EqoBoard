import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok", service: "openterminal-web" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
