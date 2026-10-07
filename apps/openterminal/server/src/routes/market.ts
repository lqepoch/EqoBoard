import { Router, type Request } from "express";
import { cached } from "../cache.js";
import { getGatewayAuthorization, type VerifiedPrincipal } from "../auth.js";
import { withFallback } from "../providers/registry.js";
import * as yahoo from "../providers/yahoo.js";
import * as stooq from "../providers/stooq.js";
import * as nasdaq from "../providers/nasdaq.js";
import * as fred from "../providers/fred.js";
import * as ecb from "../providers/ecb.js";
import * as tradingview from "../providers/tradingview.js";
import * as coingecko from "../providers/coingecko.js";
import * as binance from "../providers/binance.js";
import * as news from "../providers/news.js";
import * as econcalendar from "../providers/econcalendar.js";
import * as finra from "../providers/finra.js";
import * as secedgar from "../providers/secedgar.js";
import { sipBars, sipSnapshots, SipGatewayError, type SipSnapshot } from "../providers/eqo-sip.js";
import { isExplicitCryptoSymbol, usesSIPEquitySymbol } from "../providers/market-symbol.js";
import { latestRfc3339Nanos } from "../providers/market-time.js";
import { splitSnapshotWatermarks } from "../providers/snapshot-watermarks.js";

export const marketRouter = Router();

const QUOTE_TTL = 1_000;
const RESEARCH_HISTORY_TTL = 300_000;
const NEWS_TTL = 60_000;

function fail(req: any, res: any, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[market]", req.path, detail);
  if (err instanceof SipGatewayError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({
      error: status === 403 ? "Alpaca SIP market data is not authorized" : "Alpaca SIP market data is unavailable",
      source: "Alpaca SIP",
      status,
    });
  }
  res.status(502).json({ error: "All data providers are temporarily unavailable. Try again shortly." });
}

async function sipAuthorization(req: Request): Promise<string> {
  const principal = req.verifiedPrincipal as VerifiedPrincipal | undefined;
  if (!principal) throw new SipGatewayError(401, "A verified user identity is required");
  if (!principal.scopes.includes("market:read")) throw new SipGatewayError(403, "market:read is required");
  try {
    return `Bearer ${await getGatewayAuthorization(principal, "market:read")}`;
  } catch {
    throw new SipGatewayError(503, "The delegated SIP identity is unavailable");
  }
}

// ---- VIX: served from FRED (daily close), since it's an index rather than a
// tradable stock/ETF — Nasdaq's stock API doesn't carry it, and routing it
// through Yahoo would make it depend on Yahoo's flaky rate limits for no reason.

function isVix(symbol: string): boolean {
  return symbol.toUpperCase() === "^VIX" || symbol.toUpperCase() === "VIX";
}

async function vixQuote(): Promise<yahoo.Quote> {
  const points = await fred.series("VIXCLS", 5);
  if (points.length === 0) throw new Error("fred: no VIX data");
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const price = last.value;
  const previousClose = prev?.value ?? null;
  const change = previousClose !== null ? price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  return {
    symbol: "^VIX",
    name: "CBOE Volatility Index",
    price,
    change,
    changePercent,
    open: null,
    high: null,
    low: null,
    previousClose,
    bid: null,
    ask: null,
    volume: null,
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
    exchange: "CBOE",
    marketState: null,
    time: null,
    source: "FRED",
    asOf: last.date,
  };
}

const VIX_RANGE_N: Record<string, number> = {
  "1D": 5,
  "5D": 5,
  "1M": 22,
  "6M": 130,
  YTD: 200,
  "1Y": 252,
  "5Y": 1260,
  MAX: 20_000,
};

async function vixHistory(rangeKey: string): Promise<yahoo.Candle[]> {
  const n = VIX_RANGE_N[rangeKey] ?? 130;
  const points = await fred.series("VIXCLS", n);
  return points.map((p) => {
    const time = Math.floor(new Date(p.date + "T00:00:00Z").getTime() / 1000);
    return { time, open: p.value, high: p.value, low: p.value, close: p.value, volume: 0 };
  });
}

// ---- quotes: U.S. prices are exclusively SIP; research instruments keep their provider ----

type SourcedQuote = yahoo.Quote & {
  fundamentalSource?: string;
  fundamentalAsOf?: string | null;
  quoteAt?: string | null;
  tradeAt?: string | null;
  dailyBarAt?: string | null;
  previousDailyBarAt?: string | null;
  lastAsOf?: string | null;
  lastBasis?: "trade" | "daily_bar" | "unknown" | null;
  watermarks?: ReturnType<typeof splitSnapshotWatermarks>;
};

