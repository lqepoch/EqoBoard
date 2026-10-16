import { attachMacroSnapshots, loadMacro, type MacroData } from "./macro";
import { loadNews, type ResearchNewsItem } from "./news";
import {
  attachSipSnapshots,
  loadMarketMetadata,
  type ResearchMarketData,
  type ResearchMarketRow,
} from "./screener";
import {
  readSipSnapshotsWithDelegation,
  type MarketDelegation,
  type SipSnapshotCollection,
} from "./gateway";
import type { ProviderResult, ResearchSource } from "./types";

export const RECAP_MARKET_SAMPLE_LIMIT = 150;
const MIN_LEADER_MARKET_CAP = 2_000_000_000;

export type RecapObservation<T> = Readonly<{
  value: T | null;
  source: string | null;
  asOf: string | null;
}>;

export type ResearchRecapIndex = Readonly<{
  symbol: string;
  label: string;
  price: RecapObservation<number>;
  changePercent: RecapObservation<number>;
}>;

export type ResearchRecapLeader = Readonly<{
  symbol: string;
  name: string;
  sector: string;
  price: RecapObservation<number>;
  changePercent: RecapObservation<number>;
  marketCap: RecapObservation<number>;
}>;

export type ResearchRecapSector = Readonly<{
  sector: string;
  averageChangePercent: RecapObservation<number>;
  sampleCount: number;
  sourceTimeRange: Readonly<{ earliest: string | null; latest: string | null }>;
}>;

export type ResearchRecapCoverage = Readonly<{
  marketMetadata: Readonly<{
    status: "available" | "unavailable";
    returned: number;
    sampled: number;
    sampleLimit: number;
    truncated: boolean;
    source: string | null;
    asOf: string | null;
  }>;
  sipSnapshots: Readonly<{
    status: "available" | "partial" | "unavailable";
    requested: number;
    snapshots: number;
    marketRequested: number;
    priced: number;
    timed: number;
    complete: boolean;
    source: string | null;
    asOf: null;
  }>;
  macro: Readonly<{
    status: "available" | "partial" | "unavailable";
    source: string | null;
    asOf: null;
  }>;
  headlines: Readonly<{
    status: "available" | "partial" | "unavailable";
    returned: number;
    source: string | null;
    asOf: null;
  }>;
}>;

export type ResearchRecapData = Readonly<{
  indexes: readonly ResearchRecapIndex[];
  volatility: Readonly<{ vix: RecapObservation<number> }>;
  gainers: readonly ResearchRecapLeader[];
  losers: readonly ResearchRecapLeader[];
  sectors: readonly ResearchRecapSector[];
  headlines: readonly ResearchNewsItem[];
  coverage: ResearchRecapCoverage;
}>;

const SOURCE: ResearchSource = Object.freeze({
  provider: "FRED + TradingView scanner + Rust Gateway SIP + RSS headlines",
  providerUrl: "https://www.tradingview.com/",
  sourcePath: "apps/eqoboard-web/lib/server/research/recap.ts",
  license: null,
});

type Settled<T> = Readonly<{ status: "available"; value: T }> | Readonly<{ status: "unavailable" }>;

function fulfilled<T>(result: PromiseSettledResult<T>): Settled<T> {
  return result.status === "fulfilled"
    ? { status: "available", value: result.value }
    : { status: "unavailable" };
}

function capSample(data: ResearchMarketData): ResearchMarketData {
  const sorted = [...data.rows].sort((left, right) => {
    const leftCap = left.marketCap ?? Number.NEGATIVE_INFINITY;
    const rightCap = right.marketCap ?? Number.NEGATIVE_INFINITY;
    return rightCap - leftCap || left.symbol.localeCompare(right.symbol);
  });
  const rows = sorted.slice(0, RECAP_MARKET_SAMPLE_LIMIT);
  return Object.freeze({
    ...data,
    rows: Object.freeze(rows),
    coverage: Object.freeze({
      requested: rows.length,
      snapshots: 0,
      priced: 0,
      timed: 0,
      snapshotComplete: false,
      priceComplete: false,
      timeComplete: false,
      complete: false,
    }),
    truncated: data.truncated || sorted.length > rows.length,
  });
}

function metric(
  value: number | null,
  source: string | null,
  asOf: string | null,
): RecapObservation<number> {
  return Object.freeze({ value, source, asOf });
}

function buildIndexes(macro: MacroData | null, snapshotsAvailable: boolean): ResearchRecapIndex[] {
  if (!macro) return [];
  const rows =
    macro.indexObservations.length > 0
      ? macro.indexObservations
      : macro.indexProxies.map((proxy) => ({
          ...proxy,
          price: null,
          changePercent: null,
          source: "",
          sourceMode: null,
          asOf: null,
        }));
  return rows.map((row) =>
    Object.freeze({
      symbol: row.symbol,
      label: row.label,
      price: metric(
        snapshotsAvailable ? row.price : null,
        snapshotsAvailable ? row.source : null,
        snapshotsAvailable ? row.asOf : null,
      ),
      changePercent: metric(
        snapshotsAvailable ? row.changePercent : null,
        snapshotsAvailable ? row.source : null,
        snapshotsAvailable ? row.asOf : null,
      ),
    }),
  );
}

