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

function mergeCursorPages<TPage extends ProjectedHistoryPage<TRow>, TRow>(
  pages: readonly TPage[],
): readonly ChartPlotBar<TRow>[] {
  const byTime = new Map<number, ChartPlotBar<TRow>>();
  // Cursor pages are stored newest first, so older pages are inserted first
  // and the original newer page wins when the cursor windows overlap.
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const page = pages[index];
    if (!page) continue;
    for (const bar of page.projection.bars) byTime.set(bar.time, bar);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function mergeHeadRefresh<TRow>(
  current: readonly ChartPlotBar<TRow>[],
  refreshedHead: readonly ChartPlotBar<TRow>[],
): readonly ChartPlotBar<TRow>[] {
  const byTime = new Map<number, ChartPlotBar<TRow>>();
  // A newer validated HTTP snapshot may update an overlapping candle. Rows
  // outside its server-resolved window remain available from loaded history.
  for (const row of [...current, ...refreshedHead]) byTime.set(row.time, row);
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

type EffectiveResolutionPage = Readonly<{
  response: Readonly<{ effectiveResolution: string }>;
}>;

type ProjectedHistoryPage<TRow> = EffectiveResolutionPage &
  Readonly<{ projection: Readonly<{ bars: readonly ChartPlotBar<TRow>[] }> }>;

export type PagedHistorySnapshot<TPage extends ProjectedHistoryPage<TRow>, TRow> = Readonly<{
  /** Pages remain bound to the exact cursor window returned by the initial page. */
  cursorPages: readonly TPage[];
  /** The latest unbounded head read may have a newer server-resolved window. */
  latestHead: TPage | null;
  bars: readonly ChartPlotBar<TRow>[];
}>;

export type PagedHistoryHeadResult<TPage extends ProjectedHistoryPage<TRow>, TRow> =
  | Readonly<{ accepted: true; snapshot: PagedHistorySnapshot<TPage, TRow> }>
  | Readonly<{ accepted: false; snapshot: PagedHistorySnapshot<TPage, TRow> }>;

export function isCurrentHistoryGeneration(current: number, captured: number): boolean {
  return current === captured;
}

export function historyPageMatchesResolution<TPage extends EffectiveResolutionPage>(
  pages: readonly TPage[],
  candidate: TPage,
): boolean {
  return pages.every(
    (page) => page.response.effectiveResolution === candidate.response.effectiveResolution,
  );
}

/**
 * Accepts a changing first-page snapshot without replacing the cursor chain that
 * was created for the prior exact request window. The current validated HTTP
 * snapshot wins on overlapping timestamps; older rows outside that window stay.
 */
export function mergePagedHistoryHead<TPage extends ProjectedHistoryPage<TRow>, TRow>(
  current: PagedHistorySnapshot<TPage, TRow>,
  nextHead: TPage,
  nextBars: readonly ChartPlotBar<TRow>[],
): PagedHistoryHeadResult<TPage, TRow> {
  const knownPages = [...current.cursorPages, ...(current.latestHead ? [current.latestHead] : [])];
  if (!historyPageMatchesResolution(knownPages, nextHead)) {
    return { accepted: false, snapshot: current };
  }

  const cursorPages = current.cursorPages.length > 0 ? current.cursorPages : [nextHead];
  // Rebuild from the fixed cursor chain on each refresh. Merging the last
  // accumulated head here retains every expired unique row forever.
  const cursorBars = mergeCursorPages<TPage, TRow>(current.cursorPages);
  return {
    accepted: true,
    snapshot: {
      cursorPages,
      latestHead: nextHead,
      bars: current.cursorPages.length > 0 ? mergeHeadRefresh(cursorBars, nextBars) : nextBars,
    },
  };
}

export function saveViewport<TRow>(
  identity: ViewportIdentity,
  range: LogicalRange,
  rows: readonly ChartPlotBar<TRow>[],
): SavedViewport {
  const anchorIndex =
    rows.length === 0 ? 0 : Math.max(0, Math.min(rows.length - 1, Math.floor(range.from)));
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
