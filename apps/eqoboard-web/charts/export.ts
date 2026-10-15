import type { ChartDisplayEvidence, ChartPlotBar } from "./types";

export const MAX_CHART_EXPORT_ROWS = 10_000;
const MAX_EXPORT_EVIDENCE_LENGTH = 512;

export type ChartCsvExport = Readonly<{
  csv: string;
  exportedRows: number;
  loadedRows: number;
  truncated: boolean;
}>;

function csvField(value: string, guardFormula = false): string {
  const bounded = value.slice(0, MAX_EXPORT_EVIDENCE_LENGTH);
  const safe = guardFormula && /^[\s]*[=+@-]/u.test(bounded) ? `'${bounded}` : bounded;
  return `"${safe.replaceAll('"', '""')}"`;
}

function isoTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "invalid-time";
}

/** CSV represents the explicitly loaded display window; it never fetches or implies full history. */
export function buildChartCsv<TRow>(
  bars: readonly ChartPlotBar<TRow>[],
  evidence: ChartDisplayEvidence,
): ChartCsvExport {
  const selected = bars.slice(-MAX_CHART_EXPORT_ROWS);
  const truncated = selected.length < bars.length;
  const loadedStart = selected[0] ? isoTime(Number(selected[0].time)) : "unavailable";
  const loadedEnd = selected.at(-1) ? isoTime(Number(selected.at(-1)!.time)) : "unavailable";
  const lines: string[] = [];
  const header = ["record_type", "field", "value", "timestamp_utc", "open", "high", "low", "close", "volume", "precision"];
  lines.push(header.map((cell) => csvField(cell)).join(","));

  const metadata: ReadonlyArray<readonly [string, string]> = [
    ["export_scope", "explicitly loaded chart rows only; not full history"],
    ["source", evidence.source],
    ["provider", evidence.provider],
    ["feed", evidence.feed],
    ["as_of", evidence.asOf],
    ["requested_window", evidence.requestedWindow],
    ["effective_resolution", evidence.effectiveResolution],
    ["coverage", evidence.coverage],
    ["completeness", evidence.completeness],
    ["input_precision", evidence.precision],
    ["loaded_row_count", String(bars.length)],
    ["exported_row_count", String(selected.length)],
    ["loaded_start_utc", loadedStart],
    ["loaded_end_utc", loadedEnd],
    ["export_truncated", truncated ? "true; newest rows retained" : "false"],
    ...evidence.evidence.slice(0, 32).map(({ label, value }) => [`evidence:${label}`, value] as const),
  ];
  for (const [field, value] of metadata) {
    lines.push(["metadata", field, value, "", "", "", "", "", "", ""].map((cell, index) =>
      csvField(cell, index === 1 || index === 2)).join(","));
  }

  for (const bar of selected) {
    const exact = bar.exact;
    const values = exact
      ? [exact.open, exact.high, exact.low, exact.close, exact.volume]
      : [bar.open, bar.high, bar.low, bar.close, bar.volume].map(String);
    lines.push([
      "bar", "loaded_observation", "", isoTime(Number(bar.time)), ...values,
      exact ? "exact decimal tokens from validated source row" : "finite chart projection; source decimals unavailable",
    ].map((cell) => csvField(String(cell))).join(","));
  }
  return { csv: `${lines.join("\r\n")}\r\n`, exportedRows: selected.length, loadedRows: bars.length, truncated };
}

function safeFilenamePart(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  return normalized.slice(0, 24) || "CHART";
}

export function chartExportFilename(symbol: string, extension: "csv" | "png", now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  return `${safeFilenamePart(symbol)}-loaded-chart-${timestamp}.${extension}`;
}

function boundedCaption(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 220);
}

/** The PNG image carries the same source/window caveats as the accompanying CSV. */
export function chartPngCaptionLines(symbol: string, evidence: ChartDisplayEvidence): readonly string[] {
  return [
    `${boundedCaption(symbol)} · explicitly loaded chart rows only · not full history`,
    `Source ${boundedCaption(evidence.source)} · Provider ${boundedCaption(evidence.provider)} · Feed ${boundedCaption(evidence.feed)} · As of ${boundedCaption(evidence.asOf)}`,
    `Window ${boundedCaption(evidence.requestedWindow)} · Coverage ${boundedCaption(evidence.coverage)} · ${evidence.completeness} · Precision ${evidence.precision}`,
  ];
}

/** Composes a chart screenshot with explicit, bounded provenance and scope labels. */
export function composeChartPngCanvas(
  chartCanvas: HTMLCanvasElement,
  symbol: string,
  evidence: ChartDisplayEvidence,
): HTMLCanvasElement {
  const captions = chartPngCaptionLines(symbol, evidence);
  const captionHeight = 64;
  const output = document.createElement("canvas");
  output.width = chartCanvas.width;
  output.height = chartCanvas.height + captionHeight;
  const context = output.getContext("2d");
  if (!context) throw new Error("Chart image export is unavailable in this browser.");

  context.fillStyle = "#0b1019";
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(chartCanvas, 0, captionHeight);
  context.fillStyle = "#d9e2ef";
  context.font = "12px system-ui, sans-serif";
  captions.forEach((line, index) => context.fillText(line, 12, 17 + index * 17, Math.max(0, output.width - 24)));
  return output;
}

/** Initiates a download only after an explicit user click. */
export function downloadChartCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(filename, blob);
}

export function downloadChartPng(filename: string, canvas: HTMLCanvasElement): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Chart image export could not be created."));
        return;
      }
      downloadBlob(filename, blob);
      resolve();
    }, "image/png");
  });
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
