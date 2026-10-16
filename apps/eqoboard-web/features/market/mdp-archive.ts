/**
 * Browser adapter for the fixed MDP archive V1 contract. Field names, schema
 * ID, and hash mirror the server-only validator at `lib/server/mdp-archive.ts`;
 * the BFF performs the full source/integrity validation before this decoder.
 * Upstream provenance: MIT, `web/lib/mdp-market-data.ts` in the OpenTerminal
 * package subtree,
 * source commit `aed097c680cd8ec1c391ae06966babe7d6d91fc6`, SHA-256
 * `80af4a52c785a939f3ae7604d7d9cf32f31ad83b6a88ea0f1a4b09c3dd1fcc96`;
 * notice: repository `LICENSE`.
 */
import { hasControlCharacters, hasOnlyEnumerableDataProperties } from "../data/validation";

export const MDP_BAR_SCHEMA_ID = "lqepoch.us_equity_trade_bar_1m.v1" as const;
export const MDP_BAR_SCHEMA_SHA256 =
  "5e761a91d880e0002aeafe6dc2083b7c8a0ff2ba486d5d93582fbb4479146cb0" as const;
export const MDP_BAR_MAX_ROWS = 390;

export type MdpDatasetNamespace = "diagnostic";
export type MdpSource = Readonly<{
  provider: string;
  feed: string;
  entitlement: "unknown" | "authorized" | "unauthorized";
  numeric_encoding: string;
  source_record_id?: string | null;
}>;

/** Existing snake_case MDP bar row; values remain exact decimal strings. */
export type TradeMinuteBarV1 = Readonly<{
  schema_version: 1;
  source_provider: string;
  source_feed: string;
  source_entitlement: MdpSource["entitlement"];
  source_numeric_encoding: string;
  symbol: string;
  bar_start_utc: string;
  bar_end_exclusive_utc: string;
  available_at_utc: string;
  trade_date: string;
  session_id: string;
  session_timezone: string;
  session_policy_id: string;
  session_policy_sha256: string;
  session_start_utc: string;
  session_end_exclusive_utc: string;
  window_start_utc: string;
  window_end_exclusive_utc: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trade_count: string;
  quote_events_excluded: string;
  source_timestamp_missing_rows: string;
  sequence_gap_count: string;
  late_event_count: string;
  window_expected_minutes: string;
  window_empty_trade_minutes: string;
  source_start_utc: string;
  source_end_exclusive_utc: string;
  window_input_eof: true;
  source_pages_exhausted: true | null;
  completion_mode: "synthetic_eof" | "historical_eof_paged" | "historical_eof_nonpaged";
  nbbo_input_status: "excluded";
}>;

export type MdpBarsResponseV1 = Readonly<{
  summary: Readonly<{
    namespace: MdpDatasetNamespace;
    dataset_id: string;
    schema_id: typeof MDP_BAR_SCHEMA_ID;
    source: MdpSource;
    row_count: string;
    returned_rows: string;
    content_sha256: string;
    parquet_schema_sha256: typeof MDP_BAR_SCHEMA_SHA256;
    cache_hit: boolean;
  }>;
  rows: readonly TradeMinuteBarV1[];
}>;

export type MdpBarsExpectedRequest = Readonly<{ datasetId: string; symbol: string }>;

