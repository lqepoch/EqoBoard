import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { validateMdpBarsResponse } = await import("./mdp-archive");

function response() {
  return {
    summary: {
      namespace: "diagnostic",
      dataset_id: "archive-1",
      schema_id: "lqepoch.us_equity_trade_bar_1m.v1",
      source: { provider: "synthetic", feed: "synthetic", entitlement: "unknown", numeric_encoding: "decimal_token" },
      row_count: "1",
      returned_rows: "1",
      content_sha256: "0".repeat(64),
      parquet_schema_sha256: "5e761a91d880e0002aeafe6dc2083b7c8a0ff2ba486d5d93582fbb4479146cb0",
      cache_hit: false,
    },
    rows: [{
      schema_version: 1,
      source_provider: "synthetic",
      source_feed: "synthetic",
      source_entitlement: "unknown",
      source_numeric_encoding: "decimal_token",
      symbol: "QQQ",
      bar_start_utc: "2026-10-07T13:30:00Z",
      bar_end_exclusive_utc: "2026-10-07T13:31:00Z",
      available_at_utc: "2026-10-07T13:31:00Z",
      trade_date: "2026-10-07",
      session_id: "synthetic-one-minute-session",
      session_timezone: "UTC",
      session_policy_id: "synthetic-fixed-session-v1",
      session_policy_sha256: "a".repeat(64),
      session_start_utc: "2026-10-07T13:30:00Z",
      session_end_exclusive_utc: "2026-10-07T13:31:00Z",
      window_start_utc: "2026-10-07T13:30:00Z",
      window_end_exclusive_utc: "2026-10-07T13:31:00Z",
      open: "500.00",
      high: "501.00",
      low: "499.00",
      close: "500.50",
      volume: "1",
      trade_count: "1",
      quote_events_excluded: "0",
      source_timestamp_missing_rows: "0",
      sequence_gap_count: "0",
      late_event_count: "0",
      window_expected_minutes: "1",
      window_empty_trade_minutes: "0",
      source_start_utc: "2026-10-07T13:30:30Z",
      source_end_exclusive_utc: "2026-10-07T13:30:30.000000001Z",
      window_input_eof: true,
      source_pages_exhausted: null,
      completion_mode: "synthetic_eof",
      nbbo_input_status: "excluded",
    }],
  };
}

describe("diagnostic MDP archive validation", () => {
  it("preserves a source-labeled synthetic archive response under the requested identity", () => {
    const value = response();
    expect(validateMdpBarsResponse(value, { datasetId: "archive-1", namespace: "diagnostic", symbol: "QQQ" })).toBe(value);
  });

  it("rejects identity mismatches and incomplete data mislabeled as synthetic", () => {
    const value = response();
    expect(validateMdpBarsResponse(value, { datasetId: "other", namespace: "diagnostic", symbol: "QQQ" })).toBeNull();
    const changedSource = response();
    changedSource.rows[0]!.source_provider = "alpaca";
    expect(validateMdpBarsResponse(changedSource, { datasetId: "archive-1", namespace: "diagnostic", symbol: "QQQ" })).toBeNull();
    const promoted = response();
    promoted.summary.namespace = "curated";
    expect(validateMdpBarsResponse(promoted, { datasetId: "archive-1", namespace: "diagnostic", symbol: "QQQ" })).toBeNull();
  });
});
