"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateChartIndicators, ChartSurface, type ChartSurfaceHandle } from "@/charts";
import { chartExportFilename, composeChartPngCanvas, downloadChartPng } from "@/charts/export";
import { CHART_INDICATORS, type IndicatorId } from "@/charts/types";
import type { NativeDataOperationMap } from "@/features/data/operations";
import {
  buildYfinanceResearchInput,
  buildYfinanceOlderPageInput,
  buildYahooResearchPageHref,
  canLoadOlderPages,
  isYfinanceCursorLoop,
  parseYfinanceResearchResponse,
  yfinancePagesForProjection,
  yfinancePagesForEvidence,
  projectYfinanceResearchPages,
  yfinanceSelectionKey,
  yfinanceSnapshotBehavior,
  YFINANCE_RESEARCH_RANGES,
  yfinanceResearchEvidence,
  type YfinanceResearchConfigV1,
  type YfinanceResearchPage,
  type YfinanceSnapshotBehavior,
} from "@/features/research/yfinance";
import type { YfinanceResearchInput } from "@/features/research/yfinance-contract";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import { useAuth as useFullAuth } from "@/components/auth/AuthProvider";
import styles from "./research-widgets.module.css";

type YahooDailyOperationMap = Pick<NativeDataOperationMap, "research.yahoo.daily">;
type Props = WidgetProps<YfinanceResearchConfigV1, YahooDailyOperationMap, WidgetNoActionMap>;
type RequiredHost = Pick<Props["host"], "auth" | "data" | "lifecycle">;
export type YfinanceDailyWidgetProps = Pick<Props, "config" | "inputs" | "onConfigChange"> &
  Readonly<{ host: RequiredHost }>;

type HistoryState = Readonly<{
  selectionKey: string;
  status: "idle" | "loading" | "ready" | "error";
  /** Immutable cursor chain from the first request's exact UTC window. */
  cursorPages: readonly YfinanceResearchPage[];
  /** Single moving first-page snapshot; never added to the cursor chain. */
  latestHead: YfinanceResearchPage | null;
  loadingOlder: boolean;
  paginationBlocked: boolean;
  error: string | null;
  snapshotBehavior: YfinanceSnapshotBehavior;
}>;

function emptyState(
  selectionKey: string,
  status: HistoryState["status"] = "idle",
  snapshotBehavior: YfinanceSnapshotBehavior = yfinanceSnapshotBehavior("new-request"),
): HistoryState {
  return {
    selectionKey,
    status,
    cursorPages: [],
    latestHead: null,
    loadingOlder: false,
    paginationBlocked: false,
    error: null,
    snapshotBehavior,
  };
}

