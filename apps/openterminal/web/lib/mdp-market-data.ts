import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeMdpMarketDataRequest } from "@/lib/eqo-auth";
import { readLimitedResponse } from "@/lib/http-response";

export const MDP_BAR_SCHEMA_ID = "lqepoch.us_equity_trade_bar_1m.v1";
export const MDP_BAR_SCHEMA_SHA256 = "5e761a91d880e0002aeafe6dc2083b7c8a0ff2ba486d5d93582fbb4479146cb0";

const MAX_DATASET_ID_LENGTH = 128;
const MAX_QUERY_LENGTH = 512;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_ROWS = 390;
const UPSTREAM_DEADLINE_MS = 125_000;
const U64_MAX = (1n << 64n) - 1n;
const MINUTE_NS = 60_000_000_000n;
const SHA256 = /^[0-9a-f]{64}$/;
const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SYMBOL = /^[A-Z0-9.-]{1,16}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const NUMERIC_ENCODINGS = new Set([
  "decimal_token",
  "integer_token",
  "binary_float64_shortest_decimal",
  "binary_float32_shortest_decimal",
  "raw_messagepack_bytes",
  "raw_json_bytes",
]);

const BAR_FIELDS = [
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

const SOURCE_REQUIRED_FIELDS = ["provider", "feed", "entitlement", "numeric_encoding"] as const;
const SOURCE_ALLOWED_FIELDS = new Set([...SOURCE_REQUIRED_FIELDS, "source_record_id"]);

export type MdpDatasetNamespace = "diagnostic" | "curated";

type MdpSource = {
  provider: string;
  feed: string;
  entitlement: "unknown" | "authorized" | "unauthorized";
  numeric_encoding: string;
  source_record_id?: string | null;
};

type TradeMinuteBarV1 = Record<(typeof BAR_FIELDS)[number], unknown>;

type MdpBarsResponseV1 = {
  summary: {
    namespace: MdpDatasetNamespace;
    dataset_id: string;
    schema_id: typeof MDP_BAR_SCHEMA_ID;
    source: MdpSource;
    row_count: string;
    returned_rows: string;
    content_sha256: string;
    parquet_schema_sha256: typeof MDP_BAR_SCHEMA_SHA256;
    cache_hit: boolean;
  };
  rows: TradeMinuteBarV1[];
};

type ExpectedRequest = {
  datasetId: string;
  namespace: MdpDatasetNamespace;
  symbol: string;
};

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function validLabel(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
}

function parseWireU64(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= U64_MAX ? parsed : null;
  } catch {
    return null;
  }
}

function parseUtcNanoseconds(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, date, hour, minute, second, fractional = ""] = match;
  const base = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 19) !== `${date}T${hour}:${minute}:${second}`) {
    return null;
  }
  return BigInt(base) * 1_000_000n + BigInt(fractional.padEnd(9, "0"));
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

type DecimalParts = { negative: boolean; integer: string; fraction: string };

function decimalParts(value: unknown): DecimalParts | null {
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  return { negative, integer, fraction };
}

function compareDecimals(leftValue: unknown, rightValue: unknown): number | null {
  const left = decimalParts(leftValue);
  const right = decimalParts(rightValue);
  if (!left || !right) return null;
  const leftZero = /^0+$/.test(left.integer) && /^0*$/.test(left.fraction);
  const rightZero = /^0+$/.test(right.integer) && /^0*$/.test(right.fraction);
  const leftNegative = left.negative && !leftZero;
  const rightNegative = right.negative && !rightZero;
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;

  const leftInteger = left.integer.replace(/^0+/, "") || "0";
  const rightInteger = right.integer.replace(/^0+/, "") || "0";
  let magnitude = leftInteger === rightInteger ? 0
    : leftInteger.length === rightInteger.length
      ? leftInteger < rightInteger ? -1 : 1
      : leftInteger.length < rightInteger.length ? -1 : 1;
  if (magnitude === 0) {
    const width = Math.max(left.fraction.length, right.fraction.length);
    const leftFraction = left.fraction.padEnd(width, "0");
    const rightFraction = right.fraction.padEnd(width, "0");
    magnitude = leftFraction === rightFraction ? 0 : leftFraction < rightFraction ? -1 : 1;
  }
  return leftNegative ? -magnitude : magnitude;
}

