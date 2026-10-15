"use client";

import { useEffect, useMemo, useState } from "react";

import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import {
  parseResearchEnvelope,
  projectResearchTable,
  readResearchRequest,
  type ResearchReadOperation,
  type ResearchReadRequest,
  type ResearchDataOperationMap,
  type ResearchTableProjection,
} from "@/features/research/data";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { ResearchMarketData } from "@/lib/server/research/screener";
import { layoutMarketCapTreemap, type MarketCapTreemapCell } from "@/features/research/treemap";
import styles from "./research-widgets.module.css";

export type ResearchViewId =
  | "news"
  | "macro"
  | "economic-calendar"
  | "earnings-calendar"
  | "earnings-history"
  | "insider"
  | "screener"
  | "heatmap"
  | "crypto"
  | "crypto-global";

export type ResearchViewConfigV1 = Readonly<{
  schemaVersion: 1;
  symbol?: string;
  region?: "us" | "eu";
  symbols?: string;
  market?: "us" | "eu";
  sector?: string;
  marketCapMin?: string;
  changeMin?: string;
  changeMax?: string;
  volumeMin?: string;
  limit?: number;
}>;

export type ResearchViewDefinition = Readonly<{
  id: ResearchViewId;
  operation: ResearchReadOperation;
  title: string;
  emptyMessage: string;
  configFields: readonly (keyof ResearchViewConfigV1)[];
}>;

export const RESEARCH_VIEW_DEFINITIONS: readonly ResearchViewDefinition[] = Object.freeze([
  { id: "news", operation: "research.news", title: "News", emptyMessage: "No headlines were returned.", configFields: ["symbol"] },
  { id: "macro", operation: "research.macro", title: "Macro", emptyMessage: "No macro observations were returned.", configFields: ["region"] },
  { id: "economic-calendar", operation: "research.economicCalendar", title: "Economic calendar", emptyMessage: "No calendar events were returned.", configFields: [] },
  { id: "earnings-calendar", operation: "research.earningsCalendar", title: "Earnings calendar", emptyMessage: "Enter one or more symbols to request their calendar rows.", configFields: ["symbols"] },
  { id: "earnings-history", operation: "research.earningsHistory", title: "Earnings history", emptyMessage: "Choose a symbol to load source EPS surprises.", configFields: ["symbol"] },
  { id: "insider", operation: "research.insider", title: "Insider filings", emptyMessage: "Choose a symbol to load SEC Form 4 filings.", configFields: ["symbol"] },
  { id: "screener", operation: "research.screener", title: "Screener", emptyMessage: "No securities matched this bounded screen.", configFields: ["market", "sector", "marketCapMin", "changeMin", "changeMax", "volumeMin", "limit"] },
  { id: "heatmap", operation: "research.heatmap", title: "Heatmap", emptyMessage: "No securities are available for this heatmap.", configFields: ["market"] },
  { id: "crypto", operation: "research.crypto", title: "Crypto markets", emptyMessage: "No crypto market observations were returned.", configFields: [] },
  { id: "crypto-global", operation: "research.cryptoGlobal", title: "Crypto global", emptyMessage: "No global market-cap observations were returned.", configFields: [] },
]);

const VIEW_FIELD_KEYS: Readonly<Record<ResearchViewId, readonly string[]>> = Object.freeze({
  news: ["symbol"],
  macro: ["region"],
  "economic-calendar": [],
  "earnings-calendar": ["symbols"],
  "earnings-history": ["symbol"],
  insider: ["symbol"],
  screener: ["market", "sector", "marketCapMin", "changeMin", "changeMax", "volumeMin", "limit"],
  heatmap: ["market"],
  crypto: [],
  "crypto-global": [],
});

const SYMBOL = /^[A-Z][A-Z0-9.^-]{0,15}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const NUMBER_TEXT = /^-?(?:\d+\.?\d*|\.\d+)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every((key) => typeof key === "string" && Boolean(descriptors[key]?.enumerable && "value" in descriptors[key]!));
  } catch {
    return false;
  }
}

function configString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value === value.trim() && value.length <= max && !CONTROL.test(value) &&
    (allowEmpty || value.length > 0);
}

