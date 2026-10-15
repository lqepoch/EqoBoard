export const YFINANCE_RESEARCH_SCHEMA = "mdp-yfinance-research-observations-v1" as const;
export const YFINANCE_BRIDGE_SCHEMA = "yfinance-history-bridge-v1" as const;
export const YFINANCE_RESEARCH_MAX_CURSOR_BYTES = 8_192;
export const YFINANCE_RESEARCH_MAX_PAGE_ROWS = 24_000;
export const YFINANCE_RESEARCH_MAX_PAGE_DAYS = 3_650;
export const YFINANCE_RESEARCH_MAX_RANGE_DAYS = 36_500;
export const YFINANCE_RESEARCH_MAX_PAGES = 10;
export const YFINANCE_RESEARCH_VOLUME_ENCODING = "integer_exact_or_safe_integer_float" as const;
export const YFINANCE_BRIDGE_PROVENANCE_SCHEMA = "research-bars-v1" as const;

export type YfinanceResearchAdjustment = "unadjusted" | "adjusted";
export type YfinanceResearchAssetClass = "stock" | "etf";

export type YfinanceResearchRange = {
  start_utc: string;
  end_utc: string;
  semantics: "start_inclusive_end_exclusive";
};

export type YfinanceBridgeBar = {
  symbol: string;
  asset_class: YfinanceResearchAssetClass;
  event_ts_utc: string;
  resolution: "1d";
  adjustment: YfinanceResearchAdjustment;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  adj_close: string | null;
  volume: string | null;
  dividends: string | null;
  stock_splits: string | null;
};

export type YfinanceHistoryBridgePayload = {
  schema_version: typeof YFINANCE_BRIDGE_SCHEMA;
  status: "ready" | "partial";
  provider: "yfinance";
  source: "Yahoo Finance";
  asset_class: YfinanceResearchAssetClass;
  classification_source: string;
  resolution: "1d";
  effective_resolution: "1d";
  adjustment: YfinanceResearchAdjustment;
  provider_adjustment_semantics: "unknown_or_provider_native";
  adjustment_confirmed_raw: false;
  provider_repair_enabled: false;
  numeric_encoding: "binary_float_projection";
  volume_encoding: typeof YFINANCE_RESEARCH_VOLUME_ENCODING;
  canonical: false;
  point_in_time: false;
  executable: false;
  display_only: true;
  requested_range: Record<string, unknown>;
  requested_symbols: string[];
  returned_symbols: string[];
  missing_symbols: string[];
  available_at: string;
  fetched_at: string;
  source_observed_at: string;
  request_started_at: string;
  cache_status: unknown;
  freshness: unknown;
  coverage: Record<string, unknown>;
  action_coverage: Record<string, unknown>;
  actions: unknown[];
  bars: YfinanceBridgeBar[];
  provenance: Record<string, unknown> & {
    provider: "yahoo_finance";
    source: "yfinance";
    schema_version: typeof YFINANCE_BRIDGE_PROVENANCE_SCHEMA;
  };
};

export type YfinanceResearchResponse = {
  schema_version: typeof YFINANCE_RESEARCH_SCHEMA;
  provider: "yfinance";
  source: "Yahoo Finance";
  asset_class: YfinanceResearchAssetClass;
  resolution: "1d";
  requested_adjustment: YfinanceResearchAdjustment;
  provider_adjustment_semantics: "unknown_or_provider_native";
  adjustment_confirmed_raw: false;
  numeric_encoding: "binary_float_projection";
  canonical: false;
  point_in_time: false;
  executable: false;
  display_only: true;
  mdp_coverage_asserted: false;
  requested_symbols: string[];
  requested_range: YfinanceResearchRange;
  page_range: YfinanceResearchRange;
  observation: {
    source_observation_sha256: string;
    fetched_at_utc: string;
    payload: YfinanceHistoryBridgePayload;
  };
  next_cursor: string | null;
};

export type ExpectedYfinanceResearchRequest = {
  symbols: readonly string[];
  assetClass: YfinanceResearchAssetClass;
  adjustment: YfinanceResearchAdjustment;
  startUtc: string;
  endUtc: string;
  cursor: string | null;
};

const TOP_LEVEL_FIELDS = new Set([
  "schema_version", "provider", "source", "asset_class", "resolution", "requested_adjustment",
  "provider_adjustment_semantics", "adjustment_confirmed_raw", "numeric_encoding", "canonical",
  "point_in_time", "executable", "display_only", "mdp_coverage_asserted", "requested_symbols",
  "requested_range", "page_range", "observation", "next_cursor",
]);

