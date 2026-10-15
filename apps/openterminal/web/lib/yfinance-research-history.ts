"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  CHART_HISTORY_CACHE_SCOPE,
  projectChartHistoryBar,
  type ChartAssetClass,
  type ChartHistoryCandle,
  type ChartHistoryResponse,
  type ChartRange,
} from "./chart-history";
import {
  validateYfinanceResearchResponse,
  YFINANCE_RESEARCH_MAX_PAGES,
  type YfinanceResearchAdjustment,
  type YfinanceResearchResponse,
} from "./yfinance-research-contract";

type YfinancePage = {
  envelope: YfinanceResearchResponse;
  bars: ChartHistoryCandle[];
  requestCursor: string | null;
};

type YfinanceChartResponse = ChartHistoryResponse & {
  yfinance_research: YfinanceResearchResponse;
};

const YFINANCE_PAGE_LIMIT = YFINANCE_RESEARCH_MAX_PAGES;

function subtractCalendarDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

function subtractCalendarMonths(date: Date, months: number): Date {
  const targetMonthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(date.getUTCDate(), lastDay);
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

function rangeStart(range: ChartRange, endUtc: string): string {
  const end = new Date(endUtc);
  switch (range) {
    case "1D": return subtractCalendarDays(end, 7).toISOString();
    case "5D": return subtractCalendarDays(end, 14).toISOString();
    case "1M": return subtractCalendarMonths(end, 1).toISOString();
    case "6M": return subtractCalendarMonths(end, 6).toISOString();
    case "YTD": return new Date(Date.UTC(end.getUTCFullYear(), 0, 1)).toISOString();
    case "1Y": return subtractCalendarMonths(end, 12).toISOString();
    case "5Y": return subtractCalendarMonths(end, 60).toISOString();
    case "MAX": return "1970-01-01T00:00:00.000Z";
    default: return subtractCalendarMonths(end, 6).toISOString();
  }
}

function rangeDescription(range: ChartRange): string {
  switch (range) {
    case "1D": return "1D plots up to the latest available daily observation; the lookup window is 7 calendar days";
    case "5D": return "5D plots up to the latest 5 available daily observations; the lookup window is 14 calendar days";
    case "1M": return "1M uses a rolling UTC calendar-month window";
    case "6M": return "6M uses a rolling six-calendar-month UTC window";
    case "YTD": return "YTD starts at January 1 UTC";
    case "1Y": return "1Y uses a rolling UTC calendar-year window";
    case "5Y": return "5Y uses a rolling five-calendar-year UTC window";
    case "MAX": return "MAX starts at the 1970 UTC lower bound and loads newest-first cursor pages";
    default: return "Daily observations in the requested UTC window";
  }
}

function timestamp(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const milliseconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0") || "0");
}

function projectPage(
  envelope: YfinanceResearchResponse,
  symbol: string,
  requestCursor: string | null,
): YfinancePage {
  const rows = envelope.observation.payload.bars.filter((row) => row.symbol === symbol);
  const bars = rows.map((row) => projectChartHistoryBar({
    bar_start_utc: row.event_ts_utc,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
  if (bars.some((bar) => bar === null)) {
    throw new Error("Yahoo research values are incomplete or outside the bounded chart projection; no bars were plotted.");
  }
  return { envelope, bars: bars as ChartHistoryCandle[], requestCursor };
}

async function fetchYfinancePage(
  symbol: string,
  assetClass: ChartAssetClass,
  adjustment: YfinanceResearchAdjustment,
  startUtc: string,
  endUtc: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<YfinancePage> {
  const query = new URLSearchParams({
    symbols: symbol,
    asset_class: assetClass,
    start_utc: startUtc,
    end_utc: endUtc,
    adjustment,
  });
  if (cursor !== null) query.set("cursor", cursor);
  const response = await fetch(`/api/research/yfinance/daily?${query.toString()}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  const body: unknown = await response.json();
  if (!validateYfinanceResearchResponse(body, {
    symbols: [symbol], assetClass, adjustment, startUtc, endUtc, cursor,
  })) {
    throw new Error("Yahoo research response failed the frozen observation contract.");
  }
  return projectPage(body, symbol, cursor);
}

export function useYfinanceResearchHistory(
  symbol: string,
  range: ChartRange,
  assetClass: ChartAssetClass,
  adjustment: YfinanceResearchAdjustment,
  enabled = true,
) {
  const queryClient = useQueryClient();
  const [snapshotEndUtc, setSnapshotEndUtc] = useState(() => new Date().toISOString());
  const startUtc = rangeStart(range, snapshotEndUtc);
  const queryKey = [
    "yfinance-research-history",
    CHART_HISTORY_CACHE_SCOPE,
    "research",
    symbol,
    assetClass,
    range,
    "1d",
    adjustment,
    startUtc,
    snapshotEndUtc,
    "all",
  ] as const;

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchYfinancePage(
      symbol, assetClass, adjustment, startUtc, snapshotEndUtc, pageParam, signal,
    ),
    getNextPageParam: (lastPage, allPages) => {
      const cursor = lastPage.envelope.next_cursor;
      return allPages.length >= YFINANCE_PAGE_LIMIT || typeof cursor !== "string" ||
        allPages.some((page) => page.requestCursor === cursor) ? undefined : cursor;
    },
    enabled: enabled && Boolean(symbol),
    maxPages: YFINANCE_PAGE_LIMIT,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const pages = query.data?.pages ?? [];
  const projected = useMemo(() => {
    if (pages.length === 0) return { bars: undefined as ChartHistoryCandle[] | undefined, error: null as string | null };
    for (let index = 1; index < pages.length; index += 1) {
      const newer = pages[index - 1]!.envelope.page_range;
      const older = pages[index]!.envelope.page_range;
      const newerStart = timestamp(newer.start_utc);
      const olderEnd = timestamp(older.end_utc);
      if (newerStart === null || olderEnd === null || newerStart !== olderEnd) {
        return { bars: null, error: "Yahoo research pages are not adjacent; the mixed snapshot was not plotted." };
      }
    }
    const firstByTimestamp = new Map<string, ChartHistoryCandle>();
    for (const page of pages) {
      for (const bar of page.bars) {
        const key = `1d:${bar.time}`;
        // Pages are newest-first; the first row for a timestamp remains authoritative.
        if (!firstByTimestamp.has(key)) firstByTimestamp.set(key, bar);
      }
    }
    const orderedBars = [...firstByTimestamp.values()].sort((left, right) => left.time - right.time);
    const latestObservationLimit = pages.length === 1
      ? range === "1D" ? 1 : range === "5D" ? 5 : null
      : null;
    return {
      bars: latestObservationLimit === null ? orderedBars : orderedBars.slice(-latestObservationLimit),
      error: null,
    };
  }, [pages, range]);

  const latest = pages[0];
  const lastPage = pages[pages.length - 1];
  const cursorCycleDetected = Boolean(lastPage && typeof lastPage.envelope.next_cursor === "string" &&
    pages.some((page) => page.requestCursor === lastPage.envelope.next_cursor));
  const latestPage: YfinanceChartResponse | undefined = latest ? {
    bars: latest.bars,
    source: latest.envelope.source,
    source_label: latest.envelope.source,
    provider: latest.envelope.provider,
    requested_resolution: latest.envelope.resolution,
    effective_resolution: latest.envelope.resolution,
    coverage_status: "unasserted",
    fetched_at: latest.envelope.observation.fetched_at_utc,
    yfinance_research: latest.envelope,
  } : undefined;
  const pageLimitReached = pages.length >= YFINANCE_PAGE_LIMIT &&
    typeof pages[pages.length - 1]?.envelope.next_cursor === "string";
  const refreshSnapshot = useCallback(() => {
    setSnapshotEndUtc((current) => {
      const next = Math.max(Date.now(), Date.parse(current) + 1);
      return new Date(next).toISOString();
    });
  }, []);

  return {
    ...query,
    latestPage,
    latestEnvelope: latest?.envelope,
    bars: projected.bars,
    projectionError: projected.error,
    pageLimitReached,
    cursorCycleDetected,
    hasNextPage: Boolean(query.hasNextPage) && !pageLimitReached && !cursorCycleDetected,
    requestedResolution: "1d" as const,
    requestStart: startUtc,
    requestEnd: snapshotEndUtc,
    rangeDescription: rangeDescription(range),
    loadedPageCount: pages.length,
    refreshSnapshot: () => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      refreshSnapshot();
    },
  };
}
