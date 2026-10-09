"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {AgGridReact} from "ag-grid-react";
import {AllCommunityModule,ModuleRegistry,themeQuartz,type CellClickedEvent,type ColDef,type ColGroupDef} from "ag-grid-community";
import {apiGet,fmt} from "../../lib/api";
import {useTerminal,useWidgetSymbol,type WidgetInstance} from "../../store/terminal";
import {compareRfc3339Nanos,marketCondition,marketStatusTone,statusText,useMarket,type OptionSnapshot} from "../../store/market";
import type {EqoChain} from "../../lib/eqo-market";
import MarketFeedStatus from "./MarketFeedStatus";

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
function currentNYDate(){
  return new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit",
    timeZone:"America/New_York"}).format(new Date());
}
function rowsFromChain(
  chain:EqoChain|null|undefined,
  snapshots:Record<string,OptionSnapshot>,
  state:ReturnType<typeof useMarket.getState>,
):Row[]{
  const byStrike=new Map<number,Row>();
  if(!chain)return [];
  for(const original of [...chain.calls,...chain.puts]){
    const latest=snapshots[original.symbol];
    let item=latest?.quote_at&&(!original.quote_at||
      compareRfc3339Nanos(latest.quote_at,original.quote_at)===1)?latest:original;
    const live=state.optionQuotes[original.symbol];
    if(live&&live.event_time&&marketCondition(state,"options",original.symbol,"quote",item.quote_at??null)==="fresh"){
      item={...item,bid:live.bid,ask:live.ask,bid_size:live.bid_size,ask_size:live.ask_size,quote_at:live.event_time};
    }
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
  const generation=useRef(0);
  const grid=useRef<AgGridReact<Row>>(null);
  const browserConnected=useMarket(s=>s.browserConnected);
  const feedStatus=useMarket(s=>s.feedStatus.options);
  const subscriptionLimit=useMarket(s=>s.optionSubscriptionLimit);
  const optionSnapshots=useMarket(s=>s.optionSnapshots);
  const setSnapshotWatermark=useMarket(s=>s.setSnapshotWatermark);
  const setOptionSnapshot=useMarket(s=>s.setOptionSnapshot);
  const {data:responseData,error,isFetching}=useQuery({
    queryKey:["eqo-opra",symbol,expiry],
    queryFn:async()=>{
      const requestGeneration=useMarket.getState().gatewayInstanceGeneration;
      const chain=await apiGet<EqoChain>("/api/options/"+encodeURIComponent(symbol)+"?expiry="+encodeURIComponent(expiry));
      if(!useMarket.getState().acceptsSnapshotInstance(chain.gateway_instance_id,requestGeneration))
        throw new Error("Discarded snapshot from a retired Gateway instance");
      return {...chain,clientGatewayInstanceGeneration:requestGeneration};
    },
    refetchInterval:15_000,retry:1
  });
  const gatewayInstanceId=useMarket(s=>s.gatewayInstanceId);
  const gatewayInstanceGeneration=useMarket(s=>s.gatewayInstanceGeneration);
  const data=responseData&&responseData.clientGatewayInstanceGeneration===gatewayInstanceGeneration&&
    (!gatewayInstanceId||responseData.gateway_instance_id===gatewayInstanceId||
    (responseData.source_mode!=="alpaca"&&responseData.source_mode!=="offline_mock"))?responseData:undefined;
  const hasUsableSubscriptionLimit=typeof subscriptionLimit==="number"&&
    Number.isSafeInteger(subscriptionLimit)&&subscriptionLimit>0;
  const subscriptionSymbols=useMemo(()=>{
    const contracts=[...(data?.calls??[]),...(data?.puts??[])];
    const uniqueContracts=new Map<string,Contract>();
    for(const contract of contracts){
      if(!uniqueContracts.has(contract.symbol))uniqueContracts.set(contract.symbol,contract);
    }
    const unique=[...uniqueContracts.values()];
    if(typeof subscriptionLimit!=="number"||!Number.isSafeInteger(subscriptionLimit)||subscriptionLimit<=0)return [];
    const center=data?.underlyingPrice;
    const ordered=center===null||center===undefined?unique:
      [...unique].sort((a,b)=>Math.abs(a.strike-center)-Math.abs(b.strike-center));
    return ordered.slice(0,subscriptionLimit).map(c=>c.symbol);
  },[data?.calls,data?.puts,data?.underlyingPrice,subscriptionLimit]);
  const membershipKey=subscriptionSymbols.join(",");
  const firstContract=subscriptionSymbols[0]??"";
  const firstSnapshotAsOf=useMarket(s=>firstContract?s.optionSnapshots[firstContract]?.quote_at??
    [...(data?.calls??[]),...(data?.puts??[])].find(c=>c.symbol===firstContract)?.quote_at??undefined:undefined);
  const snapshotContractCount=useMemo(()=>new Set(
    [...(data?.calls??[]),...(data?.puts??[])].map(contract=>contract.symbol)
  ).size,[data]);
  const subscriptionCoverageText=(()=>{
    if(snapshotContractCount===0)return "OPRA lease not requested: no REST contracts";
    if(!hasUsableSubscriptionLimit)
      return `OPRA lease not requested: Gateway effective limit unknown; all ${snapshotContractCount} REST-returned contracts remain in the table`;
    const selectionNote=data?.underlyingPrice==null
      ? "Gateway order; underlying unavailable"
      : "nearest underlying first";
    const selection=subscriptionSymbols.length<snapshotContractCount?` (${selectionNote})`:"";
    return `OPRA lease request: ${subscriptionSymbols.length}/${snapshotContractCount} unique chain contracts`+
      `${selection}; REST-returned contracts remain in the table`;
  })();
  const modelMetadata=useMemo(()=>{
    const contracts=[...(data?.calls??[]),...(data?.puts??[])];
    const first=contracts.find(contract=>contract.greeksSource)||null;
    const modelAsOf=contracts.reduce<string|null>((latest,contract)=>{
      const candidate=contract.model_as_of;
      if(!candidate)return latest;
      return !latest||compareRfc3339Nanos(candidate,latest)===1?candidate:latest;
    },null);
    return {source:first?.greeksSource??"option model source unknown",asOf:modelAsOf};
  },[data?.calls,data?.puts]);
  const quoteCondition=useMarket(s=>firstContract?
    marketCondition(s,"options",firstContract,"quote",firstSnapshotAsOf):"status-unknown");
  const rows=useMemo(()=>rowsFromChain(data,optionSnapshots,useMarket.getState()),
    [data,optionSnapshots,browserConnected,quoteCondition]);
  const index=useMemo(()=>{
    const map=new Map<string,{strike:number;side:Side}>();
    for(const c of [...(data?.calls??[]),...(data?.puts??[])])
      map.set(c.symbol,{strike:c.strike,side:c.right});
    return map;
  },[data]);
  const chainContracts=useMemo(()=>new Map(
    [...(data?.calls??[]),...(data?.puts??[])].map(contract=>[contract.symbol,contract])
  ),[data]);
  useEffect(()=>{
    if(!data)return;
    for(const watermark of data.watermarks){
      if(watermark.feed==="options")setSnapshotWatermark(watermark,data.received_at,data.clientGatewayInstanceGeneration);
    }
    const quoteWatermark=data.watermarks.find(w=>w.feed==="options"&&w.event_types.length===1&&w.event_types[0]==="quote");
    for(const contract of [...data.calls,...data.puts])setOptionSnapshot(contract,
      quoteWatermark?.symbols.includes(contract.symbol)?quoteWatermark:null,
      data.received_at,data.clientGatewayInstanceGeneration);
  },[data,setOptionSnapshot,setSnapshotWatermark]);
  useEffect(()=>{
    // The first chain request has no membership yet. Do not create an empty
    // lease that its later cleanup could race against the first real lease.
    if(subscriptionSymbols.length===0)return;
    if(!consumerId.current)consumerId.current=crypto.randomUUID();
    const id=consumerId.current;
    const leaseGeneration=++generation.current;
    let alive=true;
    async function refresh(next:string[],generationValue:number){
      try{
        const res=await fetch("/api/eqo/options/subscribe",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({consumer_id:id,generation:generationValue,symbols:next})
        });
        if(!res.ok)throw new Error("OPRA subscription rejected HTTP "+res.status);
        if(alive)setSubscriptionError(null);
      }catch(e){
        if(alive)setSubscriptionError(e instanceof Error?e.message:"subscription failed");
      }
    }
    void refresh(subscriptionSymbols,leaseGeneration);
    const timer=setInterval(()=>void refresh(subscriptionSymbols,leaseGeneration),30_000);
    return()=>{
      alive=false;clearInterval(timer);
      const cleanupGeneration=++generation.current;
      void refresh([],cleanupGeneration);
    };
  },[symbol,expiry,membershipKey]);
  useEffect(()=>{
    return useMarket.subscribe((state,previous)=>{
      const clockAdvanced=state.marketClockMs!==previous.marketClockMs;
      const statusChanged=state.lastBatch.some(event=>event.kind==="feed_status");
      if(state.revision===previous.revision&&!clockAdvanced)return;
      const api=grid.current?.api;
      if(!api)return;
      const updates=new Map<number,Row>();
      if(state.revision!==previous.revision){
        for(const item of state.lastBatch){
          if(item.kind!=="option_quote")continue;
          const found=index.get(item.symbol);
          if(!found)continue;
          const latest=state.optionQuotes[item.symbol];
          if(!latest)continue;
          const row=updates.get(found.strike)??api.getRowNode(String(found.strike))?.data;
          const contract=row?.[found.side];
          if(!row||!contract)continue;
          if(marketCondition(state,"options",item.symbol,"quote")!=="fresh")continue;
          updates.set(found.strike,{...row,[found.side]:{
            ...contract,bid:latest.bid,ask:latest.ask,
            bid_size:latest.bid_size,ask_size:latest.ask_size,quote_at:latest.event_time
          }});
        }
      }
      if(clockAdvanced||statusChanged){
        for(const symbol of Object.keys(previous.optionQuotes)){
          const priorCondition=marketCondition(previous,"options",symbol,"quote");
          if(priorCondition!=="fresh")continue;
          const currentLive=state.optionQuotes[symbol];
          const currentCondition=currentLive?marketCondition(state,"options",symbol,"quote"):"stale";
          if(currentCondition==="fresh")continue;
          const found=index.get(symbol);
          const baseline=state.optionSnapshots[symbol]??chainContracts.get(symbol);
          const row=found&&(updates.get(found.strike)??api.getRowNode(String(found.strike))?.data);
          if(!found||!baseline||!row)continue;
          updates.set(found.strike,{...row,[found.side]:baseline});
        }
      }
      if(updates.size)api.applyTransactionAsync({update:[...updates.values()]});
    });
  },[index,chainContracts]);
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
      <span className="amber font-semibold" data-testid="options-source-label">
        OPRA quotes · {data?.source ?? "source unknown"} · REST model Greeks
      </span>
      <label className="dim">到期日 <input aria-label="Option expiry" type="date" value={expiry}
        onChange={e=>setExpiry(e.target.value)}
        className="bg-[#171717] border border-[#444] px-2 py-1 text-[#ddd]" /></label>
      <span className={marketStatusTone(quoteCondition,feedStatus,"opra")}>{statusText(quoteCondition,feedStatus,"opra")}</span>
      <span className="dim ml-auto">{isFetching?"更新…":data?.asOf?("Gateway response "+data.asOf):"No snapshot"}</span>
    </div>
    <div className="px-2 py-1 border-b border-[#262626]">
      <MarketFeedStatus feed="options" />
    </div>
    {error&&<div role="alert" className="down p-2">OPRA: {(error as Error).message}. Check credentials/entitlement and expiry.</div>}
    {subscriptionError&&<div role="alert" className="down p-2">{subscriptionError}</div>}
    {data?.truncated&&<div className="down p-1">⚠ 期权链分页达到上限；数据不完整。</div>}
    <div className="dim px-2 py-1 text-[9px]" data-testid="options-subscription-coverage">
      {subscriptionCoverageText} · {feedStatus&&feedStatus.confirmed!==null
        ? `${feedStatus.coverage.confirmed_count}/${feedStatus.coverage.desired_count} confirmed`
        : `confirmed unknown${feedStatus?`/${feedStatus.coverage.desired_count} desired`:" · desired unknown"}`} gateway-wide unique symbols
      · Gateway effective limit {hasUsableSubscriptionLimit?subscriptionLimit:"unknown"} · account entitlement unknown · {snapshotContractCount} unique snapshot contracts
      {data?.underlyingPrice===null&&" · SIP underlying unavailable; ATM ranking unavailable"}
    </div>
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
      <span>{rows.length} strikes · OPRA quote/trade stream · IV/Greeks: {modelMetadata.source} · model as-of {modelMetadata.asOf??"unknown"} · {data?.underlyingPrice==null?"underlying unavailable":"SIP underlying $"+fmt(data.underlyingPrice)} · missing Greeks stay empty</span>
      <span>{selected?selected.symbol+" · IV "+(selected.iv==null?"—":fmt(selected.iv*100,2)+"%"):"点击 CALL/PUT 单元格查看合约"}</span>
    </div>
    {selected&&<div className="flex gap-3 px-2 py-1 text-[10px] dim flex-wrap">
      <span>Bid {fmt(selected.bid)}</span><span>Ask {fmt(selected.ask)}</span>
      <span>Δ {fmt(selected.delta,3)}</span><span>Γ {fmt(selected.gamma,3)}</span>
      <span>Θ {fmt(selected.theta,3)}</span><span>Vega {fmt(selected.vega,3)}</span>
      <span>OPRA quote as-of {selected.quote_at??"unknown"} · trade as-of {selected.trade_at??"unknown"}</span>
      <span>{selected.greeksSource} · model as-of {selected.model_as_of??selected.greeksAsOf??"unknown"}</span>
    </div>}
  </div>;
}
