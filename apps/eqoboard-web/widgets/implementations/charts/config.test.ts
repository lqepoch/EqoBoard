import { describe, expect, it } from "vitest";
import { createDefaultChartConfig, parseNativeChartConfig } from "./config";

describe("native chart workspace config", () => {
  it("parses bounded chart controls into an immutable fresh value", () => {
    const parsed = parseNativeChartConfig({
      ...createDefaultChartConfig(),
      dataMode: "diagnostic-archive",
      diagnosticDatasetId: "fixture-bars_1m.v1",
      range: "MAX",
      indicators: ["RSI", "MACD"],
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.range).toBe("MAX");
      expect(parsed.value.dataMode).toBe("diagnostic-archive");
      expect(parsed.value.diagnosticDatasetId).toBe("fixture-bars_1m.v1");
      expect(parsed.value.indicators).toEqual(["RSI", "MACD"]);
      expect(Object.isFrozen(parsed.value.indicators)).toBe(true);
    }
    expect(createDefaultChartConfig()).not.toBe(createDefaultChartConfig());
  });

  it("rejects unknown fields, duplicate indicators, and non-JSON records", () => {
    expect(parseNativeChartConfig({ ...createDefaultChartConfig(), apiUrl: "https://provider.invalid" }).ok).toBe(false);
    expect(parseNativeChartConfig({ ...createDefaultChartConfig(), indicators: ["RSI", "RSI"] }).ok).toBe(false);
    expect(parseNativeChartConfig({ ...createDefaultChartConfig(), sessionScope: "all-hours-plus-future" }).ok).toBe(false);
    expect(parseNativeChartConfig({ ...createDefaultChartConfig(), allowDailyDowngrade: "yes" }).ok).toBe(false);
    expect(parseNativeChartConfig({ ...createDefaultChartConfig(), dataMode: "yahoo-daily" }).ok).toBe(false);
    expect(parseNativeChartConfig({ ...createDefaultChartConfig(), diagnosticDatasetId: "../other" }).ok).toBe(false);
    expect(parseNativeChartConfig(Object.assign(Object.create({ inherited: true }), createDefaultChartConfig())).ok).toBe(false);
  });
});