const SUMMARY_FIELDS = [
  "namespace",
  "dataset_id",
  "schema_id",
  "source",
  "row_count",
  "returned_rows",
  "content_sha256",
  "parquet_schema_sha256",
  "cache_hit",
] as const;
const SOURCE_FIELDS = [
  "provider",
  "feed",
  "entitlement",
  "numeric_encoding",
  "source_record_id",
] as const;
const SOURCE_REQUIRED_FIELDS = ["provider", "feed", "entitlement", "numeric_encoding"] as const;
const ROW_FIELDS = [
  "schema_version",
  "source_provider",
  "source_feed",
  "source_entitlement",
  "source_numeric_encoding",
  "symbol",
  "bar_start_utc",
  "bar_end_exclusive_utc",
  "available_at_utc",
  "trade_date",
  "session_id",
  "session_timezone",
  "session_policy_id",
  "session_policy_sha256",
  "session_start_utc",
  "session_end_exclusive_utc",
  "window_start_utc",
  "window_end_exclusive_utc",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "trade_count",
  "quote_events_excluded",
  "source_timestamp_missing_rows",
  "sequence_gap_count",
  "late_event_count",
  "window_expected_minutes",
  "window_empty_trade_minutes",
  "source_start_utc",
  "source_end_exclusive_utc",
  "window_input_eof",
  "source_pages_exhausted",
  "completion_mode",
  "nbbo_input_status",
] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const SYMBOL = /^[A-Z0-9.-]{1,16}$/u;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const U64 = /^(0|[1-9][0-9]*)$/u;
const U64_MAX = 18_446_744_073_709_551_615n;
const NUMERIC_ENCODINGS = new Set([
  "decimal_token",
  "integer_token",
  "binary_float64_shortest_decimal",
  "binary_float32_shortest_decimal",
  "raw_messagepack_bytes",
  "raw_json_bytes",
]);
const MINUTE_NS = 60_000_000_000n;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return hasOnlyEnumerableDataProperties(value);
  } catch {
    return false;
  }
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function validLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacters(value)
  );
}

function utcNanoseconds(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!match) return null;
  const [, date, hour, minute, second, fraction = ""] = match;
  const base = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  if (
    !Number.isFinite(base) ||
    new Date(base).toISOString().slice(0, 19) !== `${date}T${hour}:${minute}:${second}`
  )
    return null;
  return BigInt(base) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function validUtc(value: unknown): value is string {
  return utcNanoseconds(value) !== null;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validU64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 20 || !U64.test(value)) return false;
  try {
    return BigInt(value) <= U64_MAX;
  } catch {
    return false;
  }
}

function compareDecimal(left: string, right: string): number {
  const parts = (value: string) => {
    const negative = value.startsWith("-");
    const [integer = "", fraction = ""] = (negative ? value.slice(1) : value).split(".");
    return { negative, integer: integer.replace(/^0+/, "") || "0", fraction };
  };
  const a = parts(left);
  const b = parts(right);
  const aZero = a.integer === "0" && /^0*$/.test(a.fraction);
  const bZero = b.integer === "0" && /^0*$/.test(b.fraction);
  const aNegative = a.negative && !aZero;
  const bNegative = b.negative && !bZero;
  if (aNegative !== bNegative) return aNegative ? -1 : 1;
  let magnitude =
    a.integer === b.integer
      ? 0
      : a.integer.length === b.integer.length
        ? a.integer < b.integer
          ? -1
          : 1
        : a.integer.length < b.integer.length
          ? -1
          : 1;
  if (magnitude === 0) {
    const width = Math.max(a.fraction.length, b.fraction.length);
    const af = a.fraction.padEnd(width, "0");
    const bf = b.fraction.padEnd(width, "0");
    magnitude = af === bf ? 0 : af < bf ? -1 : 1;
  }
  return aNegative ? -magnitude : magnitude;
}

function validSource(value: unknown): value is MdpSource {
  if (
    !plainRecord(value) ||
    !onlyFields(value, SOURCE_FIELDS) ||
    !SOURCE_REQUIRED_FIELDS.every((field) => Object.hasOwn(value, field))
  )
    return false;
  return (
    validLabel(value.provider, 128) &&
    validLabel(value.feed, 64) &&
    ["unknown", "authorized", "unauthorized"].includes(value.entitlement as string) &&
    typeof value.numeric_encoding === "string" &&
    NUMERIC_ENCODINGS.has(value.numeric_encoding) &&
    (value.source_record_id === undefined ||
      value.source_record_id === null ||
      validLabel(value.source_record_id, 256))
  );
}

