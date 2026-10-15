import { describe, expect, it } from "vitest";
import { decodeCoreBarsPage } from "./core-bars";

const request = {
  symbol: "SPY",
  range: "1D",
  resolution: "1m",
  asset_class: "etf",
  session_scope: "all",
  adjustment: "unadjusted",
  provider_mode: "auto",
  allow_daily_downgrade: true,
  request_start: "2026-10-15T13:00:00Z",
  request_end: "2026-10-15T14:00:00Z",
  cursor: null,
} as const;

function response(numericEncoding: string) {
  return {
    schema_version: 1,
    provider: "Alpaca",
    feed: "SIP",
    entitlement_status: "authorized",
    requested_resolution: "1m",
    effective_resolution: "1m",
    rows: [{
      symbol: "SPY",
      asset_class: "etf",
      resolution: "1m",
      bar_start_utc: "2026-10-15T13:30:00Z",
      bar_end_exclusive_utc: "2026-10-15T13:31:00Z",
      received_at_utc: "2026-10-15T13:31:01Z",
      available_at_utc: "2026-10-15T13:31:02Z",
      open: "10.000",
      high: "12.000",
      low: "9.000",
      close: "11.000",
      volume: "100.00",
      provenance_id: "p1",
      session_instance_id: "session-1",
      validation_state: "validated",
      adjustment: "unadjusted",
    }],
    coverage_status: "complete",
    segments: [],
    gaps: [],
    source_provenance: [{
      provenance_id: "p1",
      provider: "Alpaca",
      feed: "SIP",
      entitlement_status: "authorized",
      numeric_encoding: numericEncoding,
      source: "alpaca_sip",
    }],
    as_of: "2026-10-15T13:31:02Z",
    fetched_at: "2026-10-15T13:31:02Z",
    cache_status: "miss",
    continuation_cursor: "opaque-next",
    truncated: true,
    adjustment: "unadjusted",
  };
}

function envelope(responseValue: unknown, requestValue: typeof request = request) {
  return { kind: "eqoboard.core-bars-page.v1", request: requestValue, response: responseValue };
}

describe("Core Bars V1 chart adapter", () => {
  it("decodes the transport envelope separately and keeps exact Core tokens on the UI projection", () => {
    const page = decodeCoreBarsPage(envelope(response("decimal_token")));

    expect(page?.response.rows[0]?.close).toBe("11.000");
    expect(page?.projection.bars[0]?.close).toBe(11);
    expect(page?.projection.bars[0]?.exact?.close).toBe("11.000");
    expect(page?.evidence.source).toBe("alpaca_sip");
    expect(page?.evidence.precision).toBe("exact-decimal");
    expect(page?.evidence.completeness).toBe("partial");
  });

  it("does not label float-derived decimal strings as exact input", () => {
    const page = decodeCoreBarsPage(envelope(response("binary_float64_shortest_decimal")));

    expect(page?.projection.bars[0]?.exact).toBeUndefined();
    expect(page?.evidence.precision).toBe("provider-float");
  });

  it("retains row-level exact values but reports unknown precision for mixed or ambiguous provenance", () => {
    const mixed = response("decimal_token");
    mixed.rows.push({
      ...mixed.rows[0]!,
      bar_start_utc: "2026-10-15T13:32:00Z",
      bar_end_exclusive_utc: "2026-10-15T13:33:00Z",
      provenance_id: "p2",
    });
    mixed.source_provenance.push({
      ...mixed.source_provenance[0]!,
      provenance_id: "p2",
      numeric_encoding: "binary_float32_shortest_decimal",
    });
    const mixedPage = decodeCoreBarsPage(envelope(mixed));

    expect(mixedPage?.evidence.precision).toBe("unknown");
    expect(mixedPage?.projection.bars[0]?.exact?.close).toBe("11.000");
    expect(mixedPage?.projection.bars[1]?.exact).toBeUndefined();

    const ambiguous = response("decimal_token");
    ambiguous.source_provenance.push({
      ...ambiguous.source_provenance[0]!,
      numeric_encoding: "binary_float64_shortest_decimal",
    });
    const ambiguousPage = decodeCoreBarsPage(envelope(ambiguous));

    expect(ambiguousPage?.evidence.precision).toBe("unknown");
    expect(ambiguousPage?.projection.bars[0]?.exact).toBeUndefined();
  });

  it("rejects a response that does not match the requested symbol and resolution", () => {
    const wrongSymbol = response("decimal_token");
    wrongSymbol.rows[0]!.symbol = "QQQ";
    const wrongResolution = envelope(response("decimal_token"), { ...request, resolution: "5m" });

    expect(decodeCoreBarsPage(envelope(wrongSymbol))).toBeNull();
    expect(decodeCoreBarsPage(wrongResolution)).toBeNull();
  });

  it("omits rows outside the server-resolved request window and marks their projection loss", () => {
    const outside = response("decimal_token");
    outside.rows[0]!.bar_start_utc = "2026-10-15T14:00:00Z";
    const page = decodeCoreBarsPage(envelope(outside));

    expect(page).not.toBeNull();
    expect(page?.projection.bars).toHaveLength(0);
    expect(page?.projection.rejectedRows).toBe(1);
    expect(page?.evidence.completeness).toBe("partial");
  });
});
