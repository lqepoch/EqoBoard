import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { validateYfinanceResearchResponse } from "../lib/yfinance-research-contract";

const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? `http://127.0.0.1:${process.env.E2E_RESEARCH_WEB_PORT ?? "3320"}`;
const OIDC_ORIGIN = process.env.E2E_OIDC_ORIGIN ?? `http://127.0.0.1:${process.env.E2E_OIDC_PORT ?? "4320"}`;
const SAME_HOSTNAME_WEB_ORIGIN = `http://127.0.0.1:${process.env.E2E_RESEARCH_SAME_HOSTNAME_PORT ?? "3321"}`;
const CREDENTIAL_WEB_ORIGIN = `http://127.0.0.1:${process.env.E2E_RESEARCH_CREDENTIAL_PORT ?? "3322"}`;
const LOCAL_MDP_DATASET_ID = "synthetic-2026-10-08-four-bars-parquet-v3-bars-1m-v1";

async function postJson(request: APIRequestContext, url: string, data: unknown) {
  const response = await request.post(url, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response;
}

async function reset(request: APIRequestContext) {
  await postJson(request, `${OIDC_ORIGIN}/__test/reset`, {});
}

async function metrics(request: APIRequestContext) {
  const response = await request.get(`${OIDC_ORIGIN}/__test/metrics`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function configureGateway(request: APIRequestContext, config: Record<string, unknown>) {
  return postJson(request, `${OIDC_ORIGIN}/__test/config`, config);
}

async function signIn(page: Page, request: APIRequestContext, roles: string[]) {
  await postJson(request, `${OIDC_ORIGIN}/__test/roles`, { roles });
  const callbackUrl = `${WEB_ORIGIN}/api/healthz`;
  const signInUrl = new URL("/api/auth/signin/eqo-oidc", WEB_ORIGIN);
  signInUrl.searchParams.set("callbackUrl", callbackUrl);
  await page.goto(signInUrl.toString());
  await page.getByRole("button", { name: /Organization sign-in/ }).click();
  await expect(page).toHaveURL(callbackUrl);

  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body.user.id).toBe("subject-e2e");
  expect(session.body.user.roles).toEqual(roles);
  expect(session.body.user.issuer).toBe(OIDC_ORIGIN);
  return session.body;
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("research runtime exposes only auth, health, manifests, and allowlisted read APIs", async ({ page, request }) => {
  const readiness = await request.get(`${WEB_ORIGIN}/api/readyz`);
  expect(readiness.status()).toBe(200);
  expect(await readiness.json()).toMatchObject({ ready: true, runtime_mode: "research", execution_enabled: false });

  const health = await request.get(`${WEB_ORIGIN}/api/healthz`);
  expect(await health.json()).toMatchObject({ status: "ok", service: "eqoboard-research-bff" });

  await page.context().addCookies([{
    name: "next-auth.session-token",
    value: "terminal-session-must-not-cross-hostnames",
    url: "http://localhost:3000",
    httpOnly: true,
    sameSite: "Lax",
  }]);
  let researchCookieHeader = "";
  await page.route(`${WEB_ORIGIN}/api/healthz`, async (route) => {
    researchCookieHeader = (await route.request().allHeaders()).cookie ?? "";
    await route.continue();
  });
  await page.goto(`${WEB_ORIGIN}/api/healthz`);
  expect(researchCookieHeader).not.toContain("terminal-session-must-not-cross-hostnames");

  const anonymousAuthCheck = await request.get(`${WEB_ORIGIN}/api/research/auth-check`);
  expect(anonymousAuthCheck.status()).toBe(401);
  expect(await anonymousAuthCheck.json()).toEqual({ error: "authentication_required" });
  const anonymousMdpBars = await request.get(
    `${WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
  );
  expect(anonymousMdpBars.status()).toBe(401);
  const engineInResearchMode = await request.get(`${WEB_ORIGIN}/api/eqo/engine/status`);
  expect(engineInResearchMode.status()).toBe(404);
  expect(await metrics(request)).toMatchObject({ mdp: { requests: {}, authorized: 0, rejected: 0 } });
  expect((await metrics(request)).engine).toMatchObject({ requests: {}, authorized: 0, rejected: 0 });

  const csrfResponse = await page.context().request.get(`${WEB_ORIGIN}/api/auth/csrf`);
  expect(csrfResponse.status()).toBe(200);
  const { csrfToken } = await csrfResponse.json();
  const formSignOut = await page.context().request.post(`${WEB_ORIGIN}/api/auth/signout`, {
    form: { csrfToken, callbackUrl: `${WEB_ORIGIN}/api/healthz`, json: "true" },
  });
  expect(formSignOut.status()).toBe(200);
  expect(await formSignOut.json()).toMatchObject({ url: `${WEB_ORIGIN}/api/healthz` });

  for (const path of [
    "/", "/login", "/api/eqo/orders/preview", "/api/portfolios", "/api/quotes",
    "/api/auth/not-a-nextauth-endpoint", "/_next/static/chunks/app.js",
    "/api/openbb/v1/stocks?symbols=QQQ",
  ]) {
    expect((await request.get(`${WEB_ORIGIN}${path}`)).status(), path).toBe(404);
  }
  expect((await request.get(`${WEB_ORIGIN}/%61pi/eqo/orders/preview`)).status()).toBe(404);
  expect((await request.post(`${WEB_ORIGIN}/api/openbb/openbb/v1/options`, { data: {} })).status()).toBe(404);
  expect((await request.post(`${WEB_ORIGIN}/api/research/auth-check`)).status()).toBe(404);
  expect((await request.post(
    `${WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
    { data: {} },
  )).status()).toBe(404);
  expect((await request.head(
    `${WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
  )).status()).toBe(404);
  expect((await request.fetch(
    `${WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
    { method: "OPTIONS" },
  )).status()).toBe(404);
  for (const path of [
    "/api/portfolios",
    "/api/ai/chat",
    "/api/eqo/orders/preview",
    "/api/eqo/orders/submit",
    "/api/eqo/stocks/subscribe",
    "/api/eqo/options/subscribe",
  ]) {
    expect((await request.post(`${WEB_ORIGIN}${path}`, { data: { symbol: "QQQ" } })).status(), path).toBe(404);
  }
  for (const path of [
    "/api/portfolios",
    "/api/ai/chat",
    "/api/eqo/orders/preview",
    "/api/eqo/stocks/subscribe",
    "/api/eqo/options/subscribe",
    "/api/auth/not-a-nextauth-endpoint",
  ]) {
    expect((await request.head(`${WEB_ORIGIN}${path}`)).status(), `HEAD ${path}`).toBe(404);
    expect((await request.fetch(`${WEB_ORIGIN}${path}`, { method: "OPTIONS" })).status(), `OPTIONS ${path}`).toBe(404);
  }
  expect((await request.get(`${WEB_ORIGIN}/api/portfolios`)).status()).toBe(404);
  expect((await request.get(`${WEB_ORIGIN}/api/eqo/stocks/subscribe`)).status()).toBe(404);
  expect((await request.get(`${WEB_ORIGIN}/api/eqo/options/subscribe`)).status()).toBe(404);
  expect((await request.post(`${WEB_ORIGIN}/api/auth/not-a-nextauth-endpoint`, { data: { token: "ignored" } })).status()).toBe(404);

  const sameHostnameReadiness = await request.get(`${SAME_HOSTNAME_WEB_ORIGIN}/api/readyz`);
  expect(sameHostnameReadiness.status()).toBe(503);
  expect(await sameHostnameReadiness.json()).toMatchObject({ ready: false, runtime_mode: "research" });

  const credentialReadiness = await request.get(`${CREDENTIAL_WEB_ORIGIN}/api/readyz`);
  expect(credentialReadiness.status()).toBe(503);
  expect(await credentialReadiness.json()).toMatchObject({ ready: false, runtime_mode: "research" });
  const credentialMarketRequest = await request.get(`${CREDENTIAL_WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ`);
  expect(credentialMarketRequest.status()).toBe(503);
  const credentialMdpRequest = await request.get(
    `${CREDENTIAL_WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
  );
  expect(credentialMdpRequest.status()).toBe(503);
  const sameHostnameMdpRequest = await request.get(
    `${SAME_HOSTNAME_WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
  );
  expect(sameHostnameMdpRequest.status()).toBe(503);
  expect(await metrics(request)).toMatchObject({ gateway: { requests: {}, authorized: 0, rejected: 0 } });
  expect((await metrics(request)).mdp.requests).toEqual({});

  const manifests = await request.get(`${WEB_ORIGIN}/api/openbb/widgets.json`);
  expect(manifests.status()).toBe(200);
  expect(await manifests.json()).toMatchObject({
    eqo_sip_watchlist: { endpoint: "openbb/v1/stocks" },
    eqo_sip_bars: { endpoint: "openbb/v1/bars" },
    eqo_opra_contracts: { endpoint: "openbb/v1/options" },
  });
  expect((await request.get(`${WEB_ORIGIN}/api/openbb/apps.json`)).status()).toBe(200);
  expect((await request.get(`${WEB_ORIGIN}/api/openbb/widgets.json?unexpected=true`)).status()).toBe(400);

  const anonymousMarket = await request.get(
    `${WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=bad%2Fpath&unexpected=true`,
  );
  expect(anonymousMarket.status()).toBe(401);
  expect(await metrics(request)).toMatchObject({ gateway: { authorized: 0, rejected: 0 } });
});

test("research BFF requires the separate private-research role and signs the research Quant identity", async ({ page, request }) => {
  await signIn(page, request, ["eqoboard-market-reader"]);
  const marketReader = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(marketReader).toEqual({ status: 403, body: { error: "action_forbidden" } });
  expect((await metrics(request)).quant).toMatchObject({ requests: {}, authorized: 0, rejected: 0 });
});

test("research-only role receives a private, short-lived Quant read delegation", async ({ page, request }) => {
  await signIn(page, request, ["eqoboard-private-research-reader"]);
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/research/predictions/run-e2e", { cache: "no-store" });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  });
  expect(result.status).toBe(200);
  expect(result.cache).toBe("no-store");
  expect(result.body).toMatchObject({
    authority: "LOCAL_REGISTERED_ROOT",
    prediction_status: "HISTORICAL_SIMULATED_EXPIRED",
    promotion_allowed: false,
    assessment: { lifecycle: "UNKNOWN", point_in_time: "UNKNOWN_SOURCE_COMPLETENESS", promotion_allowed: false },
  });
  expect(result.body).not.toHaveProperty("private_artifact_sha256");
  expect(result.body).not.toHaveProperty("private_envelope");
  expect((await metrics(request)).quant.calls[0]).toMatchObject({
    issuer: "openterminal-research",
    audience: "lqepoch-quant-research",
    kid: "quant-research",
    scope: "research:private-read",
    subject: "subject-e2e",
  });
});

const registeredQuantRunId = process.env.E2E_QUANT_REGISTERED_RUN_ID;
if (registeredQuantRunId) {
  test("research-host BFF reads a real local Quant result with its isolated research signer", async ({ page, request }) => {
    await signIn(page, request, ["eqoboard-private-research-reader"]);
    const result = await page.evaluate(async (runId) => {
      const response = await fetch(`/api/eqo/research/predictions/${encodeURIComponent(runId)}`, {
        cache: "no-store",
      });
      return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
    }, registeredQuantRunId);

    expect(result.status).toBe(200);
    expect(result.cache).toBe("no-store");
    expect(result.body).toMatchObject({
      schema_name: "quant-research-registered-prediction-v1",
      authority: "LOCAL_REGISTERED_ROOT",
      read_only: true,
      promotion_allowed: false,
      run_id: registeredQuantRunId,
      prediction_status: "HISTORICAL_SIMULATED_EXPIRED",
      assessment: {
        lifecycle: "UNKNOWN",
        finite_receipt_binding: "UNKNOWN",
        point_in_time: "UNKNOWN_SOURCE_COMPLETENESS",
        promotion_allowed: false,
      },
    });
    expect(result.body).not.toHaveProperty("private_artifact_sha256");
    expect(result.body).not.toHaveProperty("private_envelope");
  });
}

test("market-reader OIDC session reaches SIP and OPRA only through short research delegation", async ({ page, request }) => {
  await signIn(page, request, ["eqoboard-market-reader"]);
  const authCheck = await page.context().request.get(`${WEB_ORIGIN}/api/research/auth-check`);
  expect(authCheck.status()).toBe(204);
  expect(await authCheck.text()).toBe("");
  const cookies = await page.context().cookies(WEB_ORIGIN);
  const cookieNames = cookies.map((cookie) => cookie.name);
  expect(cookieNames).toContain("eqo-research-session-token");
  expect(cookieNames).not.toContain("next-auth.session-token");

  const stocks = await page.context().request.get(`${WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ,SPY`);
  expect(stocks.status()).toBe(200);
  const stockRows = await stocks.json();
  expect(stockRows).toEqual([
    { symbol: "QQQ", last: 500, bid: 499.99, ask: 500.01, volume: 1000, updated_at: "2026-10-07T12:00:00Z", feed: "sip" },
    { symbol: "SPY", last: 500, bid: 499.99, ask: 500.01, volume: 1000, updated_at: "2026-10-07T12:00:00Z", feed: "sip" },
  ]);
  expect(stockRows[0]).not.toHaveProperty("source");
  expect(stockRows[0]).not.toHaveProperty("source_label");

  const bars = await page.context().request.get(
    `${WEB_ORIGIN}/api/openbb/openbb/v1/bars?symbol=qqq&timeframe=1Day&days=30&limit=500`,
  );
  expect(bars.status()).toBe(200);
  expect(await bars.json()).toEqual([{
    symbol: "QQQ", time: "2026-10-07T12:00:00Z", open: 499, high: 501, low: 498,
    close: 500, volume: 1000, feed: "sip",
  }]);

  const options = await page.context().request.get(
    `${WEB_ORIGIN}/api/openbb/openbb/v1/options?underlying=qqq&expiration=2026-10-09`,
  );
  expect(options.status()).toBe(200);
  expect(await options.json()).toEqual([{
    symbol: "QQQ261009C00500000", underlying: "QQQ", expiration: "2026-10-09",
    right: "call", strike: 500, bid: 4.99, ask: 5.01, feed: "opra",
    updated_at: "2026-10-07T12:00:00Z", truncated: false,
  }]);

  const mdpBars = await page.context().request.get(
    `${WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
  );
  expect(mdpBars.status()).toBe(200);
  expect(mdpBars.headers()["cache-control"]).toBe("no-store");
  const mdpBody = await mdpBars.json();
  expect(mdpBody.summary).toMatchObject({
    namespace: "diagnostic",
    source: { provider: "synthetic", feed: "synthetic", entitlement: "unknown" },
  });
  expect(mdpBody.rows[0]).toMatchObject({ source_provider: "synthetic", source_entitlement: "unknown" });

  await configureGateway(request, { openbbOptionsTruncated: true });
  const truncated = await page.context().request.get(
    `${WEB_ORIGIN}/api/openbb/openbb/v1/options?underlying=QQQ&expiration=2026-10-09`,
  );
  expect((await truncated.json())[0].truncated).toBe(true);

  const result = await metrics(request);
  const marketCalls = result.gateway.calls.filter((call: { path: string }) => call.path.startsWith("/openbb/v1/"));
  expect(marketCalls.map((call: { path: string }) => call.path)).toEqual([
    "/openbb/v1/stocks", "/openbb/v1/bars", "/openbb/v1/options", "/openbb/v1/options",
  ]);
  for (const call of marketCalls) {
    expect(call).toMatchObject({
      method: "GET", kid: "research", scope: ["market:read"], subject: "subject-e2e",
      issuer: "openterminal-research", audience: "eqoboard-gateway",
    });
    expect(call.exp - call.iat).toBeGreaterThan(0);
    expect(call.exp - call.iat).toBeLessThanOrEqual(60);
  }
  expect(marketCalls[0]).toMatchObject({ symbols: "QQQ,SPY" });
  expect(marketCalls[1]).toMatchObject({ symbol: "QQQ", timeframe: "1Day", days: "30", limit: "500" });
  expect(marketCalls[2]).toMatchObject({ underlying: "QQQ", expiration: "2026-10-09" });
  expect(result.research.requests).toEqual({});
  expect(result.mdp.authorized).toBe(1);
  expect(result.mdp.calls[0]).toMatchObject({
    kid: "mdp-research",
    issuer: "openterminal-research",
    audience: "lqepoch-market-data",
    subject: "subject-e2e",
    scope: ["market:read"],
  });
  expect(result.mdp.calls[0].exp - result.mdp.calls[0].iat).toBeGreaterThan(0);
  expect(result.mdp.calls[0].exp - result.mdp.calls[0].iat).toBeLessThanOrEqual(60);
});

test("research OIDC BFF reads synthetic diagnostic bars from the actual loopback MDP HTTP service", async ({ page, request }) => {
  test.skip(!process.env.E2E_MDP_UPSTREAM_URL, "requires an explicit loopback E2E_MDP_UPSTREAM_URL and local MDP service");
  await reset(request);
  await signIn(page, request, ["eqoboard-market-reader"]);
  const response = await page.context().request.get(
    `${WEB_ORIGIN}/api/eqo/market-data/datasets/${LOCAL_MDP_DATASET_ID}/bars?namespace=diagnostic&symbol=QQQ`,
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

test("wrong role, feed denial, invalid input, and unknown paths fail without fallback", async ({ page, request }) => {
  await signIn(page, request, ["eqoboard-workspace-editor"]);
  const authCheck = await page.context().request.get(`${WEB_ORIGIN}/api/research/auth-check`);
  expect(authCheck.status()).toBe(403);
  expect(await authCheck.json()).toEqual({ error: "action_forbidden" });
  const forbidden = await page.context().request.get(`${WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ`);
  expect(forbidden.status()).toBe(403);
  const forbiddenMdp = await page.context().request.get(
    `${WEB_ORIGIN}/api/eqo/market-data/datasets/synthetic-e2e-bars-v1/bars?namespace=diagnostic&symbol=QQQ`,
  );
  expect(forbiddenMdp.status()).toBe(403);
  expect(await metrics(request)).toMatchObject({ gateway: { requests: {}, authorized: 0 } });
  expect((await metrics(request)).mdp.requests).toEqual({});

  await signIn(page, request, ["eqoboard-market-reader"]);
  for (const url of [
    `${WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ&unexpected=true`,
    `${WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=bad%2Fpath`,
    `${WEB_ORIGIN}/api/openbb/openbb/v1/options?underlying=QQQ&expiration=2026-13-45`,
    `${WEB_ORIGIN}/api/openbb/openbb/v1/options?underlying=QQQ&expiration=2026-02-31`,
  ]) {
    expect((await page.context().request.get(url)).status(), url).toBe(400);
  }
  expect((await page.context().request.get(`${WEB_ORIGIN}/api/openbb/openbb/v1/orders/preview`)).status()).toBe(404);
  expect((await page.context().request.get(`${WEB_ORIGIN}/api/openbb/openbb/v1/bars?symbol=QQQ&days=999999`)).status()).toBe(400);

  await reset(request);
  const crossOrigin = await page.context().request.get(`${WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ`, {
    headers: { Origin: OIDC_ORIGIN, "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors" },
  });
  expect(crossOrigin.status()).toBe(403);
  expect((await metrics(request)).gateway.requests).toEqual({});

  await configureGateway(request, { openbbOptionsStatus: 403 });
  const opraDenied = await page.context().request.get(
    `${WEB_ORIGIN}/api/openbb/openbb/v1/options?underlying=QQQ&expiration=2026-10-09`,
  );
  expect(opraDenied.status()).toBe(403);
  expect(await opraDenied.json()).toEqual({ error: "opra_unavailable" });
  const result = await metrics(request);
  expect(result.gateway.requests).toEqual({ "/openbb/v1/options": 1 });
  expect(result.research.requests).toEqual({});
});

test("Yahoo research daily BFF keeps a full 2010-2026 query stable across opaque older-page cursors", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true } });
  await signIn(page, request, ["eqoboard-market-reader"]);

  const query = new URLSearchParams({
    symbols: "AAPL",
    asset_class: "stock",
    start_utc: "2010-01-01T00:00:00Z",
    end_utc: "2026-01-01T00:00:00Z",
    adjustment: "unadjusted",
  });
  const firstResponse = await page.context().request.get(`${WEB_ORIGIN}/api/research/yfinance/daily?${query}`);
  expect(firstResponse.status()).toBe(200);
  expect(firstResponse.headers()["cache-control"]).toBe("no-store");
  const first = await firstResponse.json();
  expect(first).toMatchObject({
    schema_version: "mdp-yfinance-research-observations-v1",
    provider: "yfinance",
    source: "Yahoo Finance",
    resolution: "1d",
    requested_adjustment: "unadjusted",
    provider_adjustment_semantics: "unknown_or_provider_native",
    adjustment_confirmed_raw: false,
    numeric_encoding: "binary_float_projection",
    canonical: false,
    point_in_time: false,
    executable: false,
    display_only: true,
    mdp_coverage_asserted: false,
    requested_range: {
      start_utc: "2010-01-01T00:00:00Z",
      end_utc: "2026-01-01T00:00:00Z",
      semantics: "start_inclusive_end_exclusive",
    },
  });
  expect(first.observation.payload).toMatchObject({
    provider_repair_enabled: false,
    volume_encoding: "integer_exact_or_safe_integer_float",
    available_at: expect.any(String),
    source_observed_at: expect.any(String),
    provenance: {
      provider: "yahoo_finance",
      source: "yfinance",
      schema_version: "research-bars-v1",
      include_actions: true,
      prepost: false,
    },
  });
  expect(first.observation.payload.provenance.acquired_at).toMatch(/\+00:00$/);
  expect(first.observation.payload.provenance.served_at).toMatch(/\+00:00$/);
  expect(first.page_range.start_utc).toBe("2016-01-04T00:00:00.000Z");
  expect(first.page_range.end_utc).toBe("2026-01-01T00:00:00.000Z");
  expect(first.next_cursor).toBe("older:1");
  expect(first.observation.payload.bars.every((bar: Record<string, unknown>) => bar.resolution === "1d")).toBe(true);

  const olderQuery = new URLSearchParams(query);
  olderQuery.set("cursor", first.next_cursor);
  const olderResponse = await page.context().request.get(`${WEB_ORIGIN}/api/research/yfinance/daily?${olderQuery}`);
  expect(olderResponse.status()).toBe(200);
  const older = await olderResponse.json();
  expect(older.requested_range).toEqual(first.requested_range);
  expect(older.page_range.end_utc).toBe(first.page_range.start_utc);
  expect(older.next_cursor).toBeNull();
  expect(older.observation.payload.bars.map((bar: Record<string, unknown>) => bar.event_ts_utc)).toEqual([
    "2010-01-04T00:00:00.000Z",
    "2015-12-31T00:00:00.000Z",
  ]);
  expect(older.observation.payload.bars.every((bar: Record<string, unknown>) =>
    bar.symbol === "AAPL" && bar.resolution === "1d" && bar.adjustment === "unadjusted")).toBe(true);
  expect(older.observation.payload.coverage.calendar_gaps_assessed).toBe(false);
  expect(older.observation.payload.coverage.gaps).toContainEqual({ code: "DATE_GAPS_UNASSESSED" });

  const calls = (await metrics(request)).mdpYfinanceResearch;
  expect(calls).toHaveLength(2);
  expect(calls.map((call: { query: Record<string, string> }) => call.query.cursor ?? "")).toEqual(["", "older:1"]);
  for (const call of calls) {
    expect(call).toMatchObject({
      method: "GET",
      path: "/v1/research/yfinance/daily",
      bearer_present: true,
      gateway_delegation_present: false,
      kid: "mdp-research",
      issuer: "openterminal-research",
      audience: "lqepoch-market-data",
      subject: "subject-e2e",
      scope: ["market:read"],
    });
    expect(call.query).toMatchObject({
      symbols: "AAPL",
      asset_class: "stock",
      start_utc: "2010-01-01T00:00:00Z",
      end_utc: "2026-01-01T00:00:00Z",
      adjustment: "unadjusted",
    });
    expect(call.query).not.toHaveProperty("provider_mode");
    expect(call.query).not.toHaveProperty("resolution");
  }
  expect(JSON.stringify(calls)).not.toContain("q".repeat(64));
});

test("Yahoo research contract orders nanosecond timestamps numerically and rejects duplicate or reversed bars", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true } });
  await signIn(page, request, ["eqoboard-market-reader"]);

  const query = new URLSearchParams({
    symbols: "AAPL",
    asset_class: "stock",
    start_utc: "1996-01-01T00:00:00Z",
    end_utc: "2006-01-01T00:00:00Z",
    adjustment: "unadjusted",
  });
  const url = `${WEB_ORIGIN}/api/research/yfinance/daily?${query}`;
  const initial = await page.context().request.get(url);
  expect(initial.status()).toBe(200);
  type SyntheticEnvelope = {
    observation: {
      source_observation_sha256: string;
      payload: {
        bars: Array<Record<string, unknown>>;
        coverage: { bar_count: number; per_symbol: Array<Record<string, unknown>> };
        provenance: { row_count: number };
      };
    };
  };
  const chronological = await initial.json() as SyntheticEnvelope;
  const template = chronological.observation.payload.bars[0]!;
  const beforeNanosecondBoundary = { ...template, event_ts_utc: "1999-01-04T00:00:00Z" };
  const afterNanosecondBoundary = { ...template, event_ts_utc: "2002-01-03T00:00:00Z" };
  chronological.observation.payload.bars = [beforeNanosecondBoundary, afterNanosecondBoundary];
  chronological.observation.payload.coverage.bar_count = 2;
  chronological.observation.payload.coverage.per_symbol[0]!.bar_count = 2;
  chronological.observation.payload.coverage.per_symbol[0]!.first_bar_at = beforeNanosecondBoundary.event_ts_utc;
  chronological.observation.payload.coverage.per_symbol[0]!.last_bar_at = afterNanosecondBoundary.event_ts_utc;
  chronological.observation.payload.provenance.row_count = 2;
  const updateObservationHash = (candidate: SyntheticEnvelope) => {
    const serializedPayload = JSON.stringify(candidate.observation.payload);
    candidate.observation.source_observation_sha256 = createHash("sha256")
      .update(serializedPayload ?? "")
      .digest("hex");
  };
  updateObservationHash(chronological);
  await configureGateway(request, { yfinanceResearch: { enabled: true, response: chronological } });
  const accepted = await page.context().request.get(url);
  expect(accepted.status()).toBe(200);
  expect((await accepted.json()).observation.payload.bars.map((bar: Record<string, unknown>) => bar.event_ts_utc))
    .toEqual(["1999-01-04T00:00:00Z", "2002-01-03T00:00:00Z"]);

  const reversed = JSON.parse(JSON.stringify(chronological)) as SyntheticEnvelope;
  reversed.observation.payload.bars.reverse();
  updateObservationHash(reversed);
  await configureGateway(request, { yfinanceResearch: { enabled: true, response: reversed } });
  expect((await page.context().request.get(url)).status()).toBe(502);

  const duplicated = JSON.parse(JSON.stringify(chronological)) as SyntheticEnvelope;
  duplicated.observation.payload.bars = [
    duplicated.observation.payload.bars[0]!,
    duplicated.observation.payload.bars[0]!,
    duplicated.observation.payload.bars[1]!,
  ];
  duplicated.observation.payload.coverage.bar_count = 3;
  duplicated.observation.payload.coverage.per_symbol[0]!.bar_count = 3;
  duplicated.observation.payload.provenance.row_count = 3;
  updateObservationHash(duplicated);
  await configureGateway(request, { yfinanceResearch: { enabled: true, response: duplicated } });
  expect((await page.context().request.get(url)).status()).toBe(502);
});

test("Yahoo research BFF rejects payload metadata that violates the native MDP observation contract", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true } });
  await signIn(page, request, ["eqoboard-market-reader"]);

  const query = new URLSearchParams({
    symbols: "AAPL",
    asset_class: "stock",
    start_utc: "2010-01-01T00:00:00Z",
    end_utc: "2026-01-01T00:00:00Z",
    adjustment: "unadjusted",
  });
  const url = `${WEB_ORIGIN}/api/research/yfinance/daily?${query}`;
  const validResponse = await page.context().request.get(url);
  expect(validResponse.status()).toBe(200);
  const valid = await validResponse.json();
  const providerGap = JSON.parse(JSON.stringify(valid)) as {
    observation: { payload: Record<string, unknown> };
  };
  const providerPayload = providerGap.observation.payload;
  const providerCoverage = providerPayload.coverage as {
    gaps: Array<Record<string, unknown>>;
    per_symbol: Array<Record<string, unknown>>;
  };
  providerCoverage.gaps.push({ code: "PROVIDER_SPECIFIC_NOTE" });
  (providerCoverage.per_symbol[0]!.gaps as string[]).push("PROVIDER_SPECIFIC_NOTE");
  await configureGateway(request, { yfinanceResearch: { enabled: true, response: providerGap } });
  expect((await page.context().request.get(url)).status()).toBe(200);

  const corruptions: Array<(candidate: { observation: { payload: Record<string, unknown> } }) => void> = [
    (candidate) => { candidate.observation.payload.provider_repair_enabled = true; },
    (candidate) => { candidate.observation.payload.volume_encoding = "decimal_string"; },
    (candidate) => { candidate.observation.payload.available_at = null; },
    (candidate) => { candidate.observation.payload.source_observed_at = null; },
    (candidate) => { (candidate.observation.payload.provenance as Record<string, unknown>).provider = "yfinance"; },
    (candidate) => { (candidate.observation.payload.provenance as Record<string, unknown>).source = "Yahoo Finance"; },
    (candidate) => { (candidate.observation.payload.provenance as Record<string, unknown>).schema_version = "yfinance-history-bridge-v1"; },
    (candidate) => { (candidate.observation.payload.provenance as Record<string, unknown>).include_actions = false; },
    (candidate) => { (candidate.observation.payload.provenance as Record<string, unknown>).prepost = true; },
    (candidate) => { (candidate.observation.payload.provenance as Record<string, unknown>).cache_status = "stale_cache"; },
    (candidate) => { candidate.observation.payload.status = "partial"; },
    (candidate) => { candidate.observation.payload.request_started_at = "2010-01-01T00:00:00Z"; },
  ];
  for (const corrupt of corruptions) {
    const malformed = JSON.parse(JSON.stringify(valid)) as {
      observation: { payload: Record<string, unknown> };
    };
    corrupt(malformed);
    await configureGateway(request, { yfinanceResearch: { enabled: true, response: malformed } });
    const rejected = await page.context().request.get(url);
    expect(rejected.status()).toBe(502);
    expect(await rejected.json()).toEqual({ error: "invalid_research_observation_response" });
  }
});

test("Yahoo research BFF canonicalizes explicit UTC offsets and preserves fractional range bounds", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true } });
  await signIn(page, request, ["eqoboard-market-reader"]);

  const query = new URLSearchParams({
    symbols: "AAPL",
    asset_class: "stock",
    start_utc: "2010-01-01T00:00:00.123000+00:00",
    end_utc: "2026-01-01T00:00:00.000000+00:00",
    adjustment: "unadjusted",
  });
  const response = await page.context().request.get(`${WEB_ORIGIN}/api/research/yfinance/daily?${query}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.requested_range).toEqual({
    start_utc: "2010-01-01T00:00:00.123Z",
    end_utc: "2026-01-01T00:00:00Z",
    semantics: "start_inclusive_end_exclusive",
  });
  const [call] = (await metrics(request)).mdpYfinanceResearch;
  expect(call.query).toMatchObject({
    start_utc: "2010-01-01T00:00:00.123Z",
    end_utc: "2026-01-01T00:00:00Z",
  });

  const expected = {
    symbols: ["AAPL"],
    assetClass: "stock" as const,
    adjustment: "unadjusted" as const,
    startUtc: "2010-01-01T00:00:00.123000+00:00",
    endUtc: "2026-01-01T00:00:00.000000+00:00",
    cursor: null,
  };
  expect(validateYfinanceResearchResponse(body, expected)).toBe(true);
  const differentNanosecond = JSON.parse(JSON.stringify(body)) as {
    requested_range: { start_utc: string; end_utc: string; semantics: string };
  };
  differentNanosecond.requested_range.start_utc = "2010-01-01T00:00:00.123000001Z";
  expect(validateYfinanceResearchResponse(differentNanosecond, expected)).toBe(false);
});

test("Yahoo chart page uses the shared widget, bounded MAX cursor pages, and float-only tooltip values", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true } });
  await signIn(page, request, ["eqoboard-market-reader"]);
  await page.goto(`${WEB_ORIGIN}/research/yfinance/AAPL`);

  await expect(page.getByTestId("yfinance-research-page")).toBeVisible();
  await expect(page.getByTestId("yfinance-research-display-only")).toContainText("NOT POINT-IN-TIME");
  await expect(page.getByTestId("chart-yfinance-research-mode")).toBeVisible();
  await expect(page.getByTestId("chart-yfinance-source")).toContainText("Yahoo Finance · Provider yfinance");
  await expect(page.getByTestId("chart-widget-history-status")).toContainText("basis unknown/provider-native");
  await expect(page.getByTestId("chart-widget-history-status")).toContainText("MDP coverage asserted no");
  await expect(page.getByTestId("chart-provider-mode")).toHaveCount(0);
  await expect(page.getByTestId("chart-yfinance-adjustment")).toHaveValue("unadjusted");
  await expect(page.getByTestId("chart-bar-count")).toContainText("2 bars");
  await expect(page.getByTestId("chart-widget-legend")).toBeVisible();
  await expect(page.getByTestId("chart-widget-legend")).not.toContainText("101.5000");

  const initialCalls = (await metrics(request)).mdpYfinanceResearch;
  expect(initialCalls).toHaveLength(1);
  expect(initialCalls[0].query.start_utc).toBe("1970-01-01T00:00:00.000Z");
  expect(initialCalls[0].query.adjustment).toBe("unadjusted");

  await page.getByTestId("chart-load-older").click();
  await expect(page.getByTestId("chart-bar-count")).toContainText("4 bars");
  const pageCalls = (await metrics(request)).mdpYfinanceResearch;
  expect(pageCalls).toHaveLength(2);
  expect(pageCalls[1].query).toMatchObject({ cursor: "older:1", start_utc: initialCalls[0].query.start_utc, end_utc: initialCalls[0].query.end_utc });
  await page.getByText("Research observation, unassessed coverage and provenance").click();
  await expect(page.getByTestId("chart-yfinance-provenance")).toContainText("source_observation_sha256");
  await expect(page.getByTestId("chart-yfinance-provenance")).toContainText("not a provider signature");

  await page.getByTestId("chart-yfinance-adjustment").selectOption("adjusted");
  await expect.poll(async () => (await metrics(request)).mdpYfinanceResearch.length).toBe(3);
  const adjustedCall = (await metrics(request)).mdpYfinanceResearch[2];
  expect(adjustedCall.query.adjustment).toBe("adjusted");
  expect(adjustedCall.query.cursor).toBeUndefined();
  await expect(page.getByTestId("chart-bar-count")).toContainText("2 bars");
});

test("Yahoo MAX left-pan follows an opaque cursor and preserves the viewport while older bars arrive", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true, delayMs: 1_500 } });
  await signIn(page, request, ["eqoboard-market-reader"]);
  const historyResponses: URL[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/research/yfinance/daily") historyResponses.push(url);
  });
  await page.goto(`${WEB_ORIGIN}/research/yfinance/AAPL`);

  const widget = page.getByTestId("chart-widget");
  const canvas = widget.getByTestId("chart-widget-canvas");
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");
  await expect.poll(() => canvas.getAttribute("data-visible-logical-range")).not.toBeNull();
  const parseRange = (value: string | null) => {
    const match = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(value ?? "");
    if (!match) throw new Error(`Invalid chart logical range: ${value}`);
    return { from: Number(match[1]), to: Number(match[2]) };
  };
  const beforePan = parseRange(await canvas.getAttribute("data-visible-logical-range"));
  const instanceGeneration = await canvas.getAttribute("data-chart-instance-generation");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Research chart canvas is not visible");
  await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.55, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => (await metrics(request)).mdpYfinanceResearch.some((call: {
    query: { cursor?: string };
  }) => call.query.cursor === "older:1"), { intervals: [50, 100, 250], timeout: 5_000 }).toBe(true);
  const initialRequest = (await metrics(request)).mdpYfinanceResearch.find((call: {
    query: { cursor?: string };
  }) => !call.query.cursor);
  const continuation = (await metrics(request)).mdpYfinanceResearch.find((call: {
    query: { cursor?: string };
  }) => call.query.cursor === "older:1");
  expect(initialRequest).toBeTruthy();
  expect(continuation?.query).toMatchObject({
    cursor: "older:1",
    start_utc: initialRequest.query.start_utc,
    end_utc: initialRequest.query.end_utc,
  });
  await expect.poll(() => historyResponses.length, { intervals: [50, 100, 250], timeout: 500 }).toBe(1);
  const whilePending = parseRange(await canvas.getAttribute("data-visible-logical-range"));
  expect(whilePending.from).toBeLessThanOrEqual(12);
  expect(whilePending.to - whilePending.from).toBeCloseTo(beforePan.to - beforePan.from, 1);
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");

  await expect.poll(() => historyResponses.length, { intervals: [50, 100, 250], timeout: 5_000 }).toBe(2);
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("4 bars");
  expect(await canvas.getAttribute("data-chart-instance-generation")).toBe(instanceGeneration);
  const afterPrepend = parseRange(await canvas.getAttribute("data-visible-logical-range"));
  expect(afterPrepend.from).toBeCloseTo(whilePending.from + 2, 1);
  expect(afterPrepend.to - afterPrepend.from).toBeCloseTo(whilePending.to - whilePending.from, 1);
});

