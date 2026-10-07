import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RESEARCH_ORIGIN = process.env.EQO_RESEARCH_PUBLIC_ORIGIN!;
const TERMINAL_ORIGIN = process.env.EQO_PUBLIC_ORIGIN!;
const RESEARCH_OIDC_ORIGIN = process.env.E2E_OPENBB_OIDC_ORIGIN!;
const MAIN_OIDC_ORIGIN = process.env.E2E_MAIN_OIDC_ORIGIN!;
const RESEARCH_OIDC_CONTROL_TOKEN = process.env.E2E_RESEARCH_OIDC_CONTROL_TOKEN!;
const MAIN_OIDC_CONTROL_TOKEN = process.env.E2E_MAIN_OIDC_CONTROL_TOKEN!;
const MAIN_STORAGE_STATE = process.env.OPENBB_MAIN_E2E_STORAGE_STATE!;
const MOCK_ORIGIN = process.env.E2E_ALPACA_ORIGIN!;
const CONTROL_TOKEN = process.env.E2E_CONTROL_TOKEN!;
const ADMIN_EMAIL = process.env.OPENBB_ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.OPENBB_ADMIN_PASSWORD!;
const ARTIFACT_DIR = process.env.OPENBB_E2E_ARTIFACT_DIR ?? "/tmp/openbb-e2e-artifacts";
const STORAGE_STATE = process.env.OPENBB_E2E_STORAGE_STATE ?? join(ARTIFACT_DIR, "native-user-storage-state.json");
const DASHBOARD_URL_FILE = join(ARTIFACT_DIR, "native-dashboard-url.json");

type CapturedResponse = { path: string; status: number; body?: unknown };

async function jsonRequest(request: APIRequestContext, url: string, data: unknown, headers = {}) {
  const response = await request.post(url, { data, headers });
  expect(response.ok(), `${url}: ${await response.text()}`).toBeTruthy();
  return response;
}

async function setRoles(request: APIRequestContext, oidcOrigin: string, roles: string[], controlToken: string) {
  await jsonRequest(request, `${oidcOrigin}/__test/roles`, { roles }, { "x-e2e-control": controlToken });
}

async function resetFixtures(request: APIRequestContext) {
  await jsonRequest(request, `${RESEARCH_OIDC_ORIGIN}/__test/reset`, {}, { "x-e2e-control": RESEARCH_OIDC_CONTROL_TOKEN });
  await jsonRequest(request, `${MAIN_OIDC_ORIGIN}/__test/reset`, {}, { "x-e2e-control": MAIN_OIDC_CONTROL_TOKEN });
  await jsonRequest(request, `${MOCK_ORIGIN}/__test/reset`, {}, { "x-e2e-control": CONTROL_TOKEN });
}

async function signIn(page: Page, oidcOrigin: string, appOrigin: string, callbackPath: string, controlToken: string) {
  const signInUrl = new URL("/api/auth/signin/eqo-oidc", appOrigin);
  signInUrl.searchParams.set("callbackUrl", new URL(callbackPath, appOrigin).toString());
  await page.goto(signInUrl.toString());
  await page.getByRole("button", { name: /Organization sign-in/i }).click();
  await expect(page).toHaveURL(new URL(callbackPath, appOrigin).toString());
  const idpMetrics = await (await page.request.get(`${oidcOrigin}/__test/metrics`, { headers: { "x-e2e-control": controlToken } })).json();
  expect(idpMetrics.authorization_count).toBeGreaterThan(0);
  expect(idpMetrics.token_count).toBeGreaterThan(0);
}

async function nativeLiteLogin(page: Page) {
  await page.goto(`${RESEARCH_ORIGIN}/login`);
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-email-login.png"), fullPage: true });
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/, { timeout: 30_000 });
}

async function completeNativeLiteOnboarding(page: Page) {
  await expect(page).toHaveURL(/\/onboarding(?:\?|$)/, { timeout: 30_000 });
  await expect(page.getByText("Help us personalize your experience.", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "First Name", exact: true }).fill("EqoBoard");
  await page.getByRole("textbox", { name: "Last Name", exact: true }).fill("Demo");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).not.toHaveURL(/\/onboarding(?:\?|$)/, { timeout: 30_000 });
}

