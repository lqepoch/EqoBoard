import { finiteNumber, parseCsv, readProviderText } from "./transport";
import type { ProviderResult } from "./types";

export type MacroObservation = Readonly<{
  id: string;
  label: string;
  value: number | null;
  unit: "percent" | "index";
  provider: "FRED" | "ECB";
  asOf: string | null;
}>;

export type MacroData = Readonly<{
  region: "us" | "eu";
  observations: readonly MacroObservation[];
  /** Proxy symbols are included for the BFF's authorized SIP snapshot join. */
  indexProxies: readonly Readonly<{ symbol: string; label: string }>[];
  indexObservations: readonly Readonly<{
    symbol: string;
    label: string;
    price: number | null;
    changePercent: number | null;
    source: string;
    sourceMode: string | null;
    asOf: string | null;
  }>[];
}>;

type Point = Readonly<{ date: string; value: number }>;
type SeriesSpec = Readonly<{ id: string; label: string; unit: "percent" | "index" }>;

const US_SERIES: readonly SeriesSpec[] = [
  { id: "DGS3MO", label: "US Treasury 3M", unit: "percent" },
  { id: "DGS5", label: "US Treasury 5Y", unit: "percent" },
  { id: "DGS10", label: "US Treasury 10Y", unit: "percent" },
  { id: "DGS30", label: "US Treasury 30Y", unit: "percent" },
  { id: "VIXCLS", label: "CBOE VIX close", unit: "index" },
];

const EU_SERIES: readonly Readonly<{
  flow: string;
  seriesId: string;
  id: string;
  label: string;
  unit: "percent" | "index";
}>[] = [
  {
    flow: "YC",
    seriesId: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M",
    id: "YC-3M",
    label: "Euro area AAA yield 3M",
    unit: "percent",
  },
  {
    flow: "YC",
    seriesId: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_5Y",
    id: "YC-5Y",
    label: "Euro area AAA yield 5Y",
    unit: "percent",
  },
  {
    flow: "YC",
    seriesId: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y",
    id: "YC-10Y",
    label: "Euro area AAA yield 10Y",
    unit: "percent",
  },
  {
    flow: "YC",
    seriesId: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_30Y",
    id: "YC-30Y",
    label: "Euro area AAA yield 30Y",
    unit: "percent",
  },
  {
    flow: "FM",
    seriesId: "D.U2.EUR.4F.KR.DFR.LEV",
    id: "deposit-rate",
    label: "ECB deposit facility rate",
    unit: "percent",
  },
  {
    flow: "ICP",
    seriesId: "M.U2.N.000000.4.ANR",
    id: "hicp-yoy",
    label: "Euro area HICP y/y",
    unit: "percent",
  },
];

const US_INDEX_PROXIES = Object.freeze([
  { symbol: "SPY", label: "S&P 500 (SPY)" },
  { symbol: "DIA", label: "Dow Jones (DIA)" },
  { symbol: "QQQ", label: "Nasdaq 100 (QQQ)" },
  { symbol: "IWM", label: "Russell 2000 (IWM)" },
  { symbol: "GLD", label: "Gold (GLD)" },
  { symbol: "USO", label: "WTI Crude (USO)" },
  { symbol: "TLT", label: "20Y+ Treasury (TLT)" },
  { symbol: "UUP", label: "Dollar Index (UUP)" },
]);
const EU_INDEX_PROXIES = Object.freeze([
  { symbol: "FEZ", label: "Euro Stoxx 50 (FEZ)" },
  { symbol: "IEUR", label: "MSCI Europe (IEUR)" },
  { symbol: "EWG", label: "Germany (EWG)" },
  { symbol: "EWU", label: "UK (EWU)" },
  { symbol: "EWQ", label: "France (EWQ)" },
  { symbol: "EWI", label: "Italy (EWI)" },
]);

const FRED_SOURCE = Object.freeze({
  provider: "FRED",
  providerUrl: "https://fred.stlouisfed.org/",
  sourcePath: "apps/openterminal/server/src/providers/fred.ts",
  license: null,
});
const ECB_SOURCE = Object.freeze({
  provider: "European Central Bank SDW",
  providerUrl: "https://data-api.ecb.europa.eu/",
  sourcePath: "apps/openterminal/server/src/providers/ecb.ts",
  license: null,
});

export async function readFredHistory(seriesId: string, limit = 24): Promise<readonly Point[]> {
  const url = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv");
  url.search = new URLSearchParams({ id: seriesId }).toString();
  const csv = parseCsv(await readProviderText(url, { timeoutMs: 7_000, maxBytes: 256 * 1024 }));
  const header = csv.at(0);
  if (csv.length < 2 || !header) return [];
  const observationDateIndex = header.indexOf("observation_date");
  const seriesValueIndex = header.indexOf(seriesId);
  const dateIndex = observationDateIndex >= 0 ? observationDateIndex : 0;
  const valueIndex = seriesValueIndex >= 0 ? seriesValueIndex : 1;
  const points: Point[] = [];
  for (let index = 1; index < csv.length; index += 1) {
    const row = csv[index];
    if (!row) continue;
    const date = row[dateIndex];
    const value = finiteNumber(row[valueIndex]);
    if (date && value !== null && /^\d{4}-\d{2}-\d{2}$/u.test(date)) points.push({ date, value });
  }
  return points.slice(-Math.min(Math.max(1, limit), 260));
}

