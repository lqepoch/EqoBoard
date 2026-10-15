import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { remapViewportAfterPrepend, retainViewportOnRefresh, saveViewport } from "./history";
import { formatChartAxisTimeEt } from "./time";
import type { ChartIndicatorValues, ChartPlotBar, ChartStyle, IndicatorId } from "./types";

type ChartSeries = ReturnType<IChartApi["addSeries"]>;
type CrosshairHandler = Parameters<IChartApi["subscribeCrosshairMove"]>[0];
type CrosshairEvent = Parameters<CrosshairHandler>[0];
type VisibleLogicalRangeHandler = Parameters<ReturnType<IChartApi["timeScale"]>["subscribeVisibleLogicalRangeChange"]>[0];

export type SnapshotBehavior = "reset" | "preserve" | "prepend" | "refresh";

export type ChartControllerOptions = Readonly<{
  style: ChartStyle;
  indicators: readonly IndicatorId[];
  showVolume: boolean;
  timeVisible: boolean;
  onCrosshair?: (bar: ChartPlotBar | null) => void;
  onLeftEdge?: () => void;
  createChart?: typeof createChart;
  resizeObserverFactory?: (callback: ResizeObserverCallback) => Pick<ResizeObserver, "observe" | "disconnect"> | null;
}>;

type SeriesSet = {
  main: ChartSeries | null;
  volume: ChartSeries | null;
  overlays: Map<string, ChartSeries>;
  panes: ChartSeries[];
};

const COLORS = Object.freeze({
  up: "#26a69a",
  down: "#ef5350",
  line: "#5e9eff",
  areaTop: "rgba(94,158,255,0.28)",
  areaBottom: "rgba(94,158,255,0.015)",
  volumeUp: "rgba(38,166,154,0.52)",
  volumeDown: "rgba(239,83,80,0.52)",
  SMA20: "#f5c451",
  SMA50: "#54c3d6",
  SMA200: "#bb86fc",
  EMA20: "#f28b82",
  VWAP: "#63d6b2",
  BOLL: "#a78bfa",
  RSI: "#ffad66",
  MACD: "#80cbc4",
  MACD_SIGNAL: "#d8dee9",
  MACD_HISTOGRAM: "rgba(94,158,255,0.72)",
});

function defaultResizeObserverFactory(callback: ResizeObserverCallback) {
  return typeof ResizeObserver === "undefined" ? null : new ResizeObserver(callback);
}

