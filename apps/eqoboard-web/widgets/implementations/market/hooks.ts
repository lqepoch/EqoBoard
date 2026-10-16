"use client";

import { useEffect, useMemo, useState } from "react";

import type { NativeDataOperationMap } from "../../../features/data/operations";
import {
  decodeOptionChainResponse,
  decodeQuoteResponse,
  isCanonicalTicker,
} from "../../../features/market/market-contracts";
import type { OptionChainResponse, QuoteResponse } from "../../../features/market/market-contracts";
import { useMarketLease } from "../../../features/data/MarketDataHost";
import type {
  MarketHostSnapshot,
  MarketLeaseSnapshot,
  MarketStockLeaseCapacity,
} from "../../../stores/market/market-store";
import type { WidgetHostContext } from "../../../widgets/sdk/contracts";
import type { WidgetNoActionMap } from "../../../widgets/sdk/actions";
import type { WidgetOperationDefinition, WidgetOperationMap } from "../../../widgets/sdk/data";

export type MarketWidgetHost<
  TOperations extends {
    readonly [K in keyof TOperations]: WidgetOperationDefinition;
  } = NativeDataOperationMap,
> = WidgetHostContext<TOperations, WidgetNoActionMap, MarketHostSnapshot>;

export type QuoteWidgetHost = MarketWidgetHost<Pick<NativeDataOperationMap, "market.quotes">>;
export type OptionsWidgetHost = MarketWidgetHost<
  Pick<NativeDataOperationMap, "market.quotes" | "market.options.chain">
>;
export type MarketSnapshotOnlyHost = MarketWidgetHost<WidgetOperationMap>;

export type ReadState<T> =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{ status: "error"; detail: string }>
  | Readonly<{ status: "unsupported"; detail: string }>
  | Readonly<{ status: "partial"; detail: string; value: T }>
  | Readonly<{ status: "ready"; value: T }>;

export function useMarketSnapshot(host: Pick<MarketWidgetHost, "market">): MarketHostSnapshot {
  const [snapshot, setSnapshot] = useState(host.market.getSnapshot);
  useEffect(() => {
    setSnapshot(host.market.getSnapshot());
    return host.market.subscribe(() => setSnapshot(host.market.getSnapshot()));
  }, [host.market]);
  return snapshot;
}

type AvailableQuoteResponse = Extract<QuoteResponse, Readonly<{ status: "available" }>>;

export type StockQuoteReadPlan =
  | Readonly<{ status: "wait"; detail: string }>
  | Readonly<{ status: "error" | "unsupported"; detail: string }>
  | Readonly<{
      status: "read";
      symbols: readonly string[];
      omittedSymbols: readonly string[];
    }>;

export function planStockQuoteRead(
  symbols: readonly string[],
  stockLeaseRequired: boolean,
  lease: MarketLeaseSnapshot,
  capacity: MarketStockLeaseCapacity,
): StockQuoteReadPlan {
  if (!stockLeaseRequired)
    return { status: "read", symbols: Object.freeze([...symbols]), omittedSymbols: Object.freeze([]) };
  if (capacity.status === "unknown" || capacity.status === "pending")
    return { status: "wait", detail: "Waiting for Gateway stock subscription capacity." };
  if (capacity.status === "unavailable")
    return {
      status: "unsupported",
      detail: "Gateway stock subscription capacity is unavailable; quote reads are withheld.",
    };
  if (lease.coverage === "error")
    return {
      status: "error",
      detail: "The stock lease was not acknowledged; quote reads are withheld.",
    };
  if (
    (lease.coverage !== "complete" && lease.coverage !== "partial") ||
    lease.acknowledgedAt === null
  )
    return { status: "wait", detail: "Waiting for the stock lease acknowledgement." };

  const selected = new Set(lease.selectedSymbols);
  const selectedSymbols = Object.freeze(symbols.filter((symbol) => selected.has(symbol)));
  const omittedSymbols = Object.freeze(symbols.filter((symbol) => !selected.has(symbol)));
  if (selectedSymbols.length === 0)
    return {
      status: "unsupported",
      detail: `No requested symbols are in the acknowledged stock lease (${symbols.length} unavailable).`,
    };
  return { status: "read", symbols: selectedSymbols, omittedSymbols };
}

