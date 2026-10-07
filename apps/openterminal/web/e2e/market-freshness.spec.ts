import { configureMocks, loginWithOidc, metrics, resetDownstream, test, expect } from "./fixtures";

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

test("a connected silent SSE feed ages LIVE out without a new market event", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const snapshotTime = new Date(Date.now() - 60_000).toISOString();
  const quote = {
    symbol: "QQQ",
    name: "Invesco QQQ Trust",
    price: 100,
    change: 1,
    changePercent: 1,
    open: 99,
    high: 100,
    low: 99,
    previousClose: 99,
    bid: 99.99,
    ask: 100.01,
    volume: 100_000,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: "NASDAQ",
    marketState: null,
    source: "mock-fixture/SIP",
    asOf: snapshotTime,
    quoteAt: snapshotTime,
    tradeAt: snapshotTime,
    dailyBarAt: snapshotTime,
    previousDailyBarAt: snapshotTime,
    lastAsOf: snapshotTime,
    lastBasis: "trade",
    watermarks: [],
  };
  await configureMocks(request, { quotes: [quote], sseEvents: [] });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const quotePanel = page.locator(".terminal-panel").filter({ hasText: "Invesco QQQ Trust" });
  await expect(quotePanel).toContainText("Browser SSE connected", { timeout: 8_000 });

  const eventTime = new Date().toISOString();
  const freshUntil = new Date(Date.now() + 15_000).toISOString();
  await configureMocks(request, {
    sseEvents: [
      {
        kind: "feed_status",
        feed: "stocks",
        market_session: "unknown",
        transport: "connected",
        auth: "authenticated",
        desired: { quotes: ["QQQ"], trades: ["QQQ"] },
        confirmed: { quotes: ["QQQ"], trades: ["QQQ"] },
        pending: { subscribe: { quotes: [], trades: [] }, unsubscribe: { quotes: [], trades: [] } },
        upstream: "ready",
        coverage: { desired_count: 1, confirmed_count: 1, limit: null, complete: true },
        connection_epoch: 13,
        local_sequence: 1,
        received_at: eventTime,
        last_error: null,
        decode_error_count: 0,
        freshness: { "QQQ:trade": { state: "fresh", as_of: eventTime, age_ms: 0, fresh_until: freshUntil } },
      },
      {
        kind: "stock_trade",
        symbol: "QQQ",
        price: 101,
        size: 10,
        event_time: eventTime,
        received_at: eventTime,
        connection_epoch: 13,
        local_sequence: 2,
      },
    ],
  });
  await expect(quotePanel).toContainText("PRICE FRESH · LIVE", { timeout: 8_000 });
  await expect(page.getByTestId("configured-market-feeds")).toContainText("Configured feeds: SIP / OPRA · entitlement unverified");
  const sessionStatus = page.getByTestId("market-session-status");
  await expect(sessionStatus).toContainText("Trading day/session: unknown");
  await expect(sessionStatus).toContainText(/weekday-hours estimate: (within|outside)/);
  await expect(quotePanel).toContainText("PRICE STALE", { timeout: 22_000 });
  await expect(quotePanel).toContainText("Browser SSE connected");
  await expect(sessionStatus).toContainText("Trading day/session: unknown");
  await expect(sessionStatus).not.toContainText(/closed/i);
  expect((await metrics(request)).gateway.streamOpened).toBeGreaterThan(0);
});
