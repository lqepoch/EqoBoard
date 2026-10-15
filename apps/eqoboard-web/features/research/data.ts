import type { NativeDataOperationMap } from "@/features/data/operations";
import type { MacroData, MacroObservation } from "@/lib/server/research/macro";
import type { EconomicEvent, EarningsCalendarRow, EarningsHistoryRow } from "@/lib/server/research/calendar";
import type { CryptoGlobalData, CryptoMarketRow } from "@/lib/server/research/crypto";
import type { InsiderTransaction } from "@/lib/server/research/insider";
import type { ResearchNewsItem } from "@/lib/server/research/news";
import type { ResearchMarketData, ResearchMarketRow } from "@/lib/server/research/screener";
import type { ResearchEnvelope, ResearchOperationName } from "@/lib/server/research/types";
import type { WidgetDataClient } from "@/widgets/sdk/data";

export type ResearchEnvelopeByOperation = {
  "research.news": ResearchEnvelope<readonly ResearchNewsItem[]>;
  "research.macro": ResearchEnvelope<MacroData>;
  "research.economicCalendar": ResearchEnvelope<readonly EconomicEvent[]>;
  "research.earningsCalendar": ResearchEnvelope<readonly EarningsCalendarRow[]>;
  "research.earningsHistory": ResearchEnvelope<readonly EarningsHistoryRow[]>;
  "research.insider": ResearchEnvelope<readonly InsiderTransaction[]>;
  "research.screener": ResearchEnvelope<ResearchMarketData>;
  "research.heatmap": ResearchEnvelope<ResearchMarketData>;
  "research.crypto": ResearchEnvelope<readonly CryptoMarketRow[]>;
  "research.cryptoGlobal": ResearchEnvelope<CryptoGlobalData>;
};

/** Read capability scoped only to public/research table views. */
export type ResearchDataOperationMap = Pick<NativeDataOperationMap, keyof ResearchEnvelopeByOperation>;

export type ResearchReadRequest = {
  [Id in keyof ResearchEnvelopeByOperation]: Readonly<{
    operation: Id;
    input: NativeDataOperationMap[Id]["input"];
  }>
}[keyof ResearchEnvelopeByOperation];

