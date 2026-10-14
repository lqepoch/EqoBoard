"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Candle } from "./api";

export const CHART_RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export type ChartResolution = "1m" | "5m" | "1h" | "1d";
export type ChartProviderMode = "auto" | "alpaca_only" | "futu_only";
export type ChartAssetClass = "stock" | "etf";
export type ExactChartValues = { open: string; high: string; low: string; close: string; volume: string };
export type ChartHistoryCandle = Candle & { exact?: ExactChartValues };

type HistoryBar = {
  time?: unknown;
  bar_start_utc?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
  exact?: unknown;
  [key: string]: unknown;
};

export type ChartHistoryResponse = {
  bars: HistoryBar[];
  source?: unknown;
  source_label?: unknown;
  provider?: unknown;
  feed?: unknown;
  delay?: unknown;
  requested_resolution?: unknown;
  effective_resolution?: unknown;
  downgrade_reason?: unknown;
  resolution?: unknown;
  request_start?: unknown;
  request_end?: unknown;
  continuation_cursor?: unknown;
  next_cursor?: unknown;
  has_more?: unknown;
  truncated?: unknown;
  coverage_status?: unknown;
  coverage?: unknown;
  segments?: unknown;
  gaps?: unknown;
  source_provenance?: unknown;
  verification?: unknown;
  verified_at?: unknown;
  as_of?: unknown;
  asOf?: unknown;
  fetched_at?: unknown;
  cache_status?: unknown;
  [key: string]: unknown;
};

type CursorPageParam = {
  cursor: string;
  requestStart: string;
  requestEnd: string;
};

const MAX_PRICE = 1_000_000_000_000;
const MAX_VOLUME = 1_000_000_000_000_000;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/;
const HISTORY_CACHE_SCOPE = createBrowserCacheScope();

function createBrowserCacheScope(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    // This identifier scopes only the in-memory query cache. It is never sent to the server.
    return `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function resolutionForRange(range: ChartRange): ChartResolution {
  switch (range) {
    case "1D": return "1m";
    case "5D": return "5m";
    case "1M": return "1h";
    default: return "1d";
  }
}

function parseDecimal(value: unknown, maximum: number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= maximum ? value : null;
  }
  if (typeof value !== "string" || value.length > 128 || !DECIMAL.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= maximum ? parsed : null;
}

function parseTime(row: HistoryBar): number | null {
  const candidate = row.time ?? row.bar_start_utc;
  if (typeof candidate === "number") {
    return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
  }
  if (typeof candidate !== "string") return null;
  const milliseconds = Date.parse(candidate);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const seconds = Math.floor(milliseconds / 1_000);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function projectBar(row: HistoryBar): ChartHistoryCandle | null {
  const exactValue = row.exact;
  let exact: ExactChartValues | undefined;
  let open: number | null;
  let high: number | null;
  let low: number | null;
  let close: number | null;
  let volume: number | null;

  if (exactValue !== null && typeof exactValue === "object" && !Array.isArray(exactValue)) {
    const candidate = exactValue as Record<string, unknown>;
    if ([candidate.open, candidate.high, candidate.low, candidate.close, candidate.volume]
      .some((value) => typeof value !== "string")) return null;
    exact = {
      open: candidate.open as string,
      high: candidate.high as string,
      low: candidate.low as string,
      close: candidate.close as string,
      volume: candidate.volume as string,
    };
    open = parseDecimal(exact.open, MAX_PRICE);
    high = parseDecimal(exact.high, MAX_PRICE);
    low = parseDecimal(exact.low, MAX_PRICE);
    close = parseDecimal(exact.close, MAX_PRICE);
    volume = parseDecimal(exact.volume, MAX_VOLUME);
  } else {
    open = parseDecimal(row.open, MAX_PRICE);
    high = parseDecimal(row.high, MAX_PRICE);
    low = parseDecimal(row.low, MAX_PRICE);
    close = parseDecimal(row.close, MAX_PRICE);
    volume = parseDecimal(row.volume, MAX_VOLUME);
  }

  const time = parseTime(row);
  if ([open, high, low, close, volume].some((value) => value === null) || time === null || volume! < 0) return null;
  if (high! < Math.max(open!, close!, low!) || low! > Math.min(open!, close!, high!)) return null;
  return { time, open: open!, high: high!, low: low!, close: close!, volume: volume!, ...(exact ? { exact } : {}) };
}

function assertResponseShape(payload: unknown): ChartHistoryResponse {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("History response is not an object");
  }
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.bars)) throw new Error("History response has no bars array");
  return body as ChartHistoryResponse;
}

async function fetchHistoryPage(
  symbol: string,
  range: ChartRange,
  resolution: ChartResolution,
  providerMode: ChartProviderMode,
  assetClass: ChartAssetClass,
  pageParam: CursorPageParam | null,
  signal: AbortSignal,
): Promise<ChartHistoryResponse> {
  const query = new URLSearchParams({
    range,
    resolution,
    provider_mode: providerMode,
    asset_class: assetClass,
    session_scope: "all",
    adjustment: "unadjusted",
    allow_daily_downgrade: "true",
  });
  if (pageParam) {
    query.set("request_start", pageParam.requestStart);
    query.set("request_end", pageParam.requestEnd);
    query.set("cursor", pageParam.cursor);
  }
  const response = await fetch(`/api/history/${encodeURIComponent(symbol)}?${query.toString()}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
    const reason = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return assertResponseShape(await response.json());
}

