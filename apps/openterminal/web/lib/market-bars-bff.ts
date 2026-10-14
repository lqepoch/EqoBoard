import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getResearchServiceKey } from "@/lib/api-key";
import { authorizeBffRequest, authorizeMdpMarketDataRequest } from "@/lib/eqo-auth";
import { eqoHistory, EqoUpstreamError, usesSIPEquitySymbol } from "@/lib/eqo-market";
import { readLimitedResponse } from "@/lib/http-response";
import { mdpBaseUrl } from "@/lib/mdp-market-data";
import {
  MARKET_BAR_ADJUSTMENTS,
  MARKET_BAR_RESOLUTIONS,
  projectMdpMarketBarsResponse,
  validateMdpMarketBarsResponse,
  type MarketBarAdjustment,
  type MarketBarAssetClass,
  type MarketBarRequestIdentity,
  type MarketBarResolution,
} from "@/lib/market-bars-contract";
import { CRYPTO_SYMBOLS, isExplicitCryptoSymbol } from "../../server/src/providers/market-symbol.ts";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";
const MAX_QUERY_LENGTH = 4_096;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 2_048;
const UPSTREAM_DEADLINE_MS = 30_000;
const RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
const PROVIDER_MODES = ["auto", "alpaca_only", "futu_only", "research"] as const;
const SESSION_SCOPES = ["all", "regular", "extended", "overnight"] as const;
const INDEX_SYMBOLS = new Set(["VIX", "SPX", "NDX", "DJI", "RUT", "IXIC", "COMP"]);
const ALLOWED_QUERY_KEYS = new Set([
  "range", "resolution", "asset_class", "session_scope", "adjustment", "provider_mode",
  "allow_daily_downgrade", "cursor", "request_start", "request_end",
]);
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

type HistoryRange = (typeof RANGES)[number];
type ProviderMode = (typeof PROVIDER_MODES)[number];
type SessionScope = (typeof SESSION_SCOPES)[number];
type ParsedRequest = {
  symbol: string;
  range: HistoryRange;
  resolution: MarketBarResolution;
  assetClass: MarketBarAssetClass;
  sessionScope: SessionScope;
  adjustment: MarketBarAdjustment;
  providerMode: ProviderMode;
  allowDailyDowngrade: boolean;
  cursor: string | null;
  requestStart: string | null;
  requestEnd: string | null;
};

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function isStringEnum<T extends readonly string[]>(value: string | null, values: T): value is T[number] {
  return value !== null && (values as readonly string[]).includes(value);
}

function singleParam(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  return values.length <= 1 ? values[0] ?? null : undefined;
}

function validOpaqueCursor(value: string): boolean {
  return value.length > 0 && value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= MAX_CURSOR_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
}

function normalizedSymbol(raw: string): string | null {
  if (raw.length > 16 || !/^[A-Za-z][A-Za-z0-9.-]{0,15}$/.test(raw)) return null;
  return raw.toUpperCase();
}

function defaultResolution(range: HistoryRange): MarketBarResolution {
  switch (range) {
    case "1D": return "1m";
    case "5D": return "5m";
    case "1M": return "1h";
    default: return "1d";
  }
}

