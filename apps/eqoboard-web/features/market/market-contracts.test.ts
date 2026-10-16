import { describe, expect, it } from "vitest";

import {
  decodeOptionChainResponse,
  decodeQuoteResponse,
  decodeVerticalPreviewReceipt,
} from "./market-contracts";
import type { VerticalPreviewIntent } from "../data/operations";

const quoteResponse = {
  source: "alpaca",
  feed: "sip",
  as_of: "2026-10-15T02:00:00Z",
  snapshots: [
    {
      symbol: "SPY",
      last: 600,
      bid: 599.99,
      ask: 600.01,
      open: null,
      high: null,
      low: null,
      previous_close: null,
      change_percent: null,
      volume: null,
      quote_at: "2026-10-15T01:59:59Z",
    },
  ],
};

const optionResponse = {
  underlying: "SPY",
  expiration: "2026-12-18",
  feed: "opra",
  source: "alpaca",
  as_of: "2026-10-15T02:00:00Z",
  truncated: false,
  contracts: [
    {
      symbol: "SPY261218C00600000",
      underlying: "SPY",
      expiration: "2026-12-18",
      right: "call",
      strike: 600,
      bid: 4.1,
      ask: 4.2,
      last: null,
      bid_size: 1,
      ask_size: 2,
      iv: 0.2,
      delta: 0.5,
      gamma: 0.01,
      theta: -0.1,
      vega: 0.2,
      quote_at: "2026-10-15T01:59:59Z",
      trade_at: null,
      model_as_of: null,
      feed: "opra",
    },
  ],
};

const previewIntent: VerticalPreviewIntent = {
  broker: "alpaca",
  environment: "paper",
  kind: "vertical",
  symbol: null,
  quantity: 1,
  limit_price: 2.5,
  net_effect: "debit",
  legs: [
    { symbol: "SPY261218C00600000", side: "buy" },
    { symbol: "SPY261218C00605000", side: "sell" },
  ],
};

const previewResponse = {
  execution_enabled: false,
  preview: {
    preview_id: "preview-1",
    expires_at: "2026-10-15T03:00:00Z",
    estimated_max_loss: 250,
    currency: "USD",
    intent: previewIntent,
  },
};

