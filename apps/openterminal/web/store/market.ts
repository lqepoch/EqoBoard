"use client";

import { create } from "zustand";
import type { MarketSnapshotWatermark, Quote } from "../lib/api";
import type { EqoChain } from "../lib/eqo-market";
import { compareRfc3339Nanos, FUTURE_EVENT_SKEW_MS, isWithinFutureSkew } from "../../server/src/providers/market-time.ts";
import { resolveMarketSource, type MarketSourceFields } from "../../server/src/providers/market-source.ts";
export { compareRfc3339Nanos };

export type FeedName = "stocks" | "options";
export type ChannelSymbols = { quotes: string[]; trades: string[] };
export type FeedFreshness = {
  state: "fresh" | "stale" | "unknown";
  as_of: string | null;
  age_ms: number | null;
  fresh_until?: string | null;
};
export type FeedStatusEvent = MarketSourceFields & {
  kind: "feed_status";
  gateway_instance_id: string;
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

type EventBase = MarketSourceFields & {
  gateway_instance_id: string;
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
  return quote.lastAsOf ?? quote.asOf ?? null;
}

function validGatewayInstanceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validServerTime(value: string | null | undefined, receivedAt: string | null | undefined): boolean {
  if (value == null) return true;
  if (compareRfc3339Nanos(value, value) === null) return false;
  // Gateway-backed observations must be bounded by the receive timestamp from
  // the same response/publication. Older research providers may omit it.
  if (receivedAt == null) return true;
  return isWithinFutureSkew(value, receivedAt, FUTURE_EVENT_SKEW_MS) === true;
}

function receivedAtIsNewer(next: string | null | undefined, previous: string | null | undefined): boolean {
  if (!next) return false;
  if (!previous) return true;
  const order = compareRfc3339Nanos(next, previous);
  return order !== null && order >= 0;
}

function timedGroupIsNewer(
  nextTime: string | null | undefined,
  previousTime: string | null | undefined,
  nextReceivedAt: string | null | undefined,
  previousReceivedAt: string | null | undefined,
  hasPrevious: boolean,
): boolean {
  if (!hasPrevious) return true;
  if (nextTime == null) {
    // Unknown time never replaces values whose source time is known. If both
    // are unknown, only a later complete response may fill missing fields.
    return previousTime == null && receivedAtIsNewer(nextReceivedAt, previousReceivedAt);
  }
  if (previousTime == null) return true;
  const order = compareRfc3339Nanos(nextTime, previousTime);
  if (order === null) return false;
  return order > 0 || (order === 0 && receivedAtIsNewer(nextReceivedAt, previousReceivedAt));
}

function sameSnapshotSource(
  previous: MarketSourceFields & { source?: string },
  next: MarketSourceFields & { source?: string },
): boolean {
  return previous.source === next.source && previous.source_mode === next.source_mode &&
    previous.source_label === next.source_label;
}

function mergeStockSnapshot(previous: Quote | undefined, next: Quote): Quote {
  if (!previous) return next;
  if (!sameSnapshotSource(previous, next)) return next;

  const merged: Quote = { ...previous,
    name: next.name ?? previous.name,
    source: next.source,
    source_mode: next.source_mode,
    source_label: next.source_label,
    gateway_instance_id: next.gateway_instance_id ?? previous.gateway_instance_id,
    received_at: receivedAtIsNewer(next.received_at, previous.received_at) ? next.received_at : previous.received_at,
    currency: next.currency ?? previous.currency,
    exchange: next.exchange ?? previous.exchange,
    marketState: next.marketState ?? previous.marketState,
    watermark: next.watermark ?? previous.watermark,
    watermarks: next.watermarks ?? previous.watermarks,
  };

  const genericTime = stockLastAsOf(next);
  const previousGenericTime = stockLastAsOf(previous);
  const nextHasFieldTimes = Boolean(next.quoteAt || next.tradeAt || next.dailyBarAt || next.previousDailyBarAt || next.lastAsOf);
  const previousHasFieldTimes = Boolean(previous.quoteAt || previous.tradeAt || previous.dailyBarAt || previous.previousDailyBarAt || previous.lastAsOf);
  const useLegacyGroup = !nextHasFieldTimes && !previousHasFieldTimes;
  const lastNewer = timedGroupIsNewer(genericTime, previousGenericTime, next.received_at, previous.received_at, true);

  if (useLegacyGroup) {
    if (lastNewer) {
      Object.assign(merged, {
        price: next.price, change: next.change, changePercent: next.changePercent,
        asOf: next.asOf, lastAsOf: next.lastAsOf, lastBasis: next.lastBasis,
        bid: next.bid, ask: next.ask, quoteAt: next.quoteAt, tradeAt: next.tradeAt,
        open: next.open, high: next.high, low: next.low, volume: next.volume,
        dailyBarAt: next.dailyBarAt, previousClose: next.previousClose,
        previousDailyBarAt: next.previousDailyBarAt,
      });
    }
  } else {
    const lastFields = ["price", "lastAsOf", "lastBasis", "asOf"] as const;
    if (timedGroupIsNewer(next.lastAsOf ?? next.asOf, previous.lastAsOf ?? previous.asOf,
      next.received_at, previous.received_at, true)) {
      for (const key of lastFields) merged[key] = next[key] as never;
    }
    if (timedGroupIsNewer(next.quoteAt, previous.quoteAt, next.received_at, previous.received_at, true)) {
      merged.bid = next.bid; merged.ask = next.ask; merged.quoteAt = next.quoteAt;
    }
    if (timedGroupIsNewer(next.dailyBarAt, previous.dailyBarAt, next.received_at, previous.received_at, true)) {
      merged.open = next.open; merged.high = next.high; merged.low = next.low;
      merged.volume = next.volume; merged.dailyBarAt = next.dailyBarAt;
    }
    if (timedGroupIsNewer(next.previousDailyBarAt, previous.previousDailyBarAt,
      next.received_at, previous.received_at, true)) {
      merged.previousClose = next.previousClose;
      merged.previousDailyBarAt = next.previousDailyBarAt;
    }
    if (timedGroupIsNewer(next.tradeAt, previous.tradeAt, next.received_at, previous.received_at, true)) {
      merged.tradeAt = next.tradeAt;
    }
  }

  // Research/fundamental enrichments have their own as-of field and do not
  // control SIP quote or daily-bar observations.
  const fundamentalsNewer = timedGroupIsNewer(next.fundamentalAsOf, previous.fundamentalAsOf,
    next.received_at, previous.received_at, true);
  if (fundamentalsNewer) {
    for (const key of ["avgVolume", "marketCap", "pe", "eps", "dividendYield", "week52High", "week52Low", "beta", "sharesOutstanding", "fundamentalSource", "fundamentalAsOf"] as const) {
      merged[key] = next[key] as never;
    }
  }
  if (merged.price !== null && merged.previousClose !== null) {
    merged.change = merged.price - merged.previousClose;
    merged.changePercent = merged.previousClose === 0 ? null : (merged.change / merged.previousClose) * 100;
  }
  return merged;
}

function mergeOptionSnapshot(previous: OptionSnapshot | undefined, next: OptionSnapshot): OptionSnapshot {
  if (!previous || !sameSnapshotSource(previous, next)) return next;
  const merged: OptionSnapshot = { ...previous,
    source_mode: next.source_mode,
    source_label: next.source_label,
    gateway_instance_id: next.gateway_instance_id ?? previous.gateway_instance_id,
    received_at: receivedAtIsNewer(next.received_at, previous.received_at) ? next.received_at : previous.received_at,
  };
  if (timedGroupIsNewer(next.quote_at, previous.quote_at, next.received_at, previous.received_at, true)) {
    merged.bid = next.bid; merged.ask = next.ask;
    merged.bid_size = next.bid_size; merged.ask_size = next.ask_size;
    merged.quote_at = next.quote_at;
  }
  if (timedGroupIsNewer(next.trade_at, previous.trade_at, next.received_at, previous.received_at, true)) {
    merged.last = next.last; merged.trade_at = next.trade_at;
  }
  if (timedGroupIsNewer(next.model_as_of, previous.model_as_of, next.received_at, previous.received_at, true)) {
    merged.iv = next.iv; merged.delta = next.delta; merged.gamma = next.gamma;
    merged.theta = next.theta; merged.vega = next.vega; merged.model_as_of = next.model_as_of;
    merged.greeksSource = next.greeksSource; merged.greeksAsOf = next.greeksAsOf;
  }
  return merged;
}

function validSnapshotTimes(values: Array<string | null | undefined>, receivedAt: string | null | undefined): boolean {
  return values.every((value) => validServerTime(value, receivedAt));
}

function instanceTransition(state: MarketState, instanceId: string): Partial<MarketState> {
  return {
    gatewayInstanceId: instanceId,
    retiredGatewayInstanceIds: state.gatewayInstanceId
      ? [...state.retiredGatewayInstanceIds, state.gatewayInstanceId]
      : state.retiredGatewayInstanceIds,
    gatewayInstanceGeneration: state.gatewayInstanceGeneration + 1,
    feedStatus: {}, connectionEpochs: {}, feedSequences: {},
    stockQuotes: {}, stockTrades: {}, stockSnapshots: {},
    optionQuotes: {}, optionSnapshots: {}, optionTrades: [], optionTradeLatest: {},
    snapshotWatermarks: {}, lastBatch: [],
    resyncGeneration: state.resyncGeneration + 1,
    revision: state.revision + 1,
  };
}

function canUseGatewayInstance(state: MarketState, instanceId: unknown, requestGeneration?: number): boolean {
  if (!validGatewayInstanceId(instanceId)) return false;
  if (state.retiredGatewayInstanceIds.includes(instanceId)) return false;
  if (state.gatewayInstanceId === instanceId) return true;
  return requestGeneration === undefined || requestGeneration === state.gatewayInstanceGeneration;
}

function snapshotRequestIsCurrent(state: MarketState, instanceId: unknown, requestGeneration?: number): boolean {
  if (instanceId != null) return canUseGatewayInstance(state, instanceId, requestGeneration);
  // A legacy response has no Gateway identity, so its browser-captured
  // generation is the only safe way to reject one that crossed a restart.
  return requestGeneration === undefined || requestGeneration === state.gatewayInstanceGeneration;
}

type MarketState = {
  marketClockMs: number;
  browserConnected: boolean;
  connectionError: string | null;
  subscriptionError: string | null;
  feedStatus: Partial<Record<FeedName, FeedStatusEvent>>;
  gatewayInstanceId: string | null;
  retiredGatewayInstanceIds: string[];
  gatewayInstanceGeneration: number;
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
  acceptsSnapshotInstance: (instanceId: string | null | undefined, requestGeneration: number) => boolean;
  setStockSnapshot: (quote: Quote, requestGeneration?: number) => void;
  setOptionSnapshot: (contract: OptionSnapshot, watermark?: SnapshotWatermark | null, receivedAt?: string | null, requestGeneration?: number) => void;
  setSnapshotWatermark: (watermark: SnapshotWatermark, receivedAt?: string | null, requestGeneration?: number) => void;
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
      validGatewayInstanceId(event.gateway_instance_id) &&
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
      event.decode_error_count >= 0 && event.received_at !== null &&
      compareRfc3339Nanos(event.received_at, event.received_at) !== null &&
      Object.values(event.freshness ?? {}).every((freshness) =>
        (freshness.as_of === null || validServerTime(freshness.as_of, event.received_at)) &&
        (freshness.fresh_until == null || compareRfc3339Nanos(freshness.fresh_until, freshness.fresh_until) !== null));
  }
  return ["stock_quote", "stock_trade", "option_quote", "option_trade"].includes(event.kind) &&
    validGatewayInstanceId(event.gateway_instance_id) &&
    typeof event.symbol === "string" && event.symbol.length > 0 &&
    Number.isSafeInteger(event.connection_epoch) && event.connection_epoch >= 0 &&
    Number.isSafeInteger(event.local_sequence) && event.local_sequence >= 0 &&
    compareRfc3339Nanos(event.received_at, event.received_at) !== null &&
    (event.event_time === null || validServerTime(event.event_time, event.received_at));
}

