import { describe, expect, it } from "vitest";
import { formatChartAxisTimeEt, formatChartCrosshairTimeEtAndUtc } from "./time";

describe("chart timestamp presentation", () => {
  it("renders UTC intraday coordinates in Eastern time across daylight-saving seasons", () => {
    expect(formatChartAxisTimeEt(Date.parse("2026-01-15T14:30:00Z") / 1_000, true)).toBe("Jan 15, 2026, 09:30 ET");
    expect(formatChartAxisTimeEt(Date.parse("2026-07-15T13:30:00Z") / 1_000, true)).toBe("Jul 15, 2026, 09:30 ET");
  });

  it("keeps the UTC coordinate visible beside ET crosshair time", () => {
    const value = Date.parse("2026-07-15T13:30:00Z") / 1_000;

    expect(formatChartCrosshairTimeEtAndUtc(value)).toBe("Jul 15, 2026, 09:30 ET · 2026-07-15T13:30:00.000Z UTC");
  });
});
