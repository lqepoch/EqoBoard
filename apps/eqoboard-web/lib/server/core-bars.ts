import "server-only";

import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { BarsResponseV1Schema, type BarsResponseV1 } from "@lqepoch/trading-core-contracts";
import { consumePrincipalRateLimit, consumeServiceRateLimit } from "./rate-limit";
import type { ServerPrincipal } from "./auth";

export const CORE_BARS_LIMIT = 1_000;
const MAX_QUERY_BYTES = 4_096;
const MAX_CURSOR_BYTES = 2_048;
const RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
const RESOLUTIONS = ["1m", "5m", "15m", "1h", "1d"] as const;
const SESSION_SCOPES = ["all", "regular", "extended", "overnight"] as const;
const ADJUSTMENTS = ["unadjusted", "split", "dividend", "all"] as const;
const PROVIDER_MODES = ["auto", "alpaca_only", "futu_only"] as const;
const ALLOWED_QUERY_KEYS = new Set([
  "range", "resolution", "asset_class", "session_scope", "adjustment", "provider_mode",
  "allow_daily_downgrade", "cursor", "request_start", "request_end",
]);
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;

export type CoreBarsRequestV1 = Readonly<{
  symbol: string;
  range: (typeof RANGES)[number];
  resolution: (typeof RESOLUTIONS)[number];
  assetClass: "stock" | "etf";
  sessionScope: (typeof SESSION_SCOPES)[number];
  adjustment: (typeof ADJUSTMENTS)[number];
  providerMode: (typeof PROVIDER_MODES)[number];
  allowDailyDowngrade: boolean;
  requestStart: string;
  requestEnd: string;
  cursor: string | null;
}>;

export type CoreBarsPageRequest = Readonly<{
  ok: true;
  symbol: string;
  range: CoreBarsRequestV1["range"];
  resolution: CoreBarsRequestV1["resolution"];
  assetClass: CoreBarsRequestV1["assetClass"];
  sessionScope: CoreBarsRequestV1["sessionScope"];
  adjustment: CoreBarsRequestV1["adjustment"];
  providerMode: CoreBarsRequestV1["providerMode"];
  allowDailyDowngrade: boolean;
  cursor: string | null;
  requestStart: string;
  requestEnd: string;
}> | Readonly<{ ok: false; status: 400 | 414; error: string }>;

function isOneOf<T extends readonly string[]>(value: string | null, values: T): value is T[number] {
  return value !== null && (values as readonly string[]).includes(value);
}

function singleParam(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  return values.length <= 1 ? values[0] ?? null : undefined;
}

function parseUtc(value: string): number | null {
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, date, hour, minute, second] = match;
  const millis = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== `${date}T${hour}:${minute}:${second}`) return null;
  return millis;
}

function subtractUtcMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
  const year = Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

function rangeWindow(range: CoreBarsRequestV1["range"], now = new Date()): { start: string; end: string } {
  let start: Date;
  switch (range) {
    case "1D": start = new Date(now.getTime() - 24 * 60 * 60 * 1_000); break;
    case "5D": start = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1_000); break;
    case "1M": start = subtractUtcMonths(now, 1); break;
    case "6M": start = subtractUtcMonths(now, 6); break;
    case "YTD": start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)); break;
    case "1Y": start = subtractUtcMonths(now, 12); break;
    case "5Y": start = subtractUtcMonths(now, 60); break;
    case "MAX": start = new Date("1970-01-01T00:00:00.000Z"); break;
  }
  return { start: start.toISOString(), end: now.toISOString() };
}

function maxRangeDays(range: CoreBarsRequestV1["range"]): number {
  const days: Record<CoreBarsRequestV1["range"], number> = {
    "1D": 2, "5D": 8, "1M": 40, "6M": 200, YTD: 380, "1Y": 400, "5Y": 1_900, MAX: 60 * 366,
  };
  return days[range];
}

function defaultResolution(range: CoreBarsRequestV1["range"]): CoreBarsRequestV1["resolution"] {
  if (range === "1D") return "1m";
  if (range === "5D") return "5m";
  if (range === "1M") return "1h";
  return "1d";
}

function validCursor(value: string): boolean {
  return value.trim() === value && new TextEncoder().encode(value).byteLength > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_CURSOR_BYTES &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
}

/**
 * Parse the closed chart query and resolve the first page's UTC window. Cursor
 * requests must repeat the exact returned bounds so paging stays one snapshot.
 */
