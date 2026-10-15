import { XMLParser } from "fast-xml-parser";

import { readProviderText, validIsoDate } from "./transport";
import type { ProviderResult } from "./types";
import { SOURCE_LICENSES } from "./types";

export type ResearchNewsItem = Readonly<{
  title: string;
  link: string;
  publisher: string;
  provider: "Yahoo Finance RSS" | "Google News RSS";
  publishedAt: string | null;
  symbol: string | null;
}>;

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
  allowBooleanAttributes: false,
  removeNSPrefix: false,
});
const source = Object.freeze({
  provider: "Yahoo Finance RSS + Google News RSS",
  providerUrl: "https://news.google.com/",
  sourcePath: "apps/openterminal/server/src/providers/news.ts",
  license: SOURCE_LICENSES.providerUnknown,
});

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : null;
}

function safeLink(value: unknown): string | null {
  const text = boundedText(value, 2048);
  if (!text) return null;
  try {
    const link = new URL(text);
    return link.protocol === "https:" && link.hostname.length > 0 && link.username === "" && link.password === "" && link.port === ""
      ? link.toString()
      : null;
  } catch {
    return null;
  }
}

function parseFeed(text: string, provider: ResearchNewsItem["provider"], symbol: string | null): ResearchNewsItem[] {
  let document: unknown;
  try {
    document = xml.parse(text);
  } catch {
    return [];
  }
  if (!document || typeof document !== "object") return [];
  const rss = Reflect.get(document, "rss");
  if (!rss || typeof rss !== "object") return [];
  const channel = Reflect.get(rss, "channel");
  if (!channel || typeof channel !== "object") return [];
  const entries = values(Reflect.get(channel, "item"));
  const items: ResearchNewsItem[] = [];
  for (const entry of entries.slice(0, 80)) {
    if (!entry || typeof entry !== "object") continue;
    const title = boundedText(Reflect.get(entry, "title"), 240);
    const link = safeLink(Reflect.get(entry, "link"));
    if (!title || !link) continue;
    const pubDate = validIsoDate(Reflect.get(entry, "pubDate"));
    const publisherRaw = Reflect.get(entry, "source");
    const publisher = boundedText(
      publisherRaw && typeof publisherRaw === "object" ? Reflect.get(publisherRaw, "#text") : publisherRaw,
      96,
    );
    items.push(Object.freeze({
      title,
      link,
      publisher: publisher ?? provider,
      provider,
      publishedAt: pubDate,
      symbol,
    }));
  }
  return items;
}

async function fetchFeed(url: URL, provider: ResearchNewsItem["provider"], symbol: string | null): Promise<ResearchNewsItem[]> {
  const body = await readProviderText(url, {
    timeoutMs: 7_000,
    maxBytes: 384 * 1024,
    headers: { "User-Agent": "EqoBoard Research/1.0" },
  });
  return parseFeed(body, provider, symbol);
}

function uniqueNewest(items: readonly ResearchNewsItem[]): ResearchNewsItem[] {
  const seen = new Set<string>();
  return [...items]
    .filter((item) => {
      const key = item.title.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, " ").trim().slice(0, 120);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, 40);
}

function yahooUrl(symbol: string): URL {
  const url = new URL("https://feeds.finance.yahoo.com/rss/2.0/headline");
  url.search = new URLSearchParams({ s: symbol, region: "US", lang: "en-US" }).toString();
  return url;
}

function googleUrl(query: string): URL {
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" }).toString();
  return url;
}

export async function loadNews(symbol: string | null): Promise<ProviderResult<readonly ResearchNewsItem[]>> {
  const requests = symbol
    ? [
        fetchFeed(yahooUrl(symbol), "Yahoo Finance RSS", symbol),
        fetchFeed(googleUrl(`${symbol} stock`), "Google News RSS", symbol),
      ]
    : [
        fetchFeed(googleUrl("stock market"), "Google News RSS", null),
        fetchFeed(googleUrl("federal reserve economy"), "Google News RSS", null),
      ];
  const settled = await Promise.allSettled(requests);
  const fulfilled = settled.filter((result): result is PromiseFulfilledResult<ResearchNewsItem[]> => result.status === "fulfilled");
  if (fulfilled.length === 0) throw new Error("news-provider-unavailable");
  const failed = settled.length - fulfilled.length;
  const items = uniqueNewest(fulfilled.flatMap((result) => result.value));
  return {
    source,
    data: items,
    asOf: null,
    complete: failed === 0,
    failedItems: failed,
    truncated: items.length === 40,
    warning: "Publisher terms for storage and redistribution have not been verified; headlines and publisher links only.",
  };
}
