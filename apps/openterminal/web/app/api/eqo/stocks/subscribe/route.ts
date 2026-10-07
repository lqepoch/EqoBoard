import { NextRequest, NextResponse } from "next/server";
import { authorizeBffRequest, handleBffOptions, readBoundedJson, researchModeRouteUnavailable } from "@/lib/eqo-auth";

export const runtime = "nodejs";

export async function GET() {
  const unavailable = researchModeRouteUnavailable();
  if (unavailable) return unavailable;
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
}

export async function POST(req: NextRequest) {
  const unavailable = researchModeRouteUnavailable();
  if (unavailable) return unavailable;
  const auth = await authorizeBffRequest(req, "market:subscribe", "eqoboard-gateway");
  if (!auth.ok) return auth.response;
  const parsed = await readBoundedJson(req);
  if (!parsed.ok) return parsed.response;
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return NextResponse.json({ error: "invalid_subscription" }, { status: 400 });
  }

  const args = parsed.value as { consumer_id?: unknown; generation?: unknown; symbols?: unknown };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ticker = /^[A-Z][A-Z0-9.-]{0,11}$/;
  if (
    typeof args.consumer_id !== "string" || !uuid.test(args.consumer_id) ||
    (args.generation !== undefined && (!Number.isSafeInteger(args.generation) || Number(args.generation) < 0)) ||
    !Array.isArray(args.symbols) || args.symbols.length > 1000 ||
    !args.symbols.every((symbol) => typeof symbol === "string" && ticker.test(symbol))
  ) {
    return NextResponse.json({ error: "invalid_subscription" }, { status: 400 });
  }

  const base = (process.env.EQO_RUST_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/api/v1/subscriptions/stocks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
      cache: "no-store",
      redirect: "manual",
      body: JSON.stringify({
        consumer_id: args.consumer_id,
        ...(args.generation === undefined ? {} : { generation: args.generation }),
        symbols: args.symbols,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await response.json().catch(() => ({ error: "invalid_gateway_response" }));
    return NextResponse.json(data, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "market_subscription_unavailable" }, { status: 502 });
  }
}

export function OPTIONS() {
  return handleBffOptions("GET, HEAD, OPTIONS, POST");
}
