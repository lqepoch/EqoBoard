import { describe, expect, it } from "vitest";
import { calculateChartIndicators } from "./indicators";
import type { ChartPlotBar } from "./types";

function closeBars(closes: readonly number[], volumes?: readonly number[]): ChartPlotBar[] {
  return closes.map((close, index) => ({
    time: (1_720_000_000 + index * 60) as ChartPlotBar["time"],
    open: close,
    high: close,
    low: close,
    close,
    volume: volumes?.[index] ?? 1,
    sourceRow: index,
  }));
}

function rowAt<TRow>(rows: readonly TRow[], index: number): TRow {
  const row = rows[index];
  if (row === undefined) throw new Error(`Expected indicator fixture row at index ${index}.`);
  return row;
}

describe("chart indicators", () => {
  it("computes 20-row SMA and starts it at the twentieth observed bar", () => {
    const values = calculateChartIndicators(
      closeBars(Array.from({ length: 21 }, (_, i) => i + 1)),
      ["SMA20"],
    );
    const sma = values.overlays.SMA20;

    expect(sma).toHaveLength(2);
    expect(sma?.[0]?.value).toBe(10.5);
    expect(sma?.[1]?.value).toBe(11.5);
  });

  it("preserves legacy Wilder RSI zero-loss fallback for flat/upward data", () => {
    const flat = calculateChartIndicators(closeBars(Array(16).fill(5)), ["RSI"]).panes.rsi;
    const up = calculateChartIndicators(closeBars(Array.from({ length: 16 }, (_, i) => i + 1)), [
      "RSI",
    ]).panes.rsi;
    const down = calculateChartIndicators(closeBars(Array.from({ length: 16 }, (_, i) => 16 - i)), [
      "RSI",
    ]).panes.rsi;

    expect(flat?.[0]?.value).toBeCloseTo(100 - 100 / 101);
    expect(up?.[0]?.value).toBeCloseTo(100 - 100 / 101);
    expect(down?.[0]?.value).toBe(0);
  });

  it("labels cumulative loaded-window VWAP semantics in its title contract and volume-weights points", () => {
    const rows = [
      { ...rowAt(closeBars([10]), 0), high: 12, low: 8, volume: 1 },
      {
        ...rowAt(closeBars([20]), 0),
        time: 1_720_000_060 as ChartPlotBar["time"],
        high: 22,
        low: 18,
        volume: 3,
      },
    ];
    const vwap = calculateChartIndicators(rows, ["VWAP"]).overlays.VWAP;

    expect(vwap?.map((point) => point.value)).toEqual([10, 17.5]);
  });

  it("returns finite MACD components and population Bollinger bands for the loaded rows", () => {
    const bars = closeBars(Array.from({ length: 40 }, (_, i) => 100 + i));
    const values = calculateChartIndicators(bars, ["MACD", "BOLL"]);
    const macd = values.panes.macd;
    const bands = values.overlays.bollinger;

    expect(macd?.macd[0]?.time).toBe(bars[25]?.time);
    expect(macd?.histogram).toHaveLength(15);
    expect(macd?.histogram.every((point) => Number.isFinite(point.value))).toBe(true);
    expect(bands?.middle[0]?.value).toBe(109.5);
    expect((bands?.upper[0]?.value ?? 0) - (bands?.middle[0]?.value ?? 0)).toBeCloseTo(
      Math.sqrt(33.25) * 2,
    );
  });
});