function parseSymbols(value: string): readonly string[] | null {
  if (value.trim() === "") return [];
  const symbols = value.split(",").map((symbol) => symbol.trim().toUpperCase());
  if (symbols.length > 30 || symbols.some((symbol) => !SYMBOL.test(symbol)) || new Set(symbols).size !== symbols.length) return null;
  return symbols;
}

export function createDefaultResearchViewConfig(view: ResearchViewId): ResearchViewConfigV1 {
  switch (view) {
    case "news": return { schemaVersion: 1, symbol: "" };
    case "macro": return { schemaVersion: 1, region: "us" };
    case "economic-calendar":
    case "crypto":
    case "crypto-global": return { schemaVersion: 1 };
    case "earnings-calendar": return { schemaVersion: 1, symbols: "" };
    case "earnings-history":
    case "insider": return { schemaVersion: 1, symbol: "" };
    case "screener": return { schemaVersion: 1, market: "us", sector: "", marketCapMin: "", changeMin: "", changeMax: "", volumeMin: "", limit: 100 };
    case "heatmap": return { schemaVersion: 1, market: "us" };
  }
}

export function parseResearchViewConfig(view: ResearchViewId, value: unknown):
  | Readonly<{ ok: true; value: ResearchViewConfigV1 }>
  | Readonly<{ ok: false; code: "config-invalid"; field?: string }> {
  if (!isRecord(value)) return { ok: false, code: "config-invalid" };
  const allowed = ["schemaVersion", ...VIEW_FIELD_KEYS[view]];
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !Object.hasOwn(value, key))) {
    return { ok: false, code: "config-invalid" };
  }
  if (value.schemaVersion !== 1) return { ok: false, code: "config-invalid", field: "schemaVersion" };
  const output: Record<string, unknown> = { schemaVersion: 1 };
  for (const key of VIEW_FIELD_KEYS[view]) {
    const raw = value[key];
    if (key === "symbol") {
      if (!configString(raw, 16, true) || (raw !== "" && !SYMBOL.test(raw))) return { ok: false, code: "config-invalid", field: key };
      output[key] = raw;
    } else if (key === "symbols") {
      if (!configString(raw, 512, true) || parseSymbols(raw) === null) return { ok: false, code: "config-invalid", field: key };
      output[key] = raw;
    } else if (key === "region" || key === "market") {
      if (raw !== "us" && raw !== "eu") return { ok: false, code: "config-invalid", field: key };
      output[key] = raw;
    } else if (key === "sector") {
      if (!configString(raw, 64, true)) return { ok: false, code: "config-invalid", field: key };
      output[key] = raw;
    } else if (["marketCapMin", "changeMin", "changeMax", "volumeMin"].includes(key)) {
      if (!configString(raw, 24, true) || (raw !== "" && (!NUMBER_TEXT.test(raw) || !Number.isFinite(Number(raw))))) {
        return { ok: false, code: "config-invalid", field: key };
      }
      const number = raw === "" ? null : Number(raw);
      const limits: Readonly<Record<string, readonly [number, number]>> = {
        marketCapMin: [0, 1e16], changeMin: [-100, 1000], changeMax: [-100, 1000], volumeMin: [0, 1e16],
      };
      const bounds = limits[key]!;
      if (number !== null && (number < bounds[0] || number > bounds[1])) return { ok: false, code: "config-invalid", field: key };
      output[key] = raw;
    } else if (key === "limit") {
      if (!Number.isInteger(raw) || Number(raw) < 1 || Number(raw) > 500) return { ok: false, code: "config-invalid", field: key };
      output[key] = raw;
    }
  }
  if (view === "screener" && typeof output.changeMin === "string" && output.changeMin !== "" &&
      typeof output.changeMax === "string" && output.changeMax !== "" && Number(output.changeMin) > Number(output.changeMax)) {
    return { ok: false, code: "config-invalid", field: "changeMin" };
  }
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 8 * 1024) return { ok: false, code: "config-invalid" };
  return { ok: true, value: Object.freeze(output) as ResearchViewConfigV1 };
}

