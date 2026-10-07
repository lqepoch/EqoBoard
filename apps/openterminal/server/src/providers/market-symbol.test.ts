import { describe, expect, it } from "vitest";
import { CRYPTO_SYMBOLS, isExplicitCryptoSymbol, usesSIPEquitySymbol } from "./market-symbol.js";
import { normalizeBinancePair } from "./binance.js";

describe("shared market symbol source classifier", () => {
  it("routes U.S. equity and ETF symbols to SIP", () => {
    expect(usesSIPEquitySymbol("QQQ")).toBe(true);
    expect(usesSIPEquitySymbol("brk.b")).toBe(true);
    expect(usesSIPEquitySymbol("BTC")).toBe(true);
    for (const symbol of CRYPTO_SYMBOLS) expect(usesSIPEquitySymbol(symbol), symbol).toBe(true);
  });

  it("keeps indexes, explicit crypto pairs, and foreign listings on their named research source", () => {
    for (const symbol of ["VIX", "^VIX", "BTC-USD", "SAP.DE", "7203.T", "BHP.AX", "RELIANCE.NS"]) {
      expect(usesSIPEquitySymbol(symbol), symbol).toBe(false);
    }
    expect(isExplicitCryptoSymbol("BTC-USD")).toBe(true);
    expect(isExplicitCryptoSymbol("btc-usd")).toBe(true);
    expect(isExplicitCryptoSymbol("BTC")).toBe(false);
    expect(isExplicitCryptoSymbol("UNKNOWN-USD")).toBe(false);
  });

  it("normalizes explicit crypto pairs only inside the Binance provider", () => {
    expect(normalizeBinancePair("BTC-USD")).toBe("BTCUSDT");
    expect(normalizeBinancePair("btc-usd")).toBe("BTCUSDT");
    expect(normalizeBinancePair("BTC")).toBe("BTCUSDT");
  });
});
