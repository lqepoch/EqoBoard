"use client";

import { useMarket, type FeedName } from "../../store/market";

const channelNames = ["quotes", "trades"] as const;

export default function MarketFeedStatus({ feed }: { feed: FeedName }) {
  const browserConnected = useMarket((state) => state.browserConnected);
  const status = useMarket((state) => state.feedStatus[feed]);
  const label = feed === "stocks" ? "SIP" : "OPRA";

  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 dim text-[9px]" data-testid={`market-feed-status-${feed}`}>
      <span className={browserConnected ? "up" : "down"}>
        {browserConnected ? "Browser SSE connected" : "Browser SSE disconnected"}
      </span>
      <span>{label} auth {status?.auth ?? "unknown"}</span>
      <span>{label} transport {status?.transport ?? "unknown"}</span>
      <span>{label} upstream {status?.upstream ?? "unknown"}</span>
      {channelNames.map((channel) => {
        const desired = status?.desired[channel] ?? [];
        const confirmed = status?.confirmed?.[channel] ?? [];
        const pending = status?.pending.subscribe[channel] ?? [];
        const removing = status?.pending.unsubscribe[channel] ?? [];
        return <span key={channel}>
          {channel} ACK {confirmed.length}/{desired.length}
          {pending.length > 0 ? ` · ${pending.length} subscribe pending` : ""}
          {removing.length > 0 ? ` · ${removing.length} unsubscribe pending` : ""}
        </span>;
      })}
      <span>
        coverage {status?.coverage.confirmed_count ?? 0}/{status?.coverage.desired_count ?? 0}
        {status ? status.coverage.complete ? " complete" : " partial" : " unknown"}
      </span>
      {status?.last_error && <span className="down" title={status.last_error.message ?? status.last_error.class}>
        {status.last_error.code ? `HTTP ${status.last_error.code} · ` : ""}{status.last_error.class}
      </span>}
      {status && status.decode_error_count > 0 && <span className="down">decode errors {status.decode_error_count}</span>}
    </div>
  );
}