function validSource(value: unknown): value is MdpSource {
  if (!isRecord(value) || !hasOnlyFields(value, SOURCE_ALLOWED_FIELDS) ||
      !SOURCE_REQUIRED_FIELDS.every((field) => Object.hasOwn(value, field))) return false;
  if (!validLabel(value.provider, 128) || !validLabel(value.feed, 64) ||
      !["unknown", "authorized", "unauthorized"].includes(value.entitlement as string) ||
      typeof value.numeric_encoding !== "string" || !NUMERIC_ENCODINGS.has(value.numeric_encoding)) return false;
  return value.source_record_id === undefined || value.source_record_id === null ||
    validLabel(value.source_record_id, 256);
}

function validBar(value: unknown, symbol: string, source: MdpSource): value is TradeMinuteBarV1 {
  if (!isRecord(value) || !hasExactFields(value, BAR_FIELDS) || value.schema_version !== 1 ||
      value.symbol !== symbol || value.source_provider !== source.provider || value.source_feed !== source.feed ||
      value.source_entitlement !== source.entitlement || value.source_numeric_encoding !== source.numeric_encoding ||
      !validLabel(value.source_provider, 128) || !validLabel(value.source_feed, 64) ||
      !["unknown", "authorized", "unauthorized"].includes(value.source_entitlement as string) ||
      typeof value.source_numeric_encoding !== "string" || !NUMERIC_ENCODINGS.has(value.source_numeric_encoding) ||
      !validLabel(value.session_id, 256) || !validLabel(value.session_timezone, 128) ||
      !validLabel(value.session_policy_id, 256) || !SHA256.test(String(value.session_policy_sha256)) ||
      !isIsoDate(value.trade_date) || value.window_input_eof !== true || value.nbbo_input_status !== "excluded") {
    return false;
  }

  const times = [
    value.bar_start_utc,
    value.bar_end_exclusive_utc,
    value.available_at_utc,
    value.session_start_utc,
    value.session_end_exclusive_utc,
    value.window_start_utc,
    value.window_end_exclusive_utc,
    value.source_start_utc,
    value.source_end_exclusive_utc,
  ].map(parseUtcNanoseconds);
  if (times.some((time) => time === null)) return false;
  const [barStart, barEnd, availableAt, sessionStart, sessionEnd, windowStart, windowEnd, sourceStart, sourceEnd] =
    times as bigint[];
  if (barEnd - barStart !== MINUTE_NS || barStart % MINUTE_NS !== 0n || availableAt < barEnd ||
      sessionStart >= sessionEnd || windowStart >= windowEnd || windowStart < sessionStart ||
      windowEnd > sessionEnd || barStart < windowStart || barEnd > windowEnd ||
      (barStart - windowStart) % MINUTE_NS !== 0n ||
      (windowStart - sessionStart) % MINUTE_NS !== 0n || (sessionEnd - sessionStart) % MINUTE_NS !== 0n ||
      sourceStart < barStart || sourceEnd <= sourceStart || sourceEnd > barEnd) return false;

  const expectedMinutes = parseWireU64(value.window_expected_minutes);
  const emptyMinutes = parseWireU64(value.window_empty_trade_minutes);
  const expectedRows = expectedMinutes !== null && emptyMinutes !== null
    ? expectedMinutes - emptyMinutes
    : null;
  const tradeCount = parseWireU64(value.trade_count);
  const quoteCount = parseWireU64(value.quote_events_excluded);
  const missingTimestamps = parseWireU64(value.source_timestamp_missing_rows);
  const gaps = parseWireU64(value.sequence_gap_count);
  const lateEvents = parseWireU64(value.late_event_count);
  if (expectedMinutes === null || emptyMinutes === null || tradeCount === null || quoteCount === null ||
      expectedRows === null || missingTimestamps === null || gaps === null || lateEvents === null || tradeCount === 0n ||
      expectedMinutes === 0n || expectedMinutes > 390n || expectedRows <= 0n ||
      missingTimestamps !== 0n || gaps !== 0n || lateEvents !== 0n ||
      (windowEnd - windowStart) / MINUTE_NS !== expectedMinutes ||
      (windowEnd - windowStart) % MINUTE_NS !== 0n) return false;

  if (value.source_pages_exhausted !== null && value.source_pages_exhausted !== true) return false;
  const mode = value.completion_mode;
  if (mode === "synthetic_eof") {
    if (source.provider !== "synthetic" || source.feed !== "synthetic" ||
        source.entitlement !== "unknown" || source.numeric_encoding !== "decimal_token" ||
        value.source_pages_exhausted !== null) return false;
  } else if (mode === "historical_eof_paged") {
    if (source.provider === "synthetic" || value.source_pages_exhausted !== true) return false;
  } else if (mode === "historical_eof_nonpaged") {
    if (source.provider === "synthetic" || value.source_pages_exhausted !== null) return false;
  } else {
    return false;
  }

  const openHigh = compareDecimals(value.open, value.high);
  const highLow = compareDecimals(value.high, value.low);
  const lowOpen = compareDecimals(value.low, value.open);
  const closeHigh = compareDecimals(value.close, value.high);
  const lowClose = compareDecimals(value.low, value.close);
  const lowZero = compareDecimals(value.low, "0");
  const volumeZero = compareDecimals(value.volume, "0");
  return openHigh !== null && highLow !== null && lowOpen !== null &&
    closeHigh !== null && lowClose !== null && lowZero !== null && volumeZero !== null &&
    openHigh <= 0 && highLow >= 0 && lowOpen <= 0 &&
    closeHigh <= 0 && lowClose <= 0 && lowZero > 0 && volumeZero > 0 &&
    decimalParts(value.volume) !== null && quoteCount <= U64_MAX;
}

