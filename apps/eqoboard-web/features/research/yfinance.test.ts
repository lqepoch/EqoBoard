import { describe, expect, it } from "vitest";

import {
  buildYfinanceResearchInput,
  buildYahooResearchPageHref,
  canLoadOlderPages,
  DEFAULT_YFINANCE_RESEARCH_CONFIG,
  isYfinanceCursorLoop,
  parseYfinanceResearchConfig,
  parseYfinanceResearchResponse,
  projectYfinanceResearchPages,
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
