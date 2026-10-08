import { configureMocks, expect, loginWithOidc, metrics, resetDownstream, test } from "./fixtures";

const DATASET_ID = "synthetic-e2e-bars-v1";
const LOCAL_MDP_DATASET_ID = "synthetic-2026-10-08-four-bars-parquet-v3-bars-1m-v1";
const ROUTE = `/api/eqo/market-data/datasets/${DATASET_ID}/bars`;

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

test("terminal OIDC BFF reads a synthetic diagnostic dataset from the actual loopback MDP HTTP service", async ({ page, request }) => {
  test.skip(!process.env.E2E_MDP_UPSTREAM_URL, "requires an explicit loopback E2E_MDP_UPSTREAM_URL and local MDP service");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const response = await page.context().request.get(
    `/api/eqo/market-data/datasets/${LOCAL_MDP_DATASET_ID}/bars?namespace=diagnostic&symbol=QQQ`,
  );

  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const body = await response.json();
  expect(body.summary).toMatchObject({
    namespace: "diagnostic",
    dataset_id: LOCAL_MDP_DATASET_ID,
    schema_id: "lqepoch.us_equity_trade_bar_1m.v1",
    source: { provider: "synthetic", feed: "synthetic", entitlement: "unknown" },
    row_count: "4",
    returned_rows: "4",
    parquet_schema_sha256: "5e761a91d880e0002aeafe6dc2083b7c8a0ff2ba486d5d93582fbb4479146cb0",
  });
  expect(body.rows).toHaveLength(4);
  expect(body.rows.every((row: Record<string, unknown>) =>
    row.source_provider === "synthetic" && row.source_feed === "synthetic" &&
    row.source_entitlement === "unknown" && row.completion_mode === "synthetic_eof")).toBe(true);
  expect((await metrics(request)).mdp.requests).toEqual({});
});

test("terminal BFF proxies only diagnostic bars with an isolated short MDP delegation", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const response = await page.context().request.get(
    `${ROUTE}?namespace=diagnostic&symbol=QQQ`,
  );

  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await response.json();
  expect(body.summary).toMatchObject({
    namespace: "diagnostic",
    dataset_id: DATASET_ID,
    schema_id: "lqepoch.us_equity_trade_bar_1m.v1",
    source: {
      provider: "synthetic",
      feed: "synthetic",
      entitlement: "unknown",
      numeric_encoding: "decimal_token",
    },
    row_count: "1",
    returned_rows: "1",
  });
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0]).toMatchObject({
    symbol: "QQQ",
    source_provider: "synthetic",
    source_feed: "synthetic",
    source_entitlement: "unknown",
    completion_mode: "synthetic_eof",
    nbbo_input_status: "excluded",
  });

  const observed = await metrics(request);
  expect(observed.gateway.requests).toEqual({});
  expect(observed.mdp.authorized).toBe(1);
  expect(observed.mdp.rejected).toBe(0);
  expect(observed.mdp.calls[0]).toMatchObject({
    method: "GET",
    path: `/v1/datasets/${DATASET_ID}/bars`,
    dataset_id: DATASET_ID,
    namespace: "diagnostic",
    symbol: "QQQ",
    bearer_present: true,
    kid: "mdp-terminal",
    issuer: "eqoboard-openterminal",
    audience: "lqepoch-market-data",
    subject: "subject-e2e",
    scope: ["market:read"],
  });
  expect(observed.mdp.calls[0].exp - observed.mdp.calls[0].iat).toBeGreaterThan(0);
  expect(observed.mdp.calls[0].exp - observed.mdp.calls[0].iat).toBeLessThanOrEqual(60);
});

test("terminal role denial does not call MDP", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-workspace-editor"]);
  const forbidden = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(forbidden.status()).toBe(403);
  expect(await metrics(request)).toMatchObject({ mdp: { requests: {}, authorized: 0, rejected: 0 } });
});

