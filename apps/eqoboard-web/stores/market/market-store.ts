import { hasControlCharacters } from "../../features/data/validation";

export type MarketFeedName = "stocks" | "options";
export type MarketTransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unavailable";
export type MarketFreshness = "unknown" | "fresh" | "stale";

/** Gateway JSON fields stay verbatim in a bounded immutable copy, not a second wire DTO. */
export type GatewayMarketRecord = Readonly<Record<string, unknown>>;

export type MarketFeedSnapshot = Readonly<{
  connectionEpoch: number | null;
  lastSequence: number | null;
  lastMessageAt: number | null;
  freshness: MarketFreshness;
  rawStatus: GatewayMarketRecord | null;
}>;

export type MarketLeaseSnapshot = Readonly<{
  generation: number;
  acknowledgedAt: number | null;
  rawAck: unknown;
  coverage: "unknown" | "pending" | "complete" | "partial" | "error";
  membershipVerification: "unverified";
  requestedCount: number;
  selectedCount: number;
  leasedCount: number;
  omittedCount: number;
}>;

export type MarketHostSnapshot = Readonly<{
  revision: number;
  transportState: MarketTransportState;
  transportError: "stream-unavailable" | "stream-error" | null;
  gatewayInstanceId: string | null;
  lastSequence: number | null;
  lastEventAt: number | null;
  feeds: Readonly<Record<MarketFeedName, MarketFeedSnapshot>>;
  leases: Readonly<Record<MarketFeedName, MarketLeaseSnapshot>>;
  stockQuotes: Readonly<Record<string, GatewayMarketRecord>>;
  stockTrades: readonly GatewayMarketRecord[];
  optionQuotes: Readonly<Record<string, GatewayMarketRecord>>;
  optionTrades: readonly GatewayMarketRecord[];
}>;

const TRADE_LIMIT = 250;
const QUOTE_LIMIT = 1_000;
const FRESHNESS_MS = 5_000;
const STOCK_SYMBOL = /^[A-Z][A-Z0-9.-]{0,11}$/u;
const OPTION_SYMBOL = /^[A-Z0-9.]{1,10}\d{6}[CP]\d{8}$/u;
const MAX_EVENT_DEPTH = 16;
const MAX_EVENT_NODES = 20_000;
const MAX_EVENT_STRING_CHARS = 64 * 1024;
const MAX_EVENT_TOTAL_STRING_CHARS = 256 * 1024;
const MAX_EVENT_OBJECT_KEYS = 512;
const MAX_EVENT_ARRAY_LENGTH = 4_096;
const INVALID_JSON_VALUE = Symbol("invalid-json-value");

type CloneBudget = {
  nodes: number;
  stringChars: number;
  seen: WeakSet<object>;
};

function emptyFeed(): MarketFeedSnapshot {
  return Object.freeze({
    connectionEpoch: null,
    lastSequence: null,
    lastMessageAt: null,
    freshness: "unknown",
    rawStatus: null,
  });
}

function emptyLease(): MarketLeaseSnapshot {
  return Object.freeze({
    generation: 0,
    acknowledgedAt: null,
    rawAck: null,
    coverage: "unknown",
    membershipVerification: "unverified",
    requestedCount: 0,
    selectedCount: 0,
    leasedCount: 0,
    omittedCount: 0,
  });
}

function emptySnapshot(): MarketHostSnapshot {
  return Object.freeze({
    revision: 0,
    transportState: "idle",
    transportError: null,
    gatewayInstanceId: null,
    lastSequence: null,
    lastEventAt: null,
    feeds: Object.freeze({ stocks: emptyFeed(), options: emptyFeed() }),
    leases: Object.freeze({ stocks: emptyLease(), options: emptyLease() }),
    stockQuotes: Object.freeze({}),
    stockTrades: Object.freeze([]),
    optionQuotes: Object.freeze({}),
    optionTrades: Object.freeze([]),
  });
}

