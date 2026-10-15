export type QuantPredictionAssessment = Readonly<{
  lifecycle: "UNKNOWN" | "NOT_YET_VALID" | "ACTIVE_RESEARCH_ONLY" | "EXPIRED";
  identity_resolution: "UNKNOWN" | "VERIFIED_EXACT_ONLY";
  source_manifest_binding: "UNKNOWN" | "EXACT_WHOLE_BYTES";
  finite_receipt_binding:
    | "UNKNOWN"
    | "HASH_BOUND_UNVERIFIED"
    | "CORE_CANONICAL_EXACT_BYTES_MATCHED_LOCAL_ONLY";
  point_in_time: "UNKNOWN_SOURCE_COMPLETENESS";
  promotion_allowed: false;
  reason_codes: readonly string[];
}>;

/** Browser projection only. The server removes private artifact hashes and feature rows. */
export type RegisteredPredictionView = Readonly<{
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
}>;

export type RegisteredPredictionConfigV1 = Readonly<{ schemaVersion: 1; runId: string }>;

export const DEFAULT_REGISTERED_PREDICTION_CONFIG: RegisteredPredictionConfigV1 = Object.freeze({
  schemaVersion: 1,
  runId: "",
});
export const REGISTERED_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/u;

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PUBLIC_PROJECTION_BYTES = 256 * 1024;
const ASSESSMENT_FIELDS = [
  "lifecycle",
  "identity_resolution",
  "source_manifest_binding",
  "finite_receipt_binding",
  "point_in_time",
  "promotion_allowed",
  "reason_codes",
] as const;
const VIEW_FIELDS = [
  "schema_name",
  "authority",
  "read_only",
  "promotion_allowed",
  "run_id",
  "prediction_status",
  "source_manifest_sha256",
  "public_protojson_base64",
  "public_protojson_sha256",
  "projection_receipt_sha256",
  "assessment",
] as const;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !descriptors[key]?.enumerable ||
          !("value" in descriptors[key]!),
      )
    )
      return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key))
  );
}

function label(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function parseRegisteredPredictionConfig(
  value: unknown,
):
  | Readonly<{ ok: true; value: RegisteredPredictionConfigV1 }>
  | Readonly<{ ok: false; code: "config-invalid"; field?: string }> {
  const config = record(value);
  if (!config || !exactFields(config, ["schemaVersion", "runId"]) || config.schemaVersion !== 1) {
    return { ok: false, code: "config-invalid" };
  }
  if (
    typeof config.runId !== "string" ||
    config.runId !== config.runId.trim() ||
    config.runId.length > 255 ||
    (config.runId !== "" && !REGISTERED_RUN_ID.test(config.runId))
  )
    return { ok: false, code: "config-invalid", field: "runId" };
  return { ok: true, value: Object.freeze({ schemaVersion: 1, runId: config.runId }) };
}

function validAssessment(value: unknown): value is QuantPredictionAssessment {
  const assessment = record(value);
  return Boolean(
    assessment &&
      exactFields(assessment, ASSESSMENT_FIELDS) &&
      ["UNKNOWN", "NOT_YET_VALID", "ACTIVE_RESEARCH_ONLY", "EXPIRED"].includes(
        String(assessment.lifecycle),
      ) &&
      ["UNKNOWN", "VERIFIED_EXACT_ONLY"].includes(String(assessment.identity_resolution)) &&
      ["UNKNOWN", "EXACT_WHOLE_BYTES"].includes(String(assessment.source_manifest_binding)) &&
      [
        "UNKNOWN",
        "HASH_BOUND_UNVERIFIED",
        "CORE_CANONICAL_EXACT_BYTES_MATCHED_LOCAL_ONLY",
      ].includes(String(assessment.finite_receipt_binding)) &&
      assessment.point_in_time === "UNKNOWN_SOURCE_COMPLETENESS" &&
      assessment.promotion_allowed === false &&
      Array.isArray(assessment.reason_codes) &&
      assessment.reason_codes.length <= 64 &&
      assessment.reason_codes.every((reason) => label(reason, 128)) &&
      new Set(assessment.reason_codes).size === assessment.reason_codes.length,
  );
}

function validPublicProjection(base64: unknown, sha256: unknown): base64 is string | null {
  if (base64 === null) return sha256 === null;
  if (
    typeof base64 !== "string" ||
    base64.length === 0 ||
    base64.length > Math.ceil(MAX_PUBLIC_PROJECTION_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64) ||
    typeof sha256 !== "string" ||
    !SHA256.test(sha256)
  )
    return false;
  try {
    const binary = atob(base64);
    if (binary.length === 0 || binary.length > MAX_PUBLIC_PROJECTION_BYTES) return false;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let decoded = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      decoded += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return (
      btoa(decoded) === base64 && new TextDecoder("utf-8", { fatal: true }).decode(bytes).length > 0
    );
  } catch {
    return false;
  }
}

/** Validates only the BFF's intentionally sanitized browser projection, never a private envelope. */
export function parseRegisteredPredictionView(
  value: unknown,
  runId: string,
): RegisteredPredictionView | null {
  const view = record(value);
  if (
    !view ||
    !exactFields(view, VIEW_FIELDS) ||
    view.schema_name !== "quant-research-registered-prediction-v1" ||
    view.authority !== "LOCAL_REGISTERED_ROOT" ||
    view.read_only !== true ||
    view.promotion_allowed !== false ||
    view.run_id !== runId ||
    !REGISTERED_RUN_ID.test(runId) ||
    !["HISTORICAL_SIMULATED_EXPIRED", "UNVERIFIED_SIMULATED_ONLY", "BLOCKED_DATA"].includes(
      String(view.prediction_status),
    ) ||
    typeof view.source_manifest_sha256 !== "string" ||
    !SHA256.test(view.source_manifest_sha256) ||
    typeof view.projection_receipt_sha256 !== "string" ||
    !SHA256.test(view.projection_receipt_sha256) ||
    !validPublicProjection(view.public_protojson_base64, view.public_protojson_sha256) ||
    !validAssessment(view.assessment)
  )
    return null;
  if ((view.prediction_status === "BLOCKED_DATA") !== (view.public_protojson_base64 === null))
    return null;
  return Object.freeze(view as RegisteredPredictionView);
}

export function decodePublicPredictionProjection(view: RegisteredPredictionView): string | null {
  if (!view.public_protojson_base64) return null;
  try {
    const binary = atob(view.public_protojson_base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
