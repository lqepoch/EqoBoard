import type { APIRequestContext, Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { MOCK_OIDC_ORIGIN, WEB_ORIGIN } from "./fixtures";

/**
 * Real Rust Gateway acceptance, run only by the isolated compose runner that
 * points Next at Rust and gives the Playwright process private-network access
 * to the authenticated offline Alpaca control listener.
 *
 * The ordinary browser suite deliberately skips this file: its Gateway is a
 * request-recording mock and cannot prove server-side lease generations,
 * upstream ACKs, or connection epochs.
 */
const enabled = process.env.E2E_REAL_GATEWAY === "1";
const controlOrigin = process.env.E2E_OFFLINE_ALPACA_CONTROL_URL;
const controlToken = process.env.EQO_OFFLINE_ALPACA_CONTROL_TOKEN;

type Channels = { quotes: string[]; trades: string[] };
type FeedStatus = {
  kind: "feed_status";
  feed: "stocks" | "options";
  transport: "disconnected" | "connecting" | "connected";
  auth: "unknown" | "authenticating" | "authenticated" | "failed";
  desired: Channels;
  pending: { subscribe: Channels; unsubscribe: Channels };
  confirmed: Channels | null;
  upstream: "connecting" | "ready" | "degraded";
  coverage: { desired_count: number; confirmed_count: number; limit: number | null; complete: boolean };
  connection_epoch: number;
  local_sequence: number;
  received_at: string | null;
  last_error: { code: number | null; class: string; message?: string } | null;
  decode_error_count: number;
  out_of_order_count: number;
  stale_epoch_count?: number;
  freshness?: Record<string, { state: "fresh" | "stale" | "unknown"; as_of: string | null; fresh_until?: string | null }>;
};
type LeaseRequest = { consumer_id: string; generation: number; symbols: string[] };
type LeaseReply = {
  consumer_id: string;
  requested_generation: number;
  accepted: boolean;
  ignored: boolean;
  active_generation: number;
  active_symbols: string[];
  expires_at: string | null;
};
type OfflineSession = {
  id: string;
  feed: "stocks" | "options";
  authenticated: boolean;
  quotes: string[];
  trades: string[];
};
type OfflineState = { marker: string; rest_requests: number; sessions: OfflineSession[] };
type ChainContract = { symbol: string; right: "call" | "put"; strike: number };
type OptionChain = { calls: ChainContract[]; puts: ChainContract[] };

function requireRustRunner() {
  test.skip(!enabled, "Requires the isolated Next → Rust Gateway → offline Alpaca runner");
  expect(controlOrigin, "E2E_OFFLINE_ALPACA_CONTROL_URL must be private-network reachable from Playwright").toBeTruthy();
  expect(controlToken, "EQO_OFFLINE_ALPACA_CONTROL_TOKEN must be set for the offline control API").toBeTruthy();
}

async function alpacaControl<T>(request: APIRequestContext, path: string, data?: unknown): Promise<T> {
  const response = await request.fetch(`${controlOrigin}${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${controlToken}` },
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json();
  expect(response.ok(), `${path} returned HTTP ${response.status()}: ${JSON.stringify(body)}`).toBeTruthy();
  return body as T;
}

async function resetOfflineAlpaca(request: APIRequestContext) {
  const reset = await alpacaControl<{ marker: string; reset: boolean }>(request, "/__control/reset", {});
  expect(reset.marker).toContain("OFFLINE MOCK");
  await alpacaControl(request, "/__control/config", { ack_mode: "full", auth_mode: "accept", rest_status: 200 });
}

async function authenticateThroughOidc(page: Page, request: APIRequestContext) {
  const roles = ["eqoboard-market-reader"];
  const roleResult = await request.post(`${MOCK_OIDC_ORIGIN}/__test/roles`, { data: { roles } });
  expect(roleResult.ok()).toBeTruthy();

  // This uses the regular NextAuth login button and the mock IdP's OIDC
  // authorization-code + PKCE flow. It never injects a cookie or token.
  await page.goto(WEB_ORIGIN);
  await page.getByRole("button", { name: /organization identity provider/i }).click();
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body.user.id).toBe("subject-e2e");
  expect(session.body.user.roles).toEqual(roles);
  expect(session.body.user.issuer).toBe(MOCK_OIDC_ORIGIN);
}

