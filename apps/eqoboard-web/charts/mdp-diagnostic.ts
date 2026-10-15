import type { MdpBarsResponseV1, TradeMinuteBarV1 } from "../features/market/mdp-archive";
import { projectChartRows, type ChartProjectionResult } from "./projection";
import type { ChartDisplayEvidence, ChartPlotBar } from "./types";

export type MdpDiagnosticChartData = Readonly<{
  bars: readonly ChartPlotBar<TradeMinuteBarV1>[];
  projection: ChartProjectionResult<TradeMinuteBarV1>;
  evidence: ChartDisplayEvidence;
}>;

function isExactEncoding(value: string): boolean {
  return value === "decimal_token" || value === "integer_token";
}

function isProviderFloatEncoding(value: string): boolean {
  return value === "binary_float32_shortest_decimal" || value === "binary_float64_shortest_decimal";
}

function latestAvailableAt(rows: readonly TradeMinuteBarV1[]): string {
  let latestMs = Number.NEGATIVE_INFINITY;
  let latest = "unknown";
  for (const row of rows) {
    const availableAt = Date.parse(row.available_at_utc);
    if (Number.isFinite(availableAt) && availableAt > latestMs) {
      latestMs = availableAt;
      latest = row.available_at_utc;
    }
  }
  return latest;
}

function diagnosticWindow(rows: readonly TradeMinuteBarV1[]): string {
  const first = rows[0];
  if (!first) return "unknown; response contains no row-level window metadata";
  return `${first.trade_date} ${first.session_id} · ${first.window_start_utc} → ${first.window_end_exclusive_utc} (${first.session_timezone})`;
}

function coverageSummary(response: MdpBarsResponseV1, rejectedRows: number): string {
  const first = response.rows[0];
  if (!first) return `No diagnostic rows returned; summary row_count=${response.summary.row_count}, returned_rows=${response.summary.returned_rows}.`;
  const projectionNote = rejectedRows > 0 ? ` ${rejectedRows} row(s) could not be plotted within the bounded numeric projection.` : "";
  return [
    `Validated diagnostic window only; ${response.rows.length} returned trade-minute bars`,
    `${first.window_expected_minutes} expected minutes, ${first.window_empty_trade_minutes} empty-trade minutes`,
    `window_input_eof=${first.window_input_eof}`,
    `source_pages_exhausted=${first.source_pages_exhausted ?? "unknown"}`,
    `completion_mode=${first.completion_mode}`,
    `summary row_count=${response.summary.row_count}, returned_rows=${response.summary.returned_rows}`,
  ].join("; ") + `.${projectionNote}`;
}

/** Projects one already-decoded fixed MDP diagnostic response; never treats it as Core history. */
export function buildMdpDiagnosticChartData(response: MdpBarsResponseV1): MdpDiagnosticChartData {
  const sourceEncoding = response.summary.source.numeric_encoding;
  const exact = isExactEncoding(sourceEncoding);
  const candidates = response.rows.map((row) => {
    const timeMs = Date.parse(row.bar_start_utc);
    return {
      sourceRow: row,
      timeSeconds: Number.isFinite(timeMs) ? timeMs / 1_000 : Number.NaN,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      ...(exact ? { exact: { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume } } : {}),
    };
  });
  const projection = projectChartRows(candidates);
  const precision: ChartDisplayEvidence["precision"] = response.rows.length === 0
    ? "unknown"
    : exact ? "exact-decimal" : isProviderFloatEncoding(sourceEncoding) ? "provider-float" : "unknown";
  const completeness: ChartDisplayEvidence["completeness"] = response.rows.length === 0
    ? "unknown"
    : projection.rejectedRows === 0 ? "complete" : "partial";
  const source = response.summary.source;
  const first = response.rows[0];
  const syntheticSource = source.provider === "synthetic" || first?.completion_mode === "synthetic_eof";

  const evidence: ChartDisplayEvidence = {
    mode: "diagnostic-archive",
    source: "MDP diagnostic archive",
    provider: source.provider || "unknown",
    feed: source.feed || "unknown",
    // MDP V1 has no archive-level as-of timestamp. Row available-at is exposed separately.
    asOf: "unknown",
    requestedWindow: diagnosticWindow(response.rows),
    effectiveResolution: "1m diagnostic observations",
    coverage: coverageSummary(response, projection.rejectedRows),
    completeness,
    precision,
    evidence: [
      { label: "Status", value: syntheticSource
        ? "synthetic diagnostic observations · NOT LIVE · noncanonical · promotion unavailable"
        : "diagnostic only · NOT LIVE · noncanonical · promotion unavailable" },
      { label: "Dataset", value: response.summary.dataset_id },
      { label: "Schema", value: `${response.summary.schema_id} · ${response.summary.parquet_schema_sha256}` },
      { label: "Content SHA-256", value: response.summary.content_sha256 },
      { label: "Archive cache hit", value: String(response.summary.cache_hit) },
      { label: "Source entitlement", value: source.entitlement },
      { label: "Source numeric encoding", value: source.numeric_encoding },
      { label: "Latest row available-at", value: latestAvailableAt(response.rows) },
      { label: "As-of limitation", value: "No archive-level as-of timestamp is present in MDP Bars V1." },
      { label: "Window / session", value: first ? `${first.trade_date} · ${first.session_id}` : "unknown" },
      { label: "Session policy", value: first ? `${first.session_policy_id} · ${first.session_policy_sha256}` : "unknown" },
      { label: "Session interval", value: first ? `${first.session_start_utc} → ${first.session_end_exclusive_utc}` : "unknown" },
      { label: "Source interval", value: first ? `${first.source_start_utc} → ${first.source_end_exclusive_utc}` : "unknown" },
      { label: "Quote / NBBO inputs", value: first ? `${first.quote_events_excluded} quote events excluded · NBBO ${first.nbbo_input_status}` : "unknown" },
      { label: "Validation counters", value: first ? `missing timestamps ${first.source_timestamp_missing_rows} · sequence gaps ${first.sequence_gap_count} · late events ${first.late_event_count}` : "unknown" },
      { label: "Page limit", value: "one fixed response; no cursor or pagination contract" },
      { label: "Chart projection", value: "finite numeric coordinates; source rows remain unchanged and are not execution inputs" },
    ],
  };
  return { bars: projection.bars, projection, evidence };
}
