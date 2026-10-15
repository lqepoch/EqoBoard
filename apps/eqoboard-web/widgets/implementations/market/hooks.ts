"use client";

import { useEffect, useMemo, useState } from "react";

import type { NativeDataOperationMap } from "../../../features/data/operations";
import { decodeOptionChainResponse, decodeQuoteResponse, isCanonicalTicker } from "../../../features/market/market-contracts";
import type { OptionChainResponse, QuoteResponse, StockSnapshotRow } from "../../../features/market/market-contracts";
import { useMarketLease } from "../../../features/data/MarketDataHost";
import type { MarketHostSnapshot } from "../../../stores/market/market-store";
import type { WidgetHostContext } from "../../../widgets/sdk/contracts";
import type { WidgetNoActionMap } from "../../../widgets/sdk/actions";
import type { WidgetOperationDefinition, WidgetOperationMap } from "../../../widgets/sdk/data";

export type MarketWidgetHost<TOperations extends { readonly [K in keyof TOperations]: WidgetOperationDefinition } = NativeDataOperationMap> =
  WidgetHostContext<TOperations, WidgetNoActionMap, MarketHostSnapshot>;

export type QuoteWidgetHost = MarketWidgetHost<Pick<NativeDataOperationMap, "market.quotes">>;
export type OptionsWidgetHost = MarketWidgetHost<Pick<NativeDataOperationMap, "market.quotes" | "market.options.chain">>;
export type MarketSnapshotOnlyHost = MarketWidgetHost<WidgetOperationMap>;

export type ReadState<T> =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{ status: "error"; detail: string }>
  | Readonly<{ status: "unsupported"; detail: string }>
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

