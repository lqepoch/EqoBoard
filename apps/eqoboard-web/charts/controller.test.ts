import { describe, expect, it, vi } from "vitest";
import type { IChartApi } from "lightweight-charts";
import { LightweightChartController } from "./controller";
import type { ChartPlotBar } from "./types";

function fakeChart() {
  const removedSeries: Array<{ setData: ReturnType<typeof vi.fn> }> = [];
  const series = () => {
    const next = { setData: vi.fn(), applyOptions: vi.fn() };
    removedSeries.push(next);
    return next;
  };
  let visibleRange: { from: number; to: number } | null = null;
  const visibleRangeListeners: Array<(range: { from: number; to: number } | null) => void> = [];
  const timeScale = {
    getVisibleLogicalRange: vi.fn(() => visibleRange),
    fitContent: vi.fn(),
    setVisibleLogicalRange: vi.fn((range: { from: number; to: number }) => { visibleRange = range; }),
    subscribeVisibleLogicalRangeChange: vi.fn((listener: (range: { from: number; to: number } | null) => void) => { visibleRangeListeners.push(listener); }),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  const chart = {
    addSeries: vi.fn(() => series()),
    applyOptions: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
    resize: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    timeScale: vi.fn(() => timeScale),
    removeSeries: vi.fn(),
    takeScreenshot: vi.fn(() => ({} as HTMLCanvasElement)),
    remove: vi.fn(),
  };
  return { chart, removedSeries, timeScale, visibleRangeListeners };
}

describe("Lightweight Charts controller", () => {
  it("rebuilds visual series for settings, reapplies loaded data, and releases owned resources once", () => {
    const { chart, removedSeries, timeScale } = fakeChart();
    const createChart = vi.fn(() => chart as unknown as IChartApi);
    const disconnect = vi.fn();
    const observe = vi.fn();
    const onCrosshair = vi.fn();
    const resizeObserverFactory = vi.fn(() => ({ observe, disconnect }));
    const container = { clientWidth: 640, clientHeight: 320 } as HTMLElement;
    const controller = new LightweightChartController(container, {
      style: "candles", indicators: ["SMA20"], showVolume: true, timeVisible: true,
      onCrosshair,
      createChart: createChart as never,
      resizeObserverFactory: resizeObserverFactory as never,
    });
    const bar: ChartPlotBar = {
      time: 1_720_000_000 as ChartPlotBar["time"], open: 10, high: 12, low: 9, close: 11, volume: 100, sourceRow: "row",
    };
    controller.setSnapshot("SPY|1d|core-bars", [bar], {
      overlays: { SMA20: [{ time: Number(bar.time), value: 10 }], SMA50: null, SMA200: null, EMA20: null, VWAP: null, bollinger: null },
      panes: { rsi: null, macd: null },
    }, "reset");
    controller.setSnapshot("QQQ|1d|core-bars", [], {
      overlays: { SMA20: null, SMA50: null, SMA200: null, EMA20: null, VWAP: null, bollinger: null },
      panes: { rsi: null, macd: null },
    }, "reset");
    controller.updateOptions({ style: "line", indicators: ["SMA20", "RSI"], showVolume: false, timeVisible: false });

    expect(chart.addSeries).toHaveBeenCalled();
    expect(removedSeries.some((item) => item.setData.mock.calls.length > 0)).toBe(true);
    expect(createChart).toHaveBeenCalledWith(container, expect.objectContaining({
      layout: expect.objectContaining({ attributionLogo: true }),
    }));
    expect(chart.applyOptions).toHaveBeenCalledWith({ timeScale: { timeVisible: false, secondsVisible: false } });
    expect(onCrosshair).toHaveBeenCalledWith(null);
    expect(observe).toHaveBeenCalledWith(container);

    controller.dispose();
    controller.dispose();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(1);
    expect(timeScale.unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(1);
    expect(chart.remove).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to take a screenshot after disposal", () => {
    const { chart } = fakeChart();
    const controller = new LightweightChartController({ clientWidth: 640, clientHeight: 320 } as HTMLElement, {
      style: "candles", indicators: [], showVolume: false, timeVisible: true,
      createChart: vi.fn(() => chart as unknown as IChartApi) as never,
      resizeObserverFactory: vi.fn(() => null) as never,
    });
    controller.dispose();

    expect(() => controller.takeScreenshot()).toThrow("Chart has been disposed");
    expect(chart.takeScreenshot).not.toHaveBeenCalled();
  });

  it("translates the viewport by the anchored candle when older rows are prepended", () => {
    const { chart, timeScale } = fakeChart();
    const controller = new LightweightChartController<string>({ clientWidth: 640, clientHeight: 320 } as HTMLElement, {
      style: "candles", indicators: [], showVolume: false, timeVisible: true,
      createChart: vi.fn(() => chart as unknown as IChartApi) as never,
      resizeObserverFactory: vi.fn(() => null) as never,
    });
    const bars = (times: readonly number[]): ChartPlotBar<string>[] => times.map((time) => ({
      time: time as ChartPlotBar["time"], open: 10, high: 11, low: 9, close: 10, volume: 10, sourceRow: String(time),
    }));
    const indicators = {
      overlays: { SMA20: null, SMA50: null, SMA200: null, EMA20: null, VWAP: null, bollinger: null },
      panes: { rsi: null, macd: null },
    } as const;

    controller.setSnapshot("SPY|1d|core", bars([30, 40, 50, 60, 70]), indicators, "reset");
    timeScale.setVisibleLogicalRange({ from: 2, to: 4 });
    timeScale.setVisibleLogicalRange.mockClear();
    controller.setSnapshot("SPY|1d|core", bars([10, 20, 30, 40, 50, 60, 70]), indicators, "prepend");

    expect(timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 4, to: 6 });
    controller.dispose();
  });

  it("signals older-history availability only at the left edge after rows load", () => {
    const { chart, visibleRangeListeners } = fakeChart();
    const onLeftEdge = vi.fn();
    const controller = new LightweightChartController<string>({ clientWidth: 640, clientHeight: 320 } as HTMLElement, {
      style: "candles", indicators: [], showVolume: false, timeVisible: true, onLeftEdge,
      createChart: vi.fn(() => chart as unknown as IChartApi) as never,
      resizeObserverFactory: vi.fn(() => null) as never,
    });
    const bar: ChartPlotBar<string> = {
      time: 1_720_000_000 as ChartPlotBar["time"], open: 10, high: 11, low: 9, close: 10, volume: 10, sourceRow: "row",
    };
    controller.setSnapshot("SPY", [bar], {
      overlays: { SMA20: null, SMA50: null, SMA200: null, EMA20: null, VWAP: null, bollinger: null },
      panes: { rsi: null, macd: null },
    }, "reset");

    visibleRangeListeners[0]?.({ from: 2, to: 5 });
    visibleRangeListeners[0]?.({ from: 1, to: 5 });

    expect(onLeftEdge).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
