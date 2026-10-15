"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  BarSeries,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmt, fmtBig } from "../../lib/api";
import {
  CHART_RANGES,
  MAX_HISTORY_PAGES,
  displayHistoryValue,
  historyDowngradeReason,
  historyResolution,
  useChartHistory,
  type ChartAssetClass,
  type ChartHistoryCandle,
  type ChartRange,
  type ChartResolution,
} from "../../lib/chart-history";
import { bollinger, ema, macd, rsi, sma, vwap } from "../../lib/indicators";
import { useTradingStore, type ChartType, type IndicatorKey, type KlineInterval } from "../../store/trading-terminal";

const CHART_TYPES: ChartType[] = ["candles", "bars", "line", "area"];
const KLINE_INTERVALS: Array<{ id: KlineInterval; label: string }> = [
  { id: "AUTO", label: "Auto" },
  { id: "1s", label: "[1s]" }, { id: "5s", label: "[5s]" }, { id: "10s", label: "[10s]" },
  { id: "1m", label: "[1m]" }, { id: "5m", label: "[5m]" }, { id: "10m", label: "[10m]" },
  { id: "15m", label: "[15m]" }, { id: "30m", label: "[30m]" }, { id: "1h", label: "[1h]" },
  { id: "2h", label: "[2h]" }, { id: "4h", label: "[4h]" }, { id: "1D", label: "[1D]" },
  { id: "1W", label: "[1W]" },
];
const QUERYABLE_INTERVALS: Partial<Record<KlineInterval, ChartResolution>> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "1D": "1d",
};
const UNSUPPORTED_INTERVAL_REASON = "Unavailable: market bars supports 1m, 5m, 15m, 1h, and 1d; no substitute interval is requested.";
const DRAWING_TOOLS = [
  { id: "crosshair", icon: "✛", title: "Crosshair" },
  { id: "line", icon: "╱", title: "Trend Line" },
  { id: "fib", icon: "≡", title: "Fibonacci" },
  { id: "brush", icon: "✎", title: "Brush" },
  { id: "text", icon: "T", title: "Text Annotation" },
  { id: "pattern", icon: "☺", title: "Patterns" },
  { id: "ruler", icon: "📏", title: "Ruler" },
  { id: "measure", icon: "🔍", title: "Measure" },
  { id: "lock", icon: "🔒", title: "Lock Elements" },
] as const;
const INDICATORS: Array<{ key: IndicatorKey; label: string; color: string }> = [
  { key: "SMA20", label: "SMA20", color: "text-amber-400" },
  { key: "SMA50", label: "SMA50", color: "text-cyan-400" },
  { key: "SMA200", label: "SMA200", color: "text-purple-400" },
  { key: "EMA20", label: "EMA20", color: "text-rose-400" },
  { key: "VWAP", label: "VWAP", color: "text-teal-300" },
  { key: "RSI", label: "RSI", color: "text-orange-300" },
  { key: "MACD", label: "MACD", color: "text-sky-300" },
  { key: "BOLL", label: "BOLL", color: "text-violet-300" },
  { key: "VOL", label: "VOL", color: "text-emerald-400" },
];
const INDICATOR_COLORS: Record<string, string> = {
  SMA20: "#fbbf24", SMA50: "#38bdf8", SMA200: "#c084fc", EMA20: "#fb7185",
  VWAP: "#5eead4", RSI: "#fdba74", MACD: "#7dd3fc",
};
const ts = (time: number) => time as UTCTimestamp;
type ChartSeries = ReturnType<IChartApi["addSeries"]>;
type MainChartSeriesSet = {
  main: ChartSeries;
  volume: ChartSeries | null;
  overlays: Map<string, ChartSeries>;
  pane: ChartSeries[];
  paneSignature: string;
};
type SavedChartViewport = { identity: string; from: number; to: number; anchorIndex: number; anchorTime: number | null };

function saveChartViewport(identity: string, range: { from: number; to: number }, bars: ChartHistoryCandle[]): SavedChartViewport {
  const anchorIndex = bars.length > 0 ? Math.max(0, Math.min(bars.length - 1, Math.floor(range.from))) : 0;
  return { identity, from: range.from, to: range.to, anchorIndex, anchorTime: bars[anchorIndex]?.time ?? null };
}

function setSeriesData(series: ChartSeries, data: unknown[]) {
  series.setData(data as never);
}

type PointerPan = { startX: number; movedOlder: boolean; requested: boolean; active: boolean };
const YFINANCE_RESEARCH_SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,31}$/;

