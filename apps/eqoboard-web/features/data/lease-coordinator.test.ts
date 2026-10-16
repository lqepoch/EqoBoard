import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeMarketStockLeaseCapacity,
  loadMarketStockLeaseCapacity,
  MarketLeaseCoordinator,
  type LeaseKind,
  type MarketLeaseSender,
  type OptionsLeaseInput,
  type StockLeaseInput,
} from "./lease-coordinator";
import { MarketStore } from "../../stores/market/market-store";

describe("shared market lease coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks an unresponsive Gateway status read unavailable at its deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const readSignals: AbortSignal[] = [];
    const result = loadMarketStockLeaseCapacity(
      (signal) => {
        readSignals.push(signal);
        return new Promise<unknown>(() => {});
      },
      controller.signal,
      100,
    );

    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({ status: "unavailable", reason: "timeout" });
    expect(readSignals[0]?.aborted).toBe(true);
  });

  it("unions targets, caps options centrally, and sends a higher-generation cleanup tombstone", async () => {
    vi.useFakeTimers();
    const store = new MarketStore(() => 5_000);
    const sent: { feed: LeaseKind; input: StockLeaseInput | OptionsLeaseInput }[] = [];
    const send: MarketLeaseSender = async (feed, input) => {
      sent.push({ feed, input });
      return feed === "stocks"
        ? { active: input.symbols.length, max: 1_000, expires_in_seconds: 90 }
        : {
            active: input.symbols.length,
            max: 16,
            expires_in_seconds: 90,
            generation: (input as OptionsLeaseInput).generation,
            state: "lease_active",
          };
    };
    const coordinator = new MarketLeaseCoordinator(store, send);
    const instanceId = "00000000-0000-4000-8000-000000000001";
    const symbols = Array.from(
      { length: 17 },
      (_, index) => `SPY261218C${String(600_000 + index * 1_000).padStart(8, "0")}`,
    );

    coordinator.start();
    coordinator.setConsumer(instanceId, "options", symbols);
    await vi.advanceTimersByTimeAsync(50);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.feed).toBe("options");
    const first = sent[0]?.input as OptionsLeaseInput;
    expect(first.symbols).toHaveLength(16);
    expect(first.generation).toBe(1);
    expect(store.getSnapshot().leases.options).toMatchObject({
      generation: 1,
      requestedCount: 17,
      selectedCount: 16,
      leasedCount: 16,
      omittedCount: 1,
      coverage: "partial",
    });

    coordinator.removeConsumer(instanceId, "options");
    await vi.advanceTimersByTimeAsync(50);
    const cleanup = sent.at(-1)?.input as OptionsLeaseInput;
    expect(cleanup.generation).toBe(2);
    expect(cleanup.symbols).toEqual([]);
    expect(store.getSnapshot().leases.options).toMatchObject({
      generation: 2,
      requestedCount: 0,
      selectedCount: 0,
      leasedCount: 0,
    });

    coordinator.stop();
    coordinator.dispose();
    vi.clearAllTimers();
  });

  it("fails closed without Gateway capacity and reselects late fixed symbols within the active cap", async () => {
    vi.useFakeTimers();
    const store = new MarketStore(() => 5_000);
    const sent: StockLeaseInput[] = [];
    const coordinator = new MarketLeaseCoordinator(store, async (feed, input) => {
      if (feed !== "stocks") throw new Error("unexpected-options-lease");
      sent.push(input as StockLeaseInput);
      return { active: 32, max: 32, expires_in_seconds: 90 };
    });
    const instanceId = "00000000-0000-4000-8000-000000000002";
    const symbols = [
      ...Array.from({ length: 48 }, (_, index) => `S${String(index).padStart(3, "0")}`),
      "QQQ",
      "SPY",
    ];

    expect(decodeMarketStockLeaseCapacity({ max_stock_subscriptions: 32 })).toBeNull();
    expect(
      decodeMarketStockLeaseCapacity({
        max_stock_subscriptions: 32,
        stock_symbols: ["QQQ", "SPY"],
      }),
    ).toEqual({ limit: 32, fixedSymbols: ["QQQ", "SPY"] });

    coordinator.start();
    coordinator.setConsumer(instanceId, "stocks", symbols);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(0);
    expect(store.getSnapshot().leases.stocks.coverage).toBe("unknown");

    const status = { max_stock_subscriptions: 32, stock_symbols: ["QQQ", "SPY"] };
    coordinator.setStockCapacityFromStatus(status);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.symbols).toHaveLength(32);
    expect(sent[0]?.symbols.slice(0, 2)).toEqual(["QQQ", "SPY"]);
    expect(store.getSnapshot().leases.stocks).toMatchObject({
      requestedCount: 50,
      selectedCount: 32,
      omittedCount: 18,
      coverage: "partial",
    });
    expect(store.getSnapshot().leases.stocks.selectedSymbols).toEqual([
      "QQQ",
      "SPY",
      ...symbols.slice(0, 30),
    ]);

    coordinator.gatewayInstanceChanged();
    expect(store.getSnapshot().stockLeaseCapacity.status).toBe("pending");
    expect(store.getSnapshot().leases.stocks).toMatchObject({
      coverage: "pending",
      leasedCount: 0,
    });
    coordinator.setStockCapacityFromStatus(status);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.symbols).toEqual(sent[0]?.symbols);

    coordinator.stop();
    coordinator.dispose();
    vi.clearAllTimers();
  });
});
