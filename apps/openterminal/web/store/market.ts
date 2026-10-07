"use client";

import { create } from "zustand";
import type { MarketSnapshotWatermark, Quote } from "../lib/api";
import type { EqoChain } from "../lib/eqo-market";
import { compareRfc3339Nanos } from "../../server/src/providers/market-time.ts";
export { compareRfc3339Nanos };

export type FeedName = "stocks" | "options";
export type ChannelSymbols = { quotes: string[]; trades: string[] };
export type FeedFreshness = {
  state: "fresh" | "stale" | "unknown";
  as_of: string | null;
  age_ms: number | null;
  fresh_until?: string | null;
};
export type FeedStatusEvent = {
  kind: "feed_status";
  feed: FeedName;
  transport: "disconnected" | "connecting" | "connected";
  auth: "unknown" | "authenticating" | "authenticated" | "failed";
  desired: ChannelSymbols;
  confirmed: ChannelSymbols | null;
  pending: {
    subscribe: ChannelSymbols;
    unsubscribe: ChannelSymbols;
  };
  upstream: "connecting" | "ready" | "degraded";
  coverage: {
    desired_count: number;
    confirmed_count: number;
    limit: number | null;
    complete: boolean;
  };
  coverage_complete?: boolean;
  connection_epoch: number;
  local_sequence: number;
  received_at: string | null;
  last_error: { code: number | null; class: string; message?: string } | null;
  decode_error_count: number;
  market_session?: "open" | "closed" | "unknown";
  freshness?: Record<string, FeedFreshness>;
  // The gateway may publish this marker when its fanout detects a sequence gap.
  resync_required?: boolean;
};

type EventBase = {
  event_time: string | null;
  received_at: string;
  connection_epoch: number;
  local_sequence: number;
};
export type StockQuoteEvent = EventBase & {
  kind: "stock_quote"; symbol: string; bid: number | null; ask: number | null;
};
export type StockTradeEvent = EventBase & {
  kind: "stock_trade"; symbol: string; price: number; size: number;
};
export type OptionQuoteEvent = EventBase & {
  kind: "option_quote"; symbol: string; bid: number | null; ask: number | null;
  bid_size: number | null; ask_size: number | null;
};
export type OptionTradeEvent = EventBase & {
  kind: "option_trade"; symbol: string; price: number; size: number;
};
export type MarketDataEvent = StockQuoteEvent | StockTradeEvent | OptionQuoteEvent | OptionTradeEvent;
export type MarketEvent = MarketDataEvent | FeedStatusEvent;

export type SnapshotWatermark = MarketSnapshotWatermark;
export type OptionSnapshot = EqoChain["calls"][number];

function stockLastAsOf(quote: Quote): string | null {
  if (quote.source === "Alpaca SIP") return quote.lastAsOf ?? null;
  return quote.lastAsOf ?? quote.asOf ?? null;
}

type MarketState = {
  marketClockMs: number;
  browserConnected: boolean;
  connectionError: string | null;
  subscriptionError: string | null;
  feedStatus: Partial<Record<FeedName, FeedStatusEvent>>;
  connectionEpochs: Partial<Record<FeedName, number>>;
  feedSequences: Partial<Record<FeedName, number>>;
  stockQuotes: Record<string, StockQuoteEvent>;
  stockTrades: Record<string, StockTradeEvent>;
  stockSnapshots: Record<string, Quote>;
  optionQuotes: Record<string, OptionQuoteEvent>;
  optionSnapshots: Record<string, OptionSnapshot>;
  optionTrades: OptionTradeEvent[];
  optionTradeLatest: Record<string, OptionTradeEvent>;
  snapshotWatermarks: Record<string, SnapshotWatermark>;
  lastBatch: MarketEvent[];
  revision: number;
  resyncGeneration: number;
  setMarketClock: (nowMs: number) => void;
  setConnection: (connected: boolean, error?: string | null) => void;
  setSubscriptionError: (error: string | null) => void;
  setStockSnapshot: (quote: Quote) => void;
  setOptionSnapshot: (contract: OptionSnapshot, watermark?: SnapshotWatermark | null) => void;
  setSnapshotWatermark: (watermark: SnapshotWatermark) => void;
  applyBatch: (batch: MarketEvent[]) => void;
};