function safeDetails(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text.slice(0, 4_000) : "unknown";
  } catch {
    return "unknown";
  }
}

export default function MainChartPanel({ researchOrigin = null }: { researchOrigin?: string | null }) {
  const activeSymbol = useTradingStore((state) => state.activeSymbol);
  const chartType = useTradingStore((state) => state.chartType);
  const setChartType = useTradingStore((state) => state.setChartType);
  const indicators = useTradingStore((state) => state.indicators);
  const toggleIndicator = useTradingStore((state) => state.toggleIndicator);
  const providerMode = useTradingStore((state) => state.providerMode);
  const setProviderMode = useTradingStore((state) => state.setProviderMode);
  const klineInterval = useTradingStore((state) => state.klineInterval);
  const setKlineInterval = useTradingStore((state) => state.setKlineInterval);
  const currentQuote = useTradingStore((state) => state.currentQuote);
  const setHoveredBar = useTradingStore((state) => state.setHoveredBar);
  const [range, setRange] = useState<ChartRange>("1D");
  const [assetClass, setAssetClass] = useState<ChartAssetClass>(activeSymbol === "QQQ" ? "etf" : "stock");
  const [hoveredBar, setLocalHoveredBar] = useState<ChartHistoryCandle | null>(null);
  const [activeDrawingTool, setActiveDrawingTool] = useState("crosshair");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<MainChartSeriesSet | null>(null);
  const barsRef = useRef<ChartHistoryCandle[]>([]);
  const barByTimeRef = useRef<Map<number, ChartHistoryCandle>>(new Map());
  const appliedBarsRef = useRef<ChartHistoryCandle[]>([]);
  const appliedIdentityRef = useRef<string | null>(null);
  const forceFitIdentityRef = useRef<string | null>(null);
  const currentIdentityRef = useRef("");
  const currentTimeVisibleRef = useRef(true);
  const savedViewportRef = useRef<SavedChartViewport | null>(null);
  const chartGenerationRef = useRef(0);
  const setHoveredBarRef = useRef(setHoveredBar);
  const setLocalHoveredBarRef = useRef(setLocalHoveredBar);
  const pointerPanRef = useRef<PointerPan | null>(null);
  const pagingLockRef = useRef(false);

  useEffect(() => {
    setAssetClass(activeSymbol === "QQQ" ? "etf" : "stock");
    setLocalHoveredBar(null);
    setHoveredBar(null);
  }, [activeSymbol, setHoveredBar]);

  const selectedResolution = klineInterval === "AUTO" ? undefined : QUERYABLE_INTERVALS[klineInterval] ?? null;
  const history = useChartHistory(
    activeSymbol, range, providerMode, assetClass, selectedResolution !== null, selectedResolution,
  );
  const bars = history.bars;
  const historyResponse = history.latestPage;
  const historyIdentityResolution = selectedResolution === null
    ? `unsupported:${klineInterval}`
    : selectedResolution ?? history.requestedResolution ?? "unknown";
  const historyIdentity = `${activeSymbol}|${range}|${historyIdentityResolution}`;
  const effectiveResolution = historyResolution(historyResponse, "effective_resolution");
  const timeVisible = effectiveResolution === "unknown"
    ? (selectedResolution ?? history.requestedResolution) !== "1d"
    : effectiveResolution !== "1d";
  const requestOlder = useCallback(() => {
    if (!history.hasNextPage || history.isFetchingNextPage || pagingLockRef.current) return;
    pagingLockRef.current = true;
    void history.fetchNextPage().finally(() => { pagingLockRef.current = false; });
  }, [history.fetchNextPage, history.hasNextPage, history.isFetchingNextPage]);
  const requestOlderRef = useRef(requestOlder);
  requestOlderRef.current = requestOlder;
  const canFetchOlderRef = useRef(false);
  canFetchOlderRef.current = Boolean(history.hasNextPage);
  const maybeRequestOlder = useCallback((visibleFrom: number) => {
    const pan = pointerPanRef.current;
    if (!pan?.movedOlder || pan.requested || visibleFrom > 12 || !canFetchOlderRef.current) return;
    pan.requested = true;
    requestOlderRef.current();
  }, []);

  const calculated = useMemo(() => {
    if (!bars || bars.length === 0) return null;
    return {
      SMA20: indicators.SMA20 ? sma(bars, 20) : null,
      SMA50: indicators.SMA50 ? sma(bars, 50) : null,
      SMA200: indicators.SMA200 ? sma(bars, 200) : null,
      EMA20: indicators.EMA20 ? ema(bars, 20) : null,
      VWAP: indicators.VWAP ? vwap(bars) : null,
      RSI: indicators.RSI ? rsi(bars) : null,
      MACD: indicators.MACD ? macd(bars) : null,
      BOLL: indicators.BOLL ? bollinger(bars) : null,
    };
  }, [bars, indicators]);

  const gaps = Array.isArray(historyResponse?.gaps) ? historyResponse.gaps : null;
  const segments = Array.isArray(historyResponse?.segments) ? historyResponse.segments : null;
  const displayBar = hoveredBar ?? bars?.[bars.length - 1] ?? null;
  const isBarUp = displayBar ? displayBar.close >= displayBar.open : true;
  const realQuote = currentQuote !== null && currentQuote.symbol === activeSymbol &&
    "isRealFutu" in currentQuote && currentQuote.isRealFutu === true
    ? currentQuote
    : null;
  const quoteDayRange = realQuote?.dayRange;
  const dayRangePosition = realQuote && quoteDayRange && Number.isFinite(quoteDayRange.low) && Number.isFinite(quoteDayRange.high) &&
    Number.isFinite(realQuote.price) && quoteDayRange.low < quoteDayRange.high && realQuote.price > 0
    ? Math.max(0, Math.min(100, ((realQuote.price - quoteDayRange.low) / (quoteDayRange.high - quoteDayRange.low)) * 100))
    : null;
  const dashboardRsi = useMemo(() => {
    const latest = bars?.length ? rsi(bars).at(-1)?.value : undefined;
    return typeof latest === "number" && Number.isFinite(latest) ? latest : null;
  }, [bars]);
  const yfinanceResearchHref = researchOrigin && YFINANCE_RESEARCH_SYMBOL.test(activeSymbol)
    ? `${researchOrigin}/research/yfinance/${encodeURIComponent(activeSymbol)}`
    : null;
  barsRef.current = bars ?? [];
  currentIdentityRef.current = historyIdentity;
  currentTimeVisibleRef.current = timeVisible;
  setHoveredBarRef.current = setHoveredBar;
  setLocalHoveredBarRef.current = setLocalHoveredBar;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const chart = createChart(element, {
      layout: {
        background: { color: "#080b11" },
        textColor: "#94a3b8",
        fontSize: 10,
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        attributionLogo: false,
      },
      grid: { vertLines: { color: "#111622" }, horzLines: { color: "#111622" } },
      crosshair: { mode: 0, vertLine: { color: "#38bdf8", width: 1, style: LineStyle.Dotted }, horzLine: { color: "#38bdf8", width: 1, style: LineStyle.Dotted } },
      timeScale: {
        borderColor: "#1a2233",
        timeVisible: currentTimeVisibleRef.current,
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: "#1a2233", scaleMargins: { top: 0.08, bottom: 0.22 } },
      autoSize: true,
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;
    element.dataset.chartInstanceGeneration = String(++chartGenerationRef.current);

    const upColor = "#10b981";
    const downColor = "#ef4444";
    let main: ChartSeries;
    if (chartType === "candles") {
      main = chart.addSeries(CandlestickSeries, {
        upColor, downColor, borderUpColor: upColor, borderDownColor: downColor, wickUpColor: upColor, wickDownColor: downColor,
      });
    } else if (chartType === "bars") {
      main = chart.addSeries(BarSeries, { upColor, downColor });
    } else if (chartType === "line") {
      main = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2 });
    } else {
      main = chart.addSeries(AreaSeries, { lineColor: "#38bdf8", topColor: "rgba(56,189,248,0.3)", bottomColor: "rgba(56,189,248,0)", lineWidth: 2 });
    }
    seriesRef.current = { main, volume: null, overlays: new Map(), pane: [], paneSignature: "" };

    const crosshairListener = (param: { time?: unknown }) => {
      const latestBars = barsRef.current;
      const selected = typeof param.time === "number" ? barByTimeRef.current.get(param.time) : undefined;
      const next = selected ?? latestBars[latestBars.length - 1];
      setLocalHoveredBarRef.current(next ?? null);
      setHoveredBarRef.current(next ? { ...next, change: next.close - next.open, changePercent: next.open === 0 ? 0 : ((next.close - next.open) / next.open) * 100 } : null);
    };
    chart.subscribeCrosshairMove(crosshairListener);

    const visibleRangeListener = () => {
      const visible = chart.timeScale().getVisibleLogicalRange();
      if (visible) {
        element.dataset.visibleLogicalRange = `${visible.from.toFixed(3)}:${visible.to.toFixed(3)}`;
      }
      if (visible) maybeRequestOlder(visible.from);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(visibleRangeListener);

    return () => {
      const visible = chart.timeScale().getVisibleLogicalRange();
      if (visible) {
        savedViewportRef.current = saveChartViewport(currentIdentityRef.current, visible, appliedBarsRef.current);
      }
      chart.unsubscribeCrosshairMove(crosshairListener);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(visibleRangeListener);
      chart.remove();
      if (chartRef.current === chart) chartRef.current = null;
      seriesRef.current = null;
    };
  }, [chartType, maybeRequestOlder]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    const nextBars = bars ?? [];
    const previousBars = appliedBarsRef.current;
    const previousIdentity = appliedIdentityRef.current;
    const identityChanged = previousIdentity !== historyIdentity;
    if (identityChanged) {
      forceFitIdentityRef.current = historyIdentity;
      savedViewportRef.current = null;
      pointerPanRef.current = null;
    }

    const visible = chart.timeScale().getVisibleLogicalRange();
    const savedViewport = savedViewportRef.current?.identity === historyIdentity ? savedViewportRef.current : null;
    const previousVisible = savedViewport && previousBars.length === 0
      ? { from: savedViewport.from, to: savedViewport.to }
      : visible ?? (savedViewport ? { from: savedViewport.from, to: savedViewport.to } : null);
    if (nextBars.length === 0 && previousBars.length > 0 && !identityChanged && previousVisible) {
      savedViewportRef.current = saveChartViewport(historyIdentity, previousVisible, previousBars);
    }
    barByTimeRef.current = new Map(nextBars.map((bar) => [bar.time, bar]));

    if (chartType === "candles" || chartType === "bars") {
      setSeriesData(series.main, nextBars.map((bar) => ({ time: ts(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    } else {
      setSeriesData(series.main, nextBars.map((bar) => ({ time: ts(bar.time), value: bar.close })));
    }

    if (indicators.VOL && !series.volume) {
      series.volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" } });
      series.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    } else if (!indicators.VOL && series.volume) {
      chart.removeSeries(series.volume);
      series.volume = null;
    }
    if (series.volume) {
      setSeriesData(series.volume, nextBars.map((bar) => ({
        time: ts(bar.time), value: bar.volume,
        color: bar.close >= bar.open ? "rgba(16,185,129,0.45)" : "rgba(239,68,68,0.45)",
      })));
    }

    const overlayData: Array<[string, Array<{ time: number; value: number }> | null | undefined, string, LineStyle?]> = [
      ["SMA20", calculated?.SMA20, INDICATOR_COLORS.SMA20],
      ["SMA50", calculated?.SMA50, INDICATOR_COLORS.SMA50],
      ["SMA200", calculated?.SMA200, INDICATOR_COLORS.SMA200],
      ["EMA20", calculated?.EMA20, INDICATOR_COLORS.EMA20],
      ["VWAP", calculated?.VWAP, INDICATOR_COLORS.VWAP],
      ["BOLL_U", calculated?.BOLL?.upper, "rgba(167,139,250,0.75)", LineStyle.Dashed],
      ["BOLL_M", calculated?.BOLL?.middle, "rgba(196,181,253,0.85)"],
      ["BOLL_L", calculated?.BOLL?.lower, "rgba(167,139,250,0.75)", LineStyle.Dashed],
    ];
    const desiredOverlayKeys = new Set(overlayData.filter(([, points]) => points).map(([key]) => key));
    for (const [key, existing] of series.overlays) {
      if (!desiredOverlayKeys.has(key)) {
        chart.removeSeries(existing);
        series.overlays.delete(key);
      }
    }
    for (const [key, points, color, style] of overlayData) {
      if (!points) continue;
      let line = series.overlays.get(key);
      if (!line) {
        line = chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false });
        series.overlays.set(key, line);
      }
      setSeriesData(line, points.map((point) => ({ time: ts(point.time), value: point.value })));
    }

    const paneSignature = [calculated?.RSI ? "RSI" : "", calculated?.MACD ? "MACD" : ""].filter(Boolean).join("|");
    if (paneSignature !== series.paneSignature) {
      for (const paneSeries of series.pane) chart.removeSeries(paneSeries);
      series.pane = [];
      series.paneSignature = paneSignature;
      let paneIndex = 1;
      if (calculated?.RSI) {
        series.pane.push(chart.addSeries(LineSeries, { color: INDICATOR_COLORS.RSI, lineWidth: 1, priceLineVisible: false }, paneIndex++));
      }
      if (calculated?.MACD) {
        const macdPane = paneIndex++;
        series.pane.push(chart.addSeries(HistogramSeries, { color: "#7dd3fc", priceLineVisible: false }, macdPane));
        series.pane.push(chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 1, priceLineVisible: false }, macdPane));
        series.pane.push(chart.addSeries(LineSeries, { color: "#e2e8f0", lineWidth: 1, priceLineVisible: false }, macdPane));
      }
    }
    let paneSeriesIndex = 0;
    if (calculated?.RSI) {
      setSeriesData(series.pane[paneSeriesIndex++]!, calculated.RSI.map((point) => ({ time: ts(point.time), value: point.value })));
    }
    if (calculated?.MACD) {
      const macd = calculated.MACD;
      setSeriesData(series.pane[paneSeriesIndex++]!, macd.histogram.map((point) => ({
        time: ts(point.time), value: point.value,
        color: point.value >= 0 ? "rgba(16,185,129,0.65)" : "rgba(239,68,68,0.65)",
      })));
      setSeriesData(series.pane[paneSeriesIndex++]!, macd.macd.map((point) => ({ time: ts(point.time), value: point.value })));
      setSeriesData(series.pane[paneSeriesIndex++]!, macd.signal.map((point) => ({ time: ts(point.time), value: point.value })));
    }

    chart.applyOptions({ timeScale: { timeVisible } });
    if (nextBars.length > 0) {
      if (forceFitIdentityRef.current === historyIdentity || (previousBars.length === 0 && !savedViewport)) {
        chart.timeScale().fitContent();
        if (forceFitIdentityRef.current === historyIdentity) forceFitIdentityRef.current = null;
      } else if (previousVisible) {
        const oldIndex = savedViewport && previousBars.length === 0
          ? savedViewport.anchorIndex
          : Math.max(0, Math.min(previousBars.length - 1, Math.floor(previousVisible.from)));
        const oldAnchorTime = savedViewport && previousBars.length === 0
          ? savedViewport.anchorTime
          : previousBars[oldIndex]?.time ?? null;
        const newIndex = oldAnchorTime === null ? -1 : nextBars.findIndex((bar) => bar.time === oldAnchorTime);
        const shift = newIndex >= 0 ? newIndex - oldIndex : 0;
        try {
          chart.timeScale().setVisibleLogicalRange({ from: previousVisible.from + shift, to: previousVisible.to + shift });
        } catch {
          // If the new page is shorter than the old viewport, keep the current logical range.
        }
      } else {
        chart.timeScale().fitContent();
      }
    }

    appliedBarsRef.current = nextBars;
    appliedIdentityRef.current = historyIdentity;
    if (nextBars.length > 0 || identityChanged) savedViewportRef.current = null;
    const updatedVisible = chart.timeScale().getVisibleLogicalRange();
    if (updatedVisible) {
      const element = containerRef.current;
      if (element) element.dataset.visibleLogicalRange = `${updatedVisible.from.toFixed(3)}:${updatedVisible.to.toFixed(3)}`;
    } else if (containerRef.current) {
      delete containerRef.current.dataset.visibleLogicalRange;
    }
  }, [bars, calculated, chartType, historyIdentity, indicators.VOL, timeVisible]);

  function beginPointerPan(event: ReactPointerEvent<HTMLDivElement>) {
    pointerPanRef.current = { startX: event.clientX, movedOlder: false, requested: false, active: true };
  }

  function movePointerPan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = pointerPanRef.current;
    if (!pan?.active) return;
    if (event.clientX - pan.startX >= 8) pan.movedOlder = true;
    const visible = chartRef.current?.timeScale().getVisibleLogicalRange();
    if (pan.movedOlder && visible) maybeRequestOlder(visible.from);
  }

  function finishPointerPan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = pointerPanRef.current;
    if (!pan) return;
    if (event.clientX - pan.startX >= 8) pan.movedOlder = true;
    pan.active = false;
    if (!pan.movedOlder) {
      pointerPanRef.current = null;
      return;
    }
    const checkFinalRange = () => {
      if (pointerPanRef.current !== pan || pan.requested) return;
      const visible = chartRef.current?.timeScale().getVisibleLogicalRange();
      if (visible) maybeRequestOlder(visible.from);
    };
    checkFinalRange();
    if (!pan.requested) {
      requestAnimationFrame(() => {
        checkFinalRange();
        if (!pan.requested && pointerPanRef.current === pan) pointerPanRef.current = null;
      });
    }
  }

  function cancelPointerPan() {
    pointerPanRef.current = null;
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#07090e] overflow-hidden select-none" data-testid="main-chart-panel">
      <div className="min-h-9 bg-[#0b0e16] border-b border-[#182133] flex items-center gap-1 px-2.5 py-1 shrink-0 overflow-x-auto no-scrollbar">
        {CHART_RANGES.map((item) => (
          <button
            key={item}
            data-testid={`main-chart-range-${item}`}
            aria-label={`Chart range ${item}`}
            aria-pressed={range === item}
            onClick={() => setRange(item)}
            className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${range === item ? "bg-cyan-950/80 text-cyan-300 border border-cyan-600/80" : "text-slate-400 hover:text-slate-200"}`}
          >
            {item}
          </button>
        ))}
        <div role="group" aria-label="Chart interval" className="flex items-center gap-0.5 border-l border-[#1a2233] pl-2 ml-1" data-testid="main-chart-interval-controls">
          {KLINE_INTERVALS.map((item) => {
            const resolution = QUERYABLE_INTERVALS[item.id];
            const auto = item.id === "AUTO";
            const supported = auto || resolution !== undefined;
            return (
              <button
                key={item.id}
                data-testid={`main-chart-interval-${item.id}`}
                data-resolution={auto ? "auto" : resolution ?? "unsupported"}
                aria-label={auto ? "Chart interval Auto (range default)" : supported ? `Chart interval ${item.id}` : `Chart interval ${item.id} unavailable`}
                aria-pressed={klineInterval === item.id}
                title={auto ? "Use the documented resolution for the selected range" : supported ? `Request ${resolution} bars` : UNSUPPORTED_INTERVAL_REASON}
                disabled={!supported}
                onClick={() => { if (supported) setKlineInterval(item.id); }}
                className={`px-1 py-0.5 text-[9px] font-mono rounded ${supported
                  ? klineInterval === item.id ? "bg-cyan-950/80 text-cyan-300 border border-cyan-600/80" : "text-slate-400 hover:text-slate-200"
                  : "cursor-not-allowed text-slate-600"}`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <label className="sr-only" htmlFor="main-chart-provider-mode">Chart provider mode</label>
        <select
          id="main-chart-provider-mode"
          aria-label="Main chart provider mode"
          data-testid="main-chart-provider-mode"
          className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#111] border border-[#223048] text-slate-200"
          value={providerMode}
          onChange={(event) => setProviderMode(event.target.value as typeof providerMode)}
        >
          <option value="auto">Auto</option>
          <option value="alpaca_only">Alpaca only</option>
          <option value="futu_only">Futu only</option>
        </select>
        <label className="sr-only" htmlFor="main-chart-asset-class">Caller-declared asset class</label>
        <select
          id="main-chart-asset-class"
          aria-label="Main chart caller-declared asset class"
          data-testid="main-chart-asset-class"
          className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-[#111] border border-[#223048] text-slate-200"
          value={assetClass}
          onChange={(event) => setAssetClass(event.target.value as ChartAssetClass)}
        >
          <option value="stock">Stock</option>
          <option value="etf">ETF</option>
        </select>
        {yfinanceResearchHref ? (
          <a
            href={yfinanceResearchHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="main-chart-yfinance-research-link"
            className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-amber-900/70 text-amber-300 hover:bg-amber-950/40"
          >
            Yahoo daily research ↗
          </a>
        ) : (
          <button
            type="button"
            disabled
            title={!researchOrigin ? "Unavailable: no validated research hostname is configured." : "Unavailable: the active symbol is outside the Yahoo ticker route allowlist."}
            data-testid="main-chart-yfinance-research-unavailable"
            className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-[#223048] text-slate-600 cursor-not-allowed"
          >
            Yahoo daily research unavailable
          </button>
        )}
        {history.hasNextPage && (
          <button
            className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-[#223048] text-slate-300"
            data-testid="main-chart-load-older"
            disabled={history.isFetchingNextPage}
            onClick={requestOlder}
          >
            {history.isFetchingNextPage ? "Loading older…" : "Load older"}
          </button>
        )}
        <div className="flex items-center gap-1 border-l border-[#1a2233] pl-2 ml-1">
          {INDICATORS.map((item) => (
            <button
              key={item.key}
              aria-pressed={indicators[item.key]}
              onClick={() => toggleIndicator(item.key)}
              className={`px-1.5 py-0.5 text-[9px] font-mono rounded ${indicators[item.key] ? `bg-[#141b28] border border-[#223048] ${item.color}` : "text-slate-500 hover:text-slate-300"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 border-l border-[#1a2233] pl-2 ml-auto">
          {CHART_TYPES.map((type) => (
            <button
              key={type}
              aria-pressed={chartType === type}
              onClick={() => setChartType(type)}
              className={`px-1.5 py-0.5 text-[9px] font-mono uppercase rounded ${chartType === type ? "bg-cyan-950 text-cyan-300 border border-cyan-700/80" : "text-slate-400 hover:text-slate-200"}`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-8 bg-[#0a0d14] border-b border-[#141b28] px-3 py-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-slate-400 shrink-0" data-testid="main-chart-history-status">
        <span className="font-bold text-slate-200">{activeSymbol} · {range} · {klineInterval === "AUTO" ? "Auto" : klineInterval} · {bars?.length ?? 0} bars</span>
        <span>Mode {providerMode}</span>
        <span>Source {displayHistoryValue(historyResponse?.source_label ?? historyResponse?.source)}</span>
        <span>Provider {displayHistoryValue(historyResponse?.provider)}</span>
        <span>Feed {displayHistoryValue(historyResponse?.feed)}</span>
        <span>Delay {displayHistoryValue(historyResponse?.delay)}</span>
        <span>Verification {displayHistoryValue(historyResponse?.verification ?? historyResponse?.verified_at)}</span>
        <span>Resolution {historyResolution(historyResponse, "requested_resolution")} → {historyResolution(historyResponse, "effective_resolution")}</span>
        <span>Downgrade {historyDowngradeReason(historyResponse)}</span>
        <span>Coverage {displayHistoryValue(historyResponse?.coverage_status)}</span>
        <span>Segments {segments?.length ?? "unknown"} · Gaps {gaps?.length ?? "unknown"}</span>
        <span>As of {displayHistoryValue(historyResponse?.as_of ?? historyResponse?.asOf)}</span>
        <span>Asset class {assetClass} (caller declared)</span>
        {historyResponse && (
          <details className="basis-full text-[9px]">
            <summary className="cursor-pointer text-slate-500">Coverage, gap and provenance detail</summary>
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-slate-400">{safeDetails({
              coverage_status: historyResponse.coverage_status,
              segments: historyResponse.segments,
              gaps: historyResponse.gaps,
              source_provenance: historyResponse.source_provenance,
              cache_status: historyResponse.cache_status,
              market_calendar_version: historyResponse.market_calendar_version,
            })}</pre>
          </details>
        )}
      </div>
      {selectedResolution === null && <div role="status" className="px-3 py-1 text-[10px] text-amber-400" data-testid="main-chart-resolution-unavailable">History unavailable for {klineInterval}: {UNSUPPORTED_INTERVAL_REASON}</div>}
      {history.error && <div role="alert" className="px-3 py-1 text-[10px] text-rose-400" data-testid="main-chart-history-error">History unavailable: {(history.error as Error).message}</div>}
      {history.projectionError && <div role="alert" className="px-3 py-1 text-[10px] text-rose-400">{history.projectionError}</div>}
      {history.pageLimitReached && (
        <div role="status" className="px-3 py-1 text-[10px] text-amber-400" data-testid="main-chart-history-page-limit">
          {range === "MAX"
            ? `MAX history is incomplete: the ${MAX_HISTORY_PAGES}-page limit was reached; older bars remain unloaded.`
            : `History reached the ${MAX_HISTORY_PAGES}-page limit; older bars remain unloaded.`}
        </div>
      )}
      {selectedResolution !== null && history.isLoading && <div className="px-3 py-1 text-[10px] text-slate-500">Loading history…</div>}

      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        <div className="w-8 bg-[#0a0d14] border-r border-[#141b28] flex flex-col items-center py-2 gap-2 text-slate-500 text-xs shrink-0 select-none">
          {DRAWING_TOOLS.map((tool) => (
            <button
              key={tool.id}
              data-testid={`main-chart-tool-${tool.id}`}
              aria-label={tool.title}
              aria-pressed={activeDrawingTool === tool.id}
              onClick={() => setActiveDrawingTool(tool.id)}
              className={`w-6 h-6 rounded flex items-center justify-center ${activeDrawingTool === tool.id ? "bg-cyan-950/80 text-cyan-300 border border-cyan-700/60" : "hover:bg-[#141b27] hover:text-slate-300"}`}
              title={tool.title}
            >
              {tool.icon}
            </button>
          ))}
        </div>
        <div
          className="flex-1 relative w-full h-full min-h-0 overflow-hidden"
          onPointerDownCapture={beginPointerPan}
          onPointerMoveCapture={movePointerPan}
          onPointerUp={finishPointerPan}
          onPointerCancel={cancelPointerPan}
        >
          <div ref={containerRef} className="w-full h-full" data-testid="main-chart-canvas" data-chart-instance-generation="0" />
          {displayBar && (
            <div className="absolute top-1 left-2 z-10 flex flex-wrap gap-x-3 bg-[rgba(8,11,17,0.8)] px-2 py-1 text-[10px] font-mono pointer-events-none">
              <span>O {displayBar.exact?.open ?? fmt(displayBar.open)}</span>
              <span>H {displayBar.exact?.high ?? fmt(displayBar.high)}</span>
              <span>L {displayBar.exact?.low ?? fmt(displayBar.low)}</span>
              <span className={isBarUp ? "text-emerald-400" : "text-rose-400"}>C {displayBar.exact?.close ?? fmt(displayBar.close)}</span>
              <span>Vol {displayBar.exact?.volume ?? fmtBig(displayBar.volume)}</span>
            </div>
          )}
        </div>
      </div>
      <section className="h-32 bg-[#0b0e16] border-t border-[#182133] px-3 py-2 flex flex-col gap-2 shrink-0" aria-label="Intelligence Dashboard" data-testid="main-chart-intelligence-dashboard">
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
          <span className="font-semibold text-slate-300">Intelligence Dashboard</span>
          <span className="text-slate-600 text-xs">⋯</span>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 h-24 min-h-0">
          <article className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between min-w-0" data-testid="main-chart-day-range">
            <span className="text-[10px] font-mono text-slate-400">Day Range</span>
            {realQuote && quoteDayRange && dayRangePosition !== null ? (
              <>
                <div className="relative py-1.5" aria-label={`Quote price position in day range ${dayRangePosition.toFixed(1)} percent`}>
                  <div className="h-1.5 bg-slate-800 rounded-full" />
                  <span className="absolute top-0 text-cyan-300 text-[10px] -translate-x-1/2" style={{ left: `${dayRangePosition}%` }}>▼</span>
                </div>
                <div className="flex justify-between text-[9px] font-mono text-slate-400 tabular-nums">
                  <span>{fmt(quoteDayRange.low)}</span><span>{fmt(quoteDayRange.high)}</span>
                </div>
                <span className="text-[8px] text-slate-500 truncate" data-testid="main-chart-day-range-source">
                  {fmt(realQuote.price)} · {displayHistoryValue(realQuote.source)} · {displayHistoryValue(realQuote.timestamp)}
                </span>
              </>
            ) : (
              <span className="text-[10px] text-slate-500" data-testid="main-chart-day-range-unavailable">Unavailable · no real same-symbol quote</span>
            )}
          </article>
          <article className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between min-w-0" data-testid="main-chart-52-week-range">
            <span className="text-[10px] font-mono text-slate-400">52-Week Range</span>
            <span className="text-xs font-mono text-slate-500" data-testid="main-chart-52-week-unavailable">Unavailable</span>
            <span className="text-[8px] text-slate-500">Verified 52-week coverage metadata is unavailable.</span>
          </article>
          <article className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between min-w-0" data-testid="main-chart-rsi-card">
            <span className="text-[10px] font-mono text-slate-400">RSI(14)</span>
            <span className="text-xs font-mono font-bold text-slate-100 tabular-nums" data-testid="main-chart-rsi-value">
              {dashboardRsi === null ? "Unavailable" : fmt(dashboardRsi, 1)}
            </span>
            <span className="text-[8px] text-slate-500">Shared calculation · {bars?.length ?? 0} history bars</span>
          </article>
          <article className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between min-w-0" data-testid="main-chart-quant-signal">
            <span className="text-[10px] font-mono text-slate-400">Quant Multi-Factor Signal</span>
            <span className="text-xs font-mono text-slate-500" data-testid="main-chart-quant-unavailable">Unavailable</span>
            <span className="text-[8px] text-slate-500">No verified Quant Research qualification is connected.</span>
          </article>
        </div>
      </section>
    </div>
  );
}
