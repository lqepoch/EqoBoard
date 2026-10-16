import { describe, expect, it } from "vitest";
import {
  historyPageMatchesResolution,
  isCurrentHistoryGeneration,
  mergePagedHistoryHead,
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

function rowAt<TRow>(rows: readonly TRow[], index: number): TRow {
  const row = rows[index];
  if (row === undefined) throw new Error(`Expected chart fixture row at index ${index}.`);
  return row;
}

describe("chart history pagination and viewport", () => {
  it("lets the currently loaded snapshot win overlapping older-page rows", () => {
    const current = bars([20, 30]);
    const older = bars([10, 20]);
    const replacement = { ...rowAt(older, 1), close: 99 };
    const merged = mergeOlderPage(current, [rowAt(older, 0), replacement]);

    expect(merged.map((bar) => Number(bar.time))).toEqual([10, 20, 30]);
    expect(merged[1]?.close).toBe(10);
  });

  it("lets a newer validated head snapshot update overlapping OHLC and source rows", () => {
    const current: ChartPlotBar<Readonly<{ source: string }>>[] = bars([10, 20, 30]).map((bar) => ({
      ...bar,
      sourceRow: { source: "futu" },
    }));
    const refreshRows: ChartPlotBar<Readonly<{ source: string }>>[] = bars([30, 40]).map((bar) => ({
      ...bar,
      sourceRow: { source: "alpaca" },
    }));
    const refreshed = [{ ...rowAt(refreshRows, 0), close: 99 }, rowAt(refreshRows, 1)];
    const merged = mergeHeadRefresh(current, refreshed);

    expect(merged.map((bar) => Number(bar.time))).toEqual([10, 20, 30, 40]);
    expect(merged[2]?.close).toBe(99);
    expect(merged[2]?.sourceRow).toEqual({ source: "alpaca" });
    expect(merged[0]?.sourceRow).toEqual({ source: "futu" });
    expect(merged[3]?.close).toBe(10);
  });

  it("advances a head snapshot without replacing the exact-window cursor chain", () => {
    type Page = Readonly<{
      response: Readonly<{ effectiveResolution: string }>;
      projection: Readonly<{ bars: readonly ChartPlotBar<string>[] }>;
      envelope: Readonly<{
        request: Readonly<{ request_start: string; request_end: string; cursor: string | null }>;
      }>;
    }>;
    const originalHead: Page = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([20, 30]) },
      envelope: {
        request: {
          request_start: "2026-10-15T13:00:00Z",
          request_end: "2026-10-15T14:00:00Z",
          cursor: null,
        },
      },
    };
    const olderPage: Page = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([10, 20]) },
      envelope: {
        request: {
          request_start: "2026-10-15T13:00:00Z",
          request_end: "2026-10-15T14:00:00Z",
          cursor: "cursor-1",
        },
      },
    };
    const refreshedHead: Page = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([30, 40]) },
      envelope: {
        request: {
          request_start: "2026-10-15T13:01:00Z",
          request_end: "2026-10-15T14:01:00Z",
          cursor: null,
        },
      },
    };
    const cursorPages = [originalHead, olderPage];
    const currentRows = bars([10, 20, 30]);
    const advancedRows = bars([30, 40]);
    const latestAtOverlap = { ...rowAt(advancedRows, 0), close: 99 };
    const result = mergePagedHistoryHead(
      { cursorPages, latestHead: originalHead, bars: currentRows },
      refreshedHead,
      [latestAtOverlap, rowAt(advancedRows, 1)],
    );

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.snapshot.cursorPages).toBe(cursorPages);
    expect(result.snapshot.cursorPages[0]?.envelope.request.request_end).toBe(
      "2026-10-15T14:00:00Z",
    );
    expect(result.snapshot.latestHead).toBe(refreshedHead);
    expect(result.snapshot.bars.map((bar) => Number(bar.time))).toEqual([10, 20, 30, 40]);
    expect(result.snapshot.bars[2]?.close).toBe(99);
  });

  it("drops expired head rows on consecutive refreshes while preserving cursor pages", () => {
    type Page = Readonly<{
      response: Readonly<{ effectiveResolution: string }>;
      projection: Readonly<{ bars: readonly ChartPlotBar<string>[] }>;
    }>;
    const originalHead: Page = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([10, 20]) },
    };
    const olderPage: Page = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([0, 10]) },
    };
    const firstRefresh: Page = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([20, 30]) },
    };
    const secondRefresh: Page = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([40, 50]) },
    };
    const cursorPages = [originalHead, olderPage];
    const first = mergePagedHistoryHead(
      { cursorPages, latestHead: originalHead, bars: bars([0, 10, 20]) },
      firstRefresh,
      firstRefresh.projection.bars,
    );

    expect(first.accepted).toBe(true);
    if (!first.accepted) return;
    expect(first.snapshot.bars.map((bar) => Number(bar.time))).toEqual([0, 10, 20, 30]);

    const second = mergePagedHistoryHead(
      first.snapshot,
      secondRefresh,
      secondRefresh.projection.bars,
    );
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(second.snapshot.cursorPages).toBe(cursorPages);
    expect(second.snapshot.bars.map((bar) => Number(bar.time))).toEqual([0, 10, 20, 40, 50]);
  });

  it("rejects mixed effective resolutions for head and older pages", () => {
    const head = {
      response: { effectiveResolution: "1m" },
      projection: { bars: bars([10, 20]) },
    };
    const older = {
      response: { effectiveResolution: "1d" },
      projection: { bars: bars([1]) },
    };
    const result = mergePagedHistoryHead(
      { cursorPages: [head], latestHead: head, bars: bars([10, 20]) },
      older,
      bars([1]),
    );

    expect(result.accepted).toBe(false);
    expect(historyPageMatchesResolution([head], older)).toBe(false);
    const matching = { ...head, response: { effectiveResolution: "1m" } };
    expect(historyPageMatchesResolution([head], matching)).toBe(true);
  });

  it("rejects a response captured before the active selection generation", () => {
    expect(isCurrentHistoryGeneration(8, 7)).toBe(false);
    expect(isCurrentHistoryGeneration(8, 8)).toBe(true);
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
