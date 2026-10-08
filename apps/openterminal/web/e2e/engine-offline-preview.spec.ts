import { configureMocks, expect, loginWithOidc, metrics, resetDownstream, test } from "./fixtures";

const STATUS_ROUTE = "/api/eqo/engine/status";
const PREVIEW_ROUTE = "/api/eqo/engine/preview";

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

test("Engine BFF requires the dedicated OIDC role and mints only its short read delegation", async ({ page, request }) => {
  const anonymous = await request.get(`${process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3300"}${STATUS_ROUTE}`);
  expect(anonymous.status()).toBe(401);
  expect((await metrics(request)).engine.requests).toEqual({});

  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const marketReader = await page.context().request.get(STATUS_ROUTE);
  expect(marketReader.status()).toBe(403);
  expect((await metrics(request)).engine.requests).toEqual({});

  await page.context().clearCookies();
  await loginWithOidc(page, request, ["eqoboard-engine-offline-reader"]);

  const statusResponse = await page.context().request.get(STATUS_ROUTE);
  expect(statusResponse.status()).toBe(200);
  expect(statusResponse.headers()["cache-control"]).toBe("no-store");
  expect(statusResponse.headers()["x-content-type-options"]).toBe("nosniff");
  const status = await statusResponse.json();
  expect(status).toMatchObject({
    $typeName: "lqepoch.engine.v1.EngineStatusResponseV1",
    apiVersion: "v1",
    service: "offline-persist-preview",
    serviceReadiness: "read_only_ready",
    sourceReadiness: "unknown",
    mode: "synthetic_offline",
    executionEnabled: false,
    mutationRoutesEnabled: false,
    schemaVersion: 15,
    pendingUnknownCount: 1,
    pendingUnknownCountCapped: false,
    pendingUnknownConsumedRiskCount: 1,
    pendingUnknownUnverifiedRiskCount: 0,
  });
  expect(status).not.toHaveProperty("api_version");

  const previewResponse = await page.context().request.get(PREVIEW_ROUTE);
  expect(previewResponse.status()).toBe(200);
  expect(previewResponse.headers()["cache-control"]).toBe("no-store");
  const preview = await previewResponse.json();
  expect(preview).toMatchObject({
    $typeName: "lqepoch.engine.v1.SyntheticOfflinePreviewV1",
    sourceMode: "synthetic_offline",
    sourceProvenance: "synthetic_only",
    executionEnabled: false,
    orderMutationsEnabled: false,
    accountDataLoaded: false,
    marketDataConnected: false,
    pendingUnknownCount: 1,
    pendingUnknownCountCapped: false,
    pendingUnknownConsumedRiskCount: 1,
    pendingUnknownUnverifiedRiskCount: 0,
    disposition: "reconciliation_required",
  });
  expect(preview).not.toHaveProperty("source_mode");

  const observed = await metrics(request);
  expect(observed.engine.authorized).toBe(2);
  expect(observed.engine.rejected).toBe(0);
  expect(observed.engine.calls.map((call: { path: string }) => call.path)).toEqual([
    "/v1/status", "/v1/preview",
  ]);
  for (const call of observed.engine.calls) {
    expect(call).toMatchObject({
      method: "GET",
      issuer: "eqoboard-openterminal",
      audience: "lqepoch-trading-engine",
      kid: "engine-terminal",
      scope: "engine:offline-read",
      subject: "subject-e2e",
    });
    expect(call.expires_at - call.issued_at).toBeGreaterThan(0);
    expect(call.expires_at - call.issued_at).toBeLessThanOrEqual(60);
  }
  expect(observed.gateway.requests).toEqual({});
  expect(observed.mdp.requests).toEqual({});
  expect(observed.quant.requests).toEqual({});
});

test("Engine read routes reject other roles, research mode, writes, query strings, and cross-origin requests", async ({ page, request }) => {
  const crossOrigin = await request.get(`${process.env.E2E_WEB_ORIGIN ?? "http://127.0.0.1:3300"}${STATUS_ROUTE}`, {
    headers: { Origin: "http://evil.example.test", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
  });
  expect(crossOrigin.status()).toBe(403);
  expect((await request.get(`${STATUS_ROUTE}?unexpected=true`)).status()).toBe(400);
  expect((await request.head(STATUS_ROUTE)).status()).toBe(405);
  expect((await request.fetch(STATUS_ROUTE, { method: "OPTIONS" })).status()).toBe(405);
  expect((await request.post(STATUS_ROUTE, { data: {} })).status()).toBe(405);
  expect((await metrics(request)).engine.requests).toEqual({});

  await loginWithOidc(page, request, ["eqoboard-private-research-reader"]);
  const researchReader = await page.context().request.get(PREVIEW_ROUTE);
  expect(researchReader.status()).toBe(403);
  expect((await metrics(request)).engine.requests).toEqual({});
});

test("native Workspace Engine widget shows only bounded synthetic and unknown preview state", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-engine-offline-reader"]);
  await page.goto("/");
  await page.getByRole("button", { name: "ENGINE PREVIEW" }).click();
  const widget = page.getByTestId("engine-offline-preview-widget");
  await expect(widget).toContainText("Synthetic diagnostic only");
  await expect(widget).toContainText("Source is unknown");
  await expect(widget).toContainText("Execution, orders, and mutations remain disabled");
  await widget.getByRole("button", { name: "LOAD PREVIEW" }).click();
  const evidence = page.getByTestId("engine-preview-evidence");
  await expect(evidence).toContainText("synthetic_only");
  await expect(evidence).toContainText("Pending unknown records in bounded sample: 1");
  await expect(evidence).toContainText("Unverified risk reservations: 0");
  await expect(evidence).toContainText("DISABLED");
  const observed = await metrics(request);
  expect(observed.engine.calls.map((call: { path: string }) => call.path)).toEqual([
    "/v1/status", "/v1/preview",
  ]);
});

test("Engine BFF fails closed on redirect, oversized, non-JSON, malformed, and slow responses", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-engine-offline-reader"]);

  await configureMocks(request, { engineStatusCode: 302, engineStatusLocation: "http://evil.example.test/redirect" });
  const redirect = await page.context().request.get(STATUS_ROUTE);
  expect(redirect.status()).toBe(503);
  expect(redirect.headers()["cache-control"]).toBe("no-store");

  await configureMocks(request, { engineStatusCode: 200, engineStatusLocation: null, engineStatusBodyBytes: 16 * 1024 + 1 });
  const oversized = await page.context().request.get(STATUS_ROUTE);
  expect(oversized.status()).toBe(502);
  expect(oversized.headers()["cache-control"]).toBe("no-store");

  await configureMocks(request, { engineStatusBodyBytes: 0, engineStatusContentType: "text/plain" });
  const wrongContentType = await page.context().request.get(STATUS_ROUTE);
  expect(wrongContentType.status()).toBe(502);

  await configureMocks(request, { engineStatusContentType: "application/json", engineStatusText: '{"api_version":"v1","execution_enabled":true}' });
  const malformed = await page.context().request.get(STATUS_ROUTE);
  expect(malformed.status()).toBe(502);

  await configureMocks(request, { engineStatusText: undefined, engineDelayMs: 3_500 });
  const timeout = await page.context().request.get(STATUS_ROUTE);
  expect(timeout.status()).toBe(504);
  expect(timeout.headers()["cache-control"]).toBe("no-store");
});