async function fredLatest(seriesId: string): Promise<Point | null> {
  const points = await readFredHistory(seriesId, 5);
  return points.at(-1) ?? null;
}

export async function readEcbLatest(flow: string, seriesId: string): Promise<Point | null> {
  const url = new URL(`https://data-api.ecb.europa.eu/service/data/${flow}/${seriesId}`);
  url.search = new URLSearchParams({ format: "csvdata", lastNObservations: "5" }).toString();
  const csv = parseCsv(await readProviderText(url, { timeoutMs: 8_000, maxBytes: 256 * 1024 }));
  const header = csv.at(0);
  if (csv.length < 2 || !header) return null;
  const dateIndex = header.indexOf("TIME_PERIOD");
  const valueIndex = header.indexOf("OBS_VALUE");
  if (dateIndex < 0 || valueIndex < 0) return null;
  for (let index = csv.length - 1; index > 0; index -= 1) {
    const row = csv[index];
    if (!row) continue;
    const date = row[dateIndex];
    const value = finiteNumber(row[valueIndex]);
    if (date && value !== null && /^\d{4}(-\d{2}(-\d{2})?)?$/u.test(date)) return { date, value };
  }
  return null;
}

export async function loadMacro(region: "us" | "eu"): Promise<ProviderResult<MacroData>> {
  const source = region === "us" ? FRED_SOURCE : ECB_SOURCE;
  const proxies = region === "us" ? US_INDEX_PROXIES : EU_INDEX_PROXIES;
  const specs = region === "us" ? US_SERIES : EU_SERIES;
  const settled = await Promise.allSettled(
    specs.map((spec) => {
      if (region === "us") return fredLatest(spec.id);
      const ecbSeries = EU_SERIES.find((entry) => entry.id === spec.id);
      return ecbSeries
        ? readEcbLatest(ecbSeries.flow, ecbSeries.seriesId)
        : Promise.resolve(null);
    }),
  );
  let failedItems = 0;
  const observations = specs.map((spec, index): MacroObservation => {
    const result = settled[index];
    if (!result || result.status === "rejected") {
      failedItems += 1;
      return {
        id: spec.id,
        label: spec.label,
        value: null,
        unit: spec.unit,
        provider: region === "us" ? "FRED" : "ECB",
        asOf: null,
      };
    }
    const point = result.value;
    return {
      id: spec.id,
      label: spec.label,
      value: point?.value ?? null,
      unit: spec.unit,
      provider: region === "us" ? "FRED" : "ECB",
      asOf: point?.date ?? null,
    };
  });
  return {
    source,
    data: { region, observations, indexProxies: proxies, indexObservations: [] },
    asOf: null,
    complete: failedItems === 0 && observations.every((item) => item.value !== null),
    failedItems,
    truncated: false,
    warning:
      region === "eu"
        ? "ECB values and Gateway proxy observations have separate timestamps and are not synchronized."
        : "FRED observations and Gateway proxy observations have separate timestamps and are not synchronized.",
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Join source-verified Gateway SIP snapshots without defining a market wire DTO. */
export function attachMacroSnapshots(data: MacroData, snapshots: readonly unknown[]): MacroData {
  const bySymbol = new Map<string, Record<string, unknown>>();
  for (const raw of snapshots) {
    const row = record(raw);
    const symbol = row?.symbol;
    if (row && typeof symbol === "string" && row.feed === "sip")
      bySymbol.set(symbol.toUpperCase(), row);
  }
  const indexObservations = data.indexProxies.map((proxy) => {
    const row = bySymbol.get(proxy.symbol);
    const rawTime = row?.last_as_of;
    const time = typeof rawTime === "string" ? new Date(rawTime) : null;
    return Object.freeze({
      symbol: proxy.symbol,
      label: proxy.label,
      price: finiteNumber(row?.last),
      changePercent: finiteNumber(row?.change_percent),
      source:
        typeof row?.source_label === "string" && row.source_label.trim() !== ""
          ? row.source_label.trim().slice(0, 96)
          : "source unknown (Gateway SIP endpoint)",
      sourceMode:
        typeof row?.source_mode === "string" && row.source_mode.trim() !== ""
          ? row.source_mode.trim().slice(0, 48)
          : null,
      asOf: time && Number.isFinite(time.getTime()) ? time.toISOString() : null,
    });
  });
  return Object.freeze({ ...data, indexObservations });
}
