import { describe, expect, it } from "vitest";

import type { ResearchMarketData, ResearchMarketRow } from "@/lib/server/research/screener";
import { layoutMarketCapTreemap } from "./treemap";

function marketRow(
  symbol: string,
  marketCap: number | null,
  marketCapEur: number | null = null,
): ResearchMarketRow {
  return {
    symbol,
    name: symbol,
    price: 100,
    changePercent: null,
    volume: null,
    marketCap,
    marketCapCurrency: "USD",
    marketCapEur,
    marketCapEurAsOf: marketCapEur === null ? null : "2026-10-14",
    sector: "Technology",
    exchange: "NASDAQ",
    country: "United States",
    priceSource: "awaiting Gateway SIP snapshot",
    priceAsOf: null,
    marketCapSource: "TradingView scanner",
    marketCapAsOf: null,
    sourceMode: null,
    sourceLabel: null,
  };
}

function marketData(market: "us" | "eu", rows: readonly ResearchMarketRow[]): ResearchMarketData {
  return {
    market,
    rows,
    coverage: {
      requested: rows.length,
      snapshots: 0,
      priced: 0,
      timed: 0,
      snapshotComplete: false,
      priceComplete: false,
      timeComplete: false,
      complete: false,
    },
    truncated: false,
  };
}

describe("market-cap treemap layout", () => {
  it("allocates tile area by positive market capitalization and excludes unknown sizes", () => {
    const layout = layoutMarketCapTreemap(
      marketData("us", [
        marketRow("AAA", 300),
        marketRow("BBB", 100),
        marketRow("CCC", null),
        marketRow("DDD", 0),
      ]),
    );
    const areas = new Map(layout.cells.map((cell) => [cell.symbol, cell.areaFraction]));

    expect(layout.excludedRows).toBe(2);
    expect([...areas.keys()]).toEqual(["AAA", "BBB"]);
    expect(areas.get("AAA")).toBeCloseTo(0.75);
    expect(areas.get("BBB")).toBeCloseTo(0.25);
    expect([...areas.values()].reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    const [largestCell, smallerCell] = layout.cells;
    if (!largestCell || !smallerCell) throw new Error("expected two weighted cells");
    expect((largestCell.width * largestCell.height) / 10_000).toBeCloseTo(0.75);
    expect((smallerCell.width * smallerCell.height) / 10_000).toBeCloseTo(0.25);
  });

  it("uses the EUR-converted cap for European market areas and preserves its source date", () => {
    const layout = layoutMarketCapTreemap(
      marketData("eu", [
        marketRow("AAA", 900, 200),
        marketRow("BBB", 500, 100),
        marketRow("CCC", 400, null),
      ]),
    );

    expect(layout.excludedRows).toBe(1);
    expect(layout.cells.map((cell) => cell.marketCap)).toEqual([200, 100]);
    expect(layout.cells.map((cell) => cell.currency)).toEqual(["EUR", "EUR"]);
    expect(layout.cells[0]?.marketCapAsOf).toBe("2026-10-14");
    expect(layout.cells[0]?.areaFraction).toBeCloseTo(2 / 3);
  });

  it("fails closed for invalid layout dimensions", () => {
    const layout = layoutMarketCapTreemap(
      marketData("us", [marketRow("AAA", 100)]),
      Number.NaN,
      560,
    );
    expect(layout).toEqual({ cells: [], excludedRows: 1 });
  });
});