function macroIndexData(macro: MacroData, batch: SipSnapshotCollection | null): MacroData {
  return batch ? attachMacroSnapshots(macro, batch.snapshots) : macro;
}

function leaders(rows: readonly ResearchMarketRow[]): ResearchRecapLeader[] {
  return rows.flatMap((row): ResearchRecapLeader[] => {
    if (
      row.marketCap === null ||
      row.marketCap < MIN_LEADER_MARKET_CAP ||
      row.changePercent === null ||
      row.price === null ||
      row.priceAsOf === null
    )
      return [];
    return [
      Object.freeze({
        symbol: row.symbol,
        name: row.name,
        sector: row.sector,
        price: metric(row.price, row.priceSource, row.priceAsOf),
        changePercent: metric(row.changePercent, row.priceSource, row.priceAsOf),
        marketCap: metric(row.marketCap, row.marketCapSource, row.marketCapAsOf),
      }),
    ];
  });
}

function sectorRows(rows: readonly ResearchMarketRow[]): ResearchRecapSector[] {
  const groups = new Map<string, ResearchMarketRow[]>();
  for (const row of rows) {
    if (row.changePercent === null || row.priceAsOf === null) continue;
    const group = groups.get(row.sector) ?? [];
    group.push(row);
    groups.set(row.sector, group);
  }
  return [...groups.entries()]
    .map(([sector, values]) => {
      const timestamps = values
        .map((row) => row.priceAsOf)
        .filter((value): value is string => value !== null)
        .sort();
      const changes = values
        .map((row) => row.changePercent)
        .filter((change): change is number => change !== null);
      const average = changes.reduce((sum, change) => sum + change, 0) / values.length;
      return Object.freeze({
        sector,
        averageChangePercent: metric(
          average,
          "Equal-weighted average of Rust Gateway SIP changes; sector labels from TradingView scanner",
          null,
        ),
        sampleCount: values.length,
        sourceTimeRange: Object.freeze({
          earliest: timestamps[0] ?? null,
          latest: timestamps.at(-1) ?? null,
        }),
      });
    })
    .sort(
      (left, right) =>
        (right.averageChangePercent.value ?? -Infinity) -
        (left.averageChangePercent.value ?? -Infinity),
    );
}

function selectSectorLeaders(sectors: readonly ResearchRecapSector[]): ResearchRecapSector[] {
  const top = sectors.slice(0, 3);
  const bottom = sectors.slice(-3).reverse();
  return [...top, ...bottom].filter(
    (item, index, all) => all.findIndex((entry) => entry.sector === item.sector) === index,
  );
}

function errorCount(values: readonly boolean[]): number {
  return values.filter((value) => !value).length;
}

function hasCompleteIndexObservation(row: ResearchRecapIndex): boolean {
  return (
    row.price.value !== null &&
    row.price.asOf !== null &&
    row.changePercent.value !== null &&
    row.changePercent.asOf !== null
  );
}

