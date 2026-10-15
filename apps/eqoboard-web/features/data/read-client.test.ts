import { describe, expect, it, vi } from "vitest";

import type { AuthUiSnapshot, Permission } from "../../lib/contracts/auth";
import { createNativeDataReadClient, type NativeFetch } from "./read-client";

function terminalAuth(permissions: readonly Permission[]): AuthUiSnapshot {
  return {
    status: "authenticated",
    authenticated: true,
    displayName: "Terminal test principal",
    permissions,
    storagePartition: "terminal-test-partition",
    runtimeMode: "terminal",
  };
}

describe("native read permission boundary", () => {
  it("requires both research:read and market:read for recap while symbol search requires research:read", async () => {
    let auth = terminalAuth(["research:read"]);
    const fetcher = vi.fn<NativeFetch>(async () => new Response("{}", {
      headers: { "content-type": "application/json" },
    }));
    const client = createNativeDataReadClient(() => auth, fetcher);
    const signal = new AbortController().signal;

    await expect(client.read("research.recap", {}, { signal })).rejects.toThrow();
    await expect(client.read("research.symbolSearch", { query: "AAPL" }, { signal })).resolves.toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/research/data/symbol-search?query=AAPL");

    auth = terminalAuth(["research:read", "market:read"]);
    await expect(client.read("research.recap", {}, { signal })).resolves.toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/research/data/recap");
  });
});