export function parseCoreBarsPageRequest(request: Request, rawSymbol: string, now = new Date()): CoreBarsPageRequest {
  const url = new URL(request.url);
  if (new TextEncoder().encode(url.search).byteLength > MAX_QUERY_BYTES) return { ok: false, status: 414, error: "query_too_large" };
  if (!/^[A-Za-z][A-Za-z0-9.-]{0,11}$/u.test(rawSymbol)) return { ok: false, status: 400, error: "invalid_symbol" };
  const symbol = rawSymbol.toUpperCase();
  const params = url.searchParams;
  if ([...params.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key)) ||
      [...ALLOWED_QUERY_KEYS].some((key) => params.getAll(key).length > 1)) {
    return { ok: false, status: 400, error: "invalid_query" };
  }

  const rangeValue = singleParam(params, "range");
  const resolutionValue = singleParam(params, "resolution");
  const assetClassValue = singleParam(params, "asset_class");
  const sessionScopeValue = singleParam(params, "session_scope");
  const adjustmentValue = singleParam(params, "adjustment");
  const providerModeValue = singleParam(params, "provider_mode");
  const downgradeValue = singleParam(params, "allow_daily_downgrade");
  const cursor = singleParam(params, "cursor");
  const requestStart = singleParam(params, "request_start");
  const requestEnd = singleParam(params, "request_end");
  if (rangeValue === undefined || resolutionValue === undefined || assetClassValue === undefined ||
      sessionScopeValue === undefined || adjustmentValue === undefined || providerModeValue === undefined ||
      downgradeValue === undefined || cursor === undefined || requestStart === undefined || requestEnd === undefined) {
    return { ok: false, status: 400, error: "invalid_query" };
  }

  const range = rangeValue === null ? "6M" : rangeValue;
  if (!isOneOf(range, RANGES)) return { ok: false, status: 400, error: "invalid_range" };
  const resolution = resolutionValue === null ? defaultResolution(range) : resolutionValue;
  if (!isOneOf(resolution, RESOLUTIONS)) return { ok: false, status: 400, error: "invalid_resolution" };
  const assetClass = assetClassValue === null ? "stock" : assetClassValue;
  if (assetClass !== "stock" && assetClass !== "etf") return { ok: false, status: 400, error: "invalid_asset_class" };
  const sessionScope = sessionScopeValue === null ? "all" : sessionScopeValue;
  if (!isOneOf(sessionScope, SESSION_SCOPES)) return { ok: false, status: 400, error: "invalid_session_scope" };
  const adjustment = adjustmentValue === null ? "unadjusted" : adjustmentValue;
  if (!isOneOf(adjustment, ADJUSTMENTS)) return { ok: false, status: 400, error: "invalid_adjustment" };
  const providerMode = providerModeValue === null ? "auto" : providerModeValue;
  if (!isOneOf(providerMode, PROVIDER_MODES)) return { ok: false, status: 400, error: "invalid_provider_mode" };
  if (downgradeValue !== null && downgradeValue !== "true" && downgradeValue !== "false") {
    return { ok: false, status: 400, error: "invalid_allow_daily_downgrade" };
  }
  if ((cursor === null && (requestStart !== null || requestEnd !== null)) ||
      (cursor !== null && (requestStart === null || requestEnd === null || !validCursor(cursor)))) {
    return { ok: false, status: 400, error: "invalid_cursor" };
  }

  const window = cursor === null ? rangeWindow(range, now) : { start: requestStart as string, end: requestEnd as string };
  const startMs = parseUtc(window.start);
  const endMs = parseUtc(window.end);
  const earliestMs = Date.parse("1970-01-01T00:00:00.000Z");
  const latestMs = now.getTime() + 5 * 60 * 1_000;
  if (startMs === null || endMs === null || startMs < earliestMs || endMs <= startMs ||
      endMs > latestMs || endMs - startMs > maxRangeDays(range) * 24 * 60 * 60 * 1_000) {
    return { ok: false, status: 400, error: "invalid_request_window" };
  }

  return {
    ok: true,
    symbol,
    range,
    resolution,
    assetClass,
    sessionScope,
    adjustment,
    providerMode,
    allowDailyDowngrade: downgradeValue === null || downgradeValue === "true",
    cursor,
    requestStart: window.start,
    requestEnd: window.end,
  };
}

export function coreBarsRateLimit(principal: ServerPrincipal): boolean {
  return consumePrincipalRateLimit(principal, {
    bucket: "market:history:core-bars", maxRequests: 60, windowMs: 60_000,
  }).allowed && consumeServiceRateLimit("market:history:core-bars", 600, 60_000).allowed;
}

export function parseCoreBarsResponse(value: unknown, request: CoreBarsRequestV1): BarsResponseV1 | null {
  let response: BarsResponseV1;
  try {
    response = fromJson(BarsResponseV1Schema, value as JsonValue);
  } catch {
    return null;
  }
  if (response.schemaVersion !== 1 || response.requestedResolution !== request.resolution ||
      response.adjustment !== request.adjustment || !Array.isArray(response.rows) || response.rows.length > CORE_BARS_LIMIT ||
      response.rows.some((row) => row.symbol !== request.symbol)) return null;
  if (response.effectiveResolution !== request.resolution &&
      !(request.allowDailyDowngrade && response.effectiveResolution === "1d")) return null;
  return response;
}
