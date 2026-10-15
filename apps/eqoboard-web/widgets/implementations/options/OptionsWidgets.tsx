"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import type { ColDef, GridApi, GridReadyEvent } from "ag-grid-community";

import { ResourceState } from "@/components/shell/ResourceState";
import type { NativeDataOperationMap } from "@/features/data/operations";
import { parseOccContractSymbol } from "@/features/market/market-contracts";
import type { OptionContractRow } from "@/features/market/market-contracts";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import type { WidgetOperationMap } from "@/widgets/sdk/data";
import { useOptionsResource } from "../market/hooks";
import type { OptionsWidgetHost } from "../market/hooks";
import type { OptionExpiryConfigV1 } from "../market/config";
import styles from "../market/market-widgets.module.css";

ModuleRegistry.registerModules([AllCommunityModule]);

export type OptionsWidgetProps = WidgetProps<
  OptionExpiryConfigV1,
  Pick<NativeDataOperationMap, "market.quotes" | "market.options.chain">,
  WidgetNoActionMap,
  MarketHostSnapshot
>;

type OptionGridRow = Readonly<OptionContractRow & {
  liveBid: number | null;
  liveAsk: number | null;
  liveBidSize: number | null;
  liveAskSize: number | null;
  liveSource: string;
  liveEntitlement: string;
  liveAt: string | null;
  snapshotEvidence: string;
}>;

const DEFAULT_COL_DEF: ColDef<OptionGridRow> = Object.freeze({ sortable: true, resizable: true, minWidth: 88 });

const CHAIN_COLUMNS: readonly ColDef<OptionGridRow>[] = Object.freeze([
  { field: "symbol", headerName: "OCC contract", pinned: "left", minWidth: 185 },
  { field: "right", headerName: "Right" },
  { field: "strike", headerName: "Strike", valueFormatter: ({ value }) => formatNumber(value, 3) },
  { field: "bid", headerName: "Chain bid", valueFormatter: ({ value }) => formatNumber(value) },
  { field: "ask", headerName: "Chain ask", valueFormatter: ({ value }) => formatNumber(value) },
  { field: "last", headerName: "Chain last", valueFormatter: ({ value }) => formatNumber(value) },
  { field: "liveBid", headerName: "Stream bid", valueFormatter: ({ value }) => formatNumber(value) },
  { field: "liveAsk", headerName: "Stream ask", valueFormatter: ({ value }) => formatNumber(value) },
  { field: "liveBidSize", headerName: "Stream bid size", valueFormatter: ({ value }) => formatNumber(value, 0) },
  { field: "liveAskSize", headerName: "Stream ask size", valueFormatter: ({ value }) => formatNumber(value, 0) },
  { field: "iv", headerName: "IV", valueFormatter: ({ value }) => value === null ? "—" : formatNumber(Number(value) * 100, 2) + "%" },
  { field: "delta", headerName: "Delta", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "gamma", headerName: "Gamma", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "theta", headerName: "Theta", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "vega", headerName: "Vega", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "quoteAt", headerName: "Chain quote time", minWidth: 190 },
  { field: "modelAsOf", headerName: "Greeks model as of", minWidth: 190, valueGetter: ({ data }) => data?.modelAsOf ?? "unknown" },
  { field: "liveAt", headerName: "Stream quote time", minWidth: 190 },
  { field: "liveSource", headerName: "Stream source", minWidth: 160 },
  { field: "liveEntitlement", headerName: "Stream entitlement", minWidth: 150 },
]);

const IV_COLUMNS: readonly ColDef<OptionContractRow>[] = Object.freeze([
  { field: "symbol", headerName: "OCC contract", pinned: "left", minWidth: 185 },
  { field: "right", headerName: "Right" },
  { field: "strike", headerName: "Strike", valueFormatter: ({ value }) => formatNumber(value, 3) },
  { field: "iv", headerName: "IV", valueFormatter: ({ value }) => value === null ? "—" : formatNumber(Number(value) * 100, 2) + "%" },
  { field: "delta", headerName: "Delta", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "gamma", headerName: "Gamma", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "theta", headerName: "Theta", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "vega", headerName: "Vega", valueFormatter: ({ value }) => formatNumber(value, 4) },
  { field: "quoteAt", headerName: "Quote time", minWidth: 190 },
  { field: "tradeAt", headerName: "Trade time", minWidth: 190 },
  { field: "modelAsOf", headerName: "Greeks model as of", minWidth: 190, valueGetter: ({ data }) => data?.modelAsOf ?? "unknown" },
  { field: "feed", headerName: "Reported feed" },
]);

