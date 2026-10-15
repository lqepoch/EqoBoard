import { describe, expect, it } from "vitest";

import { parseGatewayEventBatch } from "./market-stream";

describe("shared market stream frame parser", () => {
  it("keeps batches opaque and rejects malformed or oversized frames", () => {
    const event = { kind: "stock_quote", provider_extra: { retained: true } };
    expect(parseGatewayEventBatch(JSON.stringify([event]))).toEqual([event]);
    expect(parseGatewayEventBatch("not-json")).toBeNull();
    expect(parseGatewayEventBatch(JSON.stringify({ kind: "stock_quote" }))).toBeNull();
    expect(
      parseGatewayEventBatch(JSON.stringify(Array.from({ length: 257 }, () => event))),
    ).toBeNull();
    expect(parseGatewayEventBatch("x".repeat(1024 * 1024 + 1))).toBeNull();
  });
});
