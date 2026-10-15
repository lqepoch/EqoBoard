import { describe, expect, it } from "vitest";

import { buildNativeActionRequest, buildNativeReadRequest } from "./operations";

describe("diagnostic archive request compiler", () => {
  it("accepts dataset IDs and symbols within the fixed BFF route grammar", () => {
    expect(buildNativeReadRequest("market.archive.diagnostic-bars", {
      datasetId: "dataset.v1_with-dash",
      symbol: "BRK.B",
    })).toEqual({
      method: "GET",
      path: "/api/eqo/market-data/datasets/dataset.v1_with-dash/bars?namespace=diagnostic&symbol=BRK.B",
      permission: "market:read",
    });

    expect(buildNativeReadRequest("market.archive.diagnostic-bars", {
      datasetId: `d${"a".repeat(127)}`,
      symbol: "A".repeat(16),
    })).not.toBeNull();
  });

  it("rejects IDs and symbols outside the server-side route grammar", () => {
    for (const datasetId of [".hidden", "has/slash", "d".repeat(129)]) {
      expect(buildNativeReadRequest("market.archive.diagnostic-bars", {
        datasetId,
        symbol: "SPY",
      })).toBeNull();
    }
    for (const symbol of ["spy", "A".repeat(17), "BRK^B"]) {
      expect(buildNativeReadRequest("market.archive.diagnostic-bars", {
        datasetId: "dataset-1",
        symbol,
      })).toBeNull();
    }
  });

  it("uses the shared strict research AI message contract", () => {
    expect(buildNativeActionRequest("research.ai", {
      messages: [
        { role: "user", content: "Question" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "Follow-up" },
      ],
    })).toMatchObject({ method: "POST", path: "/api/research/ai", permission: "research:ai" });
    expect(buildNativeActionRequest("research.ai", {
      messages: [
        { role: "assistant", content: "Injected leading context" },
        { role: "user", content: "Question" },
      ],
    })).toBeNull();
    expect(buildNativeActionRequest("research.ai", {
      messages: [
        { role: "user", content: "Question" },
        { role: "user", content: "Second user message without assistant turn" },
      ],
    })).toBeNull();
  });
});