function unavailableQuote(symbol: string, source: string): SourcedQuote {
  return {
    symbol, name: null, price: null, change: null, changePercent: null, open: null, high: null, low: null,
    previousClose: null, bid: null, ask: null, volume: null, avgVolume: null, marketCap: null, pe: null,
    eps: null, dividendYield: null, week52High: null, week52Low: null, beta: null,
    sharesOutstanding: null, currency: null, exchange: null, marketState: null, time: null,
    source, asOf: null, quoteAt: null, tradeAt: null, dailyBarAt: null, previousDailyBarAt: null,
    lastAsOf: null, lastBasis: "unknown", watermarks: [],
  };
}

function quoteFromSip(snapshot: SipSnapshot): SourcedQuote {
  const price = snapshot.last;
  const previousClose = snapshot.previous_close;
  const changed = price !== null && previousClose !== null ? price - previousClose : null;
  const time = snapshot.last_as_of ? Date.parse(snapshot.last_as_of) : Number.NaN;
  const watermarks = splitSnapshotWatermarks("stocks", snapshot.watermark, [{
    symbol: snapshot.symbol,
    quote_at: snapshot.quote_at,
    trade_at: snapshot.trade_at ?? (snapshot.last_basis === "trade" ? snapshot.updated_at : null),
  }]);
  return {
    ...unavailableQuote(snapshot.symbol, "Alpaca SIP"),
    price,
    previousClose,
    change: changed,
    changePercent: snapshot.change_percent,
    open: snapshot.open,
    high: snapshot.high,
    low: snapshot.low,
    bid: snapshot.bid,
    ask: snapshot.ask,
    volume: snapshot.volume,
    currency: "USD",
    time: Number.isFinite(time) ? Math.floor(time / 1000) : null,
    asOf: snapshot.last_as_of ?? null,
    quoteAt: snapshot.quote_at ?? null,
    tradeAt: snapshot.trade_at ?? snapshot.updated_at ?? null,
    dailyBarAt: snapshot.daily_bar_at ?? null,
    previousDailyBarAt: snapshot.previous_daily_bar_at ?? null,
    lastAsOf: snapshot.last_as_of ?? null,
    lastBasis: snapshot.last_basis ?? "unknown",
    watermarks,
  };
}

async function getResearchQuote(symbol: string): Promise<yahoo.Quote> {
  return cached(`quote:research:${symbol}`, QUOTE_TTL, async () => {
    const quote = await withFallback([
      ["Yahoo Finance", async () => {
        const rows = await yahoo.quotes([symbol]);
        if (!rows[0]) throw new Error("Yahoo Finance returned no quote");
        return rows[0];
      }],
      ["Yahoo Finance chart", () => yahoo.quoteFromChart(symbol)],
      ["Stooq", () => stooq.quote(symbol)],
    ]);
    return { ...quote, asOf: quote.time === null ? null : new Date(quote.time * 1000).toISOString() };
  });
}

async function getQuotes(symbols: string[], authorization: string): Promise<SourcedQuote[]> {
  const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
  const vixSymbols = unique.filter((symbol) => isVix(symbol));
  const sipSymbols = unique.filter((symbol) => !isVix(symbol) && usesSIPEquitySymbol(symbol));
  const cryptoSymbols = unique.filter(isExplicitCryptoSymbol);
  const sipOrCrypto = new Set([...sipSymbols, ...cryptoSymbols]);
  const researchSymbols = unique.filter((symbol) => !sipOrCrypto.has(symbol) && !isVix(symbol));
  const resolved = new Map<string, SourcedQuote>();

  // A denied or unavailable SIP request is allowed to fail the whole request;
  // never fill the same U.S. symbol from a public fallback or stale cache.
  if (sipSymbols.length > 0) {
    const snapshots = await sipSnapshots(sipSymbols, authorization);
    const bySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
    for (const symbol of sipSymbols) {
      const snapshot = bySymbol.get(symbol);
      resolved.set(symbol, snapshot ? quoteFromSip(snapshot) : unavailableQuote(symbol, "Alpaca SIP"));
    }
  }

  const cryptoResults = await Promise.allSettled(cryptoSymbols.map((symbol) => binance.quote(symbol)));
  cryptoResults.forEach((result, index) => {
    const symbol = cryptoSymbols[index];
    resolved.set(symbol, result.status === "fulfilled" ? result.value : unavailableQuote(symbol, "Binance"));
  });

  const vixResults = await Promise.allSettled(vixSymbols.map(() => vixQuote()));
  vixResults.forEach((result, index) => {
    const symbol = vixSymbols[index];
    resolved.set(symbol, result.status === "fulfilled"
      ? { ...result.value, symbol }
      : unavailableQuote(symbol, "FRED VIXCLS"));
  });

  const researchResults = await Promise.allSettled(researchSymbols.map((symbol) => getResearchQuote(symbol)));
  researchResults.forEach((result, index) => {
    const symbol = researchSymbols[index];
    resolved.set(symbol, result.status === "fulfilled" ? result.value : unavailableQuote(symbol, "Yahoo Finance / Stooq"));
  });

  return unique.map((symbol) => resolved.get(symbol) ?? unavailableQuote(symbol, "source unavailable"));
}

