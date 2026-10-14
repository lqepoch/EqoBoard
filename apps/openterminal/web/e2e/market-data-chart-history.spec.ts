import type { Page } from "@playwright/test";
import {
  configureMocks,
  expect,
  loginWithOidc,
  metrics,
  resetDownstream,
  test,
  WEB_ORIGIN,
} from "./fixtures";

const SYMBOL = "QQQ";
const CURSOR = "older-page-cursor-e2e";
const OLDEST_CURSOR = "oldest-page-cursor-e2e";
const PROVENANCE_ID = "fixture-provenance-v1";
const marketBarsEnabled = process.env.E2E_MDP_MARKET_BARS_ENABLED === "true";

type Resolution = "1m" | "5m" | "15m" | "1h" | "1d";
type AssetClass = "stock" | "etf";

function captureHistoryRequests(page: Page): URL[] {
  const requests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/history/")) requests.push(url);
  });
  return requests;
}

function captureHistoryResponses(page: Page): URL[] {
  const responses: URL[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/history/")) responses.push(url);
  });
  return responses;
}

function isoMinutesAgo(minutes: number, anchorMs = Date.now()): string {
  const rounded = Math.floor((anchorMs - minutes * 60_000) / 60_000) * 60_000;
  return new Date(rounded).toISOString();
}

function visibleRangeSpan(value: string | null): number {
  if (!value) throw new Error("Chart did not publish its visible logical range");
  const [from, to] = value.split(":").map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("Chart visible logical range is invalid");
  return to - from;
}

function visibleRange(value: string | null): { from: number; to: number } {
  if (!value) throw new Error("Chart did not publish its visible logical range");
  const [from, to] = value.split(":").map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("Chart visible logical range is invalid");
  return { from, to };
}

function expectViewportPreservedAfterPrepend(before: { from: number; to: number }, after: { from: number; to: number }, prependedBars: number) {
  expect(after.from).toBeCloseTo(before.from + prependedBars, 1);
  expect(after.to).toBeCloseTo(before.to + prependedBars, 1);
  expect(after.to - after.from).toBeCloseTo(before.to - before.from, 1);
}

function bar(startUtc: string, resolution: Resolution, close: string, assetClass: AssetClass) {
  const intervalMs = resolution === "1d" ? 86_400_000 : resolution === "1h" ? 3_600_000 :
    resolution === "15m" ? 900_000 : resolution === "5m" ? 300_000 : 60_000;
  const endUtc = new Date(Date.parse(startUtc) + intervalMs).toISOString();
  const asOf = new Date().toISOString();
  const closeNumber = Number(close);
  return {
    symbol: SYMBOL,
    asset_class: assetClass,
    resolution,
    adjustment: "unadjusted",
    bar_start_utc: startUtc,
    bar_end_exclusive_utc: endUtc,
    received_at_utc: asOf,
    available_at_utc: asOf,
    open: (closeNumber - 0.1).toFixed(2),
    high: (closeNumber + 0.2).toFixed(2),
    low: (closeNumber - 0.2).toFixed(2),
    close,
    volume: "1200.00",
    provenance_id: PROVENANCE_ID,
    session_instance_id: "fixture-session-regular",
    validation_state: "validated",
  };
}

