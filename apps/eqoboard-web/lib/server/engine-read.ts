import "server-only";

import { randomUUID } from "node:crypto";
import {
  parseEngineStatusResponseV1ProtoJsonText,
  parseSyntheticOfflinePreviewV1ProtoJsonText,
  type EngineStatusResponseV1,
  type SyntheticOfflinePreviewV1,
} from "@lqepoch/trading-core-contracts";
import { NextResponse } from "next/server";
import { authorizeRequest, noStoreJson, signEngineOfflineReadDelegation } from "./bff-security";
import { consumePrincipalRateLimit } from "./rate-limit";
import { createUpstreamDeadline, engineBaseUrl, readJsonResponseBounded } from "./service-http";
import type { ServerPrincipal } from "./auth";

const MAX_RESPONSE_BYTES = 16 * 1024;
const UPSTREAM_DEADLINE_MS = 3_000;

export type EngineReadResource = "status" | "preview";
type EngineReadMessage = EngineStatusResponseV1 | SyntheticOfflinePreviewV1;

function rateLimit(principal: ServerPrincipal): NextResponse | null {
  const result = consumePrincipalRateLimit(principal, {
    bucket: "engine-offline-read",
    maxRequests: 60,
    windowMs: 60_000,
  });
  return result.allowed
    ? null
    : noStoreJson({ error: "rate_limit_exceeded" }, 429, {
        "Retry-After": String(result.retryAfterSeconds),
      });
}

function emptyRequest(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && contentLength !== "0") return false;
  if (request.body === null) return true;
  void request.body.cancel().catch(() => undefined);
  return false;
}

function parseCoreMessage(value: unknown, resource: EngineReadResource): EngineReadMessage | null {
  try {
    const text = JSON.stringify(value);
    return resource === "status"
      ? parseEngineStatusResponseV1ProtoJsonText(text)
      : parseSyntheticOfflinePreviewV1ProtoJsonText(text);
  } catch {
    return null;
  }
}

export async function proxyEngineRead(
  request: Request,
  resource: EngineReadResource,
): Promise<NextResponse> {
  const authorization = await authorizeRequest(request, "engine:offline-read");
  if (!authorization.ok) return authorization.response;
  if (new URL(request.url).search !== "" || !emptyRequest(request)) {
    return noStoreJson({ error: "invalid_request" }, 400);
  }
  const limited = rateLimit(authorization.principal);
  if (limited) return limited;
  const delegation = await signEngineOfflineReadDelegation(authorization.principal);
  if (!delegation.ok) return delegation.response;
  const base = engineBaseUrl();
  if (!base) return noStoreJson({ error: "engine_service_unavailable" }, 503);

  const timeoutMs = Math.max(1, Math.min(UPSTREAM_DEADLINE_MS, delegation.expiresAt - Date.now()));
  const deadline = createUpstreamDeadline(request, timeoutMs);
  try {
    const upstream = await fetch(new URL(`/v1/${resource}`, base), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${delegation.token}`,
        "x-request-id": randomUUID(),
      },
      cache: "no-store",
      redirect: "manual",
      signal: deadline.signal,
    });
    if (upstream.status !== 200) {
      await upstream.body?.cancel().catch(() => undefined);
      return deadline.timedOut() || upstream.status === 504
        ? noStoreJson({ error: "engine_query_timeout" }, 504)
        : noStoreJson({ error: "engine_service_unavailable" }, 503);
    }
    const body = await readJsonResponseBounded(upstream, MAX_RESPONSE_BYTES);
    if (deadline.timedOut()) return noStoreJson({ error: "engine_query_timeout" }, 504);
    if (!body.ok) return noStoreJson({ error: "invalid_engine_response" }, 502);
    const message = parseCoreMessage(body.value, resource);
    if (!message) return noStoreJson({ error: "invalid_engine_response" }, 502);
    const bytes = Buffer.from(JSON.stringify(message), "utf8");
    if (bytes.byteLength > MAX_RESPONSE_BYTES)
      return noStoreJson({ error: "invalid_engine_response" }, 502);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return noStoreJson(
      { error: deadline.timedOut() ? "engine_query_timeout" : "engine_service_unavailable" },
      deadline.timedOut() ? 504 : 503,
    );
  } finally {
    deadline.close();
  }
}
