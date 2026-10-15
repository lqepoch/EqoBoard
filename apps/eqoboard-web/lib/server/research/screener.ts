import { finiteNumber } from "./transport";
import { fetchTradingViewRows } from "./calendar";
import { readEcbLatest } from "./macro";
import type { ProviderResult } from "./types";

export type ResearchMarketRow = Readonly<{
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
  marketCap: number | null;
  marketCapCurrency: string | null;
  marketCapEur: number | null;
  marketCapEurAsOf: string | null;
  sector: string;
  exchange: string;
  country: string | null;
  priceSource: string;
  priceAsOf: string | null;
  marketCapSource: string;
  marketCapAsOf: null;
  /** Source-reported mode/label values are kept only when explicitly present. */
  sourceMode: string | null;
  sourceLabel: string | null;
}>;

export type ResearchMarketData = Readonly<{
  market: "us" | "eu";
  rows: readonly ResearchMarketRow[];
  coverage: Readonly<{
    requested: number;
    snapshots: number;
    priced: number;
    timed: number;
    snapshotComplete: boolean;
    priceComplete: boolean;
    timeComplete: boolean;
    complete: boolean;
  }>;
  truncated: boolean;
}>;

export type GatewaySnapshotBatch = Readonly<{
  feed: "sip";
  snapshots: readonly unknown[];
  sourceLabel: string | null;
  sourceMode: string | null;
  receivedAt: string | null;
  gatewayInstanceId: string | null;
}>;

const SOURCE = Object.freeze({
  provider: "TradingView scanner + Rust Gateway SIP snapshot endpoint",
  providerUrl: "https://scanner.tradingview.com/",
  sourcePath: "apps/openterminal/server/src/providers/tradingview.ts",
  license: null,
});

const EU_MARKETS = Object.freeze([
  { region: "uk", exchange: "LSE", country: "United Kingdom" },
  { region: "germany", exchange: "XETR", country: "Germany" },
  { region: "france", exchange: "EURONEXT", country: "France" },
  { region: "netherlands", exchange: "EURONEXT", country: "Netherlands" },
  { region: "switzerland", exchange: "SIX", country: "Switzerland" },
  { region: "italy", exchange: "MIL", country: "Italy" },
  { region: "spain", exchange: "BME", country: "Spain" },
  { region: "sweden", exchange: "OMXSTO", country: "Sweden" },
  { region: "belgium", exchange: "EURONEXT", country: "Belgium" },
]);
const EU_FX = Object.freeze({
  GBP: { flow: "EXR", key: "D.GBP.EUR.SP00.A" },
  SEK: { flow: "EXR", key: "D.SEK.EUR.SP00.A" },
  CHF: { flow: "EXR", key: "D.CHF.EUR.SP00.A" },
});

function stringOrNull(value: unknown, maxLength = 96): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text !== "" && text.length <= maxLength ? text : null;
}

function valuesAt(row: readonly unknown[], index: number): unknown {
  return row[index];
}

async function scanRegion(
  region: string,
  exchange: string,
  country: string,
  limit: number,
): Promise<ResearchMarketRow[]> {
  const rows = await fetchTradingViewRows(`https://scanner.tradingview.com/${region}/scan`, {
    columns: ["description", "close", "change", "market_cap_basic", "sector", "volume", "fundamental_currency_code"],
    filter: [
      { left: "type", operation: "equal", right: "stock" },
      { left: "typespecs", operation: "has", right: ["common"] },
      { left: "country", operation: "equal", right: country },
      { left: "exchange", operation: "equal", right: exchange },
    ],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [0, limit],
  });
  return rows.flatMap((row): ResearchMarketRow[] => {
    const symbol = row.symbol;
    if (!symbol) return [];
    const name = stringOrNull(valuesAt(row.values, 0), 160) ?? symbol;
    const scannerClose = finiteNumber(valuesAt(row.values, 1));
    const change = finiteNumber(valuesAt(row.values, 2));
    const localCap = finiteNumber(valuesAt(row.values, 3));
    const sector = stringOrNull(valuesAt(row.values, 4)) ?? "Other";
    const volume = finiteNumber(valuesAt(row.values, 5));
    const currency = stringOrNull(valuesAt(row.values, 6), 8)?.toUpperCase() ?? null;
    return [Object.freeze({
      symbol,
      name,
      price: scannerClose,
      changePercent: change,
      volume,
      marketCap: localCap,
      marketCapCurrency: currency,
      marketCapEur: null,
      marketCapEurAsOf: null,
      sector,
      exchange,
      country,
      priceSource: "TradingView scanner",
      priceAsOf: null,
      marketCapSource: "TradingView scanner",
      marketCapAsOf: null,
      sourceMode: null,
      sourceLabel: null,
    })];
  });
}

