import { describe, expect, it } from "vitest";

import {
  buildYfinanceResearchInput,
  buildYfinanceOlderPageInput,
  buildYahooResearchPageHref,
  canLoadOlderPages,
  DEFAULT_YFINANCE_RESEARCH_CONFIG,
  isYfinanceCursorLoop,
  parseYfinanceResearchConfig,
  parseYfinanceResearchResponse,
  projectYfinanceResearchPages,
  yfinancePagesForProjection,
  yfinancePagesForEvidence,
  yfinanceSelectionKey,
  yfinanceSnapshotBehavior,
  YFINANCE_RESEARCH_MAX_PAGES,
  yfinanceResearchEvidence,
  type YfinanceResearchConfigV1,
  type YfinanceResearchPage,
} from "./yfinance";

const row = {
  symbol: "AAPL",
  asset_class: "stock" as const,
  event_ts_utc: "2026-10-14T00:00:00.000Z",
  resolution: "1d" as const,
  adjustment: "unadjusted" as const,
  open: "100.1",
  high: "103.2",
  low: "99.8",
  close: "102.4",
  adj_close: null,
  volume: "123456",
  dividends: null,
  stock_splits: null,
};

const page = {
  request: {
    symbol: "AAPL",
    assetClass: "stock" as const,
    startUtc: "2026-10-01T00:00:00.000Z",
    endUtc: "2026-10-15T00:00:00.000Z",
    adjustment: "unadjusted" as const,
  },
  response: {
    requested_range: { start_utc: "2026-10-01T00:00:00.000Z", end_utc: "2026-10-15T00:00:00.000Z" },
    observation: {
      payload: {
        bars: [row],
        status: "ready",
        returned_symbols: ["AAPL"],
        missing_symbols: [],
        source_observed_at: "2026-10-15T01:00:00.000Z",
        fetched_at: "2026-10-15T01:00:01.000Z",
        provenance: { adapter_version: "bounded-synthetic-e2e-v1" },
      },
    },
    next_cursor: "older-1",
  },
} as unknown as YfinanceResearchPage;

