import {
  configureMocks,
  expect,
  loginWithOidc,
  metrics,
  resetDownstream,
  test,
  WEB_ORIGIN,
} from "./fixtures";

type FixtureOptions = {
  symbol?: string;
  assetClass?: "stock" | "etf";
  resolution?: "1m" | "5m" | "15m" | "1h" | "1d";
  adjustment?: "unadjusted" | "split" | "dividend" | "all";
  olderMinutes?: number;
  continuationCursor?: string | null;
  truncated?: boolean;
};

function makeCoreEnvelope(options: FixtureOptions = {}) {
  const symbol = options.symbol ?? "QQQ";
  const assetClass = options.assetClass ?? "stock";
  const resolution = options.resolution ?? "5m";
  const adjustment = options.adjustment ?? "unadjusted";
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const intervalMs: Record<NonNullable<FixtureOptions["resolution"]>, number> = {
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "1d": 24 * 60 * 60_000,
  };
  const interval = intervalMs[resolution];
  const barStart = new Date(Math.floor(nowMs / interval) * interval - (options.olderMinutes ?? 2) * interval).toISOString();
  const barEnd = new Date(Date.parse(barStart) + interval).toISOString();
  const cursor = options.continuationCursor ?? null;
  const provenanceId = "synthetic-e2e-provenance";
  const sessionInstanceId = "synthetic-e2e-session";

  return {
    schema_version: 1,
    provider: "synthetic",
    feed: "synthetic",
    entitlement_status: "unknown",
    requested_resolution: resolution,
    effective_resolution: resolution,
    adjustment,
    coverage_status: "partial",
    segments: [{
      start_utc: barStart,
      end_exclusive_utc: barEnd,
      coverage_status: "partial",
      provenance_id: provenanceId,
      session_instance_id: sessionInstanceId,
    }],
    gaps: [],
    source_provenance: [{
      provenance_id: provenanceId,
      provider: "synthetic",
      feed: "synthetic",
      source: "synthetic-e2e-fixture",
      entitlement_status: "unknown",
      numeric_encoding: "decimal_token",
    }],
    as_of: now,
    fetched_at: now,
    verified_at: null,
    cache_status: "miss",
    market_calendar_version: null,
    continuation_cursor: cursor,
    truncated: cursor !== null,
    rows: [{
      symbol,
      asset_class: assetClass,
      resolution,
      adjustment,
      bar_start_utc: barStart,
      bar_end_exclusive_utc: barEnd,
      received_at_utc: now,
      available_at_utc: now,
      open: "512.3400",
      high: "513.1250",
      low: "511.8750",
      close: "512.7500",
      volume: "123456.000",
      provenance_id: provenanceId,
      session_instance_id: sessionInstanceId,
      validation_state: "validated",
    }],
  };
}

const featureEnabled = process.env.E2E_MDP_MARKET_BARS_ENABLED === "true";

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

