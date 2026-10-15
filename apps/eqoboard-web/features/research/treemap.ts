import { hierarchy, treemap, treemapSquarify } from "d3";

import type { ResearchMarketData, ResearchMarketRow } from "@/lib/server/research/screener";

export type MarketCapTreemapCell = Readonly<{
  symbol: string;
  name: string;
  market: ResearchMarketData["market"];
  marketCap: number;
  currency: string | null;
  marketCapSource: string;
  marketCapAsOf: string | null;
  changePercent: number | null;
  priceSource: string;
  priceAsOf: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  areaFraction: number;
}>;

export type MarketCapTreemapLayout = Readonly<{
  cells: readonly MarketCapTreemapCell[];
  excludedRows: number;
}>;

type TreemapNode = Readonly<{
  row?: ResearchMarketRow;
  value?: number;
  weight?: number;
  children?: readonly TreemapNode[];
}>;

function capFor(row: ResearchMarketRow, market: ResearchMarketData["market"]): number | null {
  const value = market === "eu" ? row.marketCapEur : row.marketCap;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Lay out only rows with a source-reported, positive market-cap weight. D3's
 * squarify treemap allocates area in direct proportion to those weights.
 */
export function layoutMarketCapTreemap(
  data: ResearchMarketData,
  width = 1000,
  height = 560,
): MarketCapTreemapLayout {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 10_000 ||
    height > 10_000
  ) {
    return Object.freeze({ cells: Object.freeze([]), excludedRows: data.rows.length });
  }

  const weightedRows = data.rows.flatMap((row) => {
    const value = capFor(row, data.market);
    return value === null ? [] : [{ row, value }];
  });
  const excludedRows = data.rows.length - weightedRows.length;
  if (weightedRows.length === 0) return Object.freeze({ cells: Object.freeze([]), excludedRows });
  const largestCap = Math.max(...weightedRows.map(({ value }) => value));
  const nodes = weightedRows.map(({ row, value }) => ({ row, value, weight: value / largestCap }));

  // Scaling prevents a valid but very large provider value from overflowing
  // the root sum while preserving every representable relative weight.
  const root = hierarchy<TreemapNode>({ children: nodes }, (node) => node.children)
    .sum((node) => node.weight ?? 0)
    .sort(
      (left, right) =>
        (right.value ?? 0) - (left.value ?? 0) ||
        (left.data.row?.symbol ?? "").localeCompare(right.data.row?.symbol ?? ""),
    );
  treemap<TreemapNode>().tile(treemapSquarify).size([width, height]).round(false).paddingInner(0)(
    root,
  );

  const cells = root.leaves().flatMap((node): MarketCapTreemapCell[] => {
    const row = node.data.row;
    const marketCap = node.data.value;
    if (!row || typeof marketCap !== "number" || !Number.isFinite(marketCap) || marketCap <= 0)
      return [];
    const marketCapAsOf = data.market === "eu" ? row.marketCapEurAsOf : row.marketCapAsOf;
    return [
      Object.freeze({
        symbol: row.symbol,
        name: row.name,
        market: data.market,
        marketCap,
        currency: data.market === "eu" ? "EUR" : row.marketCapCurrency,
        marketCapSource: row.marketCapSource,
        marketCapAsOf,
        changePercent: row.changePercent,
        priceSource: row.priceSource,
        priceAsOf: row.priceAsOf,
        x: (node.x0 / width) * 100,
        y: (node.y0 / height) * 100,
        width: ((node.x1 - node.x0) / width) * 100,
        height: ((node.y1 - node.y0) / height) * 100,
        areaFraction: ((node.x1 - node.x0) * (node.y1 - node.y0)) / (width * height),
      }),
    ];
  });
  return Object.freeze({ cells: Object.freeze(cells), excludedRows });
}