function marketBarsResponse({
  requestedResolution,
  effectiveResolution = requestedResolution,
  assetClass = "stock",
  feed = "fixture-feed",
  anchorMs = Date.now(),
  startsMinutesAgo,
  cursor = null,
}: {
  requestedResolution: Resolution;
  effectiveResolution?: Resolution;
  assetClass?: AssetClass;
  feed?: string;
  anchorMs?: number;
  startsMinutesAgo: Array<{ minutes: number; close: string }>;
  cursor?: string | null;
}) {
  const oldestSafeMinute = effectiveResolution === "1d" ? 3_000 : effectiveResolution === "1h" ? 120 : effectiveResolution === "15m" ? 30 : effectiveResolution === "5m" ? 10 : 2;
  const rows = startsMinutesAgo.map(({ minutes, close }) => bar(
    isoMinutesAgo(Math.max(minutes, oldestSafeMinute), anchorMs), effectiveResolution, close, assetClass,
  ));
  const first = rows[0];
  const last = rows[rows.length - 1];
  const fetchedAt = new Date().toISOString();
  const intervalMs = effectiveResolution === "1d" ? 86_400_000 : effectiveResolution === "1h" ? 3_600_000 :
    effectiveResolution === "15m" ? 900_000 : effectiveResolution === "5m" ? 300_000 : 60_000;
  const gapStart = first.bar_end_exclusive_utc;
  const gapEnd = new Date(Date.parse(gapStart) + intervalMs).toISOString();
  const segmentStart = first.bar_start_utc;
  const segmentEnd = new Date(Math.max(Date.parse(last.bar_end_exclusive_utc), Date.parse(gapEnd))).toISOString();
  return {
    schema_version: 1,
    requested_resolution: requestedResolution,
    effective_resolution: effectiveResolution,
    adjustment: "unadjusted",
    rows,
    coverage_status: "partial",
    segments: [{
      start_utc: segmentStart,
      end_exclusive_utc: segmentEnd,
      coverage_status: "partial",
      provenance_id: PROVENANCE_ID,
      session_instance_id: "fixture-session-regular",
    }],
    gaps: [{ start_utc: gapStart, end_exclusive_utc: gapEnd, reason_code: "source_gap" }],
    source_provenance: [{
      provenance_id: PROVENANCE_ID,
      provider: "fixture-provider",
      feed,
      source: "synthetic-chart-e2e",
      entitlement_status: "unknown",
      numeric_encoding: "decimal_token",
    }],
    provider: "fixture-provider",
    feed,
    entitlement_status: "unknown",
    as_of: last.bar_start_utc,
    fetched_at: fetchedAt,
    verified_at: null,
    cache_status: "miss",
    market_calendar_version: null,
    continuation_cursor: cursor,
    truncated: cursor !== null,
  };
}

test.beforeEach(async ({ request }) => {
  test.skip(!marketBarsEnabled,
    "requires E2E_MDP_MARKET_BARS_ENABLED=true; exercised by the dedicated enabled-mode E2E step");
  await resetDownstream(request);
});

