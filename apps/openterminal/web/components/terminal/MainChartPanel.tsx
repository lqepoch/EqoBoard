"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  displayHistoryValue,
  historyDowngradeReason,
  historyResolution,
  useChartHistory,
  type ChartAssetClass,
  type ChartHistoryCandle,
  type ChartRange,
} from "../../lib/chart-history";
import { bollinger, ema, macd, rsi, sma, vwap } from "../../lib/indicators";
import { useTradingStore, type ChartType, type IndicatorKey } from "../../store/trading-terminal";

const CHART_TYPES: ChartType[] = ["candles", "bars", "line", "area"];
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

function safeDetails(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text.slice(0, 4_000) : "unknown";
  } catch {
    return "unknown";
  }
}

export default function MainChartPanel() {
  const activeSymbol = useTradingStore((state) => state.activeSymbol);
  const chartType = useTradingStore((state) => state.chartType);
  const setChartType = useTradingStore((state) => state.setChartType);
  const indicators = useTradingStore((state) => state.indicators);
  const toggleIndicator = useTradingStore((state) => state.toggleIndicator);
  const providerMode = useTradingStore((state) => state.providerMode);
  const setProviderMode = useTradingStore((state) => state.setProviderMode);
  const setHoveredBar = useTradingStore((state) => state.setHoveredBar);
  const [range, setRange] = useState<ChartRange>("1D");
  const [assetClass, setAssetClass] = useState<ChartAssetClass>(activeSymbol === "QQQ" ? "etf" : "stock");
  const [hoveredBar, setLocalHoveredBar] = useState<ChartHistoryCandle | null>(null);
  const [activeDrawingTool, setActiveDrawingTool] = useState("crosshair");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const viewportRef = useRef<{
    identity: string;
    firstTime: number;
    logicalFrom: number;
    logicalTo: number;
    visibleCount: number;
    rightOffset: number;
    atRightEdge: boolean;
  } | null>(null);
  const pointerGestureRef = useRef(false);
  const pagingLockRef = useRef(false);

  useEffect(() => {
    setAssetClass(activeSymbol === "QQQ" ? "etf" : "stock");
    setLocalHoveredBar(null);
    setHoveredBar(null);
  }, [activeSymbol, setHoveredBar]);

  const history = useChartHistory(activeSymbol, range, providerMode, assetClass);
  const bars = history.bars;
  const historyResponse = history.latestPage;
  const historyIdentity = `${activeSymbol}|${range}|${history.requestedResolution}`;
  const requestOlder = useCallback(() => {
    if (!history.hasNextPage || history.isFetchingNextPage || pagingLockRef.current) return;
    pagingLockRef.current = true;
    void history.fetchNextPage().finally(() => { pagingLockRef.current = false; });
  }, [history.fetchNextPage, history.hasNextPage, history.isFetchingNextPage]);
  const requestOlderRef = useRef(requestOlder);
  requestOlderRef.current = requestOlder;
  const canFetchOlderRef = useRef(false);
  canFetchOlderRef.current = Boolean(history.hasNextPage);

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

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !bars || bars.length === 0) return;
    const previousViewport = viewportRef.current;
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
        timeVisible: historyResolution(historyResponse, "effective_resolution") !== "1d",
        secondsVisible: false,
      },
      rightPriceScale: { borderColor: "#1a2233", scaleMargins: { top: 0.08, bottom: 0.22 } },
      autoSize: true,
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    const upColor = "#10b981";
    const downColor = "#ef4444";
    const ohlc = bars.map((bar) => ({ time: ts(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
    let main: ReturnType<typeof chart.addSeries>;
    if (chartType === "candles") {
      main = chart.addSeries(CandlestickSeries, {
        upColor, downColor, borderUpColor: upColor, borderDownColor: downColor, wickUpColor: upColor, wickDownColor: downColor,
      });
      main.setData(ohlc);
    } else if (chartType === "bars") {
      main = chart.addSeries(BarSeries, { upColor, downColor });
      main.setData(ohlc);
    } else if (chartType === "line") {
      main = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2 });
      main.setData(bars.map((bar) => ({ time: ts(bar.time), value: bar.close })));
    } else {
      main = chart.addSeries(AreaSeries, { lineColor: "#38bdf8", topColor: "rgba(56,189,248,0.3)", bottomColor: "rgba(56,189,248,0)", lineWidth: 2 });
      main.setData(bars.map((bar) => ({ time: ts(bar.time), value: bar.close })));
    }

    if (indicators.VOL) {
      const volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" } });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(bars.map((bar) => ({
        time: ts(bar.time),
        value: bar.volume,
        color: bar.close >= bar.open ? "rgba(16,185,129,0.45)" : "rgba(239,68,68,0.45)",
      })));
    }

    const overlay = (points: Array<{ time: number; value: number }>, color: string, style?: LineStyle) => {
      chart.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false })
        .setData(points.map((point) => ({ time: ts(point.time), value: point.value })));
    };
    if (calculated?.SMA20) overlay(calculated.SMA20, INDICATOR_COLORS.SMA20);
    if (calculated?.SMA50) overlay(calculated.SMA50, INDICATOR_COLORS.SMA50);
    if (calculated?.SMA200) overlay(calculated.SMA200, INDICATOR_COLORS.SMA200);
    if (calculated?.EMA20) overlay(calculated.EMA20, INDICATOR_COLORS.EMA20);
    if (calculated?.VWAP) overlay(calculated.VWAP, INDICATOR_COLORS.VWAP);
    if (calculated?.BOLL) {
      overlay(calculated.BOLL.upper, "rgba(167,139,250,0.75)", LineStyle.Dashed);
      overlay(calculated.BOLL.middle, "rgba(196,181,253,0.85)");
      overlay(calculated.BOLL.lower, "rgba(167,139,250,0.75)", LineStyle.Dashed);
    }

    let pane = 1;
    if (calculated?.RSI) {
      chart.addSeries(LineSeries, { color: INDICATOR_COLORS.RSI, lineWidth: 1, priceLineVisible: false }, pane++)
        .setData(calculated.RSI.map((point) => ({ time: ts(point.time), value: point.value })));
    }
    if (calculated?.MACD) {
      const currentPane = pane++;
      chart.addSeries(HistogramSeries, { color: "#7dd3fc", priceLineVisible: false }, currentPane).setData(
        calculated.MACD.histogram.map((point) => ({ time: ts(point.time), value: point.value, color: point.value >= 0 ? "rgba(16,185,129,0.65)" : "rgba(239,68,68,0.65)" })),
      );
      chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 1, priceLineVisible: false }, currentPane)
        .setData(calculated.MACD.macd.map((point) => ({ time: ts(point.time), value: point.value })));
      chart.addSeries(LineSeries, { color: "#e2e8f0", lineWidth: 1, priceLineVisible: false }, currentPane)
        .setData(calculated.MACD.signal.map((point) => ({ time: ts(point.time), value: point.value })));
    }

    const barByTime = new Map(bars.map((bar) => [bar.time, bar]));
    const crosshairListener = (param: { time?: unknown }) => {
      const selected = typeof param.time === "number" ? barByTime.get(param.time) : undefined;
      const next = selected ?? bars[bars.length - 1];
      setLocalHoveredBar(next);
      setHoveredBar(next ? { ...next, change: next.close - next.open, changePercent: next.open === 0 ? 0 : ((next.close - next.open) / next.open) * 100 } : null);
    };
    chart.subscribeCrosshairMove(crosshairListener);

    const visibleRangeListener = () => {
      const visible = chart.timeScale().getVisibleLogicalRange();
      if (visible) {
        element.dataset.visibleLogicalRange = `${visible.from.toFixed(3)}:${visible.to.toFixed(3)}`;
      }
      if (pointerGestureRef.current && visible && visible.from <= 12 && canFetchOlderRef.current) requestOlderRef.current();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(visibleRangeListener);

    if (previousViewport?.identity === historyIdentity) {
      const firstIndex = bars.findIndex((bar) => bar.time === previousViewport.firstTime);
      const prependShift = firstIndex >= 0 ? firstIndex : 0;
      try {
        if (previousViewport.atRightEdge) {
          const to = bars.length - 1 + previousViewport.rightOffset;
          chart.timeScale().setVisibleLogicalRange({ from: to - previousViewport.visibleCount, to });
        } else {
          chart.timeScale().setVisibleLogicalRange({ from: previousViewport.logicalFrom + prependShift, to: previousViewport.logicalTo + prependShift });
        }
      } catch {
        chart.timeScale().fitContent();
      }
    } else {
      chart.timeScale().fitContent();
    }
    const initialVisibleRange = chart.timeScale().getVisibleLogicalRange();
    if (initialVisibleRange) {
      element.dataset.visibleLogicalRange = `${initialVisibleRange.from.toFixed(3)}:${initialVisibleRange.to.toFixed(3)}`;
    }

    return () => {
      const visible = chart.timeScale().getVisibleLogicalRange();
      if (visible) {
        viewportRef.current = {
          identity: historyIdentity,
          firstTime: bars[0].time,
          logicalFrom: visible.from,
          logicalTo: visible.to,
          visibleCount: visible.to - visible.from,
          rightOffset: visible.to - (bars.length - 1),
          atRightEdge: visible.to >= bars.length - 2,
        };
      }
      chart.unsubscribeCrosshairMove(crosshairListener);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(visibleRangeListener);
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, calculated, chartType, historyIdentity, historyResponse, indicators.VOL, range, setHoveredBar]);

  const requestPointerEnd = () => {
    window.setTimeout(() => { pointerGestureRef.current = false; }, 120);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#07090e] overflow-hidden select-none" data-testid="main-chart-panel">
      <div className="min-h-9 bg-[#0b0e16] border-b border-[#182133] flex items-center gap-1 px-2.5 py-1 shrink-0 overflow-x-auto no-scrollbar">
        {CHART_RANGES.map((item) => (
          <button
            key={item}
            data-testid={`main-chart-range-${item}`}
            aria-pressed={range === item}
            onClick={() => setRange(item)}
            className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${range === item ? "bg-cyan-950/80 text-cyan-300 border border-cyan-600/80" : "text-slate-400 hover:text-slate-200"}`}
          >
            {item}
          </button>
        ))}
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
        <span className="font-bold text-slate-200">{activeSymbol} · {range} · {bars?.length ?? 0} bars</span>
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
      {history.error && <div role="alert" className="px-3 py-1 text-[10px] text-rose-400" data-testid="main-chart-history-error">History unavailable: {(history.error as Error).message}</div>}
      {history.projectionError && <div role="alert" className="px-3 py-1 text-[10px] text-rose-400">{history.projectionError}</div>}
      {history.isLoading && <div className="px-3 py-1 text-[10px] text-slate-500">Loading history…</div>}

      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        <div className="w-8 bg-[#0a0d14] border-r border-[#141b28] flex flex-col items-center py-2 gap-2 text-slate-500 text-xs shrink-0 select-none">
          {[
            { id: "crosshair", icon: "✛", title: "Crosshair" },
            { id: "line", icon: "╱", title: "Trend Line" },
            { id: "fib", icon: "≡", title: "Fibonacci" },
            { id: "brush", icon: "✎", title: "Brush" },
            { id: "text", icon: "T", title: "Text Annotation" },
            { id: "ruler", icon: "📏", title: "Ruler" },
          ].map((tool) => (
            <button
              key={tool.id}
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
          onPointerDownCapture={() => { pointerGestureRef.current = true; }}
          onPointerUpCapture={requestPointerEnd}
          onPointerCancelCapture={() => { pointerGestureRef.current = false; }}
          onTouchStartCapture={() => { pointerGestureRef.current = true; }}
          onTouchEndCapture={requestPointerEnd}
        >
          <div ref={containerRef} className="w-full h-full" data-testid="main-chart-canvas" />
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
    </div>
  );
}
