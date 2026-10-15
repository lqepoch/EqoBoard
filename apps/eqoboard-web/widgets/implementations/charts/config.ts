import {
  CHART_INDICATORS,
  CHART_RANGES,
  CHART_RESOLUTIONS,
  CHART_STYLES,
  PROVIDER_PREFERENCES,
  type CallerAssetClass,
  type ChartRange,
  type ChartResolutionChoice,
  type ChartStyle,
  type IndicatorId,
  type ProviderPreference,
} from "../../../charts/types";

export const CHART_CONFIG_SCHEMA_ID = "eqoboard.chart.config.v1" as const;

export const CHART_SESSION_SCOPES = ["all", "regular", "extended", "overnight"] as const;
export type ChartSessionScope = (typeof CHART_SESSION_SCOPES)[number];

export const CHART_ADJUSTMENTS = ["unadjusted", "split", "dividend", "all"] as const;
export type ChartAdjustment = (typeof CHART_ADJUSTMENTS)[number];
export const CHART_DATA_MODES = ["core-bars", "diagnostic-archive"] as const;
export type ChartDataMode = (typeof CHART_DATA_MODES)[number];

const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isDiagnosticDatasetId(value: unknown): value is string {
  return typeof value === "string" && DATASET_ID.test(value);
}

export type NativeChartConfigV1 = Readonly<{
  schemaVersion: 1;
  dataMode: ChartDataMode;
  diagnosticDatasetId: string | null;
  range: ChartRange;
  resolution: ChartResolutionChoice;
  style: ChartStyle;
  showVolume: boolean;
  indicators: readonly IndicatorId[];
  providerPreference: ProviderPreference;
  assetClass: CallerAssetClass;
  sessionScope: ChartSessionScope;
  adjustment: ChartAdjustment;
  allowDailyDowngrade: boolean;
}>;

const FIELDS = new Set([
  "schemaVersion", "dataMode", "diagnosticDatasetId", "range", "resolution", "style", "showVolume", "indicators",
  "providerPreference", "assetClass", "sessionScope", "adjustment", "allowDailyDowngrade",
]);

export function createDefaultChartConfig(): NativeChartConfigV1 {
  return {
    schemaVersion: 1,
    dataMode: "core-bars",
    diagnosticDatasetId: null,
    range: "1Y",
    resolution: "auto",
    style: "candles",
    showVolume: true,
    indicators: ["SMA20", "EMA20"],
    providerPreference: "auto",
    assetClass: "stock",
    sessionScope: "all",
    adjustment: "unadjusted",
    allowDailyDowngrade: true,
  };
}

/** Closed, JSON-safe parser for workspace-owned chart preferences only. */
export function parseNativeChartConfig(value: unknown):
  | Readonly<{ ok: true; value: NativeChartConfigV1 }>
  | Readonly<{ ok: false; code: "config-invalid"; field?: string }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "config-invalid" };
  let record: Record<string, unknown>;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false, code: "config-invalid" };
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !FIELDS.has(key))) return { ok: false, code: "config-invalid" };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor || !descriptor.enumerable || !("value" in descriptor);
    })) return { ok: false, code: "config-invalid" };
    record = value as Record<string, unknown>;
  } catch {
    return { ok: false, code: "config-invalid" };
  }

  const fail = (field: string) => ({ ok: false as const, code: "config-invalid" as const, field });
  if (record.schemaVersion !== 1) return fail("schemaVersion");
  if (typeof record.dataMode !== "string" || !CHART_DATA_MODES.includes(record.dataMode as ChartDataMode)) return fail("dataMode");
  if (record.diagnosticDatasetId !== null && !isDiagnosticDatasetId(record.diagnosticDatasetId)) return fail("diagnosticDatasetId");
  if (typeof record.range !== "string" || !CHART_RANGES.includes(record.range as ChartRange)) return fail("range");
  if (record.resolution !== "auto" &&
      (typeof record.resolution !== "string" || !CHART_RESOLUTIONS.includes(record.resolution as never))) return fail("resolution");
  if (typeof record.style !== "string" || !CHART_STYLES.includes(record.style as ChartStyle)) return fail("style");
  if (typeof record.showVolume !== "boolean") return fail("showVolume");
  if (!Array.isArray(record.indicators) || record.indicators.length > CHART_INDICATORS.length) return fail("indicators");
  const indicators: IndicatorId[] = [];
  for (const indicator of record.indicators) {
    if (typeof indicator !== "string" || !CHART_INDICATORS.includes(indicator as IndicatorId) || indicators.includes(indicator as IndicatorId)) {
      return fail("indicators");
    }
    indicators.push(indicator as IndicatorId);
  }
  if (typeof record.providerPreference !== "string" || !PROVIDER_PREFERENCES.includes(record.providerPreference as ProviderPreference)) {
    return fail("providerPreference");
  }
  if (record.assetClass !== "stock" && record.assetClass !== "etf") return fail("assetClass");
  if (typeof record.sessionScope !== "string" || !CHART_SESSION_SCOPES.includes(record.sessionScope as ChartSessionScope)) return fail("sessionScope");
  if (typeof record.adjustment !== "string" || !CHART_ADJUSTMENTS.includes(record.adjustment as ChartAdjustment)) return fail("adjustment");
  if (typeof record.allowDailyDowngrade !== "boolean") return fail("allowDailyDowngrade");
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 8 * 1024) return fail("$");
  } catch {
    return fail("$");
  }

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      dataMode: record.dataMode as ChartDataMode,
      diagnosticDatasetId: record.diagnosticDatasetId as string | null,
      range: record.range as ChartRange,
      resolution: record.resolution as ChartResolutionChoice,
      style: record.style as ChartStyle,
      showVolume: record.showVolume,
      indicators: Object.freeze(indicators),
      providerPreference: record.providerPreference as ProviderPreference,
      assetClass: record.assetClass,
      sessionScope: record.sessionScope as ChartSessionScope,
      adjustment: record.adjustment as ChartAdjustment,
      allowDailyDowngrade: record.allowDailyDowngrade,
    }),
  };
}
