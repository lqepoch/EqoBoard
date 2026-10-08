"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  AreaSeries,
  BarSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { apiGet, fmt, fmtBig, type Candle } from "../../lib/api";
import type { EqoHistory } from "../../lib/eqo-market";
import type { MdpBarsResponseV1, TradeMinuteBarV1 } from "../../lib/mdp-market-data-contract";
import { sma, ema, vwap, rsi, macd, bollinger, type Point } from "../../lib/indicators";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

const RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
const CHART_TYPES = ["candles", "bars", "line", "area"] as const;
const INDICATORS = ["SMA20", "SMA50", "SMA200", "EMA20", "VWAP", "BOLL", "RSI", "MACD"] as const;

type Range = (typeof RANGES)[number];
type ChartType = (typeof CHART_TYPES)[number];
type Indicator = (typeof INDICATORS)[number];
type DataMode = "provider" | "mdp-diagnostic";
type ChartCandle = Candle & {
  exact?: { open: string; high: string; low: string; close: string; volume: string };
};

const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_CHART_PRICE = 1_000_000_000_000;
const MAX_CHART_VOLUME = 1_000_000_000_000_000;

function finiteChartValue(value: string, maximum: number): number | null {
  if (value.length > 128 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= maximum ? parsed : null;
}

function projectMdpBar(row: TradeMinuteBarV1): ChartCandle | null {
  const open = finiteChartValue(row.open, MAX_CHART_PRICE);
  const high = finiteChartValue(row.high, MAX_CHART_PRICE);
  const low = finiteChartValue(row.low, MAX_CHART_PRICE);
  const close = finiteChartValue(row.close, MAX_CHART_PRICE);
  const volume = finiteChartValue(row.volume, MAX_CHART_VOLUME);
  const time = Date.parse(row.bar_start_utc) / 1_000;
  if ([open, high, low, close, volume].some((value) => value === null) ||
      !Number.isSafeInteger(time) ||
      time <= 0) return null;
  return {
    time,
    open: open!,
    high: high!,
    low: low!,
    close: close!,
    volume: volume!,
    exact: { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume },
  };
}

const ts = (t: number) => t as UTCTimestamp;
const toMap = (pts: Point[]) => new Map(pts.map((p) => [p.time, p.value]));

const INDICATOR_COLOR: Record<string, string> = {
  SMA20: "#ffd966", SMA50: "#4fc3f7", SMA200: "#ba68c8", EMA20: "#ff8a65",
  VWAP: "#80cbc4", RSI: "#ff9900", BOLL: "#ff9900", MACD: "#4fc3f7",
};

export default function ChartWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const [dataMode, setDataMode] = useState<DataMode>("provider");
  const [datasetDraft, setDatasetDraft] = useState("");
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [datasetInputError, setDatasetInputError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("6M");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [active, setActive] = useState<Set<Indicator>>(new Set(["SMA20"]));
  const [legend, setLegend] = useState<ChartCandle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const { data: history, error: historyError } = useQuery({
    queryKey: ["history", symbol, range],
    queryFn: () => apiGet<EqoHistory>(`/api/history/${encodeURIComponent(symbol)}?range=${range}`),
    refetchInterval: range === "1D" ? 8_000 : 60_000,
    enabled: dataMode === "provider",
  });
  const { data: archive, error: archiveError } = useQuery({
    queryKey: ["mdp-diagnostic-bars", datasetId, symbol],
    queryFn: () => apiGet<MdpBarsResponseV1>(
      `/api/eqo/market-data/datasets/${encodeURIComponent(datasetId!)}/bars?namespace=diagnostic&symbol=${encodeURIComponent(symbol)}`
    ),
    enabled: dataMode === "mdp-diagnostic" && datasetId !== null,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const archiveCandles = useMemo<ChartCandle[] | null | undefined>(() => {
    if (!archive) return undefined;
    const rows = archive.rows.map(projectMdpBar);
    if (rows.some((row) => row === null)) return null;
    return rows as ChartCandle[];
  }, [archive]);
  const candles: ChartCandle[] | undefined = dataMode === "provider"
    ? history?.bars
    : archiveCandles ?? undefined;
  const error = dataMode === "provider" ? historyError : archiveError;

  // Fast time -> candle lookup for the crosshair legend, independent of chart type.
  const byTime = useMemo(() => {
    const m = new Map<number, ChartCandle>();
    for (const c of candles ?? []) m.set(c.time, c);
    return m;
  }, [candles]);

  // Computed once per candles/active change, shared by both the chart overlays
  // below and the hover legend — avoids recomputing the same series twice.
  const indicatorData = useMemo(() => {
    if (!candles || candles.length === 0) return null;
    return {
      SMA20: active.has("SMA20") ? sma(candles, 20) : null,
      SMA50: active.has("SMA50") ? sma(candles, 50) : null,
      SMA200: active.has("SMA200") ? sma(candles, 200) : null,
      EMA20: active.has("EMA20") ? ema(candles, 20) : null,
      VWAP: active.has("VWAP") ? vwap(candles) : null,
      RSI: active.has("RSI") ? rsi(candles) : null,
      BOLL: active.has("BOLL") ? bollinger(candles) : null,
      MACD: active.has("MACD") ? macd(candles) : null,
    };
  }, [candles, active]);

  const indicatorMaps = useMemo(() => {
    const maps: Record<string, Map<number, number>> = {};
    if (!indicatorData) return maps;
    if (indicatorData.SMA20) maps.SMA20 = toMap(indicatorData.SMA20);
    if (indicatorData.SMA50) maps.SMA50 = toMap(indicatorData.SMA50);
    if (indicatorData.SMA200) maps.SMA200 = toMap(indicatorData.SMA200);
    if (indicatorData.EMA20) maps.EMA20 = toMap(indicatorData.EMA20);
    if (indicatorData.VWAP) maps.VWAP = toMap(indicatorData.VWAP);
    if (indicatorData.RSI) maps.RSI = toMap(indicatorData.RSI);
    if (indicatorData.BOLL) {
      maps.BOLL_U = toMap(indicatorData.BOLL.upper);
      maps.BOLL_M = toMap(indicatorData.BOLL.middle);
      maps.BOLL_L = toMap(indicatorData.BOLL.lower);
    }
    if (indicatorData.MACD) {
      maps.MACD_M = toMap(indicatorData.MACD.macd);
      maps.MACD_S = toMap(indicatorData.MACD.signal);
      maps.MACD_H = toMap(indicatorData.MACD.histogram);
    }
    return maps;
  }, [indicatorData]);

  const indicatorRows = useMemo(() => {
    if (!legend) return [];
    const t = legend.time;
    const get = (key: string) => indicatorMaps[key]?.get(t);
    const rows: Array<{ label: string; value: string; color: string }> = [];
    for (const key of ["SMA20", "SMA50", "SMA200", "EMA20", "VWAP"] as const) {
      const v = get(key);
      if (v !== undefined) rows.push({ label: key, value: fmt(v), color: INDICATOR_COLOR[key] });
    }
    const rsiV = get("RSI");
    if (rsiV !== undefined) rows.push({ label: "RSI", value: fmt(rsiV, 1), color: INDICATOR_COLOR.RSI });
    const bollM = get("BOLL_M");
    if (bollM !== undefined) {
      rows.push({
        label: "BOLL",
        value: `${fmt(get("BOLL_U"))} / ${fmt(bollM)} / ${fmt(get("BOLL_L"))}`,
        color: INDICATOR_COLOR.BOLL,
      });
    }
    const macdM = get("MACD_M");
    if (macdM !== undefined) {
      rows.push({
        label: "MACD",
        value: `${fmt(macdM, 2)} / ${fmt(get("MACD_S"), 2)} / ${fmt(get("MACD_H"), 2)}`,
        color: INDICATOR_COLOR.MACD,
      });
    }
    return rows;
  }, [legend, indicatorMaps]);

  useEffect(() => {
    setLegend(candles && candles.length > 0 ? candles[candles.length - 1] : null);
  }, [candles]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !candles || candles.length === 0) return;

    const chart = createChart(el, {
      layout: { background: { color: "#0a0a0a" }, textColor: "#808080", fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: "#1a1a1a" }, horzLines: { color: "#1a1a1a" } },
      crosshair: { mode: 0 },
      timeScale: { borderColor: "#262626", timeVisible: range === "1D" || range === "5D" },
      rightPriceScale: { borderColor: "#262626" },
      autoSize: true,
      // Mouse-wheel is left free for page scrolling — zoom via drag, pinch, or the range buttons instead.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    const upColor = "#00c853";
    const downColor = "#ff3d3d";

    if (chartType === "candles") {
      chart
        .addSeries(CandlestickSeries, {
          upColor, downColor, borderUpColor: upColor, borderDownColor: downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        .setData(candles.map((c) => ({ time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "bars") {
      chart
        .addSeries(BarSeries, { upColor, downColor })
        .setData(candles.map((c) => ({ time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "line") {
      chart
        .addSeries(LineSeries, { color: "#ff9900", lineWidth: 1 })
        .setData(candles.map((c) => ({ time: ts(c.time), value: c.close })));
    } else {
      chart
        .addSeries(AreaSeries, { lineColor: "#ff9900", topColor: "rgba(255,153,0,0.25)", bottomColor: "rgba(255,153,0,0)" })
        .setData(candles.map((c) => ({ time: ts(c.time), value: c.close })));
    }

    // volume histogram on its own scale at the bottom of the main pane
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" } });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    vol.setData(
      candles.map((c) => ({ time: ts(c.time), value: c.volume, color: c.close >= c.open ? "rgba(0,200,83,0.4)" : "rgba(255,61,61,0.4)" }))
    );

    const overlay = (points: Point[], color: string) =>
      chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        .setData(points.map((p) => ({ time: ts(p.time), value: p.value })));

    if (indicatorData?.SMA20) overlay(indicatorData.SMA20, INDICATOR_COLOR.SMA20);
    if (indicatorData?.SMA50) overlay(indicatorData.SMA50, INDICATOR_COLOR.SMA50);
    if (indicatorData?.SMA200) overlay(indicatorData.SMA200, INDICATOR_COLOR.SMA200);
    if (indicatorData?.EMA20) overlay(indicatorData.EMA20, INDICATOR_COLOR.EMA20);
    if (indicatorData?.VWAP) overlay(indicatorData.VWAP, INDICATOR_COLOR.VWAP);
    if (indicatorData?.BOLL) {
      overlay(indicatorData.BOLL.upper, "rgba(255,153,0,0.5)");
      overlay(indicatorData.BOLL.middle, "rgba(255,153,0,0.8)");
      overlay(indicatorData.BOLL.lower, "rgba(255,153,0,0.5)");
    }

    let paneIdx = 1;
    if (indicatorData?.RSI) {
      const s = chart.addSeries(LineSeries, { color: INDICATOR_COLOR.RSI, lineWidth: 1 }, paneIdx++);
      s.setData(indicatorData.RSI.map((p) => ({ time: ts(p.time), value: p.value })));
    }
    if (indicatorData?.MACD) {
      const m = indicatorData.MACD;
      const pane = paneIdx++;
      chart.addSeries(HistogramSeries, { color: "#4fc3f7" }, pane).setData(
        m.histogram.map((p) => ({ time: ts(p.time), value: p.value, color: p.value >= 0 ? "rgba(0,200,83,0.6)" : "rgba(255,61,61,0.6)" }))
      );
      chart.addSeries(LineSeries, { color: "#ff9900", lineWidth: 1 }, pane).setData(
        m.macd.map((p) => ({ time: ts(p.time), value: p.value }))
      );
      chart.addSeries(LineSeries, { color: "#ffffff", lineWidth: 1 }, pane).setData(
        m.signal.map((p) => ({ time: ts(p.time), value: p.value }))
      );
    }

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setLegend(candles[candles.length - 1]);
        return;
      }
      const hit = byTime.get(param.time as number);
      if (hit) setLegend(hit);
    });

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, chartType, indicatorData, range, byTime]);

  const toggleIndicator = (ind: Indicator) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(ind)) next.delete(ind);
      else next.add(ind);
      return next;
    });

  function loadDataset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = datasetDraft.trim();
    setLegend(null);
    if (!DATASET_ID.test(id)) {
      setDatasetId(null);
      setDatasetInputError("Enter a valid diagnostic dataset ID.");
      return;
    }
    setDatasetInputError(null);
    setDatasetId(id);
  }

  function switchDataMode(mode: DataMode) {
    setLegend(null);
    setDataMode(mode);
  }

  return (
    <div className="flex flex-col h-full" data-testid="chart-widget">
      <div className="flex gap-1 p-1 flex-wrap shrink-0">
        <button className={`term-btn ${dataMode === "provider" ? "active" : ""}`} onClick={() => switchDataMode("provider")}>
          PROVIDER HISTORY
        </button>
        <button className={`term-btn ${dataMode === "mdp-diagnostic" ? "active" : ""}`} onClick={() => switchDataMode("mdp-diagnostic")}>
          MDP DIAGNOSTIC
        </button>
        {dataMode === "provider" && RANGES.map((r) => (
          <button key={r} className={`term-btn ${range === r ? "active" : ""}`} onClick={() => setRange(r)}>
            {r}
          </button>
        ))}
        <span className="w-2" />
        {CHART_TYPES.map((t) => (
          <button key={t} className={`term-btn ${chartType === t ? "active" : ""}`} onClick={() => setChartType(t)}>
            {t.toUpperCase()}
          </button>
        ))}
        <span className="w-2" />
        {INDICATORS.map((ind) => (
          <button key={ind} className={`term-btn ${active.has(ind) ? "active" : ""}`} onClick={() => toggleIndicator(ind)}>
            {ind}
          </button>
        ))}
      </div>
      {dataMode === "mdp-diagnostic" && (
        <form className="flex gap-1 px-2 py-1 border-b border-[#1c1c1c]" onSubmit={loadDataset}>
          <label className="sr-only" htmlFor={`mdp-dataset-${widget.id}`}>Diagnostic dataset ID</label>
          <input
            id={`mdp-dataset-${widget.id}`}
            value={datasetDraft}
            onChange={(event) => setDatasetDraft(event.target.value)}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            placeholder="Diagnostic dataset ID"
            className="min-w-0 flex-1 bg-[#111] border border-[var(--border)] px-2 py-1 text-[var(--text)] text-[10px]"
            data-testid="mdp-dataset-id"
          />
          <button type="submit" className="term-btn" onMouseDown={(event) => event.stopPropagation()}>LOAD ARCHIVE</button>
        </form>
      )}
      {dataMode === "mdp-diagnostic" && datasetInputError &&
        <div role="alert" className="px-2 py-1 text-[10px] down">{datasetInputError}</div>}
      <div className="px-2 py-1 border-b border-[#1c1c1c] text-[9px] dim">
        {dataMode === "provider"
          ? <>Source {history?.source ?? "unknown"} · as of {history?.asOf ?? "unknown"} · bar volume source follows the listed feed</>
          : archive?.summary
          ? <>Diagnostic archive · {archive.summary.source.provider}/{archive.summary.source.feed}/{archive.summary.source.entitlement} · {archive.rows[0]?.completion_mode ?? "empty"} · {archive.summary.dataset_id} · NOT LIVE · promotion unavailable</>
            : <>Diagnostic archive · source unknown · no dataset loaded · NOT LIVE</>}
      </div>
      {error && <div className="p-2 down">Error: {(error as Error).message}</div>}
      {dataMode === "mdp-diagnostic" && datasetId === null && !error &&
        <div className="px-2 py-1 text-[10px] dim">Enter a diagnostic dataset ID to load archived bars.</div>}
      {dataMode === "mdp-diagnostic" && archiveCandles === null &&
        <div role="alert" className="px-2 py-1 text-[10px] down">Archive values exceed the bounded chart projection; no bars were plotted.</div>}
      {dataMode === "mdp-diagnostic" && archive && archive.rows.length === 0 &&
        <div className="px-2 py-1 text-[10px] dim">The validated diagnostic dataset contains no bars for this symbol.</div>}
      <div className="relative flex-1 min-h-0">
        {legend && (
          <div className="absolute top-1 left-2 z-10 flex flex-col gap-0.5 text-[11px] pointer-events-none bg-[rgba(10,10,10,0.7)] px-2 py-1 rounded max-w-[95%]">
            <div className="flex gap-3">
              <span className="dim">O <span className="text-[var(--text)]">{legend.exact?.open ?? fmt(legend.open)}</span></span>
              <span className="dim">H <span className="up">{legend.exact?.high ?? fmt(legend.high)}</span></span>
              <span className="dim">L <span className="down">{legend.exact?.low ?? fmt(legend.low)}</span></span>
              <span className="dim">C <span className={legend.close >= legend.open ? "up" : "down"}>{legend.exact?.close ?? fmt(legend.close)}</span></span>
              <span className="dim">Vol <span className="text-[var(--text)]">{legend.exact?.volume ?? fmtBig(legend.volume)}</span></span>
            </div>
            {indicatorRows.length > 0 && (
              <div className="flex gap-3 flex-wrap">
                {indicatorRows.map((r) => (
                  <span key={r.label} className="dim">
                    {r.label} <span style={{ color: r.color }}>{r.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