function safeRequestPath(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?")[0];
  }
}

function collectPageDiagnostics(page: Page) {
  const diagnostics: {
    pageErrors: Array<{ message: string; stack: string }>;
    consoleErrors: string[];
    requestFailures: Array<{ path: string; reason: string }>;
    responses: Array<{ method: string; path: string; status: number; contentType: string }>;
  } = { pageErrors: [], consoleErrors: [], requestFailures: [], responses: [] };
  const sanitize = (value: string) => value
    .replace(/https?:\/\/[^\s"'`]+/g, (url) => safeRequestPath(url))
    .replace(/\b(code|state|token|secret|password)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 500);

  page.on("pageerror", (error) => diagnostics.pageErrors.push({
    message: sanitize(error.message),
    stack: sanitize(error.stack ?? "").split("\n").slice(0, 6).join("\n"),
  }));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(sanitize(message.text()));
  });
  page.on("requestfailed", (request) => diagnostics.requestFailures.push({
    path: safeRequestPath(request.url()),
    reason: sanitize(request.failure()?.errorText ?? "unknown"),
  }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== RESEARCH_ORIGIN) return;
    const contentType = response.headers()["content-type"] ?? "";
    const suspiciousScriptFallback = /\.(?:js|mjs|css)$/.test(url.pathname) && contentType.includes("text/html");
    if (!url.pathname.startsWith("/api/") && response.status() < 400 && !suspiciousScriptFallback) return;
    diagnostics.responses.push({
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
      contentType,
    });
  });
  return diagnostics;
}

async function savePageDiagnostics(page: Page, diagnostics: ReturnType<typeof collectPageDiagnostics>, fileName: string) {
  const pageState = await page.evaluate(() => ({
    path: window.location.pathname,
    title: document.title,
    bodyText: document.body.innerText.slice(0, 1200),
    localStorageKeys: Object.keys(window.localStorage).sort(),
    rootChildCount: document.getElementById("root")?.childElementCount ?? null,
    publicUrlConfig: (() => {
      const config = (window as Window & { __APP_CONFIG__?: { urls?: Record<string, unknown> } }).__APP_CONFIG__;
      return { exists: Boolean(config), urls: config?.urls ?? null };
    })(),
    scriptPaths: Array.from(document.scripts)
      .map((script) => script.src ? new URL(script.src).pathname : "inline")
      .slice(0, 30),
  }));
  await writeFile(join(ARTIFACT_DIR, fileName), JSON.stringify({ ...diagnostics, page: pageState }, null, 2), { mode: 0o600 });
}

async function controlMock(request: APIRequestContext, mode: Record<string, string>) {
  await jsonRequest(request, `${MOCK_ORIGIN}/__test/control`, mode, { "x-e2e-control": CONTROL_TOKEN });
}

async function captureOpenbbResponses(page: Page) {
  const responses: CapturedResponse[] = [];
  const pending: Promise<void>[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== RESEARCH_ORIGIN || !url.pathname.startsWith("/api/openbb/")) return;
    pending.push((async () => {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      responses.push({ path: `${url.pathname}${url.search}`, status: response.status(), body });
    })());
  });
  return {
    responses,
    async settle() {
      await Promise.all(pending);
    },
  };
}

function rowsFor(responses: CapturedResponse[], route: string) {
  const response = responses.find((item) => item.path.startsWith(route) && item.status === 200);
  expect(response, `No successful native browser response for ${route}`).toBeDefined();
  expect(Array.isArray(response?.body), `${route} did not return OpenBB flat rows`).toBe(true);
  return response!.body as Record<string, unknown>[];
}

let activeNativeDiagnostics: ReturnType<typeof collectPageDiagnostics> | null = null;