export function YfinanceDailyWidget({
  config,
  inputs,
  host,
  onConfigChange,
}: YfinanceDailyWidgetProps) {
  const fullAuth = useFullAuth();
  const [anchorNow, setAnchorNow] = useState(() => Date.now());
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [history, setHistory] = useState<HistoryState>(() => emptyState(""));
  const [exportError, setExportError] = useState<string | null>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const historyRef = useRef(history);
  const surfaceRef = useRef<ChartSurfaceHandle | null>(null);
  const requestGenerationRef = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const allowed =
    fullAuth.runtimeMode === "research" &&
    fullAuth.authenticated &&
    fullAuth.permissions.includes("research:read") &&
    host.auth.authenticated &&
    host.auth.permissions.includes("research:read");
  const requestIntent = useMemo(
    () => ({
      input: buildYfinanceResearchInput(
        {
          symbol: config.symbol,
          assetClass: config.assetClass,
          range: config.range,
          adjustment: config.adjustment,
        },
        inputs.symbol,
        anchorNow,
      ),
      // A manual refresh must issue a new read even when the UTC window is unchanged.
      revision: refreshRevision,
    }),
    [
      config.symbol,
      config.assetClass,
      config.range,
      config.adjustment,
      inputs.symbol,
      anchorNow,
      refreshRevision,
    ],
  );
  const request = requestIntent.input;
  const selectionKey = request
    ? yfinanceSelectionKey(config, inputs.symbol)
    : `invalid:${yfinanceSelectionKey(config, inputs.symbol)}`;
  const current =
    history.selectionKey === selectionKey
      ? history
      : emptyState(selectionKey, request ? "loading" : "idle");

  const commitHistory = useCallback((next: HistoryState) => {
    historyRef.current = next;
    setHistory(next);
  }, []);
  const updateHistory = useCallback((update: (current: HistoryState) => HistoryState) => {
    setHistory((current) => {
      const next = update(current);
      historyRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const request = requestIntent.input;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    if (!allowed || !request) {
      activeRequest.current?.abort();
      commitHistory(emptyState(selectionKey));
      return;
    }
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) {
      activeRequest.current?.abort();
      commitHistory(emptyState(selectionKey));
      return;
    }
    const previous = historyRef.current;
    const preserveLoadedPages =
      previous.selectionKey === selectionKey && previous.cursorPages.length > 0;
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    activeRequest.current?.abort();
    activeRequest.current = controller;
    commitHistory(
      preserveLoadedPages
        ? {
            ...previous,
            selectionKey,
            status: "loading",
            loadingOlder: false,
            error: null,
            snapshotBehavior: yfinanceSnapshotBehavior("refresh"),
          }
        : emptyState(selectionKey, "loading", yfinanceSnapshotBehavior("new-request")),
    );
    void host.data
      .read("research.yahoo.daily", request, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted || requestGenerationRef.current !== generation) return;
        const response = parseYfinanceResearchResponse(value, request);
        if (!response) {
          const latest = historyRef.current;
          commitHistory({
            ...(preserveLoadedPages && latest.selectionKey === selectionKey
              ? latest
              : emptyState(selectionKey, "error")),
            status: preserveLoadedPages ? "ready" : "error",
            error: "Yahoo returned a response outside the validated daily research contract.",
          });
          return;
        }
        const latest = historyRef.current;
        const headPage: YfinanceResearchPage = { request, response };
        const retainCursorPages =
          latest.selectionKey === selectionKey && preserveLoadedPages
            ? latest.cursorPages
            : Object.freeze([headPage]);
        commitHistory({
          ...emptyState(
            selectionKey,
            "ready",
            preserveLoadedPages
              ? yfinanceSnapshotBehavior("refresh")
              : yfinanceSnapshotBehavior("new-request"),
          ),
          cursorPages: retainCursorPages,
          latestHead: headPage,
          paginationBlocked:
            preserveLoadedPages && latest.selectionKey === selectionKey
              ? latest.paginationBlocked
              : false,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted && requestGenerationRef.current === generation) {
          const latest = historyRef.current;
          commitHistory({
            ...(preserveLoadedPages && latest.selectionKey === selectionKey
              ? latest
              : emptyState(selectionKey, "error")),
            status: preserveLoadedPages ? "ready" : "error",
            error: "Yahoo daily observations are unavailable for this request.",
          });
        }
      })
      .finally(() => {
        lifecycle.signal.removeEventListener("abort", abort);
        if (activeRequest.current === controller) activeRequest.current = null;
      });
    return () => {
      lifecycle.signal.removeEventListener("abort", abort);
      controller.abort();
      if (activeRequest.current === controller) activeRequest.current = null;
    };
  }, [allowed, commitHistory, host.data, host.lifecycle, requestIntent, selectionKey]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const projectionPages = useMemo(
    () => yfinancePagesForProjection(current.cursorPages, current.latestHead),
    [current.cursorPages, current.latestHead],
  );
  const projection = useMemo(
    () => projectYfinanceResearchPages(projectionPages),
    [projectionPages],
  );
  const evidencePages = useMemo(
    () => yfinancePagesForEvidence(current.cursorPages, current.latestHead),
    [current.cursorPages, current.latestHead],
  );
  const evidence = useMemo(
    () => yfinanceResearchEvidence(config, evidencePages, projection, current.paginationBlocked),
    [config, evidencePages, projection, current.paginationBlocked],
  );
  const indicators = useMemo(
    () => calculateChartIndicators(projection.bars, config.indicators),
    [projection.bars, config.indicators],
  );
  const setSurface = useCallback((handle: ChartSurfaceHandle | null) => {
    surfaceRef.current = handle;
    setSurfaceReady(handle !== null);
  }, []);
  const chartSymbol = request?.symbol ?? config.symbol;
  const exportPng = useCallback(async () => {
    const surface = surfaceRef.current;
    if (!evidence || projection.bars.length === 0 || !surface) return;
    try {
      const chartCanvas = surface.takeScreenshot();
      const labeledCanvas = composeChartPngCanvas(chartCanvas, chartSymbol || "Yahoo", evidence);
      await downloadChartPng(chartExportFilename(chartSymbol || "Yahoo", "png"), labeledCanvas);
      setExportError(null);
    } catch {
      setExportError("PNG export could not be created in this browser.");
    }
  }, [chartSymbol, evidence, projection.bars.length]);

  const updateConfig = useCallback(
    <K extends keyof YfinanceResearchConfigV1>(key: K, value: YfinanceResearchConfigV1[K]) => {
      onConfigChange({ ...config, [key]: value });
    },
    [config, onConfigChange],
  );

  const toggleIndicator = useCallback(
    (indicator: IndicatorId, enabled: boolean) => {
      const indicators = enabled
        ? [...config.indicators, indicator]
        : config.indicators.filter((item) => item !== indicator);
      updateConfig("indicators", [...new Set(indicators)]);
    },
    [config.indicators, updateConfig],
  );

  const loadOlder = useCallback(() => {
    const lastPage = current.cursorPages.at(-1);
    const cursor = lastPage?.response.next_cursor ?? null;
    if (
      !request ||
      !lastPage ||
      !cursor ||
      !canLoadOlderPages(current.cursorPages, current.paginationBlocked) ||
      current.loadingOlder
    )
      return;
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    activeRequest.current?.abort();
    activeRequest.current = controller;
    // A cursor is bound to the exact original page window, even if the head
    // snapshot has since moved to a newer server-resolved daily window.
    const pageRequest: YfinanceResearchInput = buildYfinanceOlderPageInput(lastPage, cursor);
    commitHistory({ ...current, loadingOlder: true, error: null });
    void host.data
      .read("research.yahoo.daily", pageRequest, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted || requestGenerationRef.current !== generation) return;
        const response = parseYfinanceResearchResponse(value, pageRequest);
        if (!response) {
          updateHistory((state) =>
            state.selectionKey === selectionKey
              ? {
                  ...state,
                  loadingOlder: false,
                  paginationBlocked: true,
                  error: "The older Yahoo page did not match its requested cursor and window.",
                }
              : state,
          );
          return;
        }
        const page: YfinanceResearchPage = { request: pageRequest, response };
        const loop =
          response.next_cursor !== null &&
          isYfinanceCursorLoop([...current.cursorPages, page], response.next_cursor);
        updateHistory((state) =>
          state.selectionKey === selectionKey
            ? {
                ...state,
                status: "ready",
                cursorPages: Object.freeze([...state.cursorPages, page]),
                loadingOlder: false,
                paginationBlocked: loop,
                error: null,
                snapshotBehavior: yfinanceSnapshotBehavior("prepend"),
              }
            : state,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted && requestGenerationRef.current === generation) {
          updateHistory((state) =>
            state.selectionKey === selectionKey
              ? { ...state, loadingOlder: false, error: "The older Yahoo page is unavailable." }
              : state,
          );
        }
      })
      .finally(() => {
        lifecycle.signal.removeEventListener("abort", abort);
        if (activeRequest.current === controller) activeRequest.current = null;
      });
  }, [commitHistory, current, host.data, host.lifecycle, request, selectionKey, updateHistory]);

  const olderAvailable = canLoadOlderPages(current.cursorPages, current.paginationBlocked);

  if (fullAuth.runtimeMode !== "research") {
    const symbol = request?.symbol ?? config.symbol;
    const researchHref =
      typeof window === "undefined"
        ? null
        : buildYahooResearchPageHref(fullAuth.researchOrigin, symbol, window.location.hostname);
    return (
      <section
        className={styles.widget}
        aria-label="Yahoo daily research history"
        data-testid="yahoo-daily-research-widget"
      >
        <header className={styles.header}>
          <div>
            <h2>Yahoo daily research</h2>
            <p>Yahoo history is served by a separately isolated Research runtime.</p>
          </div>
        </header>
        {researchHref ? (
          <p className={styles.empty}>
            <a href={researchHref} data-testid="yahoo-research-portal-link">
              Open isolated Research chart for {symbol}
            </a>
          </p>
        ) : (
          <p className={styles.empty} data-testid="yahoo-research-portal-unavailable">
            The isolated Research hostname is not configured for this terminal session.
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      className={styles.widget}
      aria-label="Yahoo daily research history"
      data-testid="yahoo-daily-research-widget"
    >
      <header className={styles.header}>
        <div>
          <h2>Daily research history</h2>
          <p>
            Yahoo observations are separate from Core/SIP history and are never execution inputs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setAnchorNow(Date.now());
            setRefreshRevision((revision) => revision + 1);
          }}
          disabled={!request || current.status === "loading"}
        >
          Refresh
        </button>
      </header>
      <fieldset className={styles.controls}>
        <legend className={styles.visuallyHidden}>Yahoo daily history controls</legend>
        <label className={styles.control}>
          <span>Symbol</span>
          <input
            aria-label="Yahoo symbol"
            value={config.symbol}
            maxLength={12}
            placeholder={inputs.symbol ?? "AAPL"}
            onChange={(event) => updateConfig("symbol", event.currentTarget.value.toUpperCase())}
          />
        </label>
        <label className={styles.control}>
          <span>Asset class</span>
          <select
            value={config.assetClass}
            onChange={(event) =>
              updateConfig("assetClass", event.currentTarget.value as "stock" | "etf")
            }
          >
            <option value="stock">Stock</option>
            <option value="etf">ETF</option>
          </select>
        </label>
        <label className={styles.control}>
          <span>Daily window</span>
          <select
            value={config.range}
            onChange={(event) =>
              updateConfig("range", event.currentTarget.value as YfinanceResearchConfigV1["range"])
            }
          >
            {YFINANCE_RESEARCH_RANGES.map((range) => (
              <option value={range} key={range}>
                {range}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span>Adjustment request</span>
          <select
            value={config.adjustment}
            onChange={(event) =>
              updateConfig("adjustment", event.currentTarget.value as "unadjusted" | "adjusted")
            }
          >
            <option value="unadjusted">Unadjusted</option>
            <option value="adjusted">Adjusted</option>
          </select>
        </label>
        <label className={styles.control}>
          <span>Chart style</span>
          <select
            value={config.style}
            onChange={(event) =>
              updateConfig("style", event.currentTarget.value as YfinanceResearchConfigV1["style"])
            }
          >
            {["candles", "bars", "line", "area"].map((style) => (
              <option value={style} key={style}>
                {style}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span>
            <input
              type="checkbox"
              checked={config.showVolume}
              onChange={(event) => updateConfig("showVolume", event.currentTarget.checked)}
            />{" "}
            Show volume
          </span>
        </label>
        <fieldset className={styles.indicatorChoices}>
          <legend>Indicators</legend>
          {CHART_INDICATORS.map((indicator) => (
            <label key={indicator}>
              <input
                type="checkbox"
                checked={config.indicators.includes(indicator)}
                data-testid={`yahoo-indicator-${indicator.toLowerCase()}`}
                onChange={(event) => toggleIndicator(indicator, event.currentTarget.checked)}
              />
              {indicator}
            </label>
          ))}
        </fieldset>
      </fieldset>
      {!allowed ? (
        <p className={styles.empty}>Sign in with research:read to load Yahoo daily observations.</p>
      ) : null}
      {allowed && !request ? (
        <p className={styles.empty}>
          Enter a supported symbol or bind this widget to the active symbol.
        </p>
      ) : null}
      {allowed && current.error ? (
        <p className={styles.error} role="alert">
          {current.error}
        </p>
      ) : null}
      {allowed ? (
        <div data-testid="yahoo-research-chart" data-history-status={current.status}>
          <div className={styles.header}>
            <p className={styles.notice}>Labeled export of loaded Yahoo rows only.</p>
            <button
              type="button"
              onClick={() => void exportPng()}
              disabled={!evidence || projection.bars.length === 0 || !surfaceReady}
              data-testid="native-chart-export-loaded-png"
            >
              Export labeled chart PNG
            </button>
          </div>
          {exportError ? (
            <p role="alert" data-testid="yahoo-chart-export-error">
              {exportError}
            </p>
          ) : null}
          <ChartSurface
            symbol={chartSymbol || "Yahoo"}
            identity={selectionKey}
            bars={projection.bars}
            indicators={indicators}
            style={config.style}
            enabledIndicators={config.indicators}
            showVolume={config.showVolume}
            timeVisible={false}
            evidence={evidence}
            status={
              current.status === "error"
                ? "error"
                : current.status === "loading"
                  ? "loading"
                  : current.status === "ready"
                    ? "ready"
                    : "idle"
            }
            statusMessage={current.error ?? undefined}
            notice="Yahoo daily only · provider adjustment semantics are unconfirmed · binary-float display projection."
            emptyMessage="No validated Yahoo daily bars are available for this window."
            snapshotBehavior={current.snapshotBehavior}
            olderPageTestId="yahoo-research-load-older"
            olderPageAvailable={olderAvailable}
            olderPageLoading={current.loadingOlder}
            onRequestOlder={loadOlder}
            onSurfaceReady={setSurface}
          />
        </div>
      ) : null}
    </section>
  );
}