const feedFor = (event: MarketDataEvent): FeedName => event.kind.startsWith("stock_") ? "stocks" : "options";

function eventCanReplace(current: MarketDataEvent | undefined, next: MarketDataEvent, watermark: SnapshotWatermark | undefined): boolean {
  if (watermark) {
    if (next.connection_epoch < watermark.connection_epoch) return false;
    if (next.connection_epoch === watermark.connection_epoch) {
      const asOf = watermark.as_of_by_symbol?.[next.symbol];
      if (asOf && next.event_time) {
        const againstSnapshot = compareRfc3339Nanos(next.event_time, asOf);
        if (againstSnapshot === null || againstSnapshot <= 0) return false;
      } else if (!asOf) {
        const start = watermark.request_start_sequence;
        if (start === null || start === undefined) {
          if (next.local_sequence <= watermark.local_sequence) return false;
        } else if (next.local_sequence <= start) return false;
      } else if (!next.event_time) return false;
    }
  }
  if (!current) return true;
  if (next.connection_epoch < current.connection_epoch) return false;
  if (next.connection_epoch > current.connection_epoch) return true;
  if (next.local_sequence <= current.local_sequence) return false;
  if (!next.event_time) return !current.event_time;
  if (!current.event_time) return true;
  const timeOrder = compareRfc3339Nanos(next.event_time, current.event_time);
  return timeOrder !== null && timeOrder >= 0;
}

function watermarkKey(feed: FeedName, symbol: string, eventType: "quote" | "trade"): string {
  return `${feed}:${symbol}:${eventType}`;
}

function eventWatermark(state: Pick<MarketState, "snapshotWatermarks">, event: MarketDataEvent): SnapshotWatermark | undefined {
  return state.snapshotWatermarks[watermarkKey(feedFor(event), event.symbol, event.kind.endsWith("quote") ? "quote" : "trade")];
}

function isChannels(value: unknown): value is ChannelSymbols {
  if (!value || typeof value !== "object") return false;
  const channels = value as Partial<ChannelSymbols>;
  return Array.isArray(channels.quotes) && channels.quotes.every((symbol) => typeof symbol === "string") &&
    Array.isArray(channels.trades) && channels.trades.every((symbol) => typeof symbol === "string");
}

function compatibleEvent(event: MarketEvent): boolean {
  if (event.kind === "feed_status") {
    return (event.feed === "stocks" || event.feed === "options") &&
      Number.isSafeInteger(event.connection_epoch) && event.connection_epoch >= 0 &&
      Number.isSafeInteger(event.local_sequence) && event.local_sequence >= 0 &&
      ["disconnected", "connecting", "connected"].includes(event.transport) &&
      ["unknown", "authenticating", "authenticated", "failed"].includes(event.auth) &&
      ["connecting", "ready", "degraded"].includes(event.upstream) &&
      isChannels(event.desired) && (event.confirmed === null || isChannels(event.confirmed)) &&
      event.pending && isChannels(event.pending.subscribe) && isChannels(event.pending.unsubscribe) &&
      event.coverage && Number.isFinite(event.coverage.desired_count) &&
      Number.isFinite(event.coverage.confirmed_count) &&
      (event.coverage.limit === null || Number.isFinite(event.coverage.limit)) &&
      typeof event.coverage.complete === "boolean" && Number.isSafeInteger(event.decode_error_count) &&
      event.decode_error_count >= 0 && (event.received_at === null || compareRfc3339Nanos(event.received_at, event.received_at) !== null);
  }
  return ["stock_quote", "stock_trade", "option_quote", "option_trade"].includes(event.kind) &&
    typeof event.symbol === "string" && event.symbol.length > 0 &&
    Number.isSafeInteger(event.connection_epoch) && event.connection_epoch >= 0 &&
    Number.isSafeInteger(event.local_sequence) && event.local_sequence >= 0 &&
    compareRfc3339Nanos(event.received_at, event.received_at) !== null &&
    (event.event_time === null || compareRfc3339Nanos(event.event_time, event.event_time) !== null);
}