const IV_DEFAULT_COL_DEF: ColDef<OptionContractRow> = Object.freeze({ sortable: true, resizable: true, minWidth: 88 });

function formatNumber(value: unknown, maximumFractionDigits = 4): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value)
    : "—";
}

function formatReadState(status: string): "loading" | "ready" | "error" | "unsupported" | "unavailable" {
  if (status === "loading" || status === "ready" || status === "error" || status === "unsupported") return status;
  return "unavailable";
}

function leaseState(coverage: MarketHostSnapshot["leases"]["options"]["coverage"]): string {
  switch (coverage) {
    case "pending": return "loading";
    case "complete": return "ready";
    case "partial": return "partial";
    case "error": return "error";
    case "unknown": return "unknown";
  }
}

function rowFromContract(contract: OptionContractRow, evidence: string): OptionGridRow {
  return Object.freeze({
    ...contract,
    liveBid: null,
    liveAsk: null,
    liveBidSize: null,
    liveAskSize: null,
    liveSource: "unknown",
    liveEntitlement: "unknown",
    liveAt: null,
    snapshotEvidence: evidence,
  });
}

function nullableNumber(record: Readonly<Record<string, unknown>>, key: string): number | null | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return value === null || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}

function applyOptionEvents(
  api: GridApi<OptionGridRow> | null,
  rows: Map<string, OptionGridRow>,
  snapshot: MarketHostSnapshot,
  selectedSymbols: readonly string[],
  sequences: Map<string, number>,
  gatewayInstance: { current: string | null },
): void {
  if (gatewayInstance.current !== snapshot.gatewayInstanceId) {
    sequences.clear();
    gatewayInstance.current = snapshot.gatewayInstanceId;
  }
  if (!api || selectedSymbols.length === 0) return;
  const selected = new Set(selectedSymbols);
  const updates: OptionGridRow[] = [];
  for (const [symbol, event] of Object.entries(snapshot.optionQuotes)) {
    if (!selected.has(symbol) || event.kind !== "option_quote" || typeof event.local_sequence !== "number" ||
        event.local_sequence <= (sequences.get(symbol) ?? 0)) continue;
    const bid = nullableNumber(event, "bid");
    const ask = nullableNumber(event, "ask");
    const bidSize = nullableNumber(event, "bid_size");
    const askSize = nullableNumber(event, "ask_size");
    if (bid === undefined || ask === undefined || bidSize === undefined || askSize === undefined) continue;
    const previous = rows.get(symbol);
    if (!previous) continue;
    const source = typeof event.source_label === "string" && event.source_label.length <= 128 ? event.source_label : "source unknown";
    const entitlement = typeof event.source_entitlement === "string" && event.source_entitlement.length <= 64
      ? event.source_entitlement
      : "unknown";
    const next = Object.freeze({
      ...previous,
      liveBid: bid,
      liveAsk: ask,
      liveBidSize: bidSize,
      liveAskSize: askSize,
      liveSource: source,
      liveEntitlement: entitlement,
      liveAt: typeof event.event_time === "string" ? event.event_time : typeof event.received_at === "string" ? event.received_at : null,
    });
    sequences.set(symbol, event.local_sequence);
    rows.set(symbol, next);
    updates.push(next);
  }
  if (updates.length) api.applyTransactionAsync({ update: updates });
}

function ExpiryInput({ config, onConfigChange }: Pick<OptionsWidgetProps, "config" | "onConfigChange">) {
  return (
    <label className={styles.controlLabel}>
      Expiration
      <input
        aria-label="Option expiration"
        type="date"
        value={config.expiry}
        onChange={(event) => onConfigChange({ ...config, expiry: event.target.value })}
      />
    </label>
  );
}