marketRouter.get("/quotes", async (req, res) => {
  const symbols = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 150);
  if (symbols.length === 0) return res.status(400).json({ error: "symbols required" });
  try {
    const authorization = await sipAuthorization(req);
    const data = await getQuotes(symbols, authorization);
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- history / candles ----

marketRouter.get("/history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const rangeKey = String(req.query.range ?? "6M");
  try {
    if (usesSIPEquitySymbol(symbol)) {
      const authorization = await sipAuthorization(req);
      const range = SIP_HISTORY_RANGE[rangeKey] ?? SIP_HISTORY_RANGE["6M"];
      const snapshot = await sipBars(symbol, range.timeframe, range.limit, range.days, authorization);
      let bars = toChartBars(snapshot.bars);
      if (rangeKey === "YTD") {
        const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date());
        const firstDay = Date.parse(`${year}-01-01T00:00:00Z`) / 1000;
        bars = bars.filter((bar) => bar.time >= firstDay);
      }
      const data: HistoryEnvelope = { bars, source: "Alpaca SIP",
        asOf: bars.length ? new Date(bars[bars.length - 1]!.time * 1000).toISOString() : null,
        watermark: snapshot.watermark ?? null };
      if (data.bars.length === 0) throw new Error("Alpaca SIP returned no bars");
      return res.json(data);
    }

    const cacheKey = `history:research:${symbol}:${rangeKey}`;
    const data = await cached<HistoryEnvelope>(cacheKey, RESEARCH_HISTORY_TTL, async () => {
      if (isExplicitCryptoSymbol(symbol)) {
        const bars = await binance.history(symbol, rangeKey);
        return historyEnvelope(bars, "Binance");
      }
      if (isVix(symbol)) return historyEnvelope(await vixHistory(rangeKey), "FRED VIXCLS");
      const result = await namedFallback([
        ["Yahoo Finance", () => yahoo.history(symbol, yahooRange(rangeKey).range, yahooRange(rangeKey).interval)],
        ["Stooq", () => stooq.history(symbol)],
      ]);
      return historyEnvelope(result.data, result.source);
    });
    if (data.bars.length === 0) throw new Error(`No ${data.source} history available`);
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

type HistoryEnvelope = {
  bars: yahoo.Candle[];
  source: string;
  asOf: string | null;
  watermark?: { feed: "stocks"; connection_epoch: number; request_start_sequence?: number | null; local_sequence: number } | null;
};

const SIP_HISTORY_RANGE: Record<string, { timeframe: string; days: number; limit: number }> = {
  "1D": { timeframe: "1Min", days: 4, limit: 500 },
  "5D": { timeframe: "5Min", days: 14, limit: 500 },
  "1M": { timeframe: "1Hour", days: 45, limit: 500 },
  "6M": { timeframe: "1Day", days: 210, limit: 500 },
  YTD: { timeframe: "1Day", days: 380, limit: 500 },
  "1Y": { timeframe: "1Day", days: 390, limit: 500 },
  "5Y": { timeframe: "1Week", days: 1950, limit: 520 },
  MAX: { timeframe: "1Month", days: 10500, limit: 600 },
};

function toChartBars(bars: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>): yahoo.Candle[] {
  return bars.map((bar) => ({
    time: Math.floor(Date.parse(bar.time) / 1000), open: bar.open, high: bar.high,
    low: bar.low, close: bar.close, volume: bar.volume,
  })).filter((bar) => Number.isFinite(bar.time)).sort((left, right) => left.time - right.time);
}

function historyEnvelope(bars: yahoo.Candle[], source: string): HistoryEnvelope {
  const sorted = [...bars].sort((left, right) => left.time - right.time);
  return { bars: sorted, source, asOf: sorted.length ? new Date(sorted[sorted.length - 1]!.time * 1000).toISOString() : null };
}

async function namedFallback<T>(attempts: Array<[string, () => Promise<T>]>): Promise<{ source: string; data: T }> {
  let lastError: unknown = new Error("no research provider configured");
  for (const [source, load] of attempts) {
    try { return { source, data: await load() }; }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

function yahooRange(rangeKey: string): { range: string; interval: string } {
  const map: Record<string, { range: string; interval: string }> = {
    "1D": { range: "1d", interval: "5m" },
    "5D": { range: "5d", interval: "15m" },
    "1M": { range: "1mo", interval: "1h" },
    "6M": { range: "6mo", interval: "1d" },
    YTD: { range: "ytd", interval: "1d" },
    "1Y": { range: "1y", interval: "1d" },
    "5Y": { range: "5y", interval: "1wk" },
    MAX: { range: "max", interval: "1mo" },
  };
  return map[rangeKey] ?? map["6M"];
}

// ---- search ----

marketRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  try {
    const data = await cached(`search:${q.toLowerCase()}`, 300_000, () =>
      withFallback([
        ["tradingview", () => tradingview.search(q)],
        ["yahoo", () => yahoo.search(q)],
      ])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- news ----

marketRouter.get("/news", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  try {
    const data = await cached(`news:${symbol ?? "top"}`, NEWS_TTL, async () => {
      if (symbol) {
        const lists = await Promise.allSettled([news.symbolNews(symbol), news.topNews(symbol + " stock")]);
        const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
        if (ok.length === 0) throw new Error("all news sources failed");
        return news.dedupe(ok).slice(0, 40);
      }
      const lists = await Promise.allSettled([
        news.topNews("stock market"),
        news.topNews("federal reserve economy"),
      ]);
      const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
      if (ok.length === 0) throw new Error("all news sources failed");
      return news.dedupe(ok).slice(0, 40);
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- economic calendar (Fed / ECB / CPI / NFP with forecast + actual) ----

marketRouter.get("/econ-calendar", async (req, res) => {
  try {
    const data = await cached("econ-calendar", 900_000, () => econcalendar.weeklyEvents());
    res.json(data.map((event) => ({
      ...event,
      scheduleSource: "Forex Factory",
      scheduleAsOf: null,
      actualSource: event.actual === null ? null : "FRED",
      actualAsOf: null,
    })));
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- options ----

marketRouter.get("/options/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const expiry = req.query.expiry ? String(req.query.expiry) : undefined;
  if (usesSIPEquitySymbol(symbol)) {
    return res.status(410).json({
      error: "U.S. option chains are served by the authenticated Rust OPRA route",
      code: "us_options_require_gateway",
      source: "Alpaca OPRA",
      route: "/api/v1/options/chain",
    });
  }
  try {
    const result = await cached(`options:${symbol}:${expiry ?? "front"}`, 60_000, () =>
      namedFallback([
        ["Nasdaq", async () => ({ ...(await nasdaq.optionChain(symbol, expiry)), asOf: null })],
        [
          "Yahoo Finance",
          async () => {
            const y = await yahoo.options(symbol);
            return {
              symbol: y.symbol,
              underlyingPrice: y.underlyingPrice,
              expirationDates: y.expirationDates.map((d: number) => new Date(d * 1000).toISOString().slice(0, 10)),
              selectedDate: y.selectedDate ? new Date(y.selectedDate * 1000).toISOString().slice(0, 10) : null,
              calls: y.calls,
              puts: y.puts,
              asOf: null,
            };
          },
        ],
      ])
    );
    res.json({ ...result.data, source: result.source, asOf: null });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- crypto ----

marketRouter.get("/crypto", async (req, res) => {
  try {
    const data = await cached("crypto:markets", 5_000, () =>
      withFallback([
        ["coingecko", () => coingecko.markets(50)],
        ["binance", () => binance.markets()],
      ])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/global", async (req, res) => {
  try {
    const data = await cached("crypto:global", 120_000, () =>
      withFallback([["coingecko", () => coingecko.globalStats()]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/orderbook/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!binance.CRYPTO_SYMBOLS.has(symbol)) {
    return res.status(400).json({ error: "unsupported crypto symbol" });
  }
  try {
    const data = await cached(`orderbook:${symbol}`, 5_000, () =>
      withFallback([["binance", () => binance.orderBook(symbol)]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- macro: treasury yield curve (FRED) + key indexes via ETF proxies (Nasdaq) ----

const YIELD_SERIES: Array<{ id: string; tenor: string }> = [
  { id: "DGS3MO", tenor: "3M" },
  { id: "DGS5", tenor: "5Y" },
  { id: "DGS10", tenor: "10Y" },
  { id: "DGS30", tenor: "30Y" },
];

const INDEX_PROXIES: Record<string, string> = {
  SPY: "S&P 500 (SPY)",
  DIA: "Dow Jones (DIA)",
  QQQ: "Nasdaq 100 (QQQ)",
  IWM: "Russell 2000 (IWM)",
  GLD: "Gold (GLD)",
  USO: "WTI Crude (USO)",
  TLT: "20Y+ Treasury (TLT)",
  UUP: "Dollar Index (UUP)",
};

// ---- EU macro: ECB AAA euro-area yield curve + policy rate + HICP inflation,
// plus key European indexes via US-listed ETF proxies (same trick as the US
// index proxies above — Nasdaq/Yahoo already carry these tickers, so no new
// quote provider is needed).

const EU_YIELD_SERIES: Array<{ flowRef: string; key: string; tenor: string }> = [
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M", tenor: "3M" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_5Y", tenor: "5Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", tenor: "10Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_30Y", tenor: "30Y" },
];

// Deposit facility rate — the ECB's operative policy rate since the 2024
// operational framework review (not the main refinancing rate).
const EU_POLICY_RATE = { flowRef: "FM", key: "D.U2.EUR.4F.KR.DFR.LEV" };
const EU_INFLATION = { flowRef: "ICP", key: "M.U2.N.000000.4.ANR" }; // HICP, y/y

const EU_INDEX_PROXIES: Record<string, string> = {
  FEZ: "Euro Stoxx 50 (FEZ)",
  IEUR: "MSCI Europe (IEUR)",
  EWG: "Germany (EWG)",
  EWU: "UK (EWU)",
  EWQ: "France (EWQ)",
  EWI: "Italy (EWI)",
};

marketRouter.get("/macro", async (req, res) => {
  try {
    const authorization = await sipAuthorization(req);
    if (req.query.region === "eu") {
      const [yieldResults, policyRate, inflation, quotes] = await Promise.all([
        Promise.allSettled(
          EU_YIELD_SERIES.map((s) => cached(`ecb:${s.key}`, 300_000, () => ecb.latest(s.flowRef, s.key)))
        ),
        cached(`ecb:${EU_POLICY_RATE.key}`, 300_000, () => ecb.latest(EU_POLICY_RATE.flowRef, EU_POLICY_RATE.key)).catch(
          () => null
        ),
        cached(`ecb:${EU_INFLATION.key}`, 300_000, () => ecb.latest(EU_INFLATION.flowRef, EU_INFLATION.key)).catch(
          () => null
        ),
        getQuotes(Object.keys(EU_INDEX_PROXIES), authorization),
      ]);
      const yields = EU_YIELD_SERIES.map((s, i) => {
        const r = yieldResults[i];
        const point = r.status === "fulfilled" ? r.value : null;
        return { tenor: s.tenor, value: point?.value ?? null, source: "ECB", asOf: point?.date ?? null };
      });

      const indexes = quotes.map((q) => ({
        symbol: q.symbol,
        label: EU_INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
        source: q.source,
        asOf: q.asOf ?? null,
      }));

      if (yields.every((y) => y.value === null) && indexes.every((q) => q.price === null)) throw new Error("no EU macro data from any provider");
      res.json({
        yields,
        vix: null,
        vixSource: null,
        vixAsOf: null,
        indexes,
        policyRate: policyRate?.value ?? null,
        policyRateSource: policyRate ? "ECB" : null,
        policyRateAsOf: policyRate?.date ?? null,
        inflation: inflation?.value ?? null,
        inflationSource: inflation ? "ECB" : null,
        inflationAsOf: inflation?.date ?? null,
      });
      return;
    }

    const [yieldResults, vix, quotes] = await Promise.all([
      Promise.allSettled(YIELD_SERIES.map((s) => cached(`fred:${s.id}`, 300_000, () => fred.latest(s.id)))),
      cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
      getQuotes(Object.keys(INDEX_PROXIES), authorization),
    ]);
    const yields = YIELD_SERIES.map((s, i) => {
      const r = yieldResults[i];
      const point = r.status === "fulfilled" ? r.value : null;
      return { tenor: s.tenor, value: point?.value ?? null, source: "FRED", asOf: point?.date ?? null };
    });

    const indexes = quotes.map((q) => ({
      symbol: q.symbol,
        label: INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
        source: q.source,
        asOf: q.asOf ?? null,
      }));

    if (yields.every((y) => y.value === null) && indexes.every((q) => q.price === null) && !vix) throw new Error("no macro data from any provider");
    res.json({ yields, vix: vix?.value ?? null, vixSource: vix ? "FRED VIXCLS" : null,
      vixAsOf: vix?.date ?? null, indexes, policyRate: null, inflation: null });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- heatmap + screener over the full market (TradingView scanner — live) ----
// ?market=eu switches from the whole-US scan to the merged major-European-
// exchanges scan (see tradingview.europeMarketScan).

function marketParam(req: any): "us" | "eu" {
  return req.query.market === "eu" ? "eu" : "us";
}

// TradingView reports market cap in each stock's own listing currency (SEK,
// GBP, CHF, ...), not EUR — left unconverted, a 1.2T SEK Swedish company would
// outrank a 550B EUR Dutch one in the merged EU scan. Reference rates come
// from the same ECB source as the EU macro widget, so this needs no new
// provider (rate = local-currency units per 1 EUR).
const EU_FX_SERIES: Record<string, { flowRef: string; key: string }> = {
  GBP: { flowRef: "EXR", key: "D.GBP.EUR.SP00.A" },
  SEK: { flowRef: "EXR", key: "D.SEK.EUR.SP00.A" },
  CHF: { flowRef: "EXR", key: "D.CHF.EUR.SP00.A" },
};

async function eurFxRates(): Promise<Record<string, number>> {
  const rates: Record<string, number> = { EUR: 1 };
  const entries = await Promise.all(
    Object.entries(EU_FX_SERIES).map(async ([ccy, s]) => {
      const point = await cached(`ecb:fx:${ccy}`, 3_600_000, () => ecb.latest(s.flowRef, s.key)).catch(() => null);
      return [ccy, point?.value ?? null] as const;
    })
  );
  for (const [ccy, rate] of entries) if (rate) rates[ccy] = rate;
  return rates;
}

type SourcedMarketRow = tradingview.MarketRow & {
  source: string;
  priceSource: string;
  priceAsOf: string | null;
  marketCapSource: string;
  marketCapAsOf: string | null;
  watermark?: SipSnapshot["watermark"];
};
type MarketRowsEnvelope = {
  rows: SourcedMarketRow[];
  source: string;
  asOf: string | null;
  coverage: {
    requested: number; snapshots: number; priced: number;
    snapshotComplete: boolean; priceComplete: boolean; timeComplete: boolean; complete: boolean;
  };
  truncated: boolean;
};

async function marketMetadata(market: "us" | "eu"): Promise<tradingview.MarketRow[]> {
  if (market === "us") return cached("marketscan:full", 3_000, () => tradingview.marketScan(1500));
  return cached("marketscan:eu", 5_000, async () => {
    const [rows, fx] = await Promise.all([tradingview.europeMarketScan(1500), eurFxRates()]);
    return rows.map((row) => {
      const rate = row.currency ? fx[row.currency] : undefined;
      return rate && row.marketCap ? { ...row, marketCap: row.marketCap / rate } : row;
    });
  });
}

async function marketRows(market: "us" | "eu", authorization: string): Promise<MarketRowsEnvelope> {
  if (market === "eu") {
    const rows = await marketMetadata("eu");
    const sourced = rows.map((row): SourcedMarketRow => ({
      ...row, source: "TradingView scanner", priceSource: "TradingView scanner", priceAsOf: null,
      marketCapSource: "TradingView scanner", marketCapAsOf: null,
    }));
    return {
      rows: sourced, source: "TradingView scanner · source timestamp unavailable", asOf: null,
      coverage: { requested: rows.length, snapshots: rows.length, priced: rows.filter((row) => row.price !== null).length,
        snapshotComplete: rows.length > 0,
        priceComplete: rows.length > 0 && rows.every((row) => row.price !== null),
        timeComplete: false,
        complete: false },
      truncated: rows.length >= 1500,
    };
  }
  const metadata = await marketMetadata("us");
  const symbols = [...new Set(metadata.map((row) => row.symbol).filter(usesSIPEquitySymbol))];
  // Every widget shares the provider's in-flight batch map and short-lived SIP cache.
  const snapshots = symbols.length > 0 ? await sipSnapshots(symbols, authorization) : [];
  const bySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  const rows = metadata.map((row): SourcedMarketRow => {
    const snapshot = bySymbol.get(row.symbol);
    return {
      ...row,
      price: snapshot?.last ?? null,
      changePercent: snapshot?.change_percent ?? null,
      volume: snapshot?.volume ?? null,
      source: "TradingView metadata + Alpaca SIP price data",
      priceSource: "Alpaca SIP",
      priceAsOf: snapshot?.last_as_of ?? null,
      marketCapSource: "TradingView scanner",
      marketCapAsOf: null,
      watermark: snapshot?.watermark,
    };
  });
  const asOf = latestRfc3339Nanos(rows.filter((row) => usesSIPEquitySymbol(row.symbol)).map((row) => row.priceAsOf));
  const requestedSnapshots = symbols.map((symbol) => bySymbol.get(symbol)).filter((snapshot) => snapshot !== undefined);
  const snapshotsCount = requestedSnapshots.length;
  const priced = requestedSnapshots.filter((snapshot) => snapshot.last !== null && Number.isFinite(snapshot.last)).length;
  const snapshotComplete = symbols.length > 0 && snapshotsCount === symbols.length;
  const priceComplete = symbols.length > 0 && priced === symbols.length;
  const timeComplete = symbols.length > 0 && requestedSnapshots.length === symbols.length && requestedSnapshots.every((snapshot) =>
    Boolean(snapshot.last_as_of && latestRfc3339Nanos([snapshot.last_as_of])));
  return {
    rows,
    source: "TradingView metadata + Alpaca SIP prices",
    asOf,
    coverage: {
      requested: symbols.length, snapshots: snapshotsCount, priced,
      snapshotComplete, priceComplete, timeComplete,
      complete: snapshotComplete && priceComplete && timeComplete,
    },
    truncated: metadata.length >= 1500,
  };
}

marketRouter.get("/heatmap", async (req, res) => {
  try {
    const authorization = marketParam(req) === "us" ? await sipAuthorization(req) : "";
    const data = await marketRows(marketParam(req), authorization);
    const top = data.rows.filter((r) => r.marketCap).slice(0, 150);
    res.json({ ...data, rows: top });
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/screener", async (req, res) => {
  try {
    const authorization = marketParam(req) === "us" ? await sipAuthorization(req) : "";
    const data = await marketRows(marketParam(req), authorization);
    let rows = data.rows;
    const num = (v: unknown) => (v === undefined ? undefined : Number(v));
    const f = {
      sector: req.query.sector ? String(req.query.sector) : undefined,
      marketCapMin: num(req.query.marketCapMin),
      changeMin: num(req.query.changeMin),
      changeMax: num(req.query.changeMax),
      volumeMin: num(req.query.volumeMin),
    };
    rows = rows.filter((r) => {
      if (f.sector && r.sector !== f.sector) return false;
      if (f.marketCapMin !== undefined && (r.marketCap ?? 0) < f.marketCapMin) return false;
      if (f.changeMin !== undefined && (r.changePercent ?? -Infinity) < f.changeMin) return false;
      if (f.changeMax !== undefined && (r.changePercent ?? Infinity) > f.changeMax) return false;
      if (f.volumeMin !== undefined && (r.volume ?? 0) < f.volumeMin) return false;
      return true;
    });
    const sortKey = String(req.query.sort ?? "marketCap") as keyof tradingview.MarketRow;
    const dir = req.query.dir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = (a[sortKey] as number | null) ?? -Infinity;
      const bv = (b[sortKey] as number | null) ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
    const limited = rows.slice(0, 500);
    res.json({ ...data, rows: limited, truncated: data.truncated || rows.length > limited.length });
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/sectors", async (req, res) => {
  try {
    const rows = await marketMetadata(marketParam(req));
    res.json([...new Set(rows.map((row) => row.sector))].sort());
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- market recap: templated end-of-day-style narrative + supporting stats ----

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unavailable";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function buildRecapSummary(d: {
  indexes: Array<{ symbol: string; label: string; changePercent: number | null }>;
  bestSector?: { sector: string; avgChangePercent: number };
  worstSector?: { sector: string; avgChangePercent: number };
  gainers: tradingview.MarketRow[];
  losers: tradingview.MarketRow[];
  vix: number | null;
}): string {
  const spy = d.indexes.find((i) => i.symbol === "SPY");
  const qqq = d.indexes.find((i) => i.symbol === "QQQ");
  const dia = d.indexes.find((i) => i.symbol === "DIA");

  const parts: string[] = [];
  if (spy?.changePercent === null || spy?.changePercent === undefined) {
    parts.push(`US market direction is unavailable because the SPY SIP price change is unavailable.`);
  } else {
    const dir = spy.changePercent > 0.15 ? "trading higher" : spy.changePercent < -0.15 ? "trading lower" : "little changed";
    parts.push(`US stocks are ${dir}.`);
  }
  parts.push(`S&P 500 ${pct(spy?.changePercent)}, Nasdaq 100 ${pct(qqq?.changePercent)}, Dow ${pct(dia?.changePercent)}.`);
  if (d.bestSector && d.worstSector && d.bestSector.sector !== d.worstSector.sector) {
    parts.push(
      `${d.bestSector.sector} is leading sector performance (${pct(d.bestSector.avgChangePercent)}), while ${d.worstSector.sector} lags (${pct(d.worstSector.avgChangePercent)}).`
    );
  }
  if (d.gainers[0] && d.losers[0]) {
    parts.push(
      `${d.gainers[0].name} paces advancers, up ${pct(d.gainers[0].changePercent)}, while ${d.losers[0].name} is the biggest decliner, down ${pct(
        d.losers[0].changePercent
      )}.`
    );
  }
  if (d.vix !== null) {
    parts.push(`The VIX volatility index is at ${d.vix.toFixed(2)}.`);
  }
  return parts.join(" ");
}

marketRouter.get("/recap", async (req, res) => {
  try {
    const authorization = await sipAuthorization(req);
    const [quotes, vix, market, headlines] = await Promise.all([
        getQuotes(Object.keys(INDEX_PROXIES), authorization),
        cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
        marketRows("us", authorization),
        cached("news:recap", NEWS_TTL, async () => {
          const lists = await Promise.allSettled([
            news.topNews("stock market"),
            news.topNews("federal reserve economy"),
          ]);
          const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
          if (ok.length === 0) throw new Error("all news sources failed");
          return news.dedupe(ok);
        }),
      ]);

    const indexes = quotes.map((q) => ({
        symbol: q.symbol,
        label: INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
        source: q.source,
        asOf: q.asOf ?? null,
      }));

    const rows = market.rows;
      const ranked = rows.filter((r) => (r.marketCap ?? 0) > 2_000_000_000 && r.changePercent !== null && r.price !== null);
      const gainers = [...ranked].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0)).slice(0, 5);
      const losers = [...ranked].sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0)).slice(0, 5);

      const sectorMap = new Map<string, { sum: number; count: number }>();
      for (const r of rows) {
        if (r.changePercent === null || !r.sector) continue;
        const cur = sectorMap.get(r.sector) ?? { sum: 0, count: 0 };
        cur.sum += r.changePercent;
        cur.count += 1;
        sectorMap.set(r.sector, cur);
      }
      const sectors = [...sectorMap.entries()]
        .map(([sector, { sum, count }]) => ({ sector, avgChangePercent: sum / count }))
        .sort((a, b) => b.avgChangePercent - a.avgChangePercent);

      const bestSector = sectors[0];
      const worstSector = sectors[sectors.length - 1];

    const summary = buildRecapSummary({ indexes, bestSector, worstSector, gainers, losers, vix: vix?.value ?? null });

    const data = {
        summary,
        updatedAt: new Date().toISOString(),
        marketSource: market.source,
        marketAsOf: market.asOf,
        marketCoverage: market.coverage,
        indexes,
        vix: vix?.value ?? null,
        vixSource: vix ? "FRED VIXCLS" : "FRED VIXCLS unavailable",
        vixAsOf: vix?.date ?? null,
        gainers,
        losers,
        sectors: sectors.slice(0, 3).concat(sectors.length > 3 ? sectors.slice(-3) : []),
        news: headlines.slice(0, 6),
      };
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings calendar for a list of symbols ----

marketRouter.get("/calendar", async (req, res) => {
  const symbols = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 30);
  if (symbols.length === 0) return res.status(400).json({ error: "symbols required" });
  try {
    const data = await cached(`calendar:${symbols.join(",")}`, 3_600_000, () => tradingview.earningsCalendar(symbols));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings history: forecast vs actual per quarter, plus next-day price move ----

marketRouter.get("/earnings-history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [surprises, barsResult] = await Promise.all([
      nasdaq.earningsSurprise(symbol),
      usesSIPEquitySymbol(symbol)
        ? (async () => {
            const authorization = await sipAuthorization(req);
            const result = await sipBars(symbol, "1Day", 390, 650, authorization);
            return { bars: toChartBars(result.bars), source: "Alpaca SIP" };
          })()
        : (async () => {
            const result = await namedFallback([
              ["Yahoo Finance", () => yahoo.history(symbol, yahooRange("1Y").range, yahooRange("1Y").interval)],
              ["Stooq", () => stooq.history(symbol)],
            ]);
            return { bars: result.data, source: result.source };
          })(),
    ]);
    const sorted = [...barsResult.bars].sort((a, b) => a.time - b.time);
    // Earnings date is published as a UTC calendar date; select that session's
    // close (or the next session for weekends/holidays), then compare its next
    // available daily close. No bars are sourced from research providers for U.S. names.
    const closeOnOrAfter = (unixSeconds: number) => sorted.findIndex((bar) =>
      bar.time >= unixSeconds && bar.time < unixSeconds + 4 * 86_400);
    const data = surprises.map((surprise) => {
      const idx = closeOnOrAfter(surprise.dateReported);
      const after = idx >= 0 ? sorted[idx + 1] : undefined;
      const before = idx >= 0 ? sorted[idx] : undefined;
      const dayAfterChangePercent = before && after && before.close !== 0
        ? ((after.close - before.close) / before.close) * 100
        : null;
      return {
        ...surprise,
        surpriseSource: "Nasdaq",
        surpriseAsOf: new Date(surprise.dateReported * 1000).toISOString(),
        dayAfterChangePercent,
        priceMoveSource: barsResult.source,
        priceMoveAsOf: after ? new Date(after.time * 1000).toISOString() : null,
      };
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- short sale volume (FINRA Reg SHO daily file) ----

marketRouter.get("/short-volume/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const day = await cached("finra-shortvol-day", 6 * 3_600_000, () => finra.latestDay());
    const row = day.get(symbol);
    if (!row) return res.json(null);
    res.json({ ...row, shortVolumePercent: (row.shortVolume / row.totalVolume) * 100 });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- insider transactions (SEC EDGAR Form 4) ----

marketRouter.get("/insider/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await cached(`insider:${symbol}`, 3_600_000, () => secedgar.insiderTransactions(symbol));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});
