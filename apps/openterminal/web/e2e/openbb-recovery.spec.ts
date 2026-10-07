import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const RESEARCH_ORIGIN = process.env.EQO_RESEARCH_PUBLIC_ORIGIN!;
const ARTIFACT_DIR = process.env.OPENBB_E2E_ARTIFACT_DIR ?? "/tmp/openbb-e2e-artifacts";
const STORAGE_STATE = process.env.OPENBB_E2E_STORAGE_STATE ?? join(ARTIFACT_DIR, "native-user-storage-state.json");
const DASHBOARD_URL_FILE = join(ARTIFACT_DIR, "native-dashboard-url.json");
const scenario = process.env.OPENBB_E2E_SCENARIO ?? "recovered";
const gatewayExpectedDown = process.env.OPENBB_E2E_EXPECT_GATEWAY_OFFLINE === "1";

test.use({ storageState: STORAGE_STATE });

test("openbb-recovery native workspace reflects Gateway state and reloads its three widgets", async ({ page }) => {
  const marketResponses: Array<{ path: string; url: string; status: number }> = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === RESEARCH_ORIGIN && /^\/api\/openbb\/openbb\/v1\/(stocks|bars|options)$/.test(url.pathname)) {
      marketResponses.push({ path: url.pathname, url: response.url(), status: response.status() });
    }
  });

  const { url: dashboardUrl } = JSON.parse(await readFile(DASHBOARD_URL_FILE, "utf8")) as { url: string };
  expect(new URL(dashboardUrl).origin).toBe(RESEARCH_ORIGIN);
  await page.goto(dashboardUrl);
  await expect(page.getByText("EqoBoard SIP Stock Quotes", { exact: true })).toBeVisible();
  await expect(page.getByText("EqoBoard OPRA Option Chain", { exact: true })).toBeVisible();
  await expect(page.getByText("EqoBoard SIP OHLCV", { exact: true })).toBeVisible();

  const expectedStatus = gatewayExpectedDown ? 502 : 200;
  await expect.poll(() => {
    const statuses = new Map<string, number>();
    for (const response of marketResponses) statuses.set(response.path, response.status);
    return [
      statuses.get("/api/openbb/openbb/v1/stocks"),
      statuses.get("/api/openbb/openbb/v1/bars"),
      statuses.get("/api/openbb/openbb/v1/options"),
    ];
  }, { timeout: 45_000 }).toEqual([expectedStatus, expectedStatus, expectedStatus]);

  const stock = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/openbb/v1/stocks?symbols=QQQ`);
  const bars = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/openbb/v1/bars?symbol=QQQ&timeframe=1Day&days=30&limit=500`);
  const optionsResponse = marketResponses.find((response) => response.path === "/api/openbb/openbb/v1/options");
  expect(optionsResponse, "Native dashboard did not request the options widget").toBeDefined();
  const expiration = new URL(optionsResponse!.url).searchParams.get("expiration");
  expect(expiration).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const options = await page.request.get(`${RESEARCH_ORIGIN}/api/openbb/openbb/v1/options?underlying=QQQ&expiration=${expiration}`);
  expect([stock.status(), bars.status(), options.status()]).toEqual([expectedStatus, expectedStatus, expectedStatus]);
  if (!gatewayExpectedDown) {
    expect(await stock.json()).toMatchObject([{ symbol: "QQQ", source: "unknown", source_label: "source unknown", feed: "sip" }]);
    expect(await bars.json()).toMatchObject([{ symbol: "QQQ", source: "unknown", source_label: "source unknown", feed: "sip" }]);
    expect(await options.json()).toMatchObject([{ underlying: "QQQ", source: "unknown", source_label: "source unknown", feed: "opra" }]);
    await page.screenshot({ path: join(ARTIFACT_DIR, `native-openbb-${scenario}.png`), fullPage: true });
  } else {
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toMatch(/error|failed|unavailable|bad gateway/i);
    await page.screenshot({ path: join(ARTIFACT_DIR, `native-openbb-${scenario}.png`), fullPage: true });
  }
});
