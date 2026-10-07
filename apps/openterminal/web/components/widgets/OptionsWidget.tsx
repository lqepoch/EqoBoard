"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {AgGridReact} from "ag-grid-react";
import {AllCommunityModule,ModuleRegistry,themeQuartz,type CellClickedEvent,type ColDef,type ColGroupDef} from "ag-grid-community";
import {apiGet,fmt} from "../../lib/api";
import {useTerminal,useWidgetSymbol,type WidgetInstance} from "../../store/terminal";
import {useMarket} from "../../store/market";
import type {EqoChain} from "../../lib/eqo-market";

ModuleRegistry.registerModules([AllCommunityModule]);
const theme=themeQuartz.withParams({
  backgroundColor:"#101010",foregroundColor:"#d6dfeb",headerBackgroundColor:"#1b1b1b",
  headerTextColor:"#b7c2d3",accentColor:"#e8a13b",borderColor:"#333333",
  rowHoverColor:"#282828",oddRowBackgroundColor:"#141414",fontSize:11,cellHorizontalPadding:6
});
type Contract=EqoChain["calls"][number];
type Row={strike:number;call:Contract|null;put:Contract|null};
type Side="call"|"put";
type NumericKey="bid"|"ask"|"last"|"iv"|"delta"|"gamma"|"theta"|"vega";
type EventQuote={kind:"option_quote";symbol:string;bid:number|null;ask:number|null;
  bid_size:number|null;ask_size:number|null;timestamp:string};
type MarketEvent=EventQuote|{kind:"feed_status";feed:string;state:string;timestamp:string}
  |{kind:"option_trade";symbol:string;price:number;size:number;timestamp:string};
function currentNYDate(){
  return new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit",
    timeZone:"America/New_York"}).format(new Date());
}
function rowsFromChain(chain:EqoChain|null|undefined):Row[]{
  const byStrike=new Map<number,Row>();
  if(!chain)return [];
  for(const item of [...chain.calls,...chain.puts]){
    if(!Number.isFinite(item.strike))continue;
    const row=byStrike.get(item.strike)??{strike:item.strike,call:null,put:null};
    row[item.right]=item;
    byStrike.set(item.strike,row);
  }
  return [...byStrike.values()].sort((a,b)=>a.strike-b.strike);
}
function metric(side:Side,key:NumericKey,name:string,width=77):ColDef<Row>{
  return {
    headerName:name,colId:side+"."+key,width,minWidth:55,sortable:true,
    valueGetter:p=>{
      const value=p.data?.[side]?.[key];
      return typeof value==="number"?(key==="iv"?value*100:value):null;
    },
    valueFormatter:p=>p.value==null||!Number.isFinite(p.value)?"—":
      fmt(p.value,["delta","gamma","theta","vega"].includes(key)?3:2),
    cellStyle:key==="bid"?{color:"#77d6ad"}:key==="ask"?{color:"#f8a0a0"}:{color:"#c2cfdb"}
  };
}
const columnDefs:Array<ColDef<Row>|ColGroupDef<Row>>=[
  {headerName:"CALL · 看涨",children:[
    metric("call","delta","Delta",74),metric("call","iv","IV %",74),
    metric("call","last","Last",74),metric("call","bid","Bid",75),metric("call","ask","Ask",75)
  ]},
  {headerName:"STRIKE",field:"strike",colId:"strike",width:92,minWidth:74,
    valueFormatter:p=>fmt(p.value,1),cellStyle:{color:"#facc83",fontWeight:700,textAlign:"center"}},
  {headerName:"PUT · 看跌",children:[
    metric("put","bid","Bid",75),metric("put","ask","Ask",75),
    metric("put","last","Last",74),metric("put","iv","IV %",74),metric("put","delta","Delta",74)
  ]}
];

