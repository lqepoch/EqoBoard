import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const WEB_ORIGIN = "http://127.0.0.1:3320";
const OIDC_ORIGIN = "http://127.0.0.1:4320";
const SAME_HOSTNAME_WEB_ORIGIN = "http://127.0.0.1:3321";
const CREDENTIAL_WEB_ORIGIN = "http://127.0.0.1:3322";

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
  expect((await request.get(`${WEB_ORIGIN}/api/portfolios`)).status()).toBe(404);
  expect((await request.get(`${WEB_ORIGIN}/api/eqo/stocks/subscribe`)).status()).toBe(404);
  expect((await request.get(`${WEB_ORIGIN}/api/eqo/options/subscribe`)).status()).toBe(404);

  const sameHostnameReadiness = await request.get(`${SAME_HOSTNAME_WEB_ORIGIN}/api/readyz`);
  expect(sameHostnameReadiness.status()).toBe(503);
  expect(await sameHostnameReadiness.json()).toMatchObject({ ready: false, runtime_mode: "research" });

  const credentialReadiness = await request.get(`${CREDENTIAL_WEB_ORIGIN}/api/readyz`);
  expect(credentialReadiness.status()).toBe(503);
  expect(await credentialReadiness.json()).toMatchObject({ ready: false, runtime_mode: "research" });
  const credentialMarketRequest = await request.get(`${CREDENTIAL_WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ`);
  expect(credentialMarketRequest.status()).toBe(503);
  expect(await metrics(request)).toMatchObject({ gateway: { requests: {}, authorized: 0, rejected: 0 } });

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
});

test("wrong role, feed denial, invalid input, and unknown paths fail without fallback", async ({ page, request }) => {
  await signIn(page, request, ["eqoboard-workspace-editor"]);
  const authCheck = await page.context().request.get(`${WEB_ORIGIN}/api/research/auth-check`);
  expect(authCheck.status()).toBe(403);
  expect(await authCheck.json()).toEqual({ error: "action_forbidden" });
  const forbidden = await page.context().request.get(`${WEB_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ`);
  expect(forbidden.status()).toBe(403);
  expect(await metrics(request)).toMatchObject({ gateway: { requests: {}, authorized: 0 } });

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
