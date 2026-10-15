import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readProviderJson: vi.fn() }));

vi.mock("./transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport")>();
  return { ...actual, readProviderJson: mocks.readProviderJson };
});

import { loadTradingViewSymbolSearch } from "./symbol-search";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("fixed TradingView symbol-search adapter", () => {
  it("uses a bounded fixed host and returns listing metadata without quote fields", async () => {
    mocks.readProviderJson.mockResolvedValue({
      symbols: [
        { symbol: "NASDAQ:AAPL", description: "Apple Inc.", exchange: "NASDAQ", type: "stock" },
        { symbol: "MIL:ENI", description: "Eni S.p.A.", exchange: "MIL", type: "stock" },
        { symbol: "NASDAQ:IGNORED", description: "Ignored", exchange: "NASDAQ", type: "unknown" },
        { symbol: "NASDAQ:A:B", description: "Ambiguous", exchange: "NASDAQ", type: "stock" },
      ],
    });

    const result = await loadTradingViewSymbolSearch("AAPL");
    const request = mocks.readProviderJson.mock.calls.at(0);
    if (!request) throw new Error("expected one TradingView provider request");
    const [requestUrl, options] = request;
    const url = requestUrl as URL;

    expect(url.origin).toBe("https://symbol-search.tradingview.com");
    expect(url.pathname).toBe("/symbol_search/v3/");
    expect(url.searchParams.get("text")).toBe("AAPL");
    expect(url.searchParams.get("domain")).toBe("production");
    expect(url.searchParams.get("sort_by_country")).toBe("US");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(options).toMatchObject({
      timeoutMs: 7_000,
      maxBytes: 384 * 1024,
      headers: {
        "User-Agent": "EqoBoard Research/1.0",
        Referer: "https://www.tradingview.com/",
        Origin: "https://www.tradingview.com",
      },
    });
    expect(result.source).toMatchObject({ provider: "TradingView symbol search", license: null });
    expect(result.asOf).toBeNull();
    expect(result.data).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        providerSymbol: "AAPL",
        provider: "TradingView symbol search",
        asOf: null,
      }),
      expect.objectContaining({
        symbol: "ENI.MI",
        providerSymbol: "ENI",
        provider: "TradingView symbol search",
        asOf: null,
      }),
    ]);
    expect(result.data[0]).not.toHaveProperty("price");
    expect(result.warning).toContain(
      "no observation timestamp, quote, market feed, or SIP authority",
    );
  });

  it("caps and deduplicates response rows while marking truncation", async () => {
    const symbols = Array.from({ length: 24 }, (_, index) => ({
      symbol: `NASDAQ:T${String(index).padStart(2, "0")}`,
      description: `Company ${index}`,
      exchange: "NASDAQ",
      type: "stock",
    }));
    mocks.readProviderJson.mockResolvedValue({ symbols });

    const result = await loadTradingViewSymbolSearch("companies");

    expect(result.data).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("rejects malformed queries before provider dispatch", async () => {
    await expect(loadTradingViewSymbolSearch(" AAPL")).rejects.toThrow(
      "invalid-symbol-search-query",
    );
    await expect(loadTradingViewSymbolSearch("A".repeat(65))).rejects.toThrow(
      "invalid-symbol-search-query",
    );
    expect(mocks.readProviderJson).not.toHaveBeenCalled();
  });
});
