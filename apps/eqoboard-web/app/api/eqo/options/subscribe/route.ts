import { NextRequest, NextResponse } from "next/server";
import { noStoreJson } from "@/lib/server/bff-security";
import { postGatewayJson, hasExactKeys, isRecord, OCC_PATTERN, UUID_PATTERN } from "@/lib/server/market-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseBody(value: unknown): Readonly<{ ok: true; body: unknown }> | Readonly<{ ok: false; error: string }> {
  if (!isRecord(value) || !hasExactKeys(value, ["consumer_id", "generation", "symbols"]) ||
      typeof value.consumer_id !== "string" || !UUID_PATTERN.test(value.consumer_id) ||
      typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation <= 0 ||
      !Array.isArray(value.symbols) || value.symbols.length < 1 || value.symbols.length > 1000 ||
      !value.symbols.every((item) => typeof item === "string" && OCC_PATTERN.test(item)) ||
      new Set(value.symbols as string[]).size !== value.symbols.length) {
    return { ok: false, error: "invalid_subscription" };
  }
  return { ok: true, body: { consumer_id: value.consumer_id, generation: value.generation, symbols: value.symbols } };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return postGatewayJson(request, "market:subscribe", "/api/v1/subscriptions/options", parseBody);
}

export function GET(): NextResponse {
  return noStoreJson({ error: "method_not_allowed" }, 405, { Allow: "POST" });
}
