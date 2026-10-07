import type { GatewayWatermark } from "./snapshot-watermarks.js";
import type { MarketSourceFields } from "./market-source.js";

export type SipSnapshot = MarketSourceFields & {
  gateway_instance_id?: string;
  symbol: string;
  received_at?: string | null;
  last: number | null;
  previous_close: number | null;
  change_percent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  quote_at?: string | null;
  trade_at?: string | null;
  daily_bar_at?: string | null;
  previous_daily_bar_at?: string | null;
  last_as_of?: string | null;
  last_basis?: "trade" | "daily_bar" | "unknown" | null;
  /** Compatibility field; this timestamp is trade-only. */
  updated_at?: string | null;
  watermark?: GatewayWatermark | null;
};

export type SipBar = MarketSourceFields & {
  gateway_instance_id?: string;
  received_at?: string | null;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type SipBars = MarketSourceFields & {
  gateway_instance_id?: string;
  received_at?: string | null;
  bars: SipBar[];
  watermark?: {
    gateway_instance_id?: string;
    feed: "stocks";
    connection_epoch: number;
    request_start_sequence?: number | null;
    local_sequence: number;
  } | null;
};

export class SipGatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const RUST_URL = () => (process.env.EQO_RUST_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;
const BATCH_SIZE = 50;
const REQUEST_CONCURRENCY = 3;
const SNAPSHOT_CACHE_MS = 1_000;
const SNAPSHOT_CACHE_LIMIT = 1000;
const snapshotCache = new Map<string, { snapshot: SipSnapshot | null; expiresAt: number }>();
const snapshotInFlight = new Map<string, Promise<SipSnapshot | null>>();

function validateSymbols(symbols: string[]): string[] {
  const unique = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
  if (unique.length === 0 || unique.length > 1500 || !unique.every((symbol) => TICKER.test(symbol))) {
    throw new SipGatewayError(400, "Expected 1..1500 valid U.S. ticker symbols");
  }
  return unique;
}

function storeSnapshot(symbol: string, snapshot: SipSnapshot | null): void {
  snapshotCache.delete(symbol);
  snapshotCache.set(symbol, { snapshot, expiresAt: Date.now() + SNAPSHOT_CACHE_MS });
  while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest === undefined) break;
    snapshotCache.delete(oldest);
  }
}

async function getRust<T>(path: string, authorization: string): Promise<T> {
  const response = await fetch(`${RUST_URL()}${path}`, {
    cache: "no-store",
    headers: { Authorization: authorization, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new SipGatewayError(502, "Rust SIP market-data gateway unavailable");
  });
  if (!response.ok) {
    throw new SipGatewayError(response.status, `Rust SIP market-data gateway returned HTTP ${response.status}`);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new SipGatewayError(502, "Rust SIP market-data gateway returned invalid JSON");
  }
}

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let firstError: unknown;
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!stopped && cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await run(items[index]);
      } catch (error) {
        firstError ??= error;
        stopped = true;
      }
    }
  }));
  if (firstError) throw firstError;
  return results;
}

