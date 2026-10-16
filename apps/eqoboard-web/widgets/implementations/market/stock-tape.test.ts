import { describe, expect, it } from "vitest";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import { stockTapeRows, stockTapeSummary, utcClockLabel } from "./stock-tape";

function trade(
  sequence: number,
  price: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    kind: "stock_trade",
    symbol: "SPY",
    price,
    size: 100,
    gateway_instance_id: "gw-1",
    connection_epoch: 1,
    local_sequence: sequence,
    event_time: "2026-10-16T14:30:01.123456789Z",
    received_at: "2026-10-16T14:30:01.200Z",
    source_label: "Futu OpenD",
    source_entitlement: "unknown",
    ...overrides,
  };
}

function snapshot(stockTrades: readonly Record<string, unknown>[]): MarketHostSnapshot {
  return {
    revision: 1,
    transportState: "connected",
    transportError: null,
    gatewayInstanceId: "gw-1",
    lastSequence: null,
    lastEventAt: null,
    stockLeaseCapacity: { status: "unknown", limit: null, fixedSymbols: [] },
    feeds: {
      stocks: {
        connectionEpoch: 1,
        lastSequence: null,
        lastMessageAt: null,
        freshness: "fresh",
        rawStatus: { source_label: "Futu OpenD", source_entitlement: "unknown" },
      },
      options: {
        connectionEpoch: null,
        lastSequence: null,
        lastMessageAt: null,
        freshness: "unknown",
        rawStatus: null,
      },
    },
    leases: {} as MarketHostSnapshot["leases"],
    stockQuotes: {},
    stockTrades,
    optionQuotes: {},
    optionTrades: [],
  } as unknown as MarketHostSnapshot;
}

describe("stock time and sales", () => {
  it("labels only RFC3339 UTC event times with millisecond precision", () => {
    expect(utcClockLabel("2026-10-16T14:30:01.123456789Z")).toBe("14:30:01.123");
    expect(utcClockLabel("2026-10-16T14:30:01Z")).toBe("14:30:01");
    expect(utcClockLabel("2026-10-16T14:30:01+00:00")).toBe("14:30:01");
    expect(utcClockLabel("2026-10-16T10:30:01-04:00")).toBeNull();
    expect(utcClockLabel("not a timestamp")).toBeNull();
    expect(utcClockLabel(undefined)).toBeNull();
  });

  it("lists prints newest first and compares each print only with its predecessor", () => {
    const rows = stockTapeRows(
      snapshot([trade(1, 100), trade(2, 101), trade(3, 101), trade(4, 99)]),
      "SPY",
    );
    expect(rows.map((row) => row.sequence)).toEqual([4, 3, 2, 1]);
    expect(rows.map((row) => row.direction)).toEqual(["down", "flat", "up", "first"]);
    expect(rows[0]).toMatchObject({
      price: 99,
      size: 100,
      clock: "14:30:01.123",
      source: "Futu OpenD",
      entitlement: "unknown",
    });
  });

  it("keeps only the requested symbol on the newest Gateway stream identity", () => {
    const rows = stockTapeRows(
      snapshot([
        trade(1, 100),
        trade(2, 50, { symbol: "QQQ" }),
        trade(3, 70, { connection_epoch: 0 }),
        trade(4, 101, { connection_epoch: 2 }),
        trade(5, 102, { connection_epoch: 2 }),
      ]),
      "SPY",
    );
    expect(rows.map((row) => row.sequence)).toEqual([5, 4]);
    expect(rows.map((row) => row.direction)).toEqual(["up", "first"]);
  });

  it("drops malformed prints and returns nothing without a symbol", () => {
    const rows = stockTapeRows(
      snapshot([trade(1, Number.NaN), trade(2, 100, { local_sequence: "3" }), trade(3, 101)]),
      "SPY",
    );
    expect(rows.map((row) => row.sequence)).toEqual([3]);
    expect(stockTapeRows(snapshot([trade(1, 100)]), "")).toEqual([]);
  });

  it("summarises the stock feed source and entitlement from the feed status", () => {
    expect(stockTapeSummary(snapshot([]))).toMatchObject({
      freshness: "fresh",
      transportState: "connected",
      connectionEpoch: 1,
      source: "Futu OpenD",
      entitlement: "unknown",
    });
  });
});
