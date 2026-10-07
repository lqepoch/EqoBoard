import { beforeEach, describe, expect, it } from "vitest";
import {
  compareRfc3339Nanos,
  marketCondition,
  useMarket,
  type FeedStatusEvent,
  type MarketEvent,
  type OptionSnapshot,
  type Quote,
} from "../../../web/store/market.js";

const t1 = "2026-10-07T14:30:00.000000001Z";
const t2 = "2026-10-07T14:30:00.000000002Z";
const t3 = "2026-10-07T14:30:00.000000003Z";
const instanceA = "gateway-instance-a";
const instanceB = "gateway-instance-b";
const offlineSource = { source_mode: "offline_mock", source_label: "OFFLINE MOCK — NOT MARKET DATA" } as const;

function status(overrides: Partial<FeedStatusEvent> = {}): FeedStatusEvent {
  return {
    kind: "feed_status",
    gateway_instance_id: instanceA,
    feed: "stocks",
    ...offlineSource,
    transport: "connected",
    auth: "authenticated",
    desired: { quotes: ["QQQ", "SPY"], trades: ["QQQ", "SPY"] },
    confirmed: { quotes: ["QQQ", "SPY"], trades: ["QQQ", "SPY"] },
    pending: {
      subscribe: { quotes: [], trades: [] },
      unsubscribe: { quotes: [], trades: [] },
    },
    upstream: "ready",
    coverage: { desired_count: 2, confirmed_count: 2, limit: null, complete: true },
    connection_epoch: 4,
    local_sequence: 1,
    received_at: t3,
    last_error: null,
    decode_error_count: 0,
    freshness: {
      "QQQ:quote": { state: "fresh", as_of: t3, age_ms: 0 },
      "SPY:quote": { state: "fresh", as_of: t2, age_ms: 0 },
    },
    ...overrides,
  };
}

function quote(
  symbol: string,
  eventTime: string | null,
  sequence: number,
  epoch = 4,
  gatewayInstanceId = instanceA,
  sourceFields: typeof offlineSource = offlineSource,
): MarketEvent {
  return {
    kind: "stock_quote", symbol, event_time: eventTime, received_at: t3,
    gateway_instance_id: gatewayInstanceId, ...sourceFields,
    connection_epoch: epoch, local_sequence: sequence, bid: 100, ask: 101,
  };
}

function watermark(symbols: string[], asOf: string, localSequence = 5) {
  return {
    gateway_instance_id: instanceA, feed: "stocks" as const, symbols, event_types: ["quote"] as const,
    connection_epoch: 4, request_start_sequence: 2, local_sequence: localSequence,
    as_of_by_symbol: Object.fromEntries(symbols.map((symbol) => [symbol, asOf])),
  };
}

function tradeWatermark(symbols: string[], asOf: string, localSequence = 5) {
  return {
    ...watermark(symbols, asOf, localSequence), event_types: ["trade"] as const,
  };
}

function optionSnapshot(overrides: Partial<OptionSnapshot> = {}): OptionSnapshot {
  return {
    symbol: "QQQ261009P00600000", right: "put", strike: 600,
    bid: 1, ask: 1.2, last: 1.1, iv: 0.2, delta: -0.4, gamma: 0.02,
    theta: -0.01, vega: 0.1, bid_size: 2, ask_size: 3,
    quote_at: t1, trade_at: t1, model_as_of: t1,
    ...offlineSource, gateway_instance_id: instanceA, received_at: t3,
    greeksSource: "OFFLINE MOCK — NOT MARKET DATA", greeksAsOf: t1,
    ...overrides,
  };
}