async function observeOneBrowserStream(page: Page) {
  await page.addInitScript(() => {
    const native = window.EventSource;
    const observation = { urls: [] as string[], messages: [] as unknown[] };
    Object.defineProperty(window, "__eqoRustMarketObservation", {
      configurable: false,
      value: observation,
    });
    window.EventSource = new Proxy(native, {
      construct(target, args, newTarget) {
        const source = Reflect.construct(target, args, newTarget) as EventSource;
        observation.urls.push(String(args[0]));
        source.addEventListener("message", (event) => {
          try {
            const parsed = JSON.parse((event as MessageEvent<string>).data) as unknown;
            observation.messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
          } catch {
            // Keep malformed frames visible to the application; the typed DTO
            // assertions below will fail if the Gateway emits an unusable one.
          }
        });
        return source;
      },
    });
  });
}

async function observedEvents(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const value = (window as unknown as { __eqoRustMarketObservation?: { messages: unknown[] } })
      .__eqoRustMarketObservation;
    return value?.messages ?? [];
  });
}

async function latestFeedStatus(page: Page, feed: "stocks" | "options"): Promise<FeedStatus | null> {
  const events = await observedEvents(page);
  return [...events].reverse().find((event): event is FeedStatus => {
    if (!event || typeof event !== "object") return false;
    const status = event as Partial<FeedStatus>;
    return status.kind === "feed_status" && status.feed === feed;
  }) ?? null;
}

async function currentOfflineState(request: APIRequestContext): Promise<OfflineState> {
  const state = await alpacaControl<OfflineState>(request, "/__control/state");
  expect(state.marker).toContain("OFFLINE MOCK");
  return state;
}

function assertLeaseReply(value: unknown, consumerId: string): LeaseReply {
  expect(value).toMatchObject({ consumer_id: consumerId });
  const reply = value as LeaseReply;
  expect(Number.isSafeInteger(reply.requested_generation)).toBe(true);
  expect(Number.isSafeInteger(reply.active_generation)).toBe(true);
  expect(typeof reply.accepted).toBe("boolean");
  expect(typeof reply.ignored).toBe("boolean");
  expect(Array.isArray(reply.active_symbols)).toBe(true);
  expect(reply.expires_at === null || Number.isFinite(Date.parse(reply.expires_at))).toBe(true);
  return reply;
}

