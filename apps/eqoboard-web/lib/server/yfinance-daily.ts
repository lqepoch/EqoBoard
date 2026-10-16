import "server-only";

import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";
import {
  expectedYfinanceResearchRequest,
  validateYfinanceResearchResponse,
  YFINANCE_RESEARCH_MAX_CURSOR_BYTES,
  YFINANCE_RESEARCH_MAX_RANGE_DAYS,
  type YfinanceResearchInput,
} from "@/features/research/yfinance-contract";
import { authorizeRequest, noStoreJson, signMdpResearchReadDelegation } from "./bff-security";
import { requireRuntimeMode } from "./runtime-mode";
import { consumePrincipalRateLimit, consumeServiceRateLimit } from "./rate-limit";
import { createUpstreamDeadline, mdpBaseUrl, readJsonResponseBounded } from "./service-http";
import { containsControlCharacters } from "./text-validation";
import type { ServerPrincipal } from "./auth";

const MAX_QUERY_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_DEADLINE_MS = 35_000;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const QUERY_KEYS = new Set([
  "symbols",
  "asset_class",
  "start_utc",
  "end_utc",
  "adjustment",
  "cursor",
]);

export type YfinanceDailyInputResult =
  | Readonly<{ ok: true; input: YfinanceResearchInput }>
  | Readonly<{ ok: false; status: number; error: string }>;

function parseTimestamp(value: string): bigint | null {
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const epoch = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString().slice(0, 19) !==
      `${year}-${month}-${day}T${hour}:${minute}:${second}`
  )
    return null;
  return BigInt(epoch) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function one(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  return values.length <= 1 ? (values[0] ?? null) : undefined;
}

/** Accept only the fixed one-symbol daily-observation request compiled by the host map. */
export function parseYfinanceDailyInput(request: Request): YfinanceDailyInputResult {
  const url = new URL(request.url);
  if (new TextEncoder().encode(url.search).byteLength > MAX_QUERY_BYTES) {
    return { ok: false, status: 414, error: "query_too_large" };
  }
  const params = url.searchParams;
  if (
    [...params.keys()].some((key) => !QUERY_KEYS.has(key)) ||
    [...QUERY_KEYS].some((key) => params.getAll(key).length > 1)
  ) {
    return { ok: false, status: 400, error: "invalid_query" };
  }
  const symbol = one(params, "symbols");
  const assetClass = one(params, "asset_class");
  const startUtc = one(params, "start_utc");
  const endUtc = one(params, "end_utc");
  const adjustment = one(params, "adjustment");
  const cursor = one(params, "cursor");
  if (!symbol || !assetClass || !startUtc || !endUtc || !adjustment || cursor === undefined) {
    return { ok: false, status: 400, error: "invalid_query" };
  }
  if (
    !SYMBOL.test(symbol) ||
    symbol.includes(",") ||
    (assetClass !== "stock" && assetClass !== "etf") ||
    (adjustment !== "unadjusted" && adjustment !== "adjusted")
  ) {
    return { ok: false, status: 422, error: "unsupported_research_query" };
  }

  const start = parseTimestamp(startUtc);
  const end = parseTimestamp(endUtc);
  const now = BigInt(Date.now()) * 1_000_000n;
  const maxRange = BigInt(YFINANCE_RESEARCH_MAX_RANGE_DAYS) * 86_400_000_000_000n;
  if (start === null || end === null || end <= start)
    return { ok: false, status: 400, error: "invalid_query" };
  if (start < 0n || end > now + 86_400_000_000_000n || end - start > maxRange) {
    return { ok: false, status: 413, error: "requested_range_exceeded" };
  }
  if (
    cursor !== null &&
    (new TextEncoder().encode(cursor).byteLength > YFINANCE_RESEARCH_MAX_CURSOR_BYTES ||
      cursor.length === 0 ||
      containsControlCharacters(cursor))
  ) {
    return { ok: false, status: 400, error: "invalid_query" };
  }
  return {
    ok: true,
    input: Object.freeze({
      symbol,
      assetClass,
      startUtc,
      endUtc,
      adjustment,
      ...(cursor === null ? {} : { cursor }),
    }),
  };
}