export const useMarket = create<MarketState>((set) => ({
  marketClockMs: Date.now(),
  browserConnected: false,
  connectionError: null,
  subscriptionError: null,
  feedStatus: {},
  connectionEpochs: {},
  feedSequences: {},
  stockQuotes: {}, stockTrades: {}, optionQuotes: {}, optionTrades: [], optionTradeLatest: {},
  stockSnapshots: {}, optionSnapshots: {},
  snapshotWatermarks: {}, lastBatch: [], revision: 0, resyncGeneration: 0,
  setMarketClock: (nowMs) => set((state) => {
    if (!Number.isFinite(nowMs) || state.marketClockMs === nowMs) return state;
    return { marketClockMs: nowMs };
  }),
  setConnection: (browserConnected, connectionError = null) => set((state) => {
    if (state.browserConnected === browserConnected && state.connectionError === connectionError) return state;
    return browserConnected
      ? { browserConnected, connectionError }
      : { browserConnected, connectionError, feedStatus: {}, stockQuotes: {}, stockTrades: {}, optionQuotes: {}, optionTrades: [], optionTradeLatest: {}, resyncGeneration: state.resyncGeneration + 1 };
  }),
  setSubscriptionError: (subscriptionError) => set({ subscriptionError }),
  setStockSnapshot: (quote) => set((state) => {
    const currentEpoch = state.connectionEpochs.stocks;
    const incomingEpoch = quote.watermarks?.[0]?.connection_epoch ?? quote.watermark?.connection_epoch;
    if (incomingEpoch !== undefined && currentEpoch !== undefined && incomingEpoch !== currentEpoch) return state;
    const previous = state.stockSnapshots[quote.symbol];
    const nextAsOf = stockLastAsOf(quote);
    const previousAsOf = previous ? stockLastAsOf(previous) : null;
    if (nextAsOf && compareRfc3339Nanos(nextAsOf, nextAsOf) === null) return state;
    if (previous && !nextAsOf) return state;
    if (previousAsOf && nextAsOf) {
      const order = compareRfc3339Nanos(nextAsOf, previousAsOf);
      if (order === null || order <= 0) return state;
    }
    return { stockSnapshots: { ...state.stockSnapshots, [quote.symbol]: quote } };
  }),
  setOptionSnapshot: (contract, watermark) => set((state) => {
    const currentEpoch = state.connectionEpochs.options;
    if (watermark && currentEpoch !== undefined && watermark.connection_epoch !== currentEpoch) return state;
    const previous = state.optionSnapshots[contract.symbol];
    if (previous && !contract.quote_at) return state;
    if (contract.quote_at && compareRfc3339Nanos(contract.quote_at, contract.quote_at) === null) return state;
    if (previous?.quote_at && contract.quote_at) {
      const order = compareRfc3339Nanos(contract.quote_at, previous.quote_at);
      if (order === null || order <= 0) return state;
    }
    return { optionSnapshots: { ...state.optionSnapshots, [contract.symbol]: contract } };
  }),
  setSnapshotWatermark: (watermark) => set((state) => {
    if ((watermark.feed !== "stocks" && watermark.feed !== "options") ||
        !Array.isArray(watermark.symbols) || watermark.symbols.length === 0 ||
        !watermark.symbols.every((symbol) => typeof symbol === "string" && symbol.length > 0) ||
        !Array.isArray(watermark.event_types) || watermark.event_types.length === 0 ||
        !watermark.event_types.every((eventType) => eventType === "quote" || eventType === "trade") ||
        !Number.isSafeInteger(watermark.connection_epoch) || watermark.connection_epoch < 0 ||
        !Number.isSafeInteger(watermark.local_sequence) || watermark.local_sequence < 0 ||
        (watermark.request_start_sequence !== null && watermark.request_start_sequence !== undefined &&
          (!Number.isSafeInteger(watermark.request_start_sequence) || watermark.request_start_sequence < 0 ||
            watermark.request_start_sequence > watermark.local_sequence))) return state;
    const currentEpoch = state.connectionEpochs[watermark.feed];
    // An old in-flight REST response must not install a barrier over a newer
    // stream epoch. A newer snapshot epoch invalidates the old feed status and
    // live values until that epoch's status is received.
    if (currentEpoch !== undefined && watermark.connection_epoch < currentEpoch) return state;
    const snapshotWatermarks = { ...state.snapshotWatermarks };
    const next: Partial<MarketState> = { snapshotWatermarks };
    let feedStatus = state.feedStatus;
    let connectionEpochs = state.connectionEpochs;
    let feedSequences = state.feedSequences;
    let stockQuotes = state.stockQuotes, stockTrades = state.stockTrades;
    let optionQuotes = state.optionQuotes, optionTrades = state.optionTrades;
    let optionTradeLatest = state.optionTradeLatest;
    let resyncGeneration = state.resyncGeneration;
    if (currentEpoch === undefined) {
      // The first snapshot establishes the epoch fence before an SSE status has
      // necessarily arrived, so a slower response from an earlier epoch cannot
      // later replace it. Only its request-start sequence is safe as a fence;
      // events published while the request was in flight may be newer than
      // the REST fields even when their sequence is below the response end.
      connectionEpochs = { ...connectionEpochs, [watermark.feed]: watermark.connection_epoch };
      feedSequences = { ...feedSequences };
      if (watermark.request_start_sequence !== null && watermark.request_start_sequence !== undefined) {
        feedSequences[watermark.feed] = watermark.request_start_sequence;
      } else {
        delete feedSequences[watermark.feed];
      }
    } else if (watermark.connection_epoch > currentEpoch) {
      feedStatus = { ...feedStatus };
      delete feedStatus[watermark.feed];
      connectionEpochs = { ...connectionEpochs, [watermark.feed]: watermark.connection_epoch };
      feedSequences = { ...feedSequences };
      if (watermark.request_start_sequence !== null && watermark.request_start_sequence !== undefined) {
        feedSequences[watermark.feed] = watermark.request_start_sequence;
      } else {
        delete feedSequences[watermark.feed];
      }
      if (watermark.feed === "stocks") { stockQuotes = {}; stockTrades = {}; }
      else { optionQuotes = {}; optionTrades = []; optionTradeLatest = {}; }
      resyncGeneration++;
    }
    for (const symbol of watermark.symbols) {
      for (const eventType of watermark.event_types) {
        const key = watermarkKey(watermark.feed, symbol, eventType);
        const previous = snapshotWatermarks[key];
        if (previous) {
          if (previous.connection_epoch > watermark.connection_epoch) continue;
          if (previous.connection_epoch === watermark.connection_epoch) {
            if (previous.local_sequence > watermark.local_sequence) continue;
            const previousAsOf = previous.as_of_by_symbol?.[symbol] ?? null;
            const nextAsOf = watermark.as_of_by_symbol?.[symbol] ?? null;
            if (previousAsOf && nextAsOf) {
              const asOfOrder = compareRfc3339Nanos(nextAsOf, previousAsOf);
              if (asOfOrder === null || asOfOrder < 0) continue;
              if (asOfOrder === 0 && previous.local_sequence >= watermark.local_sequence) continue;
            } else if (previousAsOf && !nextAsOf) continue;
            else if (previous.local_sequence >= watermark.local_sequence) continue;
          }
        }
        snapshotWatermarks[key] = watermark;
        if (watermark.feed === "stocks" && eventType === "quote" && stockQuotes[symbol] &&
          !eventCanReplace(undefined, stockQuotes[symbol], watermark)) {
          stockQuotes = { ...stockQuotes }; delete stockQuotes[symbol];
        }
        if (watermark.feed === "stocks" && eventType === "trade" && stockTrades[symbol] &&
          !eventCanReplace(undefined, stockTrades[symbol], watermark)) {
          stockTrades = { ...stockTrades }; delete stockTrades[symbol];
        }
        if (watermark.feed === "options" && eventType === "quote" && optionQuotes[symbol] &&
          !eventCanReplace(undefined, optionQuotes[symbol], watermark)) {
          optionQuotes = { ...optionQuotes }; delete optionQuotes[symbol];
        }
        if (watermark.feed === "options" && eventType === "trade") {
          if (optionTradeLatest[symbol] && !eventCanReplace(undefined, optionTradeLatest[symbol], watermark)) {
            optionTradeLatest = { ...optionTradeLatest }; delete optionTradeLatest[symbol];
          }
          optionTrades = optionTrades.filter((event) => event.symbol !== symbol || eventCanReplace(undefined, event, watermark));
        }
      }
    }
    next.feedStatus = feedStatus;
    next.connectionEpochs = connectionEpochs;
    next.feedSequences = feedSequences;
    next.stockQuotes = stockQuotes; next.stockTrades = stockTrades;
    next.optionQuotes = optionQuotes; next.optionTrades = optionTrades;
    next.optionTradeLatest = optionTradeLatest;
    next.resyncGeneration = resyncGeneration;
    return next;
  }),
  applyBatch: (inputBatch) => set((state) => {
    const batch = inputBatch.filter(compatibleEvent);
    if (batch.length === 0) return state;
    let feedStatus = state.feedStatus;
    let connectionEpochs = state.connectionEpochs;
    let feedSequences = state.feedSequences;
    let stockQuotes = state.stockQuotes;
    let stockTrades = state.stockTrades;
    let optionQuotes = state.optionQuotes;
    let optionTrades = state.optionTrades;
    let optionTradeLatest = state.optionTradeLatest;
    let resyncGeneration = state.resyncGeneration;
    const copied = new Set<string>();
    const acceptedStatuses = new Map<FeedName, FeedStatusEvent>();
    const acceptedQuotes = new Map<string, MarketDataEvent>();
    const acceptedTrades: MarketDataEvent[] = [];

    for (const event of batch) {
      if (event.kind === "feed_status") {
        const current = feedStatus[event.feed];
        const latestEpoch = connectionEpochs[event.feed] ?? current?.connection_epoch;
        if (latestEpoch !== undefined && event.connection_epoch < latestEpoch) continue;
        const epochChanged = latestEpoch !== undefined && event.connection_epoch > latestEpoch;
        const latestSequence = epochChanged ? undefined : feedSequences[event.feed];
        if (latestSequence !== undefined && event.local_sequence <= latestSequence) continue;
        const unavailable = event.upstream !== "ready" || event.transport !== "connected" || event.auth === "failed";
        const transitionedUnavailable = Boolean(current && unavailable &&
          (current.upstream === "ready" || current.transport === "connected" || current.auth === "authenticated"));
        if (!copied.has("feedStatus")) { feedStatus = { ...feedStatus }; copied.add("feedStatus"); }
        if (!copied.has("connectionEpochs")) { connectionEpochs = { ...connectionEpochs }; copied.add("connectionEpochs"); }
        if (!copied.has("feedSequences")) { feedSequences = { ...feedSequences }; copied.add("feedSequences"); }
        feedStatus[event.feed] = event;
        connectionEpochs[event.feed] = event.connection_epoch;
        feedSequences[event.feed] = event.local_sequence;
        acceptedStatuses.set(event.feed, event);
        if (epochChanged || transitionedUnavailable || event.resync_required) {
          if (event.feed === "stocks") {
            stockQuotes = {}; stockTrades = {}; copied.add("stockQuotes"); copied.add("stockTrades");
          } else {
            optionQuotes = {}; optionTrades = []; optionTradeLatest = {}; copied.add("optionQuotes"); copied.add("optionTrades"); copied.add("optionTradeLatest");
          }
          resyncGeneration++;
        }
        continue;
      }

      const feed = feedFor(event);
      const status = feedStatus[feed];
      const latestEpoch = connectionEpochs[feed] ?? status?.connection_epoch;
      if (latestEpoch !== undefined && event.connection_epoch < latestEpoch) continue;
      const epochChanged = latestEpoch !== undefined && event.connection_epoch > latestEpoch;
      const latestSequence = epochChanged ? undefined : feedSequences[feed];
      if (latestSequence !== undefined && event.local_sequence <= latestSequence) continue;
      if (epochChanged) {
        if (!copied.has("feedStatus")) { feedStatus = { ...feedStatus }; copied.add("feedStatus"); }
        if (!copied.has("connectionEpochs")) { connectionEpochs = { ...connectionEpochs }; copied.add("connectionEpochs"); }
        if (!copied.has("feedSequences")) { feedSequences = { ...feedSequences }; copied.add("feedSequences"); }
        // Data from a new connection epoch invalidates prior feed status until
        // the corresponding typed gateway status event arrives.
        delete feedStatus[feed];
        connectionEpochs[feed] = event.connection_epoch;
        feedSequences[feed] = event.local_sequence;
        if (feed === "stocks") { stockQuotes = {}; stockTrades = {}; copied.add("stockQuotes"); copied.add("stockTrades"); }
        else { optionQuotes = {}; optionTrades = []; optionTradeLatest = {}; copied.add("optionQuotes"); copied.add("optionTrades"); copied.add("optionTradeLatest"); }
        resyncGeneration++;
      }

      // Track the highest observed source sequence even when a message is
      // rejected by snapshot/event-time ordering. A later-arriving status with
      // a lower sequence must not restore an older ready state.
      if (!copied.has("feedSequences")) { feedSequences = { ...feedSequences }; copied.add("feedSequences"); }
      feedSequences[feed] = event.local_sequence;
      const watermark = eventWatermark(state, event);
      if (!eventCanReplace(undefined, event, watermark)) continue;

      let accepted = false;
      switch (event.kind) {
        case "stock_quote": {
          const prior = stockQuotes[event.symbol];
          if (!eventCanReplace(prior, event, watermark)) break;
          if (!copied.has("stockQuotes")) { stockQuotes = { ...stockQuotes }; copied.add("stockQuotes"); }
          stockQuotes[event.symbol] = event;
          accepted = true;
          break;
        }
        case "stock_trade": {
          const prior = stockTrades[event.symbol];
          if (!eventCanReplace(prior, event, watermark)) break;
          if (!copied.has("stockTrades")) { stockTrades = { ...stockTrades }; copied.add("stockTrades"); }
          stockTrades[event.symbol] = event;
          accepted = true;
          break;
        }
        case "option_quote": {
          const prior = optionQuotes[event.symbol];
          if (!eventCanReplace(prior, event, watermark)) break;
          if (!copied.has("optionQuotes")) { optionQuotes = { ...optionQuotes }; copied.add("optionQuotes"); }
          optionQuotes[event.symbol] = event;
          accepted = true;
          break;
        }
        case "option_trade": {
          const prior = optionTradeLatest[event.symbol];
          if (!eventCanReplace(prior, event, watermark)) break;
          optionTradeLatest = { ...optionTradeLatest, [event.symbol]: event };
          optionTrades = [event, ...optionTrades].slice(0, 500);
          copied.add("optionTrades");
          copied.add("optionTradeLatest");
          accepted = true;
          break;
        }
      }
      if (accepted) {
        if (event.kind.endsWith("quote")) acceptedQuotes.set(`${event.kind}:${event.symbol}`, event);
        else acceptedTrades.push(event);
      }
    }
    const hasStateChange = copied.size > 0 || acceptedStatuses.size > 0 || acceptedQuotes.size > 0 || acceptedTrades.length > 0;
    if (!hasStateChange) return state;
    return { feedStatus, connectionEpochs, feedSequences, stockQuotes, stockTrades, optionQuotes, optionTrades, optionTradeLatest,
      lastBatch: [...acceptedStatuses.values(), ...acceptedTrades, ...acceptedQuotes.values()],
      revision: state.revision + 1, resyncGeneration };
  }),
}));