function parseQuery(request: NextRequest, rawSymbol: string, requireRange: boolean): ParsedRequest | NextResponse {
  if (request.nextUrl.search.length > MAX_QUERY_LENGTH) return jsonError(414, "query_too_large");
  const symbol = normalizedSymbol(rawSymbol);
  if (!symbol) return jsonError(400, "invalid_symbol");
  const params = request.nextUrl.searchParams;
  if ([...params.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key)) ||
      [...ALLOWED_QUERY_KEYS].some((key) => params.getAll(key).length > 1)) {
    return jsonError(400, "invalid_query");
  }

  const rawRange = singleParam(params, "range");
  if (rawRange === undefined || (requireRange && rawRange === null) ||
      (rawRange !== null && !isStringEnum(rawRange, RANGES))) return jsonError(400, "invalid_range");
  const range = (rawRange ?? "6M") as HistoryRange;
  const rawResolution = singleParam(params, "resolution");
  if (rawResolution === undefined || (rawResolution !== null && !isStringEnum(rawResolution, MARKET_BAR_RESOLUTIONS))) {
    return jsonError(400, "invalid_resolution");
  }
  const rawAssetClass = singleParam(params, "asset_class");
  if (rawAssetClass === undefined || (rawAssetClass !== null && rawAssetClass !== "stock" && rawAssetClass !== "etf")) {
    return jsonError(400, "invalid_asset_class");
  }
  const rawSessionScope = singleParam(params, "session_scope");
  if (rawSessionScope === undefined || (rawSessionScope !== null && !isStringEnum(rawSessionScope, SESSION_SCOPES))) {
    return jsonError(400, "invalid_session_scope");
  }
  const rawAdjustment = singleParam(params, "adjustment");
  if (rawAdjustment === undefined || (rawAdjustment !== null && !isStringEnum(rawAdjustment, MARKET_BAR_ADJUSTMENTS))) {
    return jsonError(400, "invalid_adjustment");
  }
  const rawProviderMode = singleParam(params, "provider_mode");
  if (rawProviderMode === undefined || (rawProviderMode !== null && !isStringEnum(rawProviderMode, PROVIDER_MODES))) {
    return jsonError(400, "invalid_provider_mode");
  }
  const rawDowngrade = singleParam(params, "allow_daily_downgrade");
  if (rawDowngrade === undefined || (rawDowngrade !== null && rawDowngrade !== "true" && rawDowngrade !== "false")) {
    return jsonError(400, "invalid_allow_daily_downgrade");
  }
  const cursor = singleParam(params, "cursor");
  const requestStart = singleParam(params, "request_start");
  const requestEnd = singleParam(params, "request_end");
  if (cursor === undefined || requestStart === undefined || requestEnd === undefined ||
      (cursor !== null && !validOpaqueCursor(cursor)) ||
      (cursor === null && (requestStart !== null || requestEnd !== null)) ||
      (cursor !== null && (requestStart === null || requestEnd === null))) {
    return jsonError(400, "invalid_cursor");
  }

  return {
    symbol,
    range,
    resolution: (rawResolution ?? defaultResolution(range)) as MarketBarResolution,
    assetClass: (rawAssetClass ?? "stock") as MarketBarAssetClass,
    sessionScope: (rawSessionScope ?? "all") as SessionScope,
    adjustment: (rawAdjustment ?? "unadjusted") as MarketBarAdjustment,
    providerMode: (rawProviderMode ?? "auto") as ProviderMode,
    allowDailyDowngrade: rawDowngrade === null || rawDowngrade === "true",
    cursor,
    requestStart,
    requestEnd,
  };
}

function parseUtcEpoch(value: string): number | null {
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, date, hour, minute, second] = match;
  const milliseconds = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(milliseconds) ||
      new Date(milliseconds).toISOString().slice(0, 19) !== `${date}T${hour}:${minute}:${second}`) return null;
  return milliseconds;
}

function subtractUtcMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

function rangeWindow(range: HistoryRange, now = new Date()): { start: string; end: string } {
  const end = new Date(now);
  let start: Date;
  switch (range) {
    case "1D": start = new Date(end.getTime() - 24 * 60 * 60 * 1_000); break;
    case "5D": start = new Date(end.getTime() - 5 * 24 * 60 * 60 * 1_000); break;
    case "1M": start = subtractUtcMonths(end, 1); break;
    case "6M": start = subtractUtcMonths(end, 6); break;
    case "YTD": start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1)); break;
    case "1Y": start = subtractUtcMonths(end, 12); break;
    case "5Y": start = subtractUtcMonths(end, 60); break;
    case "MAX": start = new Date("1970-01-01T00:00:00.000Z"); break;
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function maximumRangeSpan(range: HistoryRange): number {
  const days: Record<HistoryRange, number> = {
    "1D": 2, "5D": 8, "1M": 40, "6M": 200, YTD: 380, "1Y": 400, "5Y": 1_900, MAX: 60 * 366,
  };
  return days[range] * 24 * 60 * 60 * 1_000;
}