function limit(principal: ServerPrincipal): NextResponse | null {
  const service = consumeServiceRateLimit("yfinance-daily", 1_200, 60_000);
  if (!service.allowed)
    return noStoreJson({ error: "rate_limit_exceeded" }, 429, {
      "Retry-After": String(service.retryAfterSeconds),
    });
  const owner = consumePrincipalRateLimit(principal, {
    bucket: "yfinance-daily",
    maxRequests: 60,
    windowMs: 60_000,
  });
  return owner.allowed
    ? null
    : noStoreJson({ error: "rate_limit_exceeded" }, 429, {
        "Retry-After": String(owner.retryAfterSeconds),
      });
}

function upstreamError(status: number): NextResponse {
  if (status === 400 || status === 410 || status === 413 || status === 422) {
    return noStoreJson({ error: "research_query_rejected" }, status);
  }
  if (status === 401) return noStoreJson({ error: "market_data_authentication_required" }, 401);
  if (status === 403) return noStoreJson({ error: "research_market_data_access_denied" }, 403);
  if (status === 429) return noStoreJson({ error: "research_provider_rate_limited" }, 429);
  if (status >= 300 && status < 400)
    return noStoreJson({ error: "market_data_redirect_rejected" }, 502);
  if (status === 504) return noStoreJson({ error: "research_query_timeout" }, 504);
  if (status === 502) return noStoreJson({ error: "invalid_research_observation_response" }, 502);
  return noStoreJson({ error: "market_data_service_unavailable" }, 503);
}

function invalidEmptyGet(request: Request): boolean {
  if (request.body === null)
    return (
      request.headers.get("content-length") === null ||
      request.headers.get("content-length") === "0"
    );
  void request.body.cancel().catch(() => undefined);
  return false;
}

export async function getYfinanceDaily(request: Request): Promise<NextResponse> {
  const runtimeError = requireRuntimeMode("research", request);
  if (runtimeError) return runtimeError;
  const authorization = await authorizeRequest(request, "research:read");
  if (!authorization.ok) return authorization.response;
  if (
    !invalidEmptyGet(request) ||
    request.headers.has("content-encoding") ||
    request.headers.has("transfer-encoding")
  ) {
    return noStoreJson({ error: "invalid_request" }, 400);
  }
  const parsed = parseYfinanceDailyInput(request);
  if (!parsed.ok) return noStoreJson({ error: parsed.error }, parsed.status);
  const limited = limit(authorization.principal);
  if (limited) return limited;

  const base = mdpBaseUrl();
  if (!base) return noStoreJson({ error: "market_data_service_unavailable" }, 503);
  const delegation = await signMdpResearchReadDelegation(authorization.principal);
  if (!delegation.ok) return delegation.response;

  const expected = expectedYfinanceResearchRequest(parsed.input);
  const upstreamUrl = new URL("/v1/research/yfinance/daily", base);
  upstreamUrl.searchParams.set("symbols", parsed.input.symbol);
  upstreamUrl.searchParams.set("asset_class", parsed.input.assetClass);
  upstreamUrl.searchParams.set("start_utc", parsed.input.startUtc);
  upstreamUrl.searchParams.set("end_utc", parsed.input.endUtc);
  upstreamUrl.searchParams.set("adjustment", parsed.input.adjustment);
  if (parsed.input.cursor !== undefined)
    upstreamUrl.searchParams.set("cursor", parsed.input.cursor);

  const deadline = createUpstreamDeadline(
    request,
    Math.max(1, Math.min(UPSTREAM_DEADLINE_MS, delegation.expiresAt - Date.now())),
  );
  try {
    const upstream = await fetch(upstreamUrl, {
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
      const error = upstreamError(upstream.status);
      if (upstream.status === 429) {
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter && /^[0-9]{1,6}$/u.test(retryAfter))
          error.headers.set("Retry-After", retryAfter);
      }
      return deadline.timedOut() ? noStoreJson({ error: "research_query_timeout" }, 504) : error;
    }
    const body = await readJsonResponseBounded(upstream, MAX_RESPONSE_BYTES);
    if (deadline.timedOut()) return noStoreJson({ error: "research_query_timeout" }, 504);
    if (!body.ok) return noStoreJson({ error: "invalid_research_observation_response" }, 502);
    if (!validateYfinanceResearchResponse(body.value, expected)) {
      return noStoreJson({ error: "invalid_research_observation_response" }, 502);
    }
    // Use the shared JSON response path after full bounded contract validation.
    // Research provenance belongs to the payload, not the outer JSON encoding.
    return noStoreJson(body.value);
  } catch {
    return noStoreJson(
      { error: deadline.timedOut() ? "research_query_timeout" : "market_data_service_unavailable" },
      deadline.timedOut() ? 504 : 503,
    );
  } finally {
    deadline.close();
  }
}
