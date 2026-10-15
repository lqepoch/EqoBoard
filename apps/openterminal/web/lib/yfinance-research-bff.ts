import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeMdpMarketDataRequest } from "@/lib/eqo-auth";
import { readLimitedResponse } from "@/lib/http-response";
import { mdpBaseUrl } from "@/lib/mdp-market-data";
import {
  YFINANCE_RESEARCH_MAX_CURSOR_BYTES,
  YFINANCE_RESEARCH_MAX_RANGE_DAYS,
  validateYfinanceResearchResponse,
  type ExpectedYfinanceResearchRequest,
  type YfinanceResearchAdjustment,
  type YfinanceResearchAssetClass,
} from "@/lib/yfinance-research-contract";

const MAX_QUERY_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_DEADLINE_MS = 35_000;
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,31}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|\+00:00)$/;
const DAY_MS = 86_400_000;
const ALLOWED_QUERY_KEYS = new Set(["symbols", "asset_class", "start_utc", "end_utc", "adjustment", "cursor"]);

type ParsedYfinanceRequest = ExpectedYfinanceResearchRequest;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function singleParam(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  return values.length <= 1 ? values[0] ?? null : undefined;
}

function parseUtc(value: string): { epochNanoseconds: bigint; normalized: string } | null {
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const epoch = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(epoch) ||
      new Date(epoch).toISOString().slice(0, 19) !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) return null;
  const normalizedFraction = fraction.replace(/0+$/, "");
  return {
    epochNanoseconds: BigInt(epoch) * 1_000_000n + BigInt(fraction.padEnd(9, "0") || "0"),
    normalized: `${year}-${month}-${day}T${hour}:${minute}:${second}${normalizedFraction ? `.${normalizedFraction}` : ""}Z`,
  };
}

function validCursor(value: string): boolean {
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength > 0 && bytes.byteLength <= YFINANCE_RESEARCH_MAX_CURSOR_BYTES &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    });
}

function parseQuery(request: NextRequest): ParsedYfinanceRequest | NextResponse {
  const params = request.nextUrl.searchParams;
  if (new TextEncoder().encode(request.nextUrl.search).byteLength > MAX_QUERY_LENGTH ||
      [...params.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key)) ||
      [...ALLOWED_QUERY_KEYS].some((key) => params.getAll(key).length > 1)) {
    return jsonError(400, "invalid_query");
  }

  const rawSymbols = singleParam(params, "symbols");
  const rawAssetClass = singleParam(params, "asset_class");
  const startUtc = singleParam(params, "start_utc");
  const endUtc = singleParam(params, "end_utc");
  const rawAdjustment = singleParam(params, "adjustment");
  const cursor = singleParam(params, "cursor");
  if (rawSymbols === null || rawSymbols === undefined || rawAssetClass === null || rawAssetClass === undefined ||
      startUtc === null || startUtc === undefined || endUtc === null || endUtc === undefined ||
      rawAdjustment === null || rawAdjustment === undefined || cursor === undefined) {
    return jsonError(400, "invalid_query");
  }

  const symbols = rawSymbols.split(",");
  if (symbols.length < 1 || symbols.length > 8 || symbols.some((symbol) => !SYMBOL.test(symbol)) ||
      new Set(symbols).size !== symbols.length ||
      (cursor !== null && !validCursor(cursor))) {
    return jsonError(400, "invalid_query");
  }
  if ((rawAssetClass !== "stock" && rawAssetClass !== "etf") ||
      (rawAdjustment !== "unadjusted" && rawAdjustment !== "adjusted")) {
    return jsonError(422, "unsupported_research_query");
  }

  const start = parseUtc(startUtc);
  const end = parseUtc(endUtc);
  const earliest = BigInt(Date.parse("1970-01-01T00:00:00Z")) * 1_000_000n;
  const latestAllowed = BigInt(Date.now() + DAY_MS) * 1_000_000n;
  const maxRangeNanoseconds = BigInt(YFINANCE_RESEARCH_MAX_RANGE_DAYS * DAY_MS) * 1_000_000n;
  if (start === null || end === null || end.epochNanoseconds <= start.epochNanoseconds) return jsonError(400, "invalid_query");
  if (start.epochNanoseconds < earliest || end.epochNanoseconds > latestAllowed ||
      end.epochNanoseconds - start.epochNanoseconds > maxRangeNanoseconds) {
    return jsonError(413, "requested_range_exceeded");
  }

  return {
    symbols,
    assetClass: rawAssetClass as YfinanceResearchAssetClass,
    adjustment: rawAdjustment as YfinanceResearchAdjustment,
    startUtc: start.normalized,
    endUtc: end.normalized,
    cursor,
  };
}

