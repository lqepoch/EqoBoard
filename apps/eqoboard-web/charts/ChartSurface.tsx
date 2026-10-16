"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { LightweightChartController, type SnapshotBehavior } from "./controller";
import { ChartEvidencePanel } from "./EvidencePanel";
import { formatChartCrosshairTimeEtAndUtc } from "./time";
import type {
  ChartDisplayEvidence,
  ChartIndicatorValues,
  ChartPlotBar,
  ChartStyle,
  IndicatorId,
} from "./types";
import "./chart-surface.css";

export type ChartSurfaceStatus = "idle" | "loading" | "ready" | "error";

export type ChartSurfaceHandle = Readonly<{
  fitContent(): void;
  zoom(factor: number): void;
  takeScreenshot(): HTMLCanvasElement;
}>;

export type ChartSurfaceProps<TRow = unknown> = Readonly<{
  symbol: string;
  identity: string;
  bars: readonly ChartPlotBar<TRow>[];
  indicators: ChartIndicatorValues;
  style: ChartStyle;
  enabledIndicators: readonly IndicatorId[];
  showVolume: boolean;
  timeVisible: boolean;
  evidence: ChartDisplayEvidence | null;
  status: ChartSurfaceStatus;
  statusMessage?: string;
  notice?: string;
  emptyMessage?: string;
  snapshotBehavior?: SnapshotBehavior;
  olderPageAvailable?: boolean;
  olderPageLoading?: boolean;
  olderPageTestId?: string;
  onRequestOlder?: () => void;
  onSurfaceReady?: (handle: ChartSurfaceHandle | null) => void;
  onCrosshairChange?: (bar: ChartPlotBar<TRow> | null) => void;
}>;

const ATTRIBUTION_URL = "https://www.tradingview.com/lightweight-charts/";