test("ChartWidget reads history through the BFF, pages older bars while panning at the left edge, and shows provenance", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const historyRequests = captureHistoryRequests(page);
  const historyResponses = captureHistoryResponses(page);
  const initial = marketBarsResponse({ requestedResolution: "1d", assetClass: "stock", startsMinutesAgo: [{ minutes: 20, close: "500.00" }] });
  await configureMocks(request, { marketBars: { enabled: true, response: initial } });
  await page.goto(WEB_ORIGIN);

  const widget = page.getByTestId("chart-widget");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Provider fixture-provider");
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: marketBarsResponse({ requestedResolution: "1d", assetClass: "etf", startsMinutesAgo: [{ minutes: 20, close: "500.00" }] }),
    },
  });
  await widget.getByLabel("Caller-declared asset class").selectOption("etf");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Asset class etf (caller declared)");
  const intradayAnchorMs = Date.now();
  const intradayFirstPage = marketBarsResponse({
    requestedResolution: "1m",
    assetClass: "etf",
    anchorMs: intradayAnchorMs,
    startsMinutesAgo: [{ minutes: 5, close: "501.00" }, { minutes: 3, close: "502.00" }],
    cursor: CURSOR,
  });
  const intradayOlderPage = marketBarsResponse({
    requestedResolution: "1m",
    assetClass: "etf",
    anchorMs: intradayAnchorMs,
    startsMinutesAgo: [
      { minutes: 20, close: "499.00" },
      { minutes: 5, close: "501.00" },
      { minutes: 3, close: "502.00" },
    ],
  });
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: intradayFirstPage,
      responsesByCursor: { [CURSOR]: intradayOlderPage },
      delayMs: 1_500,
    },
  });
  await widget.getByRole("button", { name: "1D", exact: true }).click();
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Resolution 1m → 1m");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Delay unknown");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Verification unknown");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Coverage partial");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Gaps 1");

  await expect.poll(async () => (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string } }) => call.query.resolution === "1m").length).toBeGreaterThanOrEqual(1);
  const firstPage = (await metrics(request)).mdpMarketBars.find((call: { query: { resolution?: string } }) => call.query.resolution === "1m");
  expect(firstPage).toMatchObject({
    path: "/v1/market/bars",
    bearer_present: true,
    query: { symbol: SYMBOL, asset_class: "etf", resolution: "1m", session_scope: "all", adjustment: "unadjusted", provider_mode: "auto" },
  });
  expect(firstPage.query.cursor).toBeUndefined();
  expect(firstPage.query.start).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  expect(firstPage.query.end).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");

  const canvas = widget.getByTestId("chart-widget-canvas");
  await expect.poll(() => canvas.getAttribute("data-visible-logical-range")).not.toBeNull();
  const rangeBeforePan = visibleRange(await canvas.getAttribute("data-visible-logical-range"));
  expect(rangeBeforePan.from).toBeLessThanOrEqual(0.5);
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Chart canvas is not visible");
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.2, canvasBounds.y + canvasBounds.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.65, canvasBounds.y + canvasBounds.height * 0.55, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.some((call: { query: { cursor?: string } }) => call.query.cursor === CURSOR), {
    intervals: [50, 100, 250],
    timeout: 5_000,
  }).toBe(true);
  await expect.poll(() => historyResponses.some((url) => url.searchParams.get("cursor") === CURSOR), {
    intervals: [50, 100, 250],
    timeout: 750,
  }).toBe(false);
  const rangeWhileOlderPageIsPending = visibleRange(await canvas.getAttribute("data-visible-logical-range"));
  expect(rangeWhileOlderPageIsPending.from).toBeLessThanOrEqual(0.5);
  expect(visibleRangeSpan(`${rangeWhileOlderPageIsPending.from}:${rangeWhileOlderPageIsPending.to}`))
    .toBeCloseTo(visibleRangeSpan(`${rangeBeforePan.from}:${rangeBeforePan.to}`), 1);
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");
  const pageCalls = (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string } }) => call.query.resolution === "1m");
  const cursorCallIndex = pageCalls.findIndex((call: { query: { cursor?: string } }) => call.query.cursor === CURSOR);
  if (cursorCallIndex < 0) throw new Error("Continuation request was not recorded");
  const cursorCall = pageCalls[cursorCallIndex];
  const boundaryPage = pageCalls.slice(0, cursorCallIndex).filter((call: { query: { cursor?: string } }) => !call.query.cursor).at(-1);
  if (!boundaryPage) throw new Error("Continuation request has no preceding boundary page");
  expect(cursorCall.query).toMatchObject({
    cursor: CURSOR,
    start: boundaryPage.query.start,
    end: boundaryPage.query.end,
  });
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("3 bars");
  await expect.poll(async () => visibleRange(await canvas.getAttribute("data-visible-logical-range")).from)
    .toBeCloseTo(rangeWhileOlderPageIsPending.from + 1, 1);
  expectViewportPreservedAfterPrepend(
    rangeWhileOlderPageIsPending,
    visibleRange(await canvas.getAttribute("data-visible-logical-range")),
    1,
  );
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: intradayFirstPage,
      responsesByCursor: { [CURSOR]: intradayOlderPage },
      delayMs: 0,
    },
  });

  await configureMocks(request, {
    marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: "1m", assetClass: "etf", startsMinutesAgo: [{ minutes: 5, close: "501.00" }] }) },
  });
  const chartInstanceBeforeProviderSwitch = await canvas.getAttribute("data-chart-instance-generation");
  const requestCountBeforeProviderSwitch = historyRequests.length;
  await widget.getByLabel("Chart provider mode").selectOption("alpaca_only");
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.some((call: { query: { provider_mode?: string; resolution?: string } }) => call.query.provider_mode === "alpaca_only" && call.query.resolution === "1m")).toBe(true);
  await expect.poll(() => historyRequests.slice(requestCountBeforeProviderSwitch).some((url) => url.searchParams.get("provider_mode") === "alpaca_only")).toBe(true);
  expect(await canvas.getAttribute("data-chart-instance-generation")).toBe(chartInstanceBeforeProviderSwitch);
});