export function OptionsChainWidget({ host, instance, inputs, config, onConfigChange }: OptionsWidgetProps) {
  const symbol = inputs.symbol ?? "";
  const resource = useOptionsResource(host, instance.instanceId, symbol, config.expiry);
  const apiRef = useRef<GridApi<OptionGridRow> | null>(null);
  const rowsRef = useRef(new Map<string, OptionGridRow>());
  const eventSequences = useRef(new Map<string, number>());
  const eventGatewayInstance = useRef<string | null>(null);
  const [rows, setRows] = useState<OptionGridRow[]>([]);
  const selectedSymbolsKey = JSON.stringify(resource.selectedLeaseSymbols);
  const selectedSymbols = useMemo(() => [...resource.selectedLeaseSymbols], [selectedSymbolsKey]);
  const columns = useMemo(() => CHAIN_COLUMNS, []);
  const state = formatReadState(resource.state.status);
  const chain = resource.state.status === "ready" ? resource.state.value : null;
  const evidence = chain ? `source ${chain.source} · reported feed ${chain.feed} · as_of ${chain.asOf ?? "unknown"}` : "source unknown";

  useEffect(() => {
    if (!chain) {
      if (resource.state.status === "error" || resource.state.status === "unsupported" || resource.state.status === "idle") {
        rowsRef.current = new Map();
        setRows([]);
        apiRef.current?.setGridOption("rowData", []);
      }
      return;
    }
    const next = chain.contracts.map((contract) => rowFromContract(contract, evidence));
    rowsRef.current = new Map(next.map((row) => [row.symbol, row]));
    eventSequences.current.clear();
    eventGatewayInstance.current = null;
    setRows(next);
    apiRef.current?.setGridOption("rowData", next);
    applyOptionEvents(apiRef.current, rowsRef.current, host.market.getSnapshot(), selectedSymbols, eventSequences.current, eventGatewayInstance);
  }, [chain, evidence, host.market, resource.state.status, selectedSymbolsKey]);

  const onGridReady = useCallback((event: GridReadyEvent<OptionGridRow>) => {
    apiRef.current = event.api;
    event.api.setGridOption("rowData", [...rowsRef.current.values()]);
    applyOptionEvents(event.api, rowsRef.current, host.market.getSnapshot(), selectedSymbols, eventSequences.current, eventGatewayInstance);
  }, [host.market, selectedSymbolsKey]);

  useEffect(() => host.market.subscribe(() => applyOptionEvents(
    apiRef.current,
    rowsRef.current,
    host.market.getSnapshot(),
    selectedSymbols,
    eventSequences.current,
    eventGatewayInstance,
  )), [host.market, selectedSymbolsKey]);

  const feedState = resource.feedFreshness;
  const lease = resource.lease;
  const currentStreamMessage = resource.state.status === "error" || resource.state.status === "unsupported"
    ? resource.state.detail
    : chain
      ? `${chain.contracts.length} contracts · ${chain.truncated ? "truncated" : "not marked truncated"} · Greeks model_as_of is retained per row.`
      : resource.state.status === "loading" ? "Loading the requested expiration through the bounded same-origin read." : "Choose a symbol and expiration.";

  return (
    <section className={styles.marketWidget} data-testid="market-options-chain-widget" aria-label="Options chain">
      <h2>Options chain</h2>
      <ExpiryInput config={config} onConfigChange={onConfigChange} />
      <ResourceState state={state} title="Option chain" detail={currentStreamMessage} metadata={evidence} />
      <ResourceState state={feedState} title="Gateway options stream freshness" detail={`transport ${resource.transportState}; event ordering is tracked by the shared Gateway sequence watermark.`} />
      <ResourceState
        state={leaseState(lease.coverage) as "loading" | "ready" | "partial" | "error" | "unknown"}
        title="Option stream lease coverage"
        detail={`selected ${lease.selectedCount}; acknowledged ${lease.leasedCount}; omitted ${lease.omittedCount}; generation ${lease.generation}; Gateway acknowledges counts only, exact active symbols are unverified.`}
        metadata={resource.underlyingPrice === null
          ? `No verified SIP underlying price is available; no option contracts are leased. ${resource.underlyingEvidence}`
          : `nearest contracts selected around verified SIP snapshot ${formatNumber(resource.underlyingPrice)} · ${resource.underlyingEvidence}`}
      />
      <div className={styles.marketGrid} role="region" aria-label="Options chain community grid">
        <AgGridReact<OptionGridRow>
          columnDefs={columns}
          defaultColDef={DEFAULT_COL_DEF}
          getRowId={({ data }) => data.symbol}
          onGridReady={onGridReady}
          rowData={rows}
          theme={themeQuartz}
        />
      </div>
      <p className={styles.marketFootnote}>Chain snapshot bid/ask and live Gateway bid/ask stay separate. Reported feed metadata is not proof of entitlement; missing model_as_of remains unknown. No combo price or depth is synthesized.</p>
    </section>
  );
}

