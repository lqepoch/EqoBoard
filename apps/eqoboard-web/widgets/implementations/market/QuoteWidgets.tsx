"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import type { ColDef, GridApi, GridReadyEvent } from "ag-grid-community";

import { ResourceState } from "@/components/shell/ResourceState";
import { useMarketLease, useMarketSnapshot } from "@/features/data/MarketDataHost";
import { hasControlCharacters } from "@/features/data/validation";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import type { WidgetOperationMap } from "@/widgets/sdk/data";
import type { NativeDataOperationMap } from "@/features/data/operations";
import type { StockSnapshotRow } from "@/features/market/market-contracts";
import { useQuoteSnapshots } from "./hooks";
import type { QuoteWidgetHost } from "./hooks";
import type { EmptyMarketConfigV1 } from "./config";
import styles from "./market-widgets.module.css";

ModuleRegistry.registerModules([AllCommunityModule]);

const EMPTY_SYMBOLS: readonly string[] = Object.freeze([]);

export type QuoteWidgetProps = WidgetProps<
  EmptyMarketConfigV1,
  Pick<NativeDataOperationMap, "market.quotes">,
  WidgetNoActionMap,
  MarketHostSnapshot
>;

export type MarketHostOnlyWidgetProps = WidgetProps<
  EmptyMarketConfigV1,
  WidgetOperationMap,
  WidgetNoActionMap,
  MarketHostSnapshot
>;

type StockGridRow = Readonly<{
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  changePercent: number | null;
  volume: number | null;
  quoteAt: string | null;
  tradeAt: string | null;
  snapshotEvidence: string;
  liveQuoteEvidence: string;
  liveTradeEvidence: string;
  liveBid: number | null;
  liveAsk: number | null;
  liveTradePrice: number | null;
}>;

const DEFAULT_COL_DEF: ColDef<StockGridRow> = Object.freeze({
  sortable: true,
  resizable: true,
  filter: false,
  minWidth: 95,
});

const COLUMN_DEFS: readonly ColDef<StockGridRow>[] = Object.freeze([
  { field: "symbol", headerName: "Symbol", pinned: "left", minWidth: 95 },
  {
    field: "last",
    headerName: "Snapshot last",
    valueFormatter: ({ value }) => formatNumber(value),
    minWidth: 125,
  },
  {
    field: "bid",
    headerName: "Snapshot bid",
    valueFormatter: ({ value }) => formatNumber(value),
    minWidth: 125,
  },
  {
    field: "ask",
    headerName: "Snapshot ask",
    valueFormatter: ({ value }) => formatNumber(value),
    minWidth: 125,
  },
  {
    field: "liveBid",
    headerName: "Stream bid",
    valueFormatter: ({ value }) => formatNumber(value),
    minWidth: 110,
  },
  {
    field: "liveAsk",
    headerName: "Stream ask",
    valueFormatter: ({ value }) => formatNumber(value),
    minWidth: 110,
  },
  {
    field: "liveTradePrice",
    headerName: "Latest trade",
    valueFormatter: ({ value }) => formatNumber(value),
    minWidth: 120,
  },
  {
    field: "changePercent",
    headerName: "Change %",
    valueFormatter: ({ value }) => formatNumber(value),
    minWidth: 110,
  },
  {
    field: "volume",
    headerName: "Volume",
    valueFormatter: ({ value }) => formatNumber(value, 0),
    minWidth: 100,
  },
  { field: "snapshotEvidence", headerName: "Snapshot source / feed", minWidth: 190 },
  { field: "liveQuoteEvidence", headerName: "Quote stream source / entitlement", minWidth: 220 },
  { field: "liveTradeEvidence", headerName: "Trade stream source / entitlement", minWidth: 220 },
]);

function formatNumber(value: unknown, maximumFractionDigits = 4): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value)
    : "—";
}

function sourceFeed(source: string | null, feed: string | null): string {
  const left = source ?? "source unknown";
  return feed ? `${left} · feed ${feed}` : left;
}