async function scanUs(limit: number): Promise<ResearchMarketRow[]> {
  const rows = await fetchTradingViewRows("https://scanner.tradingview.com/america/scan", {
    columns: ["description", "close", "change", "market_cap_basic", "sector", "volume", "exchange", "fundamental_currency_code"],
    filter: [
      { left: "type", operation: "equal", right: "stock" },
      { left: "typespecs", operation: "has", right: ["common"] },
    ],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [0, limit],
  });
  return rows.flatMap((row): ResearchMarketRow[] => {
    const symbol = row.symbol;
    if (!symbol) return [];
    const exchange = stringOrNull(valuesAt(row.values, 6), 24) ?? "";
    if (!exchange || exchange === "OTC") return [];
    return [Object.freeze({
      symbol,
      name: stringOrNull(valuesAt(row.values, 0), 160) ?? symbol,
      // The scanner close is deliberately not treated as a U.S. price. It is replaced only by a Gateway SIP snapshot.
      price: null,
      changePercent: null,
      volume: null,
      marketCap: finiteNumber(valuesAt(row.values, 3)),
      marketCapCurrency: stringOrNull(valuesAt(row.values, 7), 8)?.toUpperCase() ?? null,
      marketCapEur: null,
      marketCapEurAsOf: null,
      sector: stringOrNull(valuesAt(row.values, 4)) ?? "Other",
      exchange,
      country: "United States",
      priceSource: "awaiting Gateway SIP snapshot",
      priceAsOf: null,
      marketCapSource: "TradingView scanner",
      marketCapAsOf: null,
      sourceMode: null,
      sourceLabel: null,
    })];
  });
}

async function loadEurFxRates(): Promise<Readonly<Record<string, Readonly<{ rate: number; asOf: string }>>>> {
  const rates: Record<string, { rate: number; asOf: string }> = { EUR: { rate: 1, asOf: "" } };
  await Promise.all(Object.entries(EU_FX).map(async ([currency, spec]) => {
    const point = await readEcbLatest(spec.flow, spec.key);
    if (point) rates[currency] = { rate: point.value, asOf: point.date };
  }));
  return rates;
}

function applyEurRates(rows: readonly ResearchMarketRow[], rates: Readonly<Record<string, Readonly<{ rate: number; asOf: string }>>>): ResearchMarketRow[] {
  return rows.map((row) => {
    const fx = row.marketCapCurrency ? rates[row.marketCapCurrency] : undefined;
    return Object.freeze({
      ...row,
      marketCapEur: row.marketCap !== null && fx && fx.rate > 0 ? row.marketCap / fx.rate : row.marketCapCurrency === "EUR" ? row.marketCap : null,
      marketCapEurAsOf: fx?.asOf || null,
      marketCapSource: row.marketCapCurrency === "EUR" || fx ? "TradingView scanner + ECB FX" : row.marketCapSource,
    });
  });
}

