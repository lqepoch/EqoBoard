import { finiteNumber, readProviderJson, validIsoDate } from "./transport";
import type { ProviderResult } from "./types";

export type CryptoMarketRow = Readonly<{
  id: string;
  symbol: string;
  name: string;
  price: number | null;
  changePercent24h: number | null;
  marketCap: number | null;
  volume24h: number | null;
  rank: number | null;
  sparkline: readonly number[];
  asOf: string | null;
}>;

export type CryptoGlobalData = Readonly<{
  totalMarketCap: number | null;
  bitcoinDominance: number | null;
  etherDominance: number | null;
}>;

const COINGECKO_SOURCE = Object.freeze({
  provider: "CoinGecko API v3",
  providerUrl: "https://www.coingecko.com/api/documentation",
  sourcePath: "apps/openterminal/server/src/providers/coingecko.ts",
  license: null,
});
const BINANCE_SOURCE = Object.freeze({
  provider: "Binance public market data",
  providerUrl: "https://api.binance.com/",
  sourcePath: "apps/openterminal/server/src/providers/binance.ts",
  license: null,
});

const BINANCE_ASSETS = Object.freeze({
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  BNB: "BNB",
  XRP: "XRP",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  AVAX: "Avalanche",
  DOT: "Polkadot",
  LINK: "Chainlink",
  LTC: "Litecoin",
  MATIC: "Polygon",
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSparkline(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 256)
    .map(finiteNumber)
    .filter((item): item is number => item !== null);
}

async function coinGeckoMarkets(): Promise<readonly CryptoMarketRow[]> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.search = new URLSearchParams({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: "50",
    page: "1",
    sparkline: "true",
    price_change_percentage: "24h",
  }).toString();
  const raw = await readProviderJson<unknown>(url, {
    timeoutMs: 8_000,
    maxBytes: 1024 * 1024,
    headers: { Accept: "application/json" },
  });
  if (!Array.isArray(raw)) throw new Error("coingecko-response-invalid");
  return raw.slice(0, 50).flatMap((item): CryptoMarketRow[] => {
    const row = asRecord(item);
    const id = typeof row?.id === "string" ? row.id.slice(0, 80) : null;
    const symbol = typeof row?.symbol === "string" ? row.symbol.toUpperCase().slice(0, 16) : null;
    const name = typeof row?.name === "string" ? row.name.slice(0, 96) : null;
    if (!row || !id || !symbol || !name) return [];
    return [
      Object.freeze({
        id,
        symbol,
        name,
        price: finiteNumber(row.current_price),
        changePercent24h: finiteNumber(row.price_change_percentage_24h),
        marketCap: finiteNumber(row.market_cap),
        volume24h: finiteNumber(row.total_volume),
        rank: finiteNumber(row.market_cap_rank),
        sparkline: parseSparkline(asRecord(row.sparkline_in_7d)?.price),
        asOf: validIsoDate(row.last_updated),
      }),
    ];
  });
}

async function binanceMarkets(): Promise<readonly CryptoMarketRow[]> {
  const symbols = Object.keys(BINANCE_ASSETS).map((symbol) => `${symbol}USDT`);
  const url = new URL("https://api.binance.com/api/v3/ticker/24hr");
  url.search = new URLSearchParams({ symbols: JSON.stringify(symbols) }).toString();
  const raw = await readProviderJson<unknown>(url, {
    timeoutMs: 8_000,
    maxBytes: 384 * 1024,
    headers: { Accept: "application/json" },
  });
  if (!Array.isArray(raw)) throw new Error("binance-response-invalid");
  return raw
    .slice(0, symbols.length)
    .flatMap((item): CryptoMarketRow[] => {
      const row = asRecord(item);
      const pair = typeof row?.symbol === "string" ? row.symbol : "";
      const base = pair.endsWith("USDT") ? pair.slice(0, -4) : "";
      if (!row || !base || !(base in BINANCE_ASSETS)) return [];
      return [
        Object.freeze({
          id: pair,
          symbol: base,
          name: BINANCE_ASSETS[base as keyof typeof BINANCE_ASSETS],
          price: finiteNumber(row.lastPrice),
          changePercent24h: finiteNumber(row.priceChangePercent),
          marketCap: null,
          volume24h: finiteNumber(row.quoteVolume),
          rank: null,
          sparkline: [],
          asOf:
            typeof row.closeTime === "number" && Number.isFinite(row.closeTime) && row.closeTime > 0
              ? new Date(row.closeTime).toISOString()
              : null,
        }),
      ];
    })
    .sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0));
}

export async function loadCryptoMarkets(): Promise<ProviderResult<readonly CryptoMarketRow[]>> {
  try {
    const data = await coinGeckoMarkets();
    if (data.length === 0) throw new Error("coingecko-empty-response");
    const missingTimes = data.filter((row) => row.asOf === null).length;
    return {
      source: COINGECKO_SOURCE,
      data,
      asOf: null,
      complete: missingTimes === 0 && data.every((row) => row.price !== null),
      failedItems: missingTimes,
      truncated: data.length === 50,
      warning:
        "CoinGecko does not guarantee the per-row update timestamp is a market observation boundary; null timestamps stay unknown.",
    };
  } catch {
    const data = await binanceMarkets();
    return {
      source: BINANCE_SOURCE,
      data,
      asOf: null,
      complete:
        data.length === Object.keys(BINANCE_ASSETS).length &&
        data.every((row) => row.asOf !== null && row.price !== null),
      failedItems: Object.keys(BINANCE_ASSETS).length - data.length,
      truncated: false,
      warning:
        "CoinGecko failed. This response is explicitly Binance-only; market cap, rank, and sparkline are unavailable.",
    };
  }
}

export async function loadCryptoGlobal(): Promise<ProviderResult<CryptoGlobalData>> {
  const url = new URL("https://api.coingecko.com/api/v3/global");
  const raw = await readProviderJson<unknown>(url, {
    timeoutMs: 8_000,
    maxBytes: 256 * 1024,
    headers: { Accept: "application/json" },
  });
  const data = asRecord(asRecord(raw)?.data);
  if (!data) throw new Error("coingecko-global-response-invalid");
  const marketCap = asRecord(data.total_market_cap);
  const dominance = asRecord(data.market_cap_percentage);
  const totalMarketCap = finiteNumber(marketCap?.usd);
  const bitcoinDominance = finiteNumber(dominance?.btc);
  const etherDominance = finiteNumber(dominance?.eth);
  const missing = [totalMarketCap, bitcoinDominance, etherDominance].filter(
    (value) => value === null,
  ).length;
  return {
    source: COINGECKO_SOURCE,
    data: { totalMarketCap, bitcoinDominance, etherDominance },
    asOf: null,
    complete: missing === 0,
    failedItems: missing,
    truncated: false,
    warning: "CoinGecko global data does not include a source as-of timestamp in this response.",
  };
}
