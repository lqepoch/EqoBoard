export type QuantPredictionLifecycle =
  | "UNKNOWN"
  | "NOT_YET_VALID"
  | "ACTIVE_RESEARCH_ONLY"
  | "EXPIRED";

export type QuantPredictionAssessment = {
  lifecycle: QuantPredictionLifecycle;
  identity_resolution: "UNKNOWN" | "VERIFIED_EXACT_ONLY";
  source_manifest_binding: "UNKNOWN" | "EXACT_WHOLE_BYTES";
  finite_receipt_binding:
    | "UNKNOWN"
    | "HASH_BOUND_UNVERIFIED"
    | "CORE_CANONICAL_EXACT_BYTES_MATCHED_LOCAL_ONLY";
  point_in_time: "UNKNOWN_SOURCE_COMPLETENESS";
  promotion_allowed: false;
  reason_codes: string[];
};

/** Browser-safe projection returned by the EqoBoard BFF, never the private artifact. */
export type RegisteredPredictionView = {
  schema_name: "quant-research-registered-prediction-v1";
  authority: "LOCAL_REGISTERED_ROOT";
  read_only: true;
  promotion_allowed: false;
  run_id: string;
  prediction_status: "HISTORICAL_SIMULATED_EXPIRED" | "UNVERIFIED_SIMULATED_ONLY" | "BLOCKED_DATA";
  source_manifest_sha256: string;
  public_protojson_base64: string | null;
  public_protojson_sha256: string | null;
  projection_receipt_sha256: string;
  assessment: QuantPredictionAssessment;
};
