import { compareDecimals } from "@/lib/mdp-market-data";

export const MARKET_BAR_RESOLUTIONS = ["1m", "5m", "15m", "1h", "1d"] as const;
export const MARKET_BAR_ADJUSTMENTS = ["unadjusted", "split", "dividend", "all"] as const;
export const MARKET_BAR_COVERAGE = ["complete", "partial", "empty", "unknown", "unsupported"] as const;
export const MARKET_BAR_ENTITLEMENTS = ["authorized", "unauthorized", "unknown", "mixed"] as const;
export const MARKET_BAR_CACHE_STATES = ["hit", "miss", "stale", "bypass", "unavailable", "unknown"] as const;
export const MARKET_BAR_NUMERIC_ENCODINGS = [
  "decimal_token", "integer_token", "binary_float64_shortest_decimal", "binary_float32_shortest_decimal",
] as const;

export type MarketBarResolution = (typeof MARKET_BAR_RESOLUTIONS)[number];
export type MarketBarAdjustment = (typeof MARKET_BAR_ADJUSTMENTS)[number];
export type MarketBarAssetClass = "stock" | "etf";

type MarketBarRow = {
  symbol: string;
  asset_class: MarketBarAssetClass;
  resolution: MarketBarResolution;
  adjustment: MarketBarAdjustment;
  bar_start_utc: string;
  bar_end_exclusive_utc: string;
  received_at_utc: string;
  available_at_utc: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  provenance_id: string;
  session_instance_id: string;
  validation_state: "validated" | "provisional" | "conflict";
  [key: string]: unknown;
};

type MarketBarsV1 = {
  schema_version: 1;
  requested_resolution: MarketBarResolution;
  effective_resolution: MarketBarResolution;
  adjustment: MarketBarAdjustment;
  rows: MarketBarRow[];
  coverage_status: (typeof MARKET_BAR_COVERAGE)[number];
  segments: Array<Record<string, unknown>>;
  gaps: Array<Record<string, unknown>>;
  source_provenance: Array<Record<string, unknown>>;
  provider: string;
  feed: string;
  entitlement_status: (typeof MARKET_BAR_ENTITLEMENTS)[number];
  as_of?: string | null;
  fetched_at: string;
  verified_at?: string | null;
  cache_status: (typeof MARKET_BAR_CACHE_STATES)[number];
  market_calendar_version?: string | null;
  continuation_cursor?: string | null;
  truncated: boolean;
  [key: string]: unknown;
};

export type MarketBarRequestIdentity = {
  symbol: string;
  assetClass: MarketBarAssetClass;
  requestedResolution: MarketBarResolution;
  allowDailyDowngrade: boolean;
  adjustment: MarketBarAdjustment;
  start: string;
  end: string;
};

type ProjectedMarketBar = Omit<MarketBarRow, "open" | "high" | "low" | "close" | "volume"> & {
    time: number;
    asOf: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    source_mode: string;
    source_label: string;
    exact: { open: string; high: string; low: string; close: string; volume: string };
  };

export type MarketBarProjection = MarketBarsV1 & {
  bars: ProjectedMarketBar[];
  source: string;
  source_mode: string;
  source_label: string;
  resolution: { requested: MarketBarResolution; effective: MarketBarResolution; downgrade_reason: string | null };
  downgrade_reason: string | null;
  delay_ms: null;
  delay: null;
  verification: "unknown";
  request_start: string;
  request_end: string;
  cursor: string | null;
  next_cursor: string | null;
  has_more: boolean;
  asset_class: MarketBarAssetClass;
  asset_class_source: "caller_declared";
  provider_mode_requested: string;
  cache: { status: string };
  as_of: string | null;
  verified_at: string | null;
  market_calendar_version: string | null;
  continuation_cursor: string | null;
};

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f]+$/;
const MAX_PRICE = 1_000_000_000_000;
const MAX_VOLUME = 1_000_000_000_000_000;
const MAX_ROWS = 1_000;
const MAX_PROVENANCE = 1_000;
const MAX_CURSOR_LENGTH = 2_048;
const GAP_REASONS = new Set([
  "source_gap", "provider_unavailable", "entitlement_limited", "unsupported_resolution",
  "session_excluded", "validation_conflict", "unknown",
]);
const SUMMARY_MARKERS = new Set(["mixed", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLabel(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= maximum && SAFE_LABEL.test(value);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, date, hour, minute, second] = match;
  const millis = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== `${date}T${hour}:${minute}:${second}`) {
    return null;
  }
  return millis;
}

function parseTimestampNanoseconds(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, date, hour, minute, second, fraction = ""] = match;
  const millis = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== `${date}T${hour}:${minute}:${second}`) {
    return null;
  }
  return BigInt(millis) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function validDecimal(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= maximum;
}

