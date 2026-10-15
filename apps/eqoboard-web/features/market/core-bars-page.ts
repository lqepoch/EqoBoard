/** BFF paging metadata wrapped around the unchanged pinned Core Bars V1 response. */
export type CoreBarsPageRequest = Readonly<{
  symbol: string;
  range: "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";
  resolution: "1m" | "5m" | "15m" | "1h" | "1d";
  asset_class: "stock" | "etf";
  session_scope: "all" | "regular" | "extended" | "overnight";
  adjustment: "unadjusted" | "split" | "dividend" | "all";
  provider_mode: "auto" | "alpaca_only" | "futu_only";
  allow_daily_downgrade: boolean;
  request_start: string;
  request_end: string;
  cursor: string | null;
}>;

export type CoreBarsPageEnvelope = Readonly<{
  kind: "eqoboard.core-bars-page.v1";
  request: CoreBarsPageRequest;
  /** Original ProtoJSON body; the chart feature decodes it with pinned Core. */
  response: unknown;
}>;

const CONTROL = /[\u0000-\u001f\u007f]/u;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
const RESOLUTIONS = ["1m", "5m", "15m", "1h", "1d"] as const;
const ADJUSTMENTS = ["unadjusted", "split", "dividend", "all"] as const;
const SESSIONS = ["all", "regular", "extended", "overnight"] as const;
const PROVIDERS = ["auto", "alpaca_only", "futu_only"] as const;
const REQUEST_KEYS = [
  "symbol",
  "range",
  "resolution",
  "asset_class",
  "session_scope",
  "adjustment",
  "provider_mode",
  "allow_daily_downgrade",
  "request_start",
  "request_end",
  "cursor",
] as const;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        !!descriptors[key] &&
        descriptors[key]!.enumerable &&
        "value" in descriptors[key]!,
    );
  } catch {
    return false;
  }
}

function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function rfc3339(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseRequest(value: unknown): CoreBarsPageRequest | null {
  if (!plainRecord(value) || !hasKeys(value, REQUEST_KEYS)) return null;
  if (
    typeof value.symbol !== "string" ||
    !SYMBOL.test(value.symbol) ||
    typeof value.range !== "string" ||
    !(RANGES as readonly string[]).includes(value.range) ||
    typeof value.resolution !== "string" ||
    !(RESOLUTIONS as readonly string[]).includes(value.resolution) ||
    (value.asset_class !== "stock" && value.asset_class !== "etf") ||
    typeof value.session_scope !== "string" ||
    !(SESSIONS as readonly string[]).includes(value.session_scope) ||
    typeof value.adjustment !== "string" ||
    !(ADJUSTMENTS as readonly string[]).includes(value.adjustment) ||
    typeof value.provider_mode !== "string" ||
    !(PROVIDERS as readonly string[]).includes(value.provider_mode) ||
    typeof value.allow_daily_downgrade !== "boolean" ||
    !rfc3339(value.request_start) ||
    !rfc3339(value.request_end) ||
    value.request_start >= value.request_end ||
    (value.cursor !== null &&
      (typeof value.cursor !== "string" ||
        value.cursor.length === 0 ||
        new TextEncoder().encode(value.cursor).byteLength > 2_048 ||
        CONTROL.test(value.cursor)))
  )
    return null;
  return Object.freeze({
    symbol: value.symbol,
    range: value.range as CoreBarsPageRequest["range"],
    resolution: value.resolution as CoreBarsPageRequest["resolution"],
    asset_class: value.asset_class,
    session_scope: value.session_scope as CoreBarsPageRequest["session_scope"],
    adjustment: value.adjustment as CoreBarsPageRequest["adjustment"],
    provider_mode: value.provider_mode as CoreBarsPageRequest["provider_mode"],
    allow_daily_downgrade: value.allow_daily_downgrade,
    request_start: value.request_start,
    request_end: value.request_end,
    cursor: value.cursor as string | null,
  });
}

/** Validates only the non-financial paging envelope; Core validates the response body. */
export function decodeCoreBarsPageEnvelope(value: unknown): CoreBarsPageEnvelope | null {
  if (
    !plainRecord(value) ||
    !hasKeys(value, ["kind", "request", "response"]) ||
    value.kind !== "eqoboard.core-bars-page.v1"
  )
    return null;
  const request = parseRequest(value.request);
  if (!request || !plainRecord(value.response)) return null;
  return Object.freeze({ kind: "eqoboard.core-bars-page.v1", request, response: value.response });
}
