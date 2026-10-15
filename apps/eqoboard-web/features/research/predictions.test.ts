import { describe, expect, it } from "vitest";

import {
  decodePublicPredictionProjection,
  DEFAULT_REGISTERED_PREDICTION_CONFIG,
  parseRegisteredPredictionConfig,
  parseRegisteredPredictionView,
} from "./predictions";

const assessment = {
  lifecycle: "EXPIRED",
  identity_resolution: "VERIFIED_EXACT_ONLY",
  source_manifest_binding: "EXACT_WHOLE_BYTES",
  finite_receipt_binding: "HASH_BOUND_UNVERIFIED",
  point_in_time: "UNKNOWN_SOURCE_COMPLETENESS",
  promotion_allowed: false,
  reason_codes: ["historical_only"],
} as const;

const publicView = {
  schema_name: "quant-research-registered-prediction-v1",
  authority: "LOCAL_REGISTERED_ROOT",
  read_only: true,
  promotion_allowed: false,
  run_id: "run-2026-10-15",
  prediction_status: "UNVERIFIED_SIMULATED_ONLY",
  source_manifest_sha256: "a".repeat(64),
  public_protojson_base64: "e30=",
  public_protojson_sha256: "b".repeat(64),
  projection_receipt_sha256: "c".repeat(64),
  assessment,
} as const;

describe("registered prediction browser adapter", () => {
  it("accepts only the sanitized read-only view and decodes its public projection", () => {
    const view = parseRegisteredPredictionView(publicView, publicView.run_id);
    expect(view?.promotion_allowed).toBe(false);
    expect(view && decodePublicPredictionProjection(view)).toBe("{}");
  });

  it("rejects private fields, unexpected response fields, run mismatches, and promotable data", () => {
    expect(
      parseRegisteredPredictionView(
        { ...publicView, private_artifact_sha256: "d".repeat(64) },
        publicView.run_id,
      ),
    ).toBeNull();
    expect(
      parseRegisteredPredictionView({ ...publicView, extra: true }, publicView.run_id),
    ).toBeNull();
    expect(parseRegisteredPredictionView(publicView, "another-run")).toBeNull();
    expect(
      parseRegisteredPredictionView({ ...publicView, promotion_allowed: true }, publicView.run_id),
    ).toBeNull();
  });

  it("keeps saved run identifiers bounded and rejects path-like or malformed values", () => {
    expect(parseRegisteredPredictionConfig(DEFAULT_REGISTERED_PREDICTION_CONFIG).ok).toBe(true);
    expect(parseRegisteredPredictionConfig({ schemaVersion: 1, runId: "run:alpha-2" }).ok).toBe(
      true,
    );
    expect(parseRegisteredPredictionConfig({ schemaVersion: 1, runId: "../private" }).ok).toBe(
      false,
    );
    expect(parseRegisteredPredictionConfig({ schemaVersion: 1, runId: "x".repeat(256) }).ok).toBe(
      false,
    );
  });
});