function requestWindow(parsed: ParsedRequest): { start: string; end: string } | NextResponse {
  if (parsed.cursor === null) return rangeWindow(parsed.range);
  const start = parseUtcEpoch(parsed.requestStart ?? "");
  const end = parseUtcEpoch(parsed.requestEnd ?? "");
  const latestAllowed = Date.now() + 5 * 60 * 1_000;
  const earliestAllowed = Date.parse("1970-01-01T00:00:00Z");
  if (start === null || end === null || start < earliestAllowed || end <= start ||
      end > latestAllowed || end - start > maximumRangeSpan(parsed.range)) {
    return jsonError(400, "invalid_request_window");
  }
  return { start: parsed.requestStart as string, end: parsed.requestEnd as string };
}

function marketBarsFlag(): boolean | null {
  const value = process.env.EQO_MDP_MARKET_BARS_ENABLED;
  if (value === undefined || value === "false") return false;
  return value === "true" ? true : null;
}

function unsupportedSymbol(symbol: string): boolean {
  return !usesSIPEquitySymbol(symbol) || CRYPTO_SYMBOLS.has(symbol) || isExplicitCryptoSymbol(symbol) || INDEX_SYMBOLS.has(symbol);
}

async function legacyHistory(request: NextRequest, parsed: ParsedRequest): Promise<NextResponse> {
  if (parsed.cursor !== null) return jsonError(501, "legacy_history_pagination_unavailable");
  if (usesSIPEquitySymbol(parsed.symbol)) {
    const auth = await authorizeBffRequest(request, "market:read", "eqoboard-gateway");
    if (!auth.ok) return auth.response;
    try {
      const response = await eqoHistory(parsed.symbol, parsed.range, auth.token);
      return NextResponse.json(response, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      const status = error instanceof EqoUpstreamError ? error.status : 502;
      const message = error instanceof EqoUpstreamError ? error.message : "market_data_unavailable";
      return jsonError(status, message);
    }
  }

  const auth = await authorizeBffRequest(request, "market:read", "openterminal-research");
  if (!auth.ok) return auth.response;
  const key = getResearchServiceKey();
  if (!key || key.length < 32) return jsonError(503, "research_service_unavailable");
  const url = new URL(`/api/history/${encodeURIComponent(parsed.symbol)}`, API_URL);
  url.searchParams.set("range", parsed.range);
  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${auth.token}`,
        "x-api-key": key,
        "x-request-id": randomUUID(),
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readLimitedResponse(upstream);
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return jsonError(502, "research_service_unavailable");
  }
}

function upstreamError(status: number): NextResponse {
  if (status === 403) return jsonError(403, "market_data_access_denied", { entitlement_status: "unauthorized" });
  if (status === 404 || status === 405 || status === 501) return jsonError(501, "market_data_endpoint_unsupported");
  if (status === 413) return jsonError(413, "result_limit_exceeded");
  if (status === 422) return jsonError(422, "market_data_query_rejected");
  if (status === 429) return jsonError(429, "market_data_rate_limited");
  if (status === 504) return jsonError(504, "query_timeout");
  if (status === 409) return jsonError(409, "market_data_conflict");
  return jsonError(503, "market_data_service_unavailable");
}

function marketBarsTransportStatusMatchesCoverage(body: unknown, status: number): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const coverageStatus = (body as Record<string, unknown>).coverage_status;
  if (status === 200) return coverageStatus === "complete" || coverageStatus === "empty";
  if (status === 206) return coverageStatus === "partial" || coverageStatus === "unknown";
  if (status === 422) return coverageStatus === "unsupported";
  return false;
}

function hasMarketBarsCoverageStatus(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  return ["complete", "empty", "partial", "unknown", "unsupported"].includes(
    String((body as Record<string, unknown>).coverage_status),
  );
}

async function readJsonResponse(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const body = await readLimitedResponse(response, MAX_RESPONSE_BYTES);
    if (body === null) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
}

export async function getMarketBars(request: NextRequest, rawSymbol: string): Promise<NextResponse> {
  const flag = marketBarsFlag();
  if (flag === null) return jsonError(503, "market_data_service_unavailable");
  const parsedResult = parseQuery(request, rawSymbol, flag);
  if (parsedResult instanceof NextResponse) return parsedResult;
  const parsed = parsedResult;

  if (!flag) {
    if (parsed.providerMode !== "auto") {
      return jsonError(501, "provider_selector_unavailable", {
        provider_mode_requested: parsed.providerMode,
        provider_mode_applied: false,
      });
    }
    return legacyHistory(request, parsed);
  }

  if (unsupportedSymbol(parsed.symbol)) return jsonError(422, "unsupported_symbol_type");
  const window = requestWindow(parsed);
  if (window instanceof NextResponse) return window;

  const authorization = await authorizeMdpMarketDataRequest(
    request,
    parsed.providerMode === "research" ? "research:read" : "market:read",
    parsed.providerMode === "auto" || parsed.providerMode === "futu_only",
  );
  if (!authorization.ok) return authorization.response;

  const base = mdpBaseUrl();
  if (!base) return jsonError(503, "market_data_service_unavailable");
  const identity: MarketBarRequestIdentity = {
    symbol: parsed.symbol,
    assetClass: parsed.assetClass,
    requestedResolution: parsed.resolution,
    allowDailyDowngrade: parsed.allowDailyDowngrade,
    adjustment: parsed.adjustment,
    start: window.start,
    end: window.end,
  };
  const upstreamUrl = new URL("/v1/market/bars", base);
  upstreamUrl.searchParams.set("symbol", parsed.symbol);
  upstreamUrl.searchParams.set("asset_class", parsed.assetClass);
  upstreamUrl.searchParams.set("start", window.start);
  upstreamUrl.searchParams.set("end", window.end);
  upstreamUrl.searchParams.set("resolution", parsed.resolution);
  upstreamUrl.searchParams.set("session_scope", parsed.sessionScope);
  upstreamUrl.searchParams.set("adjustment", parsed.adjustment);
  upstreamUrl.searchParams.set("provider_mode", parsed.providerMode);
  upstreamUrl.searchParams.set("allow_daily_downgrade", String(parsed.allowDailyDowngrade));
  upstreamUrl.searchParams.set("limit", "1000");
  if (parsed.cursor) upstreamUrl.searchParams.set("cursor", parsed.cursor);

  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${authorization.token}`,
    "x-request-id": randomUUID(),
  });
  if (authorization.gatewayDelegation) {
    headers.set("X-Eqo-Gateway-Delegation", authorization.gatewayDelegation);
  }

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
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 422) {
      void upstream.body?.cancel().catch(() => undefined);
      return deadlineExpired ? jsonError(504, "query_timeout") : upstreamError(upstream.status);
    }
    const body = await readJsonResponse(upstream);
    if (deadlineExpired) return jsonError(504, "query_timeout");
    if (body === null) {
      if (upstream.status === 422) return upstreamError(422);
      return jsonError(502, "invalid_market_data_response");
    }
    const validated = validateMdpMarketBarsResponse(body, identity);
    if (upstream.status === 422 && !hasMarketBarsCoverageStatus(body)) return upstreamError(422);
    if (!validated || !marketBarsTransportStatusMatchesCoverage(body, upstream.status)) {
      return jsonError(502, "invalid_market_data_response");
    }
    const projected = projectMdpMarketBarsResponse(validated, {
      ...identity,
      providerMode: parsed.providerMode,
      cursor: parsed.cursor,
    });
    if (!projected) return jsonError(502, "invalid_market_data_response");
    if (upstream.status === 422) {
      return NextResponse.json({ ...projected, error: "market_data_unsupported" }, {
        status: upstream.status,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    return NextResponse.json(projected, {
      status: upstream.status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return deadlineExpired ? jsonError(504, "query_timeout") : jsonError(503, "market_data_service_unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}
