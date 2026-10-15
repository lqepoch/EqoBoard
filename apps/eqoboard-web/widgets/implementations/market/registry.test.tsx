import { describe, expect, it } from "vitest";

import { marketWidgetRegistrations } from "./registry";

describe("native market widget registrations", () => {
  it("statically registers the migrated market and options surfaces with explicit provenance", () => {
    expect(marketWidgetRegistrations.map((entry) => entry.manifest.id)).toEqual([
      "market.quote",
      "market.watchlist",
      "market.options-chain",
      "market.iv-skew",
      "market.option-tape",
      "market.feed-status",
      "market.orderbook",
      "market.vertical-preview",
    ]);
    for (const registration of marketWidgetRegistrations) {
      expect(registration.manifest.provenanceId).toBe(registration.provenance.provenanceId);
      expect(registration.provenance.origin).toBe("first-party");
    }
  });

  it("leaves unsupported depth inert and scopes the preview to its single disabled action", () => {
    const orderbook = marketWidgetRegistrations.find((entry) => entry.manifest.id === "market.orderbook");
    expect(orderbook?.allowedReadOperations).toEqual([]);
    expect(orderbook?.allowedActions).toEqual([]);
    expect(orderbook?.manifest.requiredPermissions).toEqual([]);
    expect(orderbook?.manifest.provenancePolicy).toBe("no-market-data");

    const preview = marketWidgetRegistrations.find((entry) => entry.manifest.id === "market.vertical-preview");
    expect(preview?.allowedReadOperations).toEqual([]);
    expect(preview?.allowedActions).toEqual(["orders.preview.vertical"]);
    expect(preview?.manifest.requiredPermissions).toEqual(["orders:preview"]);
  });

  it("budgets the two options snapshot reads together at their 30-second cadence", () => {
    for (const id of ["market.options-chain", "market.iv-skew"]) {
      const registration = marketWidgetRegistrations.find((entry) => entry.manifest.id === id);
      expect(registration?.manifest.refresh).toMatchObject({
        mode: "poll",
        minIntervalMs: 30_000,
        maxRequestsPerMinute: 4,
        maxConcurrentRequests: 1,
        whenHidden: "pause",
      });
    }
  });
});
