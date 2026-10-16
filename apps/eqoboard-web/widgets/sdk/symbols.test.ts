import { describe, expect, it } from "vitest";
import { isWidgetSymbol } from "./symbols";

describe("widget symbol boundary", () => {
  it("accepts bounded canonical workspace symbols only", () => {
    expect(isWidgetSymbol("SPY")).toBe(true);
    expect(isWidgetSymbol("BRK.B")).toBe(true);
    expect(isWidgetSymbol("BTC-USD")).toBe(true);
    expect(isWidgetSymbol("spy")).toBe(false);
    expect(isWidgetSymbol("SPY/INVALID")).toBe(false);
    expect(isWidgetSymbol(" ")).toBe(false);
    expect(isWidgetSymbol("A".repeat(25))).toBe(false);
  });
});