function validPositiveDecimal(value: unknown, maximum: number): value is string {
  return validDecimal(value, maximum) && compareDecimals(value, "0") === 1;
}

function validProvenance(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && safeLabel(value.provenance_id, 128) &&
    safeLabel(value.provider, 128) && !SUMMARY_MARKERS.has(value.provider) &&
    safeLabel(value.feed, 128) && !SUMMARY_MARKERS.has(value.feed) && safeLabel(value.source, 128) &&
    MARKET_BAR_ENTITLEMENTS.includes(value.entitlement_status as (typeof MARKET_BAR_ENTITLEMENTS)[number]) &&
    value.entitlement_status !== "mixed" &&
    MARKET_BAR_NUMERIC_ENCODINGS.includes(value.numeric_encoding as (typeof MARKET_BAR_NUMERIC_ENCODINGS)[number]);
}

function validInterval(startValue: unknown, endValue: unknown, identity: MarketBarRequestIdentity): boolean {
  const start = parseTimestampNanoseconds(startValue);
  const end = parseTimestampNanoseconds(endValue);
  const requestStart = parseTimestampNanoseconds(identity.start);
  const requestEnd = parseTimestampNanoseconds(identity.end);
  return start !== null && end !== null && requestStart !== null && requestEnd !== null &&
    start < end && start >= requestStart && end <= requestEnd;
}

function validSegment(value: unknown, identity: MarketBarRequestIdentity): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return validInterval(value.start_utc, value.end_exclusive_utc, identity) &&
    MARKET_BAR_COVERAGE.includes(value.coverage_status as (typeof MARKET_BAR_COVERAGE)[number]) &&
    value.coverage_status !== "empty" && value.coverage_status !== "unsupported" &&
    (value.provenance_id === undefined || value.provenance_id === null || safeLabel(value.provenance_id, 128)) &&
    safeLabel(value.session_instance_id, 128);
}

function validGap(value: unknown, identity: MarketBarRequestIdentity): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return validInterval(value.start_utc, value.end_exclusive_utc, identity) &&
    typeof value.reason_code === "string" && GAP_REASONS.has(value.reason_code);
}

function orderedNonOverlapping(values: readonly Record<string, unknown>[], startKey: string, endKey: string): boolean {
  let previousEnd: bigint | null = null;
  for (const value of values) {
    const start = parseTimestampNanoseconds(value[startKey]);
    const end = parseTimestampNanoseconds(value[endKey]);
    if (start === null || end === null || (previousEnd !== null && start < previousEnd)) return false;
    previousEnd = end;
  }
  return true;
}

function intervalsIntersect(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftStart = parseTimestampNanoseconds(left.start_utc);
  const leftEnd = parseTimestampNanoseconds(left.end_exclusive_utc);
  const rightStart = parseTimestampNanoseconds(right.start_utc);
  const rightEnd = parseTimestampNanoseconds(right.end_exclusive_utc);
  return leftStart === null || leftEnd === null || rightStart === null || rightEnd === null ||
    leftStart < rightEnd && rightStart < leftEnd;
}

function rowIntersectsGap(row: Record<string, unknown>, gap: Record<string, unknown>): boolean {
  const rowStart = parseTimestampNanoseconds(row.bar_start_utc);
  const rowEnd = parseTimestampNanoseconds(row.bar_end_exclusive_utc);
  const gapStart = parseTimestampNanoseconds(gap.start_utc);
  const gapEnd = parseTimestampNanoseconds(gap.end_exclusive_utc);
  return rowStart === null || rowEnd === null || gapStart === null || gapEnd === null ||
    rowStart < gapEnd && gapStart < rowEnd;
}

