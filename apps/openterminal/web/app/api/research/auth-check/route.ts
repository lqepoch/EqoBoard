import { NextResponse } from "next/server";
import { authorizeResearchSession } from "@/lib/eqo-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (process.env.EQO_BFF_MODE !== "research") {
    return NextResponse.json({ error: "route_not_available" }, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return authorizeResearchSession();
}