test("all chart ranges request the documented resolution through the BFF", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const historyRequests = captureHistoryRequests(page);
  await configureMocks(request, {
    marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: "1d", startsMinutesAgo: [{ minutes: 20, close: "500.00" }] }) },
  });
  await page.goto(WEB_ORIGIN);
  const widget = page.getByTestId("chart-widget");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Provider fixture-provider");
  await expect.poll(() => historyRequests.some((url) => url.pathname.endsWith(`/${SYMBOL}`) && url.searchParams.get("range") === "6M")).toBe(true);
  const initial = (await metrics(request)).mdpMarketBars.find((call: { query: { resolution?: string } }) => call.query.resolution === "1d");
  expect(initial?.query).toMatchObject({ resolution: "1d", provider_mode: "auto" });
  const mappings: Array<[string, Resolution]> = [
    ["1D", "1m"], ["5D", "5m"], ["1M", "1h"], ["6M", "1d"],
    ["YTD", "1d"], ["1Y", "1d"], ["5Y", "1d"], ["MAX", "1d"],
  ];
  for (const [range, resolution] of mappings) {
    if (range === "6M") {
      expect(historyRequests.some((url) => url.pathname.endsWith(`/${SYMBOL}`) && url.searchParams.get("range") === "6M")).toBe(true);
      continue;
    }
    const countBefore = (await metrics(request)).mdpMarketBars.length;
    const requestCountBefore = historyRequests.length;
    await configureMocks(request, {
      marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: resolution, assetClass: "stock", startsMinutesAgo: [{ minutes: 20, close: "500.00" }] }) },
    });
    await widget.getByRole("button", { name: range, exact: true }).click();
    await expect.poll(() => historyRequests.slice(requestCountBefore).some((url) =>
      url.pathname.endsWith(`/${SYMBOL}`) && url.searchParams.get("range") === range && url.searchParams.get("resolution") === resolution)).toBe(true);
    await expect.poll(async () => (await metrics(request)).mdpMarketBars.length).toBeGreaterThan(countBefore);
    const matchingCall = (await metrics(request)).mdpMarketBars.slice(countBefore).find((call: { query: { resolution?: string } }) => call.query.resolution === resolution);
    expect(matchingCall?.query).toMatchObject({ resolution, provider_mode: "auto", adjustment: "unadjusted", session_scope: "all" });
  }
});

test("MAX pans to a real daily cursor page and preserves unknown feed and exact decimals", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const historyRequests = captureHistoryRequests(page);
  const historyResponses = captureHistoryResponses(page);
  const anchorMs = Date.now();
  const firstPage = marketBarsResponse({
    requestedResolution: "1d",
    assetClass: "stock",
    feed: "unknown",
    anchorMs,
    startsMinutesAgo: [
      { minutes: 9_000, close: "501.123456789012345678" },
      { minutes: 6_000, close: "502.123456789012345678" },
    ],
    cursor: CURSOR,
  });
  const olderPage = marketBarsResponse({
    requestedResolution: "1d",
    assetClass: "stock",
    feed: "unknown",
    anchorMs,
    startsMinutesAgo: [
      { minutes: 12_000, close: "499.00" },
      { minutes: 9_000, close: "498.00" },
      { minutes: 6_000, close: "497.00" },
    ],
  });
  await configureMocks(request, {
    marketBars: { enabled: true, response: firstPage, responsesByCursor: { [CURSOR]: olderPage } },
  });
  await page.goto(WEB_ORIGIN);

  const widget = page.getByTestId("chart-widget");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Provider fixture-provider");
  const beforeMaxCount = (await metrics(request)).mdpMarketBars.length;
  await widget.getByRole("button", { name: "MAX", exact: true }).click();
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Resolution 1d → 1d");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Feed unknown");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Coverage partial");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Gaps 1");
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");
  await expect(widget.getByText("502.123456789012345678", { exact: true })).toBeVisible();
  await configureMocks(request, {
    marketBars: { enabled: true, response: firstPage, responsesByCursor: { [CURSOR]: olderPage }, delayMs: 1_500 },
  });
  await widget.getByText("Coverage, gaps and provenance detail").click();
  await expect(widget.locator("details pre")).toContainText("source_gap");

  await expect.poll(() => historyRequests.some((url) => url.pathname.endsWith(`/${SYMBOL}`) && url.searchParams.get("range") === "MAX")).toBe(true);
  const initialCall = (await metrics(request)).mdpMarketBars.slice(beforeMaxCount).find((call: { query: { resolution?: string; cursor?: string } }) => call.query.resolution === "1d" && !call.query.cursor);
  if (!initialCall) throw new Error("MAX history request was not recorded");
  expect(initialCall.query).toMatchObject({ resolution: "1d" });
  expect(initialCall.query.cursor).toBeUndefined();
  expect(initialCall.query.start).toBe("1970-01-01T00:00:00.000Z");
  expect(initialCall.query.end).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

  const canvas = widget.getByTestId("chart-widget-canvas");
  await expect.poll(() => canvas.getAttribute("data-visible-logical-range")).not.toBeNull();
  const beforeMaxPan = visibleRange(await canvas.getAttribute("data-visible-logical-range"));
  expect(beforeMaxPan.from).toBeLessThanOrEqual(0.5);
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Chart canvas is not visible");
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.2, canvasBounds.y + canvasBounds.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.65, canvasBounds.y + canvasBounds.height * 0.55, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.some((call: { query: { start?: string; cursor?: string } }) =>
    call.query.start === initialCall.query.start && call.query.cursor === CURSOR)).toBe(true);
  await expect.poll(() => historyResponses.some((url) => url.searchParams.get("cursor") === CURSOR), {
    intervals: [50, 100, 250],
    timeout: 750,
  }).toBe(false);
  const rangeWhileOlderPageIsPending = visibleRange(await canvas.getAttribute("data-visible-logical-range"));
  expect(rangeWhileOlderPageIsPending.from).toBeLessThanOrEqual(0.5);
  expect(visibleRangeSpan(`${rangeWhileOlderPageIsPending.from}:${rangeWhileOlderPageIsPending.to}`))
    .toBeCloseTo(visibleRangeSpan(`${beforeMaxPan.from}:${beforeMaxPan.to}`), 1);
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");
  await configureMocks(request, {
    marketBars: { enabled: true, response: firstPage, responsesByCursor: { [CURSOR]: olderPage }, delayMs: 0 },
  });
  const calls = (await metrics(request)).mdpMarketBars.filter((call: { query: { start?: string } }) => call.query.start === initialCall.query.start);
  const cursorIndex = calls.findIndex((call: { query: { cursor?: string } }) => call.query.cursor === CURSOR);
  const cursorCall = calls[cursorIndex];
  if (cursorIndex <= 0 || !cursorCall) throw new Error("MAX continuation request was not recorded after its first page");
  expect(cursorCall.query).toMatchObject({
    cursor: CURSOR,
    start: initialCall.query.start,
    end: initialCall.query.end,
  });
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("3 bars");
  await expect(widget.getByText("502.123456789012345678", { exact: true })).toBeVisible();
  await expect.poll(async () => visibleRange(await canvas.getAttribute("data-visible-logical-range")).from)
    .toBeCloseTo(rangeWhileOlderPageIsPending.from + 1, 1);
  expectViewportPreservedAfterPrepend(
    rangeWhileOlderPageIsPending,
    visibleRange(await canvas.getAttribute("data-visible-logical-range")),
    1,
  );
  await configureMocks(request, {
    marketBars: { enabled: true, response: firstPage, responsesByCursor: { [CURSOR]: olderPage }, delayMs: 0 },
  });
});

