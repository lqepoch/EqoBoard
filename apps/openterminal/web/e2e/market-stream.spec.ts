import { configureMocks, loginWithOidc, metrics, resetDownstream, test, expect } from "./fixtures";
import type { Route } from "@playwright/test";
import { optionPutSymbol } from "./market-test-data";

const contractSymbol = optionPutSymbol;

function feedStatus(
  localSequence: number,
  confirmed: string[] | null,
  freshnessAsOf: string | null,
  freshUntil?: string | null,
) {
  return {
    kind: "feed_status",
    feed: "options",
    transport: "connected",
    auth: "authenticated",
    desired: { quotes: [contractSymbol], trades: [contractSymbol] },
    confirmed: confirmed === null ? null : { quotes: confirmed, trades: confirmed },
    pending: {
      subscribe: { quotes: confirmed === null ? [contractSymbol] : [], trades: confirmed === null ? [contractSymbol] : [] },
      unsubscribe: { quotes: [], trades: [] },
    },
    upstream: confirmed === null ? "connecting" : "ready",
    coverage: { desired_count: 1, confirmed_count: confirmed === null ? 0 : 1, limit: null, complete: confirmed !== null },
    connection_epoch: 8,
    local_sequence: localSequence,
    received_at: new Date().toISOString(),
    last_error: null,
    decode_error_count: 0,
    freshness: freshnessAsOf === null ? {} : {
      [`${contractSymbol}:quote`]: {
        state: "fresh", as_of: freshnessAsOf, age_ms: 1_000, ...(freshUntil === undefined ? {} : { fresh_until: freshUntil }),
      },
    },
  };
}

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

