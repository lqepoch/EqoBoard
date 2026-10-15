import { describe, expect, it } from "vitest";

import { parseRecapEnvelope, parseResearchEnvelope, parseSymbolSearchEnvelope, projectResearchTable } from "./data";

const newsEnvelope = {
  schemaVersion: 1,
  operation: "news",
  source: {
    provider: "Yahoo Finance RSS + Google News RSS",
    providerUrl: "https://news.google.com/",
    sourcePath: "apps/openterminal/server/src/providers/news.ts",
    license: null,
  },
  status: "partial",
  asOf: null,
  retrievedAt: "2026-10-15T02:00:00.000Z",
  completeness: { complete: false, failedItems: 1, truncated: false },
  cache: "miss",
  data: [{
    title: "Headline",
    link: "https://news.example/story",
    publisher: "Publisher",
    provider: "Google News RSS",
    publishedAt: "2026-10-15T01:55:00.000Z",
    symbol: null,
  }],
  warning: "Provider terms are not verified.",
} as const;

describe("native research envelope adapter", () => {
  it("retains response-derived provider, as-of, retrieval, cache and completeness evidence", () => {
    const envelope = parseResearchEnvelope("research.news", newsEnvelope);

    expect(envelope?.source.provider).toBe("Yahoo Finance RSS + Google News RSS");
    expect(envelope?.asOf).toBeNull();
    expect(envelope?.retrievedAt).toBe("2026-10-15T02:00:00.000Z");
    expect(envelope?.completeness.failedItems).toBe(1);
    expect(envelope?.status).toBe("partial");
    if (!envelope) return;
    expect(projectResearchTable("research.news", envelope).rows).toHaveLength(1);
  });

  it("rejects operation/source mismatches and incomplete payloads advertised as complete", () => {
    expect(parseResearchEnvelope("research.crypto", newsEnvelope)).toBeNull();
    expect(parseResearchEnvelope("research.news", {
      ...newsEnvelope,
      status: "available",
      source: { ...newsEnvelope.source, providerUrl: "javascript:alert(1)" },
    })).toBeNull();
    expect(parseResearchEnvelope("research.news", {
      ...newsEnvelope,
      status: "available",
      completeness: { ...newsEnvelope.completeness, complete: true },
      data: [{ ...newsEnvelope.data[0]!, link: "javascript:alert(1)" }],
    })).toBeNull();
  });

  it("requires the fixed TradingView metadata-only source for symbol search", () => {
    const envelope = {
      schemaVersion: 1,
      operation: "symbol-search",
      source: {
        provider: "TradingView symbol search",
        providerUrl: "https://www.tradingview.com/",
        sourcePath: "apps/openterminal/server/src/providers/tradingview.ts",
        license: null,
      },
      status: "partial",
      asOf: null,
      retrievedAt: "2026-10-15T02:00:00.000Z",
      completeness: { complete: false, failedItems: null, truncated: true },
      cache: "miss",
      data: [{
        symbol: "AAPL",
        providerSymbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ",
        type: "stock",
        provider: "TradingView symbol search",
        asOf: null,
      }],
      warning: "TradingView symbol search returns listing metadata only.",
    } as const;

    expect(parseSymbolSearchEnvelope(envelope)?.data[0]?.symbol).toBe("AAPL");
    expect(parseSymbolSearchEnvelope({
      ...envelope,
      source: { ...envelope.source, providerUrl: "https://scanner.tradingview.com/" },
    })).toBeNull();
    expect(parseSymbolSearchEnvelope({
      ...envelope,
      data: [{ ...envelope.data[0], price: 100 }],
    })).toBeNull();
  });

  it("decodes a bounded partial recap and rejects generated narrative fields", () => {
    const envelope = {
      schemaVersion: 1,
      operation: "recap",
      source: {
        provider: "FRED + TradingView scanner + Rust Gateway SIP + RSS headlines",
        providerUrl: "https://www.tradingview.com/",
        sourcePath: "apps/eqoboard-web/lib/server/research/recap.ts",
        license: null,
      },
      status: "partial",
      asOf: null,
      retrievedAt: "2026-10-15T02:00:00.000Z",
      completeness: { complete: false, failedItems: 1, truncated: false },
      cache: "miss",
      data: {
        indexes: [{ symbol: "SPY", label: "S&P 500 (SPY)", price: { value: null, source: null, asOf: null }, changePercent: { value: null, source: null, asOf: null } }],
        volatility: { vix: { value: null, source: null, asOf: null } },
        gainers: [],
        losers: [],
        sectors: [],
        headlines: [],
        coverage: {
          marketMetadata: { status: "available", returned: 1, sampled: 1, sampleLimit: 150, truncated: false, source: "TradingView scanner", asOf: null },
          sipSnapshots: { status: "unavailable", requested: 151, snapshots: 0, marketRequested: 150, priced: 0, timed: 0, complete: false, source: null, asOf: null },
          macro: { status: "partial", source: "FRED", asOf: null },
          headlines: { status: "unavailable", returned: 0, source: null, asOf: null },
        },
      },
      warning: "Sources are incomplete.",
    } as const;

    expect(parseRecapEnvelope(envelope)?.data.indexes[0]?.price.value).toBeNull();
    expect(parseRecapEnvelope({ ...envelope, data: { ...envelope.data, narrative: "Markets rallied today." } })).toBeNull();
  });
});
