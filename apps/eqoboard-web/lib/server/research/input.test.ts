import { describe, expect, it } from "vitest";

import { parseResearchOperationInput } from "./input";

function parse(operation: string, query = "") {
  return parseResearchOperationInput(operation, new URLSearchParams(query));
}

describe("closed research BFF operation inputs", () => {
  it("allows only known operation IDs and exact fields", () => {
    expect(parse("proxy", "url=https%3A%2F%2Fexample.invalid")).toEqual({
      ok: false,
      error: "unknown-operation",
    });
    expect(parse("news", "symbol=AAPL&url=https%3A%2F%2Fexample.invalid")).toEqual({
      ok: false,
      error: "unknown-parameter",
    });
    expect(parse("crypto", "provider=binance")).toEqual({ ok: false, error: "unknown-parameter" });
  });

  it("normalizes symbols and bounds earnings-calendar batches", () => {
    expect(parse("news", "symbol=aapl")).toEqual({
      ok: true,
      value: { operation: "news", symbol: "AAPL" },
    });
    expect(parse("earnings-calendar", "symbols=AAPL%2CMSFT%2CNVDA")).toEqual({
      ok: true,
      value: { operation: "earnings-calendar", symbols: ["AAPL", "MSFT", "NVDA"] },
    });
    expect(
      parse(
        "earnings-calendar",
        `symbols=${Array.from({ length: 31 }, (_, index) => `A${index}`).join(",")}`,
      ),
    ).toEqual({
      ok: false,
      error: "invalid-parameter",
    });
    expect(parse("insider", "symbol=../../etc/passwd").ok).toBe(false);
  });

  it("requires explicit macro and market views", () => {
    expect(parse("macro").ok).toBe(false);
    expect(parse("macro", "region=eu")).toEqual({
      ok: true,
      value: { operation: "macro", region: "eu" },
    });
    expect(parse("screener", "market=us&changeMin=4&changeMax=-2").ok).toBe(false);
    expect(parse("heatmap", "market=nyse").ok).toBe(false);
  });

  it("accepts only the bounded no-parameter recap and exact symbol-search input", () => {
    expect(parse("recap")).toEqual({ ok: true, value: { operation: "recap" } });
    expect(parse("recap", "limit=20")).toEqual({ ok: false, error: "unknown-parameter" });
    expect(parse("symbol-search", "query=AAPL")).toEqual({
      ok: true,
      value: { operation: "symbol-search", query: "AAPL" },
    });
    expect(parse("symbol-search", `query=${"A".repeat(64)}`).ok).toBe(true);
    expect(parse("symbol-search", `query=${"A".repeat(65)}`).ok).toBe(false);
    expect(parse("symbol-search", "query=%20AAPL").ok).toBe(false);
    expect(parse("symbol-search", "query=AAPL&query=MSFT").ok).toBe(false);
    expect(parse("symbol-search", "query=AAPL&limit=20")).toEqual({
      ok: false,
      error: "unknown-parameter",
    });
  });

  it("rejects unbounded, duplicate, fractional-limit, and non-finite numeric filters", () => {
    expect(parse("screener", "market=us&volumeMin=-1").ok).toBe(false);
    expect(parse("screener", "market=us&limit=500.5").ok).toBe(false);
    expect(parse("screener", "market=us&market=eu").ok).toBe(false);
    expect(parse("screener", "market=us&changeMax=Infinity").ok).toBe(false);
    expect(parse("screener", "market=eu&marketCapMin=1000000000").ok).toBe(true);
  });
});