const PAYLOAD_FIELDS = new Set([
  "schema_version", "status", "provider", "source", "asset_class", "classification_source",
  "resolution", "effective_resolution", "adjustment", "provider_adjustment_semantics",
  "adjustment_confirmed_raw", "provider_repair_enabled", "numeric_encoding", "volume_encoding",
  "canonical", "point_in_time", "executable", "display_only", "requested_range", "requested_symbols",
  "returned_symbols", "missing_symbols", "available_at", "fetched_at", "source_observed_at",
  "request_started_at", "cache_status", "freshness", "coverage", "action_coverage", "actions",
  "bars", "provenance",
]);

const BAR_FIELDS = new Set([
  "symbol", "asset_class", "event_ts_utc", "resolution", "adjustment", "open", "high", "low", "close",
  "adj_close", "volume", "dividends", "stock_splits",
]);

const BRIDGE_PROVENANCE_FIELDS = new Set([
  "acquired_at", "adapter_version", "adjustment", "cache_status", "config_fingerprint", "end",
  "include_actions", "interval", "missing_symbols", "prepost", "provider", "query_fingerprint",
  "requested_at", "requested_symbols", "returned_symbols", "row_count", "schema_version", "served_at",
  "source", "start",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/;
const DAY_NS = 86_400_000_000_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function hasExactFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).length === fields.size && hasOnlyFields(value, fields);
}

function parseUtcTimestamp(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const epoch = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(epoch) ||
      new Date(epoch).toISOString().slice(0, 19) !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) return null;
  return BigInt(epoch) * 1_000_000n + BigInt(fraction.padEnd(9, "0") || "0");
}

function parseRange(value: unknown): { start: bigint; end: bigint } | null {
  if (!isRecord(value) || !hasExactFields(value, new Set(["start_utc", "end_utc", "semantics"])) ||
      value.semantics !== "start_inclusive_end_exclusive" ||
      typeof value.start_utc !== "string" || !value.start_utc.endsWith("Z") ||
      typeof value.end_utc !== "string" || !value.end_utc.endsWith("Z")) return null;
  const start = parseUtcTimestamp(value.start_utc);
  const end = parseUtcTimestamp(value.end_utc);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

function rangeMatchesRequest(value: unknown, request: ExpectedYfinanceResearchRequest): boolean {
  return isRecord(value) && value.start_utc === request.startUtc && value.end_utc === request.endUtc;
}

function isDecimalOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string" && value.length <= 64 && DECIMAL.test(value) && Number.isFinite(Number(value));
}

function isIntegerOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 64 && /^[0-9]+$/.test(value));
}

function isSymbolList(value: unknown, allowed: readonly string[]): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && allowed.includes(item)) &&
    new Set(value).size === value.length;
}

function symbolsEchoRequest(value: unknown, request: ExpectedYfinanceResearchRequest): value is string[] {
  return isSymbolList(value, request.symbols) && value.length === request.symbols.length &&
    value.every((symbol, index) => symbol === request.symbols[index]);
}