function cloneJsonValue(
  value: unknown,
  budget: CloneBudget,
  depth = 0,
): unknown | typeof INVALID_JSON_VALUE {
  budget.nodes += 1;
  if (budget.nodes > MAX_EVENT_NODES || depth > MAX_EVENT_DEPTH) return INVALID_JSON_VALUE;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  if (typeof value === "string") {
    budget.stringChars += value.length;
    return value.length <= MAX_EVENT_STRING_CHARS &&
      budget.stringChars <= MAX_EVENT_TOTAL_STRING_CHARS
      ? value
      : INVALID_JSON_VALUE;
  }
  if (typeof value !== "object") return INVALID_JSON_VALUE;

  try {
    const prototype = Object.getPrototypeOf(value);
    if (budget.seen.has(value)) return INVALID_JSON_VALUE;
    budget.seen.add(value);

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return INVALID_JSON_VALUE;
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_EVENT_ARRAY_LENGTH + 1) return INVALID_JSON_VALUE;
      const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value as object);
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value > MAX_EVENT_ARRAY_LENGTH ||
        keys.length !== lengthDescriptor.value + 1
      ) {
        return INVALID_JSON_VALUE;
      }

      const clone = new Array<unknown>(lengthDescriptor.value);
      for (const key of keys) {
        if (key === "length") continue;
        if (
          typeof key !== "string" ||
          !/^(0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= lengthDescriptor.value
        ) {
          return INVALID_JSON_VALUE;
        }
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !("value" in descriptor)) return INVALID_JSON_VALUE;
        const child = cloneJsonValue(descriptor.value, budget, depth + 1);
        if (child === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: true,
          value: child,
          writable: true,
        });
      }
      return Object.freeze(clone);
    }

    if (prototype !== Object.prototype && prototype !== null) return INVALID_JSON_VALUE;
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_EVENT_OBJECT_KEYS || keys.some((key) => typeof key !== "string"))
      return INVALID_JSON_VALUE;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const clone = Object.create(prototype) as Record<string, unknown>;
    for (const key of keys as string[]) {
      if (key.length > 512) return INVALID_JSON_VALUE;
      budget.stringChars += key.length;
      if (budget.stringChars > MAX_EVENT_TOTAL_STRING_CHARS) return INVALID_JSON_VALUE;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) return INVALID_JSON_VALUE;
      const child = cloneJsonValue(descriptor.value, budget, depth + 1);
      if (child === INVALID_JSON_VALUE) return INVALID_JSON_VALUE;
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
    return Object.freeze(clone);
  } catch {
    return INVALID_JSON_VALUE;
  }
}

function immutableJsonValue(value: unknown): unknown {
  const clone = cloneJsonValue(value, { nodes: 0, stringChars: 0, seen: new WeakSet() });
  return clone === INVALID_JSON_VALUE ? null : clone;
}

function record(value: unknown): GatewayMarketRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const clone = cloneJsonValue(value, { nodes: 0, stringChars: 0, seen: new WeakSet() });
  return clone !== INVALID_JSON_VALUE && clone !== null && typeof clone === "object"
    ? (clone as GatewayMarketRecord)
    : null;
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function eventFeed(event: GatewayMarketRecord): MarketFeedName | null {
  switch (event.kind) {
    case "stock_quote":
    case "stock_trade":
      return "stocks";
    case "option_quote":
    case "option_trade":
      return "options";
    case "feed_status":
      return event.feed === "stocks" || event.feed === "options" ? event.feed : null;
    default:
      return null;
  }
}

function eventCollection(
  kind: unknown,
): "stockQuotes" | "stockTrades" | "optionQuotes" | "optionTrades" | null {
  switch (kind) {
    case "stock_quote":
      return "stockQuotes";
    case "stock_trade":
      return "stockTrades";
    case "option_quote":
      return "optionQuotes";
    case "option_trade":
      return "optionTrades";
    default:
      return null;
  }
}

function validDisplayEvent(event: GatewayMarketRecord, feed: MarketFeedName): boolean {
  if (event.kind === "feed_status") return event.feed === feed;
  if (typeof event.symbol !== "string") return false;
  return feed === "stocks" ? STOCK_SYMBOL.test(event.symbol) : OPTION_SYMBOL.test(event.symbol);
}

