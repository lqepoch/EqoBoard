import { configureMocks, expect, loginWithOidc, metrics, resetDownstream, setRoles, test, WEB_ORIGIN, MOCK_OIDC_ORIGIN } from "./fixtures";
import { request as httpRequest } from "node:http";

function futureFridayOCCDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 35);
  date.setUTCDate(date.getUTCDate() + ((5 - date.getUTCDay() + 7) % 7));
  return date.toISOString().slice(2, 10).replaceAll("-", "");
}

async function expectNoDownstream(request: Parameters<typeof resetDownstream>[0]) {
  const result = await metrics(request);
  expect(result.gateway.requests, `Gateway calls: ${JSON.stringify(result.gateway.calls)}`).toEqual({});
  expect(result.gateway.authorized).toBe(0);
  expect(result.gateway.activeStreams).toBe(0);
  expect(result.research.requests).toEqual({});
  expect(result.research.authorized).toBe(0);
}

async function postChunkedJson(cookie: string, body: string, finish: boolean) {
  const origin = new URL(WEB_ORIGIN);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const client = httpRequest({
      hostname: origin.hostname,
      port: Number(origin.port || (origin.protocol === "https:" ? 443 : 80)),
      path: "/api/portfolios",
      method: "POST",
      headers: {
        cookie,
        origin: WEB_ORIGIN,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { responseBody += chunk; });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: responseBody });
        if (!finish) client.destroy();
      });
    });
    const deadline = setTimeout(() => client.destroy(new Error("chunked request test timed out")), 15_000);
    client.on("close", () => clearTimeout(deadline));
    client.on("error", (error) => reject(error));
    client.write(body);
    if (finish) client.end();
  });
}

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
  await setRoles(request, ["eqoboard-market-reader"]);
});

test("quotes route U.S. symbols to SIP, named research symbols to Node, preserve mixed order, and never fall back on SIP 403", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const response = await page.context().request.get(
    `${WEB_ORIGIN}/api/quotes?symbols=QQQ,BTC,BTC-USD,VIX,7203.T`,
  );
  expect(response.status()).toBe(200);
  const quotes = await response.json();
  expect(quotes.map((quote: { symbol: string }) => quote.symbol)).toEqual(["QQQ", "BTC", "BTC-USD", "VIX", "7203.T"]);
  expect(quotes.map((quote: { source: string }) => quote.source)).toEqual([
    "source unknown", "source unknown", "mock-fixture/Binance", "mock-fixture/FRED", "mock-fixture/Yahoo",
  ]);
  expect(quotes.slice(0, 2)).toMatchObject([
    { price: 500, lastAsOf: null, lastBasis: "unknown" },
    { price: 500, lastAsOf: null, lastBasis: "unknown" },
  ]);
  let observed = await metrics(request);
  expect(observed.gateway.calls.filter((call: { path: string }) => call.path === "/api/v1/stocks/snapshots"))
    .toMatchObject([{ symbols: "QQQ,BTC" }]);
  expect(observed.research.calls).toEqual([
    { method: "GET", path: "/api/quotes", symbols: "BTC-USD,VIX,7203.T" },
  ]);

  await resetDownstream(request);
  const researchHistory = await page.context().request.get(`${WEB_ORIGIN}/api/history/VIX?range=6M`);
  expect(researchHistory.status()).toBe(200);
  observed = await metrics(request);
  expect(observed.gateway.requests).toEqual({});
  expect(observed.research.calls).toEqual([
    { method: "GET", path: "/api/history/VIX", symbols: null },
  ]);

  await resetDownstream(request);
  const sipHistory = await page.context().request.get(`${WEB_ORIGIN}/api/history/QQQ?range=6M`);
  expect(sipHistory.status()).toBe(200);
  observed = await metrics(request);
  expect(observed.gateway.requests).toEqual({ "/api/v1/stocks/bars": 1 });
  expect(observed.research.requests).toEqual({});

  await resetDownstream(request);
  await configureMocks(request, { snapshotStatus: 403 });
  const denied = await page.context().request.get(`${WEB_ORIGIN}/api/quotes?symbols=QQQ,BTC,VIX`);
  expect(denied.status()).toBe(403);
  observed = await metrics(request);
  expect(observed.gateway.requests).toEqual({ "/api/v1/stocks/snapshots": 1 });
  expect(observed.gateway.calls.filter((call: { path: string }) => call.path === "/api/v1/stocks/snapshots"))
    .toMatchObject([{ symbols: "QQQ,BTC" }]);
  expect(observed.research.requests).toEqual({});
});

test("status route preserves disabled broker capabilities separately from configured endpoints", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const response = await page.context().request.get(`${WEB_ORIGIN}/api/status`);
  expect(response.status()).toBe(200);
  const status = await response.json();
  expect(status.adapterEndpointsConfigured).toEqual(["ibkr"]);
  expect(status.brokerCapabilities).toMatchObject({
    ibkr: { paper: { enabled: false, implementation: "disabled" } },
    schwab: { paper: { enabled: false, implementation: "disabled" } },
  });
  await page.goto("/");
  await expect(page.getByLabel("Broker").locator("option").filter({ hasText: "IBKR · Paper disabled" })).toHaveCount(1);
  const observed = await metrics(request);
  expect(observed.gateway.requests["/api/v1/status"]).toBeGreaterThanOrEqual(1);
  expect(observed.gateway.authorized).toBeGreaterThanOrEqual(1);
});

