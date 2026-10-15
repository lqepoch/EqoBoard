import { expect, test, type Page } from "@playwright/test";
import { researchWebOrigin, terminalWebOrigin, YFINANCE_DAILY_QUERY } from "./helpers/research-test-support";

function cspNonce(csp: string | undefined): string {
  expect(csp).toBeTruthy();
  const directive = csp?.split(";").map((item) => item.trim()).find((item) => item.startsWith("script-src "));
  const match = directive?.match(/'nonce-([A-Za-z0-9+/]{43}=)'/u);
  expect(match, "the script-src directive must contain a fresh base64 nonce").toBeTruthy();
  return match?.[1] ?? "";
}

async function expectNonceMatchesRenderedScripts(page: Page, expectedNonce: string): Promise<void> {
  const scriptNonces = await page.locator("script[nonce]").evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).nonce),
  );
  expect(scriptNonces.length, "the document must render nonce-bearing Next scripts").toBeGreaterThan(0);
  expect(new Set(scriptNonces)).toEqual(new Set([expectedNonce]));

  const inlineScriptNonces = await page.locator("script:not([src])").evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).nonce),
  );
  expect(inlineScriptNonces.length, "the document must render inline Next hydration scripts").toBeGreaterThan(0);
  expect(inlineScriptNonces.every((nonce) => nonce === expectedNonce)).toBe(true);
}

test("@component terminal and Research documents use a fresh nonce-bound production CSP", async ({ page }) => {
  for (const origin of [terminalWebOrigin(), researchWebOrigin()]) {
    const firstResponse = await page.goto(origin, { waitUntil: "domcontentloaded" });
    expect(firstResponse).not.toBeNull();
    const firstCsp = firstResponse?.headers()["content-security-policy"];
    const firstNonce = cspNonce(firstCsp);
    expect(firstCsp).toContain("'strict-dynamic'");
    expect(firstCsp).toContain("script-src-attr 'none'");
    expect(firstCsp).toContain("frame-src 'none'");
    expect(firstCsp).toContain("frame-ancestors 'none'");
    expect(firstCsp).toContain("object-src 'none'");
    expect(firstCsp).not.toContain("'unsafe-eval'");
    expect(firstCsp).not.toMatch(/script-src\s[^;]*'unsafe-inline'/u);
    expect(firstResponse?.headers()["x-frame-options"]).toBe("DENY");
    expect(firstResponse?.headers()["x-content-type-options"]).toBe("nosniff");
    await expectNonceMatchesRenderedScripts(page, firstNonce);

    const secondResponse = await page.reload({ waitUntil: "domcontentloaded" });
    const secondCsp = secondResponse?.headers()["content-security-policy"];
    const secondNonce = cspNonce(secondCsp);
    expect(secondNonce).not.toBe(firstNonce);
    expect(secondCsp).toContain("'strict-dynamic'");
    expect(secondCsp).not.toContain("'unsafe-eval'");
    await expectNonceMatchesRenderedScripts(page, secondNonce);
  }
});

test("@component auth projection and hydration remain request-scoped across anonymous and OIDC documents", async ({ page }) => {
  const origin = terminalWebOrigin();
  const anonymousResponse = await page.goto(origin, { waitUntil: "domcontentloaded" });
  expect(anonymousResponse).not.toBeNull();
  expect(anonymousResponse?.status()).toBe(200);
  const anonymousCsp = anonymousResponse?.headers()["content-security-policy"];
  const anonymousNonce = cspNonce(anonymousCsp);
  await expect(page.getByTestId("access-state")).toContainText("Sign in to open your workspace");
  await expect(page.getByTestId("sign-in-button")).toBeVisible();
  await expect(page.getByTestId("account-menu")).toHaveCount(0);
  await expectNonceMatchesRenderedScripts(page, anonymousNonce);

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();

  const authenticatedDocument = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().isNavigationRequest() && url.origin === origin && url.pathname === "/";
  });
  await page.getByTestId("sign-in-button").click();
  await expect(page.getByTestId("mock-login-writer")).toBeVisible();
  await page.getByTestId("mock-login-writer").click();

  const authenticatedResponse = await authenticatedDocument;
  expect(authenticatedResponse.status()).toBe(200);
  const authenticatedCsp = authenticatedResponse.headers()["content-security-policy"];
  const authenticatedNonce = cspNonce(authenticatedCsp);
  expect(authenticatedNonce).not.toBe(anonymousNonce);
  expect(authenticatedCsp).toContain("'strict-dynamic'");
  expect(authenticatedCsp).not.toContain("'unsafe-eval'");
  await expect(page.getByTestId("account-menu")).toBeVisible();
  await expect(page.getByTestId("sign-in-button")).toHaveCount(0);
  await expect(page.getByTestId("workspace-root")).toBeVisible();
  await expectNonceMatchesRenderedScripts(page, authenticatedNonce);

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();
});

test("@api anonymous terminal and Research JSON responses omit page CSP and nonce material", async ({ request }) => {
  const cases = [
    { origin: terminalWebOrigin(), path: "/api/workspaces" },
    { origin: researchWebOrigin(), path: `/api/research/yfinance/daily?${YFINANCE_DAILY_QUERY}` },
  ] as const;

  for (const route of cases) {
    const response = await request.get(new URL(route.path, route.origin).toString(), {
      headers: { Accept: "application/json" },
    });
    expect(response.status(), route.origin).toBe(401);
    expect(response.headers()["cache-control"]).toMatch(/no-store/u);
    expect(response.headers()["content-type"]).toMatch(/application\/json/iu);
    expect(response.headers()["content-security-policy"]).toBeUndefined();
    expect(response.headers()["x-nonce"]).toBeUndefined();
    expect(response.headers()["x-middleware-request-x-nonce"]).toBeUndefined();
    expect(response.headers()["x-middleware-request-content-security-policy"]).toBeUndefined();
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  }
});
