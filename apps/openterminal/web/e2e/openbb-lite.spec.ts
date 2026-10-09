import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureJsonResponses, type CapturedResponse } from "./openbb-response-capture";

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

function rowsFor(response: CapturedResponse | undefined, route: string) {
  expect(response, `No completed successful native browser response for ${route}`).toBeDefined();
  expect(Array.isArray(response?.body) && response.body.length > 0, `${route} did not return non-empty OpenBB flat rows`).toBe(true);
  return response!.body as Record<string, unknown>[];
}

function isValidRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return false;
  if (match[8] && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

async function latestAsOfValues(captured: ReturnType<typeof captureJsonResponses>, route: string, since: number) {
  const response = await captured.latestSettled(
    (item) => item.path.startsWith(route) && item.status === 200,
    since,
  );
  if (!response || !Array.isArray(response.body)) return [];
  return (response.body as Record<string, unknown>[])
    .map((row) => row.market_as_of)
    .filter(isValidRfc3339Timestamp);
}

function barsPollSignatures(responses: CapturedResponse[]) {
  return responses.flatMap((response) => {
    if (!response.path.startsWith("/api/openbb/openbb/v1/bars") || response.status !== 200 || !Array.isArray(response.body)) return [];
    const times = (response.body as Record<string, unknown>[])
      .map((row) => row.market_as_of)
      .filter(isValidRfc3339Timestamp);
    return times.length > 0 ? [times.join("|")] : [];
  });
}

function latestResponseUrl(responses: CapturedResponse[], route: string) {
  const response = [...responses].reverse().find((item) => item.path.startsWith(route) && item.status === 200);
  expect(response, `No successful browser response URL for ${route}`).toBeDefined();
  return new URL(response!.path, RESEARCH_ORIGIN);
}

async function revealGridColumns(page: Page, widget: Locator, columnIds: string[]) {
  const viewport = widget.locator(".ag-body-horizontal-scroll-viewport");
  await expect(viewport).toBeVisible();
  let wrappedToStart = false;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const position = await widget.evaluate((root, targets) => {
      const horizontalViewport = root.querySelector<HTMLElement>(".ag-body-horizontal-scroll-viewport");
      if (!horizontalViewport) return { missingViewport: true, missingHeader: false, delta: null, tooWide: false, scrollLeft: 0, maxScroll: 0 };
      const viewportRect = horizontalViewport.getBoundingClientRect();
      const headers = targets.map((target) =>
        Array.from(root.querySelectorAll<HTMLElement>('.ag-header-cell[role="columnheader"]'))
          .find((header) => header.getAttribute("col-id") === target) ?? null,
      );
      const scrollLeft = horizontalViewport.scrollLeft;
      const maxScroll = Math.max(0, horizontalViewport.scrollWidth - horizontalViewport.clientWidth);
      if (headers.some((header) => header === null)) {
        return { missingViewport: false, missingHeader: true, delta: null, tooWide: false, scrollLeft, maxScroll };
      }
      const headerRects = headers.map((header) => header!.getBoundingClientRect());
      const left = Math.min(...headerRects.map((rect) => rect.left));
      const right = Math.max(...headerRects.map((rect) => rect.right));
      if (right - left > horizontalViewport.clientWidth) {
        return { missingViewport: false, missingHeader: false, delta: null, tooWide: true, scrollLeft, maxScroll };
      }
      const delta = left < viewportRect.left
        ? left - viewportRect.left
        : right > viewportRect.right
          ? right - viewportRect.right
          : 0;
      return { missingViewport: false, missingHeader: false, delta, tooWide: false, scrollLeft, maxScroll };
    }, columnIds);
    if (position.missingViewport) throw new Error("Native AG Grid horizontal viewport is not rendered");
    if (position.tooWide) throw new Error("Requested native AG Grid columns exceed the viewport; scroll them individually");
    if (position.delta === 0) return;
    if (position.missingHeader) {
      if (position.scrollLeft < position.maxScroll - 1) {
        await viewport.evaluate((element) => {
          const horizontalViewport = element as HTMLElement;
          horizontalViewport.scrollLeft = Math.min(
            horizontalViewport.scrollWidth - horizontalViewport.clientWidth,
            horizontalViewport.scrollLeft + Math.max(100, horizontalViewport.clientWidth * 0.6),
          );
        });
      } else if (!wrappedToStart) {
        wrappedToStart = true;
        await viewport.evaluate((element) => { (element as HTMLElement).scrollLeft = 0; });
      } else {
        throw new Error("Native AG Grid target column is not rendered: " + columnIds.join(", "));
      }
    } else if (position.delta !== null) {
      await viewport.evaluate((element, offset) => {
        (element as HTMLElement).scrollLeft += offset;
      }, position.delta);
    } else {
      await viewport.evaluate((element) => {
        (element as HTMLElement).scrollLeft = 0;
      });
    }
    await page.waitForTimeout(60);
  }

  throw new Error("Native AG Grid columns were not visible: " + columnIds.join(", "));
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
  // Includes native onboarding, widget polling, and bounded pagination/denial/recovery phases.
  test.setTimeout(300_000);
  const diagnostics = collectPageDiagnostics(page);
  activeNativeDiagnostics = diagnostics;
  const browserCalls: string[] = [];
  page.on("request", (browserRequest) => browserCalls.push(browserRequest.url()));
  const captured = captureJsonResponses(page, RESEARCH_ORIGIN, (_response, path) => path.startsWith("/api/openbb/"));

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
  const nativeDashboardResponseStart = captured.mark();
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

  await expect.poll(() => captured.since(nativeDashboardResponseStart).filter((item) => item.status === 200).length, { timeout: 45_000 }).toBeGreaterThanOrEqual(5);
  const marketRoutes = [
    "/api/openbb/openbb/v1/stocks",
    "/api/openbb/openbb/v1/bars",
    "/api/openbb/openbb/v1/options",
  ];
  const initialMarketResponses: CapturedResponse[] = [];
  for (const route of marketRoutes) {
    await expect.poll(async () => {
      const response = await captured.latestSettled(
        (item) => item.path.startsWith(route) && item.status === 200,
        nativeDashboardResponseStart,
      );
      if (!Array.isArray(response?.body) || response.body.length === 0) return false;
      initialMarketResponses[marketRoutes.indexOf(route)] = response;
      return true;
    }, { timeout: 45_000, message: `Native dashboard did not receive non-empty flat rows from ${route}` }).toBe(true);
  }
  await captured.settle();
  const widgets = captured.responses.find((item) => item.path === "/api/openbb/widgets.json" && item.status === 200);
  const apps = captured.responses.find((item) => item.path === "/api/openbb/apps.json" && item.status === 200);
  expect(widgets).toBeDefined();
  expect(apps).toBeDefined();
  expect(Object.keys(widgets!.body as object).sort()).toEqual(["eqo_opra_contracts", "eqo_sip_bars", "eqo_sip_watchlist"]);
  expect(captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/stocks") && item.status === 200)).toBe(true);
  expect(captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/bars") && item.status === 200)).toBe(true);
  expect(captured.responses.some((item) => item.path.startsWith("/api/openbb/openbb/v1/options") && item.status === 200)).toBe(true);

  const stocks = rowsFor(initialMarketResponses[0], marketRoutes[0]);
  const bars = rowsFor(initialMarketResponses[1], marketRoutes[1]);
  const options = rowsFor(initialMarketResponses[2], marketRoutes[2]);
  expect(stocks[0]).toMatchObject({ symbol: "QQQ", source: "unknown", source_mode: "unknown", source_label: "source unknown", feed: "sip", complete: true, truncated: false });
  expect(isValidRfc3339Timestamp(stocks[0].market_as_of)).toBe(true);
  expect(isValidRfc3339Timestamp(stocks[0].quote_at)).toBe(true);
  expect(isValidRfc3339Timestamp(stocks[0].trade_at)).toBe(true);
  expect(bars[0]).toMatchObject({ symbol: "QQQ", source: "unknown", source_mode: "unknown", source_label: "source unknown", feed: "sip", complete: true, truncated: false });
  expect(isValidRfc3339Timestamp(bars[0].market_as_of)).toBe(true);
  expect(options[0]).toMatchObject({ underlying: "QQQ", source: "unknown", source_mode: "unknown", source_label: "source unknown", feed: "opra", complete: true, truncated: false });
  expect(isValidRfc3339Timestamp(options[0].market_as_of)).toBe(true);

  const callMetrics = await (await request.get(`${MOCK_ORIGIN}/__test/metrics`, { headers: { "x-e2e-control": CONTROL_TOKEN } })).json();
  const dataCalls = callMetrics.calls.filter((call: { path: string }) => !call.path.startsWith("/__test/"));
  expect(dataCalls.length).toBeGreaterThanOrEqual(3);
  expect(dataCalls.some((call: { path: string; feed: string }) => call.path === "/v2/stocks/snapshots" && call.feed === "sip")).toBe(true);
  expect(dataCalls.some((call: { path: string; feed: string; symbol: string }) => call.path.endsWith("/bars") && call.feed === "sip" && call.symbol === "QQQ")).toBe(true);
  const optionRequest = dataCalls.find((call: { path: string; feed: string }) => call.path.startsWith("/v1beta1/options/snapshots/") && call.feed === "opra");
  expect(optionRequest).toBeDefined();
  expect(optionRequest.underlying).toBe("QQQ");
  expect(optionRequest.expiration_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const barsUpstreamRequest = dataCalls.find((call: { path: string; symbol: string }) => call.path.endsWith("/bars") && call.symbol === "QQQ");
  expect(barsUpstreamRequest).toMatchObject({ feed: "sip", timeframe: "1Day", limit: "500" });
  for (const call of dataCalls) expect(call).toMatchObject({ key_id_present: true, secret_present: true });
  const gatewayMetrics = await (await request.get(`${RESEARCH_OIDC_ORIGIN}/__test/metrics`)).json();
  expect(gatewayMetrics.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"))).toHaveLength(0);
  // The research widgets use bounded REST calls. They do not acquire a
  // terminal options lease, so rendering an OPRA snapshot must not start the
  // Gateway's OPRA WebSocket session.
  expect(callMetrics.websocket_paths.sort()).toEqual(["/v2/sip"]);
  expect(browserCalls.some((url) => /yahoo|iex/i.test(url))).toBe(false);
  expect(browserCalls.some((url) => /\/orders?(\/|\?|$)|\/submit(\/|\?|$)/i.test(url))).toBe(false);

  const barsWidget = page.locator(".react-grid-item").filter({
    has: page.getByText("EqoBoard SIP OHLCV", { exact: true }),
  });
  const stocksWidget = page.locator(".react-grid-item").filter({
    has: page.getByText("EqoBoard SIP Stock Quotes", { exact: true }),
  });
  const optionsWidget = page.locator(".react-grid-item").filter({
    has: page.getByText("EqoBoard OPRA Option Chain", { exact: true }),
  });
  await expect(barsWidget).toHaveCount(1);
  await expect(stocksWidget).toHaveCount(1);
  await expect(optionsWidget).toHaveCount(1);
  await expect(barsWidget.getByRole("columnheader", { name: "Market as of", exact: true })).toBeVisible();
  await captured.settle();
  const dashboardResponses = () => captured.since(nativeDashboardResponseStart);
  const stockParams = latestResponseUrl(dashboardResponses(), "/api/openbb/openbb/v1/stocks").searchParams;
  const barsParams = latestResponseUrl(dashboardResponses(), "/api/openbb/openbb/v1/bars").searchParams;
  const optionParams = latestResponseUrl(dashboardResponses(), "/api/openbb/openbb/v1/options").searchParams;
  expect(stockParams.get("symbols")).toBe("QQQ,SPY,NVDA");
  expect(barsParams.get("symbol")).toBe("QQQ");
  expect(barsParams.get("timeframe")).toBe("1Day");
  expect(barsParams.get("days")).toBe("30");
  expect(barsParams.get("limit")).toBe("500");
  expect(optionParams.get("underlying")).toBe("QQQ");
  expect(optionParams.get("expiration")).toBe(optionRequest.expiration_date);
  const initialBarsIndex = captured.responses.indexOf(initialMarketResponses[1]);
  await expect.poll(async () => {
    await captured.settle();
    const barsAfterInitialDashboardLoad = dashboardResponses().slice(
      Math.max(0, initialBarsIndex - nativeDashboardResponseStart + 1),
    );
    return new Set(barsPollSignatures(barsAfterInitialDashboardLoad)).size;
  }, { timeout: 65_000, message: "Native dashboard did not complete two distinct bars polling responses after its initial load" })
    .toBeGreaterThanOrEqual(2);
  const visibleMarketAsOfCells = barsWidget.locator('.ag-cell[col-id="market_as_of"]').filter({ visible: true });
  await expect.poll(async () => {
    const rendered = await visibleMarketAsOfCells.allTextContents();
    const latestBarsAsOfValues = await latestAsOfValues(
      captured,
      "/api/openbb/openbb/v1/bars",
      nativeDashboardResponseStart,
    );
    return latestBarsAsOfValues.length > 0 && latestBarsAsOfValues.some((value) => rendered.includes(value));
  }).toBe(true);
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-mock-dashboard-market-time.png"), fullPage: true });

  const nativeWidgets = [
    { widget: stocksWidget, feed: "sip" },
    { widget: barsWidget, feed: "sip" },
    { widget: optionsWidget, feed: "opra" },
  ] as const;
  for (const { widget, feed } of nativeWidgets) {
    for (const [columnId, expected] of [["source_label", "source unknown"], ["feed", feed]] as const) {
      await revealGridColumns(page, widget, [columnId]);
      await expect(widget.locator(`.ag-header-cell[role="columnheader"][col-id="${columnId}"]`)).toBeVisible();
      await expect(widget.locator(`.ag-cell[col-id="${columnId}"]`).filter({ visible: true }).first()).toHaveText(expected);
    }
  }
  await expect(page.getByText("仅演示 / MOCK SIP/OPRA", { exact: false })).toBeVisible();
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-mock-dashboard-source-feed.png"), fullPage: true });

  for (const { widget } of nativeWidgets) {
    for (const [columnId, expected] of [["truncated", "false"], ["complete", "true"]] as const) {
      await revealGridColumns(page, widget, [columnId]);
      await expect(widget.locator(`.ag-header-cell[role="columnheader"][col-id="${columnId}"]`)).toBeVisible();
      const booleanCell = widget.locator(`.ag-cell[col-id="${columnId}"]`).filter({ visible: true }).first();
      const checkbox = booleanCell.locator('input[type="checkbox"]');
      await expect(checkbox).toBeVisible();
      if (expected === "true") {
        await expect(checkbox).toBeChecked();
      } else {
        await expect(checkbox).not.toBeChecked();
      }
    }
  }
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-mock-dashboard-completeness.png"), fullPage: true });

  await controlMock(request, { bars: "empty-truncated", options: "empty-truncated" });
  const paginationResponseStart = captured.mark();
  await page.goto(dashboardUrl);
  for (const route of ["bars", "options"] as const) {
    await expect.poll(async () => {
      const response = await captured.latestSettled(
        (item) => item.path.startsWith(`/api/openbb/openbb/v1/${route}`) && item.status === 502,
        paginationResponseStart,
      );
      return (response?.body as { error?: string } | undefined)?.error === "market_data_truncated";
    }, { timeout: 45_000, message: `Native ${route} endpoint did not return its latest completed truncation response` }).toBe(true);
  }
  await expect.poll(async () => {
    const response = await captured.latestSettled(
      (item) => item.path.startsWith("/api/openbb/openbb/v1/stocks") && item.status === 200,
      paginationResponseStart,
    );
    return Array.isArray(response?.body) && response.body.some((row: Record<string, unknown>) => row.symbol === "QQQ");
  }, { timeout: 45_000, message: "Pagination phase did not receive completed healthy QQQ stock rows" }).toBe(true);
  await captured.settle();
  for (const [widget, route] of [[barsWidget, "bars"], [optionsWidget, "options"]] as const) {
    const response = await captured.latestSettled(
      (item) => item.path.startsWith(`/api/openbb/openbb/v1/${route}`) && item.status === 502,
      paginationResponseStart,
    );
    expect(response?.body).toMatchObject({ error: "market_data_truncated", pages_fetched: 5, has_more: true });
    const detail = (response?.body as { detail?: string } | undefined)?.detail;
    expect(typeof detail === "string" && detail.length > 0).toBe(true);
    await expect(widget.getByTestId("results-not-found")).toBeVisible();
    await expect(widget.getByText(detail!, { exact: true })).toBeVisible();
    await expect(widget.getByRole("gridcell")).toHaveCount(0);
  }
  const paginationStockSymbols = stocksWidget.locator('.ag-cell[col-id="symbol"]');
  await expect.poll(async () =>
    (await paginationStockSymbols.allTextContents()).some((text) => text.trim() === "QQQ"),
  ).toBe(true);
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-pagination-error.png"), fullPage: true });

  const truncatedBars = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/openbb/v1/bars?symbol=QQQ&timeframe=1Day&days=30&limit=500`);
  expect(truncatedBars.status()).toBe(502);
  expect(await truncatedBars.json()).toMatchObject({ error: "market_data_truncated", source: "unknown", feed: "sip", pages_fetched: 5, has_more: true });
  const truncatedOptions = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/openbb/v1/options?underlying=QQQ&expiration=${optionRequest.expiration_date}`);
  expect(truncatedOptions.status()).toBe(502);
  expect(await truncatedOptions.json()).toMatchObject({ error: "market_data_truncated", source: "unknown", feed: "opra", pages_fetched: 5, has_more: true });
  const truncatedMetrics = await (await request.get(`${MOCK_ORIGIN}/__test/metrics`, { headers: { "x-e2e-control": CONTROL_TOKEN } })).json();
  expect(truncatedMetrics.calls.filter((call: { page_token?: string | null }) => call.page_token).length).toBeGreaterThanOrEqual(8);
  await controlMock(request, { bars: "normal", options: "normal" });

  const metricsBeforeDenied = await (await request.get(`${MOCK_ORIGIN}/__test/metrics`, { headers: { "x-e2e-control": CONTROL_TOKEN } })).json();
  const deniedFixtureCallStart = metricsBeforeDenied.calls.length;
  const deniedResponseStart = captured.mark();
  await controlMock(request, { stocks: "denied", bars: "denied", options: "denied" });
  await page.goto(dashboardUrl);
  for (const route of ["stocks", "bars", "options"]) {
    await expect.poll(async () => {
      const response = await captured.latestSettled(
        (item) => item.path.startsWith(`/api/openbb/openbb/v1/${route}`) && item.status === 403,
        deniedResponseStart,
      );
      const body = response?.body as { error?: string; detail?: string } | undefined;
      return body?.error === "market_data_error" && body.detail?.includes("403") === true;
    }, { timeout: 45_000, message: `Native ${route} provider denial did not return its latest completed 403 response` }).toBe(true);
  }
  await captured.settle();
  for (const [widget, route] of [
    [stocksWidget, "stocks"],
    [barsWidget, "bars"],
    [optionsWidget, "options"],
  ] as const) {
    const response = await captured.latestSettled((item) =>
      item.path.startsWith(`/api/openbb/openbb/v1/${route}`) && item.status === 403,
      deniedResponseStart,
    );
    expect(response?.body).toMatchObject({ error: "market_data_error" });
    const detail = (response?.body as { detail?: string } | undefined)?.detail;
    expect(detail).toContain("403");
    await expect(widget.getByTestId("results-not-found")).toBeVisible();
    await expect(widget.getByText(detail!, { exact: true })).toBeVisible();
    await expect(widget.getByRole("gridcell")).toHaveCount(0);
  }
  const deniedMetrics = await (await request.get(`${MOCK_ORIGIN}/__test/metrics`, { headers: { "x-e2e-control": CONTROL_TOKEN } })).json();
  const deniedFixtureCalls = deniedMetrics.calls.slice(deniedFixtureCallStart).filter((call: { path: string }) => !call.path.startsWith("/__test/"));
  expect(deniedFixtureCalls.some((call: { path: string; feed: string }) => call.path === "/v2/stocks/snapshots" && call.feed === "sip")).toBe(true);
  expect(deniedFixtureCalls.some((call: { path: string; feed: string; symbol: string }) => call.path.endsWith("/bars") && call.feed === "sip" && call.symbol === "QQQ")).toBe(true);
  expect(deniedFixtureCalls.some((call: { path: string; feed: string }) => call.path.startsWith("/v1beta1/options/snapshots/") && call.feed === "opra")).toBe(true);
  expect(deniedFixtureCalls.every((call: { key_id_present: boolean; secret_present: boolean }) =>
    call.key_id_present && call.secret_present,
  )).toBe(true);
  expect(browserCalls.some((url) => /yahoo|iex/i.test(url))).toBe(false);
  await page.screenshot({ path: join(ARTIFACT_DIR, "native-openbb-market-entitlement-denied.png"), fullPage: true });

  await controlMock(request, { stocks: "normal", bars: "normal", options: "normal" });
  const restoredResponseStart = captured.mark();
  await page.goto(dashboardUrl);
  await expect(page).toHaveTitle(/^仅演示 \/ MOCK SIP\/OPRA \| OpenBB Lite$/);
  const restoredRows: Record<string, Record<string, unknown>[]> = {};
  for (const route of ["stocks", "bars", "options"] as const) {
    await expect.poll(async () => {
      const response = await captured.latestSettled(
        (item) => item.path.startsWith(`/api/openbb/openbb/v1/${route}`) && item.status === 200,
        restoredResponseStart,
      );
      if (!Array.isArray(response?.body) || response.body.length === 0) return false;
      restoredRows[route] = response.body as Record<string, unknown>[];
      return route === "options"
        ? restoredRows[route].some((row) => row.underlying === "QQQ")
        : restoredRows[route].some((row) => row.symbol === "QQQ");
    }, { timeout: 45_000, message: `Native ${route} API did not recover with completed QQQ rows after the denied phase` }).toBe(true);
  }
  await captured.settle();
  await expect.poll(async () =>
    (await stocksWidget.locator('.ag-cell[col-id="symbol"]').allTextContents()).some((text) => text.trim() === "QQQ"),
  ).toBe(true);
  await expect(barsWidget.getByRole("gridcell")).not.toHaveCount(0);
  await revealGridColumns(page, barsWidget, ["open"]);
  const recoveredOpenCells = barsWidget.locator('.ag-cell[col-id="open"]').filter({ visible: true });
  await expect.poll(async () =>
    (await recoveredOpenCells.allTextContents()).some((text) =>
      Number(text.replace(/[,$]/g, "").trim()) === restoredRows.bars[0]?.open,
    ),
  ).toBe(true);
  await expect.poll(async () =>
    (await optionsWidget.locator('.ag-cell[col-id="symbol"]').allTextContents()).some((text) =>
      restoredRows.options.some((row) => row.symbol === text.trim()),
    ),
  ).toBe(true);
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
