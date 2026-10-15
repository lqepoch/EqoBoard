import { describe, expect, it } from "vitest";
import { isOrderPreviewResponse, parseVerticalPreviewIntent } from "./order-intent";

const intent = {
  broker: "alpaca",
  environment: "paper",
  kind: "vertical",
  symbol: null,
  quantity: 1,
  limit_price: 1.25,
  net_effect: "debit",
  legs: [
    { symbol: "SPY261016C00500000", side: "buy" },
    { symbol: "SPY261016C00505000", side: "sell" },
  ],
};

describe("vertical preview boundary", () => {
  it("accepts only a valid future standard vertical and preserves the exact intent", () => {
    const parsed = parseVerticalPreviewIntent(intent);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(intent);
  });

  it("rejects unknown fields, live environment, malformed legs, contradictory effects and sub-cent prices", () => {
    expect(parseVerticalPreviewIntent({ ...intent, account_id: "forbidden" }).ok).toBe(false);
    expect(parseVerticalPreviewIntent({ ...intent, environment: "live" }).ok).toBe(false);
    expect(parseVerticalPreviewIntent({ ...intent, legs: [{ symbol: "SPY261016C00500000", side: "buy" }] }).ok).toBe(false);
    expect(parseVerticalPreviewIntent({ ...intent, net_effect: "credit" }).ok).toBe(false);
    expect(parseVerticalPreviewIntent({ ...intent, limit_price: 1.255 }).ok).toBe(false);
  });

  it("requires the Gateway to keep execution disabled and return the same locked intent", () => {
    const parsed = parseVerticalPreviewIntent(intent);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const preview = {
      preview_id: "1d719f82-7f82-4f00-9bf1-2b0d04a7330e",
      expires_at: "2026-10-16T12:00:00Z",
      estimated_max_loss: 125,
      currency: "USD",
      intent,
    };
    expect(isOrderPreviewResponse({ execution_enabled: false, preview }, parsed.value)).toBe(true);
    expect(isOrderPreviewResponse({ execution_enabled: true, preview }, parsed.value)).toBe(false);
  });
});
