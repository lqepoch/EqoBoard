"use client";

import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {
  CartesianGrid,Legend,Line,LineChart,ResponsiveContainer,Tooltip,XAxis,YAxis
} from "recharts";
import {apiGet} from "../../lib/api";
import type {EqoChain} from "../../lib/eqo-market";
import {useWidgetSymbol,type WidgetInstance} from "../../store/terminal";

function nyDate(){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",
    year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
}

export default function IvSkewWidget({widget}:{widget:WidgetInstance}){
  const symbol=useWidgetSymbol(widget);
  const [expiry,setExpiry]=useState(nyDate);
  const {data,error,isFetching}=useQuery({
    queryKey:["eqo-iv-skew",symbol,expiry],
    queryFn:()=>apiGet<EqoChain>("/api/options/"+encodeURIComponent(symbol)+"?expiry="+encodeURIComponent(expiry)),
    refetchInterval:30_000,retry:1
  });
  const map=new Map<number,{strike:number;callIV?:number;putIV?:number}>();
  for(const c of [...(data?.calls??[]),...(data?.puts??[])]){
    if(c.iv==null||!Number.isFinite(c.iv)||!Number.isFinite(c.strike))continue;
    const row=map.get(c.strike)??{strike:c.strike};
    if(c.right==="call")row.callIV=c.iv*100;else row.putIV=c.iv*100;
    map.set(c.strike,row);
  }
  const rows=[...map.values()].sort((a,b)=>a.strike-b.strike);
  return <div className="h-full flex flex-col min-h-0">
    <div className="flex items-center gap-2 px-2 py-1 text-[11px] border-b border-[#262626]">
      <span className="amber">ALPACA OPRA IV</span>
      <input aria-label="IV expiry" type="date" value={expiry}
        onChange={e=>setExpiry(e.target.value)}
        className="bg-[#171717] border border-[#444] px-2 py-1 text-[#ddd]" />
      <span className="dim ml-auto">{isFetching?"更新…":data?.asOf??"—"}</span>
    </div>
    {error&&<div className="down p-2">{(error as Error).message}</div>}
    <div className="flex-1 min-h-[180px] p-1">
      {rows.length?<ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{top:8,right:16,bottom:8,left:0}}>
          <CartesianGrid stroke="#242424" strokeDasharray="3 3"/>
          <XAxis dataKey="strike" stroke="#777" tick={{fontSize:10}} type="number" domain={["dataMin","dataMax"]}/>
          <YAxis stroke="#777" tick={{fontSize:10}} unit="%"/>
          <Tooltip contentStyle={{background:"#111",border:"1px solid #444",fontSize:11}}/>
          <Legend wrapperStyle={{fontSize:10}}/>
          <Line type="monotone" dataKey="callIV" name="Call IV" dot={false} stroke="#45d6a8" strokeWidth={1.5}/>
          <Line type="monotone" dataKey="putIV" name="Put IV" dot={false} stroke="#8aa8ff" strokeWidth={1.5}/>
        </LineChart>
      </ResponsiveContainer>:<div className="dim p-3">当前日期无可用 IV 快照。</div>}
    </div>
    <div className="dim text-[10px] px-2 py-1 border-t border-[#262626]">
      单到期日 Skew；IV 来自 Alpaca 快照，合约时间可能不同步，空值保留为空。
    </div>
  </div>;
}
