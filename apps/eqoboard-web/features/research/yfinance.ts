import {
  projectChartRows,
  type ChartDisplayEvidence,
  type ChartPlotBar,
  type ChartStyle,
  type IndicatorId,
} from "@/charts";
import {
  expectedYfinanceResearchRequest,
  isYfinanceResearchSymbol,
  YFINANCE_RESEARCH_MAX_PAGES,
  YFINANCE_RESEARCH_MAX_RANGE_DAYS,
  validateYfinanceResearchResponse,
  type YfinanceResearchInput,
  type YfinanceResearchResponse,
} from "./yfinance-contract";
export { isYfinanceResearchSymbol } from "./yfinance-contract";
export { YFINANCE_RESEARCH_MAX_PAGES };

export const YFINANCE_RESEARCH_RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
export type YfinanceResearchRange = (typeof YFINANCE_RESEARCH_RANGES)[number];
const YFINANCE_RESEARCH_EARLIEST_SUPPORTED_MS = Date.UTC(1970, 0, 1);

export type YfinanceResearchConfigV1 = Readonly<{
  schemaVersion: 1;
  symbol: string;
  assetClass: "stock" | "etf";
  range: YfinanceResearchRange;
  adjustment: "unadjusted" | "adjusted";
  style: ChartStyle;
  showVolume: boolean;
  indicators: readonly IndicatorId[];
}>;

export const DEFAULT_YFINANCE_RESEARCH_CONFIG: YfinanceResearchConfigV1 = Object.freeze({
  schemaVersion: 1,
  symbol: "",
  assetClass: "stock",
  range: "1M",
  adjustment: "unadjusted",
  style: "candles",
  showVolume: true,
  indicators: Object.freeze<IndicatorId[]>(["SMA20"]),
});

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const INDICATORS = new Set<IndicatorId>([
  "SMA20",
  "SMA50",
  "SMA200",
  "EMA20",
  "VWAP",
  "RSI",
  "MACD",
  "BOLL",
]);
const STYLES = new Set<ChartStyle>(["candles", "bars", "line", "area"]);

/** Use only the server-authored distinct-host origin for the Research portal link. */
export function buildYahooResearchPageHref(
  origin: string | null | undefined,
  symbol: string,
  currentHostname: string,
): string | null {
  if (!isYfinanceResearchSymbol(symbol) || !origin) return null;
  try {
    const url = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.hostname.toLowerCase() === currentHostname.toLowerCase()
    )
      return null;
    return new URL(`/research/yfinance/${encodeURIComponent(symbol)}`, url.origin).toString();
  } catch {
    return null;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some((key) => {
        if (typeof key !== "string") return true;
        const descriptor = descriptors[key];
        return !descriptor?.enumerable || !("value" in descriptor);
      })
    )
      return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseYfinanceResearchConfig(
  value: unknown,
):
  | Readonly<{ ok: true; value: YfinanceResearchConfigV1 }>
  | Readonly<{ ok: false; code: "config-invalid"; field?: string }> {
  const config = plainRecord(value);
  const fields = [
    "schemaVersion",
    "symbol",
    "assetClass",
    "range",
    "adjustment",
    "style",
    "showVolume",
    "indicators",
  ];
  if (
    !config ||
    Reflect.ownKeys(config).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(config, field)) ||
    Reflect.ownKeys(config).some((field) => typeof field !== "string" || !fields.includes(field))
  ) {
    return { ok: false, code: "config-invalid" };
  }
  if (config.schemaVersion !== 1)
    return { ok: false, code: "config-invalid", field: "schemaVersion" };
  if (
    typeof config.symbol !== "string" ||
    config.symbol !== config.symbol.trim() ||
    config.symbol.length > 12 ||
    (config.symbol !== "" && !SYMBOL.test(config.symbol))
  )
    return { ok: false, code: "config-invalid", field: "symbol" };
  if (config.assetClass !== "stock" && config.assetClass !== "etf")
    return { ok: false, code: "config-invalid", field: "assetClass" };
  if (!YFINANCE_RESEARCH_RANGES.includes(config.range as YfinanceResearchRange))
    return { ok: false, code: "config-invalid", field: "range" };
  if (config.adjustment !== "unadjusted" && config.adjustment !== "adjusted")
    return { ok: false, code: "config-invalid", field: "adjustment" };
  if (typeof config.style !== "string" || !STYLES.has(config.style as ChartStyle))
    return { ok: false, code: "config-invalid", field: "style" };
  if (typeof config.showVolume !== "boolean")
    return { ok: false, code: "config-invalid", field: "showVolume" };
  if (
    !Array.isArray(config.indicators) ||
    config.indicators.length > 8 ||
    config.indicators.some(
      (item) => typeof item !== "string" || !INDICATORS.has(item as IndicatorId),
    ) ||
    new Set(config.indicators).size !== config.indicators.length
  )
    return { ok: false, code: "config-invalid", field: "indicators" };
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    symbol: config.symbol,
    assetClass: config.assetClass,
    range: config.range,
    adjustment: config.adjustment,
    style: config.style as ChartStyle,
    showVolume: config.showVolume,
    indicators: Object.freeze([...config.indicators]) as readonly IndicatorId[],
  });
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 8 * 1024)
    return { ok: false, code: "config-invalid" };
  return { ok: true, value: parsed as YfinanceResearchConfigV1 };
}

