import {
  configureMocks,
  expect,
  loginWithOidc,
  metrics,
  resetDownstream,
  setRoles,
  test,
  WEB_ORIGIN,
} from "./fixtures";

type FixtureOptions = {
  symbol?: string;
  assetClass?: "stock" | "etf";
  feed?: string;
  resolution?: "1m" | "5m" | "15m" | "1h" | "1d";
  effectiveResolution?: "1m" | "5m" | "15m" | "1h" | "1d";
  adjustment?: "unadjusted" | "split" | "dividend" | "all";
  coverageStatus?: "complete" | "partial" | "unsupported";
  olderMinutes?: number;
  includeGap?: boolean;
  continuationCursor?: string | null;
  truncated?: boolean;
};

function makeCoreEnvelope(options: FixtureOptions = {}) {
  const symbol = options.symbol ?? "QQQ";
  const assetClass = options.assetClass ?? "stock";
  const feed = options.feed ?? "synthetic";
  const resolution = options.resolution ?? "5m";
  const effectiveResolution = options.effectiveResolution ?? resolution;
  const coverageStatus = options.coverageStatus ?? "partial";
  const unsupported = coverageStatus === "unsupported";
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
  const interval = intervalMs[effectiveResolution];
  const barStart = new Date(Math.floor(nowMs / interval) * interval - (options.olderMinutes ?? 2) * interval).toISOString();
  const barEnd = new Date(Date.parse(barStart) + interval).toISOString();
  const gaps = unsupported ? [{
    start_utc: new Date(Date.parse(barStart) - interval).toISOString(),
    end_exclusive_utc: barStart,
    reason_code: "unsupported_resolution",
  }] : options.includeGap ? [{
    start_utc: new Date(Date.parse(barStart) - interval).toISOString(),
    end_exclusive_utc: barStart,
    reason_code: "source_gap",
  }] : [];
  const cursor = options.continuationCursor ?? null;
  const provenanceId = "synthetic-e2e-provenance";
  const sessionInstanceId = "synthetic-e2e-session";

  return {
    schema_version: 1,
    provider: unsupported ? "unknown" : "synthetic",
    feed: unsupported ? "unknown" : feed,
    entitlement_status: "unknown",
    requested_resolution: resolution,
    effective_resolution: effectiveResolution,
    adjustment,
    coverage_status: coverageStatus,
    segments: unsupported ? [] : [{
      start_utc: barStart,
      end_exclusive_utc: barEnd,
      coverage_status: coverageStatus,
      provenance_id: provenanceId,
      session_instance_id: sessionInstanceId,
    }],
    gaps,
    source_provenance: unsupported ? [] : [{
      provenance_id: provenanceId,
      provider: "synthetic",
      feed,
      source: "synthetic-e2e-fixture",
      entitlement_status: "unknown",
      numeric_encoding: "decimal_token",
    }],
    as_of: unsupported ? null : now,
    fetched_at: now,
    verified_at: null,
    cache_status: "miss",
    market_calendar_version: null,
    continuation_cursor: cursor,
    truncated: cursor !== null,
    rows: unsupported ? [] : [{
      symbol,
      asset_class: assetClass,
      resolution: effectiveResolution,
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

function expectNoResearchBarsRequests(calls: Array<{ path: string }>) {
  expect(calls.filter(({ path }) => /(?:^|\/)(?:history|bars)(?:\/|$)/i.test(path))).toEqual([]);
}

const featureEnabled = process.env.E2E_MDP_MARKET_BARS_ENABLED === "true";
const gatewaySignerDisabled = process.env.E2E_GATEWAY_SIGNER_DISABLED === "true";

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

test("default-off history preserves the legacy route and rejects an unapplied provider preference", async ({ page, request }) => {
  test.skip(featureEnabled, "requires the default-off E2E server");
  // This spec measures process-wide mock counters. Avoid counting the default
  // Workspace chart's independent legacy history request during OIDC login.
  await page.addInitScript((appOrigin) => {
    if (window.location.origin !== appOrigin) return;
    localStorage.setItem("eqo_view_mode", "workspace");
    localStorage.setItem("eqoboard-open-terminal-v1", JSON.stringify({
      state: { widgets: [], layout: [] },
      version: 0,
    }));
  }, new URL(WEB_ORIGIN).origin);
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

test("enabled history preserves valid HTTP 206 coverage, rows, gaps, and source facts", async ({ page, request }) => {
  test.skip(!featureEnabled || gatewaySignerDisabled, "requires enabled MDP bars and the optional Gateway signer");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: makeCoreEnvelope({ assetClass: "etf", feed: "unknown", includeGap: true }),
    },
  });

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
  expect(response.status()).toBe(206);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  const body = await response.json();
  expect(body).toMatchObject({
    schema_version: 1,
    provider: "synthetic",
    feed: "unknown",
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
    segments: [{
      coverage_status: "partial",
      provenance_id: "synthetic-e2e-provenance",
      session_instance_id: "synthetic-e2e-session",
    }],
    gaps: [{
      reason_code: "source_gap",
    }],
    source_provenance: [{
      provenance_id: "synthetic-e2e-provenance",
      provider: "synthetic",
      feed: "unknown",
      source: "synthetic-e2e-fixture",
      entitlement_status: "unknown",
    }],
  });
  expect(body.request_start).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  expect(body.request_end).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

  const observed = await metrics(request);
  expect(observed.gateway.requests["/api/v1/stocks/bars"]).toBeUndefined();
  expectNoResearchBarsRequests(observed.research.calls);
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

test("enabled history preserves valid HTTP 200 complete coverage", async ({ page, request }) => {
  test.skip(!featureEnabled || gatewaySignerDisabled, "requires enabled MDP bars and the optional Gateway signer");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      status: 200,
      response: makeCoreEnvelope({ coverageStatus: "complete" }),
    },
  });

  const response = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?range=5D&resolution=5m`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toMatchObject({
    coverage_status: "complete",
    bars: [{ symbol: "QQQ", exact: { close: "512.7500" } }],
    segments: [{ coverage_status: "complete" }],
    gaps: [],
  });
  expect((await metrics(request)).mdpMarketBars).toHaveLength(1);
});

test("typed unsupported coverage keeps its validated reason on HTTP 422", async ({ page, request }) => {
  test.skip(!featureEnabled || gatewaySignerDisabled, "requires enabled MDP bars and the optional Gateway signer");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const unsupported = makeCoreEnvelope({ coverageStatus: "unsupported" });
  await configureMocks(request, { marketBars: { enabled: true, response: unsupported } });

  const response = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?range=5D&resolution=5m`);
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({
    error: "market_data_unsupported",
    coverage_status: "unsupported",
    feed: "unknown",
    rows: [],
    bars: [],
    segments: [],
    gaps: [{ reason_code: "unsupported_resolution" }],
    source_provenance: [],
  });

  await configureMocks(request, { marketBars: { enabled: true, status: 206, response: unsupported } });
  const mismatched = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?range=5D&resolution=5m`);
  expect(mismatched.status()).toBe(502);
  expect((await mismatched.json()).error).toBe("invalid_market_data_response");
  expect((await metrics(request)).mdpMarketBars).toHaveLength(2);
});

test("cursor pages preserve the first request window and opaque cursor", async ({ page, request }) => {
  test.skip(!featureEnabled || gatewaySignerDisabled, "requires enabled MDP bars and the optional Gateway signer");
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
  expect(firstResponse.status()).toBe(206);
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
  expect(olderResponse.status()).toBe(206);
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

test("invalid inputs, unsupported symbols, and mismatched Core responses fail without source fallback", async ({ page, request }) => {
  test.skip(!featureEnabled || gatewaySignerDisabled, "requires enabled MDP bars and the optional Gateway signer");
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

  const unrequestedDowngrade = makeCoreEnvelope({ resolution: "5m", effectiveResolution: "1d" });
  await configureMocks(request, { marketBars: { enabled: true, response: unrequestedDowngrade } });
  const downgradeResponse = await page.context().request.get(
    `${WEB_ORIGIN}/api/history/QQQ?range=5D&resolution=5m&allow_daily_downgrade=false`,
  );
  expect(downgradeResponse.status()).toBe(502);
  expect((await downgradeResponse.json()).error).toBe("invalid_market_data_response");

  await configureMocks(request, {
    marketBars: { enabled: true, status: 200, response: makeCoreEnvelope() },
  });
  const mismatchedCoverage = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?range=5D`);
  expect(mismatchedCoverage.status()).toBe(502);
  expect((await mismatchedCoverage.json()).error).toBe("invalid_market_data_response");

  const observed = await metrics(request);
  expect(observed.gateway.requests["/api/v1/stocks/bars"]).toBeUndefined();
  expectNoResearchBarsRequests(observed.research.calls);
  expect(observed.mdpMarketBars).toHaveLength(3);
});

