import { describe, expect, it } from "vitest";
import { buildChartCsv, chartExportFilename, chartPngCaptionLines, MAX_CHART_EXPORT_ROWS } from "./export";
import type { ChartDisplayEvidence, ChartPlotBar } from "./types";

const evidence: ChartDisplayEvidence = {
  mode: "core-bars",
  source: "Core history",
  provider: "Alpaca",
  feed: "SIP",
  asOf: "2026-10-15T14:00:00Z",
  requestedWindow: "1Y requested; loaded cursor pages only",
  effectiveResolution: "1d",
  coverage: "100 loaded observations; 1 explicit gap",
  completeness: "partial",
  precision: "exact-decimal",
  evidence: [{ label: "adjustment", value: "split-adjusted" }],
};

function bar(time: number): ChartPlotBar<Readonly<{ source: string }>> {
  return {
    time: time as ChartPlotBar["time"], open: 10, high: 12, low: 9, close: 11, volume: 100,
    sourceRow: { source: "validated" },
    exact: { open: "10.000", high: "12.000", low: "9.000", close: "11.000", volume: "100.00" },
  };
}

describe("loaded chart exports", () => {
  it("exports only loaded rows and includes request, coverage, completeness, and precision evidence", () => {
    const result = buildChartCsv([bar(1_720_000_000)], evidence);

    expect(result.exportedRows).toBe(1);
    expect(result.loadedRows).toBe(1);
    expect(result.csv).toContain("explicitly loaded chart rows only; not full history");
    expect(result.csv).toContain("requested_window");
    expect(result.csv).toContain("partial");
    expect(result.csv).toContain("exact decimal tokens from validated source row");
    expect(result.csv).toContain("\"10.000\"");
  });

  it("bounds oversized exports to newest loaded rows and marks truncation", () => {
    const rows = Array.from({ length: MAX_CHART_EXPORT_ROWS + 1 }, (_, index) => bar(1_720_000_000 + index));
    const result = buildChartCsv(rows, evidence);

    expect(result.exportedRows).toBe(MAX_CHART_EXPORT_ROWS);
    expect(result.loadedRows).toBe(MAX_CHART_EXPORT_ROWS + 1);
    expect(result.truncated).toBe(true);
    expect(result.csv).toContain("true; newest rows retained");
    expect(result.csv).not.toContain(new Date(1_720_000_000 * 1000).toISOString());
  });

  it("guards metadata against spreadsheet formula evaluation and normalizes filenames", () => {
    const result = buildChartCsv([], { ...evidence, provider: "=IMPORTXML(\"https://invalid\")" });
    const filename = chartExportFilename("../spy:bad", "csv", new Date("2026-10-15T14:00:00.000Z"));

    expect(result.csv).toContain("'=IMPORTXML(\"\"https://invalid\"\")");
    expect(filename).toBe("SPY-BAD-loaded-chart-2026-10-15T14-00-00-000Z.csv");
  });

  it("labels PNG exports with loaded-only scope, source, as-of, coverage, and precision", () => {
    const captions = chartPngCaptionLines("SPY", evidence);

    expect(captions[0]).toContain("not full history");
    expect(captions[1]).toContain("Source Core history · Provider Alpaca · Feed SIP");
    expect(captions[1]).toContain("As of 2026-10-15T14:00:00Z");
    expect(captions[2]).toContain("Coverage 100 loaded observations; 1 explicit gap · partial · Precision exact-decimal");
  });
});
