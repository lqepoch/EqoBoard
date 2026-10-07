import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { captureJsonResponses, type CapturedResponse } from "./openbb-response-capture";

const RESEARCH_ORIGIN = process.env.EQO_RESEARCH_PUBLIC_ORIGIN!;
const ARTIFACT_DIR = process.env.OPENBB_E2E_ARTIFACT_DIR ?? "/tmp/openbb-e2e-artifacts";
const STORAGE_STATE = process.env.OPENBB_E2E_STORAGE_STATE ?? join(ARTIFACT_DIR, "native-user-storage-state.json");
const DASHBOARD_URL_FILE = join(ARTIFACT_DIR, "native-dashboard-url.json");
const scenario = process.env.OPENBB_E2E_SCENARIO ?? "recovered";
const gatewayExpectedDown = process.env.OPENBB_E2E_EXPECT_GATEWAY_OFFLINE === "1";

test.use({ storageState: STORAGE_STATE });

function rowsFor(response: CapturedResponse | undefined, path: string) {
  expect(response, `Native browser did not receive non-empty rows from ${path}`).toBeDefined();
  expect(Array.isArray(response?.body) && response.body.length > 0, `Native browser did not receive non-empty rows from ${path}`).toBe(true);
  return response!.body as Record<string, unknown>[];
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
        Array.from(root.querySelectorAll<HTMLElement>(".ag-header-cell"))
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
        throw new Error(`Native AG Grid target column is not rendered: ${columnIds.join(", ")}`);
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

  throw new Error(`Native AG Grid columns were not visible: ${columnIds.join(", ")}`);
}

function numericValueIsRendered(values: unknown[], text: string) {
  const rendered = Number(text.replace(/[,$]/g, "").trim());
  return Number.isFinite(rendered) && values.some((value) => typeof value === "number" && value === rendered);
}

test("openbb-recovery native workspace reflects Gateway state and restores all three widget grids", async ({ page }) => {
  const marketResponses = captureJsonResponses(page, RESEARCH_ORIGIN, (_response, path) =>
    /^\/api\/openbb\/openbb\/v1\/(stocks|bars|options)$/.test(path),
  );

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
    marketResponses.responses.some((response) => response.pathname === path && response.status === expectedStatus),
  ), { timeout: 45_000 }).toEqual([true, true, true]);
  for (const route of routes) {
    await expect.poll(async () => {
      const response = await marketResponses.latestSettled(
        (item) => item.pathname === route && item.status === expectedStatus,
      );
      if (expectedStatus === 200) return Array.isArray(response?.body) && response.body.length > 0;
      return typeof response?.body === "object" && response.body !== null;
    }, { timeout: 30_000, message: `Latest completed native response for ${route} did not have the expected JSON shape` }).toBe(true);
  }
  await marketResponses.settle();

  if (gatewayExpectedDown) {
    for (const widget of [stocksWidget, barsWidget, optionsWidget]) {
      await expect(widget.getByTestId("results-not-found")).toContainText(/status code 502/i);
      await expect(widget.getByRole("gridcell")).toHaveCount(0);
    }
    await page.screenshot({ path: join(ARTIFACT_DIR, `native-openbb-${scenario}.png`), fullPage: true });
    return;
  }

  const stockRows = rowsFor(await marketResponses.latestSettled((item) => item.pathname === routes[0] && item.status === 200), routes[0]);
  const barsRows = rowsFor(await marketResponses.latestSettled((item) => item.pathname === routes[1] && item.status === 200), routes[1]);
  const optionRows = rowsFor(await marketResponses.latestSettled((item) => item.pathname === routes[2] && item.status === 200), routes[2]);
  const stock = stockRows.find((row) => row.symbol === "QQQ");
  const bar = barsRows[0];
  const option = optionRows.find((row) => row.underlying === "QQQ");
  expect(stock).toMatchObject({ symbol: "QQQ", source: "unknown", source_label: "source unknown", feed: "sip" });
  expect(bar).toMatchObject({ symbol: "QQQ", source: "unknown", source_label: "source unknown", feed: "sip" });
  expect(option).toMatchObject({ underlying: "QQQ", source: "unknown", source_label: "source unknown", feed: "opra" });
  expect(option?.symbol).toMatch(/^QQQ\d{6}[CP]\d{8}$/);

  const stockSymbols = stocksWidget.locator('.ag-cell[col-id="symbol"]');
  await expect.poll(async () => (await stockSymbols.allTextContents()).some((text) => text.trim() === "QQQ")).toBe(true);
  for (const field of ["open", "high", "low", "close", "volume"] as const) {
    await revealGridColumns(page, barsWidget, [field]);
    await expect(barsWidget.locator(`.ag-header-cell[col-id="${field}"]`)).toBeVisible();
    const visibleCells = barsWidget.locator(`.ag-cell[col-id="${field}"]`).filter({ visible: true });
    await expect.poll(async () => {
      const rendered = await visibleCells.allTextContents();
      return rendered.some((text) => numericValueIsRendered(barsRows.map((row) => row[field]), text));
    }, { message: `Native OHLCV grid did not render a response-backed ${field} value` }).toBe(true);
  }
  const optionSymbols = optionsWidget.locator('.ag-cell[col-id="symbol"]');
  await expect.poll(async () =>
    (await optionSymbols.allTextContents()).some((text) => text.trim() === option!.symbol),
  ).toBe(true);
  await expect(stocksWidget.getByRole("gridcell")).not.toHaveCount(0);
  await expect(barsWidget.getByRole("gridcell")).not.toHaveCount(0);
  await expect(optionsWidget.getByRole("gridcell")).not.toHaveCount(0);
  await page.screenshot({ path: join(ARTIFACT_DIR, `native-openbb-${scenario}.png`), fullPage: true });
});
