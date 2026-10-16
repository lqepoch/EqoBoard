import type { MarketFeedName, MarketStore } from "../../stores/market/market-store";
import { hasOnlyEnumerableDataProperties } from "./validation";

export const MARKET_STOCK_LEASE_LIMIT = 1_000;
export const MARKET_OPTION_LEASE_LIMIT = 16;
export const MARKET_LEASE_RENEW_MS = 30_000;
const OCC_CONTRACT = /^[A-Z0-9.]{1,10}\d{6}[CP]\d{8}$/u;
const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type StockLeaseInput = Readonly<{ consumer_id: string; symbols: readonly string[] }>;
export type OptionsLeaseInput = Readonly<{
  consumer_id: string;
  generation: number;
  symbols: readonly string[];
}>;
export type LeaseKind = "stocks" | "options";

export type MarketLeaseSender = (
  feed: MarketFeedName,
  input: StockLeaseInput | OptionsLeaseInput,
  signal: AbortSignal,
  keepalive?: boolean,
) => Promise<unknown>;

export type MarketStockLeaseCapacity = Readonly<{
  limit: number;
  fixedSymbols: readonly string[];
}>;

export type StockCapacityLoadResult =
  | Readonly<{ status: "available"; capacity: MarketStockLeaseCapacity }>
  | Readonly<{ status: "unavailable"; reason: "failed" | "invalid" | "timeout" | "cancelled" }>;

type ConsumerTargets = Readonly<{ stocks: readonly string[]; options: readonly string[] }>;
type LeaseState = {
  generation: number;
  consumerId: string | null;
  inFlight: boolean;
  sentKey: string | null;
  failedKey: string | null;
  controller: AbortController | null;
};

type StockCapacityState =
  | Readonly<{ status: "unknown" | "pending" | "unavailable" }>
  | Readonly<{ status: "available"; capacity: MarketStockLeaseCapacity }>;

function validSymbols(value: readonly string[], feed: LeaseKind): readonly string[] {
  const seen = new Set<string>();
  for (const symbol of value) {
    if (
      typeof symbol !== "string" ||
      symbol !== symbol.trim() ||
      !(feed === "stocks" ? TICKER : OCC_CONTRACT).test(symbol)
    )
      continue;
    seen.add(symbol);
  }
  return Object.freeze([...seen]);
}

function aggregate(
  consumers: ReadonlyMap<string, ConsumerTargets>,
  feed: LeaseKind,
): readonly string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const targets of consumers.values()) {
    for (const symbol of targets[feed]) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      symbols.push(symbol);
    }
  }
  return Object.freeze(symbols);
}

function key(symbols: readonly string[]): string {
  return JSON.stringify(symbols);
}

function makeConsumerId(): string | null {
  try {
    const value = globalThis.crypto?.randomUUID?.();
    return typeof value === "string" && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function isAckRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return hasOnlyEnumerableDataProperties(value);
  } catch {
    return false;
  }
}

export function decodeMarketStockLeaseCapacity(value: unknown): MarketStockLeaseCapacity | null {
  if (!isAckRecord(value)) return null;
  const limit = value.max_stock_subscriptions;
  const fixedSymbols = value.stock_symbols;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MARKET_STOCK_LEASE_LIMIT ||
    !Array.isArray(fixedSymbols) ||
    fixedSymbols.length > (limit as number)
  )
    return null;
  const seen = new Set<string>();
  for (const symbol of fixedSymbols) {
    if (typeof symbol !== "string" || symbol !== symbol.trim() || !TICKER.test(symbol)) return null;
    if (seen.has(symbol)) return null;
    seen.add(symbol);
  }
  return Object.freeze({
    limit: limit as number,
    fixedSymbols: Object.freeze([...seen]),
  });
}