test("terminal query, curated namespace, and origin failures do not call MDP", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  for (const query of [
    "namespace=curated&symbol=QQQ",
    "namespace=diagnostic&symbol=QQQ&unexpected=true",
    "namespace=diagnostic&symbol=QQQ&symbol=SPY",
    "namespace=diagnostic&symbol=QQQ%2FSPY",
  ]) {
    const response = await page.context().request.get(`${ROUTE}?${query}`);
    expect([400, 403]).toContain(response.status());
  }
  const crossOrigin = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`, {
    headers: { Origin: "http://evil.example.test", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
  });
  expect(crossOrigin.status()).toBe(403);
  expect((await page.context().request.head(`${ROUTE}?namespace=diagnostic&symbol=QQQ`)).status()).toBe(405);
  expect((await page.context().request.fetch(`${ROUTE}?namespace=diagnostic&symbol=QQQ`, { method: "OPTIONS" })).status()).toBe(405);
  expect((await page.context().request.post(`${ROUTE}?namespace=diagnostic&symbol=QQQ`, { data: {} })).status()).toBe(405);
  expect((await metrics(request)).mdp.requests).toEqual({});
});

test("terminal BFF validates sparse-window completeness, schema, size, and redirects", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const valid = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  const validBody = await valid.json();

  const bearishBar = structuredClone(validBody);
  Object.assign(bearishBar.rows[0], { open: "10", high: "11", low: "8", close: "9" });
  await configureMocks(request, { mdpResponse: bearishBar });
  const bearish = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(bearish.status()).toBe(200);

  const invalidOhlc = structuredClone(bearishBar);
  invalidOhlc.rows[0].high = "9";
  await configureMocks(request, { mdpResponse: invalidOhlc });
  const invalidRange = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(invalidRange.status()).toBe(502);

  const completeTwoMinuteWindow = structuredClone(validBody);
  const firstMinute = completeTwoMinuteWindow.rows[0];
  Object.assign(firstMinute, {
    bar_start_utc: "2026-10-07T13:30:00Z",
    bar_end_exclusive_utc: "2026-10-07T13:31:00Z",
    available_at_utc: "2026-10-07T13:32:00Z",
    session_start_utc: "2026-10-07T13:30:00Z",
    session_end_exclusive_utc: "2026-10-07T13:32:00Z",
    window_start_utc: "2026-10-07T13:30:00Z",
    window_end_exclusive_utc: "2026-10-07T13:32:00Z",
    window_expected_minutes: "2",
    window_empty_trade_minutes: "0",
    source_start_utc: "2026-10-07T13:30:30Z",
    source_end_exclusive_utc: "2026-10-07T13:30:30.000000001Z",
  });
  const secondMinute = structuredClone(firstMinute);
  Object.assign(secondMinute, {
    bar_start_utc: "2026-10-07T13:31:00Z",
    bar_end_exclusive_utc: "2026-10-07T13:32:00Z",
    source_start_utc: "2026-10-07T13:31:30Z",
    source_end_exclusive_utc: "2026-10-07T13:31:30.000000001Z",
  });
  completeTwoMinuteWindow.rows = [firstMinute, secondMinute];
  completeTwoMinuteWindow.summary.row_count = "2";
  completeTwoMinuteWindow.summary.returned_rows = "2";
  await configureMocks(request, { mdpResponse: completeTwoMinuteWindow });
  const completeWindow = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(completeWindow.status()).toBe(200);

  const mismatchedSession = structuredClone(completeTwoMinuteWindow);
  mismatchedSession.rows[1].session_end_exclusive_utc = "2026-10-07T13:33:00Z";
  await configureMocks(request, { mdpResponse: mismatchedSession });
  const sessionDrift = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(sessionDrift.status()).toBe(502);

  const mismatchedAvailability = structuredClone(completeTwoMinuteWindow);
  mismatchedAvailability.rows[1].available_at_utc = "2026-10-07T13:32:01Z";
  await configureMocks(request, { mdpResponse: mismatchedAvailability });
  const availabilityDrift = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(availabilityDrift.status()).toBe(502);

  const mismatchedCompletion = structuredClone(completeTwoMinuteWindow);
  mismatchedCompletion.summary.source = {
    provider: "fixture-provider",
    feed: "sip",
    entitlement: "unknown",
    numeric_encoding: "decimal_token",
  };
  Object.assign(mismatchedCompletion.rows[0], {
    source_provider: "fixture-provider",
    source_feed: "sip",
    completion_mode: "historical_eof_nonpaged",
    source_pages_exhausted: null,
  });
  Object.assign(mismatchedCompletion.rows[1], {
    source_provider: "fixture-provider",
    source_feed: "sip",
    completion_mode: "historical_eof_paged",
    source_pages_exhausted: true,
  });
  await configureMocks(request, { mdpResponse: mismatchedCompletion });
  const completionDrift = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(completionDrift.status()).toBe(502);

  const explicitEmptyMinute = structuredClone(validBody);
  Object.assign(explicitEmptyMinute.rows[0], {
    bar_start_utc: "2026-10-07T13:31:00Z",
    bar_end_exclusive_utc: "2026-10-07T13:32:00Z",
    available_at_utc: "2026-10-07T13:32:00Z",
    session_end_exclusive_utc: "2026-10-07T13:32:00Z",
    window_end_exclusive_utc: "2026-10-07T13:32:00Z",
    window_expected_minutes: "2",
    window_empty_trade_minutes: "1",
    source_start_utc: "2026-10-07T13:31:30Z",
    source_end_exclusive_utc: "2026-10-07T13:31:30.000000001Z",
  });
  await configureMocks(request, { mdpResponse: explicitEmptyMinute });
  const sparseWindow = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(sparseWindow.status()).toBe(200);

  const invalidSchema = structuredClone(validBody);
  invalidSchema.summary.parquet_schema_sha256 = "f".repeat(64);
  await configureMocks(request, { mdpResponse: invalidSchema });
  const schemaDrift = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(schemaDrift.status()).toBe(502);
  expect(await schemaDrift.json()).toEqual({ error: "invalid_market_data_response" });

  const invalidDecimal = structuredClone(validBody);
  invalidDecimal.rows[0].open = 500;
  await configureMocks(request, { mdpResponse: invalidDecimal });
  const numericPrice = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(numericPrice.status()).toBe(502);

  const incompleteWindow = structuredClone(validBody);
  incompleteWindow.rows[0].session_end_exclusive_utc = "2026-10-07T13:32:00Z";
  incompleteWindow.rows[0].window_end_exclusive_utc = "2026-10-07T13:32:00Z";
  incompleteWindow.rows[0].window_expected_minutes = "2";
  await configureMocks(request, { mdpResponse: incompleteWindow });
  const missingMinute = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(missingMinute.status()).toBe(502);

  const tooManyRows = structuredClone(validBody);
  tooManyRows.summary.row_count = "391";
  tooManyRows.summary.returned_rows = "391";
  tooManyRows.rows = Array.from({ length: 391 }, () => structuredClone(validBody.rows[0]));
  await configureMocks(request, { mdpResponse: tooManyRows });
  const rowLimit = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(rowLimit.status()).toBe(502);

  await configureMocks(request, { mdpBodyBytes: 4 * 1024 * 1024 + 1 });
  const oversized = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(oversized.status()).toBe(502);
  expect(await oversized.json()).toEqual({ error: "invalid_market_data_response" });

  await configureMocks(request, { mdpBodyBytes: 0, mdpStatus: 302, mdpLocation: "http://127.0.0.1:4313/redirected" });
  const redirected = await page.context().request.get(`${ROUTE}?namespace=diagnostic&symbol=QQQ`);
  expect(redirected.status()).toBe(503);
  expect(await redirected.json()).toEqual({ error: "market_data_service_unavailable" });
  const observed = await metrics(request);
  expect(observed.mdp.requests["/redirected"]).toBeUndefined();
});
