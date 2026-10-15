import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadMacro: vi.fn(),
  loadMarketMetadata: vi.fn(),
  loadNews: vi.fn(),
  readSipSnapshotsWithDelegation: vi.fn(),
}));

vi.mock("./macro", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./macro")>();
  return { ...actual, loadMacro: mocks.loadMacro };
});
vi.mock("./screener", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./screener")>();
  return { ...actual, loadMarketMetadata: mocks.loadMarketMetadata };
});
vi.mock("./news", () => ({ loadNews: mocks.loadNews }));
vi.mock("./gateway", () => ({ readSipSnapshotsWithDelegation: mocks.readSipSnapshotsWithDelegation }));

import { loadResearchRecap } from "./recap";

const macroResult = {
  source: { provider: "FRED", providerUrl: "https://fred.stlouisfed.org/", sourcePath: "apps/openterminal/server/src/providers/fred.ts", license: null },
  data: {
    region: "us",
    observations: [{ id: "VIXCLS", label: "CBOE VIX close", value: 18, unit: "index", provider: "FRED", asOf: "2026-10-14" }],
    indexProxies: [{ symbol: "SPY", label: "S&P 500 (SPY)" }],
    indexObservations: [],
  },
  asOf: null,
  complete: true,
  failedItems: 0,
  truncated: false,
  warning: "FRED observations and Gateway proxy observations have separate timestamps.",
} as const;

const marketMetadata = {
  source: { provider: "TradingView scanner", providerUrl: "https://scanner.tradingview.com/", sourcePath: "apps/openterminal/server/src/providers/tradingview.ts", license: null },
  data: {
    market: "us",
    rows: [{
      symbol: "AAPL",
      name: "Apple Inc.",
      price: null,
      changePercent: null,
      volume: null,
      marketCap: 3_000_000_000_000,
      marketCapCurrency: "USD",
      marketCapEur: null,
      marketCapEurAsOf: null,
      sector: "Technology",
      exchange: "NASDAQ",
      country: "United States",
      priceSource: "awaiting Gateway SIP snapshot",
      priceAsOf: null,
      marketCapSource: "TradingView scanner",
      marketCapAsOf: null,
      sourceMode: null,
      sourceLabel: null,
    }],
    coverage: { requested: 1, snapshots: 0, priced: 0, timed: 0, snapshotComplete: false, priceComplete: false, timeComplete: false, complete: false },
    truncated: false,
  },
  asOf: null,
  complete: false,
  failedItems: 0,
  truncated: false,
  warning: "Scanner metadata has no quote timestamp.",
} as const;

const emptyNews = {
  source: { provider: "RSS headlines", providerUrl: "https://news.google.com/", sourcePath: "apps/openterminal/server/src/providers/news.ts", license: null },
  data: [],
  asOf: null,
  complete: true,
  failedItems: 0,
  truncated: false,
  warning: "Headline providers returned no rows.",
} as const;

const gatewayBatch = {
  ok: true,
  value: {
    feed: "sip",
    snapshots: [
      { feed: "sip", symbol: "SPY", last: 600, change_percent: 0.5, last_as_of: "2026-10-15T14:00:00.000Z", source_label: "Alpaca SIP", source_mode: "live" },
      { feed: "sip", symbol: "AAPL", last: 250, change_percent: 1.25, last_as_of: "2026-10-15T14:00:00.000Z", source_label: "Alpaca SIP", source_mode: "live" },
    ],
    requestedSymbols: ["SPY", "AAPL"],
    receivedAt: "2026-10-15T14:00:01.000Z",
    sourceLabel: "Alpaca SIP",
    sourceMode: "live",
    gatewayInstanceId: "gateway-test",
  },
} as const;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("bounded provider recap", () => {
  it("keeps independently sourced SIP, scanner, and macro evidence while marking headline failure partial", async () => {
    mocks.loadMacro.mockResolvedValue(macroResult);
    mocks.loadMarketMetadata.mockResolvedValue(marketMetadata);
    mocks.loadNews.mockRejectedValue(new Error("rss unavailable"));
    mocks.readSipSnapshotsWithDelegation.mockResolvedValue(gatewayBatch);

    const result = await loadResearchRecap({ token: "delegated-test-token" });

    expect(result.complete).toBe(false);
    expect(result.data.volatility.vix).toEqual({ value: 18, source: "FRED", asOf: "2026-10-14" });
    expect(result.data.indexes[0]?.price).toEqual({ value: 600, source: "Alpaca SIP", asOf: "2026-10-15T14:00:00.000Z" });
    expect(result.data.gainers[0]?.changePercent).toEqual({ value: 1.25, source: "Alpaca SIP", asOf: "2026-10-15T14:00:00.000Z" });
    expect(result.data.gainers[0]?.marketCap).toEqual({ value: 3_000_000_000_000, source: "TradingView scanner", asOf: null });
    expect(result.data.sectors[0]?.sourceTimeRange).toEqual({ earliest: "2026-10-15T14:00:00.000Z", latest: "2026-10-15T14:00:00.000Z" });
    expect(result.data.headlines).toEqual([]);
    expect(result.data.coverage.headlines.status).toBe("unavailable");
    expect(result.data.coverage.sipSnapshots.source).toBe("Alpaca SIP");
    expect(result.warning).toContain("not a synchronized market snapshot");
  });

  it("leaves prices, movers, and sectors unavailable when Gateway SIP observations are absent", async () => {
    mocks.loadMacro.mockResolvedValue(macroResult);
    mocks.loadMarketMetadata.mockRejectedValue(new Error("scanner unavailable"));
    mocks.loadNews.mockRejectedValue(new Error("rss unavailable"));
    mocks.readSipSnapshotsWithDelegation.mockResolvedValue({ ok: false, response: new Response(null, { status: 502 }) });

    const result = await loadResearchRecap({ token: "delegated-test-token" });

    expect(result.complete).toBe(false);
    expect(result.data.indexes).toHaveLength(1);
    expect(result.data.indexes[0]?.price.value).toBeNull();
    expect(result.data.gainers).toEqual([]);
    expect(result.data.losers).toEqual([]);
    expect(result.data.sectors).toEqual([]);
    expect(result.data.headlines).toEqual([]);
    expect(result.data.coverage.marketMetadata.status).toBe("unavailable");
    expect(result.data.coverage.sipSnapshots.status).toBe("unavailable");
  });

  it("keeps SIP coverage partial when an index price exists without its change observation", async () => {
    mocks.loadMacro.mockResolvedValue(macroResult);
    mocks.loadMarketMetadata.mockResolvedValue(marketMetadata);
    mocks.loadNews.mockResolvedValue(emptyNews);
    mocks.readSipSnapshotsWithDelegation.mockResolvedValue({
      ...gatewayBatch,
      value: {
        ...gatewayBatch.value,
        snapshots: gatewayBatch.value.snapshots.map((row) => row.symbol === "SPY" ? { ...row, change_percent: null } : row),
      },
    });

    const result = await loadResearchRecap({ token: "delegated-test-token" });

    expect(result.data.indexes[0]?.price.value).toBe(600);
    expect(result.data.indexes[0]?.changePercent.value).toBeNull();
    expect(result.data.coverage.sipSnapshots).toMatchObject({ status: "partial", complete: false });
    expect(result.failedItems).toBe(1);
  });
});