test("1D automatic polling refreshes only the latest page without following its older cursor", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const historyRequests = captureHistoryRequests(page);
  const historyResponses = captureHistoryResponses(page);
  const anchorMs = Date.now();
  const initialDaily = marketBarsResponse({ requestedResolution: "1d", startsMinutesAgo: [{ minutes: 6_000, close: "500.00" }] });
  await configureMocks(request, { marketBars: { enabled: true, response: initialDaily } });
  await page.goto(WEB_ORIGIN);
  const widget = page.getByTestId("chart-widget");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Provider fixture-provider");

  const initialIntraday = marketBarsResponse({
    requestedResolution: "1m",
    anchorMs,
    startsMinutesAgo: [{ minutes: 5, close: "501.00" }, { minutes: 3, close: "502.00" }],
    cursor: CURSOR,
  });
  await configureMocks(request, { marketBars: { enabled: true, response: initialIntraday } });
  const responseStart = historyResponses.length;
  const requestStart = historyRequests.length;
  await widget.getByRole("button", { name: "1D", exact: true }).click();
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Resolution 1m → 1m");
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string } }) =>
    call.query.resolution === "1m").length).toBe(1);
  const canvas = widget.getByTestId("chart-widget-canvas");
  await expect.poll(() => canvas.getAttribute("data-visible-logical-range")).not.toBeNull();
  const rangeBeforeRefresh = visibleRange(await canvas.getAttribute("data-visible-logical-range"));

  const refreshedIntraday = marketBarsResponse({
    requestedResolution: "1m",
    anchorMs,
    startsMinutesAgo: [{ minutes: 5, close: "511.00" }, { minutes: 3, close: "512.00" }],
    cursor: CURSOR,
  });
  await configureMocks(request, { marketBars: { enabled: true, response: refreshedIntraday, delayMs: 0 } });
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string; cursor?: string } }) =>
    call.query.resolution === "1m" && !call.query.cursor).length, { timeout: 15_000 }).toBe(2);
  const rangeAfterRefresh = visibleRange(await canvas.getAttribute("data-visible-logical-range"));
  expect(rangeAfterRefresh.from).toBeCloseTo(rangeBeforeRefresh.from, 1);
  expect(rangeAfterRefresh.to).toBeCloseTo(rangeBeforeRefresh.to, 1);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Chart canvas is not visible");
  await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.55);
  await expect(widget.getByText("512.00", { exact: true })).toBeVisible();

  const intradayCalls = (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string } }) => call.query.resolution === "1m");
  expect(intradayCalls.filter((call: { query: { cursor?: string } }) => Boolean(call.query.cursor))).toHaveLength(0);
  const refreshedRequests = historyRequests.slice(requestStart).filter((url) => url.searchParams.get("range") === "1D");
  expect(refreshedRequests.filter((url) => !url.searchParams.has("cursor"))).toHaveLength(2);
  expect(refreshedRequests.filter((url) => url.searchParams.has("cursor"))).toHaveLength(0);
  expect(historyResponses.slice(responseStart).some((url) => url.searchParams.get("range") === "1D" && !url.searchParams.has("cursor"))).toBe(true);
});