test("default-off history preserves the legacy route and rejects an unapplied provider preference", async ({ page, request }) => {
  test.skip(featureEnabled, "requires the default-off E2E server");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);

  const legacy = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?range=6M`);
  expect(legacy.status()).toBe(200);
  expect((await legacy.json()).bars).toHaveLength(1);

  const selector = await page.context().request.get(
    `${WEB_ORIGIN}/api/history/QQQ?range=6M&provider_mode=alpaca_only`,
  );
  expect(selector.status()).toBe(501);
  expect(await selector.json()).toMatchObject({
    error: "provider_selector_unavailable",
    provider_mode_requested: "alpaca_only",
    provider_mode_applied: false,
  });
  const observed = await metrics(request);
  expect(observed.gateway.requests["/api/v1/stocks/bars"]).toBe(1);
  expect(observed.mdpMarketBars).toEqual([]);
});

test("enabled history validates and projects the Core envelope with short independent delegations", async ({ page, request }) => {
  test.skip(!featureEnabled, "requires E2E_MDP_MARKET_BARS_ENABLED=true");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await configureMocks(request, { marketBars: { enabled: true, response: makeCoreEnvelope({ assetClass: "etf" }) } });

  const query = new URLSearchParams({
    range: "5D",
    provider_mode: "auto",
    resolution: "5m",
    asset_class: "etf",
    session_scope: "all",
    adjustment: "unadjusted",
    allow_daily_downgrade: "true",
  });
  const response = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?${query}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await response.json();
  expect(body).toMatchObject({
    schema_version: 1,
    provider: "synthetic",
    feed: "synthetic",
    entitlement_status: "unknown",
    coverage_status: "partial",
    verified_at: null,
    verification: "unknown",
    requested_resolution: "5m",
    effective_resolution: "5m",
    resolution: { requested: "5m", effective: "5m", downgrade_reason: null },
    adjustment: "unadjusted",
    asset_class: "etf",
    asset_class_source: "caller_declared",
    provider_mode_requested: "auto",
    request_start: expect.any(String),
    request_end: expect.any(String),
    cursor: null,
    next_cursor: null,
    has_more: false,
    bars: [{
      symbol: "QQQ",
      time: expect.any(Number),
      asOf: expect.any(String),
      open: 512.34,
      high: 513.125,
      low: 511.875,
      close: 512.75,
      volume: 123456,
      source_mode: "synthetic",
      source_label: "synthetic-e2e-fixture",
      exact: {
        open: "512.3400",
        high: "513.1250",
        low: "511.8750",
        close: "512.7500",
        volume: "123456.000",
      },
    }],
  });
  expect(body.request_start).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  expect(body.request_end).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

  const observed = await metrics(request);
  expect(observed.gateway.requests["/api/v1/stocks/bars"]).toBeUndefined();
  expect(observed.research.requests).toEqual({});
  expect(observed.mdp.authorized).toBe(1);
  expect(observed.mdp.rejected).toBe(0);
  expect(observed.mdpMarketBars).toHaveLength(1);
  expect(observed.mdpMarketBars[0]).toMatchObject({
    method: "GET",
    path: "/v1/market/bars",
    query: {
      symbol: "QQQ",
      asset_class: "etf",
      start: body.request_start,
      end: body.request_end,
      resolution: "5m",
      session_scope: "all",
      adjustment: "unadjusted",
      provider_mode: "auto",
      allow_daily_downgrade: "true",
      limit: "1000",
    },
    bearer_present: true,
    gateway_delegation_present: true,
    kid: "mdp-terminal",
    issuer: "eqoboard-openterminal",
    audience: "lqepoch-market-data",
    subject: "subject-e2e",
    scope: ["market:read"],
    gateway_delegation: {
      kid: "bff",
      issuer: "eqoboard-openterminal",
      audience: "eqoboard-gateway",
      subject: "subject-e2e",
      scope: ["market:read"],
    },
  });
  expect(observed.mdpMarketBars[0].exp - observed.mdpMarketBars[0].iat).toBeLessThanOrEqual(60);
  expect(observed.mdpMarketBars[0].gateway_delegation.exp - observed.mdpMarketBars[0].gateway_delegation.iat).toBeLessThanOrEqual(60);
});

test("cursor pages preserve the first request window and opaque cursor", async ({ page, request }) => {
  test.skip(!featureEnabled, "requires E2E_MDP_MARKET_BARS_ENABLED=true");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const cursor = "opaque+older-page/v1";
  const firstPage = makeCoreEnvelope({ olderMinutes: 2, continuationCursor: cursor });
  const olderPage = makeCoreEnvelope({ olderMinutes: 3 });
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      responsesByCursor: { "": firstPage, [cursor]: olderPage },
    },
  });

  const initial = new URLSearchParams({ range: "5D", provider_mode: "auto", resolution: "5m" });
  const firstResponse = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?${initial}`);
  expect(firstResponse.status()).toBe(200);
  const firstBody = await firstResponse.json();
  expect(firstBody).toMatchObject({ has_more: true, truncated: true, next_cursor: cursor });

  const older = new URLSearchParams({
    range: "5D",
    provider_mode: "auto",
    resolution: "5m",
    asset_class: "stock",
    session_scope: "all",
    adjustment: "unadjusted",
    allow_daily_downgrade: "true",
    cursor: firstBody.next_cursor,
    request_start: firstBody.request_start,
    request_end: firstBody.request_end,
  });
  const olderResponse = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?${older}`);
  expect(olderResponse.status()).toBe(200);
  const olderBody = await olderResponse.json();
  expect(olderBody).toMatchObject({ has_more: false, truncated: false, next_cursor: null });

  const calls = (await metrics(request)).mdpMarketBars;
  expect(calls).toHaveLength(2);
  expect(calls[0].query.cursor).toBeUndefined();
  expect(calls[1].query.cursor).toBe(cursor);
  for (const call of calls) {
    expect(call.query.start).toBe(firstBody.request_start);
    expect(call.query.end).toBe(firstBody.request_end);
  }
});

test("research provider mode requires the research scope before calling MDP", async ({ page, request }) => {
  test.skip(!featureEnabled, "requires E2E_MDP_MARKET_BARS_ENABLED=true");
  await loginWithOidc(page, request, ["eqoboard-workspace-editor"]);

  const response = await page.context().request.get(
    `${WEB_ORIGIN}/api/history/QQQ?range=5D&provider_mode=research`,
  );
  expect(response.status()).toBe(403);
  expect((await metrics(request)).mdpMarketBars).toEqual([]);
});

test("invalid inputs, unsupported symbols, and malformed Core envelopes fail without source fallback", async ({ page, request }) => {
  test.skip(!featureEnabled, "requires E2E_MDP_MARKET_BARS_ENABLED=true");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);

  for (const path of [
    "/api/history/QQQ?range=invalid",
    "/api/history/QQQ?range=5D&range=1D",
    "/api/history/QQQ?range=5D&provider_mode=unknown",
    "/api/history/QQQ?range=5D&cursor=opaque",
    "/api/history/VIX?range=5D",
  ]) {
    const response = await page.context().request.get(`${WEB_ORIGIN}${path}`);
    expect([400, 422]).toContain(response.status());
  }

  const malformed = makeCoreEnvelope() as ReturnType<typeof makeCoreEnvelope>;
  malformed.rows[0].high = "511.0000";
  await configureMocks(request, { marketBars: { enabled: true, response: malformed } });
  const invalidResponse = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?range=5D`);
  expect(invalidResponse.status()).toBe(502);
  expect((await invalidResponse.json()).error).toBe("invalid_market_data_response");

  const observed = await metrics(request);
  expect(observed.gateway.requests["/api/v1/stocks/bars"]).toBeUndefined();
  expect(observed.research.requests).toEqual({});
  expect(observed.mdpMarketBars).toHaveLength(1);
});
