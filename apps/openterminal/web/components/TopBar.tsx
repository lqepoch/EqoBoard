"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
import { useTerminal } from "../store/terminal";
import { useMarket } from "../store/market";

type Status = {
  stockFeed?: string;
  optionFeed?: string;
  executionMode?: string;
};

function Clock({ tz, label, now }: { tz: string; label: string; now: Date | null }) {
  if (!now) return null;
  return (
    <span className="dim">
      {label}{" "}
      <span className="text-[var(--text)]">
        {now.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false })}
      </span>
    </span>
  );
}

function regularHoursEstimate(now: Date | null): "within" | "outside" | "unknown" {
  if (!now) return "unknown";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const weekday = value("weekday");
  const weekdayHours = weekday !== undefined && ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  return weekdayHours && minutes >= 9 * 60 + 30 && minutes < 16 * 60 ? "within" : "outside";
}

export default function TopBar() {
  const setCommandOpen = useTerminal((s) => s.setCommandOpen);
  const activeSymbol = useTerminal((s) => s.activeSymbol);
  const marketClockMs = useMarket((s) => s.marketClockMs);
  const stockFeedStatus = useMarket((s) => s.feedStatus.stocks);
  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<Status>("/api/status"),
    refetchInterval: 30_000,
  });

  const now = marketClockMs > 0 ? new Date(marketClockMs) : null;
  const session = stockFeedStatus?.market_session ?? "unknown";
  const sessionLabel = session === "unknown"
    ? "Trading day/session: unknown"
    : `Market session: ${session} (Gateway status)`;
  const regularHours = regularHoursEstimate(now);
  const configuredFeeds = status
    ? `${status.stockFeed?.toUpperCase() ?? "unknown"} / ${status.optionFeed?.toUpperCase() ?? "unknown"}`
    : "unknown";

  return (
    <header className="flex items-center gap-4 px-3 h-8 bg-[var(--panel-2)] border-b border-[var(--border)] text-[11px] shrink-0">
      <span className="amber font-bold tracking-widest">EqoBoard / OpenTerminal</span>
      <span className="dim" data-testid="market-session-status" title="Weekday hours are an estimate; no holiday or early-close calendar is inferred">
        {sessionLabel} · 09:30–16:00 ET weekday-hours estimate: {regularHours}
      </span>
      <Clock tz="America/New_York" label="NY" now={now} />
      <Clock tz="Europe/Rome" label="MIL" now={now} />
      <Clock tz="Europe/London" label="LDN" now={now} />
      <Clock tz="Asia/Tokyo" label="TYO" now={now} />
      <button
        className="term-btn flex-1 max-w-md text-left dim"
        onClick={() => setCommandOpen(true)}
      >
        {activeSymbol} — search symbol… <span className="float-right">⌘K</span>
      </button>
      <span className="dim ml-auto" data-testid="configured-market-feeds"
        title="Configured feeds do not establish credentials or account entitlements">
        Configured feeds: {configuredFeeds} · entitlement unverified
      </span>
      <span className="dim">Execution: {status?.executionMode ?? "disabled"}</span>
    </header>
  );
}