function emptyRow(symbol: string): StockGridRow {
  return Object.freeze({
    symbol,
    last: null,
    bid: null,
    ask: null,
    changePercent: null,
    volume: null,
    quoteAt: null,
    tradeAt: null,
    snapshotEvidence: "unavailable",
    liveQuoteEvidence: "unknown",
    liveTradeEvidence: "unknown",
    liveBid: null,
    liveAsk: null,
    liveTradePrice: null,
  });
}

function rowFromSnapshot(
  symbol: string,
  snapshot: StockSnapshotRow | undefined,
  evidence: string,
): StockGridRow {
  if (!snapshot) return emptyRow(symbol);
  return Object.freeze({
    symbol,
    last: snapshot.last,
    bid: snapshot.bid,
    ask: snapshot.ask,
    changePercent: snapshot.changePercent,
    volume: snapshot.volume,
    quoteAt: snapshot.quoteAt,
    tradeAt: snapshot.tradeAt,
    snapshotEvidence: evidence,
    liveQuoteEvidence: "unknown",
    liveTradeEvidence: "unknown",
    liveBid: null,
    liveAsk: null,
    liveTradePrice: null,
  });
}

function nullableNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return value === null || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function eventEvidence(record: Readonly<Record<string, unknown>>): string {
  const source =
    typeof record.source_label === "string" && record.source_label.length <= 128
      ? record.source_label
      : "source unknown";
  const entitlement =
    typeof record.source_entitlement === "string" && record.source_entitlement.length <= 64
      ? record.source_entitlement
      : "unknown";
  return `${source} · entitlement ${entitlement}`;
}

function applyGatewayUpdates(
  api: GridApi<StockGridRow> | null,
  rowMap: Map<string, StockGridRow>,
  snapshot: MarketHostSnapshot,
  symbols: readonly string[],
  quoteSequences: Map<string, number>,
  tradeSequences: Map<string, number>,
  gatewayInstance: { current: string | null },
): void {
  if (gatewayInstance.current !== snapshot.gatewayInstanceId) {
    quoteSequences.clear();
    tradeSequences.clear();
    gatewayInstance.current = snapshot.gatewayInstanceId;
  }
  if (!api || symbols.length === 0) return;
  const updates: StockGridRow[] = [];
  const targets = new Set(symbols);

  for (const [symbol, event] of Object.entries(snapshot.stockQuotes)) {
    if (
      !targets.has(symbol) ||
      event.kind !== "stock_quote" ||
      typeof event.local_sequence !== "number" ||
      event.local_sequence <= (quoteSequences.get(symbol) ?? 0)
    )
      continue;
    const bid = nullableNumber(event, "bid");
    const ask = nullableNumber(event, "ask");
    if (bid === undefined || ask === undefined) continue;
    const previous = rowMap.get(symbol) ?? emptyRow(symbol);
    const next = Object.freeze({
      ...previous,
      liveBid: bid,
      liveAsk: ask,
      quoteAt: typeof event.event_time === "string" ? event.event_time : previous.quoteAt,
      liveQuoteEvidence: eventEvidence(event),
    });
    quoteSequences.set(symbol, event.local_sequence);
    rowMap.set(symbol, next);
    updates.push(next);
  }

  for (const event of snapshot.stockTrades) {
    if (
      event.kind !== "stock_trade" ||
      typeof event.symbol !== "string" ||
      !targets.has(event.symbol) ||
      typeof event.local_sequence !== "number" ||
      event.local_sequence <= (tradeSequences.get(event.symbol) ?? 0) ||
      typeof event.price !== "number" ||
      !Number.isFinite(event.price)
    )
      continue;
    const previous = rowMap.get(event.symbol) ?? emptyRow(event.symbol);
    const next = Object.freeze({
      ...previous,
      liveTradePrice: event.price,
      tradeAt: typeof event.event_time === "string" ? event.event_time : previous.tradeAt,
      liveTradeEvidence: eventEvidence(event),
    });
    tradeSequences.set(event.symbol, event.local_sequence);
    rowMap.set(event.symbol, next);
    updates.push(next);
  }

  if (updates.length > 0) api.applyTransactionAsync({ update: updates });
}

