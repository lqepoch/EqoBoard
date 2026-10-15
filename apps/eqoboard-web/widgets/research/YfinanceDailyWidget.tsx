"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateChartIndicators, ChartSurface } from "@/charts";
import { CHART_INDICATORS, type IndicatorId } from "@/charts/types";
import type { NativeDataOperationMap } from "@/features/data/operations";
import {
  buildYfinanceResearchInput,
  buildYahooResearchPageHref,
  canLoadOlderPages,
  isYfinanceCursorLoop,
  parseYfinanceResearchResponse,
  projectYfinanceResearchPages,
  YFINANCE_RESEARCH_RANGES,
  yfinanceResearchEvidence,
  type YfinanceResearchConfigV1,
  type YfinanceResearchPage,
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
  requestKey: string;
  status: "idle" | "loading" | "ready" | "error";
  pages: readonly YfinanceResearchPage[];
  loadingOlder: boolean;
  paginationBlocked: boolean;
  error: string | null;
}>;

function emptyState(requestKey: string, status: HistoryState["status"] = "idle"): HistoryState {
  return {
    requestKey,
    status,
    pages: [],
    loadingOlder: false,
    paginationBlocked: false,
    error: null,
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
  const [history, setHistory] = useState<HistoryState>(() => emptyState(""));
  const activeRequest = useRef<AbortController | null>(null);
  const allowed =
    fullAuth.runtimeMode === "research" &&
    fullAuth.authenticated &&
    fullAuth.permissions.includes("research:read") &&
    host.auth.authenticated &&
    host.auth.permissions.includes("research:read");
  const request = useMemo(
    () => buildYfinanceResearchInput(config, inputs.symbol, anchorNow),
    [config, inputs.symbol, anchorNow],
  );
  const requestKey = request ? JSON.stringify(request) : "invalid-request";
  const current =
    history.requestKey === requestKey
      ? history
      : emptyState(requestKey, request ? "loading" : "idle");

  useEffect(() => {
    if (!allowed || !request) {
      setHistory(emptyState(requestKey));
      return;
    }
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) {
      setHistory(emptyState(requestKey));
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setHistory(emptyState(requestKey, "loading"));
    void host.data
      .read("research.yahoo.daily", request, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const response = parseYfinanceResearchResponse(value, request);
        if (!response) {
          setHistory({
            ...emptyState(requestKey, "error"),
            error: "Yahoo returned a response outside the validated daily research contract.",
          });
          return;
        }
        setHistory({
          ...emptyState(requestKey, "ready"),
          pages: Object.freeze([{ request, response }]),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistory({
            ...emptyState(requestKey, "error"),
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
  }, [allowed, host.data, host.lifecycle, request, requestKey]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const projection = useMemo(() => projectYfinanceResearchPages(current.pages), [current.pages]);
  const evidence = useMemo(
    () => yfinanceResearchEvidence(config, current.pages, projection, current.paginationBlocked),
    [config, current.pages, projection, current.paginationBlocked],
  );
  const indicators = useMemo(
    () => calculateChartIndicators(projection.bars, config.indicators),
    [projection.bars, config.indicators],
  );

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
    const lastPage = current.pages.at(-1);
    const cursor = lastPage?.response.next_cursor ?? null;
    if (
      !request ||
      !cursor ||
      !canLoadOlderPages(current.pages, current.paginationBlocked) ||
      current.loadingOlder
    )
      return;
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    activeRequest.current?.abort();
    activeRequest.current = controller;
    const pageRequest: YfinanceResearchInput = Object.freeze({ ...request, cursor });
    setHistory({ ...current, loadingOlder: true, error: null });
    void host.data
      .read("research.yahoo.daily", pageRequest, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const response = parseYfinanceResearchResponse(value, pageRequest);
        if (!response) {
          setHistory((state) =>
            state.requestKey === requestKey
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
          isYfinanceCursorLoop([...current.pages, page], response.next_cursor);
        setHistory((state) =>
          state.requestKey === requestKey
            ? {
                ...state,
                status: "ready",
                pages: Object.freeze([...state.pages, page]),
                loadingOlder: false,
                paginationBlocked: loop,
                error: null,
              }
            : state,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistory((state) =>
            state.requestKey === requestKey
              ? { ...state, loadingOlder: false, error: "The older Yahoo page is unavailable." }
              : state,
          );
        }
      })
      .finally(() => {
        lifecycle.signal.removeEventListener("abort", abort);
        if (activeRequest.current === controller) activeRequest.current = null;
      });
  }, [current, host.data, host.lifecycle, request, requestKey]);

  const olderAvailable = canLoadOlderPages(current.pages, current.paginationBlocked);

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
          onClick={() => setAnchorNow(Date.now())}
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
          <ChartSurface
            symbol={(request?.symbol ?? config.symbol) || "Yahoo"}
            identity={requestKey}
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
            snapshotBehavior="reset"
            olderPageAvailable={olderAvailable}
            olderPageLoading={current.loadingOlder}
            onRequestOlder={loadOlder}
          />
        </div>
      ) : null}
    </section>
  );
}
