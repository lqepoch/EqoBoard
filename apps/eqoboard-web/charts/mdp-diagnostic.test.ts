import { describe, expect, it } from "vitest";
import {
  MDP_BAR_SCHEMA_ID,
  MDP_BAR_SCHEMA_SHA256,
  type MdpBarsResponseV1,
} from "../features/market/mdp-archive";
import { buildMdpDiagnosticChartData } from "./mdp-diagnostic";

function diagnosticResponse(
  numericEncoding = "decimal_token",
  close = "100.125",
  provider = "alpaca",
): MdpBarsResponseV1 {
  const source = {
    provider,
    feed: provider === "synthetic" ? "synthetic" : "sip",
    entitlement: provider === "synthetic" ? ("unknown" as const) : ("authorized" as const),
    numeric_encoding: numericEncoding,
  };
  return {
    summary: {
      namespace: "diagnostic",
      dataset_id: "fixture-bars_1m.v1",
      schema_id: MDP_BAR_SCHEMA_ID,
      source,
      row_count: "1",
      returned_rows: "1",
      content_sha256: "a".repeat(64),
      parquet_schema_sha256: MDP_BAR_SCHEMA_SHA256,
      cache_hit: false,
    },
    rows: [
      {
        schema_version: 1,
        source_provider: source.provider,
        source_feed: source.feed,
        source_entitlement: source.entitlement,
        source_numeric_encoding: source.numeric_encoding,
        symbol: "SPY",
        bar_start_utc: "2026-10-15T14:30:00.000Z",
        bar_end_exclusive_utc: "2026-10-15T14:31:00.000Z",
        available_at_utc: "2026-10-15T14:31:02.000Z",
        trade_date: "2026-10-15",
        session_id: "regular-2026-10-15",
        session_timezone: "America/New_York",
        session_policy_id: "us-equity-regular-v1",
        session_policy_sha256: "b".repeat(64),
        session_start_utc: "2026-10-15T13:30:00.000Z",
        session_end_exclusive_utc: "2026-10-15T20:00:00.000Z",
        window_start_utc: "2026-10-15T14:30:00.000Z",
        window_end_exclusive_utc: "2026-10-15T14:31:00.000Z",
        open: "100.000",
        high: "100.250",
        low: "99.875",
        close,
        volume: "1200",
        trade_count: "12",
        quote_events_excluded: "0",
        source_timestamp_missing_rows: "0",
        sequence_gap_count: "0",
        late_event_count: "0",
        window_expected_minutes: "1",
        window_empty_trade_minutes: "0",
        source_start_utc: "2026-10-15T14:30:01.000Z",
        source_end_exclusive_utc: "2026-10-15T14:30:59.000Z",
        window_input_eof: true,
        source_pages_exhausted: provider === "synthetic" ? null : true,
        completion_mode: provider === "synthetic" ? "synthetic_eof" : "historical_eof_paged",
        nbbo_input_status: "excluded",
      },
    ],
  };
}

describe("MDP diagnostic chart projection", () => {
  it("keeps exact source tokens and labels the fixed diagnostic window and provenance", () => {
    const data = buildMdpDiagnosticChartData(diagnosticResponse());

    expect(data.bars).toHaveLength(1);
    expect(data.bars[0]?.exact).toEqual({
      open: "100.000",
      high: "100.250",
      low: "99.875",
      close: "100.125",
      volume: "1200",
    });
    expect(data.evidence.mode).toBe("diagnostic-archive");
    expect(data.evidence.source).toBe("MDP diagnostic archive");
    expect(data.evidence.asOf).toBe("unknown");
    expect(data.evidence.coverage).toContain("Validated diagnostic window only");
    expect(data.evidence.evidence).toContainEqual({
      label: "Status",
      value: "diagnostic only · NOT LIVE · noncanonical · promotion unavailable",
    });
    expect(data.evidence.evidence).toContainEqual({
      label: "Page limit",
      value: "one fixed response; no cursor or pagination contract",
    });
  });

  it("does not label binary-float or raw encodings as exact decimal input", () => {
    const float = buildMdpDiagnosticChartData(
      diagnosticResponse("binary_float64_shortest_decimal"),
    );
    const unknown = buildMdpDiagnosticChartData(diagnosticResponse("raw_json_bytes"));

    expect(float.evidence.precision).toBe("provider-float");
    expect(float.bars[0]?.exact).toBeUndefined();
    expect(unknown.evidence.precision).toBe("unknown");
    expect(unknown.bars[0]?.exact).toBeUndefined();
  });

  it("marks synthetic archive observations explicitly when the validated source says synthetic", () => {
    const data = buildMdpDiagnosticChartData(
      diagnosticResponse("decimal_token", "100.125", "synthetic"),
    );

    expect(data.evidence.provider).toBe("synthetic");
    expect(data.evidence.evidence.find((entry) => entry.label === "Status")?.value).toContain(
      "synthetic diagnostic observations",
    );
  });

  it("reports rows outside finite display bounds instead of hiding the projection loss", () => {
    const data = buildMdpDiagnosticChartData(diagnosticResponse("decimal_token", "1000000000001"));

    expect(data.projection.rejectedRows).toBe(1);
    expect(data.evidence.completeness).toBe("partial");
    expect(data.evidence.coverage).toContain("1 row(s) could not be plotted");
  });
});
