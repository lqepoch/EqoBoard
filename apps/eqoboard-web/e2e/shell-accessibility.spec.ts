import { expect, test, type Page, type TestInfo } from "@playwright/test";

function webOrigin(): string {
  const origin = process.env.E2E_WEB_ORIGIN;
  if (!origin) throw new Error("E2E_WEB_ORIGIN must point at the production Compose image.");
  return origin;
}

function candidateSha(): string {
  const sha = process.env.E2E_CANDIDATE_SHA;
  if (!sha || !/^[0-9a-f]{40}$/iu.test(sha)) {
    throw new Error("E2E_CANDIDATE_SHA must be the frozen native source-head SHA supplied by the Compose helper.");
  }
  return sha.toLowerCase();
}

async function openNativeApp(page: Page): Promise<number> {
  const startedAt = Date.now();
  await page.goto(webOrigin(), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("app-shell")).toBeVisible();
  return Date.now() - startedAt;
}

async function attachNavigationSample(page: Page, testInfo: TestInfo, usableRenderMs: number): Promise<void> {
  const browserMetrics = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return {
      responseStartMs: entry?.responseStart ?? null,
      domContentLoadedMs: entry?.domContentLoadedEventEnd ?? null,
      loadEventMs: entry?.loadEventEnd ?? null,
      transferBytes: entry?.transferSize ?? null,
      encodedBodyBytes: entry?.encodedBodySize ?? null,
      decodedBodyBytes: entry?.decodedBodySize ?? null,
    };
  });
  await testInfo.attach("native-navigation-sample", {
    body: JSON.stringify({
      status: "candidate-sample-only; paired-baseline-not-run",
      candidateSha: candidateSha(),
      candidateOrigin: new URL(webOrigin()).origin,
      browserVersion: page.context().browser()?.version() ?? null,
      usableRenderMs,
      ...browserMetrics,
    }, null, 2),
    contentType: "application/json",
  });
}

test("@component anonymous shell exposes safe access state and accessible navigation", async ({ page }, testInfo) => {
  const externalRequests: string[] = [];
  const origin = new URL(webOrigin()).origin;
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });

  const usableRenderMs = await openNativeApp(page);
  await expect(page.getByTestId("access-state")).toContainText("Sign in to open your workspace");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByTestId("primary-navigation").getByRole("link", { name: "Workspace" }))
    .toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("sign-in-button")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/PAPER_READY|FILLED|simulator-fallback/);

  const browserStorage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(JSON.stringify(browserStorage)).not.toMatch(/access.?token|refresh.?token|client.?secret|broker.?key/i);
  expect(externalRequests).toEqual([]);
  await attachNavigationSample(page, testInfo, usableRenderMs);
});

test("@component command palette supports shortcut, search, keyboard selection, and Escape", async ({ page }) => {
  await openNativeApp(page);

  await page.keyboard.press("Control+k");
  const dialog = page.getByTestId("command-palette");
  const search = page.getByTestId("command-palette-search");
  await expect(dialog).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill("appearance");
  const appearanceCommand = dialog.getByRole("button", { name: "Cycle appearance" });
  await expect(appearanceCommand).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await expect(appearanceCommand).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("theme-toggle")).toHaveAccessibleName(/Appearance: Light/);

  await page.getByTestId("command-palette-trigger").click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("@component mobile navigation dialog closes accessibly and returns focus to its trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNativeApp(page);

  const toggle = page.getByTestId("mobile-nav-toggle");
  const dialog = page.getByTestId("mobile-nav-dialog");
  await toggle.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Navigation" })).toBeVisible();
  const mobileNav = dialog.getByTestId("mobile-primary-navigation");
  await expect(mobileNav.getByRole("link", { name: "Workspace" }))
    .toHaveAttribute("aria-current", "page");
  await mobileNav.getByRole("link", { name: "Workspace" }).click();
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close navigation" }).click();
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("@component appearance cycles through the persisted native theme preference", async ({ page }) => {
  await openNativeApp(page);

  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toHaveAccessibleName(/Appearance: System/);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName(/Appearance: Light/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("theme-toggle")).toHaveAccessibleName(/Appearance: Light/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
