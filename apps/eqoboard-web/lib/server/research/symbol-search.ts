import { readProviderJson } from "./transport";
import type { ProviderResult } from "./types";
import { SOURCE_LICENSES } from "./types";
import { hasControlCharacters } from "@/features/research/text";

export type ResearchSymbolSearchResult = Readonly<{
  symbol: string;
  providerSymbol: string;
  name: string;
  exchange: string;
  type: "stock" | "fund" | "dr";
  provider: "TradingView symbol search";
  asOf: null;
}>;

export const SYMBOL_SEARCH_RESULT_LIMIT = 20;

const SOURCE = Object.freeze({
  provider: "TradingView symbol search",
  providerUrl: "https://www.tradingview.com/",
  sourcePath: "apps/openterminal/server/src/providers/tradingview.ts",
  license: SOURCE_LICENSES.providerUnknown,
});

const EXCHANGE_SUFFIX: readonly Readonly<{ match: RegExp; suffix: string }>[] = Object.freeze([
  { match: /^(mil|bit)$/iu, suffix: ".MI" },
  { match: /euronext paris|^par$/iu, suffix: ".PA" },
  { match: /euronext amsterdam|^ams$/iu, suffix: ".AS" },
  { match: /euronext brussels|^bru$/iu, suffix: ".BR" },
  { match: /euronext lisbon|^lis$/iu, suffix: ".LS" },
  { match: /^(xetr|fra|ger|gettex)$/iu, suffix: ".DE" },
  { match: /^(lse|lsin)$/iu, suffix: ".L" },
  { match: /^(bme|mce)$/iu, suffix: ".MC" },
  { match: /^(six|swx|ebs)$/iu, suffix: ".SW" },
  { match: /^omxsto$/iu, suffix: ".ST" },
  { match: /^omxcop$/iu, suffix: ".CO" },
  { match: /^omxhex$/iu, suffix: ".HE" },
  { match: /^oslo$/iu, suffix: ".OL" },
  { match: /^(tsx|tsxv)$/iu, suffix: ".TO" },
  { match: /^asx$/iu, suffix: ".AX" },
  { match: /^hkex$/iu, suffix: ".HK" },
  { match: /^tse$/iu, suffix: ".T" },
  { match: /^nse$/iu, suffix: ".NS" },
  { match: /^bse$/iu, suffix: ".BO" },
]);

function plainText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<[^>]{0,128}>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > 0 && text.length <= maxLength && !hasControlCharacters(text) ? text : null;
}

function listingSymbol(value: unknown): string | null {
  const raw = plainText(value, 64)?.toUpperCase();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length > 2) return null;
  const symbol = parts.at(-1) ?? "";
  return /^[A-Z0-9][A-Z0-9.-]{0,15}$/u.test(symbol) ? symbol : null;
}

function providerType(value: unknown): ResearchSymbolSearchResult["type"] | null {
  return value === "stock" || value === "fund" || value === "dr" ? value : null;
}

function suffixFor(exchange: string): string {
  return EXCHANGE_SUFFIX.find((entry) => entry.match.test(exchange))?.suffix ?? "";
}

function normalizeRow(value: unknown): ResearchSymbolSearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const symbol = listingSymbol(Reflect.get(value, "symbol"));
  const exchange = plainText(Reflect.get(value, "exchange"), 64);
  const type = providerType(Reflect.get(value, "type"));
  const name = plainText(Reflect.get(value, "description"), 160) ?? symbol;
  if (!symbol || !exchange || !type || !name) return null;
  const resolvedSymbol = symbol.includes(".") ? symbol : `${symbol}${suffixFor(exchange)}`;
  return Object.freeze({
    symbol: resolvedSymbol,
    providerSymbol: symbol,
    name,
    exchange,
    type,
    provider: "TradingView symbol search",
    asOf: null,
  });
}

function symbolSearchUrl(query: string): URL {
  const url = new URL("https://symbol-search.tradingview.com/symbol_search/v3/");
  url.search = new URLSearchParams({
    text: query,
    hl: "1",
    lang: "en",
    search_type: "undefined",
    domain: "production",
    sort_by_country: "US",
  }).toString();
  return url;
}

export async function loadTradingViewSymbolSearch(
  query: string,
): Promise<ProviderResult<readonly ResearchSymbolSearchResult[]>> {
  if (
    query !== query.trim() ||
    query.length < 1 ||
    query.length > 64 ||
    hasControlCharacters(query)
  ) {
    throw new TypeError("invalid-symbol-search-query");
  }
  const payload = await readProviderJson<unknown>(symbolSearchUrl(query), {
    timeoutMs: 7_000,
    maxBytes: 384 * 1024,
    headers: {
      "User-Agent": "EqoBoard Research/1.0",
      Referer: "https://www.tradingview.com/",
      Origin: "https://www.tradingview.com",
    },
  });
  const rows =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Reflect.get(payload, "symbols")
      : null;
  if (!Array.isArray(rows)) throw new Error("tradingview-symbol-search-response-invalid");
  const normalized = rows.slice(0, 500).flatMap((row): ResearchSymbolSearchResult[] => {
    const parsed = normalizeRow(row);
    return parsed ? [parsed] : [];
  });
  const unique = [...new Map(normalized.map((row) => [row.symbol, row])).values()];
  const truncated = unique.length > SYMBOL_SEARCH_RESULT_LIMIT || rows.length > 500;
  return Object.freeze({
    source: SOURCE,
    data: Object.freeze(unique.slice(0, SYMBOL_SEARCH_RESULT_LIMIT)),
    asOf: null,
    complete: !truncated,
    failedItems: null,
    truncated,
    warning:
      "TradingView symbol search returns listing metadata only. It provides no observation timestamp, quote, market feed, or SIP authority.",
  });
}
