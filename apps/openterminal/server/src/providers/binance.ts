import type { CryptoRow } from "./coingecko.js";
import type { Quote, Candle } from "./yahoo.js";
import { CRYPTO_ASSETS, CRYPTO_SYMBOLS, isExplicitCryptoSymbol } from "./market-symbol.js";
export { CRYPTO_SYMBOLS, isExplicitCryptoSymbol };

const NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CRYPTO_ASSETS).map(([symbol, name]) => [`${symbol}USDT`, name]),
);

/** Normalize a plain or BASE-USD symbol to a Binance USDT pair before URL encoding. */
export function normalizeBinancePair(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  const base = normalized.endsWith("-USD") ? normalized.slice(0, -4) : normalized;
  return `${base}USDT`;
}

/** Fallback crypto board built from Binance public 24hr tickers (no key required). */
export async function markets(): Promise<CryptoRow[]> {
  const symbols = Object.keys(NAMES);
  const url =
    "https://api.binance.com/api/v3/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const rows: any[] = await res.json();
  return rows
    .map((r) => ({
      id: r.symbol,
      symbol: r.symbol.replace("USDT", ""),
      name: NAMES[r.symbol] ?? r.symbol,
      price: +r.lastPrice,
      changePercent24h: +r.priceChangePercent,
      marketCap: null,
      volume24h: +r.quoteVolume,
      rank: null,
      sparkline: [],
    }))
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
}

export async function orderBook(symbol: string, limit = 20): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
  const pair = encodeURIComponent(normalizeBinancePair(symbol));
  const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${pair}&limit=${limit}`);
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const d = await res.json();
  return { bids: d.bids ?? [], asks: d.asks ?? [] };
}

/** Single-symbol quote so crypto tickers can flow through the same /api/quotes path as stocks. */
export async function quote(symbol: string): Promise<Quote> {
  const pair = normalizeBinancePair(symbol);
  const displaySymbol = symbol.trim().toUpperCase();
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`);
  if (!res.ok) throw new Error(`binance ticker ${res.status}`);
  const d = await res.json();
  return {
    symbol: displaySymbol,
    name: NAMES[pair] ?? displaySymbol,
    price: +d.lastPrice,
    change: +d.priceChange,
    changePercent: +d.priceChangePercent,
    open: +d.openPrice,
    high: +d.highPrice,
    low: +d.lowPrice,
    previousClose: +d.prevClosePrice,
    bid: +d.bidPrice || null,
    ask: +d.askPrice || null,
    volume: +d.volume,
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
    exchange: "Binance",
    marketState: "Open",
    time: null,
    source: "binance",
  };
}

const RANGE_TO_KLINE: Record<string, { interval: string; limit: number }> = {
  "1D": { interval: "5m", limit: 288 },
  "5D": { interval: "15m", limit: 480 },
  "1M": { interval: "1h", limit: 720 },
  "6M": { interval: "4h", limit: 1080 },
  YTD: { interval: "1d", limit: 400 },
  "1Y": { interval: "1d", limit: 365 },
  "5Y": { interval: "1w", limit: 260 },
  MAX: { interval: "1M", limit: 200 },
};

export async function history(symbol: string, rangeKey: string): Promise<Candle[]> {
  const { interval, limit } = RANGE_TO_KLINE[rangeKey] ?? RANGE_TO_KLINE["6M"];
  const pair = normalizeBinancePair(symbol);
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`binance klines ${res.status}`);
  const rows: any[] = await res.json();
  return rows.map((r) => ({
    time: Math.round(r[0] / 1000),
    open: +r[1],
    high: +r[2],
    low: +r[3],
    close: +r[4],
    volume: +r[5],
  }));
}