function stockSnapshot(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "QQQ", name: "QQQ", price: 100, change: 1, changePercent: 1,
    open: 99, high: 100, low: 98, previousClose: 99, bid: 99.9, ask: 100.1,
    volume: 1000, avgVolume: null, marketCap: null, pe: null, eps: null,
    dividendYield: null, week52High: null, week52Low: null, beta: null,
    sharesOutstanding: null, currency: "USD", exchange: "NASDAQ", marketState: null,
    source: "OFFLINE MOCK — NOT MARKET DATA", ...offlineSource,
    gateway_instance_id: instanceA, received_at: t3,
    asOf: t1, lastAsOf: t1, lastBasis: "trade", quoteAt: t3, tradeAt: t1,
    dailyBarAt: t3, previousDailyBarAt: t3,
    ...overrides,
  };
}

beforeEach(() => {
  useMarket.setState({
    marketClockMs: Date.parse(t3), browserConnected: false, connectionError: null, subscriptionError: null,
    feedStatus: {}, gatewayInstanceId: null, retiredGatewayInstanceIds: [], gatewayInstanceGeneration: 0,
    connectionEpochs: {}, feedSequences: {}, stockQuotes: {}, stockTrades: {}, stockSnapshots: {},
    optionQuotes: {}, optionSnapshots: {}, optionTrades: [], optionTradeLatest: {},
    snapshotWatermarks: {}, lastBatch: [], revision: 0, resyncGeneration: 0,
  });
});