function validRow(
  value: unknown,
  identity: MarketBarRequestIdentity,
  effectiveResolution: MarketBarResolution,
  provenanceIds: ReadonlySet<string>,
  segments: readonly Record<string, unknown>[],
  gaps: readonly Record<string, unknown>[],
): value is MarketBarRow {
  if (!isRecord(value) || value.symbol !== identity.symbol || value.asset_class !== identity.assetClass ||
      value.resolution !== effectiveResolution || value.adjustment !== identity.adjustment ||
      !safeLabel(value.provenance_id, 128) || !provenanceIds.has(value.provenance_id) ||
      !safeLabel(value.session_instance_id, 128) ||
      !["validated", "provisional", "conflict"].includes(value.validation_state as string)) return false;

  const start = parseTimestampNanoseconds(value.bar_start_utc);
  const end = parseTimestampNanoseconds(value.bar_end_exclusive_utc);
  const received = parseTimestamp(value.received_at_utc);
  const available = parseTimestamp(value.available_at_utc);
  const receivedNs = parseTimestampNanoseconds(value.received_at_utc);
  const availableNs = parseTimestampNanoseconds(value.available_at_utc);
  const requestStart = parseTimestampNanoseconds(identity.start);
  const requestEnd = parseTimestampNanoseconds(identity.end);
  if (start === null || end === null || received === null || available === null ||
      receivedNs === null || availableNs === null || receivedNs > availableNs ||
      requestStart === null || requestEnd === null || start >= end || start < requestStart || end > requestEnd ||
      !segments.some((segment) => segment.provenance_id === value.provenance_id &&
        segment.session_instance_id === value.session_instance_id &&
        start >= (parseTimestampNanoseconds(segment.start_utc) ?? -1n) &&
        end <= (parseTimestampNanoseconds(segment.end_exclusive_utc) ?? -1n)) ||
      gaps.some((gap) => rowIntersectsGap(value, gap))) return false;

  const values = [value.open, value.high, value.low, value.close, value.volume];
  if (!validPositiveDecimal(values[0], MAX_PRICE) || !validPositiveDecimal(values[1], MAX_PRICE) ||
      !validPositiveDecimal(values[2], MAX_PRICE) || !validPositiveDecimal(values[3], MAX_PRICE) ||
      !validDecimal(values[4], MAX_VOLUME)) return false;
  const highVsOpen = compareDecimals(values[1], values[0]);
  const highVsLow = compareDecimals(values[1], values[2]);
  const highVsClose = compareDecimals(values[1], values[3]);
  const lowVsOpen = compareDecimals(values[2], values[0]);
  const lowVsClose = compareDecimals(values[2], values[3]);
  return highVsOpen !== null && highVsLow !== null && highVsClose !== null &&
    lowVsOpen !== null && lowVsClose !== null && highVsOpen >= 0 && highVsLow >= 0 &&
    highVsClose >= 0 && lowVsOpen <= 0 && lowVsClose <= 0;
}

function sourceSummary(values: readonly Record<string, unknown>[], key: "provider" | "feed"): string {
  const unique = new Set(values.map((value) => String(value[key])));
  if (unique.size === 0) return "unknown";
  if (unique.size > 1) return "mixed";
  return [...unique][0] ?? "unknown";
}

function entitlementSummary(values: readonly Record<string, unknown>[]): string {
  const unique = new Set(values.map((value) => String(value.entitlement_status)));
  if (unique.size === 0) return "unknown";
  if (unique.size > 1) return "mixed";
  return [...unique][0] ?? "unknown";
}

export function validateMdpMarketBarsResponse(
  value: unknown,
  identity: MarketBarRequestIdentity,
): MarketBarsV1 | null {
  if (!isRecord(value) || value.schema_version !== 1 ||
      value.requested_resolution !== identity.requestedResolution ||
      !MARKET_BAR_RESOLUTIONS.includes(value.effective_resolution as MarketBarResolution) ||
      (value.effective_resolution !== identity.requestedResolution &&
        (!identity.allowDailyDowngrade || value.effective_resolution !== "1d")) ||
      value.adjustment !== identity.adjustment ||
      !MARKET_BAR_COVERAGE.includes(value.coverage_status as (typeof MARKET_BAR_COVERAGE)[number]) ||
      !safeLabel(value.provider, 128) || !safeLabel(value.feed, 128) ||
      !MARKET_BAR_ENTITLEMENTS.includes(value.entitlement_status as (typeof MARKET_BAR_ENTITLEMENTS)[number]) ||
      !MARKET_BAR_CACHE_STATES.includes(value.cache_status as (typeof MARKET_BAR_CACHE_STATES)[number]) ||
      !(value.as_of === undefined || value.as_of === null || parseTimestamp(value.as_of) !== null) ||
      parseTimestamp(value.fetched_at) === null ||
      !(value.verified_at === undefined || value.verified_at === null || parseTimestamp(value.verified_at) !== null) ||
      !(value.market_calendar_version === undefined || value.market_calendar_version === null || safeLabel(value.market_calendar_version, 128)) ||
      !((value.continuation_cursor === undefined || value.continuation_cursor === null) ||
        safeLabel(value.continuation_cursor, MAX_CURSOR_LENGTH)) ||
      typeof value.truncated !== "boolean" || value.truncated !== ((value.continuation_cursor ?? null) !== null) ||
      (value.truncated && value.coverage_status === "complete") ||
      (value.coverage_status === "empty" && Array.isArray(value.rows) && value.rows.length !== 0) ||
      (value.coverage_status === "complete" && Array.isArray(value.gaps) && value.gaps.length !== 0) ||
      !Array.isArray(value.rows) || value.rows.length > MAX_ROWS ||
      !Array.isArray(value.segments) || value.segments.length > MAX_ROWS ||
      !value.segments.every((segment) => validSegment(segment, identity)) ||
      !Array.isArray(value.gaps) || value.gaps.length > MAX_ROWS ||
      !value.gaps.every((gap) => validGap(gap, identity)) ||
      !Array.isArray(value.source_provenance) || value.source_provenance.length > MAX_PROVENANCE ||
      !value.source_provenance.every(validProvenance)) return null;

  const effectiveResolution = value.effective_resolution as MarketBarResolution;
  const segments = value.segments as Array<Record<string, unknown>>;
  const gaps = value.gaps as Array<Record<string, unknown>>;
  const provenance = value.source_provenance as Array<Record<string, unknown>>;
  const provenanceIds = new Set(provenance.map((item) => String(item.provenance_id)));
  if (!orderedNonOverlapping(segments, "start_utc", "end_exclusive_utc") ||
      !orderedNonOverlapping(gaps, "start_utc", "end_exclusive_utc") ||
      provenanceIds.size !== provenance.length ||
      sourceSummary(provenance, "provider") !== value.provider ||
      sourceSummary(provenance, "feed") !== value.feed ||
      entitlementSummary(provenance) !== value.entitlement_status ||
      segments.some((segment) => segment.provenance_id !== undefined && segment.provenance_id !== null &&
        !provenanceIds.has(String(segment.provenance_id))) ||
      (value.coverage_status === "complete" && !segments.every((segment) => segment.coverage_status === "complete")) ||
      gaps.some((gap) => segments.some((segment) => segment.coverage_status === "complete" && intervalsIntersect(gap, segment)))) return null;
  if (!(value.rows as unknown[]).every((row) => validRow(row, identity, effectiveResolution, provenanceIds, segments, gaps))) return null;
  return value as unknown as MarketBarsV1;
}

