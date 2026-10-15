/*
 * Viewport and page-overlap behavior is reimplemented from EqoBoard's
 * MIT-licensed chart widget at web/components/widgets/ChartWidget.tsx (source commit
 * fea1e952add7a11e799d6f9f198ddcee47fd12b6). See NOTICE.
 */
import type { ChartPlotBar } from "./types";

export type LogicalRange = Readonly<{ from: number; to: number }>;
export type ViewportIdentity = string;

export type SavedViewport = Readonly<{
  identity: ViewportIdentity;
  range: LogicalRange;
  anchorTime: number | null;
  anchorIndex: number;
}>;

export function mergeOlderPage<TRow>(
  currentNewestFirst: readonly ChartPlotBar<TRow>[],
  incomingOlderPage: readonly ChartPlotBar<TRow>[],
): readonly ChartPlotBar<TRow>[] {
  const byTime = new Map<number, ChartPlotBar<TRow>>();
  for (const row of [...incomingOlderPage, ...currentNewestFirst]) byTime.set(row.time, row);
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function mergeHeadRefresh<TRow>(
  current: readonly ChartPlotBar<TRow>[],
  refreshedHead: readonly ChartPlotBar<TRow>[],
): readonly ChartPlotBar<TRow>[] {
  const byTime = new Map<number, ChartPlotBar<TRow>>();
  // Core Bars V1 has no explicit correction/revision stream contract. Keep the
  // first validated observation for an existing candle and append only new bars.
  for (const row of [...refreshedHead, ...current]) byTime.set(row.time, row);
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function saveViewport<TRow>(
  identity: ViewportIdentity,
  range: LogicalRange,
  rows: readonly ChartPlotBar<TRow>[],
): SavedViewport {
  const anchorIndex = rows.length === 0
    ? 0
    : Math.max(0, Math.min(rows.length - 1, Math.floor(range.from)));
  return {
    identity,
    range: { from: range.from, to: range.to },
    anchorIndex,
    anchorTime: rows[anchorIndex]?.time ?? null,
  };
}

/** Translate a visible logical range by the actual anchor-bar displacement after prepending. */
export function remapViewportAfterPrepend<TRow>(
  saved: SavedViewport,
  nextRows: readonly ChartPlotBar<TRow>[],
): LogicalRange | null {
  if (saved.anchorTime === null) return null;
  const nextIndex = nextRows.findIndex((row) => row.time === saved.anchorTime);
  if (nextIndex < 0) return null;
  const shift = nextIndex - saved.anchorIndex;
  return { from: saved.range.from + shift, to: saved.range.to + shift };
}

export function rangeFollowsLatest(range: LogicalRange | null, rowCount: number): boolean {
  return range !== null && rowCount > 0 && range.to >= rowCount - 1.5;
}

export function retainViewportOnRefresh(
  range: LogicalRange | null,
  previousCount: number,
  nextCount: number,
): LogicalRange | null {
  if (!range) return null;
  if (!rangeFollowsLatest(range, previousCount)) return range;
  const width = Math.max(1, range.to - range.from);
  const to = Math.max(0, nextCount - 1);
  return { from: Math.max(0, to - width), to };
}
