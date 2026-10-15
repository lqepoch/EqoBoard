import { describe, expect, it } from "vitest";
import { createDefaultChartConfig } from "../widgets/implementations/charts/config";
import type { DecodedCoreBarsPage } from "./core-bars";
import {
  buildCoreBarsReadInput,
  chartRefreshIntervalMs,
  coreBarsPageMatchesInput,
  coreBarsWindowKey,
  resolveChartResolution,
  usableContinuationCursor,
  withinCoreBarsWindow,
} from "./request";

const request = {
  symbol: "SPY",
  range: "MAX",
  resolution: "1d",
  asset_class: "etf",
  session_scope: "all",
  adjustment: "unadjusted",
  provider_mode: "auto",
  allow_daily_downgrade: true,
  request_start: "2020-01-01T00:00:00Z",
  request_end: "2026-10-15T00:00:00Z",
  cursor: null,
} as const;

function page(cursor: string | null = null): DecodedCoreBarsPage {
  return {
    envelope: { kind: "eqoboard.core-bars-page.v1", request: { ...request, cursor }, response: {} },
  } as unknown as DecodedCoreBarsPage;
}

describe("Core Bars chart request selection", () => {
  it("uses audited automatic range resolutions and bounded host refresh cadence", () => {
    const config = createDefaultChartConfig();
    expect(resolveChartResolution({ ...config, range: "1D", resolution: "auto" })).toBe("1m");
    expect(resolveChartResolution({ ...config, range: "5D", resolution: "auto" })).toBe("5m");
    expect(resolveChartResolution({ ...config, range: "1M", resolution: "auto" })).toBe("1h");
    expect(resolveChartResolution({ ...config, range: "MAX", resolution: "auto" })).toBe("1d");
    expect(resolveChartResolution({ ...config, range: "1D", resolution: "15m" })).toBe("15m");
    expect(chartRefreshIntervalMs("1D")).toBe(8_000);
    expect(chartRefreshIntervalMs("1Y")).toBe(60_000);
  });

  it("sends explicit market selection and accepts only the server-resolved first page", () => {
    const config = { ...createDefaultChartConfig(), range: "MAX", assetClass: "etf" as const };
    const input = buildCoreBarsReadInput("SPY", config);

    expect(input).toEqual({
      symbol: "SPY", range: "MAX", resolution: "1d", asset_class: "etf", session_scope: "all",
      adjustment: "unadjusted", provider_mode: "auto", allow_daily_downgrade: true,
    });
    expect(coreBarsPageMatchesInput(page(), input)).toBe(true);
    expect(coreBarsWindowKey(page().envelope.request)).toContain("2020-01-01T00:00:00Z");
  });

  it("requires the exact echoed cursor window on older pages and bounds opaque cursors", () => {
    const cursor = "cursor-next";
    const first = page();
    const input = {
      ...buildCoreBarsReadInput("SPY", { ...createDefaultChartConfig(), range: "MAX", assetClass: "etf" }),
      request_start: request.request_start,
      request_end: request.request_end,
      cursor,
    };
    const matching = { ...first, envelope: { ...first.envelope, request: { ...request, cursor } } };
    const wrongWindow = { ...matching, envelope: { ...matching.envelope, request: { ...matching.envelope.request, request_end: "2026-10-14T00:00:00Z" } } };

    expect(coreBarsPageMatchesInput(matching, input)).toBe(true);
    expect(coreBarsPageMatchesInput(wrongWindow, input)).toBe(false);
    expect(usableContinuationCursor(cursor)).toBe(true);
    expect(usableContinuationCursor("a".repeat(2_049))).toBe(false);
    expect(usableContinuationCursor("bad\ncursor")).toBe(false);
    expect(withinCoreBarsWindow(Date.parse("2022-01-01T00:00:00Z") / 1_000, request)).toBe(true);
    expect(withinCoreBarsWindow(Date.parse("2027-01-01T00:00:00Z") / 1_000, request)).toBe(false);
  });
});
