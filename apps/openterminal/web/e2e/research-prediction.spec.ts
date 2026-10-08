import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { configureMocks, loginWithOidc, metrics, resetDownstream, WEB_ORIGIN } from "./fixtures";

// Exported through Quant's generated PredictionEnvelopeV1 path; source/feed are synthetic and entitlement is unknown.
const PUBLIC_PROTOJSON_FIXTURE = readFileSync(
  "e2e/fixtures/prediction-envelope-v1.synthetic.protojson",
  "utf8",
);
const FACTOR_FEATURE_SUMMARY = {
  candidate_id: "synthetic_close_mean@0123456789abcdef",
  candidate_hash: "a".repeat(64),
  factor_ir_sha256: "b".repeat(64),
  registry_sha256: "c".repeat(64),
  registry_qualification: "UNKNOWN_CALLER_SUPPLIED_IDENTITY",
  feature_sha256: "d".repeat(64),
  feature_receipt_sha256: "e".repeat(64),
  timestamp_index_sha256: "f".repeat(64),
  rows: 390,
  first_valid_row_index: 4,
  model_consumed: true,
  promotion_allowed: false,
};

test.beforeEach(async ({ request }) => resetDownstream(request));

test("market-reader cannot access registered predictions or trigger a Quant lookup", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(result).toEqual({ status: 403, body: { error: "action_forbidden" } });
  expect((await metrics(request)).quant).toMatchObject({ requests: {}, authorized: 0, rejected: 0 });
});

test("explicit private-research role reads a registered view in the native Workspace", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-private-research-reader"]);
  await page.goto(WEB_ORIGIN);
  await page.getByRole("button", { name: "PREDICTION" }).click();
  const widget = page.getByTestId("registered-prediction-widget");
  await expect(widget).toBeVisible();
  await widget.getByLabel("Registered run ID").fill("run-e2e");
  await widget.getByRole("button", { name: "LOOK UP" }).click();
  await expect(widget.getByText("HISTORICAL_SIMULATED_EXPIRED")).toBeVisible();
  await expect(widget.getByText("LOCAL_REGISTERED_ROOT")).toBeVisible();
  await expect(widget.getByText("UNKNOWN_SOURCE_COMPLETENESS")).toBeVisible();
  await expect(widget.getByText("NOT ALLOWED", { exact: true })).toBeVisible();
  await widget.getByText("Show public ProtoJSON projection").click();
  await expect(widget.getByText(/prediction-e2e/)).toBeVisible();

  const serviceMetrics = await metrics(request);
  expect(serviceMetrics.quant.authorized).toBe(1);
  expect(serviceMetrics.quant.calls[0]).toMatchObject({
    method: "GET",
    path: "/v1/research/predictions/run-e2e",
    issuer: "eqoboard-openterminal",
    audience: "lqepoch-quant-research",
    kid: "quant-terminal",
    scope: "research:private-read",
    subject: "subject-e2e",
  });
  expect(serviceMetrics.quant.calls[0].expires_at - serviceMetrics.quant.calls[0].issued_at).toBeLessThanOrEqual(60);
  const browserResult = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  });
  expect(browserResult.status).toBe(200);
  expect(browserResult.cache).toBe("no-store");
  expect(browserResult.body).not.toHaveProperty("private_artifact_sha256");
  expect(browserResult.body).not.toHaveProperty("private_envelope");
  expect((await metrics(request)).quant.authorized).toBe(2);
});

test("research BFF path encoding preserves valid run IDs and exact local receipt status", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-private-research-reader"]);
  await configureMocks(request, { quantFiniteReceiptBinding: "CORE_CANONICAL_EXACT_BYTES_MATCHED_LOCAL_ONLY" });
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e:source@v1+2026", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    run_id: "run-e2e:source@v1+2026",
    assessment: {
      finite_receipt_binding: "CORE_CANONICAL_EXACT_BYTES_MATCHED_LOCAL_ONLY",
      point_in_time: "UNKNOWN_SOURCE_COMPLETENESS",
      promotion_allowed: false,
    },
    promotion_allowed: false,
  });
  expect((await metrics(request)).quant.calls[0].path).toBe(
    "/v1/research/predictions/run-e2e%3Asource%40v1%2B2026",
  );
});

test("BFF accepts only the bounded FactorIR hash summary and strips it from the browser response", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-private-research-reader"]);
  await configureMocks(request, { quantFactorFeatureSummary: FACTOR_FEATURE_SUMMARY });
  const accepted = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(accepted.status).toBe(200);
  expect(accepted.body).not.toHaveProperty("factor_feature");
  expect(accepted.body).not.toHaveProperty("private_artifact_sha256");

  const invalidSummaries = [
    { ...FACTOR_FEATURE_SUMMARY, candidate_hash: "not-a-sha256" },
    { ...FACTOR_FEATURE_SUMMARY, rows: true },
    { ...FACTOR_FEATURE_SUMMARY, rows: 391 },
    { ...FACTOR_FEATURE_SUMMARY, first_valid_row_index: FACTOR_FEATURE_SUMMARY.rows },
    { ...FACTOR_FEATURE_SUMMARY, registry_qualification: "QUALIFIED" },
    { ...FACTOR_FEATURE_SUMMARY, promotion_allowed: true },
    { ...FACTOR_FEATURE_SUMMARY, unexpected: "not in the registered summary contract" },
  ];
  for (const factorFeatureSummary of invalidSummaries) {
    await configureMocks(request, { quantFactorFeatureSummary: factorFeatureSummary });
    const rejected = await page.evaluate(async () => {
      const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
      return { status: response.status, body: await response.json() };
    });
    expect(rejected).toEqual({ status: 502, body: { error: "invalid_prediction_response" } });
  }
});

