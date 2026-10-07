"use client";

import {useEffect,useMemo,useRef} from "react";
import {useQueryClient} from "@tanstack/react-query";
import {useTerminal} from "../store/terminal";
import {useMarket,type MarketEvent} from "../store/market";
import {usesSIPEquitySymbol} from "../../server/src/providers/market-symbol.ts";

export default function MarketStreamProvider({children}:{children:React.ReactNode}){
  const queryClient=useQueryClient();
  const activeSymbol=useTerminal(s=>s.activeSymbol);
  const watchlist=useTerminal(s=>s.watchlist);
  const widgets=useTerminal(s=>s.widgets);
  const consumerId=useRef<string|null>(null);
  const generation=useRef(0);
  if(!consumerId.current&&typeof crypto!=="undefined")consumerId.current=crypto.randomUUID();

  const symbols=useMemo(()=>{
    const all=new Set<string>([activeSymbol,...watchlist]);
    for(const widget of widgets){
      if(widget.symbol)all.add(widget.symbol);
    }
    return [...all].filter(usesSIPEquitySymbol).sort();
  },[activeSymbol,watchlist,widgets]);
  const symbolKey=symbols.join(",");

  useEffect(()=>{
    const updateMarketClock=()=>useMarket.getState().setMarketClock(Date.now());
    updateMarketClock();
    const timer=setInterval(updateMarketClock,1_000);
    return()=>clearInterval(timer);
  },[]);

  useEffect(()=>{
    const source=new EventSource("/api/eqo/live");
    source.onopen=()=>useMarket.getState().setConnection(true,null);
    source.onerror=()=>useMarket.getState().setConnection(false,"EqoBoard live stream disconnected; browser will retry.");
    source.onmessage=event=>{
      let batch:MarketEvent[];
      try{batch=JSON.parse(event.data) as MarketEvent[];}catch{return;}
      if(!Array.isArray(batch))return;
      const before=useMarket.getState().resyncGeneration;
      useMarket.getState().applyBatch(batch);
      if(useMarket.getState().resyncGeneration!==before){
        void queryClient.invalidateQueries({
          predicate:q=>["quote","watchlist","eqo-opra","eqo-iv-skew"].includes(String(q.queryKey[0]))
        });
      }
    };
    return()=>source.close();
  },[queryClient]);

  useEffect(()=>{
    const id=consumerId.current;
    if(!id)return;
    const leaseGeneration=++generation.current;
    let alive=true;
    async function refresh(next:string[],generationValue:number){
      try{
        const response=await fetch("/api/eqo/stocks/subscribe",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({consumer_id:id,generation:generationValue,symbols:next})
        });
        if(!response.ok)throw new Error("SIP subscription rejected HTTP "+response.status);
        if(alive)useMarket.getState().setSubscriptionError(null);
      }catch(error){
        if(alive)useMarket.getState().setSubscriptionError(
          error instanceof Error?error.message:"SIP subscription failed");
      }
    }
    void refresh(symbols,leaseGeneration);
    const timer=setInterval(()=>void refresh(symbols,leaseGeneration),30_000);
    return()=>{
      alive=false;clearInterval(timer);
      const cleanupGeneration=++generation.current;
      void refresh([],cleanupGeneration);
    };
  },[symbolKey]); // symbols are intentionally represented by the stable key

  return <>{children}</>;
}