function validPayload(
  value: unknown,
  request: ExpectedYfinanceResearchRequest,
  pageStart: bigint,
  pageEnd: bigint,
): value is YfinanceHistoryBridgePayload {
  if (!isRecord(value) || !hasExactFields(value, PAYLOAD_FIELDS)) return false;
  const returnedSymbols = value.returned_symbols;
  const missingSymbols = value.missing_symbols;
  if (!isSymbolList(returnedSymbols, request.symbols) || !isSymbolList(missingSymbols, request.symbols) ||
      returnedSymbols.some((symbol) => missingSymbols.includes(symbol))) return false;

  if (
      value.schema_version !== YFINANCE_BRIDGE_SCHEMA || !["ready", "partial"].includes(value.status as string) ||
      value.provider !== "yfinance" || value.source !== "Yahoo Finance" ||
      value.asset_class !== request.assetClass || value.classification_source !== "caller_declared" ||
      value.resolution !== "1d" || value.effective_resolution !== "1d" || value.adjustment !== request.adjustment ||
      value.provider_adjustment_semantics !== "unknown_or_provider_native" || value.adjustment_confirmed_raw !== false ||
      value.provider_repair_enabled !== false || value.numeric_encoding !== "binary_float_projection" ||
      value.volume_encoding !== YFINANCE_RESEARCH_VOLUME_ENCODING || value.canonical !== false ||
      value.point_in_time !== false || value.executable !== false || value.display_only !== true ||
      !symbolsEchoRequest(value.requested_symbols, request) ||
      ((value.status === "partial") !== (missingSymbols.length > 0)) ||
      !["network", "fresh_cache", "stale_cache"].includes(value.cache_status as string) ||
      !["retrieved", "stale"].includes(value.freshness as string) ||
      ((value.cache_status === "stale_cache") !== (value.freshness === "stale")) ||
      parseUtcTimestamp(value.available_at) === null || parseUtcTimestamp(value.fetched_at) === null ||
      parseUtcTimestamp(value.source_observed_at) === null || parseUtcTimestamp(value.request_started_at) === null ||
      !isRecord(value.coverage) || !hasExactFields(value.coverage, new Set([
        "requested_start", "requested_end", "bar_count", "per_symbol", "gaps", "calendar_gaps_assessed",
      ])) || !Array.isArray(value.coverage.per_symbol) || !Array.isArray(value.coverage.gaps) ||
      value.coverage.calendar_gaps_assessed !== false ||
      !isRecord(value.action_coverage) || !hasExactFields(value.action_coverage, new Set([
        "dividends", "stock_splits", "symbol_renames",
      ])) || !Array.isArray(value.actions) || !Array.isArray(value.bars) || value.bars.length === 0 ||
      value.bars.length > YFINANCE_RESEARCH_MAX_PAGE_ROWS || !isRecord(value.provenance) ||
      !hasExactFields(value.provenance, BRIDGE_PROVENANCE_FIELDS)) return false;

  const innerRange = value.requested_range;
  if (!isRecord(innerRange) || !hasExactFields(innerRange, new Set(["start", "end", "semantics"])) ||
      innerRange.semantics !== "start_inclusive_end_exclusive" ||
      typeof innerRange.start !== "string" || !innerRange.start.endsWith("Z") ||
      typeof innerRange.end !== "string" || !innerRange.end.endsWith("Z") ||
      parseUtcTimestamp(innerRange.start) !== pageStart || parseUtcTimestamp(innerRange.end) !== pageEnd ||
      typeof value.coverage.requested_start !== "string" || !value.coverage.requested_start.endsWith("Z") ||
      typeof value.coverage.requested_end !== "string" || !value.coverage.requested_end.endsWith("Z") ||
      parseUtcTimestamp(value.coverage.requested_start) !== pageStart ||
      parseUtcTimestamp(value.coverage.requested_end) !== pageEnd ||
      typeof value.coverage.bar_count !== "number" || !Number.isSafeInteger(value.coverage.bar_count) ||
      value.coverage.bar_count !== value.bars.length) return false;

  const perSymbol = value.coverage.per_symbol;
  if (perSymbol.length !== request.symbols.length || !perSymbol.every((item) => isRecord(item) &&
      hasExactFields(item, new Set(["symbol", "bar_count", "first_bar_at", "last_bar_at", "gaps"])) &&
      typeof item.symbol === "string" && request.symbols.includes(item.symbol) &&
      typeof item.bar_count === "number" && Number.isSafeInteger(item.bar_count) && item.bar_count >= 0 &&
      (item.first_bar_at === null || parseUtcTimestamp(item.first_bar_at) !== null) &&
      (item.last_bar_at === null || parseUtcTimestamp(item.last_bar_at) !== null) &&
      Array.isArray(item.gaps) && item.gaps.length <= 8 && item.gaps.every((gap) =>
        typeof gap === "string" && gap.length > 0 && gap.length <= 64))) return false;
  if (new Set(perSymbol.map((item) => (item as Record<string, unknown>).symbol)).size !== request.symbols.length) return false;

  if (value.coverage.gaps.length > 72 || !value.coverage.gaps.every((gap) => isRecord(gap) &&
      (hasExactFields(gap, new Set(["code"])) || hasExactFields(gap, new Set(["code", "symbol"]))) &&
      typeof gap.code === "string" && gap.code.length > 0 && gap.code.length <= 64 &&
      (gap.symbol === undefined || (typeof gap.symbol === "string" && request.symbols.includes(gap.symbol))))) return false;

  const actionCoverage = value.action_coverage;
  if (!Object.keys(actionCoverage).every((key) => ["dividends", "stock_splits", "symbol_renames"].includes(key)) ||
      !["provider_field_present", "provider_field_unavailable"].includes(actionCoverage.dividends as string) ||
      !["provider_field_present", "provider_field_unavailable"].includes(actionCoverage.stock_splits as string) ||
      actionCoverage.symbol_renames !== "unsupported") return false;

  const provenance = value.provenance;
  if (typeof provenance.acquired_at !== "string" || parseUtcTimestamp(provenance.acquired_at) === null ||
      typeof provenance.adapter_version !== "string" || !provenance.adapter_version ||
      provenance.adjustment !== request.adjustment ||
      !["network", "fresh_cache", "stale_cache"].includes(provenance.cache_status as string) ||
      typeof provenance.config_fingerprint !== "string" || !SHA256.test(provenance.config_fingerprint) ||
      typeof provenance.end !== "string" || parseUtcTimestamp(provenance.end) !== pageEnd ||
      provenance.include_actions !== true || provenance.interval !== "1d" ||
      !isSymbolList(provenance.missing_symbols, request.symbols) ||
      provenance.prepost !== false || provenance.provider !== "yahoo_finance" ||
      typeof provenance.query_fingerprint !== "string" || !SHA256.test(provenance.query_fingerprint) ||
      provenance.cache_status !== value.cache_status ||
      typeof provenance.requested_at !== "string" || parseUtcTimestamp(provenance.requested_at) === null ||
      !symbolsEchoRequest(provenance.requested_symbols, request) ||
      !isSymbolList(provenance.returned_symbols, request.symbols) ||
      typeof provenance.row_count !== "number" || !Number.isSafeInteger(provenance.row_count) ||
      provenance.row_count !== value.bars.length || provenance.schema_version !== YFINANCE_BRIDGE_PROVENANCE_SCHEMA ||
      typeof provenance.served_at !== "string" || parseUtcTimestamp(provenance.served_at) === null ||
      provenance.source !== "yfinance" || typeof provenance.start !== "string" ||
      parseUtcTimestamp(provenance.start) !== pageStart) return false;

  const requestedAt = parseUtcTimestamp(provenance.requested_at);
  const acquiredAt = parseUtcTimestamp(provenance.acquired_at);
  const servedAt = parseUtcTimestamp(provenance.served_at);
  if (parseUtcTimestamp(value.request_started_at) !== requestedAt ||
      parseUtcTimestamp(value.source_observed_at) !== acquiredAt ||
      parseUtcTimestamp(value.available_at) !== servedAt ||
      parseUtcTimestamp(value.fetched_at) !== servedAt ||
      requestedAt === null || acquiredAt === null || servedAt === null ||
      requestedAt > acquiredAt || acquiredAt > servedAt) return false;

  for (const action of value.actions) {
    if (!isRecord(action) || typeof action.symbol !== "string" || !request.symbols.includes(action.symbol) ||
        action.source !== "Yahoo Finance") return false;
    const actionTime = parseUtcTimestamp(action.event_ts_utc);
    if (actionTime === null || actionTime < pageStart || actionTime >= pageEnd) return false;
    if (action.kind === "DIVIDEND") {
      if (!hasExactFields(action, new Set(["symbol", "event_ts_utc", "kind", "amount", "source"])) ||
          typeof action.amount !== "string" || !isDecimalOrNull(action.amount)) return false;
    } else if (action.kind === "SPLIT") {
      if (!hasExactFields(action, new Set(["symbol", "event_ts_utc", "kind", "ratio", "source"])) ||
          typeof action.ratio !== "string" || !isDecimalOrNull(action.ratio)) return false;
    } else {
      return false;
    }
  }

  let priorRowKey = "";
  for (const row of value.bars) {
    if (!isRecord(row) || !hasExactFields(row, BAR_FIELDS) || typeof row.symbol !== "string" ||
        !request.symbols.includes(row.symbol) || row.asset_class !== request.assetClass ||
        row.resolution !== "1d" || row.adjustment !== request.adjustment ||
        ![row.open, row.high, row.low, row.close, row.adj_close, row.volume, row.dividends, row.stock_splits]
        .every(isDecimalOrNull) || !isIntegerOrNull(row.volume)) return false;
    const eventTime = parseUtcTimestamp(row.event_ts_utc);
    if (eventTime === null || eventTime < pageStart || eventTime >= pageEnd) return false;
    const key = `${row.symbol}\u0000${eventTime}`;
    if (priorRowKey && key <= priorRowKey) return false;
    priorRowKey = key;
  }

  const actualSymbols = [...new Set(value.bars.map((bar) => (bar as Record<string, unknown>).symbol as string))].sort();
  const returnedSymbols = [...value.returned_symbols as string[]].sort();
  const missingSymbols = [...value.missing_symbols as string[]].sort();
  const expectedMissing = request.symbols.filter((symbol) => !actualSymbols.includes(symbol)).sort();
  if (actualSymbols.length !== returnedSymbols.length ||
      actualSymbols.some((symbol, index) => symbol !== returnedSymbols[index]) ||
      expectedMissing.length !== missingSymbols.length ||
      expectedMissing.some((symbol, index) => symbol !== missingSymbols[index]) ||
      (missingSymbols.length > 0 && value.status !== "partial")) return false;
  const provenanceReturned = [...value.provenance.returned_symbols as string[]].sort();
  const provenanceMissing = [...value.provenance.missing_symbols as string[]].sort();
  if (provenanceReturned.length !== returnedSymbols.length ||
      provenanceReturned.some((symbol, index) => symbol !== returnedSymbols[index]) ||
      provenanceMissing.length !== missingSymbols.length ||
      provenanceMissing.some((symbol, index) => symbol !== missingSymbols[index])) return false;

  for (const symbol of request.symbols) {
    const rows = value.bars.filter((bar) => (bar as Record<string, unknown>).symbol === symbol) as Array<Record<string, unknown>>;
    const summary = perSymbol.find((item) => (item as Record<string, unknown>).symbol === symbol) as Record<string, unknown>;
    if (summary.bar_count !== rows.length) return false;
    const times = rows.map((row) => parseUtcTimestamp(row.event_ts_utc)).filter((time): time is bigint => time !== null);
    const first = times.length > 0 ? times[0] : null;
    const last = times.length > 0 ? times[times.length - 1] : null;
    if ((first === null) !== (summary.first_bar_at === null) ||
        (last === null) !== (summary.last_bar_at === null) ||
        (first !== null && parseUtcTimestamp(summary.first_bar_at) !== first) ||
        (last !== null && parseUtcTimestamp(summary.last_bar_at) !== last)) return false;
  }
  return true;
}