function frozenRecordMap(
  input: Record<string, GatewayMarketRecord>,
): Readonly<Record<string, GatewayMarketRecord>> {
  return Object.freeze(input);
}

function clearedFeedEvents(
  snapshot: MarketHostSnapshot,
  feed: MarketFeedName,
): Pick<MarketHostSnapshot, "stockQuotes" | "stockTrades" | "optionQuotes" | "optionTrades"> {
  return feed === "stocks"
    ? { ...snapshot, stockQuotes: Object.freeze({}), stockTrades: Object.freeze([]) }
    : { ...snapshot, optionQuotes: Object.freeze({}), optionTrades: Object.freeze([]) };
}

/** External store shared by every market widget under one MarketDataHost. */
export class MarketStore {
  #snapshot = emptySnapshot();
  #listeners = new Set<() => void>();
  #leaseTargetKeys: Record<MarketFeedName, string | null> = { stocks: null, options: null };
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  getSnapshot = (): MarketHostSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  setTransport(
    state: MarketTransportState,
    error: MarketHostSnapshot["transportError"] = null,
  ): void {
    this.#commit({ ...this.#snapshot, transportState: state, transportError: error });
  }

  resetForIdentityBoundary(): void {
    const reset = emptySnapshot();
    this.#leaseTargetKeys = { stocks: null, options: null };
    this.#commit({ ...reset, revision: this.#snapshot.revision });
  }