type QuoteViewProps = Readonly<{
  title: string;
  symbols: readonly string[];
  host: QuoteWidgetHost;
  instanceId: string;
  testId: string;
}>;

function QuoteTable({ title, symbols, host, instanceId, testId }: QuoteViewProps) {
  const requested = useMemo(() => [...new Set(symbols)].slice(0, 50), [symbols]);
  const response = useQuoteSnapshots(host, requested);
  const [rows, setRows] = useState<StockGridRow[]>(() => requested.map(emptyRow));
  const apiRef = useRef<GridApi<StockGridRow> | null>(null);
  const rowsRef = useRef(new Map(requested.map((symbol) => [symbol, emptyRow(symbol)])));
  const quoteSequences = useRef(new Map<string, number>());
  const tradeSequences = useRef(new Map<string, number>());
  const gatewayInstance = useRef<string | null>(null);
  const columns = useMemo(() => [...COLUMN_DEFS], []);
  const leaseSymbols = useMemo(() => symbols.slice(0, 1_000), [symbols]);

  useMarketLease(instanceId, "stocks", leaseSymbols, host.lifecycle);

  useEffect(() => {
    const next = requested.map(emptyRow);
    rowsRef.current = new Map(next.map((row) => [row.symbol, row]));
    quoteSequences.current.clear();
    tradeSequences.current.clear();
    gatewayInstance.current = null;
    setRows(next);
    apiRef.current?.setGridOption("rowData", next);
  }, [requested]);

  useEffect(() => {
    if (response.status !== "ready") return;
    const source = sourceFeed(response.value.evidence.source, response.value.evidence.feed);
    const evidence = response.value.evidence.asOf
      ? `${source} · as_of ${response.value.evidence.asOf}`
      : `${source} · as_of unknown`;
    const bySymbol = new Map(response.value.snapshots.map((row) => [row.symbol, row]));
    const next = requested.map((symbol) => rowFromSnapshot(symbol, bySymbol.get(symbol), evidence));
    rowsRef.current = new Map(next.map((row) => [row.symbol, row]));
    setRows(next);
    if (apiRef.current) apiRef.current.setGridOption("rowData", next);
    applyGatewayUpdates(
      apiRef.current,
      rowsRef.current,
      host.market.getSnapshot(),
      requested,
      quoteSequences.current,
      tradeSequences.current,
      gatewayInstance,
    );
  }, [host.market, requested, response]);

  const onGridReady = useCallback(
    (event: GridReadyEvent<StockGridRow>) => {
      apiRef.current = event.api;
      event.api.setGridOption(
        "rowData",
        rowsRef.current.size ? [...rowsRef.current.values()] : rows,
      );
      applyGatewayUpdates(
        apiRef.current,
        rowsRef.current,
        host.market.getSnapshot(),
        requested,
        quoteSequences.current,
        tradeSequences.current,
        gatewayInstance,
      );
    },
    [host.market, requested, rows],
  );

  useEffect(() => {
    const update = () =>
      applyGatewayUpdates(
        apiRef.current,
        rowsRef.current,
        host.market.getSnapshot(),
        requested,
        quoteSequences.current,
        tradeSequences.current,
        gatewayInstance,
      );
    return host.market.subscribe(update);
  }, [host.market, requested]);

  const dataState =
    response.status === "ready"
      ? "ready"
      : response.status === "unsupported"
        ? "unsupported"
        : response.status === "error"
          ? "error"
          : response.status === "loading"
            ? "loading"
            : "unavailable";
  const dataDetail =
    response.status === "error" || response.status === "unsupported"
      ? response.detail
      : response.status === "ready"
        ? `${requested.length} symbol(s) · ${sourceFeed(response.value.evidence.source, response.value.evidence.feed)} · as_of ${response.value.evidence.asOf ?? "unknown"}; snapshot and stream values remain separate.`
        : "Waiting for the bounded same-origin snapshot read.";

  return (
    <section className={styles.marketWidget} data-testid={testId} aria-label={title}>
      <h2>{title}</h2>
      <ResourceState state={dataState} title="Snapshot data" detail={dataDetail} />
      <StockFeedState host={host} />
      {symbols.length > 50 ? (
        <p className={styles.notice}>
          Snapshot request is capped at 50 symbols; stream targets remain shared by the host.
        </p>
      ) : null}
      <section className={styles.marketGrid} aria-label={`${title} data grid`}>
        <AgGridReact<StockGridRow>
          columnDefs={columns}
          defaultColDef={DEFAULT_COL_DEF}
          getRowId={({ data }) => data.symbol}
          onGridReady={onGridReady}
          rowData={rows}
          theme={themeQuartz}
        />
      </section>
      <p className={styles.marketFootnote}>
        Snapshot `as_of` and per-event source/entitlement fields are preserved. A stream print is
        not inferred to be a buy or sell.
      </p>
    </section>
  );
}