/** Compose the former recap panels from bounded provider observations, with no generated narrative. */
export async function loadResearchRecap(
  delegation: MarketDelegation,
): Promise<ProviderResult<ResearchRecapData>> {
  const [macroSettled, metadataSettled, newsSettled] = await Promise.allSettled([
    loadMacro("us"),
    loadMarketMetadata("us"),
    loadNews(null),
  ]);
  const macroResult = fulfilled(macroSettled);
  const metadataResult = fulfilled(metadataSettled);
  const newsResult = fulfilled(newsSettled);
  const marketSample =
    metadataResult.status === "available" ? capSample(metadataResult.value.data) : null;
  const gatewaySymbols = [
    ...new Set([
      ...(macroResult.status === "available"
        ? macroResult.value.data.indexProxies.map((entry) => entry.symbol)
        : []),
      ...(marketSample?.rows.map((entry) => entry.symbol) ?? []),
    ]),
  ];
  let gateway: SipSnapshotCollection | null = null;
  if (gatewaySymbols.length > 0) {
    const result = await readSipSnapshotsWithDelegation(delegation, gatewaySymbols);
    if (result.ok) gateway = result.value;
  }

  const macroData =
    macroResult.status === "available" ? macroIndexData(macroResult.value.data, gateway) : null;
  const marketData =
    marketSample && gateway ? attachSipSnapshots(marketSample, gateway) : marketSample;
  const indexRows = macroData ? buildIndexes(macroData, gateway !== null) : [];
  const macroValue = macroData?.observations.find((item) => item.id === "VIXCLS") ?? null;
  const allLeaders = marketData ? leaders(marketData.rows) : [];
  const sectorSummaries = marketData ? selectSectorLeaders(sectorRows(marketData.rows)) : [];
  const headlineRows = newsResult.status === "available" ? newsResult.value.data.slice(0, 6) : [];
  const macroComplete =
    macroResult.status === "available" &&
    macroResult.value.complete &&
    indexRows.length > 0 &&
    indexRows.every(hasCompleteIndexObservation);
  const metadataComplete =
    metadataResult.status === "available" && marketSample !== null && !marketSample.truncated;
  const sipComplete =
    gateway !== null &&
    marketData?.coverage.complete === true &&
    indexRows.length > 0 &&
    indexRows.every(hasCompleteIndexObservation);
  const headlinesComplete = newsResult.status === "available" && newsResult.value.complete;
  const complete = macroComplete && metadataComplete && sipComplete && headlinesComplete;
  const missingSnapshotSymbols = new Set([
    ...(marketData?.rows
      .filter((row) => row.price === null || row.changePercent === null || row.priceAsOf === null)
      .map((row) => row.symbol) ?? []),
    ...indexRows.filter((row) => !hasCompleteIndexObservation(row)).map((row) => row.symbol),
  ]);
  const missingSnapshotCount = missingSnapshotSymbols.size;
  const failedItems =
    errorCount([
      macroResult.status === "available",
      metadataResult.status === "available",
      newsResult.status === "available",
      gateway !== null || gatewaySymbols.length === 0,
    ]) +
    Math.max(0, missingSnapshotCount) +
    (macroResult.status === "available" ? (macroResult.value.failedItems ?? 0) : 0) +
    (newsResult.status === "available" ? (newsResult.value.failedItems ?? 0) : 0);
  const coverage: ResearchRecapCoverage = Object.freeze({
    marketMetadata: Object.freeze({
      status: metadataResult.status,
      returned: metadataResult.status === "available" ? metadataResult.value.data.rows.length : 0,
      sampled: marketSample?.rows.length ?? 0,
      sampleLimit: RECAP_MARKET_SAMPLE_LIMIT,
      truncated: marketSample?.truncated ?? false,
      source: metadataResult.status === "available" ? metadataResult.value.source.provider : null,
      asOf: null,
    }),
    sipSnapshots: Object.freeze({
      status: gateway === null ? "unavailable" : sipComplete ? "available" : "partial",
      requested: gatewaySymbols.length,
      snapshots: gateway?.snapshots.length ?? 0,
      marketRequested: marketSample?.rows.length ?? 0,
      priced: marketData?.coverage.priced ?? 0,
      timed: marketData?.coverage.timed ?? 0,
      complete: sipComplete,
      source: gateway?.sourceLabel ?? null,
      asOf: null,
    }),
    macro: Object.freeze({
      status:
        macroResult.status === "unavailable"
          ? "unavailable"
          : macroResult.value.complete
            ? "available"
            : "partial",
      source: macroResult.status === "available" ? macroResult.value.source.provider : null,
      asOf: null,
    }),
    headlines: Object.freeze({
      status:
        newsResult.status === "unavailable"
          ? "unavailable"
          : newsResult.value.complete
            ? "available"
            : "partial",
      returned: headlineRows.length,
      source: newsResult.status === "available" ? newsResult.value.source.provider : null,
      asOf: null,
    }),
  });

  const indexes = indexRows.map((row) => row);
  const rankedGainers = [...allLeaders].sort(
    (left, right) =>
      (right.changePercent.value ?? -Infinity) - (left.changePercent.value ?? -Infinity),
  );
  const rankedLosers = [...rankedGainers].reverse();
  const vix = metric(
    macroValue?.value ?? null,
    macroValue?.provider ??
      (macroResult.status === "available" ? macroResult.value.source.provider : null),
    macroValue?.asOf ?? null,
  );
  const data: ResearchRecapData = Object.freeze({
    indexes: Object.freeze(indexes),
    volatility: Object.freeze({ vix }),
    gainers: Object.freeze(rankedGainers.slice(0, 5)),
    losers: Object.freeze(rankedLosers.slice(0, 5)),
    sectors: Object.freeze(sectorSummaries),
    headlines: Object.freeze(headlineRows),
    coverage,
  });
  const warning = [
    "Recap combines independent source observations and is not a synchronized market snapshot.",
    marketSample?.truncated
      ? `The SIP market universe is capped at ${RECAP_MARKET_SAMPLE_LIMIT} TradingView market-cap-ranked listings.`
      : null,
    gateway === null
      ? "Rust Gateway SIP snapshots are unavailable; price-based market sections remain empty."
      : null,
    newsResult.status === "available"
      ? newsResult.value.warning
      : "Headline providers are unavailable.",
  ]
    .filter(Boolean)
    .join(" ");
  return Object.freeze({
    source: SOURCE,
    data,
    asOf: null,
    complete,
    failedItems,
    truncated: Boolean(
      marketSample?.truncated || (newsResult.status === "available" && newsResult.value.truncated),
    ),
    warning,
  });
}
