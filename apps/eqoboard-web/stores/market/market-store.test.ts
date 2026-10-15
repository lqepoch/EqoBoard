import { describe, expect, it } from "vitest";

import { MarketStore } from "./market-store";

function quote(overrides: Record<string, unknown> = {}) {
  return {
    kind: "stock_quote",
    source_mode: "unknown",
    source_label: "Configured source",
    source_entitlement: "unknown",
    gateway_instance_id: "gateway-a",
    event_time: null,
    received_at: "2026-10-15T02:00:00Z",
    connection_epoch: 1,
    local_sequence: 1,
    symbol: "SPY",
    bid: null,
    ask: null,
    extra_provider_field: { value: "preserved" },
    ...overrides,
  };
}

describe("native market store", () => {
  it("preserves Gateway JSON and advances only monotonically within an instance", () => {
    let now = 10_000;
    const store = new MarketStore(() => now);
    const raw = quote();
    store.acceptBatch([raw], now);
    store.acceptBatch([quote({ local_sequence: 1, bid: 99 })], now + 1);

    const snapshot = store.getSnapshot();
    expect(snapshot.lastSequence).toBe(1);
    expect(snapshot.stockQuotes.SPY).toEqual(raw);
    expect(snapshot.stockQuotes.SPY?.extra_provider_field).toEqual({ value: "preserved" });
    expect(snapshot.feeds.stocks.freshness).toBe("fresh");
    now += 5_001;
    store.tick(now);
    expect(store.getSnapshot().feeds.stocks.freshness).toBe("stale");
  });

  it("keeps the instance-wide watermark when a sequenced event has an invalid display identity", () => {
    const store = new MarketStore(() => 10_000);
    store.acceptBatch([quote({ local_sequence: 1 })], 10_000);
    store.acceptBatch([quote({ local_sequence: 3, symbol: "" })], 12_000);
    store.acceptBatch([quote({ local_sequence: 2, bid: 98 })], 13_000);

    const snapshot = store.getSnapshot();
    expect(snapshot.lastSequence).toBe(3);
    expect(snapshot.lastEventAt).toBe(12_000);
    expect(snapshot.stockQuotes.SPY?.local_sequence).toBe(1);
    expect(snapshot.feeds.stocks.lastSequence).toBe(1);
    expect(snapshot.feeds.stocks.lastMessageAt).toBe(10_000);
  });

  it("advances the instance-wide watermark for unknown Gateway event kinds", () => {
    const store = new MarketStore(() => 10_000);
    store.acceptBatch([quote({ local_sequence: 1 })], 10_000);
    store.acceptBatch([{
      kind: "future_gateway_event",
      gateway_instance_id: "gateway-a",
      connection_epoch: 1,
      local_sequence: 3,
    }], 12_000);
    store.acceptBatch([quote({ local_sequence: 2, bid: 98 })], 13_000);

    const snapshot = store.getSnapshot();
    expect(snapshot.lastSequence).toBe(3);
    expect(snapshot.lastEventAt).toBe(12_000);
    expect(snapshot.stockQuotes.SPY?.local_sequence).toBe(1);
  });

  it("clears one feed on epoch change and all old Gateway state on instance change", () => {
    const store = new MarketStore(() => 1_000);
    store.acceptBatch([quote(), {
      kind: "option_trade",
      gateway_instance_id: "gateway-a",
      connection_epoch: 4,
      local_sequence: 2,
      symbol: "SPY261218C00600000",
      event_time: null,
      received_at: "2026-10-15T02:00:00Z",
      price: 1,
      size: 1,
      source_mode: "unknown",
      source_label: "Unknown",
      source_entitlement: "unknown",
    }]);
    store.acceptBatch([quote({ connection_epoch: 2, local_sequence: 3 })]);
    expect(store.getSnapshot().stockQuotes.SPY?.connection_epoch).toBe(2);
    expect(store.getSnapshot().optionTrades).toHaveLength(1);

    store.acceptBatch([quote({ gateway_instance_id: "gateway-b", local_sequence: 1, connection_epoch: 1 })]);
    const snapshot = store.getSnapshot();
    expect(snapshot.gatewayInstanceId).toBe("gateway-b");
    expect(snapshot.lastSequence).toBe(1);
    expect(snapshot.optionTrades).toHaveLength(0);
    expect(snapshot.stockQuotes.SPY?.gateway_instance_id).toBe("gateway-b");
  });

  it("fences stale lease acknowledgements and reports cap omissions", () => {
    let now = 5_000;
    const store = new MarketStore(() => now);
    const targetKey = JSON.stringify(Array.from({ length: 16 }, (_, index) => `SPY261218C${String(index + 1).padStart(8, "0")}`));
    store.setLeaseTargets("options", 22, 16, targetKey);
    const ack = { active: 16, max: 16, expires_in_seconds: 90, generation: 2, state: "lease_active" };
    store.setLeaseAck("options", 2, 16, ack, targetKey);
    now += 1_000;
    store.setLeaseAck("options", 1, 22, { active: 22, max: 22, expires_in_seconds: 90, generation: 1, state: "lease_active" }, targetKey);
    const lease = store.getSnapshot().leases.options;
    expect(lease.generation).toBe(2);
    expect(lease.acknowledgedAt).toBe(5_000);
    expect(lease.requestedCount).toBe(22);
    expect(lease.leasedCount).toBe(16);
    expect(lease.omittedCount).toBe(6);
    expect(lease.rawAck).toEqual(ack);
    expect(lease.membershipVerification).toBe("unverified");
  });

  it("ignores acknowledgements for a prior symbol target", () => {
    const store = new MarketStore(() => 5_000);
    store.setLeaseTargets("stocks", 2, 2, "target-a");
    store.setLeaseTargets("stocks", 1, 1, "target-b");
    store.setLeaseAck("stocks", 0, 1, { active: 1, max: 1_000, expires_in_seconds: 90 }, "target-a");

    const lease = store.getSnapshot().leases.stocks;
    expect(lease.acknowledgedAt).toBeNull();
    expect(lease.rawAck).toBeNull();
    expect(lease.coverage).toBe("pending");
    expect(lease.requestedCount).toBe(1);
    expect(lease.selectedCount).toBe(1);
  });

  it("resets raw market observations when the identity partition changes", () => {
    const store = new MarketStore(() => 1_000);
    store.acceptBatch([quote()]);
    store.resetForIdentityBoundary();
    expect(store.getSnapshot().gatewayInstanceId).toBeNull();
    expect(store.getSnapshot().stockQuotes).toEqual({});
    expect(store.getSnapshot().lastSequence).toBeNull();
  });
});