export async function loadMarketMetadata(market: "us" | "eu"): Promise<ProviderResult<ResearchMarketData>> {
  let rows: ResearchMarketRow[] = [];
  let failedItems = 0;
  let truncated = false;
  if (market === "us") {
    rows = await scanUs(1500);
    truncated = rows.length >= 1500;
  } else {
    const settled = await Promise.allSettled(EU_MARKETS.map((entry) => scanRegion(entry.region, entry.exchange, entry.country, 300)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        rows.push(...result.value);
        if (result.value.length >= 300) truncated = true;
      } else {
        failedItems += 1;
      }
    }
    rows.sort((left, right) => (right.marketCap ?? 0) - (left.marketCap ?? 0));
    rows = rows.slice(0, 1500);
    try {
      const rates = await loadEurFxRates();
      rows = applyEurRates(rows, rates);
    } catch {
      failedItems += 1;
    }
  }
  const initialCoverage = {
    requested: market === "us" ? rows.length : rows.length,
    snapshots: 0,
    priced: 0,
    timed: 0,
    snapshotComplete: market === "eu" && failedItems === 0,
    priceComplete: market === "eu" && failedItems === 0 && rows.every((row) => row.price !== null),
    timeComplete: false,
    complete: false,
  };
  return {
    source: SOURCE,
    data: { market, rows, coverage: initialCoverage, truncated },
    asOf: null,
    complete: market === "eu" && failedItems === 0 && rows.every((row) => row.price !== null && row.priceAsOf !== null),
    failedItems,
    truncated,
    warning: market === "us"
      ? "U.S. prices are replaced only by the authorized Rust Gateway SIP snapshot response; scanner prices are not exposed as U.S. market prices."
      : "European scanner values have no source timestamp; market-cap FX conversion carries a separate ECB observation date.",
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function snapshotText(snapshot: Record<string, unknown>, key: string, fallback?: unknown): string | null {
  const value = Object.hasOwn(snapshot, key) ? snapshot[key] : fallback;
  return stringOrNull(value, 96);
}

function snapshotTime(snapshot: Record<string, unknown>): string | null {
  const raw = snapshot.last_as_of;
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function attachSipSnapshots(data: ResearchMarketData, batch: GatewaySnapshotBatch): ResearchMarketData {
  if (data.market !== "us" || batch.feed !== "sip") return data;
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const raw of batch.snapshots) {
    const value = record(raw);
    const symbol = value?.symbol;
    if (typeof symbol === "string") snapshots.set(symbol.toUpperCase(), value!);
  }
  let priced = 0;
  let timed = 0;
  const rows = data.rows.map((row): ResearchMarketRow => {
    const snapshot = snapshots.get(row.symbol);
    const price = snapshot ? finiteNumber(snapshot.last) : null;
    const asOf = snapshot ? snapshotTime(snapshot) : null;
    if (price !== null) priced += 1;
    if (asOf !== null) timed += 1;
    return Object.freeze({
      ...row,
      price,
      changePercent: snapshot ? finiteNumber(snapshot.change_percent) : null,
      volume: snapshot ? finiteNumber(snapshot.volume) : null,
      priceSource: snapshotText(snapshot ?? {}, "source_label", batch.sourceLabel) ?? "source unknown (Gateway SIP endpoint)",
      priceAsOf: asOf,
      sourceMode: snapshotText(snapshot ?? {}, "source_mode", batch.sourceMode),
      sourceLabel: snapshotText(snapshot ?? {}, "source_label", batch.sourceLabel),
    });
  });
  const requested = data.rows.length;
  const snapshotsCount = [...snapshots.keys()].filter((symbol) => data.rows.some((row) => row.symbol === symbol)).length;
  const coverage = {
    requested,
    snapshots: snapshotsCount,
    priced,
    timed,
    snapshotComplete: requested > 0 && snapshotsCount === requested,
    priceComplete: requested > 0 && priced === requested,
    timeComplete: requested > 0 && timed === requested,
    complete: requested > 0 && snapshotsCount === requested && priced === requested && timed === requested,
  };
  return Object.freeze({ ...data, rows, coverage });
}

export type ScreenerInput = Readonly<{
  sector?: string;
  marketCapMin?: number;
  changeMin?: number;
  changeMax?: number;
  volumeMin?: number;
  sort?: "marketCap" | "price" | "changePercent" | "volume";
  direction?: "asc" | "desc";
  limit?: number;
}>;

export function filterMarketData(data: ResearchMarketData, input: ScreenerInput): ResearchMarketData {
  const marketCapValue = (row: ResearchMarketRow) => data.market === "eu" ? row.marketCapEur : row.marketCap;
  let rows = data.rows.filter((row) => {
    if (input.sector && row.sector !== input.sector) return false;
    if (input.marketCapMin !== undefined && (marketCapValue(row) === null || marketCapValue(row)! < input.marketCapMin)) return false;
    if (input.changeMin !== undefined && (row.changePercent === null || row.changePercent < input.changeMin)) return false;
    if (input.changeMax !== undefined && (row.changePercent === null || row.changePercent > input.changeMax)) return false;
    if (input.volumeMin !== undefined && (row.volume === null || row.volume < input.volumeMin)) return false;
    return true;
  });
  const sort = input.sort ?? "marketCap";
  const direction = input.direction === "asc" ? 1 : -1;
  rows = [...rows].sort((left, right) => {
    const leftValue = sort === "marketCap" ? marketCapValue(left) : left[sort];
    const rightValue = sort === "marketCap" ? marketCapValue(right) : right[sort];
    const a = leftValue ?? Number.NEGATIVE_INFINITY;
    const b = rightValue ?? Number.NEGATIVE_INFINITY;
    return (a < b ? -1 : a > b ? 1 : left.symbol.localeCompare(right.symbol)) * direction;
  });
  const limit = input.limit ?? 500;
  const truncated = data.truncated || rows.length > limit;
  rows = rows.slice(0, limit);
  return Object.freeze({ ...data, rows, truncated });
}

export function toHeatmap(data: ResearchMarketData): ResearchMarketData {
  const sorted = [...data.rows]
    .filter((row) => {
      const value = data.market === "eu" ? row.marketCapEur : row.marketCap;
      return typeof value === "number" && Number.isFinite(value) && value > 0;
    })
    .sort((left, right) => {
      const a = data.market === "eu" ? left.marketCapEur! : left.marketCap!;
      const b = data.market === "eu" ? right.marketCapEur! : right.marketCap!;
      return b - a;
    });
  const rows = sorted.slice(0, 150);
  return Object.freeze({ ...data, rows, truncated: data.truncated || sorted.length > rows.length });
}