export function validateMdpBarsResponse(value: unknown, expected: ExpectedRequest): MdpBarsResponseV1 | null {
  if (!isRecord(value) || !hasExactFields(value, ["summary", "rows"]) ||
      !isRecord(value.summary) || !hasExactFields(value.summary, SUMMARY_FIELDS) ||
      !Array.isArray(value.rows) || value.rows.length > MAX_RESPONSE_ROWS) return null;

  const summary = value.summary;
  const source = summary.source;
  if (summary.namespace !== expected.namespace || summary.dataset_id !== expected.datasetId ||
      summary.schema_id !== MDP_BAR_SCHEMA_ID || !validSource(source) ||
      typeof summary.row_count !== "string" || typeof summary.returned_rows !== "string" ||
      !SHA256.test(String(summary.content_sha256)) || summary.parquet_schema_sha256 !== MDP_BAR_SCHEMA_SHA256 ||
      typeof summary.cache_hit !== "boolean") return null;
  const rowCount = parseWireU64(summary.row_count);
  const returnedRows = parseWireU64(summary.returned_rows);
  if (rowCount === null || returnedRows === null || rowCount < returnedRows ||
      returnedRows !== BigInt(value.rows.length) || returnedRows > BigInt(MAX_RESPONSE_ROWS)) return null;

  let previousStart: bigint | null = null;
  let firstWindowIdentity: string | null = null;
  let firstWindowStart: bigint | null = null;
  let firstWindowEnd: bigint | null = null;
  let expectedWindowRows: bigint | null = null;
  for (const row of value.rows) {
    if (!validBar(row, expected.symbol, source)) return null;
    const start = parseUtcNanoseconds(row.bar_start_utc);
    const windowStart = parseUtcNanoseconds(row.window_start_utc);
    const windowEnd = parseUtcNanoseconds(row.window_end_exclusive_utc);
    const rowExpectedMinutes = parseWireU64(row.window_expected_minutes);
    const rowEmptyMinutes = parseWireU64(row.window_empty_trade_minutes);
    const rowExpectedRows = rowExpectedMinutes !== null && rowEmptyMinutes !== null
      ? rowExpectedMinutes - rowEmptyMinutes
      : null;
    if (start === null || windowStart === null || windowEnd === null || rowExpectedMinutes === null ||
        rowExpectedRows === null || (previousStart !== null && start <= previousStart)) return null;
    previousStart = start;
    const windowIdentity = [
      row.trade_date,
      row.session_id,
      row.session_start_utc,
      row.session_end_exclusive_utc,
      row.window_start_utc,
      row.window_end_exclusive_utc,
      row.available_at_utc,
      row.session_policy_id,
      row.session_policy_sha256,
      row.session_timezone,
      row.window_input_eof,
      row.completion_mode,
      row.source_pages_exhausted,
      row.window_expected_minutes,
      row.window_empty_trade_minutes,
    ].join("\u0000");
    if (firstWindowIdentity !== null && firstWindowIdentity !== windowIdentity) return null;
    firstWindowIdentity = windowIdentity;
    if (firstWindowStart !== null &&
        (firstWindowStart !== windowStart || firstWindowEnd !== windowEnd ||
          expectedWindowRows !== rowExpectedRows)) return null;
    firstWindowStart = windowStart;
    firstWindowEnd = windowEnd;
    expectedWindowRows = rowExpectedRows;
  }
  if (value.rows.length > 0 &&
      (expectedWindowRows !== BigInt(value.rows.length) || firstWindowStart === null || firstWindowEnd === null)) return null;
  return value as unknown as MdpBarsResponseV1;
}