test("MAX pagination stops at the bounded page limit and reports incomplete history", async ({ page, request }) => {
  const pageLimit = 20;
  const cursorPageLimit = pageLimit - 1;
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const anchorMs = Date.now();
  const pageCursor = (pageNumber: number) => `max-page-cursor-${pageNumber}`;
  const responsesByCursor: Record<string, ReturnType<typeof marketBarsResponse>> = {};
  for (let pageNumber = 1; pageNumber < cursorPageLimit; pageNumber += 1) {
    responsesByCursor[pageCursor(pageNumber)] = marketBarsResponse({
      requestedResolution: "1d",
      anchorMs,
      startsMinutesAgo: [{ minutes: 3_000 + pageNumber * 1_440, close: `${500 + pageNumber}.00` }],
      cursor: pageCursor(pageNumber + 1),
    });
  }
  const firstPage = marketBarsResponse({
    requestedResolution: "1d",
    anchorMs,
    startsMinutesAgo: [{ minutes: 3_000, close: "500.00" }],
    cursor: pageCursor(1),
  });
  await configureMocks(request, { marketBars: { enabled: true, response: firstPage, responsesByCursor } });
  await page.goto(WEB_ORIGIN);
  const widget = page.getByTestId("chart-widget");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Provider fixture-provider");
  await widget.getByRole("button", { name: "MAX", exact: true }).click();
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Resolution 1d → 1d");
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("1 bars");
  const maxStart = "1970-01-01T00:00:00.000Z";

  for (let loadedPageCount = 2; loadedPageCount <= cursorPageLimit; loadedPageCount += 1) {
    await widget.getByTestId("chart-load-older").click();
    const expectedCursorCalls = loadedPageCount - 1;
    await expect.poll(async () => (await metrics(request)).mdpMarketBars.filter((call: { query: { start?: string; cursor?: string } }) =>
      call.query.start === maxStart && Boolean(call.query.cursor)).length).toBe(expectedCursorCalls);
    await expect(widget.getByTestId("chart-bar-count")).toHaveText(`${loadedPageCount} bars`);
  }

  await expect(widget.getByTestId("chart-history-page-limit")).toContainText("MAX history is incomplete");
  await expect(widget.getByTestId("chart-history-page-limit")).toContainText("20-page limit");
  await expect(widget.getByTestId("chart-load-older")).toHaveCount(0);
  expect((await metrics(request)).mdpMarketBars.filter((call: { query: { start?: string; cursor?: string } }) =>
    call.query.start === maxStart && Boolean(call.query.cursor))).toHaveLength(cursorPageLimit - 1);
});