export async function sipSnapshots(inputSymbols: string[], authorization: string): Promise<SipSnapshot[]> {
  if (!authorization.startsWith("Bearer ") || authorization.length <= 7) {
    throw new SipGatewayError(401, "A verified market:read service identity is required");
  }
  const symbols = validateSymbols(inputSymbols);
  const now = Date.now();
  const waiting = new Map<string, Promise<SipSnapshot | null>>();
  const missing: string[] = [];
  for (const symbol of symbols) {
    const cached = snapshotCache.get(symbol);
    if (cached && cached.expiresAt > now) {
      waiting.set(symbol, Promise.resolve(cached.snapshot));
      continue;
    }
    if (cached) snapshotCache.delete(symbol);
    const existing = snapshotInFlight.get(symbol);
    if (existing) waiting.set(symbol, existing);
    else missing.push(symbol);
  }

  const deferred = new Map<string, { promise: Promise<SipSnapshot | null>; resolve: (value: SipSnapshot | null) => void; reject: (reason: unknown) => void }>();
  for (const symbol of missing) {
    let resolve!: (value: SipSnapshot | null) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<SipSnapshot | null>((res, rej) => { resolve = res; reject = rej; });
    const item = { promise, resolve, reject };
    deferred.set(symbol, item);
    snapshotInFlight.set(symbol, promise);
    waiting.set(symbol, promise);
  }

  if (missing.length > 0) {
    const batches: string[][] = [];
    for (let index = 0; index < missing.length; index += BATCH_SIZE) {
      batches.push(missing.slice(index, index + BATCH_SIZE));
    }
    void mapLimited(batches, REQUEST_CONCURRENCY, async (batch) => {
      const query = new URLSearchParams({ symbols: batch.join(",") });
      const response = await getRust<{
        feed: string;
        gateway_instance_id?: string;
        source_mode?: unknown;
        source_label?: unknown;
        received_at?: string | null;
        snapshots: SipSnapshot[];
        watermark?: GatewayWatermark;
      }>(
        `/api/v1/stocks/snapshots?${query.toString()}`, authorization);
      if (response.feed !== "sip" || !Array.isArray(response.snapshots)) {
        throw new SipGatewayError(502, "Rust Gateway did not return an Alpaca SIP snapshot set");
      }
      return response.snapshots.map((snapshot) => ({
        ...snapshot,
        source_mode: snapshot.source_mode === undefined ? response.source_mode : snapshot.source_mode,
        source_label: snapshot.source_label === undefined ? response.source_label : snapshot.source_label,
        gateway_instance_id: snapshot.gateway_instance_id ?? response.gateway_instance_id ?? response.watermark?.gateway_instance_id,
        received_at: snapshot.received_at === undefined ? response.received_at : snapshot.received_at,
        watermark: response.watermark ? { ...response.watermark, feed: "stocks" as const } : snapshot.watermark ?? null,
      }));
    }).then((results) => {
      const bySymbol = new Map(results.flat().map((snapshot) => [snapshot.symbol, snapshot]));
      for (const [symbol, item] of deferred) {
        const snapshot = bySymbol.get(symbol) ?? null;
        storeSnapshot(symbol, snapshot);
        item.resolve(snapshot);
      }
    }).catch((error: unknown) => {
      for (const item of deferred.values()) item.reject(error);
    }).finally(() => {
      for (const [symbol, item] of deferred) {
        if (snapshotInFlight.get(symbol) === item.promise) snapshotInFlight.delete(symbol);
      }
    });
  }

  const result = await Promise.all(symbols.map((symbol) => waiting.get(symbol)!));
  return result.filter((snapshot): snapshot is SipSnapshot => snapshot !== null);
}

export async function sipBars(
  symbol: string,
  timeframe: string,
  limit: number,
  days: number,
  authorization: string
): Promise<SipBars> {
  if (!authorization.startsWith("Bearer ") || authorization.length <= 7) {
    throw new SipGatewayError(401, "A verified market:read service identity is required");
  }
  const ticker = symbol.trim().toUpperCase();
  if (!TICKER.test(ticker)) throw new SipGatewayError(400, "Invalid ticker symbol");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 ||
      !Number.isInteger(days) || days < 1 || days > 20_000 ||
      !/^(1Min|5Min|15Min|1Hour|1Day|1Week|1Month)$/.test(timeframe)) {
    throw new SipGatewayError(400, "Invalid SIP bar query");
  }
  const query = new URLSearchParams({ symbol: ticker, timeframe, limit: String(limit), days: String(days) });
  const response = await getRust<{
    feed: string;
    gateway_instance_id?: string;
    source_mode?: unknown;
    source_label?: unknown;
    received_at?: string | null;
    bars: SipBar[];
    watermark?: Omit<NonNullable<SipBars["watermark"]>, "feed">;
  }>(
    `/api/v1/stocks/bars?${query.toString()}`, authorization);
  if (response.feed !== "sip" || !Array.isArray(response.bars)) {
    throw new SipGatewayError(502, "Rust Gateway did not return Alpaca SIP bars");
  }
  return {
    bars: response.bars.map((bar) => ({
      ...bar,
      source_mode: bar.source_mode === undefined ? response.source_mode : bar.source_mode,
      source_label: bar.source_label === undefined ? response.source_label : bar.source_label,
      gateway_instance_id: bar.gateway_instance_id ?? response.gateway_instance_id ?? response.watermark?.gateway_instance_id,
      received_at: bar.received_at === undefined ? response.received_at : bar.received_at,
    })),
    source_mode: response.source_mode,
    source_label: response.source_label,
    gateway_instance_id: response.gateway_instance_id ?? response.watermark?.gateway_instance_id,
    received_at: response.received_at,
    watermark: response.watermark ? { ...response.watermark, feed: "stocks" } : null,
  };
}

export const sipBatchLimits = { batchSize: BATCH_SIZE, requestConcurrency: REQUEST_CONCURRENCY } as const;
