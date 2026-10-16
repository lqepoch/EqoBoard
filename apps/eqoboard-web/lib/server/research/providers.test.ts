import { afterEach, describe, expect, it, vi } from "vitest";

import { attachSipEarningsMoves, type EarningsHistoryRow } from "./calendar";
import { loadCryptoMarkets } from "./crypto";
import { loadInsiderTransactions } from "./insider";
import { readFredHistory } from "./macro";
import { loadNews } from "./news";
import { attachSipSnapshots, filterMarketData, type ResearchMarketData } from "./screener";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("adapted read-only provider operations", () => {
  it("parses bounded RSS headlines and retains publisher URLs without changing their source identity", async () => {
    const feed = `<?xml version="1.0"?><rss><channel><item><title>Market headline</title><link>https://publisher.example/story</link><source>Publisher</source><pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const fetchMock = vi.fn(
      async () =>
        new Response(feed, { status: 200, headers: { "Content-Type": "application/rss+xml" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadNews(null);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      title: "Market headline",
      link: "https://publisher.example/story",
      publisher: "Publisher",
      provider: "Google News RSS",
      publishedAt: "2026-10-14T10:00:00.000Z",
    });
    expect(result.asOf).toBeNull();
    expect(result.warning).toContain("terms");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses FRED CSV observation dates and ignores missing or nonnumeric values", async () => {
    const csv = "observation_date,DGS10\n2026-10-12,4.01\n2026-10-13,.\n2026-10-14,4.12\n";
    const fetchMock = vi.fn(
      async () => new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const points = await readFredHistory("DGS10", 10);

    expect(points).toEqual([
      { date: "2026-10-12", value: 4.01 },
      { date: "2026-10-14", value: 4.12 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Binance only after CoinGecko failure and leaves absent market-cap fields null", async () => {
    const pairs = [
      "BTC",
      "ETH",
      "SOL",
      "BNB",
      "XRP",
      "ADA",
      "DOGE",
      "AVAX",
      "DOT",
      "LINK",
      "LTC",
      "MATIC",
    ];
    const binance = pairs.map((symbol) => ({
      symbol: `${symbol}USDT`,
      lastPrice: "100.25",
      priceChangePercent: "1.1",
      quoteVolume: "250000",
      closeTime: Date.parse("2026-10-15T01:00:00.000Z"),
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(binance), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadCryptoMarkets();

    expect(result.source.provider).toBe("Binance public market data");
    expect(result.data).toHaveLength(12);
    expect(result.data[0]).toMatchObject({
      marketCap: null,
      rank: null,
      sparkline: [],
      asOf: "2026-10-15T01:00:00.000Z",
    });
    expect(result.warning).toContain("CoinGecko failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses SEC lookup without an explicitly configured contact and makes no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SEC_EDGAR_CONTACT", "");

    await expect(loadInsiderTransactions("AAPL")).rejects.toThrow("sec-contact-unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives earnings price moves only from provided SIP bars and retains the source bar time", () => {
    const row: EarningsHistoryRow = {
      fiscalQuarterEnd: "12/31/2024",
      reportedAt: "2025-01-02T00:00:00.000Z",
      eps: 1.2,
      consensusForecast: 1.1,
      surprisePercent: 9.1,
      dayAfterChangePercent: null,
      priceMoveSource: "unavailable",
      priceMoveAsOf: null,
    };

    const result = attachSipEarningsMoves(
      [row],
      [
        { time: "2025-01-02T15:00:00.000Z", close: "100" },
        { time: "2025-01-03T15:00:00.000Z", close: "105" },
      ],
    );

    expect(result[0]).toMatchObject({
      dayAfterChangePercent: 5,
      priceMoveSource: "Rust Gateway SIP daily bars",
      priceMoveAsOf: "2025-01-03T15:00:00.000Z",
    });
  });

  it("keeps U.S. price values tied to a SIP response and exposes unknown source labels", () => {
    const base: ResearchMarketData = {
      market: "us",
      rows: [
        {
          symbol: "SPY",
          name: "SPDR",
          price: null,
          changePercent: null,
          volume: null,
          marketCap: 100,
          marketCapCurrency: "USD",
          marketCapEur: null,
          marketCapEurAsOf: null,
          sector: "ETF",
          exchange: "NYSEARCA",
          country: "United States",
          priceSource: "awaiting Gateway SIP snapshot",
          priceAsOf: null,
          marketCapSource: "TradingView scanner",
          marketCapAsOf: null,
          sourceMode: null,
          sourceLabel: null,
        },
      ],
      coverage: {
        requested: 1,
        snapshots: 0,
        priced: 0,
        timed: 0,
        snapshotComplete: false,
        priceComplete: false,
        timeComplete: false,
        complete: false,
      },
      truncated: false,
    };
    const attached = attachSipSnapshots(base, {
      feed: "sip",
      snapshots: [
        {
          feed: "sip",
          symbol: "SPY",
          last: "500.25",
          last_as_of: "2026-10-15T01:00:00Z",
          change_percent: "0.5",
          volume: "1000",
        },
      ],
      sourceLabel: null,
      sourceMode: null,
      receivedAt: "2026-10-15T01:00:01Z",
      gatewayInstanceId: null,
    });
    const filtered = filterMarketData(attached, { changeMin: 0, limit: 10 });

    expect(filtered.rows[0]).toMatchObject({
      price: 500.25,
      priceSource: "source unknown (Gateway SIP endpoint)",
      priceAsOf: "2026-10-15T01:00:00.000Z",
    });
    expect(filtered.coverage.complete).toBe(true);
  });
});
