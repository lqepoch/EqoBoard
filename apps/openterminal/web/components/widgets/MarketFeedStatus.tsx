"use client";

import { useMarket, type FeedName } from "../../store/market";
import { resolveMarketSource } from "../../../server/src/providers/market-source.ts";

const channelNames = ["quotes", "trades"] as const;

export default function MarketFeedStatus({ feed }: { feed: FeedName }) {
  const browserConnected = useMarket((state) => state.browserConnected);
  const status = useMarket((state) => state.feedStatus[feed]);
  const label = feed === "stocks" ? "SIP" : "OPRA";
  const source = resolveMarketSource(status, feed === "stocks" ? "sip" : "opra");
  const configuredLimit = status?.coverage.limit;
  const effectiveLimit = typeof configuredLimit === "number" &&
    Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : "unknown";

  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 dim text-[9px]" data-testid={`market-feed-status-${feed}`}>
      <span className={browserConnected ? "up" : "down"}>
        {browserConnected ? "Browser SSE connected" : "Browser SSE disconnected"}
      </span>
      <span>{label} auth {status?.auth ?? "unknown"}</span>
      <span>{label} transport {status?.transport ?? "unknown"}</span>
      <span>{label} upstream {status?.upstream ?? "unknown"}</span>
      <span>{label} source entitlement {status?.source_entitlement ?? "unknown"}</span>
      <span data-testid={`market-source-${feed}`} data-source-mode={source.mode}>
        data source {source.label}
      </span>
      {channelNames.map((channel) => {
        const desired = status?.desired[channel];
        const confirmed = status?.confirmed?.[channel] ?? null;
        const pending = status?.pending.subscribe[channel] ?? [];
        const removing = status?.pending.unsubscribe[channel] ?? [];
        const acknowledgement = !status || confirmed === null
          ? `ACK unknown${desired ? `/${desired.length} desired` : " · desired unknown"}`
          : `ACK ${confirmed.length}/${desired?.length ?? "unknown"}`;
        return <span key={channel}>
          {channel} {acknowledgement}
          {pending.length > 0 ? ` · ${pending.length} subscribe pending` : ""}
          {removing.length > 0 ? ` · ${removing.length} unsubscribe pending` : ""}
        </span>;
      })}
      <span>{!status || status.confirmed === null
        ? `coverage unknown${status ? `/${status.coverage.desired_count} desired` : ""}`
        : `coverage ${status.coverage.confirmed_count}/${status.coverage.desired_count}${status.coverage.complete ? " complete" : " partial"}`}</span>
      {feed === "options" && <span>
        Gateway effective limit {effectiveLimit}
      </span>}
      {status?.last_error && <span className="down" title={status.last_error.message ?? status.last_error.class}>
        {status.last_error.code ? `HTTP ${status.last_error.code} · ` : ""}{status.last_error.class}
      </span>}
      {status && status.decode_error_count > 0 && <span className="down">decode errors {status.decode_error_count}</span>}
    </div>
  );
}
