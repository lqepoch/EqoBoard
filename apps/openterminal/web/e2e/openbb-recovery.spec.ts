import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const RESEARCH_ORIGIN = process.env.EQO_RESEARCH_PUBLIC_ORIGIN!;
const ARTIFACT_DIR = process.env.OPENBB_E2E_ARTIFACT_DIR ?? "/tmp/openbb-e2e-artifacts";
const STORAGE_STATE = process.env.OPENBB_E2E_STORAGE_STATE ?? join(ARTIFACT_DIR, "native-user-storage-state.json");
const DASHBOARD_URL_FILE = join(ARTIFACT_DIR, "native-dashboard-url.json");
const scenario = process.env.OPENBB_E2E_SCENARIO ?? "recovered";
const gatewayExpectedDown = process.env.OPENBB_E2E_EXPECT_GATEWAY_OFFLINE === "1";

type CapturedMarketResponse = { path: string; url: string; status: number; body?: unknown };

test.use({ storageState: STORAGE_STATE });

function rowsFor(responses: CapturedMarketResponse[], path: string) {
  const response = [...responses].reverse().find((item) =>
    item.path === path && item.status === 200 && Array.isArray(item.body) && item.body.length > 0,
  );
  expect(response, `Native browser did not receive non-empty rows from ${path}`).toBeDefined();
  return response!.body as Record<string, unknown>[];
}

async function revealGridColumns(page: Page, widget: Locator, columnIds: string[]) {
  const viewport = widget.locator(".ag-body-horizontal-scroll-viewport");
  await expect(viewport).toBeVisible();
  const headers = columnIds.map((columnId) =>
    widget.locator(`.ag-header-cell[col-id="${columnId}"]`).first(),
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const viewportBox = await viewport.boundingBox();
    if (!viewportBox) throw new Error("Native AG Grid horizontal viewport is not rendered");
    const headerBoxes = await Promise.all(headers.map((header) => header.boundingBox()));
    if (headerBoxes.every((box) => box !== null)) {
      const visibleLeft = viewportBox.x;
      const visibleRight = viewportBox.x + viewportBox.width;
      const targetLeft = Math.min(...headerBoxes.map((box) => box!.x));
      const targetRight = Math.max(...headerBoxes.map((box) => box!.x + box!.width));
      const delta = targetLeft < visibleLeft
        ? targetLeft - visibleLeft
        : targetRight > visibleRight
          ? targetRight - visibleRight
          : 0;
      if (delta === 0) return;
      await viewport.evaluate((element, offset) => {
        (element as HTMLElement).scrollLeft += offset;
      }, delta);
    } else {
      await viewport.evaluate((element) => {
        const horizontalViewport = element as HTMLElement;
        horizontalViewport.scrollLeft += Math.max(100, horizontalViewport.clientWidth * 0.6);
      });
    }
    await page.waitForTimeout(50);
  }

  throw new Error(`Native AG Grid columns were not visible: ${columnIds.join(", ")}`);
}

function numericValueIsRendered(values: unknown[], text: string) {
  const rendered = Number(text.replaceAll(",", "").trim());
  return Number.isFinite(rendered) && values.some((value) => typeof value === "number" && value === rendered);
}

