import type { UTCTimestamp } from "lightweight-charts";

export const CHART_RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export const CHART_RESOLUTIONS = ["1m", "5m", "15m", "1h", "1d"] as const;
export type ChartResolution = (typeof CHART_RESOLUTIONS)[number];
export type ChartResolutionChoice = "auto" | ChartResolution;

export const CHART_STYLES = ["candles", "bars", "line", "area"] as const;
export type ChartStyle = (typeof CHART_STYLES)[number];

export const CHART_INDICATORS = ["SMA20", "SMA50", "SMA200", "EMA20", "VWAP", "RSI", "MACD", "BOLL"] as const;
export type IndicatorId = (typeof CHART_INDICATORS)[number];

export const CHART_DATA_MODES = ["core-bars", "yahoo-daily", "diagnostic-archive"] as const;
export type ChartDataMode = (typeof CHART_DATA_MODES)[number];

export const PROVIDER_PREFERENCES = ["auto", "alpaca_only", "futu_only"] as const;
export type ProviderPreference = (typeof PROVIDER_PREFERENCES)[number];
export type CallerAssetClass = "stock" | "etf";

/** UI-only coordinate projection. `sourceRow` remains the original validated row. */
export type ChartPlotBar<TRow = unknown> = Readonly<{
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sourceRow: TRow;
  exact?: Readonly<{ open: string; high: string; low: string; close: string; volume: string }>;
}>;

/** Display evidence derived from a validated response, never from a request preference. */
export type ChartEvidence = Readonly<{ label: string; value: string }>;

/** Display-only response status. This is not a wire type or completeness authority. */
export type ChartDisplayEvidence = Readonly<{
  mode: ChartDataMode;
  source: string;
  provider: string;
  feed: string;
  asOf: string;
  requestedWindow: string;
  effectiveResolution: string;
  coverage: string;
  completeness: "complete" | "partial" | "unknown";
  precision: "exact-decimal" | "provider-float" | "unknown";
  evidence: readonly ChartEvidence[];
}>;

export type IndicatorPoint = Readonly<{ time: number; value: number }>;

export type ChartIndicatorValues = Readonly<{
  overlays: Readonly<{
    SMA20: readonly IndicatorPoint[] | null;
    SMA50: readonly IndicatorPoint[] | null;
    SMA200: readonly IndicatorPoint[] | null;
    EMA20: readonly IndicatorPoint[] | null;
    VWAP: readonly IndicatorPoint[] | null;
    bollinger: Readonly<{
      upper: readonly IndicatorPoint[];
      middle: readonly IndicatorPoint[];
      lower: readonly IndicatorPoint[];
    }> | null;
  }>;
  panes: Readonly<{
    rsi: readonly IndicatorPoint[] | null;
    macd: Readonly<{
      macd: readonly IndicatorPoint[];
      signal: readonly IndicatorPoint[];
      histogram: readonly IndicatorPoint[];
    }> | null;
  }>;
}>;

export const DEFAULT_CHART_INDICATORS: readonly IndicatorId[] = Object.freeze(["SMA20", "EMA20"]);