test("BFF validates the public envelope with the pinned Core ProtoJSON parser", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-private-research-reader"]);

  const maximumSequence = PUBLIC_PROTOJSON_FIXTURE.replace('"sequence":"1"', '"sequence":"18446744073709551615"');
  expect(maximumSequence).not.toBe(PUBLIC_PROTOJSON_FIXTURE);
  await configureMocks(request, { quantProtoJsonText: maximumSequence });
  const maximumSequenceResult = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(maximumSequenceResult.status).toBe(200);

  const unknownFieldEnvelope = JSON.parse(PUBLIC_PROTOJSON_FIXTURE) as Record<string, unknown>;
  const invalidProtoJson = [
    ["unknown field", JSON.stringify({ ...unknownFieldEnvelope, unknownField: "x" })],
    ["duplicate field", PUBLIC_PROTOJSON_FIXTURE.replace(
      '"predictionId":"prediction-e2e"',
      '"predictionId":"prediction-e2e","predictionId":"duplicate"',
    )],
    ["camel and snake aliases", PUBLIC_PROTOJSON_FIXTURE.replace(
      '"predictionId":"prediction-e2e"',
      '"predictionId":"prediction-e2e","prediction_id":"prediction-e2e"',
    )],
    ["numeric uint64", PUBLIC_PROTOJSON_FIXTURE.replace('"sequence":"1"', '"sequence":1')],
    ["raw MessagePack encoding", PUBLIC_PROTOJSON_FIXTURE.replace(
      '"numericEncoding":"NUMERIC_ENCODING_DECIMAL_TOKEN"',
      '"numericEncoding":"NUMERIC_ENCODING_RAW_MESSAGEPACK_BYTES"',
    )],
  ] as const;

  for (const [label, protoJsonText] of invalidProtoJson) {
    expect(protoJsonText, `${label} fixture mutation`).not.toBe(PUBLIC_PROTOJSON_FIXTURE);
    await configureMocks(request, { quantProtoJsonText: protoJsonText });
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
      return { status: response.status, body: await response.json() };
    });
    expect(result, label).toEqual({ status: 502, body: { error: "invalid_prediction_response" } });
  }

  await configureMocks(request, { quantPublicProjectionBase64: "not-base64!" });
  const invalidBase64 = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(invalidBase64).toEqual({ status: 502, body: { error: "invalid_prediction_response" } });

  await configureMocks(request, {
    quantPublicProjectionBase64: null,
    quantPublicProjectionSha256: "0".repeat(64),
  });
  const mismatchedDigest = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(mismatchedDigest).toEqual({ status: 502, body: { error: "invalid_prediction_response" } });
});

test("invalid query and request body are rejected before a Quant lookup", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-private-research-reader"]);
  const query = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e?unexpected=true", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(query).toEqual({ status: 400, body: { error: "invalid_request" } });
  const withBody = await page.context().request.fetch(`${WEB_ORIGIN}/api/eqo/research/predictions/run-e2e`, {
    method: "GET",
    data: "{}",
    headers: { "content-type": "application/json" },
  });
  expect(withBody.status()).toBe(400);
  expect((await metrics(request)).quant.authorized).toBe(0);
});

const registeredRunId = process.env.E2E_QUANT_REGISTERED_RUN_ID;
if (registeredRunId) {
  test("terminal BFF reads a real local synthetic Quant registry result without promoting it", async ({ page, request }) => {
    await loginWithOidc(page, request, ["eqoboard-private-research-reader"]);
    const result = await page.evaluate(async (runId) => {
      const response = await fetch(`/api/eqo/research/predictions/${encodeURIComponent(runId)}`, {
        cache: "no-store",
      });
      return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
    }, registeredRunId);
    expect(result.status).toBe(200);
    expect(result.cache).toBe("no-store");
    expect(result.body).toMatchObject({
      schema_name: "quant-research-registered-prediction-v1",
      authority: "LOCAL_REGISTERED_ROOT",
      read_only: true,
      promotion_allowed: false,
      run_id: registeredRunId,
      prediction_status: "HISTORICAL_SIMULATED_EXPIRED",
      assessment: {
        lifecycle: "UNKNOWN",
        identity_resolution: "VERIFIED_EXACT_ONLY",
        source_manifest_binding: "EXACT_WHOLE_BYTES",
        finite_receipt_binding: "UNKNOWN",
        point_in_time: "UNKNOWN_SOURCE_COMPLETENESS",
        promotion_allowed: false,
      },
    });
    expect(result.body).not.toHaveProperty("private_artifact_sha256");
    expect(result.body).not.toHaveProperty("private_envelope");
    expect(result.body).not.toHaveProperty("factor_feature");

    await page.goto(WEB_ORIGIN);
    await page.getByRole("button", { name: "PREDICTION" }).click();
    const widget = page.getByTestId("registered-prediction-widget");
    await widget.getByLabel("Registered run ID").fill(registeredRunId);
    await widget.getByRole("button", { name: "LOOK UP" }).click();
    await expect(widget.getByText("HISTORICAL_SIMULATED_EXPIRED")).toBeVisible();
    await expect(widget.getByText("UNKNOWN_SOURCE_COMPLETENESS")).toBeVisible();
    await expect(widget.getByText("NOT ALLOWED", { exact: true })).toBeVisible();
  });
}
