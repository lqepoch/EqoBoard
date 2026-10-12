import { configureMocks, loginWithOidc, metrics, resetDownstream, test, expect } from "./fixtures";
import { sipSnapshotResponse } from "./market-test-data";

const instanceId = "gateway-e2e-offline-1";
const offlineSource = {
  source_mode: "offline_mock",
  source_label: "OFFLINE MOCK — NOT MARKET DATA",
};

test.beforeEach(async ({ request }) => {
  await resetDownstream(request);
});

for (const [name, statusEntitlement, eventEntitlement, expectLive] of [
  ["feed status", "unknown", "authorized", false],
  ["market event", "authorized", "unknown", false],
  ["feed status and market event", "authorized", "authorized", true],
] as const) {
  test(`Alpaca SIP freshness requires authorized entitlement on the ${name}`, async ({ page, request }) => {
    await loginWithOidc(page, request, ["eqoboard-market-reader"]);
    const publishedAt = new Date().toISOString();
    const snapshotAt = new Date(Date.now() - 1_000).toISOString();
    // Synthetic local OIDC/Gateway fixture for the UI contract; this does not
    // prove a real Alpaca entitlement, provider identity, or subscription ACK.
    const providerSource = { source_mode: "alpaca", source_label: "Alpaca SIP" };
    const snapshotFixture = sipSnapshotResponse(100, snapshotAt, 42, 0, {
      gatewayInstanceId: instanceId,
      receivedAt: publishedAt,
      sourceMode: "alpaca",
      sourceLabel: "Alpaca SIP",
    });
    await configureMocks(request, {
      snapshots: {
        ...snapshotFixture,
        source_entitlement: eventEntitlement,
        snapshots: snapshotFixture.snapshots.map((snapshot) => ({
          ...snapshot, source_entitlement: eventEntitlement,
        })),
      },
      sseEvents: [
        {
          kind: "feed_status", gateway_instance_id: instanceId, ...providerSource,
          source_entitlement: statusEntitlement,
          feed: "stocks", transport: "connected", auth: "authenticated",
          desired: { quotes: ["QQQ"], trades: ["QQQ"] },
          confirmed: { quotes: ["QQQ"], trades: ["QQQ"] },
          pending: { subscribe: { quotes: [], trades: [] }, unsubscribe: { quotes: [], trades: [] } },
          upstream: "ready", coverage: { desired_count: 1, confirmed_count: 1, limit: null, complete: true },
          connection_epoch: 42, local_sequence: 1, received_at: publishedAt,
          last_error: null, decode_error_count: 0,
          freshness: { "QQQ:trade": { state: "fresh", as_of: publishedAt, age_ms: 0 } },
        },
        {
          kind: "stock_trade", gateway_instance_id: instanceId, ...providerSource,
          source_entitlement: eventEntitlement,
          symbol: "QQQ", price: expectLive ? 101 : 100, size: 10, event_time: publishedAt,
          received_at: publishedAt, connection_epoch: 42, local_sequence: 2,
        },
      ],
    });

    const snapshotResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/quotes" && url.searchParams.get("symbols") === "QQQ";
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const response = await snapshotResponse;
    expect(response.status()).toBe(200);
    const [snapshot] = await response.json();
    expect(snapshot).toMatchObject({ symbol: "QQQ", price: 100, source_mode: "alpaca" });
    const quotePanel = page.locator(".terminal-panel").filter({ hasText: /Quote\s*QQQ/ }).first();
    if (expectLive) {
      await expect(quotePanel).toContainText("PRICE FRESH · LIVE", { timeout: 10_000 });
      await expect(quotePanel).toContainText("stream event time");
      await expect(quotePanel.getByText("101.00", { exact: true })).toBeVisible();
    } else {
      await expect(quotePanel).toContainText("FRESHNESS UNKNOWN", { timeout: 10_000 });
      await expect(quotePanel).toContainText("100.00");
      await expect(quotePanel).not.toContainText("LIVE");
    }
  });
}

for (const upstreamStatus of [401, 403, 429] as const) {
  test(`authenticated SIP quote requests surface upstream HTTP ${upstreamStatus} without fallback`, async ({ page, request }) => {
    await loginWithOidc(page, request, ["eqoboard-market-reader"]);
    await configureMocks(request, { snapshotStatus: upstreamStatus });

    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/quotes" && url.searchParams.get("symbols") === "QQQ";
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const response = await responsePromise;
    expect(response.status()).toBe(upstreamStatus);
    await expect(page.getByTestId("market-data-error")).toContainText(`HTTP ${upstreamStatus}`);
    const observed = await metrics(request);
    expect(observed.gateway.requests["/api/v1/stocks/snapshots"]).toBeGreaterThan(0);
    expect(observed.gateway.authorized).toBeGreaterThan(0);
    expect(observed.gateway.rejected).toBe(0);
    expect(observed.research.requests["/api/quotes"] ?? 0).toBe(0);
  });
}

