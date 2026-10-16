"use client";

import { useMarketDataSnapshot } from "@/features/data/MarketDataHost";
import type { MarketHostSnapshot, MarketTransportState } from "@/stores/market/market-store";

const TRANSPORT_LABELS: Readonly<Record<MarketTransportState, string>> = Object.freeze({
  idle: "Idle",
  connecting: "Connecting",
  connected: "Live",
  reconnecting: "Reconnecting",
  unavailable: "Unavailable",
});

type StatusTone = "positive" | "warning" | "negative" | "neutral";

function statusTone(snapshot: MarketHostSnapshot): StatusTone {
  if (snapshot.transportState === "connected") {
    return snapshot.feeds.stocks.freshness === "fresh" ? "positive" : "warning";
  }
  if (snapshot.transportState === "reconnecting" || snapshot.transportState === "unavailable") {
    return "negative";
  }
  return "neutral";
}

function stockSourceLabel(snapshot: MarketHostSnapshot): string {
  const label = snapshot.feeds.stocks.rawStatus?.source_label;
  return typeof label === "string" && label.length > 0 && label.length <= 64
    ? label
    : "stocks source unknown";
}

/** Header readout of the shared stock stream; it reports transport and source, never data quality. */
export function MarketStatusPill() {
  const snapshot = useMarketDataSnapshot();
  const label = TRANSPORT_LABELS[snapshot.transportState];
  const freshness = snapshot.feeds.stocks.freshness;

  return (
    <div
      className="eq-market-status"
      data-testid="market-status"
      data-tone={statusTone(snapshot)}
      title={`Stock stream ${label.toLowerCase()}; freshness ${freshness}`}
    >
      <span aria-hidden="true" className="eq-market-status__dot" />
      <span className="eq-market-status__label">{label}</span>
      <span className="eq-market-status__source">{stockSourceLabel(snapshot)}</span>
    </div>
  );
}