function decodeJson(bytes: ArrayBuffer): unknown | null {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function upstreamStatus(upstream: Response): NextResponse {
  const status = upstream.status;
  if (status === 400 || status === 410 || status === 413 || status === 422) {
    return jsonError(status, "research_query_rejected");
  }
  if (status === 401) return jsonError(401, "market_data_authentication_required");
  if (status === 403) return jsonError(403, "research_market_data_access_denied");
  if (status === 429) {
    const response = jsonError(429, "research_provider_rate_limited");
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter && /^[0-9]{1,6}$/.test(retryAfter)) response.headers.set("Retry-After", retryAfter);
    return response;
  }
  if (status === 502) return jsonError(502, "invalid_research_observation_response");
  if (status === 504) return jsonError(504, "research_query_timeout");
  if (status === 503) return jsonError(503, "market_data_service_unavailable");
  return jsonError(502, "invalid_research_observation_response");
}

export async function getYfinanceResearchDaily(request: NextRequest): Promise<NextResponse> {
  if (process.env.EQO_BFF_MODE !== "research") return jsonError(404, "route_not_available");

  const parsed = parseQuery(request);
  if (parsed instanceof NextResponse) return parsed;

  const authorization = await authorizeMdpMarketDataRequest(request, "research:read");
  if (!authorization.ok) return authorization.response;
  const base = mdpBaseUrl();
  if (!base) return jsonError(503, "market_data_service_unavailable");

  const upstreamUrl = new URL("/v1/research/yfinance/daily", base);
  upstreamUrl.searchParams.set("symbols", parsed.symbols.join(","));
  upstreamUrl.searchParams.set("asset_class", parsed.assetClass);
  upstreamUrl.searchParams.set("start_utc", parsed.startUtc);
  upstreamUrl.searchParams.set("end_utc", parsed.endUtc);
  upstreamUrl.searchParams.set("adjustment", parsed.adjustment);
  if (parsed.cursor !== null) upstreamUrl.searchParams.set("cursor", parsed.cursor);

  const controller = new AbortController();
  let deadlineExpired = false;
  const onClientAbort = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", onClientAbort, { once: true });
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, UPSTREAM_DEADLINE_MS);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authorization.token}`,
        "x-request-id": randomUUID(),
      },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status !== 200) {
      void upstream.body?.cancel().catch(() => undefined);
      return deadlineExpired ? jsonError(504, "research_query_timeout") : upstreamStatus(upstream);
    }
    if (upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      void upstream.body?.cancel().catch(() => undefined);
      return jsonError(502, "invalid_research_observation_response");
    }

    const bytes = await readLimitedResponse(upstream, MAX_RESPONSE_BYTES);
    if (deadlineExpired) return jsonError(504, "research_query_timeout");
    const body = bytes ? decodeJson(bytes) : null;
    if (!validateYfinanceResearchResponse(body, parsed)) {
      return jsonError(502, "invalid_research_observation_response");
    }
    return NextResponse.json(body, {
      status: 200,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (deadlineExpired) return jsonError(504, "research_query_timeout");
    if (error instanceof Error && error.message === "upstream_response_too_large") {
      return jsonError(502, "invalid_research_observation_response");
    }
    return jsonError(503, "market_data_service_unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}
