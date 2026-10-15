import { NextRequest, NextResponse } from "next/server";
import { authorizeGatewayRequest, noStoreJson } from "@/lib/server/bff-security";
import { fetchGateway, relayGatewayJson } from "@/lib/server/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authorization = await authorizeGatewayRequest(request, "market:read");
  if (!authorization.ok) return authorization.response;
  const upstream = await fetchGateway(request, "/api/v1/status", { token: authorization.token });
  if (!upstream.ok) return noStoreJson({ error: upstream.error }, upstream.error === "gateway_timeout" ? 504 : 503);
  return relayGatewayJson(upstream.response);
}