test("enabled history works when the optional terminal Gateway signer is absent", async ({ page, request }) => {
  test.skip(!featureEnabled || !gatewaySignerDisabled,
    "requires E2E_MDP_MARKET_BARS_ENABLED=true and E2E_GATEWAY_SIGNER_DISABLED=true");
  await configureMocks(request, {
    marketBars: { enabled: true, status: 206, response: makeCoreEnvelope({ assetClass: "etf" }) },
  });
  await setRoles(request, ["eqoboard-market-reader"]);
  await page.goto("/");
  await page.getByRole("button", { name: /organization identity provider/i }).click();
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body.user.roles).toEqual(["eqoboard-market-reader"]);
  await page.goto("/api/healthz");

  const response = await page.context().request.get(
    `${WEB_ORIGIN}/api/history/QQQ?range=5D&resolution=5m&asset_class=etf`,
  );
  expect(response.status()).toBe(206);
  expect((await response.json()).bars).toHaveLength(1);

  const observed = await metrics(request);
  expect(observed.mdp.authorized).toBe(1);
  expect(observed.mdp.rejected).toBe(0);
  expect(observed.mdpMarketBars).toHaveLength(1);
  expect(observed.mdpMarketBars[0]).toMatchObject({
    path: "/v1/market/bars",
    bearer_present: true,
    gateway_delegation_present: false,
    kid: "mdp-terminal",
    issuer: "eqoboard-openterminal",
    audience: "lqepoch-market-data",
    subject: "subject-e2e",
    scope: ["market:read"],
  });
  expect(observed.gateway.requests["/api/v1/stocks/bars"]).toBeUndefined();
});

test("Alpaca-only history does not receive a Gateway delegation", async ({ page, request }) => {
  test.skip(!featureEnabled || gatewaySignerDisabled,
    "requires enabled MDP bars and the optional Gateway signer");
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await configureMocks(request, {
    marketBars: { enabled: true, status: 206, response: makeCoreEnvelope() },
  });

  const response = await page.context().request.get(
    `${WEB_ORIGIN}/api/history/QQQ?range=5D&provider_mode=alpaca_only`,
  );
  expect(response.status()).toBe(206);
  const calls = (await metrics(request)).mdpMarketBars;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    query: { provider_mode: "alpaca_only" },
    bearer_present: true,
    gateway_delegation_present: false,
  });
});