function validBar(value: unknown, symbol: string, source: MdpSource): value is TradeMinuteBarV1 {
  if (
    !plainRecord(value) ||
    !exactFields(value, ROW_FIELDS) ||
    value.schema_version !== 1 ||
    value.symbol !== symbol ||
    value.source_provider !== source.provider ||
    value.source_feed !== source.feed ||
    value.source_entitlement !== source.entitlement ||
    value.source_numeric_encoding !== source.numeric_encoding ||
    !validLabel(value.source_provider, 128) ||
    !validLabel(value.source_feed, 64) ||
    typeof value.source_numeric_encoding !== "string" ||
    !NUMERIC_ENCODINGS.has(value.source_numeric_encoding) ||
    !["unknown", "authorized", "unauthorized"].includes(value.source_entitlement as string) ||
    !validUtc(value.bar_start_utc) ||
    !validUtc(value.bar_end_exclusive_utc) ||
    !validUtc(value.available_at_utc) ||
    !validUtc(value.session_start_utc) ||
    !validUtc(value.session_end_exclusive_utc) ||
    !validUtc(value.window_start_utc) ||
    !validUtc(value.window_end_exclusive_utc) ||
    !validUtc(value.source_start_utc) ||
    !validUtc(value.source_end_exclusive_utc) ||
    !validIsoDate(value.trade_date) ||
    !["session_id", "session_timezone", "session_policy_id"].every((key) =>
      validLabel(value[key], key === "session_id" || key === "session_policy_id" ? 256 : 128),
    ) ||
    !SHA256.test(String(value.session_policy_sha256)) ||
    value.window_input_eof !== true ||
    value.nbbo_input_status !== "excluded" ||
    (value.source_pages_exhausted !== null && value.source_pages_exhausted !== true) ||
    !["synthetic_eof", "historical_eof_paged", "historical_eof_nonpaged"].includes(
      value.completion_mode as string,
    )
  )
    return false;

  const decimalFields = ["open", "high", "low", "close", "volume"] as const;
  if (
    decimalFields.some(
      (field) =>
        typeof value[field] !== "string" ||
        value[field].length > 128 ||
        !DECIMAL.test(value[field] as string),
    ) ||
    [
      "trade_count",
      "quote_events_excluded",
      "source_timestamp_missing_rows",
      "sequence_gap_count",
      "late_event_count",
      "window_expected_minutes",
      "window_empty_trade_minutes",
    ].some((field) => !validU64(value[field]))
  )
    return false;

  const barStart = utcNanoseconds(value.bar_start_utc);
  const barEnd = utcNanoseconds(value.bar_end_exclusive_utc);
  const available = utcNanoseconds(value.available_at_utc);
  const sessionStart = utcNanoseconds(value.session_start_utc);
  const sessionEnd = utcNanoseconds(value.session_end_exclusive_utc);
  const windowStart = utcNanoseconds(value.window_start_utc);
  const windowEnd = utcNanoseconds(value.window_end_exclusive_utc);
  const sourceStart = utcNanoseconds(value.source_start_utc);
  const sourceEnd = utcNanoseconds(value.source_end_exclusive_utc);
  if (
    barStart === null ||
    barEnd === null ||
    available === null ||
    sessionStart === null ||
    sessionEnd === null ||
    windowStart === null ||
    windowEnd === null ||
    sourceStart === null ||
    sourceEnd === null
  )
    return false;
  if (
    barEnd - barStart !== MINUTE_NS ||
    barStart % MINUTE_NS !== 0n ||
    available < barEnd ||
    sessionStart >= sessionEnd ||
    windowStart < sessionStart ||
    windowEnd > sessionEnd ||
    windowStart >= windowEnd ||
    barStart < windowStart ||
    barEnd > windowEnd ||
    sourceStart < barStart ||
    sourceEnd <= sourceStart ||
    sourceEnd > barEnd
  )
    return false;

  const expected = BigInt(value.window_expected_minutes as string);
  const empty = BigInt(value.window_empty_trade_minutes as string);
  if (
    expected <= 0n ||
    expected > 390n ||
    empty >= expected ||
    BigInt(value.trade_count as string) === 0n ||
    BigInt(value.source_timestamp_missing_rows as string) !== 0n ||
    BigInt(value.sequence_gap_count as string) !== 0n ||
    BigInt(value.late_event_count as string) !== 0n ||
    compareDecimal(value.low as string, "0") <= 0 ||
    compareDecimal(value.volume as string, "0") <= 0 ||
    compareDecimal(value.open as string, value.high as string) > 0 ||
    compareDecimal(value.high as string, value.low as string) < 0 ||
    compareDecimal(value.close as string, value.high as string) > 0 ||
    compareDecimal(value.low as string, value.close as string) > 0
  )
    return false;

  if (value.completion_mode === "synthetic_eof") {
    return (
      source.provider === "synthetic" &&
      source.feed === "synthetic" &&
      source.entitlement === "unknown" &&
      source.numeric_encoding === "decimal_token" &&
      value.source_pages_exhausted === null
    );
  }
  if (value.completion_mode === "historical_eof_paged")
    return source.provider !== "synthetic" && value.source_pages_exhausted === true;
  return source.provider !== "synthetic" && value.source_pages_exhausted === null;
}

