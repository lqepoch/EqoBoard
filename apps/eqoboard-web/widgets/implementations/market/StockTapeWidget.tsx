"use client";

import { useEffect, useMemo, useState } from "react";

import { ResourceState } from "@/components/shell/ResourceState";
import { useMarketLease } from "@/features/data/MarketDataHost";
import type { MarketHostSnapshot } from "@/stores/market/market-store";
import type { WidgetProps } from "@/widgets/sdk/contracts";
import type { WidgetNoActionMap } from "@/widgets/sdk/actions";
import type { WidgetOperationMap } from "@/widgets/sdk/data";
import type { EmptyMarketConfigV1 } from "./config";
import {
  stockTapeRows,
  stockTapeSummary,
  type StockTapeRow,
  type StockTapeSummary,
} from "./stock-tape";
import styles from "./market-widgets.module.css";
import tapeStyles from "./stock-tape.module.css";

/** Coalesces bursts of shared-stream batches into a few React renders per second. */
const TAPE_REFRESH_MS = 250;
const EMPTY_SYMBOLS: readonly string[] = Object.freeze([]);
const PRICE_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const SIZE_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const TICK_GLYPH = Object.freeze({ up: "▲", down: "▼", flat: "–", first: "·" });
const TICK_LABEL = Object.freeze({
  up: "Uptick versus prior print",
  down: "Downtick versus prior print",
  flat: "Unchanged versus prior print",
  first: "First print in view",
});

export type StockTapeWidgetProps = WidgetProps<
  EmptyMarketConfigV1,
  WidgetOperationMap,
  WidgetNoActionMap,
  MarketHostSnapshot
>;

type StockTapeState = Readonly<{
  rows: readonly StockTapeRow[];
  summary: StockTapeSummary;
}>;

function readTapeState(snapshot: MarketHostSnapshot, symbol: string): StockTapeState {
  return { rows: stockTapeRows(snapshot, symbol), summary: stockTapeSummary(snapshot) };
}

function useStockTape(host: StockTapeWidgetProps["host"], symbol: string): StockTapeState {
  const [state, setState] = useState<StockTapeState>(() =>
    readTapeState(host.market.getSnapshot(), symbol),
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = false;
    const publish = () => {
      timer = null;
      setState(readTapeState(host.market.getSnapshot(), symbol));
    };
    const schedule = () => {
      if (timer === null) timer = setTimeout(publish, TAPE_REFRESH_MS);
    };
    const syncLifecycle = () => {
      const isActive = host.lifecycle.getSnapshot().phase === "active";
      if (isActive === active) return;
      active = isActive;
      if (isActive) {
        publish();
      } else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const unsubscribeMarket = host.market.subscribe(() => {
      if (active) schedule();
    });
    const unsubscribeLifecycle = host.lifecycle.subscribe(syncLifecycle);
    syncLifecycle();
    return () => {
      unsubscribeMarket();
      unsubscribeLifecycle();
      if (timer !== null) clearTimeout(timer);
    };
  }, [host.lifecycle, host.market, symbol]);

  return state;
}

export function StockTapeWidget({ host, instance, inputs }: StockTapeWidgetProps) {
  const symbol = inputs.symbol ?? "";
  const symbols = useMemo(() => (symbol ? [symbol] : EMPTY_SYMBOLS), [symbol]);
  // The tape leases its own symbol so prints flow even when no quote widget is open.
  useMarketLease(instance.instanceId, "stocks", symbols, host.lifecycle);
  const { rows, summary } = useStockTape(host, symbol);
  const visibleRows = rows.filter((row) => row.symbol === symbol);
  const provenance =
    visibleRows.length > 0
      ? `${visibleRows[0].source} · entitlement ${visibleRows[0].entitlement}`
      : `${summary.source} · entitlement ${summary.entitlement}`;

  return (
    <section
      className={styles.marketWidget}
      data-testid="market-stock-tape-widget"
      aria-label="Time and sales"
    >
      <header className={tapeStyles.tapeHeader}>
        <h2>Time &amp; sales</h2>
        <span className={tapeStyles.symbol}>{symbol || "No symbol"}</span>
      </header>
      <ResourceState
        state={summary.freshness}
        title="Stock stream freshness"
        detail={`transport ${summary.transportState}; epoch ${summary.connectionEpoch ?? "unknown"}`}
      />
      <div aria-hidden="true" className={tapeStyles.tapeHead}>
        <span>Time (UTC)</span>
        <span className={tapeStyles.alignEnd}>Price</span>
        <span className={tapeStyles.alignEnd}>Size</span>
        <span className={tapeStyles.alignCenter}>Tick</span>
      </div>
      {visibleRows.length > 0 ? (
        <ol
          aria-label={`${symbol} prints, newest first`}
          className={tapeStyles.tapeList}
          data-testid="market-stock-tape-rows"
        >
          {visibleRows.map((row) => (
            <li className={tapeStyles.tapeRow} data-direction={row.direction} key={row.id}>
              <time className={tapeStyles.clock}>{row.clock ?? "unknown"}</time>
              <span className={tapeStyles.price}>{PRICE_FORMAT.format(row.price)}</span>
              <span className={tapeStyles.size}>
                {row.size === null ? "unknown" : SIZE_FORMAT.format(row.size)}
              </span>
              <span
                aria-label={TICK_LABEL[row.direction]}
                className={tapeStyles.tick}
                title={TICK_LABEL[row.direction]}
              >
                {TICK_GLYPH[row.direction]}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.emptyState}>
          {symbol
            ? `No prints for ${symbol} on the current stock stream yet. Prints appear once the shared stream confirms this symbol.`
            : "Select a symbol to show its prints."}
        </p>
      )}
      <p className={styles.marketFootnote}>
        {provenance}. Tick arrows compare adjacent prints only. The source provides no aggressor
        side, so prints are not labelled as buys or sells.
      </p>
    </section>
  );
}