export type ResearchReadOperation = ResearchReadRequest["operation"];
export type ResearchDisplayRow = Readonly<Record<string, unknown>>;
export type ResearchTableProjection = Readonly<{
  columns: readonly Readonly<{ key: string; label: string }> [];
  rows: readonly ResearchDisplayRow[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== "string" || !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function string(value: unknown, max = 2048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableString(value: unknown, max = 2048): value is string | null {
  return value === null || string(value, max);
}

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function dateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sourceDate(value: unknown): value is string {
  return isoDate(value) || dateOnly(value);
}

function nullableDate(value: unknown): value is string | null {
  return value === null || sourceDate(value);
}

function rows(value: unknown, max: number, accepts: (row: Record<string, unknown>) => boolean): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > max) return false;
  return value.every((item) => {
    const itemRecord = record(item);
    return itemRecord !== null && accepts(itemRecord);
  });
}

function acceptsNews(row: Record<string, unknown>): boolean {
  let safeLink = false;
  if (string(row.link, 2048)) {
    try {
      const parsed = new URL(row.link);
      safeLink = parsed.protocol === "https:" && parsed.hostname.length > 0 && parsed.username === "" && parsed.password === "" && parsed.port === "";
    } catch { safeLink = false; }
  }
  return string(row.title, 240) && safeLink &&
    string(row.publisher, 96) && (row.provider === "Yahoo Finance RSS" || row.provider === "Google News RSS") &&
    nullableDate(row.publishedAt) && nullableString(row.symbol, 16);
}

function acceptsMacroObservation(value: unknown): value is MacroObservation {
  const row = record(value);
  return Boolean(row && string(row.id, 64) && string(row.label, 128) && finiteOrNull(row.value) &&
    (row.unit === "percent" || row.unit === "index") && (row.provider === "FRED" || row.provider === "ECB") &&
    nullableDate(row.asOf));
}

function acceptsMacro(value: unknown): value is MacroData {
  const data = record(value);
  if (!data || (data.region !== "us" && data.region !== "eu") || !Array.isArray(data.observations) ||
      data.observations.length > 16 || !data.observations.every(acceptsMacroObservation) ||
      !Array.isArray(data.indexProxies) || data.indexProxies.length > 16 ||
      !data.indexProxies.every((item) => {
        const row = record(item);
        return Boolean(row && string(row.symbol, 16) && string(row.label, 128));
      }) || !Array.isArray(data.indexObservations) || data.indexObservations.length > 16) return false;
  return data.indexObservations.every((item) => {
    const row = record(item);
    return Boolean(row && string(row.symbol, 16) && string(row.label, 128) && finiteOrNull(row.price) &&
      finiteOrNull(row.changePercent) && string(row.source, 128) && nullableString(row.sourceMode, 48) && nullableDate(row.asOf));
  });
}

function acceptsEconomicEvent(row: Record<string, unknown>): boolean {
  const actual = row.actual === null ? null : record(row.actual);
  const actualValid = row.actual === null || Boolean(actual && string(actual.value, 48) && actual.source === "FRED" && isoDate(actual.asOf));
  return string(row.title, 160) && string(row.country, 12) && isoDate(row.scheduledAt) &&
    ["Low", "Medium", "High", "Holiday"].includes(String(row.impact)) &&
    nullableString(row.forecast, 48) && nullableString(row.previous, 48) && row.scheduleAsOf === null && actualValid;
}

function acceptsEarningsCalendar(row: Record<string, unknown>): boolean {
  return string(row.symbol, 16) && nullableDate(row.nextEarningsDate) && nullableDate(row.lastEarningsDate) &&
    finiteOrNull(row.epsForecast) && row.source === "TradingView scanner" && row.asOf === null;
}

function acceptsEarningsHistory(row: Record<string, unknown>): boolean {
  return nullableString(row.fiscalQuarterEnd, 32) && isoDate(row.reportedAt) && finiteOrNull(row.eps) &&
    finiteOrNull(row.consensusForecast) && finiteOrNull(row.surprisePercent) && finiteOrNull(row.dayAfterChangePercent) &&
    (row.priceMoveSource === "unavailable" || row.priceMoveSource === "Rust Gateway SIP daily bars") && nullableDate(row.priceMoveAsOf);
}

function acceptsInsider(row: Record<string, unknown>): boolean {
  let safeFilingUrl = false;
  if (string(row.filingUrl, 2048)) {
    try {
      const parsed = new URL(row.filingUrl);
      safeFilingUrl = parsed.protocol === "https:" && parsed.hostname === "www.sec.gov" && parsed.username === "" && parsed.password === "" &&
        parsed.port === "" && parsed.pathname.startsWith("/Archives/edgar/data/");
    } catch { safeFilingUrl = false; }
  }
  return dateOnly(row.filingDate) && nullableString(row.transactionDate, 10) &&
    safeFilingUrl && string(row.ownerName, 160) &&
    nullableString(row.ownerTitle, 120) && typeof row.isDirector === "boolean" && typeof row.isOfficer === "boolean" &&
    typeof row.isTenPercentOwner === "boolean" && string(row.transactionCode, 4) &&
    (row.acquiredDisposed === null || row.acquiredDisposed === "A" || row.acquiredDisposed === "D") &&
    finiteOrNull(row.shares) && finiteOrNull(row.pricePerShare) && finiteOrNull(row.sharesOwnedAfter);
}

function acceptsMarketRow(row: Record<string, unknown>): boolean {
  return string(row.symbol, 16) && string(row.name, 160) && finiteOrNull(row.price) && finiteOrNull(row.changePercent) &&
    finiteOrNull(row.volume) && finiteOrNull(row.marketCap) && nullableString(row.marketCapCurrency, 8) &&
    finiteOrNull(row.marketCapEur) && nullableDate(row.marketCapEurAsOf) && string(row.sector, 96) &&
    string(row.exchange, 24) && nullableString(row.country, 96) && string(row.priceSource, 96) &&
    nullableDate(row.priceAsOf) && string(row.marketCapSource, 96) && row.marketCapAsOf === null &&
    nullableString(row.sourceMode, 48) && nullableString(row.sourceLabel, 96);
}

function acceptsMarketData(value: unknown): value is ResearchMarketData {
  const data = record(value);
  const coverage = data ? record(data.coverage) : null;
  if (!data || (data.market !== "us" && data.market !== "eu") ||
      !rows(data.rows, 1500, acceptsMarketRow) || !coverage ||
      !["requested", "snapshots", "priced", "timed"].every((key) => Number.isSafeInteger(coverage[key]) && Number(coverage[key]) >= 0) ||
      !["snapshotComplete", "priceComplete", "timeComplete", "complete"].every((key) => typeof coverage[key] === "boolean") ||
      typeof data.truncated !== "boolean") return false;
  return Number(coverage.snapshots) <= Number(coverage.requested) && Number(coverage.priced) <= Number(coverage.requested) &&
    Number(coverage.timed) <= Number(coverage.requested);
}

function acceptsCryptoMarketRow(row: Record<string, unknown>): boolean {
  return string(row.id, 80) && string(row.symbol, 16) && string(row.name, 96) && finiteOrNull(row.price) &&
    finiteOrNull(row.changePercent24h) && finiteOrNull(row.marketCap) && finiteOrNull(row.volume24h) &&
    finiteOrNull(row.rank) && Array.isArray(row.sparkline) && row.sparkline.length <= 256 &&
    row.sparkline.every((item) => typeof item === "number" && Number.isFinite(item)) && nullableDate(row.asOf);
}

function acceptsData(operation: ResearchOperationName, data: unknown): boolean {
  switch (operation) {
    case "news": return rows(data, 40, acceptsNews);
    case "macro": return acceptsMacro(data);
    case "economic-calendar": return rows(data, 100, acceptsEconomicEvent);
    case "earnings-calendar": return rows(data, 30, acceptsEarningsCalendar);
    case "earnings-history": return rows(data, 24, acceptsEarningsHistory);
    case "insider": return rows(data, 200, acceptsInsider);
    case "screener":
    case "heatmap": return acceptsMarketData(data);
    case "crypto": return rows(data, 50, acceptsCryptoMarketRow);
    case "crypto-global": {
      const value = record(data);
      return Boolean(value && finiteOrNull(value.totalMarketCap) && finiteOrNull(value.bitcoinDominance) && finiteOrNull(value.etherDominance));
    }
  }
}

const OPERATION_NAMES: Readonly<Record<ResearchReadOperation, ResearchOperationName>> = Object.freeze({
  "research.news": "news",
  "research.macro": "macro",
  "research.economicCalendar": "economic-calendar",
  "research.earningsCalendar": "earnings-calendar",
  "research.earningsHistory": "earnings-history",
  "research.insider": "insider",
  "research.screener": "screener",
  "research.heatmap": "heatmap",
  "research.crypto": "crypto",
  "research.cryptoGlobal": "crypto-global",
});

/** Validates the closed BFF response without translating it into a market model. */
export function parseResearchEnvelope<Operation extends ResearchReadOperation>(
  operationId: Operation,
  input: unknown,
): ResearchEnvelopeByOperation[Operation] | null {
  const envelope = record(input);
  if (!envelope || envelope.schemaVersion !== 1 || envelope.operation !== OPERATION_NAMES[operationId] ||
      !["available", "partial"].includes(String(envelope.status)) || !nullableDate(envelope.asOf) || !isoDate(envelope.retrievedAt) ||
      !["miss", "hit"].includes(String(envelope.cache)) || !nullableString(envelope.warning, 2048)) return null;
  const source = record(envelope.source);
  let safeProviderUrl = false;
  if (string(source?.providerUrl, 2048)) {
    try {
      const parsedUrl = new URL(source.providerUrl);
      safeProviderUrl = parsedUrl.protocol === "https:" && parsedUrl.hostname.length > 0 &&
        parsedUrl.username === "" && parsedUrl.password === "" && parsedUrl.hash === "" &&
        parsedUrl.port === "" && parsedUrl.search === "";
    } catch {
      safeProviderUrl = false;
    }
  }
  if (!source || !string(source.provider, 128) || !safeProviderUrl ||
      !string(source.sourcePath, 320) || source.sourcePath.startsWith("/") ||
      !nullableString(source.license, 120)) return null;
  const completeness = record(envelope.completeness);
  if (!completeness || typeof completeness.complete !== "boolean" ||
      !(completeness.failedItems === null || Number.isSafeInteger(completeness.failedItems) && Number(completeness.failedItems) >= 0) ||
      typeof completeness.truncated !== "boolean" ||
      (envelope.status === "available") !== completeness.complete || !acceptsData(OPERATION_NAMES[operationId], envelope.data)) return null;
  return Object.freeze({
    schemaVersion: 1,
    operation: OPERATION_NAMES[operationId],
    source: Object.freeze({
      provider: source.provider,
      providerUrl: source.providerUrl,
      sourcePath: source.sourcePath,
      license: source.license,
    }),
    status: envelope.status as "available" | "partial",
    asOf: envelope.asOf,
    retrievedAt: envelope.retrievedAt,
    completeness: Object.freeze({
      complete: completeness.complete,
      failedItems: completeness.failedItems as number | null,
      truncated: completeness.truncated,
    }),
    cache: envelope.cache as "miss" | "hit",
    data: envelope.data,
    warning: envelope.warning,
  }) as ResearchEnvelopeByOperation[Operation];
}

/** Invoke only the fixed, same-origin read operations declared in the native host map. */
export function readResearchRequest(
  data: WidgetDataClient<ResearchDataOperationMap>,
  request: ResearchReadRequest,
  signal: AbortSignal,
): Promise<unknown> {
  switch (request.operation) {
    case "research.news": return data.read(request.operation, request.input, { signal });
    case "research.macro": return data.read(request.operation, request.input, { signal });
    case "research.economicCalendar": return data.read(request.operation, request.input, { signal });
    case "research.earningsCalendar": return data.read(request.operation, request.input, { signal });
    case "research.earningsHistory": return data.read(request.operation, request.input, { signal });
    case "research.insider": return data.read(request.operation, request.input, { signal });
    case "research.screener": return data.read(request.operation, request.input, { signal });
    case "research.heatmap": return data.read(request.operation, request.input, { signal });
    case "research.crypto": return data.read(request.operation, request.input, { signal });
    case "research.cryptoGlobal": return data.read(request.operation, request.input, { signal });
  }
}

const COLUMN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  title: "Headline", link: "Source link", publisher: "Publisher", provider: "Provider", publishedAt: "Published",
  id: "Series", label: "Observation", value: "Value", unit: "Unit", asOf: "Source date", symbol: "Symbol",
  price: "Price", changePercent: "Change %", source: "Source", sourceMode: "Source mode", scheduledAt: "Scheduled",
  impact: "Impact", country: "Country", forecast: "Forecast", previous: "Previous", actual: "Actual",
  nextEarningsDate: "Next earnings", lastEarningsDate: "Last earnings", epsForecast: "EPS estimate",
  fiscalQuarterEnd: "Fiscal quarter end", reportedAt: "Reported", eps: "EPS", consensusForecast: "Consensus",
  surprisePercent: "Surprise %", dayAfterChangePercent: "Next-session change %", priceMoveSource: "Price move source",
  filingDate: "Filed", transactionDate: "Transaction date", ownerName: "Reporting owner", ownerTitle: "Title",
  transactionCode: "Code", acquiredDisposed: "Direction", shares: "Shares", pricePerShare: "Price/share",
  sharesOwnedAfter: "Shares owned after", name: "Company", sector: "Sector", exchange: "Exchange", marketCap: "Market cap",
  marketCapEur: "Market cap EUR", marketCapCurrency: "Cap currency", marketCapSource: "Cap source", priceSource: "Price source",
  priceAsOf: "Price as of", volume: "Volume", changePercent24h: "24h change %", volume24h: "24h volume", rank: "Rank",
  totalMarketCap: "Total market cap USD", bitcoinDominance: "BTC dominance %", etherDominance: "ETH dominance %",
});

