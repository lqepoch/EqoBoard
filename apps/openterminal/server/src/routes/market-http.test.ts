import { createServer, request as httpRequest, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import { requireDelegatedPrincipal, requireResearchScopeForPath, requireResearchServiceKey } from "../auth.js";
import { createMarketRouter, marketRouter } from "./market.js";

const secret = "test-market-data-signing-secret-with-at-least-sixty-four-characters";
const serviceKey = "test-research-service-key-at-least-thirty-two-characters";
const observed: string[] = [];

async function delegatedJwt(scopes: string[] = ["market:read"], subject = "market-reader-1"): Promise<string> {
  return new SignJWT({ idp_iss: "https://idp.test/", scope: scopes, jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256", kid: "research-bff" })
    .setIssuer("eqoboard-openterminal")
    .setAudience("openterminal-research")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));
}

async function startServer(router = marketRouter, authenticate = true): Promise<{ server: Server; url: string }> {
  const app = express();
  if (authenticate) {
    app.use("/api", requireResearchServiceKey, requireDelegatedPrincipal, requireResearchScopeForPath, router);
  } else {
    app.use("/api", router);
  }
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function getJson(
  url: string,
  token?: string,
  additionalHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any; retryAfter: string | undefined }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...additionalHeaders };
    if (token) {
      headers.authorization = `Bearer ${token}`;
      headers["x-api-key"] = serviceKey;
    }
    const request = httpRequest(url, { method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: text ? JSON.parse(text) : null,
          retryAfter: response.headers["retry-after"],
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

describe("GET /api/heatmap real HTTP source contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    observed.length = 0;
  });

  it("uses signed market:read identity, SIP values, and never falls back after HTTP 403", async () => {
    vi.stubEnv("EQO_RESEARCH_API_KEY", serviceKey);
    vi.stubEnv("EQO_RESEARCH_JWT_SECRET", secret);
    vi.stubEnv("EQO_RUST_URL", "http://rust-mock.test");
    const token = await delegatedJwt();
    let rustStatus = 403;
    let sourceMode: "alpaca" | "offline_mock" = "alpaca";
    let emptySnapshot = false;
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      observed.push(`${url.hostname}${url.pathname}`);
      if (url.hostname === "scanner.tradingview.com") {
        return Response.json({ data: [{
          s: "NASDAQ:QQQ",
          d: ["QQQ ETF", 999, 88, 1_000_000_000_000, "Technology", 99_999, "NASDAQ"],
        }] });
      }
      if (url.hostname === "rust-mock.test") {
        const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
        expect(authorization?.startsWith("Bearer ")).toBe(true);
        const serviceToken = authorization!.slice("Bearer ".length);
        const verified = await jwtVerify(serviceToken, new TextEncoder().encode(secret), {
          algorithms: ["HS256"], issuer: "openterminal-research", audience: "eqoboard-gateway",
        });
        expect(verified.payload.sub).toBe("market-reader-1");
        expect(verified.payload.idp_iss).toBe("https://idp.test/");
        expect(verified.payload.scope).toEqual(["market:read"]);
        expect(url.pathname).toBe("/api/v1/stocks/snapshots");
        expect(url.searchParams.get("symbols")).toBe("QQQ");
        if (rustStatus === 403) return Response.json({ error: "not entitled" }, { status: 403 });
        return Response.json({
          feed: "sip",
          source_mode: sourceMode,
          source_label: sourceMode === "alpaca" ? "Alpaca SIP" : "OFFLINE MOCK — NOT MARKET DATA",
          watermark: { connection_epoch: 4, request_start_sequence: 10, local_sequence: 12 },
          snapshots: [{
            symbol: "QQQ", last: emptySnapshot ? null : 200,
            source_mode: sourceMode,
            source_label: sourceMode === "alpaca" ? "Alpaca SIP" : "OFFLINE MOCK — NOT MARKET DATA",
            previous_close: emptySnapshot ? null : 198,
            change_percent: emptySnapshot ? null : 1.0101,
            open: emptySnapshot ? null : 199, high: emptySnapshot ? null : 201,
            low: emptySnapshot ? null : 197, bid: emptySnapshot ? null : 199.99,
            ask: emptySnapshot ? null : 200.01, volume: emptySnapshot ? null : 123456,
            quote_at: emptySnapshot ? null : "2026-10-07T14:29:59.123456789Z",
            trade_at: emptySnapshot ? null : "2026-10-07T14:30:00.123456789Z",
            daily_bar_at: emptySnapshot ? null : "2026-10-07T20:00:00Z",
            previous_daily_bar_at: emptySnapshot ? null : "2026-10-06T20:00:00Z",
            last_as_of: emptySnapshot ? null : "2026-10-07T14:30:00.123456789Z",
            last_basis: emptySnapshot ? "unknown" : "trade",
            updated_at: emptySnapshot ? null : "2026-10-07T14:30:00.123456789Z",
          }],
        });
      }
      throw new Error(`unexpected public price fallback ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal("fetch", upstream);
    const { server, url } = await startServer();
    try {
      const anonymous = await getJson(`${url}/api/heatmap?market=us`);
      expect(anonymous.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();

      const denied = await getJson(`${url}/api/heatmap?market=us`, token);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ source: "Alpaca SIP", status: 403 });
      expect(upstream.mock.calls.map(([input]) => new URL(String(input)).hostname)).toEqual([
        "scanner.tradingview.com", "rust-mock.test",
      ]);

      rustStatus = 200;
      const accepted = await getJson(`${url}/api/heatmap?market=us`, token);
      expect(accepted.status).toBe(200);
      expect(accepted.body.source).toBe("TradingView metadata + Alpaca SIP prices");
      expect(accepted.body).toMatchObject({ source_mode: "alpaca", source_label: "Alpaca SIP" });
      expect(accepted.body.asOf).toBe("2026-10-07T14:30:00.123456789Z");
      expect(accepted.body.coverage).toEqual({ requested: 1, snapshots: 1, priced: 1,
        snapshotComplete: true, priceComplete: true, timeComplete: true, complete: true });
      expect(accepted.body.rows[0]).toMatchObject({
        symbol: "QQQ", name: "QQQ ETF", marketCap: 1_000_000_000_000, sector: "Technology",
        price: 200, changePercent: 1.0101, volume: 123456, priceSource: "Alpaca SIP",
        source_mode: "alpaca", source_label: "Alpaca SIP",
        priceAsOf: "2026-10-07T14:30:00.123456789Z", marketCapSource: "TradingView scanner",
      });
      expect(accepted.body.rows[0].price).not.toBe(999);
      expect(accepted.body.rows[0].changePercent).not.toBe(88);
      expect(accepted.body.rows[0].volume).not.toBe(99_999);
      const quote = await getJson(`${url}/api/quotes?symbols=QQQ`, token);
      expect(quote.status).toBe(200);
      expect(quote.body[0]).toMatchObject({
        source: "Alpaca SIP", source_mode: "alpaca", source_label: "Alpaca SIP",
        quoteAt: "2026-10-07T14:29:59.123456789Z",
      });
      expect(upstream.mock.calls.filter(([input]) => new URL(String(input)).hostname === "rust-mock.test")).toHaveLength(2);
      expect(upstream.mock.calls.every(([input]) => ["scanner.tradingview.com", "rust-mock.test"].includes(new URL(String(input)).hostname))).toBe(true);

      // A returned record with no price/time is not complete market coverage.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      sourceMode = "offline_mock";
      emptySnapshot = true;
      const empty = await getJson(`${url}/api/heatmap?market=us`, token);
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({
        source_mode: "offline_mock", source_label: "OFFLINE MOCK — NOT MARKET DATA",
      });
      expect(empty.body.coverage).toEqual({ requested: 1, snapshots: 1, priced: 0,
        snapshotComplete: true, priceComplete: false, timeComplete: false, complete: false });
      expect(empty.body.asOf).toBeNull();
      expect(empty.body.rows[0]).toMatchObject({
        price: null, changePercent: null, volume: null, priceAsOf: null,
        priceSource: "OFFLINE MOCK — NOT MARKET DATA", source_mode: "offline_mock",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("closes the legacy U.S. options route without public-provider fallback", async () => {
    vi.stubEnv("EQO_RESEARCH_API_KEY", serviceKey);
    vi.stubEnv("EQO_RESEARCH_JWT_SECRET", secret);
    const token = await delegatedJwt(["research:read"]);
    const upstream = vi.fn(async () => {
      throw new Error("unexpected public option provider request");
    });
    vi.stubGlobal("fetch", upstream);
    const { server, url } = await startServer();
    try {
      const response = await getJson(`${url}/api/options/QQQ?expiry=2026-11-13`, token);
      expect(response.status).toBe(410);
      expect(response.body).toMatchObject({
        code: "us_options_require_gateway",
        source: "Alpaca OPRA",
        route: "/api/v1/options/chain",
      });
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps plain BTC on SIP while only BTC-USD uses Binance in generic HTTP routes", async () => {
    vi.stubEnv("EQO_RESEARCH_API_KEY", serviceKey);
    vi.stubEnv("EQO_RESEARCH_JWT_SECRET", secret);
    vi.stubEnv("EQO_RUST_URL", "http://rust-mock.test");
    const token = await delegatedJwt();
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      observed.push(`${url.hostname}${url.pathname}`);
      if (url.hostname === "rust-mock.test" && url.pathname === "/api/v1/stocks/snapshots") {
        expect(url.searchParams.get("symbols")).toBe("BTC");
        return Response.json({ error: "SIP unavailable" }, { status: 403 });
      }
      if (url.hostname === "rust-mock.test" && url.pathname === "/api/v1/stocks/bars") {
        expect(url.searchParams.get("symbol")).toBe("BTC");
        return Response.json({ error: "SIP unavailable" }, { status: 403 });
      }
      if (url.hostname === "api.binance.com" && url.pathname === "/api/v3/ticker/24hr") {
        expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
        return Response.json({
          lastPrice: "65000", priceChange: "100", priceChangePercent: "0.15",
          openPrice: "64900", highPrice: "65100", lowPrice: "64800", prevClosePrice: "64900",
          bidPrice: "64999", askPrice: "65001", volume: "25",
        });
      }
      if (url.hostname === "api.binance.com" && url.pathname === "/api/v3/klines") {
        expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
        return Response.json([[1_791_317_400_000, "64900", "65100", "64800", "65000", "25"]]);
      }
      throw new Error(`unexpected non-authoritative market provider ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal("fetch", upstream);
    const { server, url } = await startServer();
    try {
      const plainQuote = await getJson(`${url}/api/quotes?symbols=BTC`, token);
      expect(plainQuote.status).toBe(403);
      expect(plainQuote.body).toMatchObject({ source: "Alpaca SIP", status: 403 });
      const plainHistory = await getJson(`${url}/api/history/BTC?range=1M`, token);
      expect(plainHistory.status).toBe(403);
      expect(plainHistory.body).toMatchObject({ source: "Alpaca SIP", status: 403 });

      const explicitQuote = await getJson(`${url}/api/quotes?symbols=BTC-USD`, token);
      expect(explicitQuote.status).toBe(200);
      expect(explicitQuote.body[0]).toMatchObject({ symbol: "BTC-USD", source: "binance", price: 65_000 });
      const explicitHistory = await getJson(`${url}/api/history/BTC-USD?range=1M`, token);
      expect(explicitHistory.status).toBe(200);
      expect(explicitHistory.body.source).toBe("Binance");
      expect(upstream.mock.calls.map(([input]) => {
        const requestUrl = new URL(String(input));
        return `${requestUrl.hostname}${requestUrl.pathname}`;
      })).toEqual([
        "rust-mock.test/api/v1/stocks/snapshots",
        "rust-mock.test/api/v1/stocks/bars",
        "api.binance.com/api/v3/ticker/24hr",
        "api.binance.com/api/v3/klines",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("routes U.S. history and earnings price movement through SIP while keeping EPS attribution separate", async () => {
    vi.stubEnv("EQO_RESEARCH_API_KEY", serviceKey);
    vi.stubEnv("EQO_RESEARCH_JWT_SECRET", secret);
    vi.stubEnv("EQO_RUST_URL", "http://rust-mock.test");
    const token = await delegatedJwt();
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      observed.push(`${url.hostname}${url.pathname}`);
      if (url.hostname === "rust-mock.test" && url.pathname === "/api/v1/stocks/bars") {
        expect(url.searchParams.get("timeframe")).toBe(url.searchParams.get("symbol") === "NVDA" ? "1Hour" : "1Day");
        return Response.json({ feed: "sip", source_mode: "alpaca", source_label: "Alpaca SIP",
          watermark: { connection_epoch: 5, request_start_sequence: 2, local_sequence: 4 }, bars: [
          { time: "2026-10-05T20:00:00Z", open: 100, high: 103, low: 99, close: 101, volume: 1200,
            source_mode: "alpaca", source_label: "Alpaca SIP" },
          { time: "2026-10-06T20:00:00Z", open: 101, high: 104, low: 100, close: 103, volume: 1500,
            source_mode: "alpaca", source_label: "Alpaca SIP" },
        ] });
      }
      if (url.hostname === "api.nasdaq.com" && url.pathname === "/api/company/AAPL/earnings-surprise") {
        return Response.json({ data: { earningsSurpriseTable: { rows: [
          { fiscalQtrEnd: "2026-09-30", dateReported: "10/5/2026", eps: "1.25", consensusForecast: "1.20", percentageSurprise: "4.2%" },
        ] } } });
      }
      throw new Error(`unexpected price provider ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal("fetch", upstream);
    const { server, url } = await startServer();
    try {
      const history = await getJson(`${url}/api/history/NVDA?range=1M`, token);
      expect(history.status).toBe(200);
      expect(history.body.source).toBe("Alpaca SIP");
      expect(history.body).toMatchObject({ source_mode: "alpaca", source_label: "Alpaca SIP" });
      expect(history.body.bars.at(-1)).toMatchObject({ close: 103, volume: 1500 });

      const earnings = await getJson(`${url}/api/earnings-history/AAPL`, token);
      expect(earnings.status).toBe(200);
      expect(earnings.body[0]).toMatchObject({
        surpriseSource: "Nasdaq",
        priceMoveSource: "Alpaca SIP",
        dayAfterChangePercent: expect.any(Number),
      });
      expect(earnings.body[0].surpriseAsOf).toBe("2026-10-05T00:00:00.000Z");
      expect(earnings.body[0].priceMoveAsOf).toBe("2026-10-06T20:00:00Z");
      expect(observed).toEqual([
        "rust-mock.test/api/v1/stocks/bars",
        "api.nasdaq.com/api/company/AAPL/earnings-surprise",
        "rust-mock.test/api/v1/stocks/bars",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("GET /api/quotes upstream SIP authorization and throttling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    observed.length = 0;
  });

  it("rejects a request without a verified owner before calling a provider", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { server, url } = await startServer(createMarketRouter(), false);
    try {
      const response = await getJson(`${url}/api/quotes?symbols=QQQ`);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "verified_identity_required" });
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    { upstreamStatus: 401, symbol: "EQA401" },
    { upstreamStatus: 429, symbol: "EQA429" },
  ])("returns authenticated upstream HTTP $upstreamStatus with no price fallback", async ({ upstreamStatus, symbol }) => {
    vi.stubEnv("EQO_RESEARCH_API_KEY", serviceKey);
    vi.stubEnv("EQO_RESEARCH_JWT_SECRET", secret);
    vi.stubEnv("EQO_RUST_URL", "http://rust-mock.test");
    const token = await delegatedJwt();
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      observed.push(`${url.hostname}${url.pathname}`);
      expect(url.hostname).toBe("rust-mock.test");
      expect(url.pathname).toBe("/api/v1/stocks/snapshots");
      expect(url.searchParams.get("symbols")).toBe(symbol);
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(authorization?.startsWith("Bearer ")).toBe(true);
      const delegated = await jwtVerify(authorization!.slice("Bearer ".length), new TextEncoder().encode(secret), {
        algorithms: ["HS256"], issuer: "openterminal-research", audience: "eqoboard-gateway",
      });
      expect(delegated.payload.sub).toBe("market-reader-1");
      expect(delegated.payload.scope).toEqual(["market:read"]);
      return Response.json({ error: "upstream unavailable" }, { status: upstreamStatus });
    });
    vi.stubGlobal("fetch", upstream);
    const { server, url } = await startServer();
    try {
      const anonymous = await getJson(`${url}/api/quotes?symbols=${symbol}`);
      expect(anonymous.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();

      const authenticated = await getJson(`${url}/api/quotes?symbols=${symbol}`, token);
      expect(authenticated.status).toBe(upstreamStatus);
      expect(authenticated.body).toMatchObject({
        error: upstreamStatus === 401 ? "Alpaca SIP market-data authentication failed (HTTP 401)"
          : "Alpaca SIP market-data rate limit exceeded (HTTP 429)",
        source: "Alpaca SIP",
        status: upstreamStatus,
      });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(observed).toEqual(["rust-mock.test/api/v1/stocks/snapshots"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("limits SIP HTTP routes by verified owner and service, not forwarded headers, before extra Rust dispatch", async () => {
    vi.stubEnv("EQO_RESEARCH_API_KEY", serviceKey);
    vi.stubEnv("EQO_RESEARCH_JWT_SECRET", secret);
    vi.stubEnv("EQO_RUST_URL", "http://rust-mock.test");
    const ownerA = `market-owner-a-${crypto.randomUUID()}`;
    const ownerB = `market-owner-b-${crypto.randomUUID()}`;
    const tokenA = await delegatedJwt(["market:read"], ownerA);
    const tokenB = await delegatedJwt(["market:read"], ownerB);
    const upstream = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      observed.push(`${url.hostname}${url.pathname}`);
      expect(url.hostname).toBe("rust-mock.test");
      expect(url.pathname).toBe("/api/v1/stocks/snapshots");
      return Response.json({ feed: "sip", snapshots: [] });
    });
    vi.stubGlobal("fetch", upstream);
    const router = createMarketRouter({ windowMs: 60_000, ownerLimit: 2, serviceLimit: 3 });
    const { server, url } = await startServer(router);
    const ticker = (index: number) => `R${crypto.randomUUID().replaceAll("-", "").slice(0, 4)}${index}`;
    try {
      const first = await getJson(`${url}/api/quotes?symbols=${ticker(1)}`, tokenA, { "x-forwarded-for": "198.51.100.1" });
      const second = await getJson(`${url}/api/quotes?symbols=${ticker(2)}`, tokenA, { "x-forwarded-for": "198.51.100.2" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const ownerLimited = await getJson(`${url}/api/quotes?symbols=${ticker(3)}`, tokenA, { "x-forwarded-for": "198.51.100.3" });
      expect(ownerLimited.status).toBe(429);
      expect(ownerLimited.body).toMatchObject({ error: "rate_limit_exceeded" });
      expect(Number(ownerLimited.retryAfter)).toBeGreaterThan(0);

      // A different verified owner gets a separate user bucket despite using
      // the same forwarded address; the process cap still applies to all users.
      const otherOwner = await getJson(`${url}/api/quotes?symbols=${ticker(4)}`, tokenB, { "x-forwarded-for": "198.51.100.1" });
      expect(otherOwner.status).toBe(200);
      const serviceLimited = await getJson(`${url}/api/quotes?symbols=${ticker(5)}`, tokenB, { "x-forwarded-for": "203.0.113.99" });
      expect(serviceLimited.status).toBe(429);
      expect(serviceLimited.body).toMatchObject({ error: "rate_limit_exceeded" });
      expect(Number(serviceLimited.retryAfter)).toBeGreaterThan(0);
      expect(upstream).toHaveBeenCalledTimes(3);
      expect(observed).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
