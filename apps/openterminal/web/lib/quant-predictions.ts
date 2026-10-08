import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { parsePredictionEnvelopeProtoJsonText } from "@lqepoch/trading-core-contracts";
import { authorizeQuantPredictionRequest } from "@/lib/eqo-auth";
import { readLimitedResponse } from "@/lib/http-response";
import type { RegisteredPredictionView, QuantPredictionAssessment } from "@/lib/quant-prediction-contract";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 256 * 1024;
// Quant's registered FactorIR reader enforces the same bounded row range.
const MAX_FACTOR_FEATURE_ROWS = 390;
const UPSTREAM_DEADLINE_MS = 3_000;

type PredictionApiResponse = RegisteredPredictionView & { private_artifact_sha256: string };

const FACTOR_FEATURE_FIELDS = [
  "candidate_id", "candidate_hash", "factor_ir_sha256", "registry_sha256", "registry_qualification",
  "feature_sha256", "feature_receipt_sha256", "timestamp_index_sha256", "rows", "first_valid_row_index",
  "model_consumed", "promotion_allowed",
] as const;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function isLabel(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
}

function isAssessment(value: unknown): value is QuantPredictionAssessment {
  if (!isRecord(value) || !exactFields(value, [
    "lifecycle", "identity_resolution", "source_manifest_binding", "finite_receipt_binding",
    "point_in_time", "promotion_allowed", "reason_codes",
  ])) return false;
  return ["UNKNOWN", "NOT_YET_VALID", "ACTIVE_RESEARCH_ONLY", "EXPIRED"].includes(value.lifecycle as string) &&
    ["UNKNOWN", "VERIFIED_EXACT_ONLY"].includes(value.identity_resolution as string) &&
    ["UNKNOWN", "EXACT_WHOLE_BYTES"].includes(value.source_manifest_binding as string) &&
    ["UNKNOWN", "HASH_BOUND_UNVERIFIED", "CORE_CANONICAL_EXACT_BYTES_MATCHED_LOCAL_ONLY"].includes(value.finite_receipt_binding as string) &&
    value.point_in_time === "UNKNOWN_SOURCE_COMPLETENESS" && value.promotion_allowed === false &&
    Array.isArray(value.reason_codes) && value.reason_codes.length <= 64 &&
    value.reason_codes.every((reason) => isLabel(reason, 128)) &&
    new Set(value.reason_codes).size === value.reason_codes.length;
}

function isFactorFeatureSummary(value: unknown): boolean {
  if (!isRecord(value) || !exactFields(value, FACTOR_FEATURE_FIELDS)) return false;
  const candidateId = value.candidate_id;
  const rows = value.rows;
  const firstValidRowIndex = value.first_valid_row_index;
  return typeof candidateId === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]{0,31}(?:@[0-9a-f]{16})?$/.test(candidateId) &&
    ["candidate_hash", "factor_ir_sha256", "registry_sha256", "feature_sha256", "feature_receipt_sha256", "timestamp_index_sha256"]
      .every((field) => typeof value[field] === "string" && SHA256.test(value[field] as string)) &&
    value.registry_qualification === "UNKNOWN_CALLER_SUPPLIED_IDENTITY" &&
    Number.isSafeInteger(rows) && (rows as number) > 0 && (rows as number) <= MAX_FACTOR_FEATURE_ROWS &&
    Number.isSafeInteger(firstValidRowIndex) && (firstValidRowIndex as number) >= 0 &&
    (firstValidRowIndex as number) < (rows as number) &&
    value.model_consumed === true && value.promotion_allowed === false;
}

function validPublicProjection(base64: unknown, sha256: unknown): base64 is string | null {
  if (base64 === null) return sha256 === null;
  if (typeof base64 !== "string" || base64.length === 0 ||
      base64.length > Math.ceil(MAX_PROJECTION_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) ||
      typeof sha256 !== "string" || !SHA256.test(sha256)) return false;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PROJECTION_BYTES || bytes.toString("base64") !== base64 ||
      createHash("sha256").update(bytes).digest("hex") !== sha256) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const envelope = parsePredictionEnvelopeProtoJsonText(text);
    return envelope.schemaVersion === "lqepoch-prediction-envelope-v1" &&
      isLabel(envelope.predictionId, 256);
  } catch {
    return false;
  }
}

