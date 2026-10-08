export const MDP_BAR_SCHEMA_ID = "lqepoch.us_equity_trade_bar_1m.v1" as const;
export const MDP_BAR_SCHEMA_SHA256 = "5e761a91d880e0002aeafe6dc2083b7c8a0ff2ba486d5d93582fbb4479146cb0" as const;

export type MdpDatasetNamespace = "diagnostic" | "curated";

export type MdpSource = {
  provider: string;
  feed: string;
  entitlement: "unknown" | "authorized" | "unauthorized";
  numeric_encoding: string;
  source_record_id?: string | null;
};

/** Browser-safe projection of the already validated MDP V1 bar response. */
export type TradeMinuteBarV1 = {
  schema_version: 1;
  source_provider: string;
  source_feed: string;
  source_entitlement: MdpSource["entitlement"];
  source_numeric_encoding: string;
  symbol: string;
  bar_start_utc: string;
  bar_end_exclusive_utc: string;
  available_at_utc: string;
  trade_date: string;
  session_id: string;
  session_timezone: string;
  session_policy_id: string;
  session_policy_sha256: string;
  session_start_utc: string;
  session_end_exclusive_utc: string;
  window_start_utc: string;
  window_end_exclusive_utc: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trade_count: string;
  quote_events_excluded: string;
  source_timestamp_missing_rows: string;
  sequence_gap_count: string;
  late_event_count: string;
  window_expected_minutes: string;
  window_empty_trade_minutes: string;
  source_start_utc: string;
  source_end_exclusive_utc: string;
  window_input_eof: true;
  source_pages_exhausted: true | null;
  completion_mode: "synthetic_eof" | "historical_eof_paged" | "historical_eof_nonpaged";
  nbbo_input_status: "excluded";
};

export type MdpBarsResponseV1 = {
  summary: {
    namespace: MdpDatasetNamespace;
    dataset_id: string;
    schema_id: typeof MDP_BAR_SCHEMA_ID;
    source: MdpSource;
    row_count: string;
    returned_rows: string;
    content_sha256: string;
    parquet_schema_sha256: typeof MDP_BAR_SCHEMA_SHA256;
    cache_hit: boolean;
  };
  rows: TradeMinuteBarV1[];
};