test("OPRA UI waits for ACK, rejects an older tick, and keeps stable leases across widgets and tabs", async ({ page, context, request }) => {
  test.setTimeout(90_000);
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);

  const baseMs = Date.now();
  const snapshotTime = new Date(baseMs - 20_000).toISOString();
  const liveTime = new Date(baseMs).toISOString();
  const olderTime = new Date(baseMs - 1_000).toISOString();
  const contract = {
    symbol: contractSymbol,
    right: "put",
    strike: 600,
    bid: 1.25,
    ask: 1.35,
    last: 1.30,
    iv: 0.22,
    delta: -0.4,
    gamma: 0.02,
    theta: -0.01,
    vega: 0.1,
    bid_size: 4,
    ask_size: 5,
    quote_at: snapshotTime,
    trade_at: snapshotTime,
    model_as_of: null,
    feed: "opra",
  };
  await configureMocks(request, {
    optionStatus: 200,
    optionFeed: "opra",
    contracts: [contract],
    sseEvents: [feedStatus(1, null, null)],
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /OPTIONS/ }).click();
  const optionPanels = page.locator(".terminal-panel").filter({ hasText: "ALPACA OPRA QUOTES" });
  await expect(optionPanels).toHaveCount(2);
  await expect(optionPanels.first()).toContainText("SUBSCRIPTION AWAITING ACK");
  await expect(optionPanels.first()).toContainText("model as-of unknown");

  const secondTab = await context.newPage();
  await secondTab.goto("/");
  await expect(secondTab.locator(".terminal-panel").filter({ hasText: "ALPACA OPRA QUOTES" })).toHaveCount(2);
  await expect.poll(async () => {
    const seen = await metrics(request);
    return seen.gateway.subscriptions.filter((entry: { path: string; body: { symbols?: string[] } }) =>
      entry.path.endsWith("/subscriptions/options") && (entry.body.symbols?.length ?? 0) > 0).length;
  }, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

  await configureMocks(request, {
    sseEvents: [
      feedStatus(3, [contractSymbol], liveTime, new Date(Date.now() + 30_000).toISOString()),
      {
        kind: "option_quote", symbol: contractSymbol, bid: 1.5, ask: 1.6,
        bid_size: 8, ask_size: 9, event_time: liveTime,
        received_at: new Date().toISOString(), connection_epoch: 8, local_sequence: 4,
      },
    ],
  });
  const firstPanel = optionPanels.first();
  await expect(firstPanel).toContainText("FRESH · LIVE", { timeout: 8_000 });
  const bidCell = firstPanel.locator('.ag-row[row-index="0"] [col-id="put.bid"]');
  await expect(bidCell).toContainText("1.50");

  await configureMocks(request, {
    sseEvents: [
      feedStatus(6, [contractSymbol], liveTime, new Date(Date.now() + 2_000).toISOString()),
      {
        kind: "option_quote", symbol: contractSymbol, bid: 0.75, ask: 0.85,
        bid_size: 1, ask_size: 1, event_time: olderTime,
        received_at: new Date().toISOString(), connection_epoch: 8, local_sequence: 5,
      },
    ],
  });
  await expect(bidCell).toContainText("1.50", { timeout: 5_000 });
  await expect(bidCell).not.toContainText("0.75");
  await expect(bidCell).toContainText("1.25", { timeout: 8_000 });
  await expect(bidCell).not.toContainText("1.50");

  await configureMocks(request, {
    sseEvents: [{
      ...feedStatus(7, [contractSymbol], liveTime),
      auth: "failed",
      upstream: "degraded",
      last_error: { code: 403, class: "authorization", message: "OPRA access is not entitled" },
    }],
  });
  await expect(firstPanel).toContainText("UPSTREAM UNAUTHORIZED", { timeout: 5_000 });
  await expect(firstPanel).toContainText("Browser SSE connected");

  let observed = await metrics(request);
  const optionChainRequests = observed.gateway.requests["/api/v1/options/chain"] ?? 0;
  // The normal 15-second snapshot poll returns new contract objects without
  // changing membership. It must not issue an empty cleanup in either tab.
  await expect.poll(async () => {
    observed = await metrics(request);
    return observed.gateway.requests["/api/v1/options/chain"] ?? 0;
  }, { timeout: 18_000 }).toBeGreaterThan(optionChainRequests);
  let optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  expect(optionLeases.length).toBeGreaterThanOrEqual(4);
  expect(optionLeases.every((entry: { body: { symbols?: string[] } }) => (entry.body.symbols?.length ?? 0) > 0)).toBe(true);
  expect(optionLeases.every((entry: { body: { symbols?: string[] } }) =>
    entry.body.symbols?.length === 1 && entry.body.symbols[0] === contractSymbol)).toBe(true);

  const secondTabOptions = secondTab.locator(".terminal-panel").filter({ hasText: "ALPACA OPRA QUOTES" });
  await secondTabOptions.nth(0).locator(".panel-title button").last().click();
  await secondTabOptions.nth(0).locator(".panel-title button").last().click();
  await expect.poll(async () => {
    observed = await metrics(request);
    return observed.gateway.subscriptions.filter((entry: { path: string; body: { symbols?: string[] } }) =>
      entry.path.endsWith("/subscriptions/options") && (entry.body.symbols?.length ?? 0) === 0).length;
  }, { timeout: 5_000 }).toBe(2);
  optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  const firstConsumers = optionLeases.filter((entry: { body: { symbols?: string[] } }) => (entry.body.symbols?.length ?? 0) > 0);
  const releasedConsumer = optionLeases.find((entry: { body: { symbols?: string[] } }) => (entry.body.symbols?.length ?? 0) === 0)!;
  const originalLease = firstConsumers.find((entry: { body: { consumer_id: string } }) =>
    entry.body.consumer_id === releasedConsumer.body.consumer_id)!;
  expect(releasedConsumer.body.generation).toBeGreaterThan(originalLease.body.generation);

  // Reorder a real browser request at the Next BFF boundary: hold the cleanup
  // generated by an expiry change until its newer non-empty renewal has reached
  // the downstream mock, then deliver the old cleanup. This proves the client
  // sends the tombstone with a lower generation after the newer lease; the
  // mock only records requests, so server-side rejection is covered by #3 tests.
  let heldCleanup: Route | null = null;
  let heldConsumerId = "";
  let heldGeneration = 0;
  let resolveCleanupArrived!: () => void;
  const cleanupArrived = new Promise<void>((resolve) => { resolveCleanupArrived = resolve; });
  let releaseCleanup!: () => void;
  const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const holdOldCleanup = async (route: Route) => {
    const body = route.request().postDataJSON() as { consumer_id: string; generation: number; symbols: string[] };
    if (body.symbols.length === 0 && heldCleanup === null) {
      heldCleanup = route;
      heldConsumerId = body.consumer_id;
      heldGeneration = body.generation;
      resolveCleanupArrived();
      await cleanupRelease;
      await route.continue();
      return;
    }
    await route.continue();
  };
  await page.route("**/api/eqo/options/subscribe", holdOldCleanup);
  try {
    const expiryInput = firstPanel.getByRole("textbox", { name: "Option expiry" });
    const currentExpiry = new Date(`${await expiryInput.inputValue()}T12:00:00Z`);
    currentExpiry.setUTCDate(currentExpiry.getUTCDate() + 1);
    await expiryInput.fill(currentExpiry.toISOString().slice(0, 10));
    await cleanupArrived;
    await expect.poll(async () => {
      const seen = await metrics(request);
      return seen.gateway.subscriptions.some((entry: { path: string; body: { consumer_id: string; generation: number; symbols?: string[] } }) =>
        entry.path.endsWith("/subscriptions/options") && entry.body.consumer_id === heldConsumerId &&
        entry.body.generation > heldGeneration && (entry.body.symbols?.length ?? 0) > 0);
    }, { timeout: 8_000 }).toBe(true);
    releaseCleanup();
    await expect.poll(async () => {
      const seen = await metrics(request);
      const sameConsumer = seen.gateway.subscriptions.filter((entry: { path: string; body: { consumer_id: string } }) =>
        entry.path.endsWith("/subscriptions/options") && entry.body.consumer_id === heldConsumerId);
      return sameConsumer.slice(-2).map((entry: { body: { generation: number; symbols?: string[] } }) => ({
        generation: entry.body.generation,
        empty: (entry.body.symbols?.length ?? 0) === 0,
      }));
    }, { timeout: 8_000 }).toEqual([
      expect.objectContaining({ generation: expect.any(Number), empty: false }),
      { generation: heldGeneration, empty: true },
    ]);
  } finally {
    releaseCleanup();
    await page.unroute("**/api/eqo/options/subscribe", holdOldCleanup);
  }

  await firstPanel.locator(".panel-title button").last().click();
  await expect.poll(async () => {
    observed = await metrics(request);
    return observed.gateway.subscriptions.filter((entry: { path: string; body: { symbols?: string[] } }) =>
      entry.path.endsWith("/subscriptions/options") && (entry.body.symbols?.length ?? 0) === 0).length;
  }, { timeout: 5_000 }).toBe(4);
  optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  const emptyLeases = optionLeases.filter((entry: { body: { symbols?: string[] } }) => (entry.body.symbols?.length ?? 0) === 0);
  for (const cleanup of emptyLeases) {
    const previous = optionLeases.find((entry: { body: { consumer_id: string; symbols?: string[] } }) =>
      entry.body.consumer_id === cleanup.body.consumer_id && (entry.body.symbols?.length ?? 0) > 0)!;
    expect(cleanup.body.generation).toBeGreaterThan(previous.body.generation);
  }
});