export function validateYfinanceResearchResponse(
  value: unknown,
  request: ExpectedYfinanceResearchRequest,
): value is YfinanceResearchResponse {
  if (!isRecord(value) || !hasExactFields(value, TOP_LEVEL_FIELDS) ||
      value.schema_version !== YFINANCE_RESEARCH_SCHEMA || value.provider !== "yfinance" ||
      value.source !== "Yahoo Finance" || value.asset_class !== request.assetClass || value.resolution !== "1d" ||
      value.requested_adjustment !== request.adjustment || value.provider_adjustment_semantics !== "unknown_or_provider_native" ||
      value.adjustment_confirmed_raw !== false || value.numeric_encoding !== "binary_float_projection" ||
      value.canonical !== false || value.point_in_time !== false || value.executable !== false ||
      value.display_only !== true || value.mdp_coverage_asserted !== false ||
      !symbolsEchoRequest(value.requested_symbols, request) ||
      !isRecord(value.observation) || !hasExactFields(value.observation, new Set(["source_observation_sha256", "fetched_at_utc", "payload"])) ||
      typeof value.observation.source_observation_sha256 !== "string" || !SHA256.test(value.observation.source_observation_sha256) ||
      parseUtcTimestamp(value.observation.fetched_at_utc) === null ||
      (value.next_cursor !== null && (typeof value.next_cursor !== "string" || value.next_cursor.length === 0 ||
        new TextEncoder().encode(value.next_cursor).byteLength > YFINANCE_RESEARCH_MAX_CURSOR_BYTES ||
        Array.from(value.next_cursor).some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)))) {
    return false;
  }

  const requested = parseRange(value.requested_range);
  const page = parseRange(value.page_range);
  const expectedStart = parseUtcTimestamp(request.startUtc);
  const expectedEnd = parseUtcTimestamp(request.endUtc);
  const pageLimit = BigInt(YFINANCE_RESEARCH_MAX_PAGE_DAYS) * DAY_NS;
  if (!requested || !page || expectedStart === null || expectedEnd === null ||
      requested.start !== expectedStart || requested.end !== expectedEnd ||
      !rangeMatchesRequest(value.requested_range, request) ||
      page.start < requested.start || page.end > requested.end || page.end - page.start > pageLimit ||
      (request.cursor === null
        ? page.end !== requested.end || page.start !== (requested.start > requested.end - pageLimit ? requested.start : requested.end - pageLimit)
        : page.end > requested.end - pageLimit) ||
      (page.start === requested.start) !== (value.next_cursor === null) ||
      !validPayload(value.observation.payload, request, page.start, page.end)) return false;

  return true;
}
