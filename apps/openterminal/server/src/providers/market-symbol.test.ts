import { describe, expect, it } from "vitest";
import { usesSIPEquitySymbol } from "./market-symbol.js";

describe("shared market symbol source classifier", () => {
  it("routes U.S. equity and ETF symbols to SIP", () => {
    expect(usesSIPEquitySymbol("QQQ")).toBe(true);
    expect(usesSIPEquitySymbol("brk.b")).toBe(true);
  });

  it("keeps indexes, crypto pairs, and foreign listings on their named research source", () => {
    for (const symbol of ["VIX", "^VIX", "BTC-USD", "SAP.DE", "7203.T", "BHP.AX", "RELIANCE.NS"]) {
      expect(usesSIPEquitySymbol(symbol), symbol).toBe(false);
    }
  });
});