test("Yahoo range windows use UTC calendar boundaries and show only returned daily observations", async ({ page, request }) => {
  await configureGateway(request, {
    yfinanceResearch: { enabled: true, syntheticDaily: true, syntheticDailyBarCount: 8 },
  });
  await signIn(page, request, ["eqoboard-market-reader"]);
  await page.clock.setFixedTime(new Date("2024-03-31T12:00:00.000Z"));
  await page.goto(`${WEB_ORIGIN}/research/yfinance/AAPL`);
  await expect(page.getByTestId("chart-yfinance-source")).toBeVisible();
  await expect(page.getByTestId("chart-bar-count")).toHaveText("8 bars");
  await expect.poll(async () => (await metrics(request)).mdpYfinanceResearch.length).toBe(1);

  const end = "2024-03-31T12:00:00.000Z";
  const allEightBars = [
    "2024-03-20T16:00:00.000Z", "2024-03-21T16:00:00.000Z", "2024-03-22T16:00:00.000Z",
    "2024-03-25T16:00:00.000Z", "2024-03-26T16:00:00.000Z", "2024-03-27T16:00:00.000Z",
    "2024-03-28T16:00:00.000Z", "2024-03-29T16:00:00.000Z",
  ];
  const cases = [
    { range: "1D", start: "2024-03-24T12:00:00.000Z", bars: ["2024-03-29T16:00:00.000Z"], label: "up to the latest available daily observation" },
    { range: "5D", start: "2024-03-17T12:00:00.000Z", bars: allEightBars.slice(-5), label: "up to the latest 5 available daily observations" },
    { range: "1M", start: "2024-02-29T12:00:00.000Z", bars: allEightBars, label: "rolling UTC calendar-month window" },
    { range: "6M", start: "2023-09-30T12:00:00.000Z", bars: allEightBars, label: "rolling six-calendar-month UTC window" },
    { range: "YTD", start: "2024-01-01T00:00:00.000Z", bars: allEightBars, label: "starts at January 1 UTC" },
    { range: "1Y", start: "2023-03-31T12:00:00.000Z", bars: allEightBars, label: "rolling UTC calendar-year window" },
    { range: "5Y", start: "2019-03-31T12:00:00.000Z", bars: allEightBars, label: "rolling five-calendar-year UTC window" },
  ] as const;

  for (const { range, start, bars, label } of cases) {
    const before = (await metrics(request)).mdpYfinanceResearch.length;
    await page.getByRole("button", { name: range, exact: true }).click();
    await expect.poll(async () => (await metrics(request)).mdpYfinanceResearch.length).toBe(before + 1);
    const call = (await metrics(request)).mdpYfinanceResearch[before];
    expect(call.query).toMatchObject({ symbols: "AAPL", asset_class: "stock", adjustment: "unadjusted" });
    expect(call.query.start_utc).toBe(start);
    expect(call.query.end_utc).toBe(end);
    expect(call.query).not.toHaveProperty("resolution");
    const rangeWindow = page.getByTestId("chart-yfinance-range-window");
    await expect(rangeWindow).toHaveAttribute("data-range", range);
    await expect(rangeWindow).toHaveAttribute("data-start-utc", start);
    await expect(rangeWindow).toHaveAttribute("data-end-utc", end);
    await expect(rangeWindow).toContainText(label);
    const barCount = page.getByTestId("chart-bar-count");
    await expect(barCount).toHaveText(`${bars.length} bars`);
    await expect(barCount).toHaveAttribute("data-observation-times", JSON.stringify(bars.slice(-5)));
    await expect(page.getByTestId("chart-yfinance-source")).toBeVisible();
    await expect(page.getByTestId("chart-widget-history-status")).toContainText("Resolution 1d · daily bars only");
  }
});