test.beforeEach(async ({ request }) => {
  await resetFixtures(request);
  await mkdir(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
});

test.afterEach(async ({ page }, testInfo) => {
  if (activeNativeDiagnostics && testInfo.status !== testInfo.expectedStatus) {
    await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-failed-ui.png"), fullPage: true }).catch(() => undefined);
    await savePageDiagnostics(page, activeNativeDiagnostics, "native-openbb-failed-diagnostics.json");
  }
  activeNativeDiagnostics = null;
});

test("research origin gates Lite, isolates terminal cookies, and exposes only supported BFF routes", async ({ page, request }) => {
  const health = await request.get(`${RESEARCH_ORIGIN}/api/healthz`);
  expect(health.status()).toBe(200);
  const ready = await request.get(`${RESEARCH_ORIGIN}/api/readyz`);
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toMatchObject({ ready: true, runtime_mode: "research", execution_enabled: false });

  const providers = await request.get(`${RESEARCH_ORIGIN}/api/auth/providers`);
  expect(providers.status()).toBe(200);
  expect(await providers.json()).toHaveProperty("eqo-oidc");
  expect((await request.get(`${RESEARCH_ORIGIN}/api/research/auth-check`)).status()).toBe(404);
  const anonymousWidgets = await request.get(`${RESEARCH_ORIGIN}/api/openbb/widgets.json`);
  expect(anonymousWidgets.status()).toBe(401);
  expect(await anonymousWidgets.json()).toEqual({ error: "authentication_required" });
  const anonymousUi = await request.get(`${RESEARCH_ORIGIN}/app/widgets`, { maxRedirects: 0 });
  expect(anonymousUi.status()).toBe(302);
  expect(anonymousUi.headers().location).toContain("/api/auth/signin/eqo-oidc");

  await signIn(page, MAIN_OIDC_ORIGIN, TERMINAL_ORIGIN, "/api/healthz", MAIN_OIDC_CONTROL_TOKEN);
  const terminalSession = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(terminalSession.status).toBe(200);
  expect(terminalSession.body.user.roles).toEqual(["eqoboard-market-reader"]);

  const mainCookies = await page.context().cookies(TERMINAL_ORIGIN);
  expect(mainCookies.some((cookie) => cookie.name === "next-auth.session-token")).toBe(true);
  expect(mainCookies.some((cookie) => cookie.name === "eqo-research-session-token")).toBe(false);
  await page.context().storageState({ path: MAIN_STORAGE_STATE });

  await page.goto(`${TERMINAL_ORIGIN}/`);
  const researchLink = page.getByRole("navigation").getByRole("link", { name: /OpenBB Research/ });
  await expect(researchLink).toHaveAttribute("href", RESEARCH_ORIGIN);
  await expect(researchLink).toHaveAttribute("target", "_blank");
  await expect(researchLink).toHaveAttribute("rel", "noopener noreferrer");
  const researchPopupPromise = page.waitForEvent("popup");
  await researchLink.click();
  const researchPopup = await researchPopupPromise;
  await expect(researchPopup).toHaveURL(new RegExp(`^${RESEARCH_ORIGIN.replaceAll(".", "\\.")}`));
  await expect(researchPopup.getByRole("button", { name: /Organization sign-in/i })).toBeVisible();
  await expect(researchPopup.getByLabel("Email")).toHaveCount(0);
  await researchPopup.close();

  const researchAuth = await page.request.get(`${RESEARCH_ORIGIN}/api/research/auth-check`);
  expect(researchAuth.status()).toBe(404);
  const researchCookiesBeforeLogin = await page.context().cookies(RESEARCH_ORIGIN);
  expect(researchCookiesBeforeLogin.some((cookie) => cookie.name === "next-auth.session-token")).toBe(false);

  await signIn(page, RESEARCH_OIDC_ORIGIN, RESEARCH_ORIGIN, "/login", RESEARCH_OIDC_CONTROL_TOKEN);
  const researchCookies = await page.context().cookies(RESEARCH_ORIGIN);
  expect(researchCookies.map((cookie) => cookie.name)).toContain("eqo-research-session-token");
  expect(researchCookies.map((cookie) => cookie.name)).not.toContain("next-auth.session-token");
  expect((await page.request.get(`${RESEARCH_ORIGIN}/api/research/auth-check`)).status()).toBe(404);
  const researchSession = await page.request.get(`${RESEARCH_ORIGIN}/api/auth/session`);
  expect(researchSession.status()).toBe(200);
  expect(await researchSession.json()).toMatchObject({ user: { roles: ["eqoboard-market-reader"] } });
  expect((await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/widgets.json`)).status()).toBe(200);
  expect((await page.request.fetch(`${RESEARCH_ORIGIN}/api/openbb/widgets.json`, { method: "OPTIONS" })).status()).toBe(404);
  expect((await page.request.fetch(`${RESEARCH_ORIGIN}/api/openbb/widgets.json`, { method: "HEAD" })).status()).toBe(404);
});

test("native OpenBB Lite login adds and loads all three EqoBoard widgets without source fallback", async ({ page, request }) => {
  const diagnostics = collectPageDiagnostics(page);
  activeNativeDiagnostics = diagnostics;
  const browserCalls: string[] = [];
  page.on("request", (browserRequest) => browserCalls.push(browserRequest.url()));
  const captured = await captureOpenbbResponses(page);

  await signIn(page, RESEARCH_OIDC_ORIGIN, RESEARCH_ORIGIN, "/login", RESEARCH_OIDC_CONTROL_TOKEN);
  await nativeLiteLogin(page);
  // A fresh Lite admin can receive the upstream first-login onboarding route.
  // Let its initial API requests settle before opening the native widget page.
  await page.waitForTimeout(4_000);
  await savePageDiagnostics(page, diagnostics, "native-openbb-first-login-landing.json");
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-first-login-landing.png"), fullPage: true });
  await completeNativeLiteOnboarding(page);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-onboarding-complete.png"), fullPage: true });
  await expect(page.getByRole("link", { name: "Widgets", exact: true })).toBeVisible();
  await page.goto(`${RESEARCH_ORIGIN}/app/widgets`);
  await expect(page).toHaveTitle(/Widgets Library \| OpenBB Lite/);
  await expect(page.getByText("Widgets Library", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add Data", exact: true }).first().click();
  const dialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Add Data", exact: true }),
  });
  await dialog.getByRole("tab", { name: "Apps", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("仅演示 / MOCK SIP/OPRA");
  await dialog.getByLabel("URL", { exact: true }).fill(`${RESEARCH_ORIGIN}/api/openbb`);

  const validateControl = dialog.getByText("Validate Widgets", { exact: true }).locator("xpath=..").getByRole("combobox");
  await validateControl.click();
  await page.getByRole("option", { name: "Yes", exact: true }).click();
  await dialog.getByRole("button", { name: "Test", exact: true }).click();
  await expect(dialog.getByText("Test successful", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/3 Widgets found/)).toBeVisible();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const addToNewDashboard = page.getByRole("button", { name: "Add to new dashboard", exact: true });
  await expect(addToNewDashboard).toBeVisible();
  await addToNewDashboard.click();
  await expect(page.getByText("EqoBoard SIP Stock Quotes", { exact: true })).toBeVisible();
  await expect(page.getByText("EqoBoard OPRA Option Chain", { exact: true })).toBeVisible();
  await expect(page.getByText("EqoBoard SIP OHLCV", { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe("/app/widgets");
  const dashboardUrl = page.url();
  expect(new URL(dashboardUrl).origin).toBe(RESEARCH_ORIGIN);
  await writeFile(DASHBOARD_URL_FILE, JSON.stringify({ url: dashboardUrl }, null, 2), { mode: 0o600 });

  const generatedDashboardName = (await page.title()).split("|")[0].trim();
  expect(generatedDashboardName).not.toBe("");
  const dashboardTreeItem = page.getByRole("treeitem").filter({ hasText: generatedDashboardName });
  await expect(dashboardTreeItem).toBeVisible();
  await dashboardTreeItem.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const renameDialog = page.getByRole("dialog").filter({ hasText: "Rename dashboard" });
  await renameDialog.getByRole("textbox").fill("仅演示 / MOCK SIP/OPRA");
  await renameDialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page).toHaveTitle(/^仅演示 \/ MOCK SIP\/OPRA \| OpenBB Lite$/);
  await expect(page.getByRole("treeitem").filter({ hasText: "仅演示 / MOCK SIP/OPRA" })).toBeVisible();

  await expect.poll(() => captured.responses.filter((item) => item.status === 200).length, { timeout: 45_000 }).toBeGreaterThanOrEqual(5);
  await captured.settle();
  const widgets = captured.responses.find((item) => item.path === "/api/openbb/widgets.json" && item.status === 200);
  const apps = captured.responses.find((item) => item.path === "/api/openbb/apps.json" && item.status === 200);
  expect(widgets).toBeDefined();
  expect(apps).toBeDefined();
  expect(Object.keys(widgets!.body as object).sort()).toEqual(["eqo_opra_contracts", "eqo_sip_bars", "eqo_sip_watchlist"]);
  expect(captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/stocks") && item.status === 200)).toBe(true);
  expect(captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/bars") && item.status === 200)).toBe(true);
  expect(captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/options") && item.status === 200)).toBe(true);

  const stocks = rowsFor(captured.responses, "/api/openbb/openbb/v1/stocks");
  const bars = rowsFor(captured.responses, "/api/openbb/openbb/v1/bars");
  const options = rowsFor(captured.responses, "/api/openbb/openbb/v1/options");
  expect(stocks[0]).toMatchObject({ symbol: "QQQ", source: "unknown", source_mode: "unknown", source_label: "source unknown", feed: "sip", complete: true, truncated: false });
  expect(stocks[0].market_as_of).toEqual(expect.any(String));
  expect(stocks[0].quote_at).toEqual(expect.any(String));
  expect(stocks[0].trade_at).toEqual(expect.any(String));
  expect(bars[0]).toMatchObject({ symbol: "QQQ", source: "unknown", source_mode: "unknown", source_label: "source unknown", feed: "sip", complete: true, truncated: false });
  expect(bars[0].market_as_of).toEqual(expect.any(String));
  expect(options[0]).toMatchObject({ underlying: "QQQ", source: "unknown", source_mode: "unknown", source_label: "source unknown", feed: "opra", complete: true, truncated: false });
  expect(options[0].market_as_of).toEqual(expect.any(String));

  const callMetrics = await (await request.get(`${MOCK_ORIGIN}/__test/metrics`, { headers: { "x-e2e-control": CONTROL_TOKEN } })).json();
  const dataCalls = callMetrics.calls.filter((call: { path: string }) => !call.path.startsWith("/__test/"));
  expect(dataCalls.length).toBeGreaterThanOrEqual(3);
  expect(dataCalls.some((call: { path: string; feed: string }) => call.path === "/v2/stocks/snapshots" && call.feed === "sip")).toBe(true);
  expect(dataCalls.some((call: { path: string; feed: string; symbol: string }) => call.path.endsWith("/bars") && call.feed === "sip" && call.symbol === "QQQ")).toBe(true);
  const optionRequest = dataCalls.find((call: { path: string; feed: string }) => call.path.startsWith("/v1beta1/options/snapshots/") && call.feed === "opra");
  expect(optionRequest).toBeDefined();
  expect(optionRequest.expiration_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  for (const call of dataCalls) expect(call).toMatchObject({ key_id_present: true, secret_present: true });
  expect(callMetrics.websocket_paths.sort()).toEqual(["/v1beta1/opra", "/v2/sip"]);
  expect(browserCalls.some((url) => /yahoo|iex/i.test(url))).toBe(false);
  expect(browserCalls.some((url) => /\/orders?(\/|\?|$)|\/submit(\/|\?|$)/i.test(url))).toBe(false);

  const barsWidget = page.locator(".react-grid-item").filter({
    has: page.getByText("EqoBoard SIP OHLCV", { exact: true }),
  });
  await expect(barsWidget).toHaveCount(1);
  await expect(barsWidget.getByRole("columnheader", { name: "Market as of", exact: true })).toBeVisible();
  await expect(barsWidget.getByText(String(bars[0].market_as_of), { exact: true }).filter({ visible: true })).toBeVisible();
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-mock-dashboard-market-time.png"), fullPage: true });

  const horizontalViewports = page.locator(".ag-body-horizontal-scroll-viewport");
  await expect(horizontalViewports).toHaveCount(3);
  await horizontalViewports.evaluateAll((elements) => {
    for (const element of elements) {
      const viewport = element as HTMLElement;
      viewport.scrollLeft = viewport.scrollWidth;
    }
  });
  await expect(page.getByRole("columnheader", { name: "Source", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Feed", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Truncated", exact: true }).first()).toBeVisible();
  await expect(page.getByText("source unknown", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("sip", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("opra", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("仅演示 / MOCK SIP/OPRA", { exact: false })).toBeVisible();
  const dashboardText = await page.locator("body").innerText();
  expect(dashboardText).toContain("source unknown");
  expect(dashboardText.toLowerCase()).toContain("sip");
  expect(dashboardText.toLowerCase()).toContain("opra");
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-mock-dashboard.png"), fullPage: true });

  await controlMock(request, { bars: "empty-truncated", options: "empty-truncated" });
  await page.goto(dashboardUrl);
  await expect.poll(() => captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/bars") && item.status === 502), { timeout: 45_000 }).toBe(true);
  await expect.poll(() => captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/options") && item.status === 502), { timeout: 45_000 }).toBe(true);
  await captured.settle();
  const truncationText = await page.locator("body").innerText();
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-pagination-error.png"), fullPage: true });
  expect(truncationText).toMatch(/error|failed|unavailable|bad gateway|truncat/i);

  const truncatedBars = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/openbb/v1/bars?symbol=QQQ&timeframe=1Day&days=30&limit=500`);
  expect(truncatedBars.status()).toBe(502);
  expect(await truncatedBars.json()).toMatchObject({ error: "market_data_truncated", source: "unknown", feed: "sip", pages_fetched: 5, has_more: true });
  const truncatedOptions = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/openbb/v1/options?underlying=QQQ&expiration=${optionRequest.expiration_date}`);
  expect(truncatedOptions.status()).toBe(502);
  expect(await truncatedOptions.json()).toMatchObject({ error: "market_data_truncated", source: "unknown", feed: "opra", pages_fetched: 5, has_more: true });
  const truncatedMetrics = await (await request.get(`${MOCK_ORIGIN}/__test/metrics`, { headers: { "x-e2e-control": CONTROL_TOKEN } })).json();
  expect(truncatedMetrics.calls.filter((call: { page_token?: string | null }) => call.page_token).length).toBeGreaterThanOrEqual(8);
  await controlMock(request, { bars: "normal", options: "normal" });
  await page.goto(dashboardUrl);
  await expect(page).toHaveTitle(/^仅演示 \/ MOCK SIP\/OPRA \| OpenBB Lite$/);
  expect(browserCalls.some((url) => url.includes("/assets/js/datafeeds/udf/dist/bundle.js"))).toBe(false);
  expect(diagnostics.pageErrors).toEqual([]);
  await page.context().storageState({ path: STORAGE_STATE });
});

test("OIDC role and public ingress fail closed", async ({ page, request }) => {
  await setRoles(request, RESEARCH_OIDC_ORIGIN, ["eqoboard-workspace-editor"], RESEARCH_OIDC_CONTROL_TOKEN);
  await signIn(page, RESEARCH_OIDC_ORIGIN, RESEARCH_ORIGIN, "/login", RESEARCH_OIDC_CONTROL_TOKEN);
  expect((await page.request.get(`${RESEARCH_ORIGIN}/api/research/auth-check`)).status()).toBe(404);
  const api = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/widgets.json`);
  expect(api.status()).toBe(403);
  expect(await api.json()).toEqual({ error: "market_reader_role_required" });
  const ui = await page.goto(`${RESEARCH_ORIGIN}/app/widgets`);
  expect(ui?.status()).toBe(403);
  await expect(page.getByText("This account is not authorized to open the research workspace.", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(ARTIFACT_DIR, "research-role-denied.png"), fullPage: true });
});