test("anonymous, forged identity, read-only, and cross-origin writes never reach protected services", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to EqoBoard" })).toBeVisible();

  const contextRequest = page.context().request;
  const forgedHeaders = {
    "x-user": "attacker",
    "x-role": "eqoboard-paper-operator",
    authorization: "Bearer static-test-access-token",
  };
  const anonymousQuote = await contextRequest.get(`${WEB_ORIGIN}/api/quotes?symbols=QQQ`, { headers: forgedHeaders });
  expect(anonymousQuote.status()).toBe(401);
  const anonymousOrder = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/orders/preview`, {
    headers: { ...forgedHeaders, origin: WEB_ORIGIN, "content-type": "application/json" },
    data: { symbol: "QQQ" },
  });
  expect(anonymousOrder.status()).toBe(401);
  const anonymousSubscribe = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/stocks/subscribe`, {
    headers: { ...forgedHeaders, origin: WEB_ORIGIN, "content-type": "application/json" },
    data: { consumer_id: "cd21a241-1c9d-4e86-8000-f45e562b5ba1", symbols: ["QQQ"] },
  });
  expect(anonymousSubscribe.status()).toBe(401);
  const anonymousStream = await contextRequest.get(`${WEB_ORIGIN}/api/eqo/live`, { headers: forgedHeaders });
  expect(anonymousStream.status()).toBe(401);
  await expectNoDownstream(request);

  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const nodeQuote = await contextRequest.get(`${WEB_ORIGIN}/api/quotes?symbols=VIX`);
  expect(nodeQuote.status(), await nodeQuote.text()).toBe(200);
  expect(await nodeQuote.json()).toEqual([{ symbol: "VIX", source: "mock-fixture/FRED", asOf: "2026-10-07T12:00:00Z", last: 500 }]);
  const binary = await contextRequest.get(`${WEB_ORIGIN}/api/quotes/binary`);
  expect(binary.status()).toBe(200);
  expect([...await binary.body()]).toEqual([0, 1, 2, 127, 128, 254, 255]);
  const mixedMarket = await contextRequest.get(`${WEB_ORIGIN}/api/heatmap`);
  expect(mixedMarket.status()).toBe(200);
  expect((await mixedMarket.json()).scope).toBe("market:read");

  await resetDownstream(request);
  const readOnlyPreview = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/orders/preview`, {
    headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
    data: { symbol: "QQQ" },
  });
  expect(readOnlyPreview.status()).toBe(403);
  const readOnlySubmit = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/orders/submit`, {
    headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
    data: { preview_id: "00000000-0000-4000-8000-000000000001", confirm: true },
  });
  expect(readOnlySubmit.status()).toBe(403);
  await expectNoDownstream(request);

  await resetDownstream(request);
  const crossOriginWrite = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/stocks/subscribe`, {
    headers: { origin: MOCK_OIDC_ORIGIN, "content-type": "text/plain" },
    data: "{}",
  });
  expect(crossOriginWrite.status()).toBe(403);
  await page.goto(`${MOCK_OIDC_ORIGIN}/evil`);
  await expect(page.locator("body")).toContainText("external-origin");
  await page.waitForTimeout(300);
  await expectNoDownstream(request);
});

test("preview is read-only and paper submit stays blocked before Gateway dispatch", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-order-reviewer", "eqoboard-paper-operator"]);
  const contextRequest = page.context().request;
  const expiration = futureFridayOCCDate();
  const intent = {
    broker: "ibkr",
    environment: "paper",
    kind: "vertical",
    symbol: null,
    quantity: 1,
    limit_price: 0.01,
    net_effect: "debit",
    legs: [
      { symbol: `QQQ${expiration}P00620000`, side: "buy" },
      { symbol: `QQQ${expiration}P00600000`, side: "sell" },
    ],
  };
  const preview = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/orders/preview`, {
    headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
    data: intent,
  });
  expect(preview.status(), await preview.text()).toBe(200);
  const previewBody = await preview.json();
  expect(previewBody).toMatchObject({
    execution_enabled: false,
    preview: {
      preview_id: expect.any(String),
      expires_at: expect.any(String),
      estimated_max_loss: 1,
      currency: "USD",
      intent,
    },
  });
  expect(previewBody.preview.intent).toEqual(intent);

  const submit = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/orders/submit`, {
    headers: { origin: WEB_ORIGIN, "content-type": "application/json" },
    data: { preview_id: previewBody.preview.preview_id, confirm: true },
  });
  expect(submit.status()).toBe(409);
  expect(await submit.json()).toMatchObject({ state: "blocked", retryable: false, recovery_required: false });
  expect(await metrics(request)).toMatchObject({
    gateway: { requests: { "/api/v1/orders/preview": 1 }, authorized: 1 },
  });
});

test("NextAuth session update cannot grant roles, change issuer, or extend a client-chosen expiry", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const update = await page.evaluate(async () => {
    const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
    const { csrfToken } = await csrfResponse.json();
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        csrfToken,
        data: {
          roles: ["eqoboard-paper-operator", "eqoboard-order-reviewer"],
          issuer: "https://attacker.invalid",
          sessionExpiresAt: Number.MAX_SAFE_INTEGER,
        },
      }),
      cache: "no-store",
    });
    return { status: response.status, session: await response.json() };
  });
  expect(update.status).toBe(200);
  expect(update.session.user).toMatchObject({
    id: "subject-e2e",
    issuer: MOCK_OIDC_ORIGIN,
    roles: ["eqoboard-market-reader"],
  });
  expect(update.session.sessionExpiresAt).toBeLessThan(Date.now() + 31_000);

  await resetDownstream(request);
  const preview = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/orders/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "QQQ", quantity: 1 }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(preview.status).toBe(403);
  expect(preview.body.error).toBe("action_forbidden");
  await expectNoDownstream(request);
});

test("generic BFF writes reject cross-origin, unsupported media, oversized streams, and stalled bodies", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-workspace-editor"]);
  const unsupportedMedia = await page.evaluate(async () => {
    const response = await fetch("/api/portfolios", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    return response.status;
  });
  expect(unsupportedMedia).toBe(415);

  const sessionCookies = await page.context().cookies(WEB_ORIGIN);
  const cookie = sessionCookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  expect(cookie.length).toBeGreaterThan(0);
  const oversizedStream = await postChunkedJson(cookie, "x".repeat(70 * 1024), true);
  expect(oversizedStream.status).toBe(413);
  expect(JSON.parse(oversizedStream.body).error).toBe("request_too_large");

  const stalledStream = await postChunkedJson(cookie, "{", false);
  expect(stalledStream.status).toBe(408);
  expect(JSON.parse(stalledStream.body).error).toBe("request_body_timeout");
  await expectNoDownstream(request);
});

test("expired OIDC identity and expired browser session cannot authorize BFF calls", async ({ page, request }) => {
  await request.post(`${MOCK_OIDC_ORIGIN}/__test/expire-id-token`);
  await page.goto("/");
  await page.getByRole("button", { name: /organization identity provider/i }).click();
  await expect(page).toHaveURL(/error=/);
  const expiredIdentity = await page.context().request.get(`${WEB_ORIGIN}/api/quotes?symbols=QQQ`);
  expect(expiredIdentity.status()).toBe(401);
  await expectNoDownstream(request);

  const sessionExpiresAt = await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await page.waitForTimeout(Math.max(0, sessionExpiresAt - Date.now() + 1_000));
  await resetDownstream(request);
  const expiredSession = await page.context().request.get(`${WEB_ORIGIN}/api/quotes?symbols=QQQ`);
  expect(expiredSession.status()).toBe(401);
  await expectNoDownstream(request);
});

test("an authenticated SSE connection ends when its session expires", async ({ page, request }) => {
  const initialExpiry = await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/eqo/live", { cache: "no-store" });
    if (!response.ok || !response.body) return { status: response.status, firstEvent: false };
    const reader = response.body.getReader();
    const first = await reader.read();
    const browserWindow = window as typeof window & {
      __sseFinished?: Promise<boolean>;
      __sessionRefreshExpiry?: number;
      __sessionRefreshTimer?: number;
    };
    browserWindow.__sessionRefreshTimer = window.setInterval(() => {
      void fetch("/api/auth/session", { cache: "no-store" })
        .then((value) => value.json())
        .then((session) => { browserWindow.__sessionRefreshExpiry = session.sessionExpiresAt; });
    }, 2_000);
    browserWindow.__sseFinished = (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          if (browserWindow.__sessionRefreshTimer !== undefined) clearInterval(browserWindow.__sessionRefreshTimer);
          return true;
        }
      }
    })();
    return { status: response.status, firstEvent: Boolean(first.value) };
  });
  expect(result).toEqual({ status: 200, firstEvent: true });
  expect(Date.now()).toBeLessThan(initialExpiry + 5_000);
  await expect.poll(() => page.evaluate(() => {
    const browserWindow = window as typeof window & { __sseFinished?: Promise<boolean> };
    return browserWindow.__sseFinished;
  }), { timeout: 40_000 }).toBe(true);
  const extendedExpiry = await page.evaluate(() => {
    const browserWindow = window as typeof window & { __sessionRefreshExpiry?: number };
    return browserWindow.__sessionRefreshExpiry ?? 0;
  });
  expect(extendedExpiry).toBeGreaterThan(initialExpiry + 5_000);
  const resultMetrics = await metrics(request);
  expect(resultMetrics.gateway.streamOpened).toBe(1);
  expect(resultMetrics.gateway.streamClosed).toBe(1);
});