test("Yahoo yearly windows clamp leap day to the last day of February", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true } });
  await signIn(page, request, ["eqoboard-market-reader"]);
  await page.clock.setFixedTime(new Date("2024-02-29T12:00:00.000Z"));
  await page.goto(`${WEB_ORIGIN}/research/yfinance/AAPL`);
  await expect(page.getByTestId("chart-bar-count")).toHaveText("2 bars");

  const end = "2024-02-29T12:00:00.000Z";
  for (const [range, start] of [
    ["1Y", "2023-02-28T12:00:00.000Z"],
    ["5Y", "2019-02-28T12:00:00.000Z"],
  ] as const) {
    const before = (await metrics(request)).mdpYfinanceResearch.length;
    await page.getByRole("button", { name: range, exact: true }).click();
    await expect.poll(async () => (await metrics(request)).mdpYfinanceResearch.length).toBe(before + 1);
    const call = (await metrics(request)).mdpYfinanceResearch[before];
    expect(call.query).toMatchObject({ start_utc: start, end_utc: end });
    await expect(page.getByTestId("chart-yfinance-range-window")).toHaveAttribute("data-start-utc", start);
    await expect(page.getByTestId("chart-yfinance-range-window")).toHaveAttribute("data-end-utc", end);
  }
});

test("Yahoo history route rejects non-research roles and malformed cursor queries before MDP", async ({ page, request }) => {
  await configureGateway(request, { yfinanceResearch: { enabled: true, syntheticDaily: true } });
  await signIn(page, request, ["eqoboard-private-research-reader"]);
  const denied = await page.context().request.get(
    `${WEB_ORIGIN}/api/research/yfinance/daily?symbols=AAPL&asset_class=stock&start_utc=2010-01-01T00%3A00%3A00Z&end_utc=2026-01-01T00%3A00%3A00Z&adjustment=unadjusted`,
  );
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toEqual({ error: "action_forbidden" });
  expect((await metrics(request)).mdpYfinanceResearch).toEqual([]);

  await signIn(page, request, ["eqoboard-market-reader"]);
  for (const url of [
    `${WEB_ORIGIN}/api/research/yfinance/daily?symbols=aapl&asset_class=stock&start_utc=2010-01-01T00%3A00%3A00Z&end_utc=2026-01-01T00%3A00%3A00Z&adjustment=unadjusted`,
    `${WEB_ORIGIN}/api/research/yfinance/daily?symbols=AAPL&symbols=SPY&asset_class=stock&start_utc=2010-01-01T00%3A00%3A00Z&end_utc=2026-01-01T00%3A00%3A00Z&adjustment=unadjusted`,
    `${WEB_ORIGIN}/api/research/yfinance/daily?symbols=AAPL&asset_class=stock&start_utc=2026-01-01T00%3A00%3A00Z&end_utc=2010-01-01T00%3A00%3A00Z&adjustment=unadjusted`,
  ]) {
    expect((await page.context().request.get(url)).status(), url).toBe(400);
  }
  expect((await metrics(request)).mdpYfinanceResearch).toEqual([]);
});