test("a delayed older page cannot overwrite a newer 1D refresh and can be retried", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const historyResponses = captureHistoryResponses(page);
  const anchorMs = Date.now();
  const initialDaily = marketBarsResponse({ requestedResolution: "1d", startsMinutesAgo: [{ minutes: 6_000, close: "500.00" }] });
  await configureMocks(request, { marketBars: { enabled: true, response: initialDaily } });
  await page.goto(WEB_ORIGIN);
  const widget = page.getByTestId("chart-widget");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Provider fixture-provider");

  const initialIntraday = marketBarsResponse({
    requestedResolution: "1m",
    anchorMs,
    startsMinutesAgo: [{ minutes: 5, close: "501.00" }, { minutes: 3, close: "502.00" }],
    cursor: CURSOR,
  });
  const delayedOlderPage = marketBarsResponse({
    requestedResolution: "1m",
    anchorMs,
    startsMinutesAgo: [
      { minutes: 20, close: "499.00" },
      { minutes: 5, close: "498.00" },
      { minutes: 3, close: "497.00" },
    ],
    cursor: OLDEST_CURSOR,
  });
  const oldestPage = marketBarsResponse({
    requestedResolution: "1m",
    anchorMs,
    startsMinutesAgo: [{ minutes: 30, close: "490.00" }, { minutes: 20, close: "491.00" }],
  });
  await configureMocks(request, { marketBars: { enabled: true, response: initialIntraday } });
  await widget.getByRole("button", { name: "1D", exact: true }).click();
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Resolution 1m → 1m");
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("2 bars");

  const metricsBeforeRace = await metrics(request);
  const raceStart = metricsBeforeRace.mdpMarketBars.length;
  const authorizedBeforeRace = metricsBeforeRace.mdp.authorized;
  const raceResponseStart = historyResponses.length;
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: initialIntraday,
      responsesByCursor: { [CURSOR]: delayedOlderPage },
      // Keep the cursor pending across more than one head-refresh tick so the race does not depend on gesture timing.
      delayMs: 18_000,
    },
  });
  const canvas = widget.getByTestId("chart-widget-canvas");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Chart canvas is not visible");
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.2, canvasBounds.y + canvasBounds.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.65, canvasBounds.y + canvasBounds.height * 0.55, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.some((call: { query: { resolution?: string; cursor?: string } }) =>
    call.query.resolution === "1m" && call.query.cursor === CURSOR)).toBe(true);
  await expect.poll(async () => {
    const state = await metrics(request);
    const delayedCursorCall = state.mdpMarketBars.find((call: { query: { resolution?: string; cursor?: string }; gateway_delegation?: unknown }) =>
      call.query.resolution === "1m" && call.query.cursor === CURSOR);
    return state.mdp.authorized > authorizedBeforeRace && state.mdp.inFlight > 0 &&
      delayedCursorCall?.gateway_delegation !== undefined;
  }).toBe(true);

  const refreshedIntraday = marketBarsResponse({
    requestedResolution: "1m",
    anchorMs,
    startsMinutesAgo: [{ minutes: 5, close: "511.00" }, { minutes: 3, close: "512.00" }],
    cursor: CURSOR,
  });
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: refreshedIntraday,
      responsesByCursor: { [CURSOR]: delayedOlderPage },
      delayMs: 0,
    },
  });
  await expect.poll(async () => {
    const calls = (await metrics(request)).mdpMarketBars.slice(raceStart);
    const cursorIndex = calls.findIndex((call: { query: { resolution?: string; cursor?: string } }) =>
      call.query.resolution === "1m" && call.query.cursor === CURSOR);
    const refreshIndex = calls.findIndex((call: { query: { resolution?: string; cursor?: string } }, index: number) =>
      index > cursorIndex && call.query.resolution === "1m" && !call.query.cursor);
    return cursorIndex >= 0 && refreshIndex > cursorIndex;
  }, { timeout: 12_000 }).toBe(true);
  await expect(widget.getByText("512.00", { exact: true })).toBeVisible();

  await expect.poll(() => historyResponses.slice(raceResponseStart).some((url) =>
    url.searchParams.get("range") === "1D" && url.searchParams.get("cursor") === CURSOR), { timeout: 20_000 }).toBe(true);
  const raceCalls = (await metrics(request)).mdpMarketBars.slice(raceStart)
    .filter((call: { query: { resolution?: string } }) => call.query.resolution === "1m");
  expect(raceCalls.length).toBeLessThanOrEqual(4);
  expect(raceCalls.filter((call: { query: { cursor?: string } }) => call.query.cursor === CURSOR)).toHaveLength(1);
  expect(raceCalls.some((call: { query: { cursor?: string } }) => !call.query.cursor)).toBe(true);
  const countAfterRefresh = Number((await widget.getByTestId("chart-bar-count").textContent())?.match(/^(\d+) bars$/)?.[1]);
  expect([2, 3]).toContain(countAfterRefresh);
  await expect(widget.getByText("512.00", { exact: true })).toBeVisible();

  const responsesAfterRace = historyResponses.slice(raceResponseStart)
    .filter((url) => url.searchParams.get("range") === "1D");
  const refreshResponseIndex = responsesAfterRace.findIndex((url) => !url.searchParams.has("cursor"));
  const delayedCursorResponseIndex = responsesAfterRace.findIndex((url) => url.searchParams.get("cursor") === CURSOR);
  expect(refreshResponseIndex).toBeGreaterThanOrEqual(0);
  expect(delayedCursorResponseIndex).toBeGreaterThan(refreshResponseIndex);

  await configureMocks(request, {
    marketBars: {
      enabled: true,
      status: 503,
      response: refreshedIntraday,
      responsesByCursor: { [CURSOR]: oldestPage, [OLDEST_CURSOR]: oldestPage },
      delayMs: 0,
    },
  });
  const cursorCallCount = (await metrics(request)).mdpMarketBars.filter((call: { query: { cursor?: string } }) =>
    call.query.cursor === CURSOR || call.query.cursor === OLDEST_CURSOR).length;
  await widget.getByTestId("chart-load-older").click();
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.filter((call: { query: { cursor?: string } }) =>
    call.query.cursor === CURSOR || call.query.cursor === OLDEST_CURSOR).length).toBeGreaterThan(cursorCallCount);
  await expect(widget.getByTestId("chart-history-error")).toBeVisible();
  await expect(widget.getByTestId("chart-bar-count")).toHaveText(`${countAfterRefresh} bars`);
  await expect(widget.getByText("512.00", { exact: true })).toBeVisible();

  await configureMocks(request, {
    marketBars: {
      enabled: true,
      status: 200,
      response: refreshedIntraday,
      responsesByCursor: { [CURSOR]: oldestPage, [OLDEST_CURSOR]: oldestPage },
      delayMs: 0,
    },
  });
  await widget.getByTestId("chart-load-older").click();
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("4 bars");
  await expect(widget.getByText("512.00", { exact: true })).toBeVisible();
});

