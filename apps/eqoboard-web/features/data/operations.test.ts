import { describe, expect, it } from "vitest";

import { buildNativeActionRequest, buildNativeReadRequest } from "./operations";
import { isNativeReadAllowedInRuntime } from "./runtime-policy";

describe("fixed recap and symbol-search read operations", () => {
  it("compiles only the fixed same-origin routes and keeps the recap permission conjunction", () => {
    expect(buildNativeReadRequest("research.recap", {})).toEqual({
      method: "GET",
      path: "/api/research/data/recap",
      permission: ["research:read", "market:read"],
    });
    expect(buildNativeReadRequest("research.symbolSearch", { query: "NVDA earnings" })).toEqual({
      method: "GET",
      path: "/api/research/data/symbol-search?query=NVDA+earnings",
      permission: "research:read",
    });
    const searchRequest = buildNativeReadRequest("research.symbolSearch", { query: "AAPL" });
    expect(searchRequest?.path).toBe("/api/research/data/symbol-search?query=AAPL");
    expect(searchRequest?.path).not.toContain("limit");
    expect(
      buildNativeReadRequest("research.symbolSearch", { query: "AAPL", limit: 20 }),
    ).toBeNull();
  });

  it("rejects empty, untrimmed, overlong, and control-character search terms", () => {
    for (const query of ["", "   ", " AAPL", "AAPL ", "x".repeat(65), "AAPL\nNVDA"]) {
      expect(buildNativeReadRequest("research.symbolSearch", { query })).toBeNull();
    }
  });

  it("keeps both new operations terminal-only", () => {
    for (const operationId of ["research.recap", "research.symbolSearch"] as const) {
      expect(isNativeReadAllowedInRuntime(operationId, "terminal")).toBe(true);
      expect(isNativeReadAllowedInRuntime(operationId, "research")).toBe(false);
    }
  });
});

describe("diagnostic archive request compiler", () => {
  it("accepts dataset IDs and symbols within the fixed BFF route grammar", () => {
    expect(
      buildNativeReadRequest("market.archive.diagnostic-bars", {
        datasetId: "dataset.v1_with-dash",
        symbol: "BRK.B",
      }),
    ).toEqual({
      method: "GET",
      path: "/api/eqo/market-data/datasets/dataset.v1_with-dash/bars?namespace=diagnostic&symbol=BRK.B",
      permission: "market:read",
    });

    expect(
      buildNativeReadRequest("market.archive.diagnostic-bars", {
        datasetId: `d${"a".repeat(127)}`,
        symbol: "A".repeat(16),
      }),
    ).not.toBeNull();
  });

  it("rejects IDs and symbols outside the server-side route grammar", () => {
    for (const datasetId of [".hidden", "has/slash", "d".repeat(129)]) {
      expect(
        buildNativeReadRequest("market.archive.diagnostic-bars", {
          datasetId,
          symbol: "SPY",
        }),
      ).toBeNull();
    }
    for (const symbol of ["spy", "A".repeat(17), "BRK^B"]) {
      expect(
        buildNativeReadRequest("market.archive.diagnostic-bars", {
          datasetId: "dataset-1",
          symbol,
        }),
      ).toBeNull();
    }
  });

  it("uses the shared strict research AI message contract", () => {
    expect(
      buildNativeActionRequest("research.ai", {
        messages: [
          { role: "user", content: "Question" },
          { role: "assistant", content: "Answer" },
          { role: "user", content: "Follow-up" },
        ],
      }),
    ).toMatchObject({ method: "POST", path: "/api/research/ai", permission: "research:ai" });
    expect(
      buildNativeActionRequest("research.ai", {
        messages: [
          { role: "assistant", content: "Injected leading context" },
          { role: "user", content: "Question" },
        ],
      }),
    ).toBeNull();
    expect(
      buildNativeActionRequest("research.ai", {
        messages: [
          { role: "user", content: "Question" },
          { role: "user", content: "Second user message without assistant turn" },
        ],
      }),
    ).toBeNull();
  });
});