export const useMarket = create<MarketState>((set, get) => ({
  marketClockMs: Date.now(),
  browserConnected: false,
  connectionError: null,
  subscriptionError: null,
  feedStatus: {},
  gatewayInstanceId: null,
  retiredGatewayInstanceIds: [],
  gatewayInstanceGeneration: 0,
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
  acceptsSnapshotInstance: (instanceId, requestGeneration) => {
    return snapshotRequestIsCurrent(get(), instanceId, requestGeneration);
  },
  setStockSnapshot: (quote, requestGeneration) => set((state) => {
    const instanceId = quote.gateway_instance_id ?? quote.watermarks?.[0]?.gateway_instance_id ?? quote.watermark?.gateway_instance_id;
    // Legacy REST rows have no Gateway identity or field-level merge contract.
    // Keep them in React Query's response path so each poll can replace the
    // visible value; never freeze them in the shared market cache.
    if (!validGatewayInstanceId(instanceId) || !snapshotRequestIsCurrent(state, instanceId, requestGeneration)) return state;
    const knownSIPSource = resolveMarketSource(quote, "sip").mode !== "unknown";
    const times = [quote.lastAsOf, quote.asOf, quote.quoteAt, quote.tradeAt, quote.dailyBarAt, quote.previousDailyBarAt];
    if (!validSnapshotTimes(times, quote.received_at) || (knownSIPSource && (!quote.received_at || !instanceId))) return state;
    let working = state;
    let transition: Partial<MarketState> = {};
    if (instanceId && state.gatewayInstanceId !== instanceId) {
      transition = instanceTransition(state, instanceId);
      working = { ...state, ...transition };
    }
    const incomingEpoch = quote.watermarks?.find((item) => item.feed === "stocks")?.connection_epoch ?? quote.watermark?.connection_epoch;
    const currentEpoch = working.connectionEpochs.stocks;
    if (incomingEpoch !== undefined && currentEpoch !== undefined && incomingEpoch !== currentEpoch) return state;
    const next = mergeStockSnapshot(working.stockSnapshots[quote.symbol], quote);
    return { ...transition, stockSnapshots: { ...working.stockSnapshots, [quote.symbol]: next }, revision: state.revision + 1 };
  }),
  setOptionSnapshot: (contract, watermark, receivedAt, requestGeneration) => set((state) => {
    const instanceId = contract.gateway_instance_id ?? watermark?.gateway_instance_id;
    if (!validGatewayInstanceId(instanceId) || !snapshotRequestIsCurrent(state, instanceId, requestGeneration)) return state;
    const responseReceivedAt = contract.received_at ?? receivedAt;
    const knownOPRASource = resolveMarketSource(contract, "opra").mode !== "unknown";
    if (!validSnapshotTimes([contract.quote_at, contract.trade_at, contract.model_as_of], responseReceivedAt) ||
        (knownOPRASource && (!responseReceivedAt || !instanceId))) return state;
    let working = state;
    let transition: Partial<MarketState> = {};
    if (instanceId && state.gatewayInstanceId !== instanceId) {
      transition = instanceTransition(state, instanceId);
      working = { ...state, ...transition };
    }
    const currentEpoch = working.connectionEpochs.options;
    if (watermark && currentEpoch !== undefined && watermark.connection_epoch !== currentEpoch) return state;
    const next = mergeOptionSnapshot(working.optionSnapshots[contract.symbol], contract);
    return { ...transition, optionSnapshots: { ...working.optionSnapshots, [contract.symbol]: next }, revision: state.revision + 1 };
  }),
  setSnapshotWatermark: (watermark, receivedAt, requestGeneration) => set((state) => {
    if ((watermark.feed !== "stocks" && watermark.feed !== "options") ||
        !validGatewayInstanceId(watermark.gateway_instance_id) ||
        !Array.isArray(watermark.symbols) || watermark.symbols.length === 0 ||
        !watermark.symbols.every((symbol) => typeof symbol === "string" && symbol.length > 0) ||
        !Array.isArray(watermark.event_types) || watermark.event_types.length === 0 ||
        !watermark.event_types.every((eventType) => eventType === "quote" || eventType === "trade") ||
        !Number.isSafeInteger(watermark.connection_epoch) || watermark.connection_epoch < 0 ||
        !Number.isSafeInteger(watermark.local_sequence) || watermark.local_sequence < 0 ||
        (watermark.request_start_sequence !== null && watermark.request_start_sequence !== undefined &&
          (!Number.isSafeInteger(watermark.request_start_sequence) || watermark.request_start_sequence < 0 ||
            watermark.request_start_sequence > watermark.local_sequence)) ||
        !Object.values(watermark.as_of_by_symbol ?? {}).every((asOf) => validServerTime(asOf, receivedAt)) ||
        (Object.values(watermark.as_of_by_symbol ?? {}).some(Boolean) && !receivedAt)) return state;
    if (!canUseGatewayInstance(state, watermark.gateway_instance_id, requestGeneration)) return state;
    let working = state;
    let transition: Partial<MarketState> = {};
    if (state.gatewayInstanceId !== watermark.gateway_instance_id) {
      transition = instanceTransition(state, watermark.gateway_instance_id!);
      working = { ...state, ...transition };
    }
    const currentEpoch = working.connectionEpochs[watermark.feed];
    // An old in-flight REST response must not install a barrier over a newer
    // stream epoch. A newer snapshot epoch invalidates the old feed status and
    // live values until that epoch's status is received.
    if (currentEpoch !== undefined && watermark.connection_epoch < currentEpoch) return state;
    const snapshotWatermarks = { ...working.snapshotWatermarks };
    const next: Partial<MarketState> = { ...transition, snapshotWatermarks };
    let feedStatus = working.feedStatus;
    let connectionEpochs = working.connectionEpochs;
    let feedSequences = working.feedSequences;
    let stockQuotes = working.stockQuotes, stockTrades = working.stockTrades;
    let optionQuotes = working.optionQuotes, optionTrades = working.optionTrades;
    let optionTradeLatest = working.optionTradeLatest;
    let resyncGeneration = working.resyncGeneration;
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
    let gatewayInstanceId = state.gatewayInstanceId;
    let retiredGatewayInstanceIds = state.retiredGatewayInstanceIds;
    let gatewayInstanceGeneration = state.gatewayInstanceGeneration;
    let connectionEpochs = state.connectionEpochs;
    let feedSequences = state.feedSequences;
    let stockQuotes = state.stockQuotes;
    let stockTrades = state.stockTrades;
    let stockSnapshots = state.stockSnapshots;
    let optionQuotes = state.optionQuotes;
    let optionSnapshots = state.optionSnapshots;
    let optionTrades = state.optionTrades;
    let optionTradeLatest = state.optionTradeLatest;
    let snapshotWatermarks = state.snapshotWatermarks;
    let resyncGeneration = state.resyncGeneration;
    const copied = new Set<string>();
    const acceptedStatuses = new Map<FeedName, FeedStatusEvent>();
    const acceptedQuotes = new Map<string, MarketDataEvent>();
    const acceptedTrades: MarketDataEvent[] = [];

    const selectInstance = (instanceId: string): boolean => {
      if (retiredGatewayInstanceIds.includes(instanceId)) return false;
      if (gatewayInstanceId === instanceId) return true;
      if (gatewayInstanceId) {
        retiredGatewayInstanceIds = [...retiredGatewayInstanceIds, gatewayInstanceId];
      }
      gatewayInstanceId = instanceId;
      gatewayInstanceGeneration++;
      feedStatus = {}; connectionEpochs = {}; feedSequences = {};
      stockQuotes = {}; stockTrades = {}; stockSnapshots = {};
      optionQuotes = {}; optionSnapshots = {}; optionTrades = []; optionTradeLatest = {};
      snapshotWatermarks = {};
      for (const key of ["feedStatus", "connectionEpochs", "feedSequences", "stockQuotes", "stockTrades", "stockSnapshots",
        "optionQuotes", "optionSnapshots", "optionTrades", "optionTradeLatest", "snapshotWatermarks"] as const) copied.add(key);
      acceptedStatuses.clear(); acceptedQuotes.clear(); acceptedTrades.length = 0;
      resyncGeneration++;
      return true;
    };

    for (const event of batch) {
      if (!selectInstance(event.gateway_instance_id)) continue;
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
    return { feedStatus, gatewayInstanceId, retiredGatewayInstanceIds, gatewayInstanceGeneration,
      connectionEpochs, feedSequences, stockQuotes, stockTrades, stockSnapshots, optionQuotes, optionSnapshots,
      optionTrades, optionTradeLatest, snapshotWatermarks,
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
  state: Pick<MarketState, "browserConnected" | "feedStatus" | "gatewayInstanceId" | "stockQuotes" | "stockTrades" | "optionQuotes" | "optionTrades" | "marketClockMs">,
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
  if (!state.gatewayInstanceId || status.gateway_instance_id !== state.gatewayInstanceId ||
      event.gateway_instance_id !== state.gatewayInstanceId) return "unknown";
  const expectedFeed = feed === "stocks" ? "sip" : "opra";
  const statusSource = resolveMarketSource(status, expectedFeed);
  const eventSource = resolveMarketSource(event, expectedFeed);
  if (statusSource.mode === "unknown" || eventSource.mode === "unknown" ||
      statusSource.mode !== eventSource.mode || statusSource.label !== eventSource.label) return "unknown";
  const eventPublicationOrder = compareRfc3339Nanos(event.event_time, event.received_at);
  if (eventPublicationOrder === null || eventPublicationOrder > 0 ||
      isWithinFutureSkew(event.event_time, event.received_at, FUTURE_EVENT_SKEW_MS) !== true) return "unknown";
  const now = state.marketClockMs || Date.now();
  const nowAsOf = new Date(now).toISOString();
  const eventAgeBoundary = new Date(now - MAX_LIVE_MARKET_AGE_MS).toISOString();
  const eventStillWithinClientGuard = compareRfc3339Nanos(event.event_time, eventAgeBoundary);
  if (eventStillWithinClientGuard === null) return "unknown";
  if (eventStillWithinClientGuard < 0) return "stale";
  if (snapshotAsOf) {
    const againstSnapshot = compareRfc3339Nanos(event.event_time, snapshotAsOf);
    if (againstSnapshot === null) return "unknown";
    if (againstSnapshot <= 0) return "waiting-for-data";
  }
  const freshness = status.freshness?.[`${symbol}:${eventType}`] ?? status.freshness?.[`${symbol}|${eventType}`];
  if (!freshness || freshness.state === "unknown") return "unknown";
  if (freshness.state === "stale") return "stale";
  if (!freshness.as_of) return "unknown";
  if (status.received_at === null || !Number.isFinite(freshness.age_ms) || freshness.age_ms! < 0) return "unknown";
  const projectionReceivedAtMs = Date.parse(status.received_at);
  const freshnessAsOfOrder = compareRfc3339Nanos(freshness.as_of, status.received_at);
  if (!Number.isFinite(projectionReceivedAtMs) || freshnessAsOfOrder === null || freshnessAsOfOrder > 0) return "unknown";
  const projectionAgeMs = freshness.age_ms! + Math.max(0, now - projectionReceivedAtMs);
  if (projectionAgeMs > MAX_LIVE_MARKET_AGE_MS) return "stale";
  if (Object.hasOwn(freshness, "fresh_until")) {
    if (!freshness.fresh_until || compareRfc3339Nanos(freshness.fresh_until, freshness.fresh_until) === null) return "unknown";
    const beforeExpiry = compareRfc3339Nanos(nowAsOf, freshness.fresh_until);
    if (beforeExpiry === null) return "unknown";
    if (beforeExpiry >= 0) return "stale";
  }
  const againstGatewayAsOf = compareRfc3339Nanos(event.event_time, freshness.as_of);
  if (againstGatewayAsOf === null) return "unknown";
  if (againstGatewayAsOf < 0) return "waiting-for-data";
  if (againstGatewayAsOf > 0) return "unknown";
  if (status.upstream !== "ready") return "waiting-for-data";
  return "fresh";
}

export function statusText(condition: MarketCondition, source?: MarketSourceFields, feed?: "sip" | "opra"): string {
  if (condition === "fresh") {
    const mode = feed ? resolveMarketSource(source, feed).mode : "unknown";
    if (mode === "alpaca") return "FRESH · LIVE";
    if (mode === "offline_mock") return "FRESH · OFFLINE MOCK";
    return "FRESHNESS SOURCE UNKNOWN";
  }
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
    case "stale": return "STALE";
    case "unknown": return "FRESHNESS UNKNOWN";
  }
}

export function marketStatusTone(condition: MarketCondition, source?: MarketSourceFields, feed?: "sip" | "opra"): string {
  if (condition !== "fresh") return "dim";
  const mode = feed ? resolveMarketSource(source, feed).mode : "unknown";
  return mode === "alpaca" ? "up" : mode === "offline_mock" ? "amber" : "dim";
}