test("MainChartPanel shares the provider history client and does not request Futu kline bars", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const anchorMs = Date.now();
  await configureMocks(request, {
    marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: "1m", assetClass: "etf", anchorMs, startsMinutesAgo: [{ minutes: 5, close: "501.00" }, { minutes: 3, close: "502.00" }] }) },
  });
  await page.goto(WEB_ORIGIN);
  await page.getByRole("button", { name: /pro trading/i }).click();

  const chart = page.getByTestId("main-chart-panel");
  await expect(chart.getByTestId("main-chart-history-status")).toContainText("Provider fixture-provider");
  await expect(chart.getByTestId("main-chart-history-status")).toContainText("Feed fixture-feed");
  await expect(chart.getByTestId("main-chart-history-status")).toContainText("2 bars");
  const canvas = chart.getByTestId("main-chart-canvas");
  await expect.poll(() => canvas.getAttribute("data-visible-logical-range")).not.toBeNull();
  const initialVisibleRange = visibleRange(await canvas.getAttribute("data-visible-logical-range"));
  const initialViewportSpan = visibleRangeSpan(await canvas.getAttribute("data-visible-logical-range"));
  const chartInstanceBeforeProviderSwitch = await canvas.getAttribute("data-chart-instance-generation");
  const call = (await metrics(request)).mdpMarketBars.at(-1);
  expect(call).toMatchObject({
    path: "/v1/market/bars",
    bearer_present: true,
    query: { symbol: SYMBOL, asset_class: "etf", resolution: "1m", provider_mode: "auto", adjustment: "unadjusted", session_scope: "all" },
  });

  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: marketBarsResponse({
        requestedResolution: "1m",
        assetClass: "etf",
        anchorMs,
        startsMinutesAgo: [
          { minutes: 12, close: "499.00" },
          { minutes: 10, close: "500.00" },
          { minutes: 5, close: "501.00" },
          { minutes: 3, close: "502.00" },
        ],
      }),
    },
  });
  await chart.getByLabel("Main chart provider mode").selectOption("futu_only");
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.some((entry: { query: { provider_mode?: string } }) => entry.query.provider_mode === "futu_only")).toBe(true);
  await expect(chart.getByTestId("main-chart-history-status")).toContainText("4 bars");
  expect(await canvas.getAttribute("data-chart-instance-generation")).toBe(chartInstanceBeforeProviderSwitch);
  const switchedVisibleRange = visibleRange(await canvas.getAttribute("data-visible-logical-range"));
  const switchedViewportSpan = visibleRangeSpan(await canvas.getAttribute("data-visible-logical-range"));
  expect(switchedViewportSpan).toBeCloseTo(initialViewportSpan, 2);
  expect(switchedVisibleRange.from).toBeCloseTo(initialVisibleRange.from + 2, 1);
  expect(switchedVisibleRange.to).toBeCloseTo(initialVisibleRange.to + 2, 1);
  const legacyKlineRequests = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/api/futu/kline")).length);
  expect(legacyKlineRequests).toBe(0);
});