function rangeDays(range: YfinanceResearchRange): number {
  switch (range) {
    case "1D":
      return 7;
    case "5D":
      return 14;
    case "1M":
      return 45;
    case "6M":
      return 200;
    case "1Y":
      return 370;
    case "5Y":
      return 1_850;
    case "MAX":
      return YFINANCE_RESEARCH_MAX_RANGE_DAYS;
    case "YTD":
      return 1;
  }
}

/** Builds a UTC midnight-exclusive daily window; the current incomplete UTC day is excluded. */
export function buildYfinanceResearchInput(
  config: Pick<YfinanceResearchConfigV1, "symbol" | "assetClass" | "range" | "adjustment">,
  activeSymbol: string | undefined,
  nowMs: number,
  cursor?: string,
): YfinanceResearchInput | null {
  const symbol = config.symbol || activeSymbol || "";
  if (!SYMBOL.test(symbol) || !Number.isSafeInteger(nowMs)) return null;
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) return null;
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const requestedStart =
    config.range === "YTD"
      ? Date.UTC(now.getUTCFullYear(), 0, 1)
      : end - rangeDays(config.range) * 86_400_000;
  const start =
    config.range === "MAX"
      ? Math.max(requestedStart, YFINANCE_RESEARCH_EARLIEST_SUPPORTED_MS)
      : requestedStart;
  if (start >= end) return null;
  return Object.freeze({
    symbol,
    assetClass: config.assetClass,
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    adjustment: config.adjustment,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

/** Stable view identity; rolling UTC bounds belong to individual request pages. */
export function yfinanceSelectionKey(
  config: Pick<YfinanceResearchConfigV1, "symbol" | "assetClass" | "range" | "adjustment">,
  activeSymbol: string | undefined,
): string {
  return JSON.stringify([
    config.symbol || activeSymbol || "",
    config.assetClass,
    config.range,
    config.adjustment,
  ]);
}

export function parseYfinanceResearchResponse(
  value: unknown,
  input: YfinanceResearchInput,
): YfinanceResearchResponse | null {
  const expected = expectedYfinanceResearchRequest(input);
  return validateYfinanceResearchResponse(value, expected) ? value : null;
}

export type YfinanceResearchPage = Readonly<{
  request: YfinanceResearchInput;
  response: YfinanceResearchResponse;
}>;

/** Continues a cursor from the exact page/window that supplied it. */
export function buildYfinanceOlderPageInput(
  cursorAnchor: YfinanceResearchPage,
  cursor: string,
): YfinanceResearchInput {
  return Object.freeze({ ...cursorAnchor.request, cursor });
}

export type YfinanceSnapshotBehavior = "reset" | "refresh" | "prepend";
export type YfinanceSnapshotTransition = "new-request" | "refresh" | "prepend";

export function yfinanceSnapshotBehavior(
  transition: YfinanceSnapshotTransition,
): YfinanceSnapshotBehavior {
  return transition === "new-request" ? "reset" : transition;
}

export type YfinanceResearchProjection = Readonly<{
  bars: readonly ChartPlotBar<YfinanceResearchResponse["observation"]["payload"]["bars"][number]>[];
  rejectedRows: number;
}>;

/** Provider decimals are deliberately projected to display floats with no exact-decimal claim. */
export function projectYfinanceResearchPages(
  pages: readonly YfinanceResearchPage[],
): YfinanceResearchProjection {
  const candidates = pages.flatMap(({ response }) =>
    response.observation.payload.bars.map((row) => ({
      sourceRow: row,
      timeSeconds: Math.floor(Date.parse(row.event_ts_utc) / 1_000),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    })),
  );
  const projection = projectChartRows(candidates);
  return { bars: projection.bars, rejectedRows: projection.rejectedRows };
}

/** Orders loaded cursor history oldest-first and overlays only the latest head snapshot. */
export function yfinancePagesForProjection(
  cursorPages: readonly YfinanceResearchPage[],
  latestHead: YfinanceResearchPage | null,
): readonly YfinanceResearchPage[] {
  const oldestFirst = [...cursorPages].reverse();
  if (latestHead && latestHead !== cursorPages[0]) oldestFirst.push(latestHead);
  return oldestFirst;
}

/** Keeps current provenance first while retaining the complete original cursor-page evidence. */
export function yfinancePagesForEvidence(
  cursorPages: readonly YfinanceResearchPage[],
  latestHead: YfinanceResearchPage | null,
): readonly YfinanceResearchPage[] {
  if (!latestHead || latestHead === cursorPages[0]) return cursorPages;
  return [latestHead, ...cursorPages];
}

export function yfinanceResearchEvidence(
  config: YfinanceResearchConfigV1,
  pages: readonly YfinanceResearchPage[],
  projection: YfinanceResearchProjection,
  paginationBlocked: boolean,
): ChartDisplayEvidence | null {
  const head = pages[0];
  if (!head) return null;
  const responses = pages.map((page) => page.response);
  const providerTimes = [
    ...new Set(responses.map((response) => response.observation.payload.source_observed_at)),
  ];
  const rejected = projection.rejectedRows;
  const pendingCursor = responses.at(-1)?.next_cursor ?? null;
  const partial =
    responses.some(
      (response) =>
        response.observation.payload.status === "partial" ||
        response.observation.payload.missing_symbols.length > 0,
    ) ||
    rejected > 0 ||
    pendingCursor !== null ||
    paginationBlocked;
  const start = head.response.requested_range.start_utc;
  const end = head.response.requested_range.end_utc;
  const firstPlottedRow = projection.bars[0]?.sourceRow.event_ts_utc;
  const lastPlottedRow = projection.bars.at(-1)?.sourceRow.event_ts_utc;
  const loadedObservationWindow =
    firstPlottedRow && lastPlottedRow
      ? `${firstPlottedRow} → ${lastPlottedRow}`
      : "no chartable rows returned";
  const returned = [
    ...new Set(responses.flatMap((response) => response.observation.payload.returned_symbols)),
  ];
  const missing = [
    ...new Set(responses.flatMap((response) => response.observation.payload.missing_symbols)),
  ];
  const adapterVersions = [
    ...new Set(
      responses
        .map((response) => response.observation.payload.provenance.adapter_version)
        .filter((version): version is string => typeof version === "string" && version.length > 0),
    ),
  ];
  const hasSyntheticFixtureMarker = adapterVersions.some((version) =>
    version.startsWith("bounded-synthetic-e2e"),
  );
  const singleProviderTime = providerTimes.length === 1 ? (providerTimes.at(0) ?? "unknown") : null;
  const safeAdapterVersions = adapterVersions.map((version) =>
    /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,119}$/u.test(version)
      ? version
      : "unrecognized adapter identifier (omitted)",
  );
  const requestedRangeLabel =
    config.range === "MAX"
      ? "MAX (up to 100 years; Yahoo full-history availability not guaranteed)"
      : config.range;
  return Object.freeze({
    mode: "yahoo-daily",
    source: "Yahoo Finance",
    provider: "yfinance",
    feed: "daily observations",
    asOf:
      singleProviderTime ??
      (providerTimes.length > 1 ? "mixed source observation times" : "unknown"),
    requestedWindow: `${requestedRangeLabel} · ${start} → ${end}`,
    effectiveResolution: "1d",
    coverage: [
      `MDP coverage not asserted; ${projection.bars.length} plotted rows across ${pages.length} page(s); `,
      `loaded observation window ${loadedObservationWindow}; returned ${returned.join(", ") || "none"}; missing ${missing.join(", ") || "none"}`,
      rejected ? `; ${rejected} rows omitted for invalid/missing OHLCV` : "",
      pendingCursor ? "; older cursor available by explicit request" : "",
      paginationBlocked ? "; pagination stopped after a repeated/invalid cursor" : "",
    ].join(""),
    completeness: partial ? "partial" : "unknown",
    precision: "provider-float",
    evidence: Object.freeze([
      { label: "Adjustment", value: `${config.adjustment}; provider semantics unconfirmed` },
      {
        label: "Source observed at",
        value: singleProviderTime ?? "mixed / unknown",
      },
      {
        label: "Provider fetch",
        value: responses.map((response) => response.observation.fetched_at_utc).join(", "),
      },
      { label: "Adapter provenance", value: safeAdapterVersions.join(", ") || "unknown" },
      ...(hasSyntheticFixtureMarker
        ? [
            {
              label: "Fixture provenance",
              value: "Synthetic acceptance fixture · bounded-synthetic-e2e marker",
            },
          ]
        : []),
      {
        label: "Coverage assertion",
        value: "MDP does not assert coverage; calendar gaps are not assessed",
      },
      { label: "Authority", value: "Display only · non-canonical · non-PIT · non-executable" },
    ]),
  });
}

export function canLoadOlderPages(
  pages: readonly YfinanceResearchPage[],
  blocked: boolean,
): boolean {
  return (
    pages.length > 0 &&
    pages.length < YFINANCE_RESEARCH_MAX_PAGES &&
    !blocked &&
    pages.at(-1)?.response.next_cursor !== null
  );
}

export function isYfinanceCursorLoop(
  pages: readonly YfinanceResearchPage[],
  nextCursor: string,
): boolean {
  return (
    pages.some((page) => page.request.cursor === nextCursor) ||
    pages.some((page) => page.response.next_cursor === nextCursor)
  );
}