test("openbb-recovery native workspace reflects Gateway state and restores all three widget grids", async ({ page }) => {
  const marketResponses: CapturedMarketResponse[] = [];
  const pendingResponses: Promise<void>[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== RESEARCH_ORIGIN || !/^\/api\/openbb\/openbb\/v1\/(stocks|bars|options)$/.test(url.pathname)) return;
    const captured: CapturedMarketResponse = {
      path: url.pathname,
      url: response.url(),
      status: response.status(),
    };
    marketResponses.push(captured);
    pendingResponses.push((async () => {
      try {
        captured.body = await response.json();
      } catch {
        captured.body = undefined;
      }
    })());
  });

  const { url: dashboardUrl } = JSON.parse(await readFile(DASHBOARD_URL_FILE, "utf8")) as { url: string };
  expect(new URL(dashboardUrl).origin).toBe(RESEARCH_ORIGIN);
  await page.goto(dashboardUrl);
  await expect(page).toHaveTitle(/^仅演示 \/ MOCK SIP\/OPRA \| OpenBB Lite$/);

  const stocksWidget = page.locator(".react-grid-item").filter({
    has: page.getByText("EqoBoard SIP Stock Quotes", { exact: true }),
  });
  const barsWidget = page.locator(".react-grid-item").filter({
    has: page.getByText("EqoBoard SIP OHLCV", { exact: true }),
  });
  const optionsWidget = page.locator(".react-grid-item").filter({
    has: page.getByText("EqoBoard OPRA Option Chain", { exact: true }),
  });
  await expect(stocksWidget).toHaveCount(1);
  await expect(barsWidget).toHaveCount(1);
  await expect(optionsWidget).toHaveCount(1);

  const expectedStatus = gatewayExpectedDown ? 502 : 200;
  const routes = [
    "/api/openbb/openbb/v1/stocks",
    "/api/openbb/openbb/v1/bars",
    "/api/openbb/openbb/v1/options",
  ];
  await expect.poll(() => routes.map((path) =>
    marketResponses.some((response) => response.path === path && response.status === expectedStatus),
  ), { timeout: 45_000 }).toEqual([true, true, true]);
  await Promise.all(pendingResponses);

  if (gatewayExpectedDown) {
    for (const widget of [stocksWidget, barsWidget, optionsWidget]) {
      await expect(widget.getByTestId("results-not-found")).toContainText(/status code 502/i);
      await expect(widget.getByRole("gridcell")).toHaveCount(0);
    }
    await page.screenshot({ path: join(ARTIFACT_DIR, `native-openbb-${scenario}.png`), fullPage: true });
    return;
  }

  const stockRows = rowsFor(marketResponses, routes[0]);
  const barsRows = rowsFor(marketResponses, routes[1]);
  const optionRows = rowsFor(marketResponses, routes[2]);
  const stock = stockRows.find((row) => row.symbol === "QQQ");
  const bar = barsRows[0];
  const option = optionRows.find((row) => row.underlying === "QQQ");
  expect(stock).toMatchObject({ symbol: "QQQ", source: "unknown", source_label: "source unknown", feed: "sip" });
  expect(bar).toMatchObject({ symbol: "QQQ", source: "unknown", source_label: "source unknown", feed: "sip" });
  expect(option).toMatchObject({ underlying: "QQQ", source: "unknown", source_label: "source unknown", feed: "opra" });
  expect(option?.symbol).toMatch(/^QQQ\d{6}[CP]\d{8}$/);

  await expect(stocksWidget.locator('.ag-cell[col-id="symbol"]')).toContainText("QQQ");
  await revealGridColumns(page, barsWidget, ["open", "high", "low", "close", "volume"]);
  for (const field of ["open", "high", "low", "close", "volume"] as const) {
    const visibleCells = barsWidget.locator(`.ag-cell[col-id="${field}"]`).filter({ visible: true });
    await expect.poll(async () => {
      const rendered = await visibleCells.allTextContents();
      return rendered.some((text) => numericValueIsRendered(barsRows.map((row) => row[field]), text));
    }, { message: `Native OHLCV grid did not render a response-backed ${field} value` }).toBe(true);
  }
  await expect(optionsWidget.locator('.ag-cell[col-id="symbol"]')).toContainText(option!.symbol as string);
  await expect(stocksWidget.getByRole("gridcell")).not.toHaveCount(0);
  await expect(barsWidget.getByRole("gridcell")).not.toHaveCount(0);
  await expect(optionsWidget.getByRole("gridcell")).not.toHaveCount(0);
  await page.screenshot({ path: join(ARTIFACT_DIR, `native-openbb-${scenario}.png`), fullPage: true });
});