function sameMembers(left: string[], right: string[]) {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function nextExpiry(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

function rfc3339At(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function timestamp96At(epochMillis: number) {
  const millis = BigInt(Math.trunc(epochMillis));
  const seconds = millis / 1_000n;
  const nanoseconds = Number((millis % 1_000n) * 1_000_000n + 123_456n);
  return { encoding: "timestamp96" as const, seconds: Number(seconds), nanoseconds };
}

function timestamp96(offsetMs: number) {
  return timestamp96At(Date.now() + offsetMs);
}

test.describe("real Rust Gateway market protocol", () => {
  test.beforeEach(async ({ request }) => {
    requireRustRunner();
    await resetOfflineAlpaca(request);
  });

  test.afterEach(async ({ page, request }) => {
    if (!enabled || !controlOrigin || !controlToken) return;
    await page.close().catch(() => undefined);
    await alpacaControl(request, "/__control/reset", {}).catch(() => undefined);
  });

  test("rejects a delayed older OPRA cleanup after the newer generation is active", async ({ page, request }) => {
    test.setTimeout(150_000);
    await observeOneBrowserStream(page);
    await authenticateThroughOidc(page, request);
    const quotePanel = page.locator(".terminal-panel").filter({ hasText: "Invesco QQQ Trust" });
    await expect(quotePanel).toContainText("Alpaca SIP", { timeout: 30_000 });

    const subscribeReplies: Array<{ request: LeaseRequest; status: number; body: unknown }> = [];
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/eqo/options/subscribe")) return;
      const requestBody = response.request().postDataJSON() as LeaseRequest;
      subscribeReplies.push({ request: requestBody, status: response.status(), body: await response.json().catch(() => null) });
    });

    await page.getByRole("button", { name: /OPTIONS/ }).click();
    const panels = page.locator(".terminal-panel").filter({ hasText: "ALPACA OPRA QUOTES" });
    await expect(panels).toHaveCount(2);
    await expect.poll(() => subscribeReplies.filter((item) => item.request.symbols.length > 0).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);

    const firstLease = subscribeReplies.find((item) => item.request.symbols.length > 0)!;
    const targetConsumer = firstLease.request.consumer_id;
    const initial = assertLeaseReply(firstLease.body, targetConsumer);
    expect(initial.accepted).toBe(true);
    expect(initial.ignored).toBe(false);
    expect(initial.active_generation).toBe(initial.requested_generation);
    expect(sameMembers(initial.active_symbols, firstLease.request.symbols)).toBe(true);

    await expect.poll(async () => {
      const status = await latestFeedStatus(page, "options");
      return status?.confirmed !== null && status?.confirmed !== undefined && status.coverage.complete;
    }, { timeout: 25_000 }).toBe(true);
    await expect.poll(async () => {
      const state = await currentOfflineState(request);
      return ["stocks", "options"].map((feed) =>
        state.sessions.filter((session) => session.feed === feed && session.authenticated).length);
    }, { timeout: 20_000 }).toEqual([1, 1]);
    const initialStreams = await page.evaluate(() => {
      const value = (window as unknown as { __eqoRustMarketObservation: { urls: string[] } }).__eqoRustMarketObservation;
      return value.urls.filter((url) => url.includes("/api/eqo/live")).length;
    });
    expect(initialStreams).toBe(1);

    let cleanupGeneration: number | null = null;
    let resolveCleanupArrived!: () => void;
    const cleanupArrived = new Promise<void>((resolve) => { resolveCleanupArrived = resolve; });
    let releaseCleanup!: () => void;
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let heldRoute: Route | null = null;
    const holdOldCleanup = async (route: Route) => {
      const body = route.request().postDataJSON() as LeaseRequest;
      if (body.consumer_id === targetConsumer && body.symbols.length === 0 && heldRoute === null) {
        cleanupGeneration = body.generation;
        heldRoute = route;
        resolveCleanupArrived();
        await cleanupRelease;
      }
      await route.continue();
    };
    await page.route("**/api/eqo/options/subscribe", holdOldCleanup);

    try {
      const expiries = panels.getByRole("textbox", { name: "Option expiry" });
      const changedExpiry = nextExpiry(await expiries.first().inputValue());
      for (let index = 0; index < await expiries.count(); index += 1) {
        await expiries.nth(index).fill(changedExpiry);
      }
      await cleanupArrived;
      expect(cleanupGeneration).not.toBeNull();

      await expect.poll(() => subscribeReplies.some((item) =>
        item.request.consumer_id === targetConsumer && item.request.symbols.length > 0 &&
        item.request.generation > cleanupGeneration! && !sameMembers(item.request.symbols, initial.active_symbols)),
      { timeout: 30_000 }).toBe(true);
      const renewal = subscribeReplies.find((item) => item.request.consumer_id === targetConsumer &&
        item.request.symbols.length > 0 && item.request.generation > cleanupGeneration! &&
        !sameMembers(item.request.symbols, initial.active_symbols))!;
      const renewalReply = assertLeaseReply(renewal.body, targetConsumer);
      expect(renewal.status).toBe(200);
      expect(renewalReply.accepted).toBe(true);
      expect(renewalReply.ignored).toBe(false);
      expect(renewalReply.active_generation).toBe(renewal.request.generation);
      expect(renewalReply.active_symbols).toEqual(renewal.request.symbols);
      expect(renewalReply.expires_at).not.toBeNull();

      await expect.poll(async () => {
        const status = await latestFeedStatus(page, "options");
        return Boolean(status && renewal.request.symbols.every((symbol) =>
          status.desired.quotes.includes(symbol) && status.desired.trades.includes(symbol)));
      }, { timeout: 20_000 }).toBe(true);

      let cleanupResponse: { status: number; body: unknown } | null = null;
      const cleanupFinished = page.waitForResponse(async (response) => {
        if (!response.url().endsWith("/api/eqo/options/subscribe")) return false;
        const body = response.request().postDataJSON() as LeaseRequest;
        return body.consumer_id === targetConsumer && body.generation === cleanupGeneration;
      }).then(async (response) => ({ status: response.status(), body: await response.json() }));
      releaseCleanup();
      cleanupResponse = await cleanupFinished;
      const stale = assertLeaseReply(cleanupResponse.body, targetConsumer);
      expect(cleanupResponse.status === 409 || stale.ignored).toBe(true);
      expect(stale.accepted).toBe(false);
      expect(stale.requested_generation).toBe(cleanupGeneration);
      expect(stale.active_generation).toBe(renewalReply.active_generation);
      expect(stale.active_generation).toBeGreaterThan(stale.requested_generation);
      expect(stale.active_symbols).toEqual(renewalReply.active_symbols);
      expect(Date.parse(stale.expires_at!)).toBeGreaterThanOrEqual(Date.parse(renewalReply.expires_at!));

      const statusAfterCleanup = await latestFeedStatus(page, "options");
      expect(statusAfterCleanup).not.toBeNull();
      expect(renewal.request.symbols.every((symbol) =>
        statusAfterCleanup!.desired.quotes.includes(symbol) && statusAfterCleanup!.desired.trades.includes(symbol))).toBe(true);
      const upstream = await currentOfflineState(request);
      const optionSessions = upstream.sessions.filter((session) => session.feed === "options" && session.authenticated);
      expect(optionSessions).toHaveLength(1);
      expect(renewal.request.symbols.every((symbol) =>
        optionSessions[0].quotes.includes(symbol) && optionSessions[0].trades.includes(symbol))).toBe(true);
    } finally {
      releaseCleanup();
      await page.unroute("**/api/eqo/options/subscribe", holdOldCleanup);
    }
  });

  test("renders real partial ACK and rejects an older OPRA tick after a fresh event", async ({ page, request }) => {
    test.setTimeout(150_000);
    await observeOneBrowserStream(page);
    await authenticateThroughOidc(page, request);

    const optionChains: OptionChain[] = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname !== "/api/options/QQQ" || !response.ok()) return;
      const value: unknown = await response.json().catch(() => null);
      if (value && typeof value === "object" && Array.isArray((value as OptionChain).calls) &&
          Array.isArray((value as OptionChain).puts)) optionChains.push(value as OptionChain);
    });
    await page.getByRole("button", { name: /OPTIONS/ }).click();
    const panels = page.locator(".terminal-panel").filter({ hasText: "ALPACA OPRA QUOTES" });
    await expect(panels.first()).toBeVisible();
    const feedStatus = page.locator('[data-testid="market-feed-status-options"]');
    await expect.poll(async () => {
      const status = await latestFeedStatus(page, "options");
      return status?.confirmed !== null && status?.confirmed !== undefined && status.coverage.complete;
    }, { timeout: 25_000 }).toBe(true);

    const fullStatus = await latestFeedStatus(page, "options");
    expect(fullStatus?.desired.quotes.length).toBeGreaterThan(0);
    const symbol = fullStatus!.desired.quotes[0];
    await expect.poll(() => optionChains.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const chain = optionChains.find((item) => [...item.calls, ...item.puts]
      .some((contract) => contract.symbol === symbol));
    expect(chain).toBeDefined();
    const contract = [...chain!.calls, ...chain!.puts].find((item) => item.symbol === symbol);
    expect(contract).toBeDefined();
    const visibleStrikes = [...new Set([...chain!.calls, ...chain!.puts].map((item) => item.strike))]
      .sort((left, right) => left - right);
    const rowIndex = visibleStrikes.indexOf(contract!.strike);
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    const bidCell = panels.first().locator(`.ag-row[row-index="${rowIndex}"] [col-id="${contract!.right}.bid"]`);
    const emitted = await alpacaControl<{ delivered: number }>(request, "/__control/emit", {
      feed: "options",
      record: { kind: "option_quote", symbol, timestamp: timestamp96(250), bid: 4.44, ask: 4.54, bid_size: 9, ask_size: 8 },
    });
    expect(emitted.delivered).toBeGreaterThan(0);
    await expect(bidCell).toContainText("4.44", { timeout: 10_000 });
    const liveEvent = [...await observedEvents(page)].reverse().find((event) =>
      Boolean(event && typeof event === "object" &&
        (event as { kind?: string; symbol?: string; bid?: number }).kind === "option_quote" &&
        (event as { symbol?: string }).symbol === symbol && (event as { bid?: number }).bid === 4.44)) as
      { event_time?: string | null; received_at?: string; connection_epoch?: number; local_sequence?: number } | undefined;
    expect(liveEvent?.event_time).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(typeof liveEvent?.received_at).toBe("string");
    expect(liveEvent?.connection_epoch).toBe(fullStatus?.connection_epoch);
    expect(liveEvent?.local_sequence).toBeGreaterThan(fullStatus?.local_sequence ?? 0);
    const statusBeforeOldTick = await latestFeedStatus(page, "options");
    expect(statusBeforeOldTick).not.toBeNull();
    expect(statusBeforeOldTick?.connection_epoch).toBe(fullStatus?.connection_epoch);

    const oldTimestamp = timestamp96At(Date.parse(liveEvent!.event_time!) - 5_000);
    const old = await alpacaControl<{ delivered: number }>(request, "/__control/emit", {
      feed: "options",
      record: { kind: "option_quote", symbol, timestamp: oldTimestamp, bid: 0.22, ask: 0.32, bid_size: 1, ask_size: 1 },
    });
    expect(old.delivered).toBeGreaterThan(0);
    await expect.poll(async () => {
      return (await latestFeedStatus(page, "options"))?.out_of_order_count ?? 0;
    }, { timeout: 10_000 }).toBeGreaterThan(statusBeforeOldTick!.out_of_order_count);
    await expect(bidCell).toContainText("4.44");
    await expect(bidCell).not.toContainText("0.22");

    await alpacaControl(request, "/__control/config", { ack_mode: "partial" });
    const expiry = panels.first().getByRole("textbox", { name: "Option expiry" });
    const partialExpiry = nextExpiry(await expiry.inputValue());
    await expiry.fill(partialExpiry);
    await expect.poll(async () => {
      const status = await latestFeedStatus(page, "options");
      if (!status?.confirmed || status.coverage.complete) return false;
      const missingQuote = status.desired.quotes.some((item) => !status.confirmed!.quotes.includes(item));
      const missingTrade = status.desired.trades.some((item) => !status.confirmed!.trades.includes(item));
      return missingQuote || missingTrade;
    }, { timeout: 30_000 }).toBe(true);

    const partial = await latestFeedStatus(page, "options");
    expect(partial).not.toBeNull();
    expect(partial?.connection_epoch).toBe(fullStatus?.connection_epoch);
    expect(partial?.local_sequence).toBeGreaterThan(fullStatus?.local_sequence ?? 0);
    expect(partial?.coverage.complete).toBe(false);
    await expect(feedStatus).toContainText("partial");
    const upstream = await currentOfflineState(request);
    const optionSessions = upstream.sessions.filter((session) => session.feed === "options" && session.authenticated);
    expect(optionSessions).toHaveLength(1);
    expect(optionSessions[0].quotes.length + optionSessions[0].trades.length).toBeGreaterThan(0);
    expect(partial?.confirmed).not.toBeNull();
    expect(sameMembers(optionSessions[0].quotes, partial!.confirmed!.quotes)).toBe(true);
    expect(sameMembers(optionSessions[0].trades, partial!.confirmed!.trades)).toBe(true);
  });

  test("fences an old SIP tick behind a later REST snapshot after a Rust reconnect", async ({ page, request }) => {
    test.setTimeout(150_000);
    await observeOneBrowserStream(page);
    await authenticateThroughOidc(page, request);

    const quotePanel = page.locator(".terminal-panel").filter({ hasText: "Invesco QQQ Trust" });
    await expect(quotePanel).toContainText("Alpaca SIP", { timeout: 30_000 });
    let initialStatus: FeedStatus | null = null;
    await expect.poll(async () => {
      initialStatus = await latestFeedStatus(page, "stocks");
      return Boolean(initialStatus?.desired.quotes.includes("QQQ") &&
        initialStatus.confirmed?.quotes.includes("QQQ"));
    }, { timeout: 25_000 }).toBe(true);
    expect(initialStatus).not.toBeNull();
    await expect.poll(async () => {
      const state = await currentOfflineState(request);
      return state.sessions.some((session) => session.feed === "stocks" && session.authenticated && session.quotes.includes("QQQ"));
    }, { timeout: 20_000 }).toBe(true);

    const live = await alpacaControl<{ delivered: number }>(request, "/__control/emit", {
      feed: "stocks",
      record: { kind: "stock_trade", symbol: "QQQ", timestamp: rfc3339At(0), price: 602.75, size: 2 },
    });
    expect(live.delivered).toBeGreaterThan(0);
    await expect(quotePanel.locator(".text-xl")).toContainText("602.75", { timeout: 10_000 });
    await expect(quotePanel).toContainText("PRICE FRESH · LIVE");

    await alpacaControl(request, "/__control/disconnect", { feed: "stocks" });
    await expect.poll(async () => {
      const status = await latestFeedStatus(page, "stocks");
      return Boolean(status && status.connection_epoch > initialStatus!.connection_epoch);
    }, { timeout: 30_000 }).toBe(true);

    const snapshotTime = new Date(Date.now()).toISOString();
    await alpacaControl(request, "/__control/config", {
      ack_mode: "full",
      stock_trade_at: snapshotTime,
      stock_quote_at: snapshotTime,
      stock_daily_bar_at: new Date(Date.now() - 86_400_000).toISOString(),
      stock_previous_daily_bar_at: new Date(Date.now() - 172_800_000).toISOString(),
    });
    let refreshedRows: Array<Record<string, unknown>> = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname !== "/api/quotes" || !response.ok()) return;
      const value: unknown = await response.json().catch(() => null);
      if (Array.isArray(value)) {
        const rows = value.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
        const row = rows.find((item) => item.symbol === "QQQ");
        const watermarks = row?.watermarks as Array<Record<string, unknown>> | undefined;
        const trade = watermarks?.find((watermark) =>
          Array.isArray(watermark.event_types) && watermark.event_types.includes("trade"));
        if (row && Date.parse(String(row.tradeAt)) === Date.parse(snapshotTime) &&
            typeof trade?.connection_epoch === "number" && trade.connection_epoch > initialStatus!.connection_epoch) {
          refreshedRows = rows;
        }
      }
    });
    await expect.poll(async () => {
      const row = refreshedRows.find((item) => item.symbol === "QQQ");
      const watermarks = row?.watermarks as Array<Record<string, unknown>> | undefined;
      const trade = watermarks?.find((watermark) =>
        Array.isArray(watermark.event_types) && watermark.event_types.includes("trade"));
      return Boolean(row && Date.parse(String(row.tradeAt)) === Date.parse(snapshotTime) &&
        typeof trade?.connection_epoch === "number" && trade.connection_epoch > initialStatus!.connection_epoch);
    }, { timeout: 40_000 }).toBe(true);
    const refreshedQuote = page.locator(".terminal-panel").filter({ hasText: "Invesco QQQ Trust" });
    const snapshot = refreshedRows.find((item) => item.symbol === "QQQ")!;
    expect(snapshot.source).toBe("Alpaca SIP");
    expect(snapshot.price).toBe(600.12);
    expect(Date.parse(String(snapshot.tradeAt))).toBe(Date.parse(snapshotTime));
    const tradeWatermark = (snapshot.watermarks as Array<Record<string, unknown>>).find((watermark) =>
      Array.isArray(watermark.event_types) && watermark.event_types.includes("trade"));
    expect(tradeWatermark).toBeDefined();
    expect(tradeWatermark!.feed).toBe("stocks");
    expect((tradeWatermark!.symbols as string[])).toContain("QQQ");
    expect(Number.isSafeInteger(tradeWatermark!.local_sequence)).toBe(true);
    expect(tradeWatermark!.request_start_sequence === null ||
      Number.isSafeInteger(tradeWatermark!.request_start_sequence)).toBe(true);
    expect(tradeWatermark!.connection_epoch).toBeGreaterThan(initialStatus!.connection_epoch);
    await expect(refreshedQuote.locator(".text-xl")).toContainText("600.12");
    await expect(refreshedQuote).toContainText("REST snapshot");
    await expect.poll(async () => {
      const status = await latestFeedStatus(page, "stocks");
      return Boolean(status && status.connection_epoch > initialStatus!.connection_epoch &&
        status.desired.quotes.includes("QQQ"));
    }, { timeout: 25_000 }).toBe(true);

    await expect.poll(async () => {
      const state = await currentOfflineState(request);
      return state.sessions.some((session) => session.feed === "stocks" && session.authenticated &&
        session.quotes.includes("QQQ") && session.trades.includes("QQQ"));
    }, { timeout: 25_000 }).toBe(true);
    await expect(page.locator('[data-testid="market-feed-status-stocks"]'))
      .toContainText("Browser SSE connected");
    const statusBeforeOldTick = await latestFeedStatus(page, "stocks");
    expect(statusBeforeOldTick).not.toBeNull();
    const old = await alpacaControl<{ delivered: number }>(request, "/__control/emit", {
      feed: "stocks",
      record: {
        kind: "stock_trade", symbol: "QQQ",
        timestamp: new Date(Date.parse(snapshotTime) - 5_000).toISOString(), price: 699.99, size: 1,
      },
    });
    expect(old.delivered).toBeGreaterThan(0);
    let oldStockEventPublished = false;
    await expect.poll(async () => {
      const status = await latestFeedStatus(page, "stocks");
      const events = await observedEvents(page);
      oldStockEventPublished = events.some((event) => event && typeof event === "object" &&
        (event as { kind?: string; symbol?: string; price?: number }).kind === "stock_trade" &&
        (event as { symbol?: string }).symbol === "QQQ" && (event as { price?: number }).price === 699.99);
      return Boolean(status && status.out_of_order_count > statusBeforeOldTick!.out_of_order_count) ||
        oldStockEventPublished;
    }, { timeout: 10_000 }).toBe(true);
    if (oldStockEventPublished) {
      const oldStockEvent = [...await observedEvents(page)].reverse().find((event) => event && typeof event === "object" &&
        (event as { kind?: string; symbol?: string; price?: number }).kind === "stock_trade" &&
        (event as { symbol?: string }).symbol === "QQQ" && (event as { price?: number }).price === 699.99) as
        { event_time?: string | null; connection_epoch?: number; local_sequence?: number } | undefined;
      expect(oldStockEvent?.event_time).not.toBeNull();
      expect(Date.parse(oldStockEvent!.event_time!)).toBeLessThan(Date.parse(snapshotTime));
      expect(oldStockEvent?.connection_epoch).toBe(tradeWatermark!.connection_epoch);
      expect(oldStockEvent?.local_sequence).toBeGreaterThan(Number(tradeWatermark!.local_sequence));
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
    }
    await expect(refreshedQuote.locator(".text-xl")).toContainText("600.12");
    await expect(refreshedQuote).not.toContainText("PRICE FRESH · LIVE");

    const browserStreams = await page.evaluate(() => {
      const value = (window as unknown as { __eqoRustMarketObservation?: { urls: string[] } })
        .__eqoRustMarketObservation;
      return value?.urls.filter((url) => url.includes("/api/eqo/live")).length ?? 0;
    });
    expect(browserStreams).toBe(1);
  });
});