function seriesData<TRow>(rows: readonly ChartPlotBar<TRow>[]) {
  return rows.map((row) => ({
    time: row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));
}

function closeData<TRow>(rows: readonly ChartPlotBar<TRow>[]) {
  return rows.map((row) => ({ time: row.time, value: row.close }));
}

/** Owns one Lightweight Charts instance and all resources attached to it. */
export class LightweightChartController<TRow = unknown> {
  private readonly chart: IChartApi;
  private readonly container: HTMLElement;
  private readonly resizeObserver: Pick<ResizeObserver, "observe" | "disconnect"> | null;
  private readonly timeScale: ReturnType<IChartApi["timeScale"]>;
  private readonly series: SeriesSet = { main: null, volume: null, overlays: new Map(), panes: [] };
  private bars: readonly ChartPlotBar<TRow>[] = [];
  private lastIndicators: ChartIndicatorValues | null = null;
  private barsByTime = new Map<number, ChartPlotBar<TRow>>();
  private identity = "";
  private structureKey = "";
  private style: ChartStyle;
  private indicators: readonly IndicatorId[];
  private showVolume: boolean;
  private timeVisible: boolean;
  private disposed = false;
  private onCrosshair?: (bar: ChartPlotBar<TRow> | null) => void;
  private onLeftEdge?: () => void;

  private readonly onCrosshairMove: CrosshairHandler = (event: CrosshairEvent) => {
    const time = typeof event.time === "number" ? event.time : null;
    this.onCrosshair?.(time === null ? null : this.barsByTime.get(time) ?? null);
  };

  private readonly onVisibleLogicalRangeChange: VisibleLogicalRangeHandler = (range) => {
    if (!this.disposed && this.bars.length > 0 && range && range.from <= 1.5) this.onLeftEdge?.();
  };

  private readonly onResize = () => {
    if (this.disposed) return;
    const width = Math.floor(this.container.clientWidth);
    const height = Math.floor(this.container.clientHeight);
    if (width > 0 && height > 0) this.chart.resize(width, height);
  };

  constructor(container: HTMLElement, options: ChartControllerOptions) {
    this.container = container;
    this.style = options.style;
    this.indicators = [...options.indicators];
    this.showVolume = options.showVolume;
    this.timeVisible = options.timeVisible;
    this.onCrosshair = options.onCrosshair as ((bar: ChartPlotBar<TRow> | null) => void) | undefined;
    this.onLeftEdge = options.onLeftEdge;
    const makeChart = options.createChart ?? createChart;
    this.chart = makeChart(container, {
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      autoSize: false,
      layout: {
        background: { color: "#0b1019" },
        textColor: "#aab4c3",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        attributionLogo: true,
      },
      localization: {
        timeFormatter: (time) => formatChartAxisTimeEt(time, this.timeVisible),
      },
      grid: { vertLines: { color: "#17202d" }, horzLines: { color: "#17202d" } },
      crosshair: {
        mode: 0,
        vertLine: { color: "#7c9ab8", width: 1, style: LineStyle.Dotted },
        horzLine: { color: "#7c9ab8", width: 1, style: LineStyle.Dotted },
      },
      timeScale: {
        borderColor: "#263244",
        timeVisible: this.timeVisible,
        secondsVisible: false,
        rightOffset: 5,
        tickMarkFormatter: (time) => formatChartAxisTimeEt(time, this.timeVisible),
      },
      rightPriceScale: { borderColor: "#263244", scaleMargins: { top: 0.1, bottom: 0.22 } },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    });
    this.timeScale = this.chart.timeScale();
    this.chart.subscribeCrosshairMove(this.onCrosshairMove);
    this.timeScale.subscribeVisibleLogicalRangeChange(this.onVisibleLogicalRangeChange);
    const makeResizeObserver = options.resizeObserverFactory ?? defaultResizeObserverFactory;
    this.resizeObserver = makeResizeObserver(this.onResize);
    this.resizeObserver?.observe(container);
    if (!this.resizeObserver && typeof window !== "undefined") window.addEventListener("resize", this.onResize);
    this.onResize();
    this.rebuildSeries();
  }

  setCrosshairCallback(callback: ((bar: ChartPlotBar<TRow> | null) => void) | undefined): void {
    if (this.disposed) return;
    this.onCrosshair = callback;
  }

  updateOptions(options: Readonly<{
    style: ChartStyle;
    indicators: readonly IndicatorId[];
    showVolume: boolean;
    timeVisible: boolean;
  }>): void {
    if (this.disposed) return;
    const previousRange = this.timeScale.getVisibleLogicalRange();
    const previousStructure = this.currentStructureKey();
    this.style = options.style;
    this.indicators = [...options.indicators];
    this.showVolume = options.showVolume;
    this.timeVisible = options.timeVisible;
    this.chart.applyOptions({ timeScale: { timeVisible: this.timeVisible, secondsVisible: false } });
    if (previousStructure !== this.currentStructureKey()) {
      this.rebuildSeries();
      this.applySeriesData(this.lastIndicators ?? undefined);
      if (previousRange) this.timeScale.setVisibleLogicalRange(previousRange);
    }
  }

  setSnapshot(
    identity: string,
    bars: readonly ChartPlotBar<TRow>[],
    indicators: ChartIndicatorValues,
    behavior: SnapshotBehavior,
  ): void {
    if (this.disposed) return;
    const previousBars = this.bars;
    const previousRange = this.timeScale.getVisibleLogicalRange();
    const saved = previousRange && previousBars.length > 0
      ? saveViewport(this.identity || identity, previousRange, previousBars)
      : null;
    const identityChanged = Boolean(this.identity && this.identity !== identity);
    if (identityChanged) this.onCrosshair?.(null);
    this.identity = identity;
    this.bars = [...bars];
    this.lastIndicators = indicators;
    this.barsByTime = new Map(this.bars.map((bar) => [Number(bar.time), bar]));
    if (this.structureKey !== this.currentStructureKey()) this.rebuildSeries();
    this.applySeriesData(indicators);

    if (this.bars.length === 0) return;
    if (behavior === "reset" || (identityChanged && behavior !== "preserve")) {
      this.timeScale.fitContent();
      return;
    }
    if (!previousRange) {
      this.timeScale.fitContent();
      return;
    }
    if (behavior === "prepend" && saved) {
      const translated = remapViewportAfterPrepend(saved, this.bars);
      if (translated) this.timeScale.setVisibleLogicalRange(translated);
      return;
    }
    if (behavior === "refresh") {
      const retained = retainViewportOnRefresh(previousRange, previousBars.length, this.bars.length);
      if (retained) this.timeScale.setVisibleLogicalRange(retained);
      return;
    }
    this.timeScale.setVisibleLogicalRange(previousRange);
  }

  fitContent(): void {
    if (!this.disposed && this.bars.length > 0) this.timeScale.fitContent();
  }

  zoom(factor: number): void {
    if (this.disposed || this.bars.length < 2 || !Number.isFinite(factor) || factor <= 0) return;
    const current = this.timeScale.getVisibleLogicalRange();
    const currentWidth = current ? current.to - current.from : Math.min(this.bars.length - 1, 80);
    const nextWidth = Math.max(1, Math.min(this.bars.length - 1, currentWidth * factor));
    const center = current ? (current.from + current.to) / 2 : this.bars.length - 1;
    const from = Math.max(0, Math.min(this.bars.length - 1 - nextWidth, center - nextWidth / 2));
    this.timeScale.setVisibleLogicalRange({ from, to: from + nextWidth });
  }

  takeScreenshot(): HTMLCanvasElement {
    if (this.disposed) throw new Error("Chart has been disposed.");
    return this.chart.takeScreenshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    if (!this.resizeObserver && typeof window !== "undefined") window.removeEventListener("resize", this.onResize);
    this.chart.unsubscribeCrosshairMove(this.onCrosshairMove);
    this.timeScale.unsubscribeVisibleLogicalRangeChange(this.onVisibleLogicalRangeChange);
    for (const series of this.allSeries()) this.chart.removeSeries(series);
    this.series.main = null;
    this.series.volume = null;
    this.series.overlays.clear();
    this.series.panes = [];
    this.chart.remove();
    this.bars = [];
    this.barsByTime.clear();
    this.lastIndicators = null;
    this.onCrosshair = undefined;
    this.onLeftEdge = undefined;
  }

  private currentStructureKey(): string {
    return [this.style, this.showVolume ? "volume" : "no-volume", [...this.indicators].sort().join(",")].join("|");
  }

  private allSeries(): ChartSeries[] {
    return [
      ...(this.series.main ? [this.series.main] : []),
      ...(this.series.volume ? [this.series.volume] : []),
      ...this.series.overlays.values(),
      ...this.series.panes,
    ];
  }

  private rebuildSeries(): void {
    for (const series of this.allSeries()) this.chart.removeSeries(series);
    this.series.main = null;
    this.series.volume = null;
    this.series.overlays.clear();
    this.series.panes = [];
    this.structureKey = this.currentStructureKey();

    if (this.style === "candles") {
      this.series.main = this.chart.addSeries(CandlestickSeries, {
        upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down,
        wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      });
    } else if (this.style === "bars") {
      this.series.main = this.chart.addSeries(BarSeries, { upColor: COLORS.up, downColor: COLORS.down });
    } else if (this.style === "area") {
      this.series.main = this.chart.addSeries(AreaSeries, {
        lineColor: COLORS.line, topColor: COLORS.areaTop, bottomColor: COLORS.areaBottom, lineWidth: 2,
      });
    } else {
      this.series.main = this.chart.addSeries(LineSeries, { color: COLORS.line, lineWidth: 2 });
    }

    if (this.showVolume) {
      this.series.volume = this.chart.addSeries(HistogramSeries, {
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }

    const lineDefinitions: Array<readonly [IndicatorId, string, number]> = [
      ["SMA20", COLORS.SMA20, 1], ["SMA50", COLORS.SMA50, 1], ["SMA200", COLORS.SMA200, 1],
      ["EMA20", COLORS.EMA20, 1], ["VWAP", COLORS.VWAP, 1],
    ];
    for (const [id, color] of lineDefinitions) {
      if (!this.indicators.includes(id)) continue;
      this.series.overlays.set(id, this.chart.addSeries(LineSeries, {
        color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      }));
    }
    if (this.indicators.includes("BOLL")) {
      for (const key of ["upper", "middle", "lower"] as const) {
        this.series.overlays.set(`BOLL_${key}`, this.chart.addSeries(LineSeries, {
          color: COLORS.BOLL, lineWidth: 1, lineStyle: key === "middle" ? LineStyle.Dotted : LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false,
        }));
      }
    }

    let paneIndex = 1;
    if (this.indicators.includes("RSI")) {
      this.series.panes.push(this.chart.addSeries(LineSeries, {
        color: COLORS.RSI, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        title: "RSI 14 (flat=50)",
      }, paneIndex));
      paneIndex += 1;
    }
    if (this.indicators.includes("MACD")) {
      this.series.panes.push(this.chart.addSeries(HistogramSeries, { color: COLORS.MACD_HISTOGRAM, title: "MACD Histogram" }, paneIndex));
      this.series.panes.push(this.chart.addSeries(LineSeries, {
        color: COLORS.MACD, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "MACD",
      }, paneIndex));
      this.series.panes.push(this.chart.addSeries(LineSeries, {
        color: COLORS.MACD_SIGNAL, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "Signal",
      }, paneIndex));
    }
  }

  private applySeriesData(indicators?: ChartIndicatorValues): void {
    if (!this.series.main) return;
    if (this.style === "candles" || this.style === "bars") {
      this.series.main.setData(seriesData(this.bars) as never);
    } else {
      this.series.main.setData(closeData(this.bars) as never);
    }
    if (this.series.volume) {
      this.series.volume.setData(this.bars.map((bar) => ({
        time: bar.time,
        value: bar.volume,
        color: bar.close >= bar.open ? COLORS.volumeUp : COLORS.volumeDown,
      })) as never);
    }
    if (!indicators) return;
    const mapLine = (points: readonly { time: number; value: number }[]) =>
      points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
    for (const [id, series] of this.series.overlays) {
      if (id === "BOLL_upper") series.setData(mapLine(indicators.overlays.bollinger?.upper ?? []) as never);
      else if (id === "BOLL_middle") series.setData(mapLine(indicators.overlays.bollinger?.middle ?? []) as never);
      else if (id === "BOLL_lower") series.setData(mapLine(indicators.overlays.bollinger?.lower ?? []) as never);
      else {
        const points = id === "SMA20" ? indicators.overlays.SMA20
          : id === "SMA50" ? indicators.overlays.SMA50
            : id === "SMA200" ? indicators.overlays.SMA200
              : id === "EMA20" ? indicators.overlays.EMA20
                : indicators.overlays.VWAP;
        series.setData(mapLine(points ?? []) as never);
      }
    }
    let paneIndex = 0;
    if (this.indicators.includes("RSI")) {
      this.series.panes[paneIndex++]?.setData(mapLine(indicators.panes.rsi ?? []) as never);
    }
    if (this.indicators.includes("MACD")) {
      const macd = indicators.panes.macd;
      this.series.panes[paneIndex++]?.setData(mapLine(macd?.histogram ?? []) as never);
      this.series.panes[paneIndex++]?.setData(mapLine(macd?.macd ?? []) as never);
      this.series.panes[paneIndex++]?.setData(mapLine(macd?.signal ?? []) as never);
    }
  }
}
