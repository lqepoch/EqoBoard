import { describe, expect, it, vi } from "vitest";

import { PERMISSIONS, type AuthUiSnapshot } from "../../lib/contracts/auth";
import type { NativeFetch } from "./read-client";
import { createNativeActionClient } from "./action-client";

function researchAuthWithExcessPermissions(): AuthUiSnapshot {
  return {
    status: "authenticated",
    authenticated: true,
    displayName: "Research test principal",
    permissions: PERMISSIONS,
    storagePartition: "research-test-partition",
    runtimeMode: "research",
  };
}

describe("native action runtime boundary", () => {
  it("does not dispatch any action in research mode even if a UI snapshot carries excess permissions", async () => {
    const fetcher = vi.fn<NativeFetch>(async () => new Response("{}", {
      headers: { "content-type": "application/json" },
    }));
    const client = createNativeActionClient(researchAuthWithExcessPermissions, fetcher);
    const signal = new AbortController().signal;

    await expect(client.invoke("research.ai", {
      messages: [{ role: "user", content: "Explain this note." }],
    }, { signal })).rejects.toThrow();
    await expect(client.invoke("orders.preview.vertical", {
      broker: "alpaca",
      environment: "paper",
      kind: "vertical",
      symbol: null,
      quantity: 1,
      limit_price: 1.25,
      net_effect: "debit",
      legs: [
        { symbol: "SPY261016C00500000", side: "buy" },
        { symbol: "SPY261016C00510000", side: "sell" },
      ],
    }, { signal })).rejects.toThrow();

    expect(fetcher).not.toHaveBeenCalled();
  });
});
