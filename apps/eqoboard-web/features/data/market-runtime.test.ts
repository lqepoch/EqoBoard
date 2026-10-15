import { describe, expect, it, vi } from "vitest";

import { PERMISSIONS, type AuthUiSnapshot } from "../../lib/contracts/auth";
import { MarketStore } from "../../stores/market/market-store";
import { createNativeDataReadClient } from "./read-client";
import type { NativeFetch } from "./read-client";
import { startMarketHostBackgroundServices } from "./market-runtime";

function researchAuth(): AuthUiSnapshot {
  return {
    status: "authenticated",
    authenticated: true,
    displayName: "Research test principal",
    permissions: PERMISSIONS,
    storagePartition: "research-test-partition",
    runtimeMode: "research",
  };
}

describe("research runtime market isolation", () => {
  it("starts no terminal stream or lease transport even when signed permissions include them", () => {
    const store = new MarketStore(() => 1_000);
    const attachStream = vi.fn(() => vi.fn());
    const startLeases = vi.fn();
    const stopLeases = vi.fn();

    const cleanup = startMarketHostBackgroundServices(researchAuth(), {
      store,
      attachStream,
      startLeases,
      stopLeases,
    });

    expect(attachStream).not.toHaveBeenCalled();
    expect(startLeases).not.toHaveBeenCalled();
    expect(store.getSnapshot().transportState).toBe("unavailable");
    cleanup();
    expect(stopLeases).not.toHaveBeenCalled();
  });

  it("dispatches no terminal market reads but keeps the explicitly shared diagnostic archive operation", async () => {
    let calls = 0;
    const fetcher: NativeFetch = async () => {
      calls += 1;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const client = createNativeDataReadClient(researchAuth, fetcher);
    const signal = new AbortController().signal;

    await expect(client.read("market.quotes", { symbols: ["SPY"] }, { signal })).rejects.toThrow();
    await expect(client.read("market.options.chain", { symbol: "SPY", expiry: "2027-01-15" }, { signal })).rejects.toThrow();
    await expect(client.read("market.status", {}, { signal })).rejects.toThrow();
    await expect(client.read("market.history.core-bars", { symbol: "SPY" }, { signal })).rejects.toThrow();
    expect(calls).toBe(0);

    await expect(client.read("market.archive.diagnostic-bars", { datasetId: "archive-1", symbol: "SPY" }, { signal })).resolves.toEqual({});
    expect(calls).toBe(1);
  });
});
