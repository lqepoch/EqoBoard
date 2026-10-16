import { describe, expect, it } from "vitest";

import { MarketStore } from "../../../stores/market/market-store";
import { applyOptionEvents } from "../options/OptionsWidgets";
import { applyGatewayUpdates, currentFeedStatus } from "./QuoteWidgets";
import { marketWidgetRegistrations } from "./registry";

function feedStatus(feed: "stocks" | "options", connectionEpoch: number, localSequence: number) {
  return {
    kind: "feed_status",
    feed,
    gateway_instance_id: "gateway-a",
    connection_epoch: connectionEpoch,
    local_sequence: localSequence,
  } as const;
}

function stockQuote(
  connectionEpoch: number,
  localSequence: number,
  bid: number,
  eventTime = "2026-10-15T14:30:00Z",
) {
  return {
    kind: "stock_quote",
    symbol: "SPY",
    gateway_instance_id: "gateway-a",
    connection_epoch: connectionEpoch,
    local_sequence: localSequence,
    bid,
    ask: bid + 0.01,
    event_time: eventTime,
    source_label: "configured source",
    source_entitlement: "unknown",
  } as const;
}

function stockTrade(
  connectionEpoch: number,
  localSequence: number,
  price: number,
  eventTime: string,
) {
  return {
    kind: "stock_trade",
    symbol: "SPY",
    gateway_instance_id: "gateway-a",
    connection_epoch: connectionEpoch,
    local_sequence: localSequence,
    price,
    event_time: eventTime,
    source_label: "configured source",
    source_entitlement: "unknown",
  } as const;
}

function optionQuote(connectionEpoch: number, localSequence: number, bid: number) {
  return {
    kind: "option_quote",
    symbol: "SPY261218C00600000",
    gateway_instance_id: "gateway-a",
    connection_epoch: connectionEpoch,
    local_sequence: localSequence,
    bid,
    ask: bid + 0.01,
    bid_size: 1,
    ask_size: 2,
    event_time: "2026-10-15T14:30:00Z",
    received_at: "2026-10-15T14:30:00Z",
    source_label: "configured source",
    source_entitlement: "unknown",
  } as const;
}

