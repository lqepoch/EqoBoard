import { finiteNumber, readProviderJson, validIsoDate } from "./transport";
import { readFredHistory } from "./macro";
import type { ProviderResult } from "./types";

export type EconomicEvent = Readonly<{
  title: string;
  country: string;
  scheduledAt: string;
  impact: "Low" | "Medium" | "High" | "Holiday";
  forecast: string | null;
  previous: string | null;
  scheduleAsOf: null;
  actual: Readonly<{ value: string; source: "FRED"; asOf: string }> | null;
}>;

const scheduleSource = Object.freeze({
  provider: "Forex Factory calendar feed",
  providerUrl: "https://nfs.faireconomy.media/",
  sourcePath: "apps/openterminal/server/src/providers/econcalendar.ts",
  license: null,
});
const earningsSource = Object.freeze({
  provider: "TradingView scanner",
  providerUrl: "https://scanner.tradingview.com/",
  sourcePath: "apps/openterminal/server/src/providers/tradingview.ts",
  license: null,
});

type RawEconomicEvent = Readonly<{
  title?: unknown;
  country?: unknown;
  date?: unknown;
  impact?: unknown;
  forecast?: unknown;
  previous?: unknown;
}>;
type Matcher = Readonly<{
  test(title: string, country: string): boolean;
  seriesId: string;
  kind: "level" | "mom_pct" | "yoy_pct" | "change";
  cadence: "rate" | "monthly";
}>;

const FRED_MATCHERS: readonly Matcher[] = [
  { test: (title, country) => country === "USD" && /federal funds rate/iu.test(title), seriesId: "DFEDTARU", kind: "level", cadence: "rate" },
  { test: (title, country) => country === "EUR" && /main refinancing rate/iu.test(title), seriesId: "ECBMRRFR", kind: "level", cadence: "rate" },
  { test: (title, country) => country === "EUR" && /deposit facility rate/iu.test(title), seriesId: "ECBDFR", kind: "level", cadence: "rate" },
  { test: (title, country) => country === "USD" && /non-?farm employment change/iu.test(title), seriesId: "PAYEMS", kind: "change", cadence: "monthly" },
  { test: (title, country) => country === "USD" && /^unemployment rate$/iu.test(title), seriesId: "UNRATE", kind: "level", cadence: "monthly" },
  { test: (title, country) => country === "USD" && /^core cpi y\/y$/iu.test(title), seriesId: "CPILFESL", kind: "yoy_pct", cadence: "monthly" },
  { test: (title, country) => country === "USD" && /^core cpi m\/m$/iu.test(title), seriesId: "CPILFESL", kind: "mom_pct", cadence: "monthly" },
  { test: (title, country) => country === "USD" && /^cpi y\/y$/iu.test(title), seriesId: "CPIAUCSL", kind: "yoy_pct", cadence: "monthly" },
  { test: (title, country) => country === "USD" && /^cpi m\/m$/iu.test(title), seriesId: "CPIAUCSL", kind: "mom_pct", cadence: "monthly" },
];

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function sameMonth(left: Date, right: Date): boolean {
  return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCMonth() === right.getUTCMonth();
}

type ActualResult = Readonly<{ actual: EconomicEvent["actual"]; failed: boolean }>;