export async function loadMarketStockLeaseCapacity(
  read: (signal: AbortSignal) => Promise<unknown>,
  parentSignal: AbortSignal,
  timeoutMs = 5_000,
): Promise<StockCapacityLoadResult> {
  if (parentSignal.aborted) return { status: "unavailable", reason: "cancelled" };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let deadlineElapsed = false;
  let removeParentAbort: () => void = () => {};
  const cancelled = new Promise<StockCapacityLoadResult>((resolve) => {
    const onAbort = () => {
      controller.abort();
      resolve({ status: "unavailable", reason: "cancelled" });
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
    removeParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
    if (parentSignal.aborted) onAbort();
  });
  const deadline = new Promise<StockCapacityLoadResult>((resolve) => {
    timeout = setTimeout(() => {
      deadlineElapsed = true;
      resolve({ status: "unavailable", reason: "timeout" });
      controller.abort();
    }, timeoutMs);
  });
  const loaded = Promise.resolve()
    .then(() => read(controller.signal))
    .then<StockCapacityLoadResult, StockCapacityLoadResult>(
      (value) => {
        if (deadlineElapsed) return { status: "unavailable", reason: "timeout" };
        const capacity = decodeMarketStockLeaseCapacity(value);
        return capacity
          ? { status: "available", capacity }
          : { status: "unavailable", reason: "invalid" };
      },
      () =>
        deadlineElapsed
          ? { status: "unavailable", reason: "timeout" }
          : {
              status: "unavailable",
              reason: parentSignal.aborted ? "cancelled" : "failed",
            },
    );

  try {
    return await Promise.race([loaded, deadline, cancelled]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeParentAbort();
    controller.abort();
  }
}

function acknowledgedActiveCount(
  feed: LeaseKind,
  generation: number,
  value: unknown,
): number | null {
  if (
    !isAckRecord(value) ||
    !Number.isSafeInteger(value.active) ||
    (value.active as number) < 0 ||
    !Number.isSafeInteger(value.max) ||
    (value.max as number) < 0 ||
    (value.active as number) > (value.max as number) ||
    !Number.isSafeInteger(value.expires_in_seconds) ||
    (value.expires_in_seconds as number) < 1 ||
    (value.expires_in_seconds as number) > 90
  )
    return null;
  if (feed === "stocks")
    return (value.active as number) <= MARKET_STOCK_LEASE_LIMIT ? (value.active as number) : null;
  if (
    (value.active as number) > MARKET_OPTION_LEASE_LIMIT ||
    value.generation !== generation ||
    value.state !== "lease_active"
  )
    return null;
  return value.active as number;
}

/**
 * Aggregates all widget leases into one stock and one options lease. It applies
 * Gateway-facing caps centrally, renews without overlap, fences options ACKs by
 * generation, and sends a higher-generation empty tombstone on clean disposal.
 */
export class MarketLeaseCoordinator {
  #store: MarketStore;
  #send: MarketLeaseSender;
  #consumers = new Map<string, ConsumerTargets>();
  #states: Record<LeaseKind, LeaseState> = {
    stocks: {
      generation: 0,
      consumerId: null,
      inFlight: false,
      sentKey: null,
      failedKey: null,
      controller: null,
    },
    options: {
      generation: 0,
      consumerId: null,
      inFlight: false,
      sentKey: null,
      failedKey: null,
      controller: null,
    },
  };
  #timer: ReturnType<typeof setInterval> | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #disposed = false;
  #runToken = 0;
  #stockCapacity: StockCapacityState = Object.freeze({ status: "unknown" });

  constructor(store: MarketStore, send: MarketLeaseSender) {
    this.#store = store;
    this.#send = send;
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#runToken += 1;
    this.#states.stocks.consumerId = makeConsumerId();
    this.#states.options.consumerId = this.#states.stocks.consumerId;
    this.#states.stocks.sentKey = null;
    this.#states.options.sentKey = null;
    this.#states.stocks.failedKey = null;
    this.#states.options.failedKey = null;
    this.#publishTargets("stocks");
    this.#timer = setInterval(() => {
      void this.#reconcile("stocks", true);
      void this.#reconcile("options", true);
    }, MARKET_LEASE_RENEW_MS);
    this.#schedule();
  }

  setConsumer(instanceId: string, feed: LeaseKind, symbols: readonly string[]): void {
    if (this.#disposed || typeof instanceId !== "string" || !UUID.test(instanceId)) return;
    const previous = this.#consumers.get(instanceId) ?? { stocks: [], options: [] };
    const safe = validSymbols(symbols, feed);
    this.#consumers.set(instanceId, Object.freeze({ ...previous, [feed]: safe }));
    this.#publishTargets(feed);
    this.#schedule();
  }

  removeConsumer(instanceId: string, feed?: LeaseKind): void {
    if (this.#disposed) return;
    const previous = this.#consumers.get(instanceId);
    if (!previous) return;
    if (!feed) this.#consumers.delete(instanceId);
    else {
      const next = Object.freeze({ ...previous, [feed]: Object.freeze([]) });
      if (next.stocks.length === 0 && next.options.length === 0) this.#consumers.delete(instanceId);
      else this.#consumers.set(instanceId, next);
    }
    if (feed) this.#publishTargets(feed);
    else {
      this.#publishTargets("stocks");
      this.#publishTargets("options");
    }
    this.#schedule();
  }

  setStockCapacityPending(): void {
    this.#stockCapacity = Object.freeze({ status: "pending" });
    this.#states.stocks.sentKey = null;
    this.#states.stocks.failedKey = null;
    this.#store.setStockLeaseCapacity("pending");
    this.#publishTargets("stocks");
    this.#schedule();
  }

  gatewayInstanceChanged(): void {
    this.#runToken += 1;
    for (const state of Object.values(this.#states)) {
      state.controller?.abort();
      state.controller = null;
      state.inFlight = false;
      state.sentKey = null;
      state.failedKey = null;
    }
    this.#stockCapacity = Object.freeze({ status: "pending" });
    this.#store.setStockLeaseCapacity("pending");
    this.#publishTargets("stocks");
    this.#publishTargets("options");
    this.#schedule();
  }

  setStockCapacityFromStatus(value: unknown): boolean {
    const capacity = decodeMarketStockLeaseCapacity(value);
    if (!capacity) {
      this.setStockCapacityUnavailable();
      return false;
    }
    this.setStockCapacity(capacity);
    return true;
  }

  setStockCapacity(capacity: MarketStockLeaseCapacity): void {
    this.#stockCapacity = Object.freeze({ status: "available", capacity });
    this.#store.setStockLeaseCapacity("available", capacity.limit, capacity.fixedSymbols);
    this.#publishTargets("stocks");
    this.#schedule();
  }

  setStockCapacityUnavailable(): void {
    this.#stockCapacity = Object.freeze({ status: "unavailable" });
    this.#store.setStockLeaseCapacity("unavailable");
    this.#publishTargets("stocks");
    this.#schedule();
  }

  /** Host cleanup sends best-effort empty leases; server TTL still bounds missed cleanup. */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#runToken += 1;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#timer = null;
    this.#debounce = null;
    for (const state of Object.values(this.#states)) state.controller?.abort();
    if (this.#states.stocks.consumerId) {
      void this.#sendTombstone("stocks", this.#runToken);
      void this.#sendTombstone("options", this.#runToken);
    }
    this.#consumers.clear();
    for (const state of Object.values(this.#states)) {
      state.controller = null;
      state.inFlight = false;
      state.sentKey = null;
      state.failedKey = null;
      state.consumerId = null;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    this.#consumers.clear();
  }

  #schedule(): void {
    if (!this.#started || this.#disposed || this.#debounce) return;
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.#reconcile("stocks", false);
      void this.#reconcile("options", false);
    }, 50);
  }

  #selectedTargets(feed: LeaseKind, requested: readonly string[]): readonly string[] {
    const limit = feed === "stocks" ? MARKET_STOCK_LEASE_LIMIT : MARKET_OPTION_LEASE_LIMIT;
    if (feed === "options") return Object.freeze(requested.slice(0, limit));
    if (this.#stockCapacity.status !== "available") return Object.freeze([]);
    const { capacity } = this.#stockCapacity;
    const requestedSet = new Set(requested);
    const fixedRequested = capacity.fixedSymbols.filter((symbol) => requestedSet.has(symbol));
    const fixedSet = new Set(capacity.fixedSymbols);
    const extras = requested.filter((symbol) => !fixedSet.has(symbol));
    const selectedLimit = Math.max(0, Math.min(capacity.limit, limit) - capacity.fixedSymbols.length);
    return Object.freeze([...fixedRequested, ...extras.slice(0, selectedLimit)]);
  }

  #publishTargets(feed: LeaseKind): void {
    const requested = aggregate(this.#consumers, feed);
    const selected = this.#selectedTargets(feed, requested);
    this.#store.setLeaseTargets(
      feed,
      requested.length,
      selected.length,
      key(selected),
      selected,
    );
  }

  async #reconcile(feed: LeaseKind, renewal: boolean): Promise<void> {
    const state = this.#states[feed];
    if (!state.consumerId || this.#disposed || !this.#started) return;
    const requested = aggregate(this.#consumers, feed);
    const selected = this.#selectedTargets(feed, requested);
    const desiredKey = key(selected);
    this.#store.setLeaseTargets(feed, requested.length, selected.length, desiredKey, selected);
    if (feed === "stocks" && this.#stockCapacity.status !== "available") {
      if (requested.length > 0 && this.#stockCapacity.status === "unavailable")
        this.#store.setLeaseError(feed, state.generation, desiredKey);
      return;
    }
    if (requested.length === 0 && state.sentKey === null) return;
    if (!renewal && (state.sentKey === desiredKey || state.failedKey === desiredKey)) return;
    if (state.inFlight) return;

    state.inFlight = true;
    const controller = new AbortController();
    const runToken = this.#runToken;
    state.controller = controller;
    const generation = feed === "options" ? ++state.generation : state.generation;
    try {
      const input: StockLeaseInput | OptionsLeaseInput =
        feed === "stocks"
          ? { consumer_id: state.consumerId, symbols: selected }
          : {
              consumer_id: state.consumerId,
              generation: Math.max(1, generation),
              symbols: selected,
            };
      const ack = await this.#send(feed, input, controller.signal);
      if (
        this.#disposed ||
        runToken !== this.#runToken ||
        state.controller !== controller
      )
        return;
      const activeCount = acknowledgedActiveCount(feed, generation, ack);
      if (activeCount === null) throw new Error("invalid-lease-ack");
      state.sentKey = desiredKey;
      state.failedKey = null;
      this.#store.setLeaseAck(feed, generation, activeCount, ack, desiredKey);
    } catch {
      if (
        !this.#disposed &&
        runToken === this.#runToken &&
        state.controller === controller &&
        !controller.signal.aborted
      ) {
        state.failedKey = desiredKey;
        this.#store.setLeaseError(feed, generation, desiredKey);
      }
    } finally {
      if (state.controller === controller) {
        state.inFlight = false;
        state.controller = null;
        if (
          !this.#disposed &&
          key(this.#selectedTargets(feed, aggregate(this.#consumers, feed))) !== desiredKey
        )
          this.#schedule();
      }
    }
  }

  async #sendTombstone(feed: LeaseKind, runToken: number): Promise<void> {
    const state = this.#states[feed];
    if (!state.consumerId) return;
    const controller = new AbortController();
    const generation = feed === "options" ? ++state.generation : state.generation;
    const input: StockLeaseInput | OptionsLeaseInput =
      feed === "stocks"
        ? { consumer_id: state.consumerId, symbols: Object.freeze([]) }
        : {
            consumer_id: state.consumerId,
            generation: Math.max(1, generation),
            symbols: Object.freeze([]),
          };
    try {
      const ack = await this.#send(feed, input, controller.signal, true);
      const activeCount = acknowledgedActiveCount(feed, generation, ack);
      if (this.#runToken === runToken && activeCount !== null) {
        this.#store.setLeaseTargets(feed, 0, 0, key([]));
        this.#store.setLeaseAck(feed, generation, activeCount, ack, key([]));
      }
    } catch {
      // Gateway's bounded lease TTL is the final cleanup mechanism on unload/network loss.
    }
  }
}