test("a browser stream outage cannot pin an old U.S. tick over a newer REST SIP snapshot", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const now = Date.now();
  const snapshotTime = new Date(now - 60_000).toISOString();
  const liveTime = new Date(now).toISOString();
  const refreshedTime = new Date(now).toISOString();
  const quote = (price: number, lastAsOf: string) => ({
    symbol: "QQQ",
    name: "Invesco QQQ Trust",
    price,
    change: price - 99,
    changePercent: ((price - 99) / 99) * 100,
    open: 99,
    high: price,
    low: 99,
    previousClose: 99,
    bid: price - 0.01,
    ask: price + 0.01,
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
    asOf: lastAsOf,
    quoteAt: lastAsOf,
    tradeAt: lastAsOf,
    dailyBarAt: lastAsOf,
    previousDailyBarAt: snapshotTime,
    lastAsOf,
    lastBasis: "trade",
    watermarks: [],
  });
  await configureMocks(request, {
    quotes: [quote(100, snapshotTime)],
    sseDisconnectAfterMs: 12_000,
    sseEvents: [
      {
        kind: "feed_status",
        feed: "stocks",
        transport: "connected",
        auth: "authenticated",
        desired: { quotes: ["QQQ"], trades: ["QQQ"] },
        confirmed: { quotes: ["QQQ"], trades: ["QQQ"] },
        pending: { subscribe: { quotes: [], trades: [] }, unsubscribe: { quotes: [], trades: [] } },
        upstream: "ready",
        coverage: { desired_count: 1, confirmed_count: 1, limit: null, complete: true },
        connection_epoch: 12,
        local_sequence: 1,
        received_at: new Date(now).toISOString(),
        last_error: null,
        decode_error_count: 0,
        freshness: { "QQQ:trade": {
          state: "fresh", as_of: liveTime, age_ms: 1_000,
          fresh_until: new Date(now + 30_000).toISOString(),
        } },
      },
      {
        kind: "stock_trade",
        symbol: "QQQ",
        price: 101,
        size: 10,
        event_time: liveTime,
        received_at: new Date(now).toISOString(),
        connection_epoch: 12,
        local_sequence: 2,
      },
    ],
  });

  let streamRequests = 0;
  await page.route("**/api/eqo/live", async (route) => {
    streamRequests += 1;
    if (streamRequests > 1) return route.abort();
    return route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const quotePanel = page.locator(".terminal-panel").filter({ hasText: "Invesco QQQ Trust" });
  await expect(quotePanel).toContainText("FRESH · LIVE", { timeout: 15_000 });
  await expect(quotePanel).toContainText("101.00");

  await expect(quotePanel).toContainText("BROWSER DISCONNECTED", { timeout: 20_000 });
  await configureMocks(request, { quotes: [quote(105, refreshedTime)] });
  await expect(quotePanel).toContainText("105.00", { timeout: 22_000 });
  await expect(quotePanel).toContainText("PRICE BROWSER DISCONNECTED · REST snapshot");
  await expect(quotePanel).not.toContainText("FRESH · LIVE");
  expect(streamRequests).toBeGreaterThan(1);
  expect((await metrics(request)).gateway.requests["/api/v1/orders/submit"]).toBeUndefined();
});