/** Presentational renderer shared by native chart and research charts. */
export function ChartSurface<TRow = unknown>({
  symbol,
  identity,
  bars,
  indicators,
  style,
  enabledIndicators,
  showVolume,
  timeVisible,
  evidence,
  status,
  statusMessage,
  notice,
  emptyMessage = "No historical observations are loaded.",
  snapshotBehavior = "preserve",
  olderPageAvailable = false,
  olderPageLoading = false,
  olderPageTestId = "native-chart-load-older",
  onRequestOlder,
  onSurfaceReady,
  onCrosshairChange,
}: ChartSurfaceProps<TRow>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<LightweightChartController<TRow> | null>(null);
  const readyCallbackRef = useRef(onSurfaceReady);
  const crosshairCallbackRef = useRef(onCrosshairChange);
  const olderRequestRef = useRef({
    available: olderPageAvailable,
    loading: olderPageLoading,
    callback: onRequestOlder,
  });
  const panGestureRef = useRef<Readonly<{
    pointerId: number;
    startX: number;
    horizontalPan: boolean;
    requested: boolean;
  }> | null>(null);
  const [crosshairBar, setCrosshairBar] = useState<ChartPlotBar<TRow> | null>(null);
  const sortedIndicators = useMemo(() => [...enabledIndicators].sort(), [enabledIndicators]);
  const chartOptionsRef = useRef({ style, indicators: sortedIndicators, showVolume, timeVisible });

  useLayoutEffect(() => {
    chartOptionsRef.current = { style, indicators: sortedIndicators, showVolume, timeVisible };
  }, [style, sortedIndicators, showVolume, timeVisible]);

  useLayoutEffect(() => {
    readyCallbackRef.current = onSurfaceReady;
  }, [onSurfaceReady]);

  useLayoutEffect(() => {
    crosshairCallbackRef.current = onCrosshairChange;
  }, [onCrosshairChange]);

  useLayoutEffect(() => {
    olderRequestRef.current = {
      available: olderPageAvailable,
      loading: olderPageLoading,
      callback: onRequestOlder,
    };
  }, [olderPageAvailable, olderPageLoading, onRequestOlder]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onPointerDownCapture = (event: PointerEvent) => {
      if (event.button !== 0) return;
      panGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        horizontalPan: false,
        requested: false,
      };
    };
    const onPointerMoveCapture = (event: PointerEvent) => {
      const gesture = panGestureRef.current;
      if (
        !gesture ||
        gesture.pointerId !== event.pointerId ||
        gesture.horizontalPan ||
        Math.abs(event.clientX - gesture.startX) < 5
      )
        return;
      panGestureRef.current = { ...gesture, horizontalPan: true };
    };
    const endPointerGesture = (event: PointerEvent) => {
      if (panGestureRef.current?.pointerId === event.pointerId) panGestureRef.current = null;
    };
    container.addEventListener("pointerdown", onPointerDownCapture, true);
    container.addEventListener("pointermove", onPointerMoveCapture, true);
    container.addEventListener("pointerup", endPointerGesture, true);
    container.addEventListener("pointercancel", endPointerGesture, true);
    const initialOptions = chartOptionsRef.current;
    const controller = new LightweightChartController<TRow>(container, {
      ...initialOptions,
      onLeftEdge: () => {
        const gesture = panGestureRef.current;
        const request = olderRequestRef.current;
        if (!gesture?.horizontalPan || gesture.requested || !request.available || request.loading)
          return;
        panGestureRef.current = { ...gesture, requested: true };
        request.callback?.();
      },
      onCrosshair: (bar) => {
        setCrosshairBar(bar);
        crosshairCallbackRef.current?.(bar);
      },
    });
    controllerRef.current = controller;
    readyCallbackRef.current?.({
      fitContent: () => controller.fitContent(),
      zoom: (factor) => controller.zoom(factor),
      takeScreenshot: () => controller.takeScreenshot(),
    });
    return () => {
      readyCallbackRef.current?.(null);
      controller.dispose();
      container.removeEventListener("pointerdown", onPointerDownCapture, true);
      container.removeEventListener("pointermove", onPointerMoveCapture, true);
      container.removeEventListener("pointerup", endPointerGesture, true);
      container.removeEventListener("pointercancel", endPointerGesture, true);
      panGestureRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
    };
    // The controller owns one chart for this mounted surface. Live option updates
    // are applied below without replacing the chart DOM or losing its viewport.
  }, []);

  useLayoutEffect(() => {
    controllerRef.current?.updateOptions({
      style,
      indicators: sortedIndicators,
      showVolume,
      timeVisible,
    });
  }, [style, showVolume, timeVisible, sortedIndicators]);

  useLayoutEffect(() => {
    controllerRef.current?.setSnapshot(identity, bars, indicators, snapshotBehavior);
  }, [identity, bars, indicators, snapshotBehavior]);

  return (
    <section
      className="native-chart-surface"
      data-testid="native-chart-surface"
      data-chart-live="false"
      aria-label={`${symbol} historical chart`}
    >
      <div className="native-chart-surface__plot-wrap">
        <div
          ref={containerRef}
          className="native-chart-surface__plot"
          data-testid="native-chart-plot"
          role="img"
          aria-label={`${symbol} price chart. Historical data only; no live bar corrections are available.`}
        />
        {status === "loading" && bars.length === 0 ? (
          <div className="native-chart-surface__empty" role="status">
            Loading historical bars…
          </div>
        ) : null}
        {status === "error" && bars.length === 0 ? (
          <div className="native-chart-surface__empty" role="alert">
            {statusMessage ?? "Historical bars could not be loaded."}
          </div>
        ) : null}
        {status !== "loading" && bars.length === 0 && status !== "error" ? (
          <div className="native-chart-surface__empty" role="status">
            {emptyMessage}
          </div>
        ) : null}
        {bars.length > 0 && status === "loading" ? (
          <div className="native-chart-surface__updating" role="status">
            Refreshing loaded history…
          </div>
        ) : null}
      </div>
      <div
        className="native-chart-surface__readout"
        aria-live="polite"
        data-testid="native-chart-crosshair"
      >
        {crosshairBar ? (
          <>
            <span>{formatChartCrosshairTimeEtAndUtc(Number(crosshairBar.time))}</span>
            <span>O {crosshairBar.exact?.open ?? crosshairBar.open}</span>
            <span>H {crosshairBar.exact?.high ?? crosshairBar.high}</span>
            <span>L {crosshairBar.exact?.low ?? crosshairBar.low}</span>
            <span>C {crosshairBar.exact?.close ?? crosshairBar.close}</span>
            <span>V {crosshairBar.exact?.volume ?? crosshairBar.volume}</span>
          </>
        ) : (
          <span>{statusMessage ?? `${bars.length.toLocaleString()} loaded bars · ${style}`}</span>
        )}
        <button
          type="button"
          className="native-chart-surface__fit"
          onClick={() => controllerRef.current?.fitContent()}
          disabled={bars.length === 0}
          aria-label="Fit loaded chart history"
          data-testid="native-chart-fit-content"
        >
          Fit
        </button>
        <button
          type="button"
          className="native-chart-surface__zoom"
          onClick={() => controllerRef.current?.zoom(0.8)}
          disabled={bars.length < 2}
          aria-label="Zoom in"
          data-testid="native-chart-zoom-in"
        >
          +
        </button>
        <button
          type="button"
          className="native-chart-surface__zoom"
          onClick={() => controllerRef.current?.zoom(1.25)}
          disabled={bars.length < 2}
          aria-label="Zoom out"
          data-testid="native-chart-zoom-out"
        >
          −
        </button>
      </div>
      {olderPageAvailable || olderPageLoading ? (
        <div className="native-chart-surface__paging">
          <button
            type="button"
            onClick={onRequestOlder}
            disabled={!olderPageAvailable || olderPageLoading}
            data-testid={olderPageTestId}
          >
            {olderPageLoading ? "Loading older bars…" : "Load older bars"}
          </button>
          <span>Each page extends only the loaded observation window.</span>
        </div>
      ) : null}
      {notice ? (
        <p className="native-chart-surface__notice" role="note">
          {notice}
        </p>
      ) : null}
      <ChartEvidencePanel evidence={evidence} />
      <div className="native-chart-attribution" data-testid="native-chart-tradingview-attribution">
        <span>Charts by</span>{" "}
        <a
          href={ATTRIBUTION_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="TradingView Lightweight Charts attribution"
        >
          TradingView Lightweight Charts
        </a>
      </div>
    </section>
  );
}
