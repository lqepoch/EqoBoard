import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  authorizeRequest,
  noStoreJson,
  signGatewayDelegation,
  signMdpMarketReadDelegation,
} from "@/lib/server/bff-security";
import {
  coreBarsRateLimit,
  CORE_BARS_LIMIT,
  parseCoreBarsPageRequest,
  parseCoreBarsResponse,
} from "@/lib/server/core-bars";
import {
  mdpBaseUrl,
  createUpstreamDeadline,
  readJsonResponseBounded,
} from "@/lib/server/service-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_DEADLINE_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type RouteContext = Readonly<{ params: Promise<{ symbol: string }> }>;

function invalidRequest(request: Request): boolean {
  if (request.headers.has("content-encoding") || request.headers.has("transfer-encoding"))
    return true;
  if (request.body !== null) {
    void request.body.cancel().catch(() => undefined);
    return true;
  }
  return false;
}

function upstreamStatus(status: number): NextResponse {
  if (status === 401) return noStoreJson({ error: "market_data_authentication_required" }, 401);
  if (status === 403) return noStoreJson({ error: "market_data_access_denied" }, 403);
  if (status === 404 || status === 405 || status === 501)
    return noStoreJson({ error: "market_data_endpoint_unsupported" }, 501);
  if (status === 409) return noStoreJson({ error: "market_data_conflict" }, 409);
  if (status === 413) return noStoreJson({ error: "result_limit_exceeded" }, 413);
  if (status === 422) return noStoreJson({ error: "market_data_query_rejected" }, 422);
  if (status === 429) return noStoreJson({ error: "market_data_rate_limited" }, 429);
  if (status === 504) return noStoreJson({ error: "market_data_query_timeout" }, 504);
  return noStoreJson({ error: "market_data_service_unavailable" }, 503);
}

function coverageMatchesStatus(value: unknown, status: number): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const coverage = (value as Record<string, unknown>).coverage_status;
  if (status === 200) return coverage === "complete" || coverage === "empty";
  if (status === 206) return coverage === "partial" || coverage === "unknown";
  return status === 422 && coverage === "unsupported";
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const authorization = await authorizeRequest(request, "market:read");
  if (!authorization.ok) return authorization.response;
  if (invalidRequest(request)) return noStoreJson({ error: "invalid_request" }, 400);

  const { symbol } = await context.params;
  const parsed = parseCoreBarsPageRequest(request, symbol);
  if (!parsed.ok) return noStoreJson({ error: parsed.error }, parsed.status);
  if (!coreBarsRateLimit(authorization.principal)) {
    return noStoreJson({ error: "rate_limit_exceeded" }, 429, { "Retry-After": "60" });
  }

  const base = mdpBaseUrl();
  if (!base) return noStoreJson({ error: "market_data_service_unavailable" }, 503);
  const mdpAuthorization = await signMdpMarketReadDelegation(authorization.principal);
  if (!mdpAuthorization.ok) return mdpAuthorization.response;
  let gatewayAuthorization: Awaited<ReturnType<typeof signGatewayDelegation>> | null = null;
  if (parsed.providerMode === "auto" || parsed.providerMode === "futu_only") {
    gatewayAuthorization = await signGatewayDelegation(authorization.principal, "market:read");
    if (!gatewayAuthorization.ok) return gatewayAuthorization.response;
  }

  const upstreamUrl = new URL("/v1/market/bars", base);
  upstreamUrl.searchParams.set("symbol", parsed.symbol);
  upstreamUrl.searchParams.set("asset_class", parsed.assetClass);
  upstreamUrl.searchParams.set("start", parsed.requestStart);
  upstreamUrl.searchParams.set("end", parsed.requestEnd);
  upstreamUrl.searchParams.set("resolution", parsed.resolution);
  upstreamUrl.searchParams.set("session_scope", parsed.sessionScope);
  upstreamUrl.searchParams.set("adjustment", parsed.adjustment);
  upstreamUrl.searchParams.set("provider_mode", parsed.providerMode);
  upstreamUrl.searchParams.set("allow_daily_downgrade", String(parsed.allowDailyDowngrade));
  upstreamUrl.searchParams.set("limit", String(CORE_BARS_LIMIT));
  if (parsed.cursor !== null) upstreamUrl.searchParams.set("cursor", parsed.cursor);

  const expiresAt = Math.min(
    mdpAuthorization.expiresAt,
    gatewayAuthorization?.ok ? gatewayAuthorization.expiresAt : Number.POSITIVE_INFINITY,
  );
  const deadline = createUpstreamDeadline(
    request,
    Math.max(1, Math.min(UPSTREAM_DEADLINE_MS, expiresAt - Date.now())),
  );
  try {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${mdpAuthorization.token}`,
      "x-request-id": randomUUID(),
    });
    if (gatewayAuthorization?.ok)
      headers.set("X-Eqo-Gateway-Delegation", gatewayAuthorization.token);
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: deadline.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      return noStoreJson({ error: "market_data_redirect_rejected" }, 502);
    }
    if (![200, 206, 422].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => undefined);
      return deadline.timedOut()
        ? noStoreJson({ error: "market_data_query_timeout" }, 504)
        : upstreamStatus(upstream.status);
    }

    const body = await readJsonResponseBounded(upstream, MAX_RESPONSE_BYTES);
    if (deadline.timedOut()) return noStoreJson({ error: "market_data_query_timeout" }, 504);
    if (!body.ok) return noStoreJson({ error: "invalid_market_data_response" }, 502);
    const requestContract = {
      symbol: parsed.symbol,
      range: parsed.range,
      resolution: parsed.resolution,
      assetClass: parsed.assetClass,
      sessionScope: parsed.sessionScope,
      adjustment: parsed.adjustment,
      providerMode: parsed.providerMode,
      allowDailyDowngrade: parsed.allowDailyDowngrade,
      requestStart: parsed.requestStart,
      requestEnd: parsed.requestEnd,
      cursor: parsed.cursor,
    };
    if (
      !parseCoreBarsResponse(body.value, requestContract) ||
      !coverageMatchesStatus(body.value, upstream.status)
    ) {
      return noStoreJson({ error: "invalid_market_data_response" }, 502);
    }

    const envelope = {
      kind: "eqoboard.core-bars-page.v1",
      request: {
        symbol: requestContract.symbol,
        range: requestContract.range,
        resolution: requestContract.resolution,
        asset_class: requestContract.assetClass,
        session_scope: requestContract.sessionScope,
        adjustment: requestContract.adjustment,
        provider_mode: requestContract.providerMode,
        allow_daily_downgrade: requestContract.allowDailyDowngrade,
        request_start: requestContract.requestStart,
        request_end: requestContract.requestEnd,
        cursor: requestContract.cursor,
      },
      response: body.value,
    };
    return NextResponse.json(envelope, {
      status: upstream.status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return noStoreJson(
      {
        error: deadline.timedOut()
          ? "market_data_query_timeout"
          : "market_data_service_unavailable",
      },
      deadline.timedOut() ? 504 : 503,
    );
  } finally {
    deadline.close();
  }
}

export function HEAD(): NextResponse {
  return noStoreJson({ error: "method_not_allowed" }, 405, { Allow: "GET" });
}

export function OPTIONS(): NextResponse {
  return noStoreJson({ error: "method_not_allowed" }, 405, { Allow: "GET" });
}
