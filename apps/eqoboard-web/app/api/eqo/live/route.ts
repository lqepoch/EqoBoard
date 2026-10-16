import type { NextResponse, NextRequest } from "next/server";
import { authorizeRequest, noStoreJson, signGatewayDelegation } from "@/lib/server/bff-security";
import { gatewayUrl } from "@/lib/server/gateway";
import { consumePrincipalRateLimit, consumeServiceRateLimit } from "@/lib/server/rate-limit";
import { acquireLiveStreamSlot } from "@/lib/server/stream-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONNECT_DEADLINE_MS = 5_000;

function invalidRequest(request: Request): boolean {
  if (
    new URL(request.url).search ||
    request.headers.has("content-encoding") ||
    request.headers.has("transfer-encoding")
  )
    return true;
  if (request.body !== null) {
    void request.body.cancel().catch(() => undefined);
    return true;
  }
  return false;
}

function errorResponse(error: string, status: number): NextResponse {
  return noStoreJson({ error }, status);
}

export async function GET(request: NextRequest): Promise<Response> {
  const authorization = await authorizeRequest(request, "market:stream");
  if (!authorization.ok) return authorization.response;
  if (invalidRequest(request)) return errorResponse("invalid_request", 400);
  const perPrincipal = consumePrincipalRateLimit(authorization.principal, {
    bucket: "market:live:connect",
    maxRequests: 20,
    windowMs: 60_000,
  });
  const service = consumeServiceRateLimit("market:live:connect", 600, 60_000);
  if (!perPrincipal.allowed || !service.allowed) {
    const retry = Math.max(perPrincipal.retryAfterSeconds, service.retryAfterSeconds);
    return noStoreJson({ error: "rate_limit_exceeded" }, 429, { "Retry-After": String(retry) });
  }
  const releaseSlot = acquireLiveStreamSlot(authorization.principal);
  if (!releaseSlot) return errorResponse("stream_capacity_exceeded", 429);
  const upstreamUrl = gatewayUrl("/api/v1/stream/sse");
  if (!upstreamUrl) {
    releaseSlot();
    return errorResponse("gateway_unavailable", 503);
  }
  const delegation = await signGatewayDelegation(authorization.principal, "market:stream");
  if (!delegation.ok) {
    releaseSlot();
    return delegation.response;
  }

  const controller = new AbortController();
  let connectTimedOut = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let authorizationTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  const onClientAbort = () => controller.abort(request.signal.reason);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (connectTimer) clearTimeout(connectTimer);
    if (authorizationTimer) clearTimeout(authorizationTimer);
    request.signal.removeEventListener("abort", onClientAbort);
    controller.signal.removeEventListener("abort", cleanup);
    releaseSlot();
  };
  if (request.signal.aborted) controller.abort(request.signal.reason);
  else request.signal.addEventListener("abort", onClientAbort, { once: true });
  controller.signal.addEventListener("abort", cleanup, { once: true });
  connectTimer = setTimeout(() => {
    connectTimedOut = true;
    controller.abort(new Error("gateway_connect_timeout"));
  }, CONNECT_DEADLINE_MS);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: { accept: "text/event-stream", authorization: `Bearer ${delegation.token}` },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      cleanup();
      return errorResponse("gateway_redirect_rejected", 502);
    }
    const contentType = upstream.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (upstream.status !== 200 || contentType !== "text/event-stream" || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      cleanup();
      return errorResponse(
        upstream.status >= 500 ? "market_stream_unavailable" : "invalid_market_stream_response",
        upstream.status >= 500 ? 503 : 502,
      );
    }

    const expiresAt = Math.min(authorization.principal.sessionExpiresAt, delegation.expiresAt);
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      await upstream.body.cancel().catch(() => undefined);
      cleanup();
      return errorResponse("unauthenticated", 401);
    }
    authorizationTimer = setTimeout(
      () => controller.abort(new Error("authorization_expired")),
      remainingMs,
    );

    const reader = upstream.body.getReader();
    const authorizedStream = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const item = await reader.read();
          if (item.done) {
            cleanup();
            streamController.close();
          } else {
            streamController.enqueue(item.value);
          }
        } catch {
          cleanup();
          streamController.close();
        }
      },
      async cancel(reason) {
        cleanup();
        controller.abort(reason);
        await reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(authorizedStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    cleanup();
    return errorResponse(
      connectTimedOut ? "gateway_timeout" : "market_stream_unavailable",
      connectTimedOut ? 504 : 503,
    );
  }
}

export function HEAD(): NextResponse {
  return noStoreJson({ error: "method_not_allowed" }, 405, { Allow: "GET" });
}

export function OPTIONS(): NextResponse {
  return noStoreJson({ error: "method_not_allowed" }, 405, { Allow: "GET" });
}