function mdpBaseUrl(): URL | null {
  const raw = process.env.EQO_MDP_URL;
  if (!raw || raw.length > 2_048 || raw.trim() !== raw) return null;
  try {
    const base = new URL(raw);
    if ((base.protocol !== "https:" && base.protocol !== "http:") ||
        base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
        (raw !== base.origin && raw !== `${base.origin}/`)) return null;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.protocol === "http:" && !loopback && base.hostname !== "market-data-platform") return null;
    return new URL(base.origin);
  } catch {
    return null;
  }
}

function normalizedQuery(request: NextRequest): { namespace: MdpDatasetNamespace; symbol: string } | null {
  if (request.nextUrl.search.length > MAX_QUERY_LENGTH) return null;
  const params = request.nextUrl.searchParams;
  const keys = [...params.keys()];
  if (keys.length !== 2 || keys.some((key) => !["namespace", "symbol"].includes(key)) ||
      params.getAll("namespace").length !== 1 || params.getAll("symbol").length !== 1) return null;
  const namespace = params.get("namespace");
  const symbol = params.get("symbol");
  if ((namespace !== "diagnostic" && namespace !== "curated") || !symbol || !SYMBOL.test(symbol)) return null;
  return { namespace, symbol };
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readJsonResponse(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    cancelBody(response);
    return null;
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(MAX_RESPONSE_BYTES))) {
    cancelBody(response);
    return null;
  }
  try {
    const bytes = await readLimitedResponse(response, MAX_RESPONSE_BYTES);
    if (bytes === null) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    cancelBody(response);
    return null;
  }
}

function mapUpstreamFailure(status: number): NextResponse {
  if (status === 413) return jsonError(413, "result_limit_exceeded");
  if (status === 504) return jsonError(504, "query_timeout");
  return jsonError(503, "market_data_service_unavailable");
}

/**
 * Server-only BFF route implementation for the current diagnostic V1 API.
 * The V1 payload has no typed completion evidence, so this proxy never admits
 * a curated namespace and never promotes an unknown source to a live status.
 */
export async function proxyMdpBars(
  request: NextRequest,
  datasetId: string,
): Promise<NextResponse> {
  const authorization = await authorizeMdpMarketDataRequest(request);
  if (!authorization.ok) return authorization.response;

  if (datasetId.length > MAX_DATASET_ID_LENGTH || !DATASET_ID.test(datasetId)) {
    return jsonError(400, "invalid_request");
  }
  const query = normalizedQuery(request);
  if (!query) return jsonError(400, "invalid_request");
  if (query.namespace === "curated") return jsonError(403, "not_authorized");

  const base = mdpBaseUrl();
  if (!base) return jsonError(503, "market_data_service_unavailable");

  const upstreamUrl = new URL(`/v1/datasets/${encodeURIComponent(datasetId)}/bars`, base);
  upstreamUrl.searchParams.set("namespace", query.namespace);
  upstreamUrl.searchParams.set("symbol", query.symbol);

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
        Accept: "application/json",
        Authorization: `Bearer ${authorization.token}`,
        "X-Request-ID": randomUUID(),
      },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status !== 200) {
      cancelBody(upstream);
      return mapUpstreamFailure(upstream.status);
    }

    const body = await readJsonResponse(upstream);
    if (body === null) {
      return deadlineExpired
        ? jsonError(504, "query_timeout")
        : jsonError(502, "invalid_market_data_response");
    }
    const validated = validateMdpBarsResponse(body, {
      datasetId,
      namespace: query.namespace,
      symbol: query.symbol,
    });
    if (!validated) return jsonError(502, "invalid_market_data_response");

    return NextResponse.json(validated, {
      status: 200,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return deadlineExpired
      ? jsonError(504, "query_timeout")
      : jsonError(503, "market_data_service_unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}
