"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";
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
import {
  useTradingStore,
  type ChartType,
  type KlineInterval,
  type IndicatorKey,
  type BarData,
} from "../../store/trading-terminal";

// 指标计算辅助函数
function calculateSMA(bars: BarData[], period: number) {
  const result: Array<{ time: UTCTimestamp; value: number }> = [];
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += bars[i - j].close;
    }
    result.push({
      time: bars[i].time as UTCTimestamp,
      value: Number((sum / period).toFixed(2)),
    });
  }
  return result;
}

function calculateEMA(bars: BarData[], period: number) {
  if (bars.length < period) return [];
  const result: Array<{ time: UTCTimestamp; value: number }> = [];
  const k = 2 / (period + 1);
  let ema = bars.slice(0, period).reduce((acc, b) => acc + b.close, 0) / period;
  result.push({ time: bars[period - 1].time as UTCTimestamp, value: Number(ema.toFixed(2)) });

  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    result.push({ time: bars[i].time as UTCTimestamp, value: Number(ema.toFixed(2)) });
  }
  return result;
}

function calculateBollinger(bars: BarData[], period: number = 20, multiplier: number = 2) {
  const upper: Array<{ time: UTCTimestamp; value: number }> = [];
  const middle: Array<{ time: UTCTimestamp; value: number }> = [];
  const lower: Array<{ time: UTCTimestamp; value: number }> = [];

  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += bars[i - j].close;
    }
    const mean = sum / period;

    let variance = 0;
    for (let j = 0; j < period; j++) {
      variance += Math.pow(bars[i - j].close - mean, 2);
    }
    const stdDev = Math.sqrt(variance / period);

    const t = bars[i].time as UTCTimestamp;
    middle.push({ time: t, value: Number(mean.toFixed(2)) });
    upper.push({ time: t, value: Number((mean + multiplier * stdDev).toFixed(2)) });
    lower.push({ time: t, value: Number((mean - multiplier * stdDev).toFixed(2)) });
  }

  return { upper, middle, lower };
}