export function QuoteWidget({ host, instance, inputs }: QuoteWidgetProps) {
  const symbol = inputs.symbol ?? "";
  const symbols = useMemo(() => (symbol ? [symbol] : EMPTY_SYMBOLS), [symbol]);
  return (
    <QuoteTable
      title="Quote"
      symbols={symbols}
      host={host}
      instanceId={instance.instanceId}
      testId="market-quote-widget"
    />
  );
}

export function WatchlistWidget({ host, instance, inputs }: QuoteWidgetProps) {
  const symbols = inputs.watchlist ?? EMPTY_SYMBOLS;
  return (
    <QuoteTable
      title="Watchlist"
      symbols={symbols}
      host={host}
      instanceId={instance.instanceId}
      testId="market-watchlist-widget"
    />
  );
}

function StockFeedState({ host }: Readonly<{ host: QuoteWidgetHost }>) {
  const [feed, setFeed] = useState(() => {
    const snapshot = host.market.getSnapshot();
    return {
      freshness: snapshot.feeds.stocks.freshness,
      transportState: snapshot.transportState,
      connectionEpoch: snapshot.feeds.stocks.connectionEpoch,
      lastSequence: snapshot.feeds.stocks.lastSequence,
      coverage: snapshot.leases.stocks.coverage,
      selectedCount: snapshot.leases.stocks.selectedCount,
      leasedCount: snapshot.leases.stocks.leasedCount,
      omittedCount: snapshot.leases.stocks.omittedCount,
    };
  });
  useEffect(
    () =>
      host.market.subscribe(() => {
        const snapshot = host.market.getSnapshot();
        const next = {
          freshness: snapshot.feeds.stocks.freshness,
          transportState: snapshot.transportState,
          connectionEpoch: snapshot.feeds.stocks.connectionEpoch,
          lastSequence: snapshot.feeds.stocks.lastSequence,
          coverage: snapshot.leases.stocks.coverage,
          selectedCount: snapshot.leases.stocks.selectedCount,
          leasedCount: snapshot.leases.stocks.leasedCount,
          omittedCount: snapshot.leases.stocks.omittedCount,
        };
        setFeed((current) =>
          Object.keys(next).every(
            (key) => current[key as keyof typeof current] === next[key as keyof typeof next],
          )
            ? current
            : next,
        );
      }),
    [host.market],
  );
  const leaseState =
    feed.coverage === "pending"
      ? "loading"
      : feed.coverage === "complete"
        ? "ready"
        : feed.coverage === "partial"
          ? "partial"
          : feed.coverage === "error"
            ? "error"
            : "unknown";
  return (
    <ResourceState
      state={feed.freshness}
      title="Gateway stock stream freshness"
      detail={`transport ${feed.transportState}; connection epoch ${feed.connectionEpoch ?? "unknown"}; last local sequence ${feed.lastSequence ?? "unknown"}; Gateway lease acknowledgement exposes counts only, exact active symbols are unverified.`}
      metadata={
        <span data-state={leaseState}>
          lease {leaseState}; selected {feed.selectedCount}; acknowledged {feed.leasedCount};
          omitted {feed.omittedCount}; exact membership unverified
        </span>
      }
    />
  );
}