function validatePredictionResponse(value: unknown, runId: string): RegisteredPredictionView | null {
  const responseFields = [
    "schema_name", "authority", "read_only", "promotion_allowed", "run_id", "prediction_status",
    "source_manifest_sha256", "private_artifact_sha256", "public_protojson_base64",
    "public_protojson_sha256", "projection_receipt_sha256", "assessment",
  ];
  if (!isRecord(value)) return null;
  const hasFactorFeature = Object.hasOwn(value, "factor_feature");
  if (!exactFields(value, hasFactorFeature ? [...responseFields, "factor_feature"] : responseFields) ||
      (hasFactorFeature && !isFactorFeatureSummary(value.factor_feature)) ||
      value.schema_name !== "quant-research-registered-prediction-v1" ||
      value.authority !== "LOCAL_REGISTERED_ROOT" || value.read_only !== true ||
      value.promotion_allowed !== false || value.run_id !== runId ||
      !["HISTORICAL_SIMULATED_EXPIRED", "UNVERIFIED_SIMULATED_ONLY", "BLOCKED_DATA"].includes(value.prediction_status as string) ||
      typeof value.source_manifest_sha256 !== "string" || !SHA256.test(value.source_manifest_sha256) ||
      typeof value.private_artifact_sha256 !== "string" || !SHA256.test(value.private_artifact_sha256) ||
      typeof value.projection_receipt_sha256 !== "string" || !SHA256.test(value.projection_receipt_sha256) ||
      !validPublicProjection(value.public_protojson_base64, value.public_protojson_sha256) ||
      !isAssessment(value.assessment) || value.assessment.promotion_allowed !== false) return null;
  if ((value.prediction_status === "BLOCKED_DATA") !== (value.public_protojson_base64 === null)) return null;

  // The verified FactorIR value is only a bounded hash summary. Keep it out of
  // the browser contract; feature rows and private research artifacts stay server-side.
  const {
    private_artifact_sha256: _privateArtifactHash,
    factor_feature: _factorFeatureSummary,
    ...publicView
  } = value as PredictionApiResponse & { factor_feature?: unknown };
  return publicView;
}

function quantBaseUrl(): URL | null {
  const raw = process.env.EQO_QUANT_RESEARCH_URL;
  if (!raw || raw.length > 2_048 || raw.trim() !== raw) return null;
  try {
    const base = new URL(raw);
    if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password ||
        base.search || base.hash || base.pathname !== "/" ||
        (raw !== base.origin && raw !== `${base.origin}/`)) return null;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.protocol === "http:" && !loopback && base.hostname !== "quant-research") return null;
    return new URL(base.origin);
  } catch {
    return null;
  }
}

async function readJsonResponse(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(MAX_RESPONSE_BYTES))) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const bytes = await readLimitedResponse(response, MAX_RESPONSE_BYTES);
    if (bytes === null) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
}

/** Server-only read proxy; it never returns the private artifact or caller-supplied paths. */
export async function proxyRegisteredPrediction(request: NextRequest, runId: string): Promise<NextResponse> {
  const hasBody = request.body !== null;
  if (hasBody) void request.body?.cancel().catch(() => undefined);
  if (request.nextUrl.search !== "" || runId.length > 255 || !RUN_ID.test(runId) ||
      request.headers.has("content-encoding") || request.headers.has("transfer-encoding") ||
      hasBody || (request.headers.has("content-length") && request.headers.get("content-length") !== "0")) {
    return jsonError(400, "invalid_request");
  }
  const authorization = await authorizeQuantPredictionRequest(request);
  if (!authorization.ok) return authorization.response;
  const base = quantBaseUrl();
  if (!base) return jsonError(503, "research_service_unavailable");

  const controller = new AbortController();
  let deadlineExpired = false;
  const onClientAbort = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", onClientAbort, { once: true });
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, UPSTREAM_DEADLINE_MS);
  try {
    const upstreamUrl = new URL(`/v1/research/predictions/${encodeURIComponent(runId)}`, base);
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${authorization.token}`, "X-Request-ID": randomUUID() },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status !== 200) {
      void upstream.body?.cancel().catch(() => undefined);
      if (upstream.status === 404) return jsonError(404, "prediction_not_found");
      if (upstream.status === 504 || deadlineExpired) return jsonError(504, "research_query_timeout");
      return jsonError(503, "research_service_unavailable");
    }
    const body = await readJsonResponse(upstream);
    if (body === null) return deadlineExpired
      ? jsonError(504, "research_query_timeout")
      : jsonError(502, "invalid_prediction_response");
    const validated = validatePredictionResponse(body, runId);
    if (!validated) return jsonError(502, "invalid_prediction_response");
    return NextResponse.json(validated, {
      status: 200,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return deadlineExpired
      ? jsonError(504, "research_query_timeout")
      : jsonError(503, "research_service_unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}
