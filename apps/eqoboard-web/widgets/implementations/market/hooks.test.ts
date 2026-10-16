import { describe, expect, it } from "vitest";

import type {
  MarketLeaseSnapshot,
  MarketStockLeaseCapacity,
} from "../../../stores/market/market-store";
import { planStockQuoteRead } from "./hooks";

function lease(
  overrides: Partial<MarketLeaseSnapshot> = {},
): MarketLeaseSnapshot {
  return {
    generation: 0,
    acknowledgedAt: null,
    rawAck: null,
    coverage: "unknown",
    membershipVerification: "unverified",
    requestedCount: 0,
    selectedCount: 0,
    selectedSymbols: [],
    leasedCount: 0,
    omittedCount: 0,
    ...overrides,
  };
}

function capacity(
  overrides: Partial<MarketStockLeaseCapacity> = {},
): MarketStockLeaseCapacity {
  return { status: "available", limit: 32, fixedSymbols: ["QQQ", "SPY"], ...overrides };
}

describe("stock quote lease gate", () => {
  it("waits for the authoritative capacity and lease acknowledgement before reading", () => {
    const symbols = ["AAPL"];
    expect(planStockQuoteRead(symbols, true, lease(), capacity({ status: "pending", limit: null }))).toMatchObject({
      status: "wait",
    });
    expect(
      planStockQuoteRead(
        symbols,
        true,
        lease({ coverage: "pending" }),
        capacity(),
      ),
    ).toMatchObject({ status: "wait" });
    expect(
      planStockQuoteRead(symbols, true, lease(), capacity({ status: "unavailable", limit: null })),
    ).toMatchObject({ status: "unsupported" });
  });

  it("reads only acknowledged symbols and reports the omitted watchlist rows", () => {
    const symbols = [
      ...Array.from({ length: 48 }, (_, index) => `S${String(index).padStart(3, "0")}`),
      "QQQ",
      "SPY",
    ];
    const selectedSymbols = ["QQQ", "SPY", ...symbols.slice(0, 30)];
    const plan = planStockQuoteRead(
      symbols,
      true,
      lease({
        acknowledgedAt: 1_000,
        coverage: "partial",
        requestedCount: 50,
        selectedCount: 32,
        selectedSymbols,
        leasedCount: 32,
        omittedCount: 18,
      }),
      capacity(),
    );

    expect(plan).toEqual({
      status: "read",
      symbols: [...symbols.slice(0, 30), "QQQ", "SPY"],
      omittedSymbols: symbols.slice(30, 48),
    });
  });

  it("leaves market:read-only consumers independent of stock subscription leases", () => {
    expect(
      planStockQuoteRead(
        ["AAPL", "MSFT"],
        false,
        lease({ coverage: "error" }),
        capacity({ status: "unavailable", limit: null }),
      ),
    ).toEqual({ status: "read", symbols: ["AAPL", "MSFT"], omittedSymbols: [] });
  });
});