describe("native market response adapters", () => {
  it("accepts known Alpaca snapshots and retains the original provider envelope", () => {
    const decoded = decodeQuoteResponse(quoteResponse);
    expect(decoded?.status).toBe("available");
    if (decoded?.status !== "available") return;
    expect(decoded.evidence).toMatchObject({
      source: "alpaca",
      feed: "sip",
      asOf: quoteResponse.as_of,
    });
    expect(decoded.snapshots[0]).toMatchObject({
      symbol: "SPY",
      last: 600,
      bid: 599.99,
      ask: 600.01,
    });
    expect(decoded.wire).toEqual(quoteResponse);
  });

  it("does not infer an Alpaca source from source_mode alone", () => {
    const decoded = decodeQuoteResponse({
      source_mode: "alpaca",
      feed: "sip",
      as_of: quoteResponse.as_of,
      snapshots: quoteResponse.snapshots,
    });
    expect(decoded?.status).toBe("unsupported-source");
    expect(decoded?.evidence.source).toBeNull();
  });

  it("accepts the current Futu Gateway snapshots without promoting receipt time to market time", () => {
    const futuResponse = {
      feed: "futu",
      source_mode: "futu",
      source_label: "Futu OpenD",
      source_entitlement: "unknown",
      received_at: "2026-10-15T02:00:01Z",
      gateway_instance_id: "gateway-a",
      snapshots: [
        {
          symbol: "SPY",
          last: 600,
          previous_close: 590,
          change_percent: 1.69,
          open: 595,
          high: 601,
          low: 594,
          bid: null,
          ask: null,
          volume: 1_000,
          feed: "futu",
          last_as_of: "2026-10-15T02:00:00Z",
          last_basis: "unknown",
          quote_at: null,
          trade_at: null,
          received_at: "2026-10-15T02:00:01Z",
          source_mode: "futu",
          source_label: "Futu OpenD",
        },
      ],
    };
    const decoded = decodeQuoteResponse(futuResponse);

    expect(decoded?.status).toBe("available");
    if (decoded?.status !== "available") return;
    expect(decoded.evidence).toMatchObject({
      source: "futu",
      sourceMode: "futu",
      sourceLabel: "Futu OpenD",
      sourceEntitlement: "unknown",
      feed: "futu",
      asOf: null,
    });
    expect(decoded.snapshots[0]).toMatchObject({
      symbol: "SPY",
      last: 600,
      marketAsOf: "2026-10-15T02:00:00Z",
    });
    expect(decoded.wire).toEqual(futuResponse);
  });

  it("keeps Futu acceptance tied to its explicit Gateway identity and stock snapshot cap", () => {
    const snapshot = {
      symbol: "SPY",
      last: 600,
      feed: "futu",
      source_mode: "futu",
      source_label: "Futu OpenD",
    };
    const response = {
      feed: "futu",
      source_mode: "futu",
      source_label: "Futu OpenD",
      source_entitlement: "unknown",
      snapshots: [snapshot],
    };
    expect(
      decodeQuoteResponse({ ...response, snapshots: [{ ...snapshot, source_label: "Alpaca SIP" }] }),
    ).toBeNull();
    expect(
      decodeQuoteResponse({
        ...response,
        snapshots: Array.from({ length: 33 }, (_, i) => ({ ...snapshot, symbol: `S${i}` })),
      }),
    ).toBeNull();
  });

  it("does not translate a configured Futu payload into the Alpaca table shape", () => {
    const decoded = decodeQuoteResponse({
      source: "futu",
      feed: "configured",
      as_of: null,
      snapshots: [{ code: "US.SPY", last_price: 600 }],
      gateway_instance_id: "gateway-a",
    });
    expect(decoded?.status).toBe("unsupported-source");
    expect(decoded?.evidence.source).toBe("futu");
  });

  it("rejects malformed known-source snapshot envelopes", () => {
    expect(
      decodeQuoteResponse({ ...quoteResponse, snapshots: [{ symbol: "SPY", last: "600" }] }),
    ).toBeNull();
    expect(
      decodeQuoteResponse({
        ...quoteResponse,
        snapshots: [quoteResponse.snapshots[0], quoteResponse.snapshots[0]],
      }),
    ).toBeNull();
  });

  it("accepts only provider-returned option rows that match the requested OCC identity", () => {
    const decoded = decodeOptionChainResponse(optionResponse, "SPY", "2026-12-18");
    expect(decoded?.contracts[0]).toMatchObject({
      symbol: "SPY261218C00600000",
      strike: 600,
      iv: 0.2,
      delta: 0.5,
      feed: "opra",
      modelAsOf: null,
    });
    expect(
      decodeOptionChainResponse({ ...optionResponse, source: "futu" }, "SPY", "2026-12-18"),
    ).toBeNull();
    expect(decodeOptionChainResponse(optionResponse, "SPY", "2026-12-19")).toBeNull();
  });

  it("accepts disabled preview receipts only when they match the requested vertical", () => {
    const decoded = decodeVerticalPreviewReceipt(previewResponse, previewIntent);
    expect(decoded?.executionEnabled).toBe(false);
    expect(decoded?.preview.intent).toEqual(previewIntent);
    expect(
      decodeVerticalPreviewReceipt(
        {
          ...previewResponse,
          preview: { ...previewResponse.preview, intent: { ...previewIntent, quantity: 2 } },
        },
        previewIntent,
      ),
    ).toBeNull();
    expect(
      decodeVerticalPreviewReceipt(
        {
          ...previewResponse,
          execution_enabled: true,
        },
        previewIntent,
      ),
    ).toBeNull();
  });
});
