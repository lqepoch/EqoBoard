import { configureMocks, loginWithOidc, metrics, resetDownstream, test, expect, WEB_ORIGIN } from "./fixtures";
import type { BrowserContext, Route } from "@playwright/test";
import { optionPutSymbol, sipSnapshotResponse } from "./market-test-data";

const contractSymbol = optionPutSymbol;
type SessionRefreshState = {
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void> | null;
  failure?: string;
};
const sessionRefreshStates = new WeakMap<BrowserContext, SessionRefreshState>();

test.afterEach(async ({ context }) => {
  const state = sessionRefreshStates.get(context);
  if (!state) return;
  if (state.timer !== null) clearInterval(state.timer);
  if (state.inFlight) await state.inFlight;
  expect(state.failure).toBeUndefined();
  sessionRefreshStates.delete(context);
});

function feedStatus(
  localSequence: number,
  confirmed: string[] | null,
  freshnessAsOf: string | null,
  freshUntil?: string | null,
) {
  return {
    kind: "feed_status",
    gateway_instance_id: "gateway-e2e-offline-1",
    source_mode: "offline_mock",
    source_label: "OFFLINE MOCK — NOT MARKET DATA",
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

test("options subscription BFF requires a positive safe generation before forwarding", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const contextRequest = page.context().request;
  const consumerId = "e42fb3e1-cdb2-4a44-9407-5d453ae61c66";
  const symbols = [contractSymbol];
  const invalidBodies = [
    { consumer_id: consumerId, symbols },
    { consumer_id: consumerId, generation: 0, symbols },
    { consumer_id: consumerId, generation: Number.MAX_SAFE_INTEGER + 1, symbols },
  ];
  const subscriptionsBefore = (await metrics(request)).gateway.subscriptions.length;

  for (const data of invalidBodies) {
    const response = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/options/subscribe`, {
      headers: { origin: WEB_ORIGIN },
      data,
    });
    expect(response.status()).toBe(400);
  }
  expect((await metrics(request)).gateway.subscriptions).toHaveLength(subscriptionsBefore);

  const accepted = await contextRequest.post(`${WEB_ORIGIN}/api/eqo/options/subscribe`, {
    headers: { origin: WEB_ORIGIN },
    data: { consumer_id: consumerId, generation: 1, symbols },
  });
  expect(accepted.status()).toBe(200);
  const forwarded = (await metrics(request)).gateway.subscriptions.at(-1);
  expect(forwarded).toMatchObject({
    path: "/api/v1/subscriptions/options",
    body: { consumer_id: consumerId, generation: 1, symbols },
  });
});

test("OPRA UI waits for ACK, rejects an older tick, and keeps stable leases across widgets and tabs", async ({ page, context, request }) => {
  test.setTimeout(90_000);
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const refreshState: SessionRefreshState = { timer: null, inFlight: null };
  refreshState.timer = setInterval(() => {
    if (refreshState.inFlight) return;
    refreshState.inFlight = context.request.get(`${WEB_ORIGIN}/api/auth/session`, { timeout: 5_000 })
      .then(async (response) => {
        if (!response.ok()) throw new Error("session refresh rejected");
        const session = await response.json();
        if (session.user?.id !== "subject-e2e" || session.sessionExpiresAt <= Date.now() + 1_000) {
          throw new Error("session refresh did not return an active test principal");
        }
      })
      .catch(() => { refreshState.failure = "active OIDC session refresh failed"; })
      .finally(() => { refreshState.inFlight = null; });
  }, 2_000);
  sessionRefreshStates.set(context, refreshState);

  const baseMs = Date.now();
  const snapshotTime = new Date(baseMs - 20_000).toISOString();
  const contract = {
    symbol: contractSymbol,
    gateway_instance_id: "gateway-e2e-offline-1",
    source_mode: "offline_mock",
    source_label: "OFFLINE MOCK — NOT MARKET DATA",
    received_at: new Date().toISOString(),
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
  const optionPanels = page.locator(".terminal-panel").filter({ hasText: /OPRA quotes ·/ });
  await expect(optionPanels).toHaveCount(2);
  await expect(optionPanels.first()).toContainText("SUBSCRIPTION AWAITING ACK");
  await expect(optionPanels.first()).toContainText("OPRA quotes · source unknown");
  await expect(optionPanels.first()).toContainText("model as-of unknown");

  const secondTab = await context.newPage();
  await secondTab.goto("/");
  await expect(secondTab.locator(".terminal-panel").filter({ hasText: /OPRA quotes ·/ })).toHaveCount(2);
  await expect.poll(async () => {
    const seen = await metrics(request);
    return seen.gateway.subscriptions.filter((entry: { path: string; body: { symbols?: string[] } }) =>
      entry.path.endsWith("/subscriptions/options") && (entry.body.symbols?.length ?? 0) > 0).length;
  }, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

  const liveTime = new Date().toISOString();
  const olderTime = new Date(Date.parse(liveTime) - 1_000).toISOString();
  await configureMocks(request, {
    sseEvents: [
      feedStatus(3, [contractSymbol], liveTime, new Date(Date.now() + 30_000).toISOString()),
      {
        gateway_instance_id: "gateway-e2e-offline-1",
        source_mode: "offline_mock",
        source_label: "OFFLINE MOCK — NOT MARKET DATA",
        kind: "option_quote", symbol: contractSymbol, bid: 1.5, ask: 1.6,
        bid_size: 8, ask_size: 9, event_time: liveTime,
        received_at: new Date().toISOString(), connection_epoch: 8, local_sequence: 4,
      },
    ],
  });
  const firstPanel = optionPanels.first();
  await expect(firstPanel).toContainText("FRESH · OFFLINE MOCK", { timeout: 8_000 });
  const bidCell = firstPanel.locator('.ag-row[row-index="0"] [col-id="put.bid"]');
  await expect(bidCell).toContainText("1.50");

  await configureMocks(request, {
    sseEvents: [
      feedStatus(6, [contractSymbol], liveTime, new Date(Date.now() + 2_000).toISOString()),
      {
        gateway_instance_id: "gateway-e2e-offline-1",
        source_mode: "offline_mock",
        source_label: "OFFLINE MOCK — NOT MARKET DATA",
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
  let optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  const emptyCleanupCountBeforeSnapshotPoll = optionLeases.filter((entry: { body: { symbols?: string[] } }) =>
    (entry.body.symbols?.length ?? 0) === 0).length;
  const optionChainRequests = observed.gateway.requests["/api/v1/options/chain"] ?? 0;
  // The normal 15-second snapshot poll returns new contract objects without
  // changing membership. It must not issue an empty cleanup in either tab.
  await expect.poll(async () => {
    observed = await metrics(request);
    return observed.gateway.requests["/api/v1/options/chain"] ?? 0;
  }, { timeout: 18_000 }).toBeGreaterThan(optionChainRequests);
  optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  expect(optionLeases.length).toBeGreaterThanOrEqual(4);
  const emptyLeaseCountAfterSnapshotPoll = optionLeases.filter((entry: { body: { symbols?: string[] } }) =>
    (entry.body.symbols?.length ?? 0) === 0).length;
  expect(emptyLeaseCountAfterSnapshotPoll).toBe(emptyCleanupCountBeforeSnapshotPoll);
  const nonEmptyOptionLeases = optionLeases.filter((entry: { body: { symbols?: string[] } }) =>
    (entry.body.symbols?.length ?? 0) > 0);
  expect(nonEmptyOptionLeases.every((entry: { body: { symbols?: string[] } }) =>
    entry.body.symbols?.length === 1 && entry.body.symbols[0] === contractSymbol)).toBe(true);

  const secondTabOptions = secondTab.locator(".terminal-panel").filter({ hasText: /OPRA quotes ·/ });
  const emptyCleanupCountBeforeTabClose = optionLeases.filter((entry: { body: { symbols?: string[] } }) =>
    (entry.body.symbols?.length ?? 0) === 0).length;
  await secondTabOptions.nth(0).locator(".panel-title button").last().click();
  await secondTabOptions.nth(0).locator(".panel-title button").last().click();
  await expect.poll(async () => {
    observed = await metrics(request);
    return observed.gateway.subscriptions.filter((entry: { path: string; body: { symbols?: string[] } }) =>
      entry.path.endsWith("/subscriptions/options") && (entry.body.symbols?.length ?? 0) === 0).length;
  }, { timeout: 5_000 }).toBe(emptyCleanupCountBeforeTabClose + 2);
  optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  const releasedConsumers = optionLeases.filter((entry: { body: { symbols?: string[] } }) => (entry.body.symbols?.length ?? 0) === 0)
    .slice(emptyCleanupCountBeforeTabClose);
  for (const releasedConsumer of releasedConsumers) {
    const originalLease = optionLeases.find((entry: { body: { consumer_id: string; generation: number; symbols?: string[] } }) =>
      entry.body.consumer_id === releasedConsumer.body.consumer_id &&
      (entry.body.symbols?.length ?? 0) > 0 && entry.body.generation < releasedConsumer.body.generation)!;
    expect(releasedConsumer.body.generation).toBeGreaterThan(originalLease.body.generation);
  }

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

  observed = await metrics(request);
  optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  const emptyCleanupCountBeforeFirstPanelClose = optionLeases.filter((entry: { body: { symbols?: string[] } }) =>
    (entry.body.symbols?.length ?? 0) === 0).length;
  await firstPanel.locator(".panel-title button").last().click();
  await expect.poll(async () => {
    observed = await metrics(request);
    return observed.gateway.subscriptions.filter((entry: { path: string; body: { symbols?: string[] } }) =>
      entry.path.endsWith("/subscriptions/options") && (entry.body.symbols?.length ?? 0) === 0).length;
  }, { timeout: 5_000 }).toBe(emptyCleanupCountBeforeFirstPanelClose + 1);
  optionLeases = observed.gateway.subscriptions.filter((entry: { path: string }) =>
    entry.path.endsWith("/subscriptions/options"));
  const emptyLeases = optionLeases.filter((entry: { body: { symbols?: string[] } }) => (entry.body.symbols?.length ?? 0) === 0)
    .slice(emptyCleanupCountBeforeFirstPanelClose);
  for (const cleanup of emptyLeases) {
    const previous = optionLeases.find((entry: { body: { consumer_id: string; generation: number; symbols?: string[] } }) =>
      entry.body.consumer_id === cleanup.body.consumer_id &&
      (entry.body.symbols?.length ?? 0) > 0 && entry.body.generation < cleanup.body.generation)!;
    expect(cleanup.body.generation).toBeGreaterThan(previous.body.generation);
  }
});

test("Gateway status replay confirms a late browser subscriber and nonzero-epoch resync clears live quotes", async ({ page, context, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const snapshotTime = new Date(Date.now() - 20_000).toISOString();
  const contract = {
    symbol: contractSymbol,
    gateway_instance_id: "gateway-e2e-offline-1",
    source_mode: "offline_mock",
    source_label: "OFFLINE MOCK — NOT MARKET DATA",
    received_at: new Date().toISOString(),
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
    greeksSource: "REST model",
    greeksAsOf: null,
  };
  await configureMocks(request, {
    optionStatus: 200,
    optionFeed: "opra",
    contracts: [contract],
    sseEvents: [feedStatus(1, null, null)],
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /OPTIONS/ }).click();
  const panels = page.locator(".terminal-panel").filter({ hasText: /OPRA quotes ·/ });
  await expect(panels).toHaveCount(2);

  const liveTime = new Date().toISOString();
  await configureMocks(request, {
    sseEvents: [
      feedStatus(3, [contractSymbol], liveTime, new Date(Date.now() + 30_000).toISOString()),
      {
        gateway_instance_id: "gateway-e2e-offline-1",
        source_mode: "offline_mock",
        source_label: "OFFLINE MOCK — NOT MARKET DATA",
        kind: "option_quote",
        symbol: contractSymbol,
        bid: 1.50,
        ask: 1.60,
        bid_size: 8,
        ask_size: 9,
        event_time: liveTime,
        received_at: new Date().toISOString(),
        connection_epoch: 8,
        local_sequence: 4,
      },
    ],
  });
  const bidCell = panels.first().locator('.ag-row[row-index="0"] [col-id="put.bid"]');
  await expect(bidCell).toContainText("1.50", { timeout: 8_000 });

  await configureMocks(request, {
    sseEvents: [feedStatus(5, [contractSymbol], liveTime)],
  });
  const lateSubscriber = await context.newPage();
  await lateSubscriber.goto("/", { waitUntil: "domcontentloaded" });
  const latePanels = lateSubscriber.locator(".terminal-panel").filter({ hasText: /OPRA quotes ·/ });
  await expect(latePanels).toHaveCount(2);
  await expect(latePanels.first()).toContainText("quotes ACK 1/1", { timeout: 8_000 });
  await expect(latePanels.first()).toContainText("OPRA source entitlement unknown");

  await configureMocks(request, {
    sseEvents: [{
      ...feedStatus(6, [contractSymbol], liveTime),
      resync_required: true,
    }],
  });
  await expect(bidCell).toContainText("1.25", { timeout: 8_000 });
  await expect(bidCell).not.toContainText("1.50");
  await expect(panels.first()).toContainText("SUBSCRIBED · WAITING FOR DATA");
});

test("a browser stream outage cannot pin an old U.S. tick over a newer REST SIP snapshot", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);
  const gatewayInstanceId = "gateway-e2e-outage-1";
  const offlineSource = { sourceMode: "offline_mock" as const, sourceLabel: "OFFLINE MOCK — NOT MARKET DATA" };
  const snapshotTime = new Date(Date.now() - 20_000).toISOString();
  await configureMocks(request, {
    snapshots: sipSnapshotResponse(100, snapshotTime, 12, 0, { gatewayInstanceId, ...offlineSource }),
    sseDisconnectAfterMs: 12_000,
    sseEvents: [],
  });

  let streamRequests = 0;
  await page.route("**/api/eqo/live", async (route) => {
    streamRequests += 1;
    if (streamRequests > 1) return route.abort();
    return route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const quotePanel = page.locator(".terminal-panel").filter({ hasText: /Quote\s*QQQ/ }).first();
  await expect(quotePanel).toContainText("Browser SSE connected", { timeout: 15_000 });

  const liveTime = new Date().toISOString();
  await configureMocks(request, {
    sseEvents: [
      {
        kind: "feed_status",
        gateway_instance_id: gatewayInstanceId,
        source_mode: "offline_mock",
        source_label: "OFFLINE MOCK — NOT MARKET DATA",
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
        received_at: liveTime,
        last_error: null,
        decode_error_count: 0,
        freshness: { "QQQ:trade": {
          state: "fresh", as_of: liveTime, age_ms: 1_000,
          fresh_until: new Date(Date.now() + 30_000).toISOString(),
        } },
      },
      {
        kind: "stock_trade",
        gateway_instance_id: gatewayInstanceId,
        source_mode: "offline_mock",
        source_label: "OFFLINE MOCK — NOT MARKET DATA",
        symbol: "QQQ",
        price: 101,
        size: 10,
        event_time: liveTime,
        received_at: liveTime,
        connection_epoch: 12,
        local_sequence: 2,
      },
    ],
  });
  await expect(quotePanel).toContainText("PRICE FRESH · OFFLINE MOCK", { timeout: 8_000 });
  await expect(quotePanel).toContainText("101.00");

  await expect(quotePanel).toContainText("BROWSER DISCONNECTED", { timeout: 20_000 });
  const refreshedTime = new Date().toISOString();
  await configureMocks(request, { snapshots: sipSnapshotResponse(105, refreshedTime, 12, 2, {
    gatewayInstanceId, ...offlineSource,
  }) });
  await expect(quotePanel).toContainText("105.00", { timeout: 20_000 });
  await expect(quotePanel).toContainText("PRICE BROWSER DISCONNECTED · REST snapshot");
  expect(streamRequests).toBeGreaterThan(1);
  expect((await metrics(request)).gateway.requests["/api/v1/orders/submit"]).toBeUndefined();
});
