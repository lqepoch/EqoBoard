export type GatewaySourceMode = "alpaca" | "offline_mock";
export type MarketSourceMode = GatewaySourceMode | "unknown";
export type MarketSourceFields = {
  source_mode?: unknown;
  source_label?: unknown;
  source_entitlement?: "unknown" | "authorized" | "unauthorized";
};

export const OFFLINE_MARKET_SOURCE_LABEL = "OFFLINE MOCK — NOT MARKET DATA";

/**
 * Render a source label only when the Gateway mode and label form a recognized
 * pair. Feed names describe the protocol and never prove the data source.
 */
export function resolveMarketSource(
  source: MarketSourceFields | null | undefined,
  feed: "sip" | "opra",
): { mode: MarketSourceMode; label: string } {
  if (source?.source_mode === "offline_mock" && source.source_label === OFFLINE_MARKET_SOURCE_LABEL) {
    return { mode: "offline_mock", label: OFFLINE_MARKET_SOURCE_LABEL };
  }
  const expectedLabel = feed === "sip" ? "Alpaca SIP" : "Alpaca OPRA";
  if (source?.source_mode === "alpaca" && source.source_label === expectedLabel) {
    return { mode: "alpaca", label: expectedLabel };
  }
  return { mode: "unknown", label: "source unknown" };
}