describe("Yahoo daily research adapter", () => {
  it("resets only a new request and uses viewport-aware refresh and prepend transitions", () => {
    expect(yfinanceSnapshotBehavior("new-request")).toBe("reset");
    expect(yfinanceSnapshotBehavior("refresh")).toBe("refresh");
    expect(yfinanceSnapshotBehavior("prepend")).toBe("prepend");
    expect(yfinancePagesForProjection([page], page)).toEqual([page]);
  });

  it("keeps a stable Yahoo selection identity while head bounds advance and cursor bounds stay anchored", () => {
    const config: YfinanceResearchConfigV1 = {
      ...DEFAULT_YFINANCE_RESEARCH_CONFIG,
      symbol: "AAPL",
      range: "1M",
    };
    const firstRequest = buildYfinanceResearchInput(
      config,
      undefined,
      Date.parse("2026-10-15T12:30:00.000Z"),
    );
    const advancedRequest = buildYfinanceResearchInput(
      config,
      undefined,
      Date.parse("2026-10-16T12:30:00.000Z"),
    );
    expect(firstRequest).not.toBeNull();
    expect(advancedRequest).not.toBeNull();
    if (!firstRequest || !advancedRequest) return;

    expect(yfinanceSelectionKey(config, undefined)).toBe(
      yfinanceSelectionKey({ ...config, style: "line" }, undefined),
    );
    expect(yfinanceSelectionKey(config, undefined)).not.toBe(
      yfinanceSelectionKey({ ...config, range: "5D" }, undefined),
    );
    expect(advancedRequest.endUtc).not.toBe(firstRequest.endUtc);

    const originalPage = {
      ...page,
      request: firstRequest,
      response: {
        ...page.response,
        requested_range: {
          start_utc: firstRequest.startUtc,
          end_utc: firstRequest.endUtc,
        },
      },
    } as unknown as YfinanceResearchPage;
    const olderInput = buildYfinanceOlderPageInput(originalPage, "cursor-from-original-window");
    expect(olderInput).toEqual({ ...firstRequest, cursor: "cursor-from-original-window" });
    expect(olderInput.startUtc).not.toBe(advancedRequest.startUtc);
    expect(olderInput.endUtc).toBe(firstRequest.endUtc);
  });

  it("retains the original Yahoo head window across refresh and overlays only the latest head", () => {
    const originalEarliestRow = {
      ...row,
      event_ts_utc: "2026-09-01T00:00:00.000Z",
      close: "88.8",
    };
    const cursorOlderRow = {
      ...row,
      event_ts_utc: "2026-08-31T00:00:00.000Z",
      close: "87.7",
    };
    const originalOverlapRow = { ...row, close: "102.4" };
    const latestOverlapRow = { ...row, close: "105.5" };
    const latestNewRow = {
      ...row,
      event_ts_utc: "2026-10-15T00:00:00.000Z",
      close: "106.6",
    };
    const originalRequest = {
      ...page.request,
      startUtc: "2026-08-01T00:00:00.000Z",
      endUtc: "2026-10-15T00:00:00.000Z",
    };
    const originalHead = {
      ...page,
      request: originalRequest,
      response: {
        ...page.response,
        requested_range: {
          start_utc: originalRequest.startUtc,
          end_utc: originalRequest.endUtc,
        },
        observation: {
          ...page.response.observation,
          payload: {
            ...page.response.observation.payload,
            bars: [originalEarliestRow, originalOverlapRow],
          },
        },
      },
    } as unknown as YfinanceResearchPage;
    const olderPage = {
      ...page,
      request: { ...originalRequest, cursor: "cursor-1" },
      response: {
        ...page.response,
        requested_range: {
          start_utc: originalRequest.startUtc,
          end_utc: originalRequest.endUtc,
        },
        observation: {
          ...page.response.observation,
          payload: { ...page.response.observation.payload, bars: [cursorOlderRow] },
        },
        next_cursor: null,
      },
    } as unknown as YfinanceResearchPage;
    const refreshedHead = {
      ...page,
      request: {
        ...originalRequest,
        startUtc: "2026-09-02T00:00:00.000Z",
        endUtc: "2026-10-16T00:00:00.000Z",
      },
      response: {
        ...page.response,
        requested_range: {
          start_utc: "2026-09-02T00:00:00.000Z",
          end_utc: "2026-10-16T00:00:00.000Z",
        },
        observation: {
          ...page.response.observation,
          payload: {
            ...page.response.observation.payload,
            bars: [latestOverlapRow, latestNewRow],
          },
        },
      },
    } as unknown as YfinanceResearchPage;
    const cursorPages = [originalHead, olderPage];

    const orderedPages = yfinancePagesForProjection(cursorPages, refreshedHead);
    const projection = projectYfinanceResearchPages(orderedPages);
    const evidencePages = yfinancePagesForEvidence(cursorPages, refreshedHead);
    const subsequentHead = {
      ...refreshedHead,
      response: {
        ...refreshedHead.response,
        observation: {
          ...refreshedHead.response.observation,
          payload: {
            ...refreshedHead.response.observation.payload,
            bars: [latestNewRow],
          },
        },
      },
    } as unknown as YfinanceResearchPage;
    const olderInput = buildYfinanceOlderPageInput(olderPage, "cursor-2");
    expect(orderedPages).toEqual([olderPage, originalHead, refreshedHead]);
    expect(yfinancePagesForProjection(cursorPages, subsequentHead)).toEqual([
      olderPage,
      originalHead,
      subsequentHead,
    ]);
    expect(projection.bars.map((bar) => bar.sourceRow.event_ts_utc)).toEqual([
      "2026-08-31T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-10-14T00:00:00.000Z",
      "2026-10-15T00:00:00.000Z",
    ]);
    expect(projection.bars[2]?.close).toBe(105.5);
    expect(projection.bars[2]?.sourceRow.close).toBe("105.5");
    expect(evidencePages).toEqual([refreshedHead, originalHead, olderPage]);
    expect(olderInput).toMatchObject({
      startUtc: olderPage.request.startUtc,
      endUtc: olderPage.request.endUtc,
      cursor: "cursor-2",
    });
  });

  it("bounds saved chart configuration and derives a daily UTC-exclusive request window", () => {
    const parsed = parseYfinanceResearchConfig({
      ...DEFAULT_YFINANCE_RESEARCH_CONFIG,
      symbol: "AAPL",
      range: "YTD",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const request = buildYfinanceResearchInput(
      parsed.value,
      undefined,
      Date.parse("2026-10-15T12:30:00.000Z"),
    );
    expect(request).toMatchObject({
      symbol: "AAPL",
      startUtc: "2026-01-01T00:00:00.000Z",
      endUtc: "2026-10-15T00:00:00.000Z",
      adjustment: "unadjusted",
    });
    expect(
      parseYfinanceResearchConfig({
        ...DEFAULT_YFINANCE_RESEARCH_CONFIG,
        indicators: ["SMA20", "SMA20"],
      }).ok,
    ).toBe(false);
    expect(
      parseYfinanceResearchConfig({ ...DEFAULT_YFINANCE_RESEARCH_CONFIG, symbol: "../x" }).ok,
    ).toBe(false);
  });

  it("surfaces the fixture marker and creates portal links only for a distinct server-authored origin", () => {
    const projection = projectYfinanceResearchPages([page]);
    const evidence = yfinanceResearchEvidence(
      DEFAULT_YFINANCE_RESEARCH_CONFIG,
      [page],
      projection,
      false,
    );
    expect(evidence?.evidence).toContainEqual({
      label: "Fixture provenance",
      value: "Synthetic acceptance fixture · bounded-synthetic-e2e marker",
    });
    expect(buildYahooResearchPageHref("https://research.example", "AAPL", "terminal.example")).toBe(
      "https://research.example/research/yfinance/AAPL",
    );
    expect(
      buildYahooResearchPageHref("https://research.example/", "AAPL", "terminal.example"),
    ).toBeNull();
    expect(
      buildYahooResearchPageHref("https://terminal.example/", "AAPL", "terminal.example"),
    ).toBeNull();
    expect(
      buildYahooResearchPageHref(
        "https://user:secret@research.example/",
        "AAPL",
        "terminal.example",
      ),
    ).toBeNull();
  });

  it("keeps provider floats distinct and omits rows with missing OHLCV rather than filling values", () => {
    const missingVolume = { ...row, event_ts_utc: "2026-10-13T00:00:00.000Z", volume: null };
    const fixture = {
      ...page,
      response: {
        ...page.response,
        observation: {
          ...page.response.observation,
          payload: { ...page.response.observation.payload, bars: [row, missingVolume] },
        },
      },
    } as YfinanceResearchPage;
    const projection = projectYfinanceResearchPages([fixture]);
    expect(projection.bars).toHaveLength(1);
    expect(projection.bars[0]?.close).toBe(102.4);
    expect(projection.bars[0]?.exact).toBeUndefined();
    expect(projection.rejectedRows).toBe(1);
    const evidence = yfinanceResearchEvidence(
      DEFAULT_YFINANCE_RESEARCH_CONFIG,
      [fixture],
      projection,
      false,
    );
    expect(evidence?.precision).toBe("provider-float");
    expect(evidence?.completeness).toBe("partial");
    expect(evidence?.coverage).toContain("1 rows omitted");
  });

  it("limits cursor pagination and detects a repeated continuation", () => {
    expect(canLoadOlderPages([page], false)).toBe(true);
    expect(isYfinanceCursorLoop([page], "older-1")).toBe(true);
    expect(canLoadOlderPages([page], true)).toBe(false);
    expect(
      canLoadOlderPages(
        Array.from({ length: YFINANCE_RESEARCH_MAX_PAGES }, () => page),
        false,
      ),
    ).toBe(false);
  });

  it("rejects absent or mismatched provider envelopes without guessing source data", () => {
    const config: YfinanceResearchConfigV1 = {
      ...DEFAULT_YFINANCE_RESEARCH_CONFIG,
      symbol: "AAPL",
    };
    const request = buildYfinanceResearchInput(
      config,
      undefined,
      Date.parse("2026-10-15T12:30:00.000Z"),
    );
    expect(request).not.toBeNull();
    if (!request) return;
    expect(parseYfinanceResearchResponse(null, request)).toBeNull();
    expect(
      parseYfinanceResearchResponse(
        { schema_version: "mdp-yfinance-research-observations-v1" },
        request,
      ),
    ).toBeNull();
  });
});
