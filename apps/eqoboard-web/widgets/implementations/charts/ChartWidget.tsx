"use client";

/*
 * Chart controls and history lifecycle are independently reimplemented from
 * EqoBoard's MIT-licensed chart widget at web/components/widgets/ChartWidget.tsx (source commit
 * fea1e952add7a11e799d6f9f198ddcee47fd12b6). See charts/NOTICE.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChartSurface, calculateChartIndicators } from "../../../charts";
import { mergeHeadRefresh, mergeOlderPage } from "../../../charts/history";
import {
  buildChartCsv,
  chartExportFilename,
  composeChartPngCanvas,
  downloadChartCsv,
  downloadChartPng,
} from "../../../charts/export";
import { decodeCoreBarsPage, type DecodedCoreBarsPage } from "../../../charts/core-bars";
import type { SnapshotBehavior } from "../../../charts/controller";
import {
  buildCoreBarsReadInput,
  chartRefreshIntervalMs,
  chartSelectionKey,
  coreBarsPageMatchesInput,
  coreBarsWindowKey,
  MAX_HISTORY_PAGES,
  usableContinuationCursor,
} from "../../../charts/request";
import type { ChartSurfaceHandle, ChartSurfaceStatus } from "../../../charts/ChartSurface";
import type { ChartDisplayEvidence, ChartPlotBar, IndicatorId } from "../../../charts/types";
import type { TradeMinuteBarV1 } from "../../../features/market/mdp-archive";
import type { CoreBarsReadInput } from "../../../features/data/operations";
import type { NativeChartOperationMap } from "../../../charts/native-operations";
import type { BarsResponseV1, BarRowV1 } from "@lqepoch/trading-core-contracts";
import type { WidgetProps } from "../../../widgets/sdk/contracts";
import type { WidgetNoActionMap } from "../../../widgets/sdk/actions";
import type { MarketHostSnapshot } from "../../../stores/market/market-store";
import {
  CHART_ADJUSTMENTS,
  CHART_SESSION_SCOPES,
  type ChartAdjustment,
  type ChartSessionScope,
  type NativeChartConfigV1,
} from "./config";
import { isDiagnosticDatasetId } from "./config";
import { useDiagnosticArchive } from "./use-diagnostic-archive";

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const HISTORY_ONLY_NOTICE = "HISTORY ONLY · No live bar updates or candle corrections are available.";
const DIAGNOSTIC_ONLY_NOTICE = "MDP DIAGNOSTIC ARCHIVE · NOT LIVE · NONCANONICAL · promotion unavailable; this is one fixed diagnostic window.";

type ChartPageResponse = BarsResponseV1;
type HistoryPage = DecodedCoreBarsPage;

type ChartHistoryState = Readonly<{
  status: ChartSurfaceStatus;
  selectionKey: string | null;
  windowKey: string | null;
  pages: readonly HistoryPage[];
  bars: readonly ChartPlotBar<BarRowV1>[];
  nextCursor: string | null;
  paginationBlocked: boolean;
  olderLoading: boolean;
  snapshotBehavior: SnapshotBehavior;
  error: string | null;
  notice: string | null;
}>;

const EMPTY_HISTORY: ChartHistoryState = Object.freeze({
  status: "idle",
  selectionKey: null,
  windowKey: null,
  pages: [],
  bars: [],
  nextCursor: null,
  paginationBlocked: false,
  olderLoading: false,
  snapshotBehavior: "reset",
  error: null,
  notice: null,
});

function responseCursor(page: HistoryPage): string | null {
  const response = page.response as ChartPageResponse;
  return response.truncated && usableContinuationCursor(response.continuationCursor)
    ? response.continuationCursor
    : null;
}

function mergePageEvidence(pages: readonly HistoryPage[], state: ChartHistoryState): ChartDisplayEvidence | null {
  const head = pages[0];
  if (!head) return null;

  const values = (select: (page: HistoryPage) => string): string[] =>
    [...new Set(pages.map(select).filter((value) => value !== "unknown"))];
  const combine = (items: string[]): string => items.length === 0 ? "unknown" : items.length === 1 ? items[0]! : "mixed";
  const responses = pages.map((page) => page.response as ChartPageResponse);
  const anyUnknownCoverage = responses.some((response) => response.coverageStatus === "unknown");
  const incompleteCoverage = responses.some((response) => response.coverageStatus !== "complete") ||
    pages.some((page) => page.projection.rejectedRows > 0);
  const pageLimitReached = pages.length >= MAX_HISTORY_PAGES && state.nextCursor !== null;
  const completeness = anyUnknownCoverage
    ? "unknown"
    : incompleteCoverage || state.nextCursor !== null || state.paginationBlocked || pageLimitReached
      ? "partial"
      : "complete";
  const precision = pages.every((page) => page.evidence.precision === "exact-decimal")
    ? "exact-decimal"
    : pages.every((page) => page.evidence.precision === "provider-float")
      ? "provider-float"
      : "unknown";
  const totalSegments = responses.reduce((sum, response) => sum + response.segments.length, 0);
  const totalGaps = responses.reduce((sum, response) => sum + response.gaps.length, 0);
  const unresolvedTruncation = responses.some((response) => response.truncated) && state.nextCursor !== null;
  const request = head.envelope.request;
  const continuation = pageLimitReached
    ? `history page cap reached (${MAX_HISTORY_PAGES})`
    : state.paginationBlocked
      ? "pagination unavailable or stopped by response/cursor validation"
      : state.nextCursor
        ? "older history is available by explicit request"
        : unresolvedTruncation
          ? "truncated response has no usable continuation cursor"
          : "no continuation cursor returned";

  return {
    ...head.evidence,
    source: combine(values((page) => page.evidence.source)),
    provider: combine(values((page) => page.evidence.provider)),
    feed: combine(values((page) => page.evidence.feed)),
    effectiveResolution: combine(values((page) => page.evidence.effectiveResolution)),
    completeness,
    precision,
    requestedWindow: `${request.range} · ${request.request_start} → ${request.request_end}`,
    coverage: `${combine(responses.map((response) => response.coverageStatus))}; ${totalSegments} segments and ${totalGaps} gaps across ${pages.length} page(s); ${state.bars.length} distinct rows loaded; ${continuation}`,
    evidence: [
      ...head.evidence.evidence,
      { label: "Loaded history pages", value: String(pages.length) },
      { label: "Loaded distinct rows", value: String(state.bars.length) },
      { label: "History refresh", value: "host-scheduled history snapshots; existing candle values are retained" },
      { label: "Bar stream", value: "unavailable; no live bar update or correction contract" },
    ],
  };
}

function requestError(code: "rate-limited" | "request-failed"): string {
  return code === "rate-limited"
    ? "History refresh is rate limited. The last validated snapshot remains visible."
    : "History could not be refreshed. The last validated snapshot remains visible.";
}

function validDecodedPage(value: unknown, input: CoreBarsReadInput): HistoryPage | null {
  const page = decodeCoreBarsPage(value);
  if (!page || !coreBarsPageMatchesInput(page, input)) return null;
  return page;
}

function uniquePages(pages: readonly HistoryPage[], next: HistoryPage): readonly HistoryPage[] {
  const cursor = next.envelope.request.cursor;
  const priorIndex = pages.findIndex((page) => page.envelope.request.cursor === cursor);
  if (priorIndex < 0) return [...pages, next];
  return pages.map((page, index) => index === priorIndex ? next : page);
}

function nextUnloadedCursor(cursor: string | null, pages: readonly HistoryPage[]): Readonly<{ cursor: string | null; blocked: boolean }> {
  let current = cursor;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) return { cursor: current, blocked: true };
    visited.add(current);
    const loaded = pages.find((page) => page.envelope.request.cursor === current);
    if (!loaded) return { cursor: current, blocked: false };
    const next = responseCursor(loaded);
    if (next === current) return { cursor: current, blocked: true };
    current = next;
  }
  return { cursor: null, blocked: false };
}

export type NativeChartWidgetProps = WidgetProps<
  NativeChartConfigV1,
  NativeChartOperationMap,
  WidgetNoActionMap,
  MarketHostSnapshot
>;

function selectionTransition(previous: string | null, next: string | null): SnapshotBehavior {
  if (!previous || !next) return "reset";
  try {
    const oldParts = JSON.parse(previous) as unknown;
    const newParts = JSON.parse(next) as unknown;
    if (!Array.isArray(oldParts) || !Array.isArray(newParts)) return "reset";
    // Symbol/range/resolution changes use another coordinate domain. Changing
    // request preferences can switch source while retaining the zoom selection.
    return oldParts.slice(0, 3).every((part, index) => part === newParts[index]) ? "preserve" : "reset";
  } catch {
    return "reset";
  }
}

export function ChartWidget({ config, inputs, host, onConfigChange }: NativeChartWidgetProps) {
  const symbol = inputs.symbol ?? "";
  const validSymbol = SYMBOL.test(symbol);
  const [diagnosticDraftState, setDiagnosticDraftState] = useState(() => ({
    configValue: config.diagnosticDatasetId,
    value: config.diagnosticDatasetId ?? "",
  }));
  const diagnosticDraft = diagnosticDraftState.configValue === config.diagnosticDatasetId
    ? diagnosticDraftState.value
    : config.diagnosticDatasetId ?? "";
  const [diagnosticSubmission, setDiagnosticSubmission] = useState<Readonly<{
    configValue: string | null;
    datasetId: string;
  }> | null>(null);
  const diagnosticDatasetId = diagnosticSubmission?.configValue === config.diagnosticDatasetId
    ? diagnosticSubmission.datasetId
    : config.diagnosticDatasetId;
  const [diagnosticRetryRevision, setDiagnosticRetryRevision] = useState(0);
  const [diagnosticFormError, setDiagnosticFormError] = useState<string | null>(null);
  const input = useMemo(
    () => validSymbol ? buildCoreBarsReadInput(symbol, config) : null,
    [validSymbol, symbol, config.range, config.resolution, config.assetClass, config.sessionScope,
      config.adjustment, config.providerPreference, config.allowDailyDowngrade],
  );
  const selectionKey = input ? chartSelectionKey(input) : null;
  const [history, setHistory] = useState<ChartHistoryState>(EMPTY_HISTORY);
  const historyRef = useRef(history);
  const activeRequestRef = useRef<AbortController | null>(null);
  const activeCursorKeyRef = useRef<string | null>(null);
  const cursorHistoryRef = useRef(new Set<string>());
  const surfaceRef = useRef<ChartSurfaceHandle | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const diagnostic = useDiagnosticArchive(
    config.dataMode === "diagnostic-archive",
    symbol,
    diagnosticDatasetId,
    diagnosticRetryRevision,
    host,
  );
  const displayedHistory: ChartHistoryState = history.selectionKey === selectionKey
    ? history
    : {
        ...EMPTY_HISTORY,
        status: input ? "loading" : "idle",
        selectionKey,
        snapshotBehavior: selectionTransition(history.selectionKey, selectionKey),
      };

  const commitHistory = useCallback((next: ChartHistoryState) => {
    historyRef.current = next;
    setHistory(next);
  }, []);
  const cancelOlderRead = useCallback(() => {
    const activeCursorKey = activeCursorKeyRef.current;
    if (activeCursorKey) cursorHistoryRef.current.delete(activeCursorKey);
    activeCursorKeyRef.current = null;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
  }, []);

  useEffect(() => {
    cancelOlderRead();
    cursorHistoryRef.current = new Set();
    if (config.dataMode !== "core-bars") {
      commitHistory({
        ...EMPTY_HISTORY,
        status: "idle",
        selectionKey: null,
        snapshotBehavior: "reset",
      });
      return undefined;
    }
    commitHistory({
      ...EMPTY_HISTORY,
      status: input ? "loading" : "idle",
      selectionKey,
      snapshotBehavior: selectionTransition(historyRef.current.selectionKey, selectionKey),
      error: null,
    });
    if (!input || !selectionKey) return undefined;

    let active = true;
    const unsubscribe = host.refresh.observe(
      "market.history.core-bars",
      input,
      { refreshIntervalMs: chartRefreshIntervalMs(config.range) },
      (scheduled) => {
        if (!active) return;
        const current = historyRef.current;
        if (scheduled.status === "pending") {
          commitHistory({
            ...current,
            status: "loading",
            snapshotBehavior: current.bars.length > 0 ? "refresh" : current.snapshotBehavior,
            error: null,
          });
          return;
        }
        if (scheduled.status === "error") {
          const message = requestError(scheduled.code);
          commitHistory({
            ...current,
            status: current.bars.length ? "ready" : "error",
            error: message,
            notice: message,
          });
          return;
        }

        const page = validDecodedPage(scheduled.value, input);
        if (!page) {
          const message = "The history response did not match the selected request or Core Bars V1 contract.";
          commitHistory({
            ...current,
            status: current.bars.length ? "ready" : "error",
            error: message,
            notice: message,
          });
          return;
        }

        const windowKey = coreBarsWindowKey(page.envelope.request);
        const incomingCursor = responseCursor(page);
        if (current.selectionKey !== selectionKey || current.windowKey === null) {
          cancelOlderRead();
          cursorHistoryRef.current = new Set();
          commitHistory({
            status: "ready", selectionKey, windowKey, pages: [page], bars: page.projection.bars,
            nextCursor: incomingCursor, paginationBlocked: Boolean(page.response.truncated && !incomingCursor),
            olderLoading: false, snapshotBehavior: current.snapshotBehavior, error: null,
            notice: page.response.truncated && !incomingCursor
              ? "The response is truncated but supplied no usable continuation cursor."
              : null,
          });
          return;
        }

        const sameWindow = current.windowKey === windowKey;
        const oldHeadCursor = current.pages[0] ? responseCursor(current.pages[0]) : null;
        const cursorChainChanged = sameWindow && current.pages.length > 1 && oldHeadCursor !== incomingCursor;
        cancelOlderRead();
        if (!sameWindow || cursorChainChanged) cursorHistoryRef.current = new Set();
        const nextPages = sameWindow && !cursorChainChanged ? uniquePages(current.pages, page) : [page];
        const retainedRows = sameWindow && !cursorChainChanged ? current.bars : [];
        const bars = mergeHeadRefresh(retainedRows, page.projection.bars);
        const cursorResult = nextUnloadedCursor(cursorChainChanged || !sameWindow || current.pages.length <= 1
          ? incomingCursor
          : current.nextCursor, nextPages);
        const nextCursor = cursorResult.cursor;
        commitHistory({
          status: "ready",
          selectionKey,
          windowKey,
          pages: nextPages,
          bars,
          nextCursor,
          paginationBlocked: cursorResult.blocked || Boolean(page.response.truncated && !incomingCursor),
          olderLoading: false,
          snapshotBehavior: !sameWindow || cursorChainChanged ? "reset" : "refresh",
          error: null,
          notice: !sameWindow && current.pages.length > 1
            ? "The server resolved a new history window; older cursor pages were cleared."
            : cursorChainChanged
              ? "The server refreshed its continuation cursor; pagination will continue from the newest page."
              : page.response.truncated && !incomingCursor
                ? "The response is truncated but supplied no usable continuation cursor."
                : null,
        });
      },
    );

    return () => {
      active = false;
      unsubscribe();
      cancelOlderRead();
    };
  }, [cancelOlderRead, commitHistory, config.dataMode, config.range, host.refresh, input, selectionKey]);

  useEffect(() => () => cancelOlderRead(), [cancelOlderRead]);

  const loadOlder = useCallback(async () => {
    const current = historyRef.current;
    if (config.dataMode !== "core-bars" || !input || !selectionKey || current.selectionKey !== selectionKey || current.olderLoading ||
        !current.nextCursor || current.paginationBlocked) return;
    if (current.pages.length >= MAX_HISTORY_PAGES) {
      commitHistory({ ...current, notice: `The chart has reached its ${MAX_HISTORY_PAGES}-page history limit.` });
      return;
    }
    const head = current.pages[0];
    if (!head) return;
    const cursor = current.nextCursor;
    const windowKey = current.windowKey;
    const cursorKey = `${windowKey}|${cursor}`;
    if (cursorHistoryRef.current.has(cursorKey)) {
      commitHistory({ ...current, paginationBlocked: true, notice: "A repeated history cursor was blocked." });
      return;
    }
    cancelOlderRead();
    cursorHistoryRef.current.add(cursorKey);

    const requestInput = {
      ...input,
      request_start: head.envelope.request.request_start,
      request_end: head.envelope.request.request_end,
      cursor,
    } as const;
    const abortController = new AbortController();
    const lifecycleSignal = host.lifecycle.getSnapshot().signal;
    const abortForLifecycle = () => abortController.abort();
    if (lifecycleSignal.aborted) abortController.abort();
    else lifecycleSignal.addEventListener("abort", abortForLifecycle, { once: true });
    activeRequestRef.current = abortController;
    activeCursorKeyRef.current = cursorKey;
    commitHistory({ ...current, olderLoading: true, error: null });

    try {
      const raw = await host.data.read("market.history.core-bars", requestInput, { signal: abortController.signal });
      const afterRead = historyRef.current;
      if (abortController.signal.aborted || afterRead.selectionKey !== selectionKey) return;
      if (afterRead.windowKey !== windowKey || afterRead.nextCursor !== cursor) {
        commitHistory({ ...afterRead, olderLoading: false });
        return;
      }
      const page = validDecodedPage(raw, requestInput);
      if (!page || coreBarsWindowKey(page.envelope.request) !== windowKey) {
        commitHistory({
          ...afterRead, olderLoading: false, paginationBlocked: true,
          notice: "The older page did not echo the active history window and cursor; pagination stopped.",
        });
        return;
      }

      const latest = historyRef.current;
      const pages = uniquePages(latest.pages, page);
      const bars = mergeOlderPage(latest.bars, page.projection.bars);
      const returnedCursor = responseCursor(page);
      const returnedCursorKey = returnedCursor ? `${windowKey}|${returnedCursor}` : null;
      const repeatedCursor = returnedCursorKey !== null && cursorHistoryRef.current.has(returnedCursorKey);
      const cursorResult = repeatedCursor
        ? { cursor: returnedCursor, blocked: true }
        : nextUnloadedCursor(returnedCursor, pages);
      const nextCursor = cursorResult.cursor;
      commitHistory({
        ...latest,
        status: "ready",
        pages,
        bars,
        nextCursor,
        paginationBlocked: cursorResult.blocked || Boolean(page.response.truncated && !returnedCursor),
        olderLoading: false,
        snapshotBehavior: "prepend",
        error: null,
        notice: repeatedCursor
          ? "The server returned a repeated history cursor; further pagination was stopped."
          : page.response.truncated && !returnedCursor
            ? "The response is truncated but supplied no usable continuation cursor."
            : null,
      });
    } catch {
      if (!abortController.signal.aborted) {
        cursorHistoryRef.current.delete(cursorKey);
        const latest = historyRef.current;
        const message = "Older history could not be loaded. Existing validated rows remain visible.";
        commitHistory({ ...latest, olderLoading: false, error: message, notice: message });
      }
    } finally {
      lifecycleSignal.removeEventListener("abort", abortForLifecycle);
      const ownsRequest = activeRequestRef.current === abortController;
      if (ownsRequest) {
        activeRequestRef.current = null;
        if (activeCursorKeyRef.current === cursorKey) activeCursorKeyRef.current = null;
      }
      if (ownsRequest && historyRef.current.olderLoading && abortController.signal.aborted) {
        cursorHistoryRef.current.delete(cursorKey);
        commitHistory({ ...historyRef.current, olderLoading: false });
      }
    }
  }, [cancelOlderRead, commitHistory, config.dataMode, host.data, host.lifecycle, input, selectionKey]);

  const evidence = useMemo(() => mergePageEvidence(displayedHistory.pages, displayedHistory), [displayedHistory]);
  const activeIsCore = config.dataMode === "core-bars";
  const diagnosticData = diagnostic.data;
  const diagnosticBars = diagnosticData && diagnosticData.projection.rejectedRows === 0 ? diagnosticData.bars : [];
  const activeBars: readonly ChartPlotBar<BarRowV1 | TradeMinuteBarV1>[] = activeIsCore
    ? displayedHistory.bars
    : diagnosticBars;
  const activeEvidence = activeIsCore ? evidence : diagnosticData?.evidence ?? null;
  const activeStatus = activeIsCore ? displayedHistory.status : diagnostic.status;
  const indicators = useMemo(
    () => calculateChartIndicators(activeBars, config.indicators),
    [activeBars, config.indicators],
  );
  const setSurface = useCallback((handle: ChartSurfaceHandle | null) => {
    surfaceRef.current = handle;
  }, []);
  const updateConfig = useCallback((patch: Partial<NativeChartConfigV1>) => {
    onConfigChange({ ...config, ...patch });
  }, [config, onConfigChange]);
  const toggleIndicator = useCallback((indicator: IndicatorId, checked: boolean) => {
    const indicators = checked
      ? [...config.indicators, indicator]
      : config.indicators.filter((current) => current !== indicator);
    updateConfig({ indicators });
  }, [config.indicators, updateConfig]);
  const submitDiagnosticDataset = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const datasetId = diagnosticDraft.trim();
    if (!isDiagnosticDatasetId(datasetId)) {
      setDiagnosticFormError("Use a dataset ID containing 1–128 letters, digits, dots, underscores, or hyphens; it must start with a letter or digit.");
      return;
    }
    setDiagnosticFormError(null);
    setDiagnosticSubmission({ configValue: config.diagnosticDatasetId, datasetId });
    updateConfig({ dataMode: "diagnostic-archive", diagnosticDatasetId: datasetId });
    setDiagnosticRetryRevision((revision) => revision + 1);
  }, [config.diagnosticDatasetId, diagnosticDraft, updateConfig]);
  const exportCsv = useCallback(() => {
    if (!activeEvidence || activeBars.length === 0) return;
    const result = buildChartCsv(activeBars, activeEvidence);
    downloadChartCsv(chartExportFilename(symbol, "csv"), result.csv);
    setExportError(null);
  }, [activeBars, activeEvidence, symbol]);
  const exportPng = useCallback(async () => {
    if (!activeEvidence || activeBars.length === 0 || !surfaceRef.current) return;
    try {
      const chartCanvas = surfaceRef.current.takeScreenshot();
      const labeledCanvas = composeChartPngCanvas(chartCanvas, symbol, activeEvidence);
      await downloadChartPng(chartExportFilename(symbol, "png"), labeledCanvas);
      setExportError(null);
    } catch {
      setExportError("PNG export could not be created in this browser.");
    }
  }, [activeBars, activeEvidence, symbol]);

  const pageLimitReached = activeIsCore && displayedHistory.pages.length >= MAX_HISTORY_PAGES && displayedHistory.nextCursor !== null;
  const olderPageAvailable = activeIsCore && Boolean(displayedHistory.nextCursor && !displayedHistory.paginationBlocked && !pageLimitReached);
  const effectiveResolution = displayedHistory.pages[0]?.response.effectiveResolution;
  const effectiveTimeVisible = activeIsCore
    ? effectiveResolution ? effectiveResolution !== "1d" : input?.resolution !== "1d"
    : true;
  const diagnosticStatusMessage = diagnostic.error ?? (!validSymbol
    ? "Select a valid active or fixed symbol before loading a diagnostic archive."
    : !isDiagnosticDatasetId(diagnosticDatasetId)
      ? "Enter a diagnostic dataset ID to load its fixed archive window."
      : diagnostic.status === "loading"
        ? "Loading one bounded MDP diagnostic archive response."
        : diagnostic.status === "ready"
          ? `${diagnosticBars.length.toLocaleString()} diagnostic archive rows loaded; no cursor or pagination is available.`
          : "The diagnostic archive is not loaded.");
  const activeStatusMessage = activeIsCore
    ? displayedHistory.error ?? (!validSymbol
      ? "Select an active or fixed symbol to view historical Core bars."
      : displayedHistory.status === "loading"
        ? "Waiting for a validated Core Bars V1 history response."
        : `${displayedHistory.bars.length.toLocaleString()} validated historical rows loaded.`)
    : diagnosticStatusMessage;
  const activeIdentity = activeIsCore
    ? `${selectionKey ?? "no-symbol"}|${displayedHistory.windowKey ?? "unresolved-window"}`
    : `mdp-diagnostic|${symbol || "no-symbol"}|${diagnosticDatasetId ?? "no-dataset"}`;
  const lastPlottedIdentityRef = useRef<string | null>(null);
  const activeSnapshotBehavior: SnapshotBehavior = activeIsCore
    ? displayedHistory.snapshotBehavior
    : activeBars.length > 0 && lastPlottedIdentityRef.current === activeIdentity ? "preserve" : "reset";
  useEffect(() => {
    lastPlottedIdentityRef.current = activeBars.length > 0 ? activeIdentity : null;
  }, [activeBars.length, activeIdentity]);
  const notice = [
    activeIsCore ? HISTORY_ONLY_NOTICE : DIAGNOSTIC_ONLY_NOTICE,
    activeIsCore ? displayedHistory.notice : diagnostic.error,
    activeIsCore && displayedHistory.error && displayedHistory.bars.length ? displayedHistory.error : null,
    exportError,
  ].filter((value): value is string => Boolean(value)).join(" ");
  const pageCountMessage = `History snapshots refresh through the shared host (${chartRefreshIntervalMs(config.range) / 1_000}s cadence while active); this is not a live bar feed.`;

  return (
    <section className="native-chart-widget" data-testid="native-chart" data-chart-live="false" aria-label={`${symbol || "Unselected symbol"} chart widget`}>
      <header className="native-chart-widget__header">
        <div>
          <h2>{symbol || "Chart"}</h2>
          <p data-testid="native-chart-status">{activeIsCore
            ? "Core Bars V1 · history snapshots · no live bar corrections · finite-number display projection"
            : "MDP diagnostic archive · NOT LIVE · noncanonical · promotion unavailable"}</p>
        </div>
        <div className="native-chart-widget__export">
          <button type="button" onClick={exportCsv} disabled={!activeEvidence || activeBars.length === 0} data-testid="native-chart-export-loaded-csv">
            Export loaded rows CSV
          </button>
          <button type="button" onClick={() => void exportPng()} disabled={!activeEvidence || activeBars.length === 0 || !surfaceRef.current} data-testid="native-chart-export-loaded-png">
            Export labeled chart PNG
          </button>
        </div>
      </header>

      <div className="native-chart-widget__controls" aria-label="Chart settings">
        <div className="native-chart-widget__range" role="group" aria-label="Chart data mode">
          <button type="button" aria-pressed={activeIsCore} onClick={() => updateConfig({ dataMode: "core-bars" })} data-testid="native-chart-mode-core">Core history</button>
          <button type="button" aria-pressed={!activeIsCore} onClick={() => updateConfig({ dataMode: "diagnostic-archive" })} data-testid="native-chart-mode-diagnostic">MDP diagnostic</button>
        </div>

        {activeIsCore ? <div className="native-chart-widget__range" role="group" aria-label="History range">
          {(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const).map((range) => (
            <button
              type="button"
              key={range}
              aria-pressed={config.range === range}
              data-testid={`native-chart-range-${range}`}
              onClick={() => updateConfig({ range })}
            >{range}</button>
          ))}
        </div> : (
          <form className="native-chart-widget__diagnostic-form" noValidate onSubmit={submitDiagnosticDataset} data-testid="native-chart-diagnostic-form">
            <label>
              Diagnostic dataset ID
              <input
                value={diagnosticDraft}
                maxLength={128}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
                required
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(diagnosticFormError)}
                aria-describedby={diagnosticFormError ? "native-chart-diagnostic-form-error" : undefined}
                onChange={(event) => {
                  setDiagnosticDraftState({ configValue: config.diagnosticDatasetId, value: event.currentTarget.value });
                  setDiagnosticFormError(null);
                }}
                data-testid="native-chart-diagnostic-dataset"
              />
            </label>
            <button type="submit" data-testid="native-chart-diagnostic-load">Load fixed diagnostic window</button>
            {diagnosticFormError ? <span id="native-chart-diagnostic-form-error" role="alert">{diagnosticFormError}</span> : null}
          </form>
        )}

        {activeIsCore ? (
          <>
            <label>
              Resolution
              <select value={config.resolution} onChange={(event) => updateConfig({ resolution: event.currentTarget.value as NativeChartConfigV1["resolution"] })} data-testid="native-chart-resolution">
                <option value="auto">Auto</option>
                <option value="1m">1 minute</option>
                <option value="5m">5 minutes</option>
                <option value="15m">15 minutes</option>
                <option value="1h">1 hour</option>
                <option value="1d">1 day</option>
              </select>
            </label>
            <label>
              Asset class
              <select value={config.assetClass} onChange={(event) => updateConfig({ assetClass: event.currentTarget.value as NativeChartConfigV1["assetClass"] })} data-testid="native-chart-asset-class">
                <option value="stock">Stock</option>
                <option value="etf">ETF</option>
              </select>
            </label>
            <label>
              Provider preference
              <select value={config.providerPreference} onChange={(event) => updateConfig({ providerPreference: event.currentTarget.value as NativeChartConfigV1["providerPreference"] })} data-testid="native-chart-provider-mode">
                <option value="auto">Automatic</option>
                <option value="alpaca_only">Alpaca only</option>
                <option value="futu_only">Futu only</option>
              </select>
            </label>
            <label>
              Session scope
              <select value={config.sessionScope} onChange={(event) => updateConfig({ sessionScope: event.currentTarget.value as ChartSessionScope })} data-testid="native-chart-session-scope">
                {CHART_SESSION_SCOPES.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
              </select>
            </label>
            <label>
              Adjustment request
              <select value={config.adjustment} onChange={(event) => updateConfig({ adjustment: event.currentTarget.value as ChartAdjustment })} data-testid="native-chart-adjustment">
                {CHART_ADJUSTMENTS.map((adjustment) => <option key={adjustment} value={adjustment}>{adjustment}</option>)}
              </select>
            </label>
            <label className="native-chart-widget__check">
              <input type="checkbox" checked={config.allowDailyDowngrade} onChange={(event) => updateConfig({ allowDailyDowngrade: event.currentTarget.checked })} data-testid="native-chart-daily-downgrade" />
              Allow daily downgrade
            </label>
          </>
        ) : null}
        <label>
          Style
          <select value={config.style} onChange={(event) => updateConfig({ style: event.currentTarget.value as NativeChartConfigV1["style"] })} data-testid="native-chart-style">
            <option value="candles">Candles</option>
            <option value="bars">OHLC bars</option>
            <option value="line">Line</option>
            <option value="area">Area</option>
          </select>
        </label>
        <label className="native-chart-widget__check">
          <input type="checkbox" checked={config.showVolume} onChange={(event) => updateConfig({ showVolume: event.currentTarget.checked })} data-testid="native-chart-volume" />
          Volume
        </label>
      </div>

      <fieldset className="native-chart-widget__indicators">
        <legend>Indicators</legend>
        {(["SMA20", "SMA50", "SMA200", "EMA20", "VWAP", "RSI", "MACD", "BOLL"] as const).map((indicator) => (
          <label key={indicator}>
            <input
              type="checkbox"
              checked={config.indicators.includes(indicator)}
              onChange={(event) => toggleIndicator(indicator, event.currentTarget.checked)}
              data-testid={`native-chart-indicator-${indicator}`}
            />
            {indicator === "VWAP" ? "VWAP (loaded window)" : indicator === "BOLL" ? "Bollinger (20, 2σ)" : indicator}
          </label>
        ))}
      </fieldset>

      <ChartSurface<BarRowV1 | TradeMinuteBarV1>
        symbol={symbol || "Unselected symbol"}
        identity={activeIdentity}
        bars={activeBars}
        indicators={indicators}
        style={config.style}
        enabledIndicators={config.indicators}
        showVolume={config.showVolume}
        timeVisible={effectiveTimeVisible}
        evidence={activeEvidence}
        status={activeStatus}
        statusMessage={activeStatusMessage}
        notice={notice}
        emptyMessage={activeIsCore
          ? validSymbol ? "No Core Bars V1 history rows were returned for this selection." : activeStatusMessage
          : diagnosticStatusMessage}
        snapshotBehavior={activeSnapshotBehavior}
        olderPageAvailable={olderPageAvailable}
        olderPageLoading={activeIsCore && displayedHistory.olderLoading}
        onRequestOlder={() => void loadOlder()}
        onSurfaceReady={setSurface}
      />

      {pageLimitReached ? <p data-testid="native-chart-history-page-limit">The {MAX_HISTORY_PAGES}-page cap was reached; older rows are not loaded.</p> : null}
      {activeIsCore && displayedHistory.error ? <p role="alert" data-testid="native-chart-history-error">{displayedHistory.error}</p> : null}
      {!activeIsCore && diagnostic.error ? <p role="alert" data-testid="native-chart-diagnostic-error">{diagnostic.error}</p> : null}
      <p className="native-chart-widget__cadence">{activeIsCore
        ? pageCountMessage
        : "The MDP diagnostic archive is a fixed, bounded noncanonical window; it has no cursor, live updates, or candle corrections."}</p>
      <p className="native-chart-widget__precision">Indicators use finite-number display coordinates. Exact decimal strings are shown separately only when the source encoding guarantees decimal or integer tokens; no chart value is an execution input.</p>
    </section>
  );
}