function numeric(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export function buildResearchViewRequest(
  view: ResearchViewId,
  config: ResearchViewConfigV1,
  activeSymbol?: string,
): ResearchReadRequest | null {
  const symbolValue = config.symbol || activeSymbol || "";
  switch (view) {
    case "news":
      return { operation: "research.news", input: symbolValue ? { symbol: symbolValue } : {} };
    case "macro":
      return { operation: "research.macro", input: { region: config.region ?? "us" } };
    case "economic-calendar": return { operation: "research.economicCalendar", input: {} };
    case "earnings-calendar": {
      const symbols = parseSymbols(config.symbols || activeSymbol || "");
      return symbols && symbols.length > 0
        ? { operation: "research.earningsCalendar", input: { symbols } }
        : null;
    }
    case "earnings-history":
      return symbolValue ? { operation: "research.earningsHistory", input: { symbol: symbolValue } } : null;
    case "insider":
      return symbolValue ? { operation: "research.insider", input: { symbol: symbolValue } } : null;
    case "screener":
      return {
        operation: "research.screener",
        input: {
          market: config.market ?? "us",
          ...(config.sector ? { sector: config.sector } : {}),
          ...(numeric(config.marketCapMin) === undefined ? {} : { marketCapMin: numeric(config.marketCapMin) }),
          ...(numeric(config.changeMin) === undefined ? {} : { changeMin: numeric(config.changeMin) }),
          ...(numeric(config.changeMax) === undefined ? {} : { changeMax: numeric(config.changeMax) }),
          ...(numeric(config.volumeMin) === undefined ? {} : { volumeMin: numeric(config.volumeMin) }),
          sort: "marketCap",
          direction: "desc",
          limit: config.limit ?? 100,
        },
      };
    case "heatmap": return { operation: "research.heatmap", input: { market: config.market ?? "us" } };
    case "crypto": return { operation: "research.crypto", input: {} };
    case "crypto-global": return { operation: "research.cryptoGlobal", input: {} };
  }
}

type ResearchViewProps = WidgetProps<ResearchViewConfigV1, ResearchDataOperationMap, WidgetNoActionMap> &
  Readonly<{ definition: ResearchViewDefinition }>;

type ReadState =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{
      status: "ready";
      envelope: NonNullable<ReturnType<typeof parseResearchEnvelope>>;
      table: ResearchTableProjection;
      heatmapData: ResearchMarketData | null;
    }>;

function useReadResearch(
  host: ResearchViewProps["host"],
  request: ResearchReadRequest | null,
  refreshVersion: number,
): ReadState {
  const requestKey = request ? `${request.operation}:${JSON.stringify(request.input)}` : "none";
  const [state, setState] = useState<ReadState>({ status: "idle" });
  useEffect(() => {
    if (!request) {
      setState({ status: "idle" });
      return;
    }
    const lifecycle = host.lifecycle.getSnapshot();
    if (lifecycle.phase !== "active" || lifecycle.signal.aborted) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifecycle.signal.addEventListener("abort", abort, { once: true });
    setState({ status: "loading" });
    void readResearchRequest(host.data, request, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      const envelope = parseResearchEnvelope(request.operation, response);
      if (!envelope) {
        setState({ status: "error", message: "The research response did not match its validated source envelope." });
        return;
      }
      const table = projectResearchTable(request.operation, envelope as NonNullable<ReturnType<typeof parseResearchEnvelope>>);
      const heatmap = request.operation === "research.heatmap"
        ? parseResearchEnvelope("research.heatmap", response)?.data ?? null
        : null;
      setState({ status: "ready", envelope, table, heatmapData: heatmap });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error", message: "Research data is unavailable for this request." });
    });
    return () => {
      lifecycle.signal.removeEventListener("abort", abort);
      controller.abort();
    };
  }, [host.data, host.lifecycle, request, requestKey, refreshVersion]);
  return state;
}

function updateConfig(
  config: ResearchViewConfigV1,
  onConfigChange: ResearchViewProps["onConfigChange"],
  key: keyof ResearchViewConfigV1,
  value: string | number,
): void {
  onConfigChange({ ...config, [key]: value } as ResearchViewConfigV1);
}