export type MarketCondition =
  | "browser-disconnected" | "status-unknown" | "unauthorized" | "authentication-pending"
  | "upstream-disconnected" | "upstream-degraded" | "subscription-pending" | "not-subscribed"
  | "partial-coverage" | "waiting-for-data" | "fresh" | "stale" | "unknown";

/** Client-side fail-safe for a server projection that still says `fresh`. */
export const MAX_LIVE_MARKET_AGE_MS = 5_000;

export function marketCondition(
  state: Pick<MarketState, "browserConnected" | "feedStatus" | "stockQuotes" | "stockTrades" | "optionQuotes" | "optionTrades" | "marketClockMs">,
  feed: FeedName,
  symbol: string,
  eventType: "quote" | "trade",
  snapshotAsOf?: string | null
): MarketCondition {
  if (!state.browserConnected) return "browser-disconnected";
  const status = state.feedStatus[feed];
  if (!status) return "status-unknown";
  if (status.auth === "failed") return "unauthorized";
  if (status.auth !== "authenticated") return "authentication-pending";
  if (status.transport !== "connected") return "upstream-disconnected";
  if (status.upstream === "degraded") return "upstream-degraded";
  const desired = status.desired[eventType === "quote" ? "quotes" : "trades"];
  const confirmed = status.confirmed?.[eventType === "quote" ? "quotes" : "trades"];
  if (!desired.includes(symbol)) return "not-subscribed";
  if (!confirmed?.includes(symbol)) return "subscription-pending";
  if (!status.coverage.complete) return "partial-coverage";
  if (snapshotAsOf === null) return "unknown";
  const event = feed === "stocks"
    ? eventType === "quote" ? state.stockQuotes[symbol] : state.stockTrades[symbol]
    : eventType === "quote" ? state.optionQuotes[symbol] : state.optionTrades.find((item) => item.symbol === symbol);
  if (!event) return "waiting-for-data";
  if (event.event_time === null) return "unknown";
  if (compareRfc3339Nanos(event.event_time, event.event_time) === null) return "unknown";
  const now = state.marketClockMs || Date.now();
  if (snapshotAsOf) {
    const againstSnapshot = compareRfc3339Nanos(event.event_time, snapshotAsOf);
    if (againstSnapshot === null) return "unknown";
    if (againstSnapshot <= 0) return "waiting-for-data";
  }
  const freshness = status.freshness?.[`${symbol}:${eventType}`] ?? status.freshness?.[`${symbol}|${eventType}`];
  if (!freshness || freshness.state === "unknown") return "unknown";
  if (freshness.state === "stale") return "stale";
  if (!freshness.as_of) return "unknown";
  if (Object.hasOwn(freshness, "fresh_until")) {
    if (!freshness.fresh_until || compareRfc3339Nanos(freshness.fresh_until, freshness.fresh_until) === null) return "unknown";
    const nowAsOf = new Date(now).toISOString();
    const beforeExpiry = compareRfc3339Nanos(nowAsOf, freshness.fresh_until);
    if (beforeExpiry === null) return "unknown";
    if (beforeExpiry > 0) return "stale";
  } else {
    const eventTimeMs = Date.parse(event.event_time);
    if (!Number.isFinite(eventTimeMs)) return "unknown";
    const eventAgeMs = now - eventTimeMs;
    if (eventAgeMs < -1_000) return "unknown";
    if (eventAgeMs > MAX_LIVE_MARKET_AGE_MS) return "stale";
    if (freshness.age_ms === null || status.received_at === null) return "unknown";
    const statusReceivedAtMs = Date.parse(status.received_at);
    if (!Number.isFinite(statusReceivedAtMs)) return "unknown";
    const projectionAgeMs = freshness.age_ms + Math.max(0, now - statusReceivedAtMs);
    if (projectionAgeMs > MAX_LIVE_MARKET_AGE_MS) return "stale";
  }
  if (status.market_session === "closed") return "stale";
  const againstGatewayAsOf = compareRfc3339Nanos(event.event_time, freshness.as_of);
  if (againstGatewayAsOf === null) return "unknown";
  if (againstGatewayAsOf < 0) return "waiting-for-data";
  if (againstGatewayAsOf > 0) return "unknown";
  if (status.upstream !== "ready") return "waiting-for-data";
  return "fresh";
}

export function statusText(condition: MarketCondition): string {
  switch (condition) {
    case "browser-disconnected": return "BROWSER DISCONNECTED";
    case "status-unknown": return "UPSTREAM STATUS UNKNOWN";
    case "unauthorized": return "UPSTREAM UNAUTHORIZED";
    case "authentication-pending": return "AUTHENTICATING";
    case "upstream-disconnected": return "UPSTREAM DISCONNECTED";
    case "upstream-degraded": return "UPSTREAM DEGRADED";
    case "subscription-pending": return "SUBSCRIPTION AWAITING ACK";
    case "not-subscribed": return "NOT SUBSCRIBED";
    case "partial-coverage": return "PARTIAL COVERAGE";
    case "waiting-for-data": return "SUBSCRIBED · WAITING FOR DATA";
    case "fresh": return "FRESH · LIVE";
    case "stale": return "STALE";
    case "unknown": return "FRESHNESS UNKNOWN";
  }
}