function numericProjection(value: string, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > maximum) {
    throw new Error("invalid_numeric_projection");
  }
  return numeric;
}

function sourceName(response: MarketBarsV1): string {
  if (response.provider === "mixed" || response.feed === "mixed") return "mixed";
  const names = [...new Set(response.source_provenance.map((item) => String(item.source)))];
  if (names.length === 1) return names[0];
  if (names.length > 1) return "mixed";
  return "unknown";
}

export function projectMdpMarketBarsResponse(
  response: MarketBarsV1,
  request: MarketBarRequestIdentity & { providerMode: string; cursor: string | null },
): MarketBarProjection | null {
  try {
    const provenanceById = new Map(response.source_provenance.map((item) => [String(item.provenance_id), item]));
    const bars = response.rows.map((row) => {
      const exact = { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
      const provenance = provenanceById.get(row.provenance_id);
      if (!provenance) throw new Error("missing_provenance");
      const timeMillis = parseTimestamp(row.bar_start_utc);
      if (timeMillis === null) throw new Error("invalid_bar_time");
      const time = Math.floor(timeMillis / 1000);
      if (!Number.isSafeInteger(time)) throw new Error("invalid_bar_time");
      return {
        ...row,
        time,
        asOf: row.bar_start_utc,
        open: numericProjection(row.open, MAX_PRICE),
        high: numericProjection(row.high, MAX_PRICE),
        low: numericProjection(row.low, MAX_PRICE),
        close: numericProjection(row.close, MAX_PRICE),
        volume: numericProjection(row.volume, MAX_VOLUME),
        source_mode: String(provenance.provider),
        source_label: String(provenance.source),
        exact,
      };
    }).sort((left, right) => left.time - right.time);
    const downgradeReason = response.requested_resolution === response.effective_resolution ? null : "unknown";
    const source = sourceName(response);
    const continuationCursor = response.continuation_cursor ?? null;
    const hasMore = response.truncated && continuationCursor !== null;
    return {
      ...response,
      bars,
      source,
      source_mode: response.provider,
      source_label: source,
      resolution: {
        requested: response.requested_resolution,
        effective: response.effective_resolution,
        downgrade_reason: downgradeReason,
      },
      downgrade_reason: downgradeReason,
      delay_ms: null,
      delay: null,
      // Structural bar validation is not independent source or entitlement verification.
      verification: "unknown",
      request_start: request.start,
      request_end: request.end,
      cursor: request.cursor,
      as_of: response.as_of ?? null,
      verified_at: response.verified_at ?? null,
      market_calendar_version: response.market_calendar_version ?? null,
      continuation_cursor: continuationCursor,
      next_cursor: continuationCursor,
      has_more: hasMore,
      asset_class: request.assetClass,
      asset_class_source: "caller_declared",
      provider_mode_requested: request.providerMode,
      cache: { status: response.cache_status },
    };
  } catch {
    return null;
  }
}