async function actualFor(
  title: string,
  country: string,
  eventDate: Date,
  historyFor: (seriesId: string) => Promise<readonly Readonly<{ date: string; value: number }>[]>): Promise<ActualResult> {
  if (eventDate.getTime() > Date.now()) return { actual: null, failed: false };
  const matcher = FRED_MATCHERS.find((item) => item.test(title, country));
  if (!matcher) return { actual: null, failed: false };
  try {
    const points = await historyFor(matcher.seriesId);
    const latest = points.at(-1);
    if (!latest) return { actual: null, failed: false };
    const latestDate = new Date(`${latest.date}T00:00:00.000Z`);
    if (matcher.cadence === "rate" && latestDate.getTime() < eventDate.getTime() - 3 * 86_400_000) return { actual: null, failed: false };
    if (matcher.cadence === "monthly") {
      const referenceMonth = new Date(Date.UTC(eventDate.getUTCFullYear(), eventDate.getUTCMonth() - 1, 1));
      if (!sameMonth(latestDate, referenceMonth)) return { actual: null, failed: false };
    }
    let actual: string | null = null;
    if (matcher.kind === "level") actual = `${latest.value.toFixed(2)}%`;
    else if (matcher.kind === "change") {
      const previous = points.at(-2);
      actual = previous ? `${Math.round(latest.value - previous.value)}K` : null;
    } else if (matcher.kind === "mom_pct") {
      const previous = points.at(-2);
      actual = previous && previous.value !== 0 ? `${(((latest.value - previous.value) / previous.value) * 100).toFixed(1)}%` : null;
    } else {
      const yearAgo = [...points].reverse().find((point) =>
        latestDate.getTime() - new Date(`${point.date}T00:00:00.000Z`).getTime() >= 360 * 86_400_000);
      actual = yearAgo && yearAgo.value !== 0
        ? `${(((latest.value - yearAgo.value) / yearAgo.value) * 100).toFixed(1)}%`
        : null;
    }
    return { actual: actual === null ? null : { value: actual, source: "FRED", asOf: latest.date }, failed: false };
  } catch {
    return { actual: null, failed: true };
  }
}

