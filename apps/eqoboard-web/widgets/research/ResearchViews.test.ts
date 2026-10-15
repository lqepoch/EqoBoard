import { describe, expect, it } from "vitest";

import { buildResearchViewRequest, createDefaultResearchViewConfig, parseResearchViewConfig } from "./ResearchViews";

describe("native research view configuration", () => {
  it("accepts only the fields and bounds belonging to each registered view", () => {
    expect(parseResearchViewConfig("screener", createDefaultResearchViewConfig("screener")).ok).toBe(true);
    expect(parseResearchViewConfig("screener", { ...createDefaultResearchViewConfig("screener"), path: "https://provider.invalid" }).ok).toBe(false);
    expect(parseResearchViewConfig("screener", { ...createDefaultResearchViewConfig("screener"), limit: 501 }).ok).toBe(false);
    expect(parseResearchViewConfig("screener", {
      ...createDefaultResearchViewConfig("screener"), changeMin: "20", changeMax: "-5",
    }).ok).toBe(false);
  });

  it("does not request symbol-specific views without a user or active-symbol selection", () => {
    const config = createDefaultResearchViewConfig("earnings-history");
    expect(buildResearchViewRequest("earnings-history", config)).toBeNull();
    expect(buildResearchViewRequest("earnings-history", config, "SPY")).toEqual({
      operation: "research.earningsHistory",
      input: { symbol: "SPY" },
    });
  });

  it("builds bounded same-origin inputs and uses active symbol for scoped calendar reads", () => {
    expect(buildResearchViewRequest("earnings-calendar", createDefaultResearchViewConfig("earnings-calendar"), "QQQ")).toEqual({
      operation: "research.earningsCalendar",
      input: { symbols: ["QQQ"] },
    });
    const screener = parseResearchViewConfig("screener", {
      ...createDefaultResearchViewConfig("screener"), market: "eu", sector: "Technology", changeMin: "2", limit: 50,
    });
    expect(screener.ok && buildResearchViewRequest("screener", screener.value)).toEqual({
      operation: "research.screener",
      input: { market: "eu", sector: "Technology", changeMin: 2, sort: "marketCap", direction: "desc", limit: 50 },
    });
  });
});