export default function OptionsWidget({widget}:{widget:WidgetInstance}){
  const symbol=useWidgetSymbol(widget);
  const [expiry,setExpiry]=useState(currentNYDate);
  const [subscriptionError,setSubscriptionError]=useState<string|null>(null);
  const [selected,setSelected]=useState<Contract|null>(null);
  const selectOptionLeg=useTerminal(s=>s.selectOptionLeg);
  const consumerId=useRef<string|null>(null);
  const grid=useRef<AgGridReact<Row>>(null);
  const connected=useMarket(s=>s.connected);
  const {data,error,isFetching}=useQuery({
    queryKey:["eqo-opra",symbol,expiry],
    queryFn:()=>apiGet<EqoChain>("/api/options/"+encodeURIComponent(symbol)+"?expiry="+encodeURIComponent(expiry)),
    refetchInterval:15_000,retry:1
  });
  const rows=useMemo(()=>rowsFromChain(data),[data]);
  const index=useMemo(()=>{
    const map=new Map<string,{strike:number;side:Side}>();
    for(const c of [...(data?.calls??[]),...(data?.puts??[])])
      map.set(c.symbol,{strike:c.strike,side:c.right});
    return map;
  },[data]);
  useEffect(()=>{
    if(!data)return;
    if(!consumerId.current)consumerId.current=crypto.randomUUID();
    const id=consumerId.current;
    const contracts=[...data.calls,...data.puts];
    const strikes=contracts.map(c=>c.strike).filter(Number.isFinite).sort((a,b)=>a-b);
    const center=data.underlyingPrice??strikes[Math.floor(strikes.length/2)]??0;
    const symbols=contracts.sort((a,b)=>Math.abs(a.strike-center)-Math.abs(b.strike-center))
      .slice(0,500).map(c=>c.symbol);
    let alive=true;
    async function refresh(next:string[]){
      try{
        const res=await fetch("/api/eqo/options/subscribe",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({consumer_id:id,symbols:next})
        });
        if(!res.ok)throw new Error("OPRA subscription rejected HTTP "+res.status);
        if(alive)setSubscriptionError(null);
      }catch(e){
        if(alive)setSubscriptionError(e instanceof Error?e.message:"subscription failed");
      }
    }
    void refresh(symbols);
    const timer=setInterval(()=>void refresh(symbols),30_000);
    return()=>{alive=false;clearInterval(timer);void refresh([]);};
  },[data]);
  useEffect(()=>{
    return useMarket.subscribe((state,previous)=>{
      if(state.revision===previous.revision)return;
      const api=grid.current?.api;
      if(!api)return;
      const updates=new Map<number,Row>();
      for(const item of state.lastBatch){
        if(item.kind!=="option_quote")continue;
        const found=index.get(item.symbol);
        if(!found)continue;
        const row=updates.get(found.strike)??api.getRowNode(String(found.strike))?.data;
        const contract=row?.[found.side];
        if(!row||!contract)continue;
        updates.set(found.strike,{...row,[found.side]:{
          ...contract,bid:item.bid,ask:item.ask,
          bid_size:item.bid_size,ask_size:item.ask_size,updated_at:item.timestamp
        }});
      }
      if(updates.size)api.applyTransactionAsync({update:[...updates.values()]});
    });
  },[index]);
  function onCellClick(e:CellClickedEvent<Row>){
    const side=e.column.getColId().split(".")[0];
    if((side==="call"||side==="put")&&e.data?.[side]){
      const contract=e.data[side]!;
      setSelected(contract);
      selectOptionLeg({symbol:contract.symbol,strike:contract.strike,right:contract.right});
    }
  }
  return <div className="h-full min-h-0 flex flex-col">
    <div className="flex items-center gap-2 flex-wrap px-2 py-1 border-b border-[#262626] text-[11px]">
      <span className="amber font-semibold">ALPACA OPRA</span>
      <label className="dim">到期日 <input aria-label="Option expiry" type="date" value={expiry}
        onChange={e=>setExpiry(e.target.value)}
        className="bg-[#171717] border border-[#444] px-2 py-1 text-[#ddd]" /></label>
      <span className={connected?"up":"down"}>{connected?"● LIVE":"○ SNAPSHOT"}</span>
      <span className="dim ml-auto">{isFetching?"更新…":data?.asOf?("Snapshot "+data.asOf):"No snapshot"}</span>
    </div>
    {error&&<div role="alert" className="down p-2">OPRA: {(error as Error).message}. Check credentials/entitlement and expiry.</div>}
    {subscriptionError&&<div role="alert" className="down p-2">{subscriptionError}</div>}
    {data?.truncated&&<div className="down p-1">⚠ 期权链分页达到上限；数据不完整。</div>}
    <div className="flex-1 min-h-[230px]" style={{width:"100%"}}>
      <AgGridReact<Row> ref={grid} theme={theme} columnDefs={columnDefs} rowData={rows}
        getRowId={p=>String(p.data.strike)}
        rowHeight={31} headerHeight={29} groupHeaderHeight={28}
        defaultColDef={{sortable:true,resizable:true,filter:false}} animateRows={false}
        onCellClicked={onCellClick}
        overlayNoRowsTemplate='<span style="color:#999">当前到期日无 OPRA 快照，请更换日期</span>'
      />
    </div>
    <div className="flex items-center justify-between px-2 py-1 border-t border-[#282828] text-[10px] dim">
      <span>{rows.length} strikes · {data?.source??"OPRA"} · missing Greeks stay empty</span>
      <span>{selected?selected.symbol+" · IV "+(selected.iv==null?"—":fmt(selected.iv*100,2)+"%"):"点击 CALL/PUT 单元格查看合约"}</span>
    </div>
    {selected&&<div className="flex gap-3 px-2 py-1 text-[10px] dim flex-wrap">
      <span>Bid {fmt(selected.bid)}</span><span>Ask {fmt(selected.ask)}</span>
      <span>Δ {fmt(selected.delta,3)}</span><span>Γ {fmt(selected.gamma,3)}</span>
      <span>Θ {fmt(selected.theta,3)}</span><span>Vega {fmt(selected.vega,3)}</span>
      <span>{selected.updated_at??"quote time unavailable"}</span>
    </div>}
  </div>;
}
