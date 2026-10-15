import { describe, expect, it } from "vitest";

import { decodeMdpBarsResponse, MDP_BAR_SCHEMA_ID, MDP_BAR_SCHEMA_SHA256 } from "./mdp-archive";

const EMPTY_DIAGNOSTIC_PAGE = {
  summary: {
    namespace: "diagnostic",
    dataset_id: "archive-1",
    schema_id: MDP_BAR_SCHEMA_ID,
    source: {
      provider: "alpaca",
      feed: "sip",
      entitlement: "unknown",
      numeric_encoding: "decimal_token",
    },
    row_count: "0",
    returned_rows: "0",
    content_sha256: "a".repeat(64),
    parquet_schema_sha256: MDP_BAR_SCHEMA_SHA256,
    cache_hit: false,
  },
  rows: [],
};

describe("MDP diagnostic archive browser adapter", () => {
  it("preserves a valid empty diagnostic page under the requested dataset identity", () => {
    expect(
      decodeMdpBarsResponse(EMPTY_DIAGNOSTIC_PAGE, { datasetId: "archive-1", symbol: "SPY" }),
    ).toBe(EMPTY_DIAGNOSTIC_PAGE);
  });

  it("rejects mismatched identity, another namespace, and unexpected wire fields", () => {
    expect(
      decodeMdpBarsResponse(EMPTY_DIAGNOSTIC_PAGE, { datasetId: "other", symbol: "SPY" }),
    ).toBeNull();
    expect(
      decodeMdpBarsResponse(
        {
          ...EMPTY_DIAGNOSTIC_PAGE,
          summary: { ...EMPTY_DIAGNOSTIC_PAGE.summary, namespace: "curated" },
        },
        { datasetId: "archive-1", symbol: "SPY" },
      ),
    ).toBeNull();
    expect(
      decodeMdpBarsResponse(
        { ...EMPTY_DIAGNOSTIC_PAGE, unexpected: true },
        { datasetId: "archive-1", symbol: "SPY" },
      ),
    ).toBeNull();
  });
});
