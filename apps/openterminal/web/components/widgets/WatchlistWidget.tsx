"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, fmt, fmtBig, pctClass, type Quote } from "../../lib/api";
import { normalizeSymbol, symbolsParam } from "../../lib/symbol";
import { useTerminal } from "../../store/terminal";
import { marketCondition, statusText, useMarket } from "../../store/market";
import Flash from "../Flash";
import MarketFeedStatus from "./MarketFeedStatus";

function LiveRow({sym,snapshot,onSelect,onRemove}:{sym:string;snapshot:Quote|undefined;onSelect:()=>void;onRemove:()=>void}) {
  const trade=useMarket(s=>s.stockTrades[sym]);
  const latest=useMarket(s=>s.stockSnapshots[sym]);
  const feedStatus=useMarket(s=>s.feedStatus.stocks);
  const current=latest??snapshot;
  const condition=useMarket(s=>marketCondition(s,"stocks",sym,"trade",current?.lastAsOf??undefined));
  const price=condition==="fresh"&&trade?.event_time?trade.price:current?.price??null;
  const previous=current?.previousClose??null;
  const changePercent=price!==null&&previous?((price/previous)-1)*100:current?.changePercent??null;
  return <tr onClick={onSelect}>
    <td className="font-bold">{sym}</td>
    <td><Flash value={price}>{fmt(price)}</Flash></td>
    <td className={pctClass(changePercent)}>
      <Flash value={changePercent}>{fmt(changePercent)}%</Flash>
    </td>
    <td>{fmtBig(current?.volume)}</td>
    <td className="dim text-[9px]" title={`${current?.source??"source unknown"} · ${current?.asOf??"as-of unknown"}`}>
      {statusText(condition,feedStatus,"sip")}
    </td>
    <td>
      <button onClick={e=>{e.stopPropagation();onRemove();}} className="dim hover:text-[var(--down)]">✕</button>
    </td>
  </tr>;
}

export default function WatchlistWidget() {
  const watchlist = useTerminal((s) => s.watchlist);
  const addToWatchlist = useTerminal((s) => s.addToWatchlist);
  const removeFromWatchlist = useTerminal((s) => s.removeFromWatchlist);
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);

  const { data: responseData = [], error } = useQuery({
    queryKey: ["watchlist", watchlist.join(",")],
    queryFn: async () => {
      const requestGeneration = useMarket.getState().gatewayInstanceGeneration;
      const rows = await apiGet<Quote[]>(`/api/quotes?symbols=${symbolsParam(watchlist)}`);
      return rows.map((row) => {
        const instanceId = row.gateway_instance_id ?? row.watermarks?.[0]?.gateway_instance_id ?? row.watermark?.gateway_instance_id;
        if (!useMarket.getState().acceptsSnapshotInstance(instanceId, requestGeneration)) {
          throw new Error("Discarded snapshot from a retired Gateway instance");
        }
        return { ...row, clientGatewayInstanceGeneration: requestGeneration };
      });
    },
    enabled: watchlist.length > 0,
    refetchInterval: 15_000,
  });
  const gatewayInstanceId=useMarket(s=>s.gatewayInstanceId);
  const data=responseData.filter(row=>!gatewayInstanceId||
    (row.gateway_instance_id?row.gateway_instance_id===gatewayInstanceId:
      row.source_mode!=="alpaca"&&row.source_mode!=="offline_mock"));
  const setSnapshotWatermark=useMarket(s=>s.setSnapshotWatermark);
  const setStockSnapshot=useMarket(s=>s.setStockSnapshot);
  useEffect(()=>{
    for(const row of data){
      for(const watermark of row.watermarks??[]){
        if(watermark.feed==="stocks")setSnapshotWatermark(watermark,row.received_at,row.clientGatewayInstanceGeneration);
      }
      setStockSnapshot(row,row.clientGatewayInstanceGeneration);
    }
  },[data,setSnapshotWatermark,setStockSnapshot]);

  return (
    <div>
      <form
        className="flex gap-1 p-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          const sym = normalizeSymbol(input);
          if (!sym) {
            setInvalid(true);
            return;
          }
          addToWatchlist(sym);
          setInput("");
        }}
      >
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setInvalid(false);
          }}
          placeholder="Add ticker…"
          title={invalid ? "Not a valid ticker symbol" : undefined}
          aria-invalid={invalid}
          className={`flex-1 ${invalid ? "!border-[var(--down)]" : ""}`}
        />
        <button className="term-btn" type="submit">+</button>
      </form>
      <div className="px-2 pb-1">
        <MarketFeedStatus feed="stocks" />
      </div>
      {error&&<div role="alert" className="p-1 down text-[10px]">SIP snapshot unavailable: {(error as Error).message}. Last snapshot remains timestamped; it is not marked live.</div>}
      <table className="data-table">
        <thead>
          <tr><th>Sym</th><th>Last</th><th>Chg%</th><th>Vol</th><th>Mode</th><th></th></tr>
        </thead>
        <tbody>
          {watchlist.map((sym) => (
            <LiveRow key={sym} sym={sym} snapshot={data.find(d=>d.symbol===sym)}
              onSelect={()=>setActiveSymbol(sym)}
              onRemove={()=>removeFromWatchlist(sym)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