/** Validates the fixed diagnostic page identity and browser-facing V1 shape. */
export function decodeMdpBarsResponse(
  value: unknown,
  expected: MdpBarsExpectedRequest,
): MdpBarsResponseV1 | null {
  if (
    !plainRecord(value) ||
    !exactFields(value, ["summary", "rows"]) ||
    !plainRecord(value.summary) ||
    !exactFields(value.summary, SUMMARY_FIELDS) ||
    !Array.isArray(value.rows) ||
    value.rows.length > MDP_BAR_MAX_ROWS ||
    !SYMBOL.test(expected.symbol) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(expected.datasetId)
  )
    return null;

  const summary = value.summary;
  const source = summary.source;
  if (
    summary.namespace !== "diagnostic" ||
    summary.dataset_id !== expected.datasetId ||
    summary.schema_id !== MDP_BAR_SCHEMA_ID ||
    !validSource(source) ||
    !validU64(summary.row_count) ||
    !validU64(summary.returned_rows) ||
    !SHA256.test(String(summary.content_sha256)) ||
    summary.parquet_schema_sha256 !== MDP_BAR_SCHEMA_SHA256 ||
    typeof summary.cache_hit !== "boolean"
  )
    return null;

  const rowCount = BigInt(summary.row_count as string);
  const returnedRows = BigInt(summary.returned_rows as string);
  if (rowCount < returnedRows || returnedRows !== BigInt(value.rows.length)) return null;
  const rows = value.rows as TradeMinuteBarV1[];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || !validBar(row, expected.symbol, source)) return null;
  }
  if (rows.length > 0) {
    const first = rows[0];
    if (!first) return null;
    const expectedBars =
      BigInt(first.window_expected_minutes) - BigInt(first.window_empty_trade_minutes);
    if (expectedBars !== BigInt(rows.length)) return null;
    const identity = [
      first.trade_date,
      first.session_id,
      first.session_start_utc,
      first.session_end_exclusive_utc,
      first.window_start_utc,
      first.window_end_exclusive_utc,
      first.available_at_utc,
      first.session_policy_id,
      first.session_policy_sha256,
      first.session_timezone,
      first.window_input_eof,
      first.completion_mode,
      first.source_pages_exhausted,
      first.window_expected_minutes,
      first.window_empty_trade_minutes,
    ].join("\u0000");
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (!previous || !current) return null;
      const currentIdentity = [
        current.trade_date,
        current.session_id,
        current.session_start_utc,
        current.session_end_exclusive_utc,
        current.window_start_utc,
        current.window_end_exclusive_utc,
        current.available_at_utc,
        current.session_policy_id,
        current.session_policy_sha256,
        current.session_timezone,
        current.window_input_eof,
        current.completion_mode,
        current.source_pages_exhausted,
        current.window_expected_minutes,
        current.window_empty_trade_minutes,
      ].join("\u0000");
      const previousStart = utcNanoseconds(previous.bar_start_utc);
      const currentStart = utcNanoseconds(current.bar_start_utc);
      if (
        previousStart === null ||
        currentStart === null ||
        currentIdentity !== identity ||
        previousStart >= currentStart
      )
        return null;
    }
  }
  return value as unknown as MdpBarsResponseV1;
}