function ResearchControls({ definition, config, onConfigChange }: Pick<ResearchViewProps, "definition" | "config" | "onConfigChange">) {
  const fields = definition.configFields;
  if (fields.length === 0) return null;
  return (
    <div className={styles.controls} aria-label={`${definition.title} filters`}>
      {fields.map((field) => {
        if (field === "region" || field === "market") {
          const value = config[field] ?? "us";
          return (
            <label className={styles.control} key={field}>
              <span>{field === "region" ? "Region" : "Market"}</span>
              <select value={value} onChange={(event) => updateConfig(config, onConfigChange, field, event.currentTarget.value)}>
                <option value="us">United States</option>
                <option value="eu">Europe</option>
              </select>
            </label>
          );
        }
        if (field === "limit") {
          return (
            <label className={styles.control} key={field}>
              <span>Rows</span>
              <select value={config.limit ?? 100} onChange={(event) => updateConfig(config, onConfigChange, field, Number(event.currentTarget.value))}>
                {[50, 100, 250, 500].map((limit) => <option value={limit} key={limit}>{limit}</option>)}
              </select>
            </label>
          );
        }
        const labels: Partial<Record<keyof ResearchViewConfigV1, string>> = {
          symbol: "Symbol (blank uses active symbol)",
          symbols: "Symbols (comma separated)",
          sector: "Sector",
          marketCapMin: "Minimum market cap",
          changeMin: "Minimum change %",
          changeMax: "Maximum change %",
          volumeMin: "Minimum volume",
        };
        const type = field === "marketCapMin" || field === "changeMin" || field === "changeMax" || field === "volumeMin" ? "number" : "text";
        const value = config[field] ?? "";
        return (
          <label className={styles.control} key={field}>
            <span>{labels[field] ?? field}</span>
            <input
              type={type}
              min={type === "number" && field !== "changeMin" && field !== "changeMax" ? "0" : undefined}
              max={field === "changeMin" || field === "changeMax" ? "1000" : undefined}
              value={value}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                updateConfig(config, onConfigChange, field, field === "symbol" || field === "symbols" ? raw.toUpperCase() : raw);
              }}
              aria-label={labels[field] ?? field}
            />
          </label>
        );
      })}
    </div>
  );
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const row = isRecord(value);
  if (row && typeof value.value === "string") {
    return [value.value, typeof value.source === "string" ? value.source : null, typeof value.asOf === "string" ? value.asOf : null].filter(Boolean).join(" · ");
  }
  try { return JSON.stringify(value).slice(0, 180); } catch { return "—"; }
}

function Evidence({ envelope }: { envelope: NonNullable<ReturnType<typeof parseResearchEnvelope>> }) {
  const { source, status, asOf, retrievedAt, completeness, cache, warning } = envelope;
  return (
    <div className={styles.evidence} aria-label="Research source evidence">
      <span>{source.provider}</span>
      <span>{status === "available" ? "Complete response" : "Partial response"}</span>
      <span>Provider as of: {asOf ?? "unknown"}</span>
      <span>Retrieved: {retrievedAt}</span>
      <span>Failed items: {completeness.failedItems ?? "unknown"}{completeness.truncated ? " · truncated" : ""}</span>
      <span>Process cache: {cache}</span>
      {warning ? <p>{warning}</p> : null}
    </div>
  );
}