describe("native market widget registrations", () => {
  it("statically registers the migrated market and options surfaces with explicit provenance", () => {
    expect(marketWidgetRegistrations.map((entry) => entry.manifest.id)).toEqual([
      "market.quote",
      "market.watchlist",
      "market.stock-tape",
      "market.options-chain",
      "market.iv-skew",
      "market.option-tape",
      "market.feed-status",
      "market.orderbook",
      "market.vertical-preview",
    ]);
    for (const registration of marketWidgetRegistrations) {
      expect(registration.manifest.provenanceId).toBe(registration.provenance.provenanceId);
      expect(registration.provenance.origin).toBe("first-party");
    }
  });

  it("leaves unsupported depth inert and scopes the preview to its single disabled action", () => {
    const orderbook = marketWidgetRegistrations.find(
      (entry) => entry.manifest.id === "market.orderbook",
    );
    expect(orderbook?.allowedReadOperations).toEqual([]);
    expect(orderbook?.allowedActions).toEqual([]);
    expect(orderbook?.manifest.requiredPermissions).toEqual([]);
    expect(orderbook?.manifest.provenancePolicy).toBe("no-market-data");

    const preview = marketWidgetRegistrations.find(
      (entry) => entry.manifest.id === "market.vertical-preview",
    );
    expect(preview?.allowedReadOperations).toEqual([]);
    expect(preview?.allowedActions).toEqual(["orders.preview.vertical"]);
    expect(preview?.manifest.requiredPermissions).toEqual(["orders:preview"]);
  });

  it("budgets the two options snapshot reads together at their 30-second cadence", () => {
    for (const id of ["market.options-chain", "market.iv-skew"]) {
      const registration = marketWidgetRegistrations.find((entry) => entry.manifest.id === id);
      expect(registration?.manifest.refresh).toMatchObject({
        mode: "poll",
        minIntervalMs: 30_000,
        maxRequestsPerMinute: 4,
        maxConcurrentRequests: 1,
        whenHidden: "pause",
      });
    }
  });

  it("clears only stock stream values when the feed epoch changes or becomes unknown", () => {
    const store = new MarketStore(() => 10_000);
    const snapshotBid = 500;
    const stockRow = Object.freeze({
      symbol: "SPY",
      last: 501,
      bid: snapshotBid,
      ask: 502,
      changePercent: 0.2,
      volume: 1_000,
      quoteAt: "REST snapshot quote time",
      tradeAt: "REST snapshot trade time",
      snapshotEvidence: "REST snapshot source",
      liveQuoteEvidence: "unknown",
      liveTradeEvidence: "unknown",
      liveQuoteAt: null,
      liveTradeAt: null,
      liveBid: null,
      liveAsk: null,
      liveTradePrice: null,
    });
    type StockGridRowFixture =
      Parameters<typeof applyGatewayUpdates>[1] extends Map<string, infer Row> ? Row : never;
    const rows = new Map<string, StockGridRowFixture>([["SPY", stockRow as StockGridRowFixture]]);
    const cursor = { current: { gatewayInstanceId: null, connectionEpoch: null } };
    const quoteSequences = new Map<string, number>();
    const tradeSequences = new Map<string, number>();
    const apply = () =>
      applyGatewayUpdates(
        null,
        rows,
        store.getSnapshot(),
        ["SPY"],
        quoteSequences,
        tradeSequences,
        cursor,
      );

    store.acceptBatch([
      stockQuote(1, 1, 500.5, "2026-10-15T14:30:01Z"),
      stockTrade(1, 2, 500.75, "2026-10-15T14:30:02Z"),
    ]);
    apply();
    expect(rows.get("SPY")).toMatchObject({
      liveBid: 500.5,
      liveTradePrice: 500.75,
      liveQuoteAt: "2026-10-15T14:30:01Z",
      liveTradeAt: "2026-10-15T14:30:02Z",
      bid: snapshotBid,
      quoteAt: "REST snapshot quote time",
      tradeAt: "REST snapshot trade time",
    });

    store.acceptBatch([feedStatus("stocks", 2, 3)]);
    apply();
    expect(rows.get("SPY")).toMatchObject({
      liveBid: null,
      liveAsk: null,
      liveTradePrice: null,
      liveQuoteAt: null,
      liveTradeAt: null,
      liveQuoteEvidence: "unknown",
      liveTradeEvidence: "unknown",
      bid: snapshotBid,
      quoteAt: "REST snapshot quote time",
      tradeAt: "REST snapshot trade time",
    });

    store.acceptBatch([
      stockQuote(2, 4, 501.5, "2026-10-15T14:31:01Z"),
      stockTrade(2, 5, 501.75, "2026-10-15T14:31:02Z"),
    ]);
    apply();
    expect(rows.get("SPY")).toMatchObject({
      liveBid: 501.5,
      liveTradePrice: 501.75,
      liveQuoteAt: "2026-10-15T14:31:01Z",
      liveTradeAt: "2026-10-15T14:31:02Z",
      bid: snapshotBid,
      quoteAt: "REST snapshot quote time",
      tradeAt: "REST snapshot trade time",
    });

    store.resetForIdentityBoundary();
    apply();
    expect(rows.get("SPY")).toMatchObject({
      liveBid: null,
      liveAsk: null,
      liveTradePrice: null,
      liveQuoteAt: null,
      liveTradeAt: null,
      liveQuoteEvidence: "unknown",
      liveTradeEvidence: "unknown",
      bid: snapshotBid,
      quoteAt: "REST snapshot quote time",
      tradeAt: "REST snapshot trade time",
    });
    expect(cursor.current.connectionEpoch).toBeNull();
  });

  it("keeps prior-epoch feed source metadata unknown until a matching status arrives", () => {
    const store = new MarketStore(() => 10_000);
    store.acceptBatch([feedStatus("stocks", 1, 1)]);
    expect(currentFeedStatus(store.getSnapshot(), "stocks")?.connection_epoch).toBe(1);

    store.acceptBatch([stockQuote(2, 2, 500.5)]);

    const snapshot = store.getSnapshot();
    expect(snapshot.feeds.stocks.connectionEpoch).toBe(2);
    expect(snapshot.feeds.stocks.rawStatus?.connection_epoch).toBe(1);
    expect(currentFeedStatus(snapshot, "stocks")).toBeNull();
  });

  it("clears only option stream values at epoch boundaries and rejects unknown epochs", () => {
    const store = new MarketStore(() => 10_000);
    const symbol = "SPY261218C00600000";
    const snapshotBid = 1.1;
    const optionRow = Object.freeze({
      symbol,
      underlying: "SPY",
      expiration: "2026-12-18",
      right: "call" as const,
      strike: 600,
      bid: snapshotBid,
      ask: 1.2,
      last: null,
      bidSize: null,
      askSize: null,
      iv: 0.2,
      delta: 0.5,
      gamma: 0.1,
      theta: -0.01,
      vega: 0.1,
      quoteAt: "chain snapshot quote time",
      tradeAt: null,
      modelAsOf: "model time",
      feed: "reported chain feed",
      wire: Object.freeze({}),
      liveBid: null,
      liveAsk: null,
      liveBidSize: null,
      liveAskSize: null,
      liveSource: "unknown",
      liveEntitlement: "unknown",
      liveAt: "unknown",
      liveReceivedAt: "unknown",
      snapshotEvidence: "chain snapshot source",
    });
    type OptionGridRowFixture =
      Parameters<typeof applyOptionEvents>[1] extends Map<string, infer Row> ? Row : never;
    const rows = new Map<string, OptionGridRowFixture>([
      [symbol, optionRow as OptionGridRowFixture],
    ]);
    const cursor = { current: { gatewayInstanceId: null, connectionEpoch: null } };
    const sequences = new Map<string, number>();
    const apply = () =>
      applyOptionEvents(null, rows, store.getSnapshot(), [symbol], sequences, cursor);

    store.acceptBatch([optionQuote(1, 1, 1.15)]);
    apply();
    expect(rows.get(symbol)).toMatchObject({ liveBid: 1.15, bid: snapshotBid });

    store.acceptBatch([feedStatus("options", 2, 2)]);
    apply();
    expect(rows.get(symbol)).toMatchObject({
      liveBid: null,
      liveAsk: null,
      liveBidSize: null,
      liveAskSize: null,
      liveSource: "unknown",
      liveEntitlement: "unknown",
      liveAt: "unknown",
      liveReceivedAt: "unknown",
      bid: snapshotBid,
      quoteAt: "chain snapshot quote time",
      modelAsOf: "model time",
    });

    store.acceptBatch([optionQuote(2, 3, 1.25)]);
    apply();
    expect(rows.get(symbol)).toMatchObject({ liveBid: 1.25, bid: snapshotBid });

    store.resetForIdentityBoundary();
    apply();
    expect(rows.get(symbol)).toMatchObject({
      liveBid: null,
      liveAsk: null,
      liveSource: "unknown",
      liveEntitlement: "unknown",
      bid: snapshotBid,
      quoteAt: "chain snapshot quote time",
    });
    expect(cursor.current.connectionEpoch).toBeNull();

    store.acceptBatch([
      {
        kind: "option_quote",
        symbol,
        gateway_instance_id: "gateway-a",
        local_sequence: 4,
        bid: 1.35,
        ask: 1.36,
        bid_size: 1,
        ask_size: 1,
      },
    ]);
    apply();
    expect(store.getSnapshot().feeds.options.connectionEpoch).toBeNull();
    expect(rows.get(symbol)).toMatchObject({
      liveBid: null,
      liveAsk: null,
      liveSource: "unknown",
      bid: snapshotBid,
    });
  });
});
