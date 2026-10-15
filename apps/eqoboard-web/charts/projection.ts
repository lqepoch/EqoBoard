import type { ChartPlotBar } from "./types";

export const MAX_CHART_PRICE = 1_000_000_000_000;
export const MAX_CHART_VOLUME = 1_000_000_000_000_000;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** A narrow adapter input assembled from a validated source row. It is not a wire DTO. */
export type ChartProjectionCandidate<TRow> = Readonly<{
  sourceRow: TRow;
  timeSeconds: number;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume: unknown;
  /** Supply only for contracts that guarantee exact decimal tokens. */
  exact?: Readonly<{ open: string; high: string; low: string; close: string; volume: string }>;
}>;

export type ChartProjectionResult<TRow> = Readonly<{
  bars: readonly ChartPlotBar<TRow>[];
  rejectedRows: number;
}>;

function parseNumber(value: unknown, maximum: number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= maximum ? value : null;
  }
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) return null;
  const projected = Number(value);
  return Number.isFinite(projected) && Math.abs(projected) <= maximum ? projected : null;
}

function projectOne<TRow>(candidate: ChartProjectionCandidate<TRow>): ChartPlotBar<TRow> | null {
  const { timeSeconds } = candidate;
  if (!Number.isSafeInteger(timeSeconds) || timeSeconds <= 0) return null;
  const open = parseNumber(candidate.exact?.open ?? candidate.open, MAX_CHART_PRICE);
  const high = parseNumber(candidate.exact?.high ?? candidate.high, MAX_CHART_PRICE);
  const low = parseNumber(candidate.exact?.low ?? candidate.low, MAX_CHART_PRICE);
  const close = parseNumber(candidate.exact?.close ?? candidate.close, MAX_CHART_PRICE);
  const volume = parseNumber(candidate.exact?.volume ?? candidate.volume, MAX_CHART_VOLUME);
  if (open === null || high === null || low === null || close === null || volume === null || volume < 0) return null;
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;

  return {
    time: timeSeconds as ChartPlotBar<TRow>["time"],
    open,
    high,
    low,
    close,
    volume,
    sourceRow: candidate.sourceRow,
    ...(candidate.exact ? { exact: candidate.exact } : {}),
  };
}

/**
 * Projects validated contract rows for plotting. Invalid numeric rows are counted and omitted;
 * callers must expose that count instead of implying a complete view.
 */
export function projectChartRows<TRow>(
  candidates: readonly ChartProjectionCandidate<TRow>[],
): ChartProjectionResult<TRow> {
  const bars: ChartPlotBar<TRow>[] = [];
  let rejectedRows = 0;
  for (const candidate of candidates) {
    const bar = projectOne(candidate);
    if (bar) bars.push(bar);
    else rejectedRows += 1;
  }
  bars.sort((left, right) => left.time - right.time);
  const deduplicated: ChartPlotBar<TRow>[] = [];
  for (const bar of bars) {
    const previous = deduplicated[deduplicated.length - 1];
    if (previous?.time === bar.time) {
      // Input order is source-defined. Preserve the last occurrence so newer-page precedence
      // can be applied by merge helpers before or after this projection as needed.
      deduplicated[deduplicated.length - 1] = bar;
    } else {
      deduplicated.push(bar);
    }
  }
  return { bars: deduplicated, rejectedRows };
}