  setLeaseTargets(
    feed: MarketFeedName,
    requestedCount: number,
    selectedCount: number,
    targetKey: string,
  ): void {
    const current = this.#snapshot.leases[feed];
    const targetChanged = this.#leaseTargetKeys[feed] !== targetKey;
    this.#leaseTargetKeys[feed] = targetKey;
    const next: MarketLeaseSnapshot = Object.freeze({
      ...current,
      ...(targetChanged
        ? {
            acknowledgedAt: null,
            rawAck: null,
            coverage: requestedCount === 0 ? ("unknown" as const) : ("pending" as const),
            leasedCount: 0,
          }
        : {}),
      requestedCount,
      selectedCount,
      omittedCount: Math.max(0, requestedCount - selectedCount),
    });
    const acknowledgedCoverage =
      next.acknowledgedAt === null
        ? next.coverage
        : next.leasedCount >= selectedCount && next.omittedCount === 0
          ? "complete"
          : "partial";
    this.#setLease(
      feed,
      Object.freeze({
        ...next,
        coverage: acknowledgedCoverage,
      }),
    );
  }

  setLeaseAck(
    feed: MarketFeedName,
    generation: number,
    activeCount: number,
    rawAck: unknown,
    targetKey: string,
  ): void {
    const current = this.#snapshot.leases[feed];
    if (generation < current.generation || this.#leaseTargetKeys[feed] !== targetKey) return;
    const coverage =
      activeCount >= current.selectedCount && current.omittedCount === 0 ? "complete" : "partial";
    this.#setLease(
      feed,
      Object.freeze({
        ...current,
        generation,
        acknowledgedAt: this.#now(),
        rawAck: immutableJsonValue(rawAck),
        leasedCount: activeCount,
        coverage,
      }),
    );
  }

  setLeaseError(feed: MarketFeedName, generation: number, targetKey: string): void {
    const current = this.#snapshot.leases[feed];
    if (generation < current.generation || this.#leaseTargetKeys[feed] !== targetKey) return;
    this.#setLease(
      feed,
      Object.freeze({
        ...current,
        generation,
        acknowledgedAt: null,
        rawAck: null,
        leasedCount: 0,
        coverage: "error",
      }),
    );
  }

  /** Validates Gateway ordering metadata and stores a bounded immutable copy of each accepted event. */
  acceptBatch(batch: readonly unknown[], receivedAt = this.#now()): void {
    if (!Number.isFinite(receivedAt)) return;
    const parsed = batch
      .map(record)
      .filter((event): event is GatewayMarketRecord => event !== null)
      .filter(
        (event) =>
          safePositiveInteger(event.local_sequence) &&
          safePositiveInteger(event.connection_epoch) &&
          typeof event.gateway_instance_id === "string" &&
          event.gateway_instance_id.length > 0 &&
          event.gateway_instance_id.length <= 160 &&
          !hasControlCharacters(event.gateway_instance_id),
      )
      .sort((left, right) => (left.local_sequence as number) - (right.local_sequence as number));
    if (parsed.length === 0) return;

    let next = this.#snapshot;
    for (const event of parsed) {
      const instanceId = event.gateway_instance_id as string;
      const sequence = event.local_sequence as number;
      if (next.gatewayInstanceId !== null && next.gatewayInstanceId !== instanceId) {
        const transportState = next.transportState;
        const transportError = next.transportError;
        next = { ...emptySnapshot(), revision: next.revision, transportState, transportError };
      }
      if (
        next.gatewayInstanceId === instanceId &&
        next.lastSequence !== null &&
        sequence <= next.lastSequence
      )
        continue;

      // Gateway local_sequence is instance-wide across feed kinds and epochs.
      // Advance it even for an unknown or malformed event so a later older
      // event cannot be accepted after a decoder rejects its payload.
      next = {
        ...next,
        gatewayInstanceId: instanceId,
        lastSequence: sequence,
        lastEventAt: receivedAt,
      };

      const feed = eventFeed(event);
      if (!feed || !validDisplayEvent(event, feed)) continue;

      const previousFeed = next.feeds[feed];
      const epoch = event.connection_epoch as number;
      const epochChanged =
        previousFeed.connectionEpoch !== null && previousFeed.connectionEpoch !== epoch;
      if (epochChanged) next = { ...next, ...clearedFeedEvents(next, feed) };

      const isStatus = event.kind === "feed_status";
      const feeds = Object.freeze({
        ...next.feeds,
        [feed]: Object.freeze({
          connectionEpoch: epoch,
          lastSequence: sequence,
          lastMessageAt: receivedAt,
          freshness: "fresh" as const,
          rawStatus: isStatus ? event : next.feeds[feed].rawStatus,
        }),
      });
      next = {
        ...next,
        feeds,
      };

      const collection = eventCollection(event.kind);
      if (collection === "stockQuotes" || collection === "optionQuotes") {
        const symbol = event.symbol;
        if (typeof symbol !== "string" || symbol.length < 1 || symbol.length > 32) continue;
        const current = next[collection] as Readonly<Record<string, GatewayMarketRecord>>;
        const entries = Object.entries(current).filter(([key]) => key !== symbol);
        entries.push([symbol, event]);
        while (entries.length > QUOTE_LIMIT) entries.shift();
        next = { ...next, [collection]: frozenRecordMap(Object.fromEntries(entries)) };
      } else if (collection === "stockTrades" || collection === "optionTrades") {
        const current = next[collection] as readonly GatewayMarketRecord[];
        next = { ...next, [collection]: Object.freeze([...current, event].slice(-TRADE_LIMIT)) };
      }
    }
    if (next !== this.#snapshot) this.#commit(next);
  }

  /** Called by the single host freshness timer; freshness never uses source claims. */
  tick(now = this.#now()): void {
    let changed = false;
    const feeds = { ...this.#snapshot.feeds };
    for (const feed of ["stocks", "options"] as const) {
      const state = feeds[feed];
      const freshness: MarketFreshness =
        state.lastMessageAt === null
          ? "unknown"
          : now - state.lastMessageAt <= FRESHNESS_MS
            ? "fresh"
            : "stale";
      if (freshness !== state.freshness) {
        feeds[feed] = Object.freeze({ ...state, freshness });
        changed = true;
      }
    }
    if (changed) this.#commit({ ...this.#snapshot, feeds: Object.freeze(feeds) });
  }

  #setLease(feed: MarketFeedName, lease: MarketLeaseSnapshot): void {
    this.#commit({
      ...this.#snapshot,
      leases: Object.freeze({ ...this.#snapshot.leases, [feed]: lease }),
    });
  }

  #commit(next: MarketHostSnapshot): void {
    this.#snapshot = Object.freeze({ ...next, revision: this.#snapshot.revision + 1 });
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A widget subscriber cannot block other widgets or host state updates.
      }
    }
  }
}
