"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiGet, fmt, fmtBig, pctClass, type Quote } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import { marketCondition, statusText, useMarket } from "../../store/market";
import Flash from "../Flash";
import MarketFeedStatus from "./MarketFeedStatus";

type ShortVolume = { date: string; shortVolume: number; shortExemptVolume: number; totalVolume: number; shortVolumePercent: number };

export default function QuoteWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const { data, error } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${encodeURIComponent(symbol)}`))[0],
    refetchInterval: 15_000,
  });
  const liveTrade = useMarket((s) => s.stockTrades[symbol]);
  const liveQuote = useMarket((s) => s.stockQuotes[symbol]);
  const latestSnapshot = useMarket((s) => s.stockSnapshots[symbol]);
  const setSnapshotWatermark = useMarket((s) => s.setSnapshotWatermark);
  const setStockSnapshot = useMarket((s) => s.setStockSnapshot);
  const lastAsOf=latestSnapshot?.lastAsOf??(latestSnapshot?null:data?.lastAsOf??null);
  const quoteAsOf=latestSnapshot?.quoteAt??(latestSnapshot?null:data?.quoteAt??null);
  const tradeCondition = useMarket((s) => marketCondition(s, "stocks", symbol, "trade", lastAsOf ?? undefined));
  const quoteCondition = useMarket((s) => marketCondition(s, "stocks", symbol, "quote", quoteAsOf ?? undefined));
  useEffect(() => {
    if (!data) return;
    for (const watermark of data.watermarks ?? []) {
      if (watermark.feed === "stocks") setSnapshotWatermark(watermark);
    }
    setStockSnapshot(data);
  }, [data, setStockSnapshot, setSnapshotWatermark]);
  // FINRA's Reg SHO file only updates once a day (next-morning), so no point polling it fast.
  const { data: shortVol } = useQuery({
    queryKey: ["short-volume", symbol],
    queryFn: () => apiGet<ShortVolume | null>(`/api/short-volume/${encodeURIComponent(symbol)}`),
    staleTime: 3_600_000,
  });

  if (error) return <div className="p-2 down" data-testid="market-data-error">Error: {(error as Error).message}</div>;
  if (!data) return <div className="p-2 dim">Loading {symbol}…</div>;

  const quote=latestSnapshot??data;
  const liveTradeReady = tradeCondition === "fresh" && liveTrade?.event_time != null;
  const liveQuoteReady = quoteCondition === "fresh" && liveQuote?.event_time != null;
  const price = liveTradeReady ? liveTrade!.price : quote.price;
  const change = price !== null && quote.previousClose !== null ? price - quote.previousClose : quote.change;
  const changePercent = change !== null && quote.previousClose
    ? (change / quote.previousClose) * 100 : quote.changePercent;
  const bid = liveQuoteReady ? liveQuote!.bid : quote.bid;
  const ask = liveQuoteReady ? liveQuote!.ask : quote.ask;
  const asOf = liveTradeReady ? liveTrade!.event_time : liveQuoteReady ? liveQuote!.event_time : quote.lastAsOf ?? null;

  const rows: Array<[string, string, string?]> = [
    ["Open", fmt(quote.open)],
    ["High", fmt(quote.high)],
    ["Low", fmt(quote.low)],
    ["Prev Close", fmt(quote.previousClose)],
    ["Bid", fmt(bid)],
    ["Ask", fmt(ask)],
    ["Volume", fmtBig(quote.volume)],
    ["Avg Vol 3M", fmtBig(quote.avgVolume)],
    ...(shortVol ? ([[`FINRA Short Vol % · ${shortVol.date}`, fmt(shortVol.shortVolumePercent, 1) + "%"]] as Array<[string, string]>) : []),
    ["Mkt Cap", fmt(quote.marketCap)],
    ["P/E (ttm)", fmt(quote.pe)],
    ["EPS (ttm)", fmt(quote.eps)],
    ["Div Yield", quote.dividendYield !== null ? fmt(quote.dividendYield * 100) + "%" : "—"],
    ["52W High", fmt(quote.week52High)],
    ["52W Low", fmt(quote.week52Low)],
    ["Beta", fmt(quote.beta)],
    ["Shares Out", fmtBig(quote.sharesOutstanding)],
  ];

  return (
    <div className="p-2">
      <div className="flex items-baseline gap-3 mb-1">
        <Flash value={price} className="text-xl font-bold">{fmt(price)}</Flash>
        <Flash value={changePercent} className={`${pctClass(changePercent)} text-sm`}>
          {change !== null && change >= 0 ? "+" : ""}
          {fmt(change)} ({fmt(changePercent)}%)
        </Flash>
        <span className="dim text-[10px] ml-auto">
          {quote.exchange ?? ""} · {quote.currency ?? ""} · {quote.source} · {asOf ?? "—"}
        </span>
      </div>
      <div className={`text-[9px] mb-1 ${tradeCondition === "fresh" ? "up" : "dim"}`}>
        PRICE {statusText(tradeCondition)} · {liveTradeReady ? "stream event time" : "REST snapshot"}
      </div>
      <MarketFeedStatus feed="stocks" />
      {quote.source === "Alpaca SIP" && <div className="dim text-[9px] mb-1">
        SIP field times · last ({quote.lastBasis ?? "basis unknown"}): {asOf ?? "unknown"}
        · quote: {quote.quoteAt ?? "unknown"} · trade: {quote.tradeAt ?? "unknown"}
        · daily bar: {quote.dailyBarAt ?? "unknown"} · prior daily bar: {quote.previousDailyBarAt ?? "unknown"}
      </div>}
      <div className="dim text-[11px] mb-2 truncate">{quote.name}</div>
      <div className="grid grid-cols-2 gap-x-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between border-b border-[#161616] py-0.5">
            <span className="dim">{label}</span>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