export function useQuoteSnapshots(host: QuoteWidgetHost, symbols: readonly string[]): ReadState<AvailableQuoteResponse> {
  const symbolsKey = JSON.stringify(symbols);
  const safeSymbols = useMemo(() => [...new Set(symbols.filter(isCanonicalTicker))].slice(0, 50), [symbolsKey]);
  const [state, setState] = useState<ReadState<AvailableQuoteResponse>>({ status: "idle" });

  useEffect(() => {
    if (safeSymbols.length === 0) {
      setState({ status: "idle" });
      return undefined;
    }
    return host.refresh.observe(
      "market.quotes",
      { symbols: safeSymbols },
      { refreshIntervalMs: 30_000 },
      (scheduled) => {
        if (scheduled.status === "pending") {
          setState((current) => current.status === "ready" ? current : { status: "loading" });
          return;
        }
        if (scheduled.status === "error") {
          setState({ status: "error", detail: scheduled.code === "rate-limited"
            ? "The quote snapshot read is rate limited."
            : "The same-origin quote read failed or was not authorized." });
          return;
        }
        const decoded = decodeQuoteResponse(scheduled.value);
        if (!decoded) {
          setState({ status: "error", detail: "The quote response did not match a known provider contract." });
        } else if (decoded.status === "unsupported-source") {
          setState({ status: "unsupported", detail: `Provider response source is not supported for display (${decoded.evidence.sourceLabel ?? decoded.evidence.source ?? "unknown"}).` });
        } else {
          setState({ status: "ready", value: decoded });
        }
      },
    );
  }, [host.refresh, symbolsKey]);

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

export function useOptionsResource(host: OptionsWidgetHost, instanceId: string, symbol: string, expiry: string): OptionsResource {
  const [state, setState] = useState<ReadState<OptionChainResponse>>({ status: "idle" });
  const [snapshotPrice, setSnapshotPrice] = useState<number | null>(null);
  const [underlyingEvidence, setUnderlyingEvidence] = useState("No verified Alpaca SIP underlying snapshot is available.");
  const [streamView, setStreamView] = useState(() => {
    const snapshot = host.market.getSnapshot();
    return { feedFreshness: snapshot.feeds.options.freshness, transportState: snapshot.transportState, lease: snapshot.leases.options };
  });
  const valid = isCanonicalTicker(symbol) && /^\d{4}-\d{2}-\d{2}$/u.test(expiry);
  const underlyingPrice = snapshotPrice;

  useEffect(() => {
    const sync = () => {
      const snapshot = host.market.getSnapshot();
      setStreamView((current) => {
        const next = { feedFreshness: snapshot.feeds.options.freshness, transportState: snapshot.transportState, lease: snapshot.leases.options };
        return current.feedFreshness === next.feedFreshness && current.transportState === next.transportState && current.lease === next.lease
          ? current
          : next;
      });
    };
    sync();
    return host.market.subscribe(sync);
  }, [host.market, symbol, valid]);

  useEffect(() => {
    if (!valid) {
      setState({ status: "idle" });
      setSnapshotPrice(null);
      setUnderlyingEvidence("Choose a valid symbol and expiration; a verified Alpaca SIP snapshot is required to select option contracts.");
      return undefined;
    }
    setSnapshotPrice(null);
    setUnderlyingEvidence("Checking the bounded same-origin quote snapshot for a verified Alpaca SIP feed.");
    return host.refresh.observe(
      "market.quotes",
      { symbols: [symbol] },
      { refreshIntervalMs: 30_000 },
      (scheduled) => {
        if (scheduled.status === "pending") return;
        if (scheduled.status === "error") {
          setSnapshotPrice(null);
          setUnderlyingEvidence(scheduled.code === "rate-limited"
            ? "The underlying snapshot read is rate limited; no option contracts are selected."
            : "The same-origin underlying snapshot read failed or was not authorized.");
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
          setUnderlyingEvidence(`Underlying snapshot is not supported for contract selection (${evidence}).`);
          return;
        }
        const last = quotes.snapshots.find((entry) => entry.symbol === symbol)?.last ?? null;
        if (last !== null && last > 0 && quotes.evidence.source === "alpaca" && quotes.evidence.feed?.toLowerCase() === "sip") {
          setSnapshotPrice(last);
          setUnderlyingEvidence(`verified Alpaca SIP snapshot · ${evidence}`);
        } else {
          setSnapshotPrice(null);
          setUnderlyingEvidence(`No verified Alpaca SIP underlying snapshot; received ${evidence}.`);
        }
      },
    );
  }, [host.refresh, symbol, valid]);

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
          setState((current) => current.status === "ready" ? current : { status: "loading" });
          return;
        }
        if (scheduled.status === "error") {
          setState({ status: "error", detail: scheduled.code === "rate-limited"
            ? "The option chain read is rate limited."
            : "The same-origin option chain read failed or was not authorized." });
          return;
        }
        const decoded = decodeOptionChainResponse(scheduled.value, symbol, expiry);
        if (!decoded) {
          setState({ status: "error", detail: "The option chain response did not match the expected Alpaca chain contract." });
          return;
        }
        if (decoded.source !== "alpaca") {
          setState({ status: "unsupported", detail: "Only the known Alpaca option-chain contract is supported." });
          return;
        }
        setState({ status: "ready", value: decoded });
      },
    );
  }, [host.refresh, symbol, expiry, valid]);

  const selectedLeaseSymbols = useMemo(() => {
    if (state.status !== "ready" || underlyingPrice === null || !Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return Object.freeze([] as string[]);
    return Object.freeze([...state.value.contracts]
      .sort((left, right) => Math.abs(left.strike - underlyingPrice) - Math.abs(right.strike - underlyingPrice) || left.symbol.localeCompare(right.symbol))
      .slice(0, 16)
      .map((contract) => contract.symbol));
  }, [state, underlyingPrice]);

  useMarketLease(instanceId, "stocks", valid ? [symbol] : [], host.lifecycle);
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

export function resourceStateFromRead<T>(state: ReadState<T>): "loading" | "ready" | "error" | "unsupported" | "unavailable" {
  switch (state.status) {
    case "loading": return "loading";
    case "ready": return "ready";
    case "error": return "error";
    case "unsupported": return "unsupported";
    case "idle": return "unavailable";
  }
}
