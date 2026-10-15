import { describe, expect, it } from "vitest";
import {
  mergeHeadRefresh,
  mergeOlderPage,
  remapViewportAfterPrepend,
  retainViewportOnRefresh,
  saveViewport,
} from "./history";
import type { ChartPlotBar } from "./types";

function bars(times: readonly number[]): ChartPlotBar<string>[] {
  return times.map((time) => ({
    time: time as ChartPlotBar["time"],
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100,
    sourceRow: String(time),
  }));
}

describe("chart history pagination and viewport", () => {
  it("lets the currently loaded snapshot win overlapping older-page rows", () => {
    const current = bars([20, 30]);
    const older = bars([10, 20]);
    const replacement = { ...older[1]!, close: 99 };
    const merged = mergeOlderPage(current, [older[0]!, replacement]);

    expect(merged.map((bar) => Number(bar.time))).toEqual([10, 20, 30]);
    expect(merged[1]?.close).toBe(10);
  });

  it("appends new history observations without applying uncontracted candle corrections", () => {
    const current = bars([10, 20, 30]);
    const refreshRows = bars([30, 40]);
    const refreshed = [{ ...refreshRows[0]!, close: 99 }, refreshRows[1]!];
    const merged = mergeHeadRefresh(current, refreshed);

    expect(merged.map((bar) => Number(bar.time))).toEqual([10, 20, 30, 40]);
    expect(merged[2]?.close).toBe(10);
    expect(merged[3]?.close).toBe(10);
  });

  it("remaps a historical viewport by anchor candle after prepending an older page", () => {
    const prior = bars([30, 40, 50, 60, 70]);
    const saved = saveViewport("SPY|1d|core", { from: 2.2, to: 4.7 }, prior);
    const next = bars([10, 20, 30, 40, 50, 60, 70]);

    expect(saved.anchorTime).toBe(50);
    expect(remapViewportAfterPrepend(saved, next)).toEqual({ from: 4.2, to: 6.7 });
  });

  it("follows the tail on refresh only when the user was already viewing the latest rows", () => {
    expect(retainViewportOnRefresh({ from: 80, to: 99 }, 100, 105)).toEqual({ from: 85, to: 104 });
    expect(retainViewportOnRefresh({ from: 20, to: 39 }, 100, 105)).toEqual({ from: 20, to: 39 });
  });
});