export function IvSkewWidget({ host, instance, inputs, config, onConfigChange }: OptionsWidgetProps) {
  const symbol = inputs.symbol ?? "";
  const resource = useOptionsResource(host, instance.instanceId, symbol, config.expiry);
  const chain = resource.state.status === "ready" ? resource.state.value : null;
  const rows = useMemo(() => chain
    ? [...chain.contracts].sort((left, right) => left.strike - right.strike || left.right.localeCompare(right.right))
    : [], [chain]);
  const withIv = rows.filter((row) => row.iv !== null);
  const columns = useMemo(() => IV_COLUMNS, []);
  const state = chain
    ? withIv.length === 0 ? "unsupported" : withIv.length < rows.length ? "partial" : "ready"
    : formatReadState(resource.state.status);
  const detail = chain
    ? withIv.length === 0 ? "No implied-volatility observations were returned; IV skew is unavailable."
      : `${withIv.length} of ${rows.length} contracts have an IV value; quote/trade timestamps and model_as_of remain separate.`
    : resource.state.status === "error" || resource.state.status === "unsupported" ? resource.state.detail
      : resource.state.status === "loading" ? "Loading the requested option expiration." : "Choose a symbol and expiration.";

  return (
    <section className={styles.marketWidget} data-testid="market-iv-skew-widget" aria-label="Implied volatility and Greeks">
      <h2>IV and Greeks</h2>
      <ExpiryInput config={config} onConfigChange={onConfigChange} />
      <ResourceState state={state as "unsupported" | "partial" | "ready" | "error" | "loading" | "unavailable"} title="IV observations" detail={detail} metadata={chain ? `source ${chain.source} · reported feed ${chain.feed} · as_of ${chain.asOf ?? "unknown"}` : "source unknown"} />
      {chain ? <p className={styles.marketFootnote}>Values are the provider's per-contract snapshot. IV is shown only when returned; no interpolation, skew fit, or Greeks model time is inferred.</p> : null}
      <div className={styles.marketGrid} role="region" aria-label="IV and Greeks community grid">
        <AgGridReact<OptionContractRow>
          columnDefs={columns}
          defaultColDef={IV_DEFAULT_COL_DEF}
          getRowId={({ data }) => data.symbol}
          rowData={withIv}
          theme={themeQuartz}
        />
      </div>
    </section>
  );
}

type OptionTapeWidgetProps = WidgetProps<EmptyMarketConfigV1, WidgetOperationMap, WidgetNoActionMap, MarketHostSnapshot>;

function textValue(record: Readonly<Record<string, unknown>>, key: string, max = 160): string {
  const value = record[key];
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "unknown";
}

type OptionTapeRow = Readonly<{
  id: string;
  sequence: number;
  symbol: string;
  price: number | null;
  size: number | null;
  eventAt: string;
  source: string;
  entitlement: string;
}>;

const TAPE_COLUMNS: readonly ColDef<OptionTapeRow>[] = Object.freeze([
  { field: "sequence", hide: true, sort: "desc" },
  { field: "symbol", headerName: "OCC contract", pinned: "left", minWidth: 185 },
  { field: "price", headerName: "Price", valueFormatter: ({ value }) => formatNumber(value) },
  { field: "size", headerName: "Size", valueFormatter: ({ value }) => formatNumber(value, 0) },
  { field: "eventAt", headerName: "Event time", minWidth: 190 },
  { field: "source", headerName: "Source", minWidth: 150 },
  { field: "entitlement", headerName: "Entitlement", minWidth: 140 },
]);
const TAPE_DEFAULT_COL_DEF: ColDef<OptionTapeRow> = Object.freeze({ sortable: true, resizable: true, minWidth: 100 });

function tapeRow(event: Readonly<Record<string, unknown>>): OptionTapeRow | null {
  if (typeof event.gateway_instance_id !== "string" || typeof event.local_sequence !== "number" ||
      typeof event.symbol !== "string" || event.kind !== "option_trade") return null;
  if (!parseOccContractSymbol(event.symbol)) return null;
  return Object.freeze({
    id: event.gateway_instance_id + ":" + event.local_sequence,
    sequence: event.local_sequence,
    symbol: event.symbol,
    price: typeof event.price === "number" && Number.isFinite(event.price) ? event.price : null,
    size: typeof event.size === "number" && Number.isFinite(event.size) ? event.size : null,
    eventAt: textValue(event, "event_time") === "unknown" ? textValue(event, "received_at") : textValue(event, "event_time"),
    source: textValue(event, "source_label", 128),
    entitlement: textValue(event, "source_entitlement", 64),
  });
}

function rowsFromSnapshot(snapshot: MarketHostSnapshot, underlying: string): readonly OptionTapeRow[] {
  return Object.freeze(snapshot.optionTrades
    .filter((event) => event.kind === "option_trade" && typeof event.symbol === "string" &&
      parseOccContractSymbol(event.symbol)?.underlyingRoot === underlying)
    .slice(-50)
    .map(tapeRow)
    .filter((row): row is OptionTapeRow => row !== null)
    .sort((left, right) => right.sequence - left.sequence));
}

function updateTapeGrid(
  api: GridApi<OptionTapeRow> | null,
  rows: Map<string, OptionTapeRow>,
  lastSequence: { current: number },
  gatewayInstance: { current: string | null },
  connectionEpoch: { current: number | null },
  activeUnderlying: { current: string },
  snapshot: MarketHostSnapshot,
  underlying: string,
): void {
  const instanceChanged = gatewayInstance.current !== snapshot.gatewayInstanceId;
  const epochChanged = connectionEpoch.current !== snapshot.feeds.options.connectionEpoch;
  const symbolChanged = activeUnderlying.current !== underlying;
  if (instanceChanged || epochChanged || symbolChanged) {
    gatewayInstance.current = snapshot.gatewayInstanceId;
    connectionEpoch.current = snapshot.feeds.options.connectionEpoch;
    activeUnderlying.current = underlying;
    const current = rowsFromSnapshot(snapshot, underlying);
    rows.clear();
    for (const row of current) rows.set(row.id, row);
    lastSequence.current = snapshot.optionTrades.reduce(
      (maximum, event) => typeof event.local_sequence === "number" ? Math.max(maximum, event.local_sequence) : maximum,
      0,
    );
    api?.setGridOption("rowData", [...current]);
    return;
  }

  const unseen = snapshot.optionTrades
    .filter((event) => typeof event.local_sequence === "number" && event.local_sequence > lastSequence.current)
    .sort((left, right) => (left.local_sequence as number) - (right.local_sequence as number));
  if (unseen.length === 0) return;
  lastSequence.current = unseen.reduce(
    (maximum, event) => Math.max(maximum, event.local_sequence as number),
    lastSequence.current,
  );
  const added = unseen
    .filter((event) => event.kind === "option_trade" && typeof event.symbol === "string" &&
      parseOccContractSymbol(event.symbol)?.underlyingRoot === underlying)
    .map(tapeRow)
    .filter((row): row is OptionTapeRow => row !== null);
  if (added.length === 0) return;
  const removed: OptionTapeRow[] = [];
  for (const row of added) rows.set(row.id, row);
  const ordered = [...rows.values()].sort((left, right) => left.sequence - right.sequence);
  while (ordered.length > 50) {
    const evicted = ordered.shift();
    if (evicted) {
      rows.delete(evicted.id);
      removed.push(evicted);
    }
  }
  api?.applyTransactionAsync({ add: added, remove: removed });
}

export function OptionTapeWidget({ host, inputs }: OptionTapeWidgetProps) {
  const symbol = inputs.symbol ?? "";
  const apiRef = useRef<GridApi<OptionTapeRow> | null>(null);
  const rowsRef = useRef(new Map<string, OptionTapeRow>());
  const lastSequenceRef = useRef(0);
  const gatewayInstanceRef = useRef<string | null>(null);
  const connectionEpochRef = useRef<number | null>(null);
  const activeUnderlyingRef = useRef("");
  const [feed, setFeed] = useState(() => {
    const snapshot = host.market.getSnapshot();
    return {
      freshness: snapshot.feeds.options.freshness,
      transportState: snapshot.transportState,
      connectionEpoch: snapshot.feeds.options.connectionEpoch,
    };
  });
  const columns = useMemo(() => TAPE_COLUMNS, []);
  const onGridReady = useCallback((event: GridReadyEvent<OptionTapeRow>) => {
    apiRef.current = event.api;
    event.api.setGridOption("rowData", [...rowsRef.current.values()].sort((left, right) => right.sequence - left.sequence));
    updateTapeGrid(event.api, rowsRef.current, lastSequenceRef, gatewayInstanceRef, connectionEpochRef, activeUnderlyingRef, host.market.getSnapshot(), symbol);
  }, [host.market, symbol]);

  useEffect(() => {
    let unsubscribeMarket: (() => void) | null = null;
    const update = () => updateTapeGrid(
      apiRef.current,
      rowsRef.current,
      lastSequenceRef,
      gatewayInstanceRef,
      connectionEpochRef,
      activeUnderlyingRef,
      host.market.getSnapshot(),
      symbol,
    );
    const syncLifecycle = () => {
      if (host.lifecycle.getSnapshot().phase === "active") {
        if (!unsubscribeMarket) unsubscribeMarket = host.market.subscribe(update);
        update();
      } else {
        unsubscribeMarket?.();
        unsubscribeMarket = null;
      }
    };
    syncLifecycle();
    const unsubscribeLifecycle = host.lifecycle.subscribe(syncLifecycle);
    return () => {
      unsubscribeLifecycle();
      unsubscribeMarket?.();
      unsubscribeMarket = null;
    };
  }, [host.lifecycle, host.market, symbol]);

  useEffect(() => host.market.subscribe(() => {
    const snapshot = host.market.getSnapshot();
    const next = {
      freshness: snapshot.feeds.options.freshness,
      transportState: snapshot.transportState,
      connectionEpoch: snapshot.feeds.options.connectionEpoch,
    };
    setFeed((current) => current.freshness === next.freshness && current.transportState === next.transportState &&
      current.connectionEpoch === next.connectionEpoch ? current : next);
  }), [host.market]);
  return (
    <section className={styles.marketWidget} data-testid="market-option-tape-widget" aria-label="Option tape">
      <h2>Option tape</h2>
      <ResourceState state={feed.freshness} title="Gateway options event freshness" detail={"transport " + feed.transportState + "; epoch " + (feed.connectionEpoch ?? "unknown")} />
      <p className={styles.marketFootnote}>Recent option trade prints for {symbol || "the active symbol"}. Aggressor side is unavailable and is not inferred.</p>
      <div className={styles.marketGrid} role="region" aria-label="Option tape community grid">
        <AgGridReact<OptionTapeRow>
          columnDefs={columns}
          defaultColDef={TAPE_DEFAULT_COL_DEF}
          getRowId={({ data }) => data.id}
          onGridReady={onGridReady}
          rowData={[...rowsRef.current.values()].sort((left, right) => right.sequence - left.sequence)}
          theme={themeQuartz}
        />
      </div>
      <p className={styles.marketFootnote}>No trade aggressor side is provided by this source; the tape does not classify prints as buys or sells.</p>
    </section>
  );
}
