import { describe, expect, it } from "vitest";
import { applyOptionEvents, tapeRow } from "./OptionsWidgets";
import { MarketStore } from "@/stores/market/market-store";

const trade = {
  kind: "option_trade",
  gateway_instance_id: "synthetic-test",
  local_sequence: 1,
  symbol: "SPY261218C00600000",
  price: 4.25,
  size: 2,
  received_at: "2026-10-16T14:30:01Z",
  source_label: "synthetic test; not provider data",
  source_entitlement: "unknown",
};

const OPTION_SYMBOL = "SPY261218C00600000";
const RECEIVED_AT = "2026-10-16T14:30:01Z";

function applyQuoteEvent(overrides: Record<string, unknown> = {}) {
  const quote = {
    kind: "option_quote",
    gateway_instance_id: "synthetic-test",
    connection_epoch: 1,
    local_sequence: 1,
    symbol: OPTION_SYMBOL,
    received_at: RECEIVED_AT,
    source_label: "synthetic test; not provider data",
    source_entitlement: "unknown",
    bid: 4.25,
    ask: 4.5,
    bid_size: 1,
    ask_size: 2,
    ...overrides,
  };
  const store = new MarketStore(() => 10_000);
  store.acceptBatch([quote], 10_000);

  type OptionRow = Parameters<typeof applyOptionEvents>[1] extends Map<string, infer Row>
    ? Row
    : never;
  const row = {
    symbol: OPTION_SYMBOL,
    underlying: "SPY",
    expiration: "2026-12-18",
    right: "call",
    strike: 600,
    bid: null,
    ask: null,
    last: null,
    bidSize: null,
    askSize: null,
    iv: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    quoteAt: null,
    tradeAt: null,
    modelAsOf: null,
    feed: "opra",
    wire: {},
    liveBid: null,
    liveAsk: null,
    liveBidSize: null,
    liveAskSize: null,
    liveSource: "unknown",
    liveEntitlement: "unknown",
    liveAt: "unknown",
    liveReceivedAt: "unknown",
    snapshotEvidence: "synthetic test",
  } as OptionRow;
  const rows = new Map<string, OptionRow>([[OPTION_SYMBOL, row]]);
  const transactions: unknown[] = [];
  const api = {
    applyTransactionAsync: (transaction: unknown) => transactions.push(transaction),
  } as unknown as Parameters<typeof applyOptionEvents>[0];

  applyOptionEvents(api, rows, store.getSnapshot(), [OPTION_SYMBOL], new Map(), {
    current: { gatewayInstanceId: null, connectionEpoch: null },
  });
  return { row: rows.get(OPTION_SYMBOL), transactions };
}

describe("option tape time provenance", () => {
  it("does not turn Gateway receive time into a missing market event time", () => {
    expect(tapeRow({ ...trade, event_time: null })).toMatchObject({
      eventAt: "unknown",
      receivedAt: trade.received_at,
      entitlement: "unknown",
    });
    expect(tapeRow(trade)?.eventAt).toBe("unknown");
  });

  it("preserves separately supplied market and receive times", () => {
    expect(tapeRow({ ...trade, event_time: "2026-10-16T14:30:00Z" })).toMatchObject({
      eventAt: "2026-10-16T14:30:00Z",
      receivedAt: trade.received_at,
    });
    expect(tapeRow({ ...trade, received_at: null })?.receivedAt).toBe("unknown");
  });
});

describe("option chain stream timestamp provenance", () => {
  it("keeps missing market event time unknown and displays Gateway receive time separately", () => {
    const result = applyQuoteEvent();

    expect(result.row).toMatchObject({ liveAt: "unknown", liveReceivedAt: RECEIVED_AT });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      update: [expect.objectContaining({ liveAt: "unknown", liveReceivedAt: RECEIVED_AT })],
    });
  });

  it("preserves supplied market event time separately from Gateway receive time", () => {
    const eventTime = "2026-10-16T14:30:00Z";
    const result = applyQuoteEvent({ event_time: eventTime });

    expect(result.row).toMatchObject({ liveAt: eventTime, liveReceivedAt: RECEIVED_AT });
  });
});