function Table({ table, emptyMessage }: { table: ResearchTableProjection; emptyMessage: string }) {
  if (table.rows.length === 0) return <p className={styles.empty}>{emptyMessage}</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr>{table.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={typeof row.symbol === "string" ? `${row.symbol}-${rowIndex}` : rowIndex}>
              {table.columns.map((column) => {
                const value = row[column.key];
                if (column.key === "link" && typeof value === "string") {
                  return <td key={column.key}><a href={value} target="_blank" rel="noopener noreferrer">Open source</a></td>;
                }
                if (column.key === "filingUrl" && typeof value === "string") {
                  return <td key={column.key}><a href={value} target="_blank" rel="noopener noreferrer">SEC filing</a></td>;
                }
                return <td key={column.key}>{display(value)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function workspaceTicker(symbol: string): string | null {
  const ticker = symbol.split(":").at(-1)?.toUpperCase() ?? "";
  return /^[A-Z][A-Z0-9.^-]{0,15}$/u.test(ticker) ? ticker : null;
}

function compactMarketCap(cell: MarketCapTreemapCell): string {
  const currency = cell.market === "eu" ? "EUR" : cell.currency;
  try {
    return currency
      ? new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(cell.marketCap)
      : `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(cell.marketCap)} (source currency unknown)`;
  } catch {
    return `${display(cell.marketCap)} ${currency ?? "unknown currency"}`;
  }
}

function Heatmap({ data, onSelect }: { data: ResearchMarketData; onSelect: (symbol: string) => void }) {
  const layout = useMemo(() => layoutMarketCapTreemap(data), [data]);
  return (
    <div className={styles.heatmap} aria-label="Market-cap-weighted research heatmap" data-testid="research-heatmap">
      <p className={styles.notice}>Tile area is proportional to the returned positive market-cap value ({data.market === "eu" ? "EUR-converted cap" : "provider cap"}). Color uses the returned change; unknown change stays neutral. This view is metadata and research evidence, not a synchronized quote surface.</p>
      <div className={styles.heatmapCanvas}>
        {layout.cells.length === 0 ? <p className={styles.empty}>No positive source-reported market caps are available to size tiles.</p> : null}
        {layout.cells.map((cell) => {
          const change = typeof cell.changePercent === "number" && Number.isFinite(cell.changePercent) ? cell.changePercent : null;
          const tone = change === null ? "neutral" : change > 0 ? "positive" : change < 0 ? "negative" : "neutral";
          const ticker = workspaceTicker(cell.symbol);
          const capText = compactMarketCap(cell);
          const label = `${cell.symbol}, ${cell.name}, market cap ${capText} from ${cell.marketCapSource} as of ${cell.marketCapAsOf ?? "unknown"}, change ${change === null ? "unavailable" : `${change}%`} from ${cell.priceSource} as of ${cell.priceAsOf ?? "unknown"}`;
          return (
            <button
              className={`${styles.tile} ${styles[`tile_${tone}`]}`}
              key={cell.symbol}
              type="button"
              data-testid="research-heatmap-tile"
              data-symbol={cell.symbol}
              style={{ left: `${cell.x}%`, top: `${cell.y}%`, width: `${cell.width}%`, height: `${cell.height}%` }}
              aria-label={label}
              title={label}
              disabled={!ticker}
              onClick={() => { if (ticker) onSelect(ticker); }}
            >
              <strong>{cell.symbol}</strong>
              <span>{cell.name}</span>
              <span>{change === null ? "Change unavailable" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}</span>
              <span>{capText}</span>
              <small>Cap: {cell.marketCapSource} · {cell.marketCapAsOf ?? "as of unknown"}</small>
              <small>Change: {cell.priceSource} · {cell.priceAsOf ?? "as of unknown"}</small>
            </button>
          );
        })}
      </div>
      <p className={styles.heatmapFootnote}>Excluded from tile area: {layout.excludedRows} listings without a positive known market cap. Select a tile to focus the workspace symbol.</p>
    </div>
  );
}

export function ResearchViewWidget(props: ResearchViewProps) {
  const { definition, config, inputs, host, onConfigChange } = props;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const request = useMemo(() => buildResearchViewRequest(definition.id, config, inputs.symbol), [definition.id, config, inputs.symbol]);
  const hasReadPermission = host.auth.authenticated && host.auth.permissions.includes("research:read");
  const state = useReadResearch(host, hasReadPermission ? request : null, refreshVersion);
  const selectSymbol = (symbol: string) => host.events.dispatch({ type: "active-symbol.select.v1", symbol });

  return (
    <section className={styles.widget} aria-label={definition.title}>
      <header className={styles.header}>
        <div><h2>{definition.title}</h2><p>Read-only provider observations; values remain non-canonical research data.</p></div>
        <button type="button" onClick={() => setRefreshVersion((value) => value + 1)} disabled={!hasReadPermission || !request || state.status === "loading"}>
          Refresh
        </button>
      </header>
      <ResearchControls definition={definition} config={config} onConfigChange={onConfigChange} />
      {!hasReadPermission ? <p className={styles.empty}>Sign in with the research:read permission to load this view.</p> : null}
      {hasReadPermission && !request ? <p className={styles.empty}>{definition.emptyMessage}</p> : null}
      {hasReadPermission && state.status === "loading" ? <p className={styles.empty} role="status">Loading authorized research observations…</p> : null}
      {hasReadPermission && state.status === "error" ? <p className={styles.error} role="alert">{state.message}</p> : null}
      {hasReadPermission && state.status === "ready" ? (
        <>
          <Evidence envelope={state.envelope} />
          {definition.id === "heatmap" && state.heatmapData
            ? <Heatmap data={state.heatmapData} onSelect={selectSymbol} />
            : <Table table={state.table} emptyMessage={definition.emptyMessage} />}
        </>
      ) : null}
    </section>
  );
}
