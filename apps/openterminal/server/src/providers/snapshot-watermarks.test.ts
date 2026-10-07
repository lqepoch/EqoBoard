import { describe, expect, it } from "vitest";
import { splitSnapshotWatermarks } from "./snapshot-watermarks.js";

describe("snapshot watermark projection", () => {
  it("keeps quote and trade barriers separate and preserves unknown source times", () => {
    const projected = splitSnapshotWatermarks("stocks", {
      connection_epoch: 3,
      request_start_sequence: 7,
      local_sequence: 10,
    }, [
      { symbol: "QQQ", quote_at: "2026-10-07T14:30:00.000000001Z", trade_at: "2026-10-07T14:30:00.000000002Z" },
      { symbol: "SPY", quote_at: null, trade_at: "2026-10-07T14:30:00.000000003Z" },
    ]);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      event_types: ["quote"], request_start_sequence: 7, local_sequence: 10,
      as_of_by_symbol: { QQQ: "2026-10-07T14:30:00.000000001Z", SPY: null },
    });
    expect(projected[1]).toMatchObject({
      event_types: ["trade"],
      as_of_by_symbol: {
        QQQ: "2026-10-07T14:30:00.000000002Z",
        SPY: "2026-10-07T14:30:00.000000003Z",
      },
    });
  });

  it("does not fabricate barriers from a Gateway response without a watermark", () => {
    expect(splitSnapshotWatermarks("options", null, [
      { symbol: "QQQ261009P00600000", quote_at: null, trade_at: null },
    ])).toEqual([]);
  });
});