export default function MainChartPanel() {
  const {
    activeSymbol,
    chartType,
    setChartType,
    klineInterval,
    setKlineInterval,
    indicators,
    toggleIndicator,
    klineBars,
    currentQuote,
    hoveredBar,
    setHoveredBar,
  } = useTradingStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    main: any;
    vol: any;
    sma20: any;
    sma50: any;
    ema20: any;
    bollUp: any;
    bollMid: any;
    bollLow: any;
  }>({
    main: null,
    vol: null,
    sma20: null,
    sma50: null,
    ema20: null,
    bollUp: null,
    bollMid: null,
    bollLow: null,
  });

  const lastViewKeyRef = useRef<string>("");
  const [activeDrawingTool, setActiveDrawingTool] = useState<string>("crosshair");

  // 指标计算与缓存
  const computedIndicators = useMemo(() => {
    if (!klineBars || klineBars.length === 0) return null;
    return {
      sma20: indicators.SMA20 ? calculateSMA(klineBars, 20) : null,
      sma50: indicators.SMA50 ? calculateSMA(klineBars, 50) : null,
      ema20: indicators.EMA20 ? calculateEMA(klineBars, 20) : null,
      boll: indicators.BOLL ? calculateBollinger(klineBars, 20, 2) : null,
    };
  }, [klineBars, indicators]);

  // 1. 初始化 TradingView Lightweight Charts 画布 (全局单例)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(el, {
      layout: {
        background: { color: "#080b11" },
        textColor: "#94a3b8",
        fontSize: 10,
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
      },
      grid: {
        vertLines: { color: "#111622" },
        horzLines: { color: "#111622" },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: "#38bdf8", width: 1, style: LineStyle.Dotted },
        horzLine: { color: "#38bdf8", width: 1, style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: "#1a2233",
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: "#1a2233",
        scaleMargins: {
          top: 0.08,
          bottom: 0.22,
        },
      },
      autoSize: true,
    });

    chartRef.current = chart;
    lastViewKeyRef.current = "";

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {
        main: null,
        vol: null,
        sma20: null,
        sma50: null,
        ema20: null,
        bollUp: null,
        bollMid: null,
        bollLow: null,
      };
    };
  }, []);

  // 2. 系列维护与平滑数据同步
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !klineBars || klineBars.length === 0) return;

    const isIntraday = !["1D", "THIS_WEEK", "1W", "1Y"].includes(klineInterval);
    const isSecond = ["1s", "5s", "10s"].includes(klineInterval);

    const viewKey = `${activeSymbol}-${klineInterval}-${chartType}-${JSON.stringify(indicators)}`;
    const needsFullRebuild = lastViewKeyRef.current !== viewKey;

    const upColor = "#10b981"; // 涨绿
    const downColor = "#ef4444"; // 跌红

    if (needsFullRebuild) {
      if (seriesRef.current.main) chart.removeSeries(seriesRef.current.main);
      if (seriesRef.current.vol) chart.removeSeries(seriesRef.current.vol);
      if (seriesRef.current.sma20) chart.removeSeries(seriesRef.current.sma20);
      if (seriesRef.current.sma50) chart.removeSeries(seriesRef.current.sma50);
      if (seriesRef.current.ema20) chart.removeSeries(seriesRef.current.ema20);
      if (seriesRef.current.bollUp) chart.removeSeries(seriesRef.current.bollUp);
      if (seriesRef.current.bollMid) chart.removeSeries(seriesRef.current.bollMid);
      if (seriesRef.current.bollLow) chart.removeSeries(seriesRef.current.bollLow);

      chart.timeScale().applyOptions({
        timeVisible: isIntraday,
        secondsVisible: isSecond,
      });

      let mainSeries: any = null;
      if (chartType === "candles") {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor,
          downColor,
          borderUpColor: upColor,
          borderDownColor: downColor,
          wickUpColor: upColor,
          wickDownColor: downColor,
        });
        mainSeries.setData(
          klineBars.map((b) => ({
            time: b.time as UTCTimestamp,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          }))
        );
      } else if (chartType === "bars") {
        mainSeries = chart.addSeries(BarSeries, { upColor, downColor });
        mainSeries.setData(
          klineBars.map((b) => ({
            time: b.time as UTCTimestamp,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          }))
        );
      } else if (chartType === "line") {
        mainSeries = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2 });
        mainSeries.setData(
          klineBars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close }))
        );
      } else if (chartType === "area") {
        mainSeries = chart.addSeries(AreaSeries, {
          lineColor: "#38bdf8",
          topColor: "rgba(56, 189, 248, 0.3)",
          bottomColor: "rgba(56, 189, 248, 0.0)",
          lineWidth: 2,
        });
        mainSeries.setData(
          klineBars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close }))
        );
      }
      seriesRef.current.main = mainSeries;

      // 量柱
      if (indicators.VOL) {
        const volSeries = chart.addSeries(HistogramSeries, {
          priceScaleId: "volume-scale",
          priceFormat: { type: "volume" },
        });
        volSeries.priceScale().applyOptions({
          scaleMargins: { top: 0.82, bottom: 0 },
        });
        volSeries.setData(
          klineBars.map((b) => ({
            time: b.time as UTCTimestamp,
            value: b.volume,
            color: b.close >= b.open ? "rgba(16, 185, 129, 0.45)" : "rgba(239, 68, 68, 0.45)",
          }))
        );
        seriesRef.current.vol = volSeries;
      }

      // SMA 20
      if (computedIndicators?.sma20 && indicators.SMA20) {
        const s = chart.addSeries(LineSeries, {
          color: "#fbbf24",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        s.setData(computedIndicators.sma20);
        seriesRef.current.sma20 = s;
      }

      // SMA 50
      if (computedIndicators?.sma50 && indicators.SMA50) {
        const s = chart.addSeries(LineSeries, {
          color: "#38bdf8",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        s.setData(computedIndicators.sma50);
        seriesRef.current.sma50 = s;
      }

      // EMA 20
      if (computedIndicators?.ema20 && indicators.EMA20) {
        const s = chart.addSeries(LineSeries, {
          color: "#f43f5e",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        s.setData(computedIndicators.ema20);
        seriesRef.current.ema20 = s;
      }

      // Bollinger Bands
      if (computedIndicators?.boll && indicators.BOLL) {
        const bollUp = chart.addSeries(LineSeries, {
          color: "rgba(168, 85, 247, 0.7)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        bollUp.setData(computedIndicators.boll.upper);

        const bollMid = chart.addSeries(LineSeries, {
          color: "rgba(192, 132, 252, 0.8)",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        bollMid.setData(computedIndicators.boll.middle);

        const bollLow = chart.addSeries(LineSeries, {
          color: "rgba(168, 85, 247, 0.7)",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        bollLow.setData(computedIndicators.boll.lower);

        seriesRef.current.bollUp = bollUp;
        seriesRef.current.bollMid = bollMid;
        seriesRef.current.bollLow = bollLow;
      }

      chart.timeScale().fitContent();
      lastViewKeyRef.current = viewKey;
    } else {
      const main = seriesRef.current.main;
      if (main && klineBars.length > 0) {
        if (chartType === "candles" || chartType === "bars") {
          main.setData(
            klineBars.map((b) => ({
              time: b.time as UTCTimestamp,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
            }))
          );
        } else {
          main.setData(
            klineBars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close }))
          );
        }
      }

      if (seriesRef.current.vol && indicators.VOL) {
        seriesRef.current.vol.setData(
          klineBars.map((b) => ({
            time: b.time as UTCTimestamp,
            value: b.volume,
            color: b.close >= b.open ? "rgba(16, 185, 129, 0.45)" : "rgba(239, 68, 68, 0.45)",
          }))
        );
      }
      if (seriesRef.current.sma20 && computedIndicators?.sma20) {
        seriesRef.current.sma20.setData(computedIndicators.sma20);
      }
      if (seriesRef.current.sma50 && computedIndicators?.sma50) {
        seriesRef.current.sma50.setData(computedIndicators.sma50);
      }
      if (seriesRef.current.ema20 && computedIndicators?.ema20) {
        seriesRef.current.ema20.setData(computedIndicators.ema20);
      }
      if (seriesRef.current.bollUp && computedIndicators?.boll) {
        seriesRef.current.bollUp.setData(computedIndicators.boll.upper);
        seriesRef.current.bollMid?.setData(computedIndicators.boll.middle);
        seriesRef.current.bollLow?.setData(computedIndicators.boll.lower);
      }
    }
  }, [klineBars, chartType, klineInterval, activeSymbol, indicators, computedIndicators]);

  // 十字光标 HUD 监听
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !klineBars || klineBars.length === 0) return;

    const barMap = new Map<number, BarData>();
    for (const b of klineBars) barMap.set(b.time, b);

    const onCrosshairMove = (param: any) => {
      if (!param || !param.time) {
        const last = klineBars[klineBars.length - 1];
        if (last) {
          const change = last.close - last.open;
          const changePercent = (change / last.open) * 100;
          setHoveredBar({ ...last, change, changePercent });
        }
        return;
      }
      const hit = barMap.get(param.time as number);
      if (hit) {
        const change = hit.close - hit.open;
        const changePercent = (change / hit.open) * 100;
        setHoveredBar({ ...hit, change, changePercent });
      }
    };

    chart.subscribeCrosshairMove(onCrosshairMove);

    const lastBar = klineBars[klineBars.length - 1];
    if (lastBar) {
      const change = lastBar.close - lastBar.open;
      const changePercent = (change / lastBar.open) * 100;
      setHoveredBar({ ...lastBar, change, changePercent });
    }

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
    };
  }, [klineBars, setHoveredBar]);

  const displayBar = hoveredBar || (klineBars && klineBars[klineBars.length - 1]);
  const isBarUp = displayBar ? displayBar.close >= displayBar.open : true;

  return (
    <div className="flex-1 flex flex-col h-full bg-[#07090e] overflow-hidden select-none">
      {/* 顶部 Docked 工具栏: 周期选择、指标开关、配额状态、图表类型 */}
      <div className="h-9 bg-[#0b0e16] border-b border-[#182133] flex items-center justify-between px-2.5 shrink-0 overflow-x-auto no-scrollbar">
        {/* 左侧: 时间周期选择 */}
        <div className="flex items-center gap-1 shrink-0">
          {(
            [
              { id: "1s", label: "[1s]" },
              { id: "5s", label: "[5s]" },
              { id: "10s", label: "[10s]" },
              { id: "1m", label: "[1m]" },
              { id: "5m", label: "[5m]" },
              { id: "10m", label: "[10m]" },
              { id: "30m", label: "[30m]" },
              { id: "1h", label: "[1h]" },
              { id: "2h", label: "[2h]" },
              { id: "4h", label: "[4h]" },
              { id: "1D", label: "[1D]" },
              { id: "1W", label: "[1W]" },
            ] as Array<{ id: KlineInterval; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              onClick={() => setKlineInterval(item.id)}
              className={`px-1.5 py-0.5 text-[10px] font-mono tracking-wider font-semibold rounded transition-colors ${
                klineInterval === item.id
                  ? "bg-cyan-950/80 text-cyan-300 font-bold border border-cyan-600/80 shadow-xs"
                  : "text-slate-400 hover:text-slate-200 hover:bg-[#141b27]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 中间: 指标切换开关 */}
        <div className="hidden lg:flex items-center gap-1 border-l border-[#1a2233] pl-2 shrink-0">
          {(
            [
              { key: "SMA20", label: "SMA20 (Yellow)", color: "text-amber-400" },
              { key: "SMA50", label: "SMA50 (Blue)", color: "text-cyan-400" },
              { key: "EMA20", label: "EMA20 (Rose)", color: "text-rose-400" },
              { key: "BOLL", label: "BOLL (Purple Dashed)", color: "text-purple-400" },
              { key: "VOL", label: "VOL (Emerald)", color: "text-emerald-400" },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              onClick={() => toggleIndicator(item.key)}
              className={`px-1.5 py-0.5 text-[9px] font-mono rounded font-medium transition-colors ${
                indicators[item.key]
                  ? "bg-[#141b28] border border-[#223048] " + item.color
                  : "text-slate-500 hover:text-slate-400"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 右侧: 配额 Badge 与图表类型 */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden xl:flex items-center gap-1 text-[9px] font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60">
            ⚡ 180D Multi-session 1m Aggregation Online
          </span>

          <div className="flex items-center gap-1 border-l border-[#1a2233] pl-2">
            {(["candles", "bars", "line", "area"] as ChartType[]).map((type) => (
              <button
                key={type}
                onClick={() => setChartType(type)}
                className={`px-1.5 py-0.5 text-[9px] font-mono uppercase rounded font-medium transition-colors ${
                  chartType === type
                    ? "bg-cyan-950 text-cyan-300 font-bold border border-cyan-700/80"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {type === "candles" ? "Candles" : type}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 十字光标 HUD 浮动条 */}
      <div className="h-6 bg-[#0a0d14] border-b border-[#141b28] px-3 flex items-center justify-between text-[10px] font-mono text-slate-400 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-bold text-slate-200">
            {activeSymbol} · <span className="text-cyan-400 font-bold">{klineInterval}</span> ·{" "}
            <span className="text-slate-400">{klineBars.length} BARS</span>
          </span>
          {displayBar && (
            <div className="flex items-center gap-2.5">
              <span>
                O: <span className="text-slate-200 font-medium tabular-nums">{displayBar.open.toFixed(2)}</span>
              </span>
              <span>
                H: <span className="text-emerald-400 font-medium tabular-nums">{displayBar.high.toFixed(2)}</span>
              </span>
              <span>
                L: <span className="text-rose-400 font-medium tabular-nums">{displayBar.low.toFixed(2)}</span>
              </span>
              <span>
                C:{" "}
                <span
                  className={`font-semibold tabular-nums ${
                    isBarUp ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {displayBar.close.toFixed(2)}
                </span>
              </span>
              <span>
                Vol:{" "}
                <span className="text-slate-300 font-medium tabular-nums">
                  {(displayBar.volume / 1_000).toFixed(1)}K
                </span>
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[9px]">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-slate-400">TICK REALTIME AGGREGATED</span>
        </div>
      </div>

      {/* 主画布容器: 左侧绘图工具栏 + 中间 Lightweight Charts Canvas */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* 左侧垂直绘图工具栏 (TradingView 风格) */}
        <div className="w-8 bg-[#0a0d14] border-r border-[#141b28] flex flex-col items-center py-2 gap-2 text-slate-500 text-xs shrink-0 select-none">
          {[
            { id: "crosshair", icon: "✛", title: "Crosshair" },
            { id: "line", icon: "╱", title: "Trend Line" },
            { id: "fib", icon: "≡", title: "Fibonacci" },
            { id: "brush", icon: "✎", title: "Brush" },
            { id: "text", icon: "T", title: "Text Annotation" },
            { id: "pattern", icon: "☺", title: "Patterns" },
            { id: "ruler", icon: "📏", title: "Ruler" },
            { id: "measure", icon: "🔍", title: "Measure" },
            { id: "lock", icon: "🔒", title: "Lock Elements" },
          ].map((tool) => (
            <button
              key={tool.id}
              onClick={() => setActiveDrawingTool(tool.id)}
              className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                activeDrawingTool === tool.id
                  ? "bg-cyan-950/80 text-cyan-300 font-bold border border-cyan-700/60 shadow-xs"
                  : "hover:bg-[#141b27] hover:text-slate-300"
              }`}
              title={tool.title}
            >
              {tool.icon}
            </button>
          ))}
        </div>

        {/* Lightweight Charts 核心画板 */}
        <div className="flex-1 relative w-full h-full min-h-0 overflow-hidden">
          <div ref={containerRef} className="w-full h-full" />
        </div>
      </div>

      {/* =========================================================================
          Bottom: Intelligence Dashboard (4-card Grid matching the 4K mockup)
         ========================================================================= */}
      <div className="h-32 bg-[#0b0e16] border-t border-[#182133] px-3 py-2 flex flex-col justify-between shrink-0">
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
          <span className="font-semibold text-slate-300">Intelligence Dashboard</span>
          <span className="text-slate-600 text-xs">⋯</span>
        </div>

        <div className="grid grid-cols-4 gap-2.5 h-24">
          {/* Card 1: Day Range */}
          <div className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-slate-400">Day Range</span>
            <div className="flex flex-col items-center justify-center my-auto">
              <div className="w-full relative py-2">
                <div className="h-1.5 bg-slate-800 rounded-full relative overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 rounded-full w-2/3" />
                </div>
                {/* Pointer triangle indicator */}
                <div className="absolute top-0 left-2/3 -translate-x-1/2 text-cyan-300 text-[10px]">
                  ▼
                </div>
              </div>
              <div className="w-full flex items-center justify-between text-[9px] font-mono text-slate-400">
                <span className="tabular-nums">${(currentQuote?.low || 744.85).toFixed(2)}</span>
                <span className="tabular-nums">${(currentQuote?.high || 749.79).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Card 2: 52-Week Range (Arc Gauge) */}
          <div className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-slate-400">52-Week Range</span>
            <div className="flex flex-col items-center justify-center relative my-auto">
              <svg width="84" height="42" className="overflow-visible">
                <path
                  d="M 6 40 A 36 36 0 0 1 78 40"
                  fill="none"
                  stroke="#1e293b"
                  strokeWidth="6"
                  strokeLinecap="round"
                />
                <path
                  d="M 6 40 A 36 36 0 0 1 78 40"
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray="113"
                  strokeDashoffset="14"
                />
              </svg>
              <span className="font-mono text-xs font-bold text-slate-100 tabular-nums -mt-2">
                89%
              </span>
            </div>
          </div>

          {/* Card 3: RSI(14) (Dial with Needle) */}
          <div className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-slate-400">RSI(14)</span>
            <div className="flex flex-col items-center justify-center relative my-auto">
              <svg width="84" height="42" className="overflow-visible">
                <path
                  d="M 6 40 A 36 36 0 0 1 78 40"
                  fill="none"
                  stroke="#334155"
                  strokeWidth="6"
                  strokeLinecap="round"
                />
                {/* Needle */}
                <line
                  x1="42"
                  y1="40"
                  x2="42"
                  y2="10"
                  stroke="#e2e8f0"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle cx="42" cy="40" r="3" fill="#e2e8f0" />
              </svg>
              <div className="flex flex-col items-center -mt-1">
                <span className="font-mono text-xs font-bold text-slate-100 tabular-nums">
                  {currentQuote?.rsi ? currentQuote.rsi.toFixed(1) : "46.2"}
                </span>
                <span className="text-[8px] font-mono text-slate-400">Neutral</span>
              </div>
            </div>
          </div>

          {/* Card 4: Quant Multi-Factor Signal (Color-zoned Speedometer) */}
          <div className="bg-[#0f1422] border border-[#1a2438] rounded p-2 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-slate-400">Quant Multi-Factor Signal</span>
            <div className="flex flex-col items-center justify-center relative my-auto">
              <svg width="90" height="45" className="overflow-visible">
                {/* Left: Green Zone */}
                <path
                  d="M 8 42 A 38 38 0 0 1 30 10"
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="6"
                />
                {/* Center: Gray Zone */}
                <path
                  d="M 32 8 A 38 38 0 0 1 58 8"
                  fill="none"
                  stroke="#64748b"
                  strokeWidth="6"
                />
                {/* Right: Red Zone */}
                <path
                  d="M 60 10 A 38 38 0 0 1 82 42"
                  fill="none"
                  stroke="#f43f5e"
                  strokeWidth="6"
                />
                {/* Needle pointing to SELL */}
                <line
                  x1="45"
                  y1="42"
                  x2="68"
                  y2="18"
                  stroke="#f8fafc"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle cx="45" cy="42" r="3" fill="#f8fafc" />
              </svg>
              <span className="font-mono text-[10px] font-bold text-amber-400 tracking-wider -mt-1">
                NEUTRAL / SELL
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
