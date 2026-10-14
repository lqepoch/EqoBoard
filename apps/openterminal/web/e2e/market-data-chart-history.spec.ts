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
const PROVENANCE_ID = "fixture-provenance-v1";

type Resolution = "1m" | "5m" | "15m" | "1h" | "1d";
type AssetClass = "stock" | "etf";

function isoMinutesAgo(minutes: number): string {
  const now = Date.now();
  const rounded = Math.floor((now - minutes * 60_000) / 60_000) * 60_000;
  return new Date(rounded).toISOString();
}

function visibleRangeSpan(value: string | null): number {
  if (!value) throw new Error("Chart did not publish its visible logical range");
  const [from, to] = value.split(":").map(Number);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("Chart visible logical range is invalid");
  return to - from;
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
  assetClass = "etf",
  startsMinutesAgo,
  cursor = null,
}: {
  requestedResolution: Resolution;
  effectiveResolution?: Resolution;
  assetClass?: AssetClass;
  startsMinutesAgo: Array<{ minutes: number; close: string }>;
  cursor?: string | null;
}) {
  const oldestSafeMinute = effectiveResolution === "1d" ? 1_500 : effectiveResolution === "1h" ? 120 : effectiveResolution === "15m" ? 30 : effectiveResolution === "5m" ? 10 : 2;
  const rows = startsMinutesAgo.map(({ minutes, close }) => bar(isoMinutesAgo(Math.max(minutes, oldestSafeMinute)), effectiveResolution, close, assetClass));
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
      feed: "fixture-feed",
      source: "synthetic-chart-e2e",
      entitlement_status: "unknown",
      numeric_encoding: "decimal",
    }],
    provider: "fixture-provider",
    feed: "fixture-feed",
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

test.beforeEach(async ({ request }) => resetDownstream(request));

test("ChartWidget reads history through the BFF, pages older bars while panning at the left edge, and shows provenance", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
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
  await configureMocks(request, {
    marketBars: {
      enabled: true,
      response: marketBarsResponse({
        requestedResolution: "1m",
        startsMinutesAgo: [{ minutes: 5, close: "501.00" }, { minutes: 3, close: "502.00" }],
        cursor: CURSOR,
      }),
      responsesByCursor: {
        [CURSOR]: marketBarsResponse({
          requestedResolution: "1m",
          startsMinutesAgo: [
            { minutes: 20, close: "499.00" },
            { minutes: 5, close: "501.00" },
            { minutes: 3, close: "502.00" },
          ],
        }),
      },
    },
  });
  await widget.getByRole("button", { name: "1D", exact: true }).click();
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Resolution 1m → 1m");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Delay unknown");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Verification unknown");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Coverage partial");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Gaps 1");

  await expect.poll(async () => (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string } }) => call.query.resolution === "1m").length).toBe(1);
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
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Chart canvas is not visible");
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.65, canvasBounds.y + canvasBounds.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.9, canvasBounds.y + canvasBounds.height * 0.55, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string } }) => call.query.resolution === "1m").length).toBe(2);
  const pageCalls = (await metrics(request)).mdpMarketBars.filter((call: { query: { resolution?: string } }) => call.query.resolution === "1m");
  expect(pageCalls[1].query).toMatchObject({
    cursor: CURSOR,
    start: firstPage.query.start,
    end: firstPage.query.end,
  });
  await expect(widget.getByTestId("chart-bar-count")).toHaveText("3 bars");

  await configureMocks(request, {
    marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: "1m", startsMinutesAgo: [{ minutes: 5, close: "501.00" }] }) },
  });
  await widget.getByLabel("Chart provider mode").selectOption("alpaca_only");
  await expect.poll(async () => (await metrics(request)).mdpMarketBars.some((call: { query: { provider_mode?: string; resolution?: string } }) => call.query.provider_mode === "alpaca_only" && call.query.resolution === "1m")).toBe(true);
});

test("all chart ranges request the documented resolution through the BFF", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await configureMocks(request, {
    marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: "1d", startsMinutesAgo: [{ minutes: 20, close: "500.00" }] }) },
  });
  await page.goto(WEB_ORIGIN);
  const widget = page.getByTestId("chart-widget");
  await expect(widget.getByTestId("chart-widget-history-status")).toContainText("Provider fixture-provider");
  const mappings: Array<[string, Resolution]> = [
    ["1D", "1m"], ["5D", "5m"], ["1M", "1h"], ["6M", "1d"],
    ["YTD", "1d"], ["1Y", "1d"], ["5Y", "1d"], ["MAX", "1d"],
  ];
  for (const [range, resolution] of mappings) {
    if (range === "6M") {
      expect((await metrics(request)).mdpMarketBars.at(-1).query.resolution).toBe("1d");
      continue;
    }
    const countBefore = (await metrics(request)).mdpMarketBars.length;
    await configureMocks(request, {
      marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: resolution, assetClass: "stock", startsMinutesAgo: [{ minutes: 20, close: "500.00" }] }) },
    });
    await widget.getByRole("button", { name: range, exact: true }).click();
    await expect.poll(async () => (await metrics(request)).mdpMarketBars.length).toBeGreaterThan(countBefore);
    const latest = (await metrics(request)).mdpMarketBars.at(-1);
    expect(latest.query.resolution).toBe(resolution);
    expect(latest.query.provider_mode).toBe("auto");
    expect(latest.query.adjustment).toBe("unadjusted");
    expect(latest.query.session_scope).toBe("all");
  }
});

test("MainChartPanel shares the provider history client and does not request Futu kline bars", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  await configureMocks(request, {
    marketBars: { enabled: true, response: marketBarsResponse({ requestedResolution: "1m", assetClass: "etf", startsMinutesAgo: [{ minutes: 5, close: "501.00" }, { minutes: 3, close: "502.00" }] }) },
  });
  await page.goto(WEB_ORIGIN);
  await page.getByRole("button", { name: /pro trading/i }).click();

  const chart = page.getByTestId("main-chart-panel");
  await expect(chart.getByTestId("main-chart-history-status")).toContainText("Provider fixture-provider");
  await expect(chart.getByTestId("main-chart-history-status")).toContainText("Feed fixture-feed");
  await expect(chart.getByTestId("main-chart-history-status")).toContainText("2 bars");
  const canvas = chart.getByTestId("main-chart-canvas");
  await expect.poll(() => canvas.getAttribute("data-visible-logical-range")).not.toBeNull();
  const initialViewportSpan = visibleRangeSpan(await canvas.getAttribute("data-visible-logical-range"));
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
  const switchedViewportSpan = visibleRangeSpan(await canvas.getAttribute("data-visible-logical-range"));
  expect(switchedViewportSpan).toBeCloseTo(initialViewportSpan, 2);
  const legacyKlineRequests = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/api/futu/kline")).length);
  expect(legacyKlineRequests).toBe(0);
});
