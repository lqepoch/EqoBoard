import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
});