function makeTable<Row extends object>(columns: readonly string[], inputRows: readonly Row[]): ResearchTableProjection {
  return Object.freeze({
    columns: Object.freeze(columns.map((key) => Object.freeze({ key, label: COLUMN_LABELS[key] ?? key }))),
    rows: Object.freeze(inputRows as readonly ResearchDisplayRow[]),
  });
}

/** Project only explicit, operation-specific display columns after envelope validation. */
export function projectResearchTable(operation: ResearchReadOperation, envelope: ResearchEnvelopeByOperation[ResearchReadOperation]): ResearchTableProjection {
  const data = envelope.data;
  switch (operation) {
    case "research.news":
      return makeTable(["title", "publisher", "publishedAt", "provider", "link"], data as readonly ResearchNewsItem[]);
    case "research.macro": {
      const macro = data as MacroData;
      const rates = macro.observations.map((row: MacroObservation) => ({ group: "Macro", ...row }));
      const proxies = macro.indexObservations.map((row) => ({ group: "SIP proxy", symbol: row.symbol, label: row.label, price: row.price, changePercent: row.changePercent, source: row.source, sourceMode: row.sourceMode, asOf: row.asOf }));
      return makeTable(["group", "symbol", "id", "label", "value", "price", "changePercent", "unit", "provider", "source", "sourceMode", "asOf"], [...rates, ...proxies]);
    }
    case "research.economicCalendar":
      return makeTable(["title", "country", "scheduledAt", "impact", "forecast", "previous", "actual"], data as readonly EconomicEvent[]);
    case "research.earningsCalendar":
      return makeTable(["symbol", "nextEarningsDate", "lastEarningsDate", "epsForecast", "source", "asOf"], data as readonly EarningsCalendarRow[]);
    case "research.earningsHistory":
      return makeTable(["fiscalQuarterEnd", "reportedAt", "eps", "consensusForecast", "surprisePercent", "dayAfterChangePercent", "priceMoveSource"], data as readonly EarningsHistoryRow[]);
    case "research.insider":
      return makeTable(["filingDate", "transactionDate", "ownerName", "ownerTitle", "transactionCode", "acquiredDisposed", "shares", "pricePerShare", "sharesOwnedAfter", "filingUrl"], data as readonly InsiderTransaction[]);
    case "research.screener":
    case "research.heatmap": {
      const marketData = data as ResearchMarketData;
      const rowsWithCoverage = marketData.rows.map((row: ResearchMarketRow) => ({ ...row }));
      return makeTable(["symbol", "name", "sector", "exchange", "price", "changePercent", "volume", "priceSource", "priceAsOf", "marketCap", "marketCapEur", "marketCapCurrency", "marketCapSource"], rowsWithCoverage);
    }
    case "research.crypto":
      return makeTable(["symbol", "name", "price", "changePercent24h", "marketCap", "volume24h", "rank", "asOf", "provider"], (data as readonly CryptoMarketRow[]).map((row) => ({ ...row, provider: envelope.source.provider })));
    case "research.cryptoGlobal":
      return makeTable(["totalMarketCap", "bitcoinDominance", "etherDominance", "provider", "asOf"], [{ ...(data as CryptoGlobalData), provider: envelope.source.provider, asOf: envelope.asOf }]);
  }
}

export function isResearchReadOperation(value: unknown): value is ResearchReadOperation {
  return typeof value === "string" && Object.hasOwn(OPERATION_NAMES, value);
}
