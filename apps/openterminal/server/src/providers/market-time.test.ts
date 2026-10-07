import { describe, expect, it } from "vitest";
import { compareRfc3339Nanos, isWithinFutureSkew, latestRfc3339Nanos } from "./market-time.js";

describe("RFC3339 market timestamps", () => {
  it("compares fractional seconds at nanosecond precision", () => {
    expect(compareRfc3339Nanos("2026-10-07T14:30:00.123456788Z", "2026-10-07T14:30:00.123456789Z")).toBe(-1);
    expect(compareRfc3339Nanos("2026-10-07T14:30:00.123456789Z", "2026-10-07T14:30:00.123456789Z")).toBe(0);
  });

  it("normalizes offsets before comparing instants", () => {
    expect(compareRfc3339Nanos("2026-10-07T10:30:00.123456789-04:00", "2026-10-07T14:30:00.123456789Z")).toBe(0);
    expect(compareRfc3339Nanos("2026-10-07T14:30:00.000000001Z", "2026-10-07T16:30:00+02:00")).toBe(1);
  });

  it("keeps the original text of the latest valid timestamp and ignores invalid values", () => {
    const latest = "2026-10-07T14:30:00.000000002Z";
    expect(latestRfc3339Nanos([
      "bad", "2026-10-07T16:30:00+02:00", latest,
      "2026-13-07T14:30:00Z", null,
    ])).toBe(latest);
  });

  it("rejects malformed dates and offsets instead of guessing", () => {
    expect(compareRfc3339Nanos("2026-02-30T00:00:00Z", "2026-02-28T00:00:00Z")).toBeNull();
    expect(compareRfc3339Nanos("2026-10-07T14:30:00+01:99", "2026-10-07T14:30:00Z")).toBeNull();
    expect(latestRfc3339Nanos(["2026-10-07T14:30:00"])).toBeNull();
  });

  it("bounds source timestamps against a publication time at exact nanosecond precision", () => {
    const received = "2026-10-07T14:30:00.123456789Z";
    expect(isWithinFutureSkew("2026-10-07T14:30:01.123456789Z", received, 1_000)).toBe(true);
    expect(isWithinFutureSkew("2026-10-07T14:30:01.123456790Z", received, 1_000)).toBe(false);
    expect(isWithinFutureSkew("2026-10-07T10:30:01.123456789-04:00", received, 1_000)).toBe(true);
    expect(isWithinFutureSkew("invalid", received, 1_000)).toBeNull();
  });
});
