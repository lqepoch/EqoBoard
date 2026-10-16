import { describe, expect, it } from "vitest";
import { tapeRow } from "./OptionsWidgets";

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
