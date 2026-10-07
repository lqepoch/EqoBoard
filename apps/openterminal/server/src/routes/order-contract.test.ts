import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderRequestError, postOrderJson } from "../../../web/lib/order-api.js";
import {
  isLockedPreview,
  orderIntentMatches,
  orderErrorFromResponse,
} from "../../../web/lib/order-contract.js";

const lockedPreview = {
  preview_id: "8b7991fd-cedc-4b41-8b4f-2b0eb4db48de",
  expires_at: "2026-10-07T08:00:00Z",
  estimated_max_loss: 10,
  currency: "USD",
  intent: {
    broker: "ibkr",
    environment: "paper",
    kind: "vertical",
    symbol: null,
    quantity: 1,
    limit_price: 0.1,
    net_effect: "debit",
    legs: [
      { symbol: "QQQ261009P00600000", side: "buy" },
      { symbol: "QQQ261009P00599000", side: "sell" },
    ],
  },
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("locked order preview contract", () => {
  it("accepts a finite, expiring server intent with two distinct opposite legs", () => {
    expect(isLockedPreview(lockedPreview)).toBe(true);
  });

  it("rejects malformed expiry, non-finite risk, and invalid contract symbols", () => {
    expect(isLockedPreview({ ...lockedPreview, expires_at: "not-a-date" })).toBe(false);
    expect(isLockedPreview({ ...lockedPreview, estimated_max_loss: Number.NaN })).toBe(false);
    expect(isLockedPreview({ ...lockedPreview, intent: { ...lockedPreview.intent, quantity: 0 } })).toBe(false);
    expect(isLockedPreview({ ...lockedPreview, intent: {
      ...lockedPreview.intent,
      legs: [{ symbol: "QQQ261009P00600000", side: "buy" }, { symbol: "not-occ", side: "sell" }],
    } })).toBe(false);
  });

  it("requires the server-locked executable intent to match the submitted intent", () => {
    expect(orderIntentMatches(lockedPreview.intent, lockedPreview.intent)).toBe(true);
    expect(orderIntentMatches({ ...lockedPreview.intent, limit_price: 0.2 }, lockedPreview.intent)).toBe(false);
    expect(orderIntentMatches({
      ...lockedPreview.intent,
      legs: [lockedPreview.intent.legs[1], lockedPreview.intent.legs[0]],
    }, lockedPreview.intent)).toBe(false);
  });
});

describe("typed order outcomes", () => {
  it("preserves UNKNOWN and client_order_id from a Fetch API mock response without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      state: "unknown",
      client_order_id: "stable-order-id",
      retryable: false,
      recovery_required: true,
      detail: "Adapter timed out after submission.",
    }), { status: 502, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postOrderJson("/api/eqo/orders/submit", { preview_id: lockedPreview.preview_id }, "submit"))
      .rejects.toMatchObject({
        contract: {
          state: "unknown",
          client_order_id: "stable-order-id",
          retryable: false,
          recovery_required: true,
        },
      } satisfies Partial<OrderRequestError>);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a transport failure unknown and associates it with the existing preview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("socket closed")));
    const priorPreviewId = lockedPreview.preview_id;

    try {
      await postOrderJson("/api/eqo/orders/submit", { preview_id: priorPreviewId }, "submit");
      throw new Error("expected submit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OrderRequestError);
      const orderError = error as OrderRequestError;
      expect(orderError.contract.state).toBe("unknown");
      expect(orderError.contract.retryable).toBe(false);
      expect(orderError.contract.client_order_id).toBeUndefined();
      expect(priorPreviewId).toBe(lockedPreview.preview_id);
    }
  });

  it("classifies gateway server failures as unknown and authorization failures as blocked", () => {
    expect(orderErrorFromResponse({ error: "timeout" }, 502)).toMatchObject({
      state: "unknown", retryable: false, recovery_required: true,
    });
    expect(orderErrorFromResponse({ error: "forbidden" }, 403)).toMatchObject({
      state: "blocked", retryable: false,
    });
    expect(orderErrorFromResponse({ error: "conflict" }, 409)).toMatchObject({
      state: "unknown", retryable: false, recovery_required: true,
    });
  });
});