function field(record: Readonly<Record<string, unknown>> | null, key: string, max = 128): string {
  const value = record?.[key];
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlCharacters(value)
    ? value
    : "unknown";
}

function FeedRow({
  snapshot,
  feedName,
}: Readonly<{ snapshot: MarketHostSnapshot; feedName: "stocks" | "options" }>) {
  const feed = snapshot.feeds[feedName];
  const lease = snapshot.leases[feedName];
  const raw = feed.rawStatus;
  const error = raw?.last_error;
  const errorRecord =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Readonly<Record<string, unknown>>)
      : null;
  const coverage = raw?.coverage;
  const coverageRecord =
    coverage && typeof coverage === "object" && !Array.isArray(coverage)
      ? (coverage as Readonly<Record<string, unknown>>)
      : null;
  return (
    <article className={styles.feedCard}>
      <h3>{feedName === "stocks" ? "Stocks" : "Options"}</h3>
      <ResourceState
        state={feed.freshness}
        title={`${feedName} event freshness`}
        detail={`transport ${field(raw, "transport")}; auth ${field(raw, "auth")}; upstream ${field(raw, "upstream")}`}
        metadata={`source mode ${field(raw, "source_mode")}; source ${field(raw, "source_label")}; entitlement ${field(raw, "source_entitlement")}; epoch ${feed.connectionEpoch ?? "unknown"}; sequence ${feed.lastSequence ?? "unknown"}`}
      />
      <ResourceState
        state={
          lease.coverage === "pending"
            ? "loading"
            : lease.coverage === "complete"
              ? "ready"
              : lease.coverage === "partial"
                ? "partial"
                : lease.coverage === "error"
                  ? "error"
                  : "unknown"
        }
        title={`${feedName} lease coverage`}
        detail={`requested ${lease.requestedCount}; selected ${lease.selectedCount}; acknowledged ${lease.leasedCount}; omitted ${lease.omittedCount}; max ${typeof coverageRecord?.max === "number" ? coverageRecord.max : "unknown"}; exact active symbols are unverified.`}
        metadata={`coverage complete ${typeof raw?.coverage_complete === "boolean" ? String(raw.coverage_complete) : "unknown"}; resync required ${typeof raw?.resync_required === "boolean" ? String(raw.resync_required) : "unknown"}`}
      />
      {errorRecord ? (
        <p className={styles.notice}>
          Gateway error: {field(errorRecord, "class")} · {field(errorRecord, "code")}
        </p>
      ) : null}
      {raw && typeof raw.decode_error_count === "number" ? (
        <p>Decode errors reported: {raw.decode_error_count}</p>
      ) : null}
    </article>
  );
}

export function FeedStatusWidget({ host }: MarketHostOnlyWidgetProps) {
  const snapshot = useMarketSnapshot(host);
  return (
    <section
      className={styles.marketWidget}
      data-testid="market-feed-status-widget"
      aria-label="Market feed status"
    >
      <h2>Feed status</h2>
      <ResourceState
        state={snapshot.transportState}
        title="Shared Gateway event stream"
        detail={
          snapshot.transportError ??
          "One host-owned same-origin event stream is shared by market widgets."
        }
        metadata={`Gateway instance ${snapshot.gatewayInstanceId ?? "unknown"}; sequence watermark ${snapshot.lastSequence ?? "unknown"}`}
      />
      <div className={styles.feedGrid}>
        <FeedRow snapshot={snapshot} feedName="stocks" />
        <FeedRow snapshot={snapshot} feedName="options" />
      </div>
    </section>
  );
}

export function OrderbookWidget() {
  return (
    <section
      className={styles.marketWidget}
      data-testid="market-orderbook-widget"
      aria-label="Order book"
    >
      <h2>Order book</h2>
      <ResourceState
        state="unsupported"
        title="Depth data"
        detail="No typed depth source is available; depth is not displayed."
      />
    </section>
  );
}