test("legacy REST price remains visible as unknown, while silent SSE freshness expires", async ({ page, request }) => {
  await loginWithOidc(page, request, ["eqoboard-market-reader"]);

  const legacyAsOf = new Date(Date.now() - 60_000).toISOString();
  await configureMocks(request, {
    snapshots: {
      feed: "sip",
      as_of: legacyAsOf,
      snapshots: [{
        symbol: "QQQ", feed: "sip", source: "Alpaca SIP", as_of: legacyAsOf,
        last: 100, previous_close: 99, change_percent: 1.0101,
        open: 99, high: 100, low: 98, bid: 99.99, ask: 100.01, volume: 100_000,
        updated_at: legacyAsOf,
      }],
    },
    sseEvents: [],
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const quotePanel = page.locator(".terminal-panel").filter({ hasText: /Quote\s*QQQ/ }).first();
  await expect(quotePanel).toContainText("100.00", { timeout: 10_000 });
  await expect(quotePanel).toContainText("last (unknown): unknown");
  const source = page.getByTestId("market-source-stocks").first();
  await expect(source).toHaveAttribute("data-source-mode", "unknown");
  await expect(source).toContainText("source unknown");
  const stockStatus = page.getByTestId("market-feed-status-stocks").first();
  await expect(stockStatus).toContainText("quotes ACK unknown · desired unknown");
  await expect(stockStatus).toContainText("coverage unknown");
  const optionsStatus = page.getByTestId("market-feed-status-options").first();
  await expect(optionsStatus).toContainText("quotes ACK unknown · desired unknown");
  await expect(optionsStatus).toContainText("coverage unknown");
  await expect(page.getByTestId("options-subscription-coverage"))
    .toContainText("confirmed unknown · desired unknown gateway-wide unique symbols");
  await expect(quotePanel).not.toContainText("LIVE");

  const firstPublication = new Date().toISOString();
  await configureMocks(request, {
    sseEvents: [
      {
        kind: "feed_status", gateway_instance_id: instanceId, ...offlineSource,
        feed: "stocks", transport: "connected", auth: "authenticated",
        desired: { quotes: ["QQQ"], trades: ["QQQ"] },
        confirmed: { quotes: ["QQQ"], trades: ["QQQ"] },
        pending: { subscribe: { quotes: [], trades: [] }, unsubscribe: { quotes: [], trades: [] } },
        upstream: "ready", coverage: { desired_count: 1, confirmed_count: 1, limit: null, complete: true },
        connection_epoch: 13, local_sequence: 1, received_at: firstPublication,
        last_error: null, decode_error_count: 0,
        freshness: { "QQQ:trade": { state: "fresh", as_of: firstPublication, age_ms: 0 } },
      },
      {
        // Legacy data payloads without the source pair may be observed but can
        // never overwrite a trusted REST snapshot or be presented as LIVE.
        kind: "stock_trade", gateway_instance_id: instanceId,
        symbol: "QQQ", price: 101, size: 10, event_time: firstPublication,
        received_at: firstPublication, connection_epoch: 13, local_sequence: 2,
      },
    ],
  });
  await expect(quotePanel).toContainText("FRESHNESS UNKNOWN", { timeout: 8_000 });
  await expect(quotePanel).toContainText("100.00");
  await expect(quotePanel).not.toContainText("LIVE");

  const liveAt = new Date().toISOString();
  await configureMocks(request, {
    sseEvents: [
      {
        kind: "feed_status", gateway_instance_id: instanceId, ...offlineSource,
        feed: "stocks", transport: "connected", auth: "authenticated",
        desired: { quotes: ["QQQ"], trades: ["QQQ"] },
        confirmed: { quotes: ["QQQ"], trades: ["QQQ"] },
        pending: { subscribe: { quotes: [], trades: [] }, unsubscribe: { quotes: [], trades: [] } },
        upstream: "ready", coverage: { desired_count: 1, confirmed_count: 1, limit: null, complete: true },
        connection_epoch: 13, local_sequence: 3, received_at: liveAt,
        last_error: null, decode_error_count: 0,
        freshness: { "QQQ:trade": {
          state: "fresh", as_of: liveAt, age_ms: 0,
          // The Gateway projection cannot extend the client-side silent-feed guard.
          fresh_until: new Date(Date.now() + 15_000).toISOString(),
        } },
      },
      {
        kind: "stock_trade", gateway_instance_id: instanceId, ...offlineSource,
        symbol: "QQQ", price: 101, size: 10, event_time: liveAt,
        received_at: liveAt, connection_epoch: 13, local_sequence: 4,
      },
    ],
  });
  await expect(quotePanel).toContainText("PRICE FRESH · OFFLINE MOCK", { timeout: 8_000 });
  await expect(quotePanel).toContainText("101.00");
  await expect(page.getByTestId("configured-market-feeds"))
    .toContainText("Configured feeds: SIP / OPRA · source OFFLINE MOCK — NOT MARKET DATA · entitlement unverified");
  const sessionStatus = page.getByTestId("market-session-status");
  await expect(sessionStatus).toContainText("Trading day/session: unknown");
  await expect(sessionStatus).toContainText(/weekday-hours estimate: (within|outside)/);
  await expect(quotePanel).toContainText("PRICE STALE", { timeout: 8_000 });
  await expect(quotePanel).toContainText("100.00");
  await expect(quotePanel).toContainText("Browser SSE connected");
  await expect(sessionStatus).not.toContainText(/closed/i);
  expect((await metrics(request)).gateway.streamOpened).toBeGreaterThan(0);

  const refreshedAt = new Date().toISOString();
  await configureMocks(request, {
    snapshots: {
      feed: "sip",
      as_of: refreshedAt,
      snapshots: [{
        symbol: "QQQ", feed: "sip", source: "Alpaca SIP", as_of: refreshedAt,
        last: 102, previous_close: 99, change_percent: 3.0303,
        open: 99, high: 102, low: 98, bid: 101.99, ask: 102.01, volume: 101_000,
        updated_at: refreshedAt,
      }],
    },
  });
  await expect(quotePanel).toContainText("102.00", { timeout: 20_000 });
  await expect(quotePanel).toContainText("last (unknown): unknown");
  await expect(quotePanel).not.toContainText("LIVE");
});