export async function loadEconomicCalendar(): Promise<ProviderResult<readonly EconomicEvent[]>> {
  const url = new URL("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
  const raw = await readProviderJson<unknown>(url, {
    timeoutMs: 8_000,
    maxBytes: 512 * 1024,
    headers: { "User-Agent": "EqoBoard Research/1.0" },
  });
  if (!Array.isArray(raw)) throw new Error("calendar-provider-response-invalid");
  const inputs = raw.slice(0, 100).filter((entry): entry is RawEconomicEvent => Boolean(entry) && typeof entry === "object");
  const history = new Map<string, Promise<readonly Readonly<{ date: string; value: number }>[]> >();
  const historyFor = (seriesId: string) => {
    let pending = history.get(seriesId);
    if (!pending) {
      pending = readFredHistory(seriesId, 24);
      history.set(seriesId, pending);
    }
    return pending;
  };
  let failedActualLookups = 0;
  const settled = await Promise.all(inputs.map(async (entry): Promise<EconomicEvent | null> => {
    const title = cleanText(entry.title, 160);
    const country = cleanText(entry.country, 12);
    const scheduledAt = validIsoDate(entry.date);
    if (!title || !country || !scheduledAt) return null;
    const impact = entry.impact === "Low" || entry.impact === "Medium" || entry.impact === "High" || entry.impact === "Holiday"
      ? entry.impact
      : null;
    if (!impact) return null;
    const forecast = cleanText(entry.forecast, 48);
    const previous = cleanText(entry.previous, 48);
    const actualResult = await actualFor(title, country, new Date(scheduledAt), historyFor);
    if (actualResult.failed) failedActualLookups += 1;
    return {
      title,
      country,
      scheduledAt,
      impact,
      forecast,
      previous,
      scheduleAsOf: null,
      actual: actualResult.actual,
    };
  }));
  const events = settled.filter((event): event is EconomicEvent => event !== null).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const dropped = inputs.length - events.length;
  return {
    source: scheduleSource,
    data: events,
    asOf: null,
    complete: dropped === 0 && failedActualLookups === 0,
    failedItems: dropped + failedActualLookups,
    truncated: raw.length > inputs.length,
    warning: "Event schedule publication time is unavailable; actual values are populated only for matched FRED releases with a matching reference period.",
  };
}

export type EarningsCalendarRow = Readonly<{
  symbol: string;
  nextEarningsDate: string | null;
  lastEarningsDate: string | null;
  epsForecast: number | null;
  source: "TradingView scanner";
  asOf: null;
}>;

export async function loadEarningsCalendar(symbols: readonly string[]): Promise<ProviderResult<readonly EarningsCalendarRow[]>> {
  if (symbols.length === 0) {
    return { source: earningsSource, data: [], asOf: null, complete: true, failedItems: 0, truncated: false,
      warning: "Provide one or more symbols to look up earnings dates; no provider request was made." };
  }
  const exchanges = ["NASDAQ", "NYSE", "AMEX"];
  const tickers = symbols.flatMap((symbol) => exchanges.map((exchange) => `${exchange}:${symbol}`));
  const rows = await fetchTradingViewRows("https://scanner.tradingview.com/america/scan", {
    symbols: { tickers },
    columns: ["earnings_release_next_date", "earnings_release_date", "earnings_per_share_forecast_next_fq"],
  });
  const bySymbol = new Map<string, EarningsCalendarRow>();
  for (const row of rows) {
    const symbol = row.symbol;
    if (!symbol || bySymbol.has(symbol)) continue;
    const nextDate = finiteNumber(row.values[0]);
    const lastDate = finiteNumber(row.values[1]);
    const epsForecast = finiteNumber(row.values[2]);
    bySymbol.set(symbol, Object.freeze({
      symbol,
      nextEarningsDate: nextDate !== null && nextDate > 0 ? new Date(nextDate * 1000).toISOString() : null,
      lastEarningsDate: lastDate !== null && lastDate > 0 ? new Date(lastDate * 1000).toISOString() : null,
      epsForecast,
      source: "TradingView scanner",
      asOf: null,
    }));
  }
  const data = symbols.map((symbol) => bySymbol.get(symbol) ?? Object.freeze({
    symbol, nextEarningsDate: null, lastEarningsDate: null, epsForecast: null, source: "TradingView scanner" as const, asOf: null,
  }));
  const missing = data.filter((row) => row.nextEarningsDate === null && row.lastEarningsDate === null).length;
  return {
    source: earningsSource,
    data,
    asOf: null,
    complete: missing === 0,
    failedItems: missing,
    truncated: false,
    warning: "TradingView does not supply a publication timestamp for this schedule; missing symbol rows remain null.",
  };
}

export type TradingViewRow = Readonly<{ symbol: string | null; values: readonly unknown[] }>;

export async function fetchTradingViewRows(urlValue: string, body: unknown): Promise<TradingViewRow[]> {
  const url = new URL(urlValue);
  if (url.hostname !== "scanner.tradingview.com" || url.protocol !== "https:") throw new TypeError("unapproved-tradingview-host");
  const json = await readProviderJson<unknown>(url, {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 9_000,
    maxBytes: 1024 * 1024,
    headers: { "Content-Type": "application/json", "User-Agent": "EqoBoard Research/1.0" },
  });
  if (!json || typeof json !== "object") throw new Error("tradingview-response-invalid");
  const rawRows = Reflect.get(json, "data");
  if (!Array.isArray(rawRows)) throw new Error("tradingview-response-invalid");
  return rawRows.slice(0, 1600).flatMap((raw): TradingViewRow[] => {
    if (!raw || typeof raw !== "object") return [];
    const rawSymbol = Reflect.get(raw, "s");
    const rawValues = Reflect.get(raw, "d");
    if (typeof rawSymbol !== "string" || !Array.isArray(rawValues)) return [];
    const symbol = rawSymbol.split(":").at(-1)?.toUpperCase() ?? null;
    return [{ symbol: symbol && /^[A-Z0-9.^-]{1,16}$/u.test(symbol) ? symbol : null, values: rawValues }];
  });
}

/** Legacy Nasdaq EPS-surprise provider; kept separate from price bars and SIP authority. */
export type EarningsHistoryRow = Readonly<{
  fiscalQuarterEnd: string | null;
  reportedAt: string;
  eps: number | null;
  consensusForecast: number | null;
  surprisePercent: number | null;
  dayAfterChangePercent: number | null;
  priceMoveSource: "unavailable" | "Rust Gateway SIP daily bars";
  priceMoveAsOf: string | null;
}>;

export async function loadEarningsHistory(symbol: string): Promise<ProviderResult<readonly EarningsHistoryRow[]>> {
  const url = new URL(`https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`);
  const json = await readProviderJson<unknown>(url, {
    timeoutMs: 8_000,
    maxBytes: 384 * 1024,
    headers: { Accept: "application/json", "User-Agent": "EqoBoard Research/1.0" },
  });
  const dataNode = json && typeof json === "object" ? Reflect.get(json, "data") : null;
  const table = dataNode && typeof dataNode === "object" ? Reflect.get(dataNode, "earningsSurpriseTable") : null;
  const rows = table && typeof table === "object" ? Reflect.get(table, "rows") : null;
  if (!Array.isArray(rows)) throw new Error("nasdaq-earnings-response-invalid");
  const result = rows.slice(0, 24).flatMap((row): EarningsHistoryRow[] => {
    if (!row || typeof row !== "object") return [];
    const [month, day, year] = String(Reflect.get(row, "dateReported") ?? "").split("/").map(Number);
    if (!month || !day || !year || year < 1900 || year > 2200) return [];
    return [{
      fiscalQuarterEnd: cleanText(Reflect.get(row, "fiscalQtrEnd"), 32),
      reportedAt: new Date(Date.UTC(year, month - 1, day)).toISOString(),
      eps: finiteNumber(Reflect.get(row, "eps")),
      consensusForecast: finiteNumber(Reflect.get(row, "consensusForecast")),
      surprisePercent: finiteNumber(Reflect.get(row, "percentageSurprise")),
      dayAfterChangePercent: null,
      priceMoveSource: "unavailable",
      priceMoveAsOf: null,
    }];
  });
  const source = Object.freeze({ provider: "Nasdaq earnings-surprise endpoint", providerUrl: "https://www.nasdaq.com/", sourcePath: "apps/openterminal/server/src/providers/nasdaq.ts", license: null });
  return {
    source,
    data: result,
    asOf: null,
    complete: true,
    failedItems: 0,
    truncated: rows.length > 24,
    warning: "Nasdaq is the source for EPS surprises. Daily price moves require the existing Rust Gateway SIP daily-bars response; source time is left null.",
  };
}

function barTime(value: unknown): Readonly<{ seconds: number; asOf: string }> | null {
  if (typeof value === "string") {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp)
      ? { seconds: Math.floor(timestamp / 1000), asOf: new Date(timestamp).toISOString() }
      : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
    const milliseconds = seconds * 1_000;
    return Number.isFinite(milliseconds) ? { seconds, asOf: new Date(milliseconds).toISOString() } : null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Price moves are derived only from verified Gateway SIP daily bars; no Yahoo substitution. */
export function attachSipEarningsMoves(
  rows: readonly EarningsHistoryRow[],
  bars: readonly unknown[],
): readonly EarningsHistoryRow[] {
  const sorted = bars.flatMap((raw): Array<{ time: number; close: number; asOf: string }> => {
    const row = record(raw);
    const parsedTime = barTime(row?.time);
    const close = finiteNumber(row?.close);
    const sourceTime = typeof row?.asOf === "string" ? validIsoDate(row.asOf) : null;
    return parsedTime !== null && close !== null
      ? [{ time: parsedTime.seconds, close, asOf: sourceTime ?? parsedTime.asOf }]
      : [];
  }).sort((left, right) => left.time - right.time);
  return rows.map((row) => {
    const reportedAt = Math.floor(new Date(row.reportedAt).getTime() / 1000);
    const index = sorted.findIndex((bar) => bar.time >= reportedAt && bar.time < reportedAt + 4 * 86_400);
    const previous = index >= 0 ? sorted[index] : undefined;
    const next = index >= 0 ? sorted[index + 1] : undefined;
    const change = previous && next && previous.close !== 0
      ? ((next.close - previous.close) / previous.close) * 100
      : null;
    return Object.freeze({
      ...row,
      dayAfterChangePercent: change,
      priceMoveSource: previous && next ? "Rust Gateway SIP daily bars" : "unavailable",
      priceMoveAsOf: next?.asOf ?? null,
    });
  });
}