describe("shared market snapshot and stream state", () => {
  it("compares RFC3339 nanoseconds exactly and rejects malformed precision", () => {
    expect(compareRfc3339Nanos(t1, t2)).toBe(-1);
    expect(compareRfc3339Nanos("2026-10-07T10:30:00.000000001-04:00", t1)).toBe(0);
    expect(compareRfc3339Nanos("2026-10-07T14:30:00.1234567890Z", t1)).toBeNull();
  });

  it("keeps newer events and REST snapshots scoped to their symbol and event type", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status(), quote("QQQ", t1, 2), quote("SPY", t1, 3), quote("QQQ", t3, 4)]);

    store.setSnapshotWatermark(watermark(["QQQ"], t2), t3);

    const after = useMarket.getState();
    expect(after.stockQuotes.SPY?.event_time).toBe(t1);
    expect(after.stockQuotes.QQQ?.event_time).toBe(t3);
    expect(after.snapshotWatermarks["stocks:SPY:quote"]).toBeUndefined();
    expect(after.snapshotWatermarks["stocks:QQQ:trade"]).toBeUndefined();
    expect(after.snapshotWatermarks["stocks:QQQ:quote"]).toBeDefined();
  });

  it("does not let an older REST snapshot or watermark overwrite a newer result", () => {
    const store = useMarket.getState();
    store.setStockSnapshot({ symbol: "QQQ", name: null, price: 102, change: null, changePercent: null,
      open: null, high: null, low: null, previousClose: null, bid: null, ask: null, volume: null,
      avgVolume: null, marketCap: null, pe: null, eps: null, dividendYield: null, week52High: null,
      week52Low: null, beta: null, sharesOutstanding: null, currency: "USD", exchange: null,
      marketState: null, source: "OFFLINE MOCK — NOT MARKET DATA", ...offlineSource,
      gateway_instance_id: instanceA, received_at: t3, asOf: t3, lastAsOf: t3, lastBasis: "trade" });
    store.setStockSnapshot({ ...useMarket.getState().stockSnapshots.QQQ!, price: 100, asOf: t1, lastAsOf: t1 });
    store.setSnapshotWatermark(watermark(["QQQ"], t3, 8), t3);
    store.setSnapshotWatermark(watermark(["QQQ"], t2, 9), t3);

    expect(useMarket.getState().stockSnapshots.QQQ?.price).toBe(102);
    expect(useMarket.getState().snapshotWatermarks["stocks:QQQ:quote"]?.as_of_by_symbol?.QQQ).toBe(t3);
  });

  it("drops late lower-sequence and older event-time ticks, and ignores prior epochs", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status(), quote("QQQ", t3, 8)]);
    store.applyBatch([quote("QQQ", t2, 7), quote("QQQ", t2, 9), quote("QQQ", t1, 10, 3)]);

    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(t3);
    expect(useMarket.getState().stockQuotes.QQQ?.local_sequence).toBe(8);
  });

  it("rejects late lower/equal status sequences and only publishes accepted quote updates", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status(), quote("QQQ", t3, 3), quote("QQQ", t2, 4)]);
    expect(useMarket.getState().lastBatch.filter((event) => event.kind === "stock_quote")).toEqual([
      expect.objectContaining({ symbol: "QQQ", event_time: t3, local_sequence: 3 }),
    ]);

    store.applyBatch([status({ local_sequence: 5, upstream: "degraded" })]);
    store.applyBatch([status({ local_sequence: 4, upstream: "ready" })]);
    store.applyBatch([status({ local_sequence: 5, upstream: "ready" })]);
    expect(useMarket.getState().feedStatus.stocks?.upstream).toBe("degraded");
    expect(useMarket.getState().feedStatus.stocks?.local_sequence).toBe(5);

    store.applyBatch([quote("QQQ", t3, 6)]);
    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(t3);
    store.applyBatch([quote("QQQ", t2, 7)]);
    expect(useMarket.getState().lastBatch).toEqual([]);
    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(t3);
  });

  it("fences stale REST epochs from feed watermarks and both snapshot stores", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([
      status({ connection_epoch: 5, local_sequence: 1 }),
      { ...quote("QQQ", t3, 2, 5) },
      status({ feed: "options", connection_epoch: 5, local_sequence: 1 }),
    ]);
    const oldStockWatermark = { ...watermark(["QQQ"], t1), connection_epoch: 4 };
    const oldOptionWatermark = { ...oldStockWatermark, feed: "options" as const };
    store.setSnapshotWatermark(oldStockWatermark, t3);
    store.setSnapshotWatermark(oldOptionWatermark, t3);
    store.setStockSnapshot({ symbol: "QQQ", name: null, price: 90, change: null, changePercent: null,
      open: null, high: null, low: null, previousClose: null, bid: null, ask: null, volume: null,
      avgVolume: null, marketCap: null, pe: null, eps: null, dividendYield: null, week52High: null,
      week52Low: null, beta: null, sharesOutstanding: null, currency: "USD", exchange: null,
      marketState: null, source: "OFFLINE MOCK — NOT MARKET DATA", ...offlineSource,
      gateway_instance_id: instanceA, received_at: t3, asOf: t1, lastAsOf: t1, watermark: oldStockWatermark });
    store.setOptionSnapshot({ symbol: "QQQ261009C00600000", quote_at: t1, ...offlineSource,
      gateway_instance_id: instanceA, received_at: t3 } as unknown as OptionSnapshot, oldOptionWatermark, t3);

    const after = useMarket.getState();
    expect(after.stockQuotes.QQQ?.event_time).toBe(t3);
    expect(after.stockSnapshots.QQQ).toBeUndefined();
    expect(after.optionSnapshots["QQQ261009C00600000"]).toBeUndefined();
    expect(after.snapshotWatermarks["stocks:QQQ:quote"]).toBeUndefined();
    expect(after.snapshotWatermarks["options:QQQ:quote"]).toBeUndefined();
  });

  it("does not let an older REST response epoch erase a newer live epoch", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status({ connection_epoch: 5, local_sequence: 1 }), quote("QQQ", t3, 2, 5)]);
    const old = { ...watermark(["QQQ"], t1), connection_epoch: 4 };
    store.setSnapshotWatermark(old, t3);
    expect(useMarket.getState().stockQuotes.QQQ?.connection_epoch).toBe(5);
    expect(useMarket.getState().snapshotWatermarks["stocks:QQQ:quote"]).toBeUndefined();
    expect(useMarket.getState().feedStatus.stocks?.connection_epoch).toBe(5);
  });

  it("uses REST request-start, not response-end, as the initial SSE sequence fence", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.setSnapshotWatermark({
      ...watermark(["QQQ"], t1, 10), request_start_sequence: 2,
    }, t3);
    store.applyBatch([quote("QQQ", t2, 3, 4)]);
    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(t2);
    expect(useMarket.getState().lastBatch).toEqual([expect.objectContaining({
      kind: "stock_quote", symbol: "QQQ", local_sequence: 3, event_time: t2,
    })]);
  });

  it("keeps quote and trade snapshot barriers separate", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.setSnapshotWatermark(watermark(["QQQ"], t2, 10), t3);
    store.applyBatch([
      quote("QQQ", t3, 3, 4),
      { kind: "stock_trade", symbol: "QQQ", price: 101, size: 1, event_time: t1,
        gateway_instance_id: instanceA, ...offlineSource,
        received_at: t3, connection_epoch: 4, local_sequence: 4 },
    ]);
    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(t3);
    expect(useMarket.getState().stockTrades.QQQ?.event_time).toBe(t1);
    expect(useMarket.getState().snapshotWatermarks["stocks:QQQ:trade"]).toBeUndefined();
  });

  it("does not call a status LIVE when its accepted event has a different or missing source", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    const wrongSource = { source_mode: "alpaca", source_label: "Alpaca SIP" };
    store.applyBatch([status(), {
      ...quote("QQQ", t3, 2), ...wrongSource,
    }]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("unknown");

    store.applyBatch([quote("QQQ", t3, 3)]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("fresh");
  });

  it("rejects excessive future events and never marks tolerated future data LIVE", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status()]);
    const farFuture = new Date(Date.parse(t3) + 2_000).toISOString();
    store.applyBatch([{
      ...quote("QQQ", farFuture, 2), received_at: t3,
    }]);
    expect(useMarket.getState().stockQuotes.QQQ).toBeUndefined();
    expect(useMarket.getState().feedSequences.stocks).toBe(1);

    const toleratedFuture = new Date(Date.parse(t3) + 500).toISOString();
    store.applyBatch([{
      ...quote("QQQ", toleratedFuture, 2), received_at: t3,
    }]);
    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(toleratedFuture);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("unknown");
  });

  it("does not let a future REST timestamp contaminate a snapshot or its price", () => {
    const store = useMarket.getState();
    store.setStockSnapshot(stockSnapshot({ price: 100, lastAsOf: t1, asOf: t1 }));
    const future = new Date(Date.parse(t3) + 2_000).toISOString();
    store.setStockSnapshot(stockSnapshot({ price: 999, lastAsOf: future, asOf: future, received_at: t3 }));
    expect(useMarket.getState().stockSnapshots.QQQ?.price).toBe(100);
    expect(useMarket.getState().stockSnapshots.QQQ?.lastAsOf).toBe(t1);
  });

  it("merges stock quote, trade, and bar groups by their independent source times", () => {
    const store = useMarket.getState();
    store.setStockSnapshot(stockSnapshot({
      price: 100, previousClose: 99, bid: 99.9, ask: 100.1, volume: 1000,
      lastAsOf: t1, asOf: t1, quoteAt: t3, tradeAt: t1, dailyBarAt: t3, previousDailyBarAt: t3,
    }));
    store.setStockSnapshot(stockSnapshot({
      price: 110, previousClose: 90, bid: 50, ask: 51, volume: 5,
      lastAsOf: t3, asOf: t3, quoteAt: t1, tradeAt: t3, dailyBarAt: t1, previousDailyBarAt: t1,
    }));

    const merged = useMarket.getState().stockSnapshots.QQQ!;
    expect(merged.price).toBe(110);
    expect(merged.lastAsOf).toBe(t3);
    expect(merged.change).toBe(11);
    expect(merged.changePercent).toBeCloseTo(11 / 99 * 100);
    expect(merged.bid).toBe(99.9);
    expect(merged.ask).toBe(100.1);
    expect(merged.quoteAt).toBe(t3);
    expect(merged.volume).toBe(1000);
    expect(merged.dailyBarAt).toBe(t3);
    expect(merged.previousClose).toBe(99);
    expect(merged.previousDailyBarAt).toBe(t3);
    expect(merged.tradeAt).toBe(t3);
  });

  it("merges option quote, trade, and model fields independently", () => {
    const store = useMarket.getState();
    store.setOptionSnapshot(optionSnapshot({ quote_at: t3, trade_at: t1, model_as_of: t1 }));
    store.setOptionSnapshot(optionSnapshot({
      bid: 0.1, ask: 0.2, bid_size: 9, ask_size: 10,
      last: 2.2, iv: 0.4, delta: -0.7,
      quote_at: t1, trade_at: t3, model_as_of: t3,
    }));

    const merged = useMarket.getState().optionSnapshots["QQQ261009P00600000"]!;
    expect(merged.bid).toBe(1);
    expect(merged.ask).toBe(1.2);
    expect(merged.quote_at).toBe(t3);
    expect(merged.last).toBe(2.2);
    expect(merged.trade_at).toBe(t3);
    expect(merged.iv).toBe(0.4);
    expect(merged.delta).toBe(-0.7);
    expect(merged.model_as_of).toBe(t3);
  });

  it("does not cache legacy snapshots without Gateway identity", () => {
    const store = useMarket.getState();
    const legacyStock = stockSnapshot({
      price: 500, lastAsOf: null, asOf: null, lastBasis: "unknown", tradeAt: t1,
      quoteAt: null, dailyBarAt: null, previousDailyBarAt: null,
      source: "Alpaca SIP", source_mode: undefined, source_label: undefined,
      gateway_instance_id: undefined, received_at: undefined,
    });
    store.setStockSnapshot(legacyStock);
    store.setStockSnapshot({ ...legacyStock, price: 501, tradeAt: t2 });

    const legacyOption = optionSnapshot({
      source_mode: undefined, source_label: undefined,
      gateway_instance_id: undefined, received_at: undefined,
    });
    store.setOptionSnapshot(legacyOption, null, null);
    store.setOptionSnapshot({ ...legacyOption, last: 2, trade_at: t2 }, null, null);

    expect(useMarket.getState().stockSnapshots.QQQ).toBeUndefined();
    expect(useMarket.getState().optionSnapshots[legacyOption.symbol]).toBeUndefined();
  });

  it("recovers from a Gateway restart with a lower feed epoch and rejects old instance data", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([
      status({ gateway_instance_id: instanceA, connection_epoch: 2, local_sequence: 1 }),
      { ...quote("QQQ", t3, 2, 2), bid: 2, ask: 3 },
    ]);
    const oldRequestGeneration = useMarket.getState().gatewayInstanceGeneration;
    store.setStockSnapshot(stockSnapshot({ price: 101, gateway_instance_id: instanceA }));
    store.setConnection(false, "Gateway restarted");
    store.setConnection(true);
    store.applyBatch([
      status({ gateway_instance_id: instanceB, connection_epoch: 1, local_sequence: 1 }),
      { ...quote("QQQ", t3, 2, 1, instanceB), bid: 4, ask: 5 },
    ]);
    store.setStockSnapshot(stockSnapshot({ price: 102, gateway_instance_id: instanceB }),
      useMarket.getState().gatewayInstanceGeneration);
    store.setOptionSnapshot(optionSnapshot({ gateway_instance_id: instanceB }), null, t3,
      useMarket.getState().gatewayInstanceGeneration);

    store.applyBatch([
      status({ gateway_instance_id: instanceA, connection_epoch: 3, local_sequence: 90 }),
      { ...quote("QQQ", new Date(Date.parse(t3) + 1_000).toISOString(), 91, 3), bid: 0, ask: 0 },
    ]);
    store.setStockSnapshot(stockSnapshot({ price: 1, gateway_instance_id: instanceA }), oldRequestGeneration);
    store.setSnapshotWatermark({ ...watermark(["QQQ"], t1), gateway_instance_id: instanceA }, t3, oldRequestGeneration);
    const legacyStock = stockSnapshot({
      price: 2, source: "Alpaca SIP", source_mode: undefined, source_label: undefined,
      gateway_instance_id: undefined, received_at: undefined,
    });
    store.setStockSnapshot(legacyStock, oldRequestGeneration);
    const legacyOption = optionSnapshot({ source_mode: undefined, source_label: undefined,
      gateway_instance_id: undefined, received_at: undefined });
    store.setOptionSnapshot(legacyOption, null, null, oldRequestGeneration);

    const state = useMarket.getState();
    expect(state.gatewayInstanceId).toBe(instanceB);
    expect(state.retiredGatewayInstanceIds).toContain(instanceA);
    expect(state.feedStatus.stocks?.connection_epoch).toBe(1);
    expect(state.stockQuotes.QQQ?.bid).toBe(4);
    expect(state.stockSnapshots.QQQ?.price).toBe(102);
    expect(state.optionSnapshots["QQQ261009P00600000"]?.gateway_instance_id).toBe(instanceB);
    expect(state.optionSnapshots["QQQ261009P00600000"]?.bid).toBe(1);
    expect(state.snapshotWatermarks["stocks:QQQ:quote"]).toBeUndefined();
  });

  it("requires browser, authenticated ACK coverage, known event time, and gateway freshness for LIVE", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status(), quote("QQQ", null, 2)]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote", t1)).toBe("unknown");

    store.applyBatch([quote("QQQ", t3, 3)]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote", t1)).toBe("fresh");
    store.setConnection(false, "stream interrupted");
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote", t1)).toBe("browser-disconnected");
    expect(useMarket.getState().stockQuotes.QQQ).toBeUndefined();
  });

  it("expires a silent live feed from the shared clock and honors gateway fresh-until when present", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status(), quote("QQQ", t3, 2)]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("fresh");
    store.setMarketClock(Date.parse(t3) + 5_001);
    expect(useMarket.getState().browserConnected).toBe(true);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("stale");

    store.applyBatch([status({ local_sequence: 3, received_at: t3, freshness: {
      "QQQ:quote": { state: "fresh", as_of: t3, age_ms: 0, fresh_until: "2026-10-07T14:30:15Z" },
    } }), quote("QQQ", t3, 4)]);
    store.setMarketClock(Date.parse(t3));
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("fresh");
    store.setMarketClock(Date.parse(t3) + 5_001);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("stale");

    store.setMarketClock(Date.parse(t3));
    store.applyBatch([status({ local_sequence: 5, freshness: {
      "QQQ:quote": { state: "fresh", as_of: t2, age_ms: 0, fresh_until: null },
    } })]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("unknown");
  });

  it("keeps Gateway session context separate from event freshness", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status({
      market_session: "closed",
      freshness: {
        "QQQ:quote": { state: "fresh", as_of: t3, age_ms: 0, fresh_until: "2026-10-07T14:30:05Z" },
      },
    }), quote("QQQ", t3, 2)]);

    expect(useMarket.getState().feedStatus.stocks?.market_session).toBe("closed");
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("fresh");

    store.setMarketClock(Date.parse(t3) + 5_001);
    expect(useMarket.getState().feedStatus.stocks?.market_session).toBe("closed");
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("stale");
  });

  it("shows authorization, ACK, and partial-coverage failures independently of browser SSE", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.applyBatch([status({ auth: "failed" })]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("unauthorized");

    store.applyBatch([status({ auth: "authenticated", local_sequence: 2, confirmed: null })]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("subscription-pending");

    store.applyBatch([status({ auth: "authenticated", local_sequence: 3,
      coverage: { desired_count: 2, confirmed_count: 1, limit: null, complete: false } })]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("partial-coverage");
  });
});
