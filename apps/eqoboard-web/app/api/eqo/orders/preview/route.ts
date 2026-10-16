import { type NextRequest, NextResponse } from "next/server";
import { authorizeGatewayRequest, noStoreJson, readBoundedJson } from "@/lib/server/bff-security";
import { fetchGateway, readBoundedResponse } from "@/lib/server/gateway";
import { copyBytesToArrayBuffer } from "@/lib/server/http-body";
import { isOrderPreviewResponse, parseVerticalPreviewIntent } from "@/lib/server/order-intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authorization = await authorizeGatewayRequest(request, "orders:preview");
  if (!authorization.ok) return authorization.response;
  const bounded = await readBoundedJson(request, 8 * 1024);
  if (!bounded.ok) return bounded.response;
  const intent = parseVerticalPreviewIntent(bounded.value);
  if (!intent.ok) return noStoreJson({ error: intent.error }, 400);

  const upstream = await fetchGateway(request, "/api/v1/orders/preview", {
    method: "POST",
    token: authorization.token,
    body: JSON.stringify(intent.value),
    timeoutMs: 15_000,
  });
  if (!upstream.ok) {
    return noStoreJson({ error: upstream.error }, upstream.error === "gateway_timeout" ? 504 : 503);
  }
  const contentType = upstream.response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    await upstream.response.body?.cancel().catch(() => undefined);
    return noStoreJson({ error: "invalid_gateway_response" }, 502);
  }
  const responseBody = await readBoundedResponse(upstream.response, 64 * 1024);
  if (!responseBody.ok) return noStoreJson({ error: "invalid_gateway_response" }, 502);
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(responseBody.bytes),
    ) as unknown;
  } catch {
    return noStoreJson({ error: "invalid_gateway_response" }, 502);
  }
  if (
    upstream.response.status >= 200 &&
    upstream.response.status < 300 &&
    !isOrderPreviewResponse(value, intent.value)
  ) {
    return noStoreJson({ error: "invalid_gateway_response" }, 502);
  }
  return new NextResponse(copyBytesToArrayBuffer(responseBody.bytes), {
    status: upstream.response.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