function readStockLeaseState(host: Pick<MarketWidgetHost, "market">): Readonly<{
  lease: MarketLeaseSnapshot;
  capacity: MarketStockLeaseCapacity;
}> {
  const snapshot = host.market.getSnapshot();
  return { lease: snapshot.leases.stocks, capacity: snapshot.stockLeaseCapacity };
}

function useStockLeaseState(host: Pick<MarketWidgetHost, "market">) {
  const [state, setState] = useState(() => readStockLeaseState(host));
  useEffect(() => {
    let current = readStockLeaseState(host);
    setState(current);
    return host.market.subscribe(() => {
      const next = readStockLeaseState(host);
      if (next.lease === current.lease && next.capacity === current.capacity) return;
      current = next;
      setState(next);
    });
  }, [host.market]);
  return state;
}

export function useQuoteSnapshots(
  host: QuoteWidgetHost,
  symbols: readonly string[],
  stockLeaseRequired = false,
): ReadState<AvailableQuoteResponse> {
  const safeSymbols = useMemo(
    () => [...new Set(symbols.filter(isCanonicalTicker))].slice(0, 50),
    [symbols],
  );
  const [state, setState] = useState<ReadState<AvailableQuoteResponse>>({ status: "idle" });
  const stockLease = useStockLeaseState(host);

  useEffect(() => {
    if (safeSymbols.length === 0) {
      setState({ status: "idle" });
      return undefined;
    }
    const readPlan = planStockQuoteRead(
      safeSymbols,
      stockLeaseRequired,
      stockLease.lease,
      stockLease.capacity,
    );
    if (readPlan.status !== "read") {
      setState(
        readPlan.status === "wait"
          ? { status: "loading" }
          : { status: readPlan.status, detail: readPlan.detail },
      );
      return undefined;
    }
    return host.refresh.observe(
      "market.quotes",
      { symbols: readPlan.symbols },
      { refreshIntervalMs: 30_000 },
      (scheduled) => {
        if (scheduled.status === "pending") {
          setState((current) =>
            current.status === "ready" || current.status === "partial"
              ? current
              : { status: "loading" },
          );
          return;
        }
        if (scheduled.status === "error") {
          setState({
            status: "error",
            detail:
              scheduled.code === "rate-limited"
                ? "The quote snapshot read is rate limited."
                : "The same-origin quote read failed or was not authorized.",
          });
          return;
        }
        const decoded = decodeQuoteResponse(scheduled.value);
        if (!decoded) {
          setState({
            status: "error",
            detail: "The quote response did not match a known provider contract.",
          });
        } else if (decoded.status === "unsupported-source") {
          setState({
            status: "unsupported",
            detail: `Provider response source is not supported for display (${decoded.evidence.sourceLabel ?? decoded.evidence.source ?? "unknown"}).`,
          });
        } else {
          setState(
            readPlan.omittedSymbols.length > 0
              ? {
                  status: "partial",
                  value: decoded,
                  detail: `${readPlan.symbols.length} of ${safeSymbols.length} symbols are within the acknowledged stock lease; ${readPlan.omittedSymbols.length} remain unavailable because of the active subscription capacity.`,
                }
              : { status: "ready", value: decoded },
          );
        }
      },
    );
  }, [
    host.refresh,
    safeSymbols,
    stockLeaseRequired,
    stockLease.lease,
    stockLease.capacity,
  ]);

  return state;
}

