import { beforeEach, describe, expect, it } from "vitest";
import {
  compareRfc3339Nanos,
  marketCondition,
  useMarket,
  type FeedStatusEvent,
  type MarketEvent,
  type OptionSnapshot,
} from "../../../web/store/market.js";

const t1 = "2026-10-07T14:30:00.000000001Z";
const t2 = "2026-10-07T14:30:00.000000002Z";
const t3 = "2026-10-07T14:30:00.000000003Z";

function status(overrides: Partial<FeedStatusEvent> = {}): FeedStatusEvent {
  return {
    kind: "feed_status",
    feed: "stocks",
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
    received_at: t1,
    last_error: null,
    decode_error_count: 0,
    freshness: {
      "QQQ:quote": { state: "fresh", as_of: t3, age_ms: 0 },
      "SPY:quote": { state: "fresh", as_of: t2, age_ms: 0 },
    },
    ...overrides,
  };
}

function quote(symbol: string, eventTime: string | null, sequence: number, epoch = 4): MarketEvent {
  return {
    kind: "stock_quote", symbol, event_time: eventTime, received_at: t3,
    connection_epoch: epoch, local_sequence: sequence, bid: 100, ask: 101,
  };
}

function watermark(symbols: string[], asOf: string, localSequence = 5) {
  return {
    feed: "stocks" as const, symbols, event_types: ["quote"] as const,
    connection_epoch: 4, request_start_sequence: 2, local_sequence: localSequence,
    as_of_by_symbol: Object.fromEntries(symbols.map((symbol) => [symbol, asOf])),
  };
}

function tradeWatermark(symbols: string[], asOf: string, localSequence = 5) {
  return {
    ...watermark(symbols, asOf, localSequence), event_types: ["trade"] as const,
  };
}

beforeEach(() => {
  useMarket.setState({
    marketClockMs: Date.parse(t3), browserConnected: false, connectionError: null, subscriptionError: null,
    feedStatus: {}, connectionEpochs: {}, feedSequences: {}, stockQuotes: {}, stockTrades: {}, stockSnapshots: {},
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

    store.setSnapshotWatermark(watermark(["QQQ"], t2));

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
      marketState: null, source: "Alpaca SIP", asOf: t3, lastAsOf: t3, lastBasis: "trade" });
    store.setStockSnapshot({ ...useMarket.getState().stockSnapshots.QQQ!, price: 100, asOf: t1, lastAsOf: t1 });
    store.setSnapshotWatermark(watermark(["QQQ"], t3, 8));
    store.setSnapshotWatermark(watermark(["QQQ"], t2, 9));

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
    store.setSnapshotWatermark(oldStockWatermark);
    store.setSnapshotWatermark(oldOptionWatermark);
    store.setStockSnapshot({ symbol: "QQQ", name: null, price: 90, change: null, changePercent: null,
      open: null, high: null, low: null, previousClose: null, bid: null, ask: null, volume: null,
      avgVolume: null, marketCap: null, pe: null, eps: null, dividendYield: null, week52High: null,
      week52Low: null, beta: null, sharesOutstanding: null, currency: "USD", exchange: null,
      marketState: null, source: "Alpaca SIP", asOf: t1, lastAsOf: t1, watermark: oldStockWatermark });
    store.setOptionSnapshot({ symbol: "QQQ261009C00600000", quote_at: t1 } as unknown as OptionSnapshot, oldOptionWatermark);

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
    store.setSnapshotWatermark(old);
    expect(useMarket.getState().stockQuotes.QQQ?.connection_epoch).toBe(5);
    expect(useMarket.getState().snapshotWatermarks["stocks:QQQ:quote"]).toBeUndefined();
    expect(useMarket.getState().feedStatus.stocks?.connection_epoch).toBe(5);
  });

  it("uses REST request-start, not response-end, as the initial SSE sequence fence", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.setSnapshotWatermark({
      ...watermark(["QQQ"], t1, 10), request_start_sequence: 2,
    });
    store.applyBatch([quote("QQQ", t2, 3, 4)]);
    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(t2);
    expect(useMarket.getState().lastBatch).toEqual([expect.objectContaining({
      kind: "stock_quote", symbol: "QQQ", local_sequence: 3, event_time: t2,
    })]);
  });

  it("keeps quote and trade snapshot barriers separate", () => {
    const store = useMarket.getState();
    store.setConnection(true);
    store.setSnapshotWatermark(watermark(["QQQ"], t2, 10));
    store.applyBatch([
      quote("QQQ", t3, 3, 4),
      { kind: "stock_trade", symbol: "QQQ", price: 101, size: 1, event_time: t1,
        received_at: t3, connection_epoch: 4, local_sequence: 4 },
    ]);
    expect(useMarket.getState().stockQuotes.QQQ?.event_time).toBe(t3);
    expect(useMarket.getState().stockTrades.QQQ?.event_time).toBe(t1);
    expect(useMarket.getState().snapshotWatermarks["stocks:QQQ:trade"]).toBeUndefined();
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

    store.applyBatch([status({ local_sequence: 3, received_at: t1, freshness: {
      "QQQ:quote": { state: "fresh", as_of: t3, age_ms: 99_000, fresh_until: "2026-10-07T14:30:05Z" },
    } }), quote("QQQ", t3, 4)]);
    store.setMarketClock(Date.parse(t3));
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("fresh");
    store.setMarketClock(Date.parse(t3) + 5_001);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("stale");

    store.applyBatch([status({ local_sequence: 5, freshness: {
      "QQQ:quote": { state: "fresh", as_of: t2, age_ms: 0, fresh_until: null },
    } })]);
    expect(marketCondition(useMarket.getState(), "stocks", "QQQ", "quote")).toBe("unknown");
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
