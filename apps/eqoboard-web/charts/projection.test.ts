import { describe, expect, it } from "vitest";
import { projectChartRows, type ChartProjectionCandidate } from "./projection";

function candidate(timeSeconds: number, close = "10.25"): ChartProjectionCandidate<Readonly<{ id: string }>> {
  const sourceRow = Object.freeze({ id: `row-${timeSeconds}-${close}` });
  return {
    sourceRow,
    timeSeconds,
    open: close,
    high: "12.50",
    low: "9.00",
    close,
    volume: "2500.125",
    exact: { open: close, high: "12.50", low: "9.00", close, volume: "2500.125" },
  };
}

describe("chart coordinate projection", () => {
  it("sorts valid rows and retains exact decimal tokens beside finite coordinates", () => {
    const result = projectChartRows([candidate(1_720_000_020), candidate(1_720_000_000)]);

    expect(result.rejectedRows).toBe(0);
    expect(result.bars.map((bar) => Number(bar.time))).toEqual([1_720_000_000, 1_720_000_020]);
    expect(result.bars[0]?.close).toBe(10.25);
    expect(result.bars[0]?.exact?.volume).toBe("2500.125");
    expect(result.bars[0]?.sourceRow.id).toBe("row-1720000000-10.25");
  });

  it("drops unsafe rows and uses the last source occurrence for a duplicate candle identity", () => {
    const invalidOhlcRow = candidate(1_720_000_010);
    const invalidVolumeRow = candidate(1_720_000_030);
    const invalidOhlc = {
      ...invalidOhlcRow,
      high: "8.00",
      exact: { ...invalidOhlcRow.exact!, high: "8.00" },
    };
    const invalidVolume = {
      ...invalidVolumeRow,
      volume: "-1",
      exact: { ...invalidVolumeRow.exact!, volume: "-1" },
    };
    const result = projectChartRows([candidate(1_720_000_000, "10.00"), invalidOhlc, invalidVolume, candidate(1_720_000_000, "11.00")]);

    expect(result.rejectedRows).toBe(2);
    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]?.close).toBe(11);
  });

  it("rejects exponent notation, non-finite numbers, and unsafe timestamps", () => {
    const result = projectChartRows([
      { ...candidate(1_720_000_000), close: "1e3", exact: undefined },
      { ...candidate(1_720_000_001), volume: Number.POSITIVE_INFINITY, exact: undefined },
      candidate(Number.MAX_SAFE_INTEGER + 1),
    ]);

    expect(result.bars).toHaveLength(0);
    expect(result.rejectedRows).toBe(3);
  });
});
