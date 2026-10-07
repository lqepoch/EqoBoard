"use client";

import {useEffect,useState} from "react";
import {fmt} from "../../lib/api";
import {useWidgetSymbol,type WidgetInstance} from "../../store/terminal";

type Trade={kind:"option_trade";symbol:string;price:number;size:number;timestamp:string};
function occRoot(symbol:string){return symbol.length>15?symbol.slice(0,-15):"";}
function et(ts:string){
  const d=new Date(ts);
  return Number.isFinite(d.getTime())?d.toLocaleTimeString("en-US",{
    timeZone:"America/New_York",hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"
  }):"—";
}
export default function OptionTapeWidget({widget}:{widget:WidgetInstance}){
  const symbol=useWidgetSymbol(widget);
  const [trades,setTrades]=useState<Trade[]>([]);
  const [connected,setConnected]=useState(false);
  useEffect(()=>{
    setTrades([]);
    const source=new EventSource("/api/eqo/live");
    source.onopen=()=>setConnected(true);
    source.onerror=()=>setConnected(false);
    source.onmessage=e=>{
      let batch:unknown;
      try{batch=JSON.parse(e.data);}catch{return;}
      if(!Array.isArray(batch))return;
      const incoming=batch.filter((x):x is Trade=>
        Boolean(x)&&typeof x==="object"&&(x as {kind?:string}).kind==="option_trade"&&
        occRoot((x as Trade).symbol)===symbol);
      if(incoming.length)setTrades(old=>[...incoming.reverse(),...old].slice(0,150));
    };
    return()=>source.close();
  },[symbol]);
  return <div className="h-full min-h-0 flex flex-col">
    <div className="flex justify-between px-2 py-1 border-b border-[#262626] text-[10px]">
      <span className="amber">OPRA TRADE TAPE · {symbol}</span>
      <span className={connected?"up":"down"}>{connected?"● LIVE":"○ OFFLINE"}</span>
    </div>
    <div className="grid grid-cols-[62px_1fr_58px_48px] gap-1 px-2 py-1 dim text-[9px] border-b border-[#222]">
      <span>ET</span><span>CONTRACT</span><span className="text-right">PRICE</span><span className="text-right">SIZE</span>
    </div>
    <div className="flex-1 overflow-auto min-h-0">
      {trades.map((t,i)=><div key={t.timestamp+t.symbol+i}
        className="grid grid-cols-[62px_1fr_58px_48px] gap-1 px-2 py-1 border-b border-[#191919] text-[10px] font-mono">
        <span className="dim">{et(t.timestamp)}</span>
        <span className="truncate" title={t.symbol}>{t.symbol}</span>
        <span className="text-right amber">{fmt(t.price)}</span>
        <span className="text-right">{fmt(t.size,0)}</span>
      </div>)}
      {!trades.length&&<div className="dim p-3">等待当前 Option Chain 已订阅合约的真实 OPRA trades。</div>}
    </div>
    <div className="dim text-[9px] px-2 py-1 border-t border-[#222]">
      不推断主动买/卖方向；仅展示原始 TradeEvent。
    </div>
  </div>;
}
