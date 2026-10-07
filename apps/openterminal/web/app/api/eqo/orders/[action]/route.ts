import { NextRequest, NextResponse } from "next/server";
import { authorizeBffRequest, handleBffOptions, readBoundedJson, researchModeRouteUnavailable } from "@/lib/eqo-auth";
import { readLimitedResponse } from "@/lib/http-response";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ action: string }> };

export async function GET() {
  const unavailable = researchModeRouteUnavailable();
  if (unavailable) return unavailable;
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
}

export async function POST(req: NextRequest, context: RouteContext) {
  const unavailable = researchModeRouteUnavailable();
  if (unavailable) return unavailable;
  const { action } = await context.params;
  if (action !== "preview" && action !== "submit") {
    return NextResponse.json({ error: "route_not_available" }, { status: 404 });
  }

  const auth = action === "preview"
    ? await authorizeBffRequest(req, "orders:preview", "eqoboard-gateway")
    : await authorizeBffRequest(req, "paper:submit", "eqoboard-gateway");
  if (!auth.ok) return auth.response;

  if (action === "submit") {
    return NextResponse.json({
      state: "blocked",
      retryable: false,
      recovery_required: false,
      detail: "Paper execution is disabled until persistent preview, outbox, and account-binding gates are complete.",
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }

  const parsed = await readBoundedJson(req);
  if (!parsed.ok) return parsed.response;
  const base = (process.env.EQO_RUST_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  try {
    const upstream = await fetch(`${base}/api/v1/orders/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
      body: parsed.text,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = await readLimitedResponse(upstream);
    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "order_preview_unavailable" }, { status: 502 });
  }
}

export function OPTIONS() {
  return handleBffOptions("GET, HEAD, OPTIONS, POST");
}