export type OptionsResource = Readonly<{
  state: ReadState<OptionChainResponse>;
  underlyingPrice: number | null;
  underlyingEvidence: string;
  selectedLeaseSymbols: readonly string[];
  feedFreshness: MarketHostSnapshot["feeds"]["options"]["freshness"];
  transportState: MarketHostSnapshot["transportState"];
  lease: MarketHostSnapshot["leases"]["options"];
}>;

export function useOptionsResource(
  host: OptionsWidgetHost,
  instanceId: string,
  symbol: string,
  expiry: string,
): OptionsResource {
  const [state, setState] = useState<ReadState<OptionChainResponse>>({ status: "idle" });
  const [snapshotPrice, setSnapshotPrice] = useState<number | null>(null);
  const [underlyingEvidence, setUnderlyingEvidence] = useState(
    "No verified Alpaca SIP underlying snapshot is available.",
  );
  const [streamView, setStreamView] = useState(() => {
    const snapshot = host.market.getSnapshot();
    return {
      feedFreshness: snapshot.feeds.options.freshness,
      transportState: snapshot.transportState,
      lease: snapshot.leases.options,
      stockLease: snapshot.leases.stocks,
    };
  });
  const valid = isCanonicalTicker(symbol) && /^\d{4}-\d{2}-\d{2}$/u.test(expiry);
  const underlyingPrice = snapshotPrice;
  const stockLeaseSymbols = useMemo(() => (valid ? [symbol] : []), [symbol, valid]);
  const stockLeaseRequired = useMarketLease(instanceId, "stocks", stockLeaseSymbols, host.lifecycle);

  useEffect(() => {
    const sync = () => {
      const snapshot = host.market.getSnapshot();
      setStreamView((current) => {
        const next = {
          feedFreshness: snapshot.feeds.options.freshness,
          transportState: snapshot.transportState,
          lease: snapshot.leases.options,
          stockLease: snapshot.leases.stocks,
        };
        return current.feedFreshness === next.feedFreshness &&
          current.transportState === next.transportState &&
          current.lease === next.lease &&
          current.stockLease === next.stockLease
          ? current
          : next;
      });
    };
    sync();
    return host.market.subscribe(sync);
  }, [host.market]);

  useEffect(() => {
    if (!valid) {
      setState({ status: "idle" });
      setSnapshotPrice(null);
      setUnderlyingEvidence(
        "Choose a valid symbol and expiration; a verified Alpaca SIP snapshot is required to select option contracts.",
      );
      return undefined;
    }
    setSnapshotPrice(null);
    setUnderlyingEvidence(
      "Checking the bounded same-origin quote snapshot for a verified Alpaca SIP feed.",
    );
    if (stockLeaseRequired) {
      if (streamView.stockLease.coverage === "error") {
        setUnderlyingEvidence(
          "The underlying stock lease was not acknowledged; no quote read was issued.",
        );
        return undefined;
      }
      if (
        (streamView.stockLease.coverage !== "complete" &&
          streamView.stockLease.coverage !== "partial") ||
        streamView.stockLease.acknowledgedAt === null
      ) {
        setUnderlyingEvidence(
          "Waiting for the underlying stock lease acknowledgement before reading a quote.",
        );
        return undefined;
      }
      if (!streamView.stockLease.selectedSymbols.includes(symbol)) {
        setUnderlyingEvidence(
          `Underlying symbol is outside the acknowledged stock lease (${streamView.stockLease.omittedCount} symbol(s) omitted); no quote read was issued.`,
        );
        return undefined;
      }
    }
    return host.refresh.observe(
      "market.quotes",
      { symbols: [symbol] },
      { refreshIntervalMs: 30_000 },
      (scheduled) => {
        if (scheduled.status === "pending") return;
        if (scheduled.status === "error") {
          setSnapshotPrice(null);
          setUnderlyingEvidence(
            scheduled.code === "rate-limited"
              ? "The underlying snapshot read is rate limited; no option contracts are selected."
              : "The same-origin underlying snapshot read failed or was not authorized.",
          );
          return;
        }
        const quotes = decodeQuoteResponse(scheduled.value);
        if (!quotes) {
          setSnapshotPrice(null);
          setUnderlyingEvidence("The quote response did not match a known provider contract.");
          return;
        }
        const evidence = `source ${quotes.evidence.source ?? "unknown"}; feed ${quotes.evidence.feed ?? "unknown"}; as_of ${quotes.evidence.asOf ?? "unknown"}`;
        if (quotes.status !== "available") {
          setSnapshotPrice(null);
          setUnderlyingEvidence(
            `Underlying snapshot is not supported for contract selection (${evidence}).`,
          );
          return;
        }
        const last = quotes.snapshots.find((entry) => entry.symbol === symbol)?.last ?? null;
        if (
          last !== null &&
          last > 0 &&
          quotes.evidence.source === "alpaca" &&
          quotes.evidence.feed?.toLowerCase() === "sip"
        ) {
          setSnapshotPrice(last);
          setUnderlyingEvidence(`verified Alpaca SIP snapshot · ${evidence}`);
        } else {
          setSnapshotPrice(null);
          setUnderlyingEvidence(
            `No verified Alpaca SIP underlying snapshot; received ${evidence}.`,
          );
        }
      },
    );
  }, [host.refresh, symbol, valid, stockLeaseRequired, streamView.stockLease]);

  useEffect(() => {
    if (!valid) {
      setState({ status: "idle" });
      return undefined;
    }
    return host.refresh.observe(
      "market.options.chain",
      { symbol, expiry },
      { refreshIntervalMs: 30_000 },
      (scheduled) => {
        if (scheduled.status === "pending") {
          setState((current) => (current.status === "ready" ? current : { status: "loading" }));
          return;
        }
        if (scheduled.status === "error") {
          setState({
            status: "error",
            detail:
              scheduled.code === "rate-limited"
                ? "The option chain read is rate limited."
                : "The same-origin option chain read failed or was not authorized.",
          });
          return;
        }
        const decoded = decodeOptionChainResponse(scheduled.value, symbol, expiry);
        if (!decoded) {
          setState({
            status: "error",
            detail: "The option chain response did not match the expected Alpaca chain contract.",
          });
          return;
        }
        if (decoded.source !== "alpaca") {
          setState({
            status: "unsupported",
            detail: "Only the known Alpaca option-chain contract is supported.",
          });
          return;
        }
        setState({ status: "ready", value: decoded });
      },
    );
  }, [host.refresh, symbol, expiry, valid]);

  const selectedLeaseSymbols = useMemo(() => {
    if (
      state.status !== "ready" ||
      underlyingPrice === null ||
      !Number.isFinite(underlyingPrice) ||
      underlyingPrice <= 0
    )
      return Object.freeze([] as string[]);
    return Object.freeze(
      [...state.value.contracts]
        .sort(
          (left, right) =>
            Math.abs(left.strike - underlyingPrice) - Math.abs(right.strike - underlyingPrice) ||
            left.symbol.localeCompare(right.symbol),
        )
        .slice(0, 16)
        .map((contract) => contract.symbol),
    );
  }, [state, underlyingPrice]);

  useMarketLease(instanceId, "options", selectedLeaseSymbols, host.lifecycle);

  return Object.freeze({
    state,
    underlyingPrice,
    underlyingEvidence,
    selectedLeaseSymbols,
    feedFreshness: streamView.feedFreshness,
    transportState: streamView.transportState,
    lease: streamView.lease,
  });
}

export function resourceStateFromRead<T>(
  state: ReadState<T>,
): "loading" | "ready" | "partial" | "error" | "unsupported" | "unavailable" {
  switch (state.status) {
    case "loading":
      return "loading";
    case "ready":
      return "ready";
    case "partial":
      return "partial";
    case "error":
      return "error";
    case "unsupported":
      return "unsupported";
    case "idle":
      return "unavailable";
  }
}
