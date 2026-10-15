import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartWidget, type NativeChartWidgetProps } from "./ChartWidget";
import { createDefaultChartConfig } from "./config";

function renderChart(symbol = "SPY", config = createDefaultChartConfig()): string {
  const host = {
    auth: { authenticated: true, permissions: ["market:read"] },
    lifecycle: {
      getSnapshot: () => ({ phase: "active", generation: 1, signal: new AbortController().signal }),
      subscribe: vi.fn(() => () => undefined),
      onDispose: vi.fn(() => () => undefined),
    },
    events: { subscribe: vi.fn(() => () => undefined), dispatch: vi.fn() },
    data: { read: vi.fn() },
    actions: { invoke: vi.fn() },
    refresh: { observe: vi.fn(() => () => undefined) },
    market: { getSnapshot: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    reportError: vi.fn(),
  } as unknown as NativeChartWidgetProps["host"];
  const props: NativeChartWidgetProps = {
    instance: {
      instanceId: "chart-instance-1",
      manifestId: "eqoboard.chart",
      manifestVersion: "1.0.0",
      configSchemaId: "eqoboard.chart.config.v1",
      config,
    },
    config,
    inputs: symbol ? { symbol } : {},
    host,
    onConfigChange: vi.fn(),
  };
  return renderToStaticMarkup(<ChartWidget {...props} />);
}

describe("native chart widget surface", () => {
  it("renders bounded controls, explicit history-only status, and required Lightweight Charts attribution", () => {
    const markup = renderChart();

    expect(markup).toContain('data-testid="native-chart-range-MAX"');
    expect(markup).toContain('data-testid="native-chart-resolution"');
    expect(markup).toContain('data-testid="native-chart-indicator-RSI"');
    expect(markup).toContain('data-testid="native-chart-export-loaded-csv"');
    expect(markup).toContain('data-testid="native-chart-export-loaded-png"');
    expect(markup).toContain('data-chart-live="false"');
    expect(markup).toContain("no live bar corrections");
    expect(markup).toContain("finite-number display projection");
    expect(markup).toContain('data-testid="native-chart-tradingview-attribution"');
    expect(markup).toContain("https://www.tradingview.com/lightweight-charts/");
  });

  it("keeps a missing bound symbol in a visible idle state", () => {
    const markup = renderChart("");

    expect(markup).toContain("Select an active or fixed symbol");
    expect(markup).toContain("Source evidence unavailable.");
  });

  it("renders the diagnostic archive selector and hides Core request controls in that mode", () => {
    const config = {
      ...createDefaultChartConfig(),
      dataMode: "diagnostic-archive" as const,
      diagnosticDatasetId: "fixture-bars_1m.v1",
    };
    const markup = renderChart("SPY", config);

    expect(markup).toContain('data-testid="native-chart-mode-diagnostic"');
    expect(markup).toContain('data-testid="native-chart-diagnostic-form"');
    expect(markup).toContain('data-testid="native-chart-diagnostic-dataset"');
    expect(markup).toContain('data-testid="native-chart-diagnostic-load"');
    expect(markup).toContain(
      "MDP diagnostic archive · NOT LIVE · noncanonical · promotion unavailable",
    );
    expect(markup).not.toContain('data-testid="native-chart-range-1D"');
    expect(markup).not.toContain('data-testid="native-chart-resolution"');
  });
});