function responseResolution(response: ChartHistoryResponse): string | null {
  return typeof response.effective_resolution === "string" ? response.effective_resolution : null;
}

function requestCursor(response: ChartHistoryResponse): CursorPageParam | undefined {
  const cursor = typeof response.continuation_cursor === "string"
    ? response.continuation_cursor
    : typeof response.next_cursor === "string" ? response.next_cursor : null;
  const requestStart = response.request_start;
  const requestEnd = response.request_end;
  const hasMore = typeof response.has_more === "boolean" ? response.has_more : cursor !== null;
  if (!hasMore || !cursor || cursor.length > 4_096 || typeof requestStart !== "string" || typeof requestEnd !== "string") return undefined;
  if (!UTC_RFC3339.test(requestStart) || !UTC_RFC3339.test(requestEnd) || !Number.isFinite(Date.parse(requestStart)) || !Number.isFinite(Date.parse(requestEnd))) return undefined;
  return { cursor, requestStart, requestEnd };
}

export function displayHistoryValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

export function historyResolution(response: ChartHistoryResponse | undefined, key: "requested_resolution" | "effective_resolution"): string {
  if (!response) return "unknown";
  const value = response[key];
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    const named = nested[key === "requested_resolution" ? "requested" : "effective"];
    if (typeof named === "string") return named;
  }
  const resolution = response.resolution;
  if (resolution && typeof resolution === "object") {
    const nested = resolution as Record<string, unknown>;
    const candidate = nested[key === "requested_resolution" ? "requested" : "effective"];
    if (typeof candidate === "string") return candidate;
  }
  return "unknown";
}

export function historyDowngradeReason(response: ChartHistoryResponse | undefined): string {
  if (!response) return "unknown";
  if (typeof response.downgrade_reason === "string") return response.downgrade_reason || "none";
  if (response.downgrade_reason === null) return "none";
  if (response.resolution && typeof response.resolution === "object") {
    const reason = (response.resolution as Record<string, unknown>).downgrade_reason;
    if (typeof reason === "string") return reason || "none";
    if (reason === null) return "none";
  }
  return "unknown";
}

export function useChartHistory(
  symbol: string,
  range: ChartRange,
  providerMode: ChartProviderMode,
  assetClass: ChartAssetClass,
  enabled = true,
) {
  const resolution = resolutionForRange(range);
  const query = useInfiniteQuery({
    queryKey: [
      "chart-history",
      HISTORY_CACHE_SCOPE,
      symbol,
      range,
      resolution,
      "provider",
      providerMode,
      "all",
      "unadjusted",
      assetClass,
    ],
    initialPageParam: null as CursorPageParam | null,
    queryFn: ({ pageParam, signal }) => fetchHistoryPage(
      symbol, range, resolution, providerMode, assetClass, pageParam, signal,
    ),
    getNextPageParam: (lastPage) => requestCursor(lastPage),
    enabled: enabled && Boolean(symbol),
    refetchInterval: range === "1D" ? 8_000 : 60_000,
    refetchIntervalInBackground: false,
    maxPages: 20,
  });

  const projected = useMemo(() => {
    const pages = query.data?.pages ?? [];
    if (pages.length === 0) return { bars: undefined as ChartHistoryCandle[] | undefined, error: null as string | null };
    const pageResolution = pages.map(responseResolution);
    const knownResolutions = new Set(pageResolution.filter((value): value is string => value !== null));
    if (knownResolutions.size > 1) {
      return { bars: null, error: "History pages returned inconsistent effective resolutions; data was not plotted." };
    }
    const firstByTimestamp = new Map<string, ChartHistoryCandle>();
    const effectiveResolution = pageResolution[0] ?? "unknown";
    for (const page of pages) {
      for (const rawBar of page.bars) {
        const bar = projectBar(rawBar);
        if (!bar) return { bars: null, error: "History values exceed the bounded chart projection or contain invalid OHLCV; no bars were plotted." };
        const key = `${effectiveResolution}:${bar.time}`;
        // Page order is newest first: newer history pages retain authority when cursors overlap.
        if (!firstByTimestamp.has(key)) firstByTimestamp.set(key, bar);
      }
    }
    return { bars: [...firstByTimestamp.values()].sort((left, right) => left.time - right.time), error: null };
  }, [query.data?.pages]);

  return {
    ...query,
    bars: projected.bars,
    projectionError: projected.error,
    latestPage: query.data?.pages[0],
    requestedResolution: resolution,
  };
}
