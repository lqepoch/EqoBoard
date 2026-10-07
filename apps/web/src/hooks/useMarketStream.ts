import {useEffect} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {createWsTicket} from '../api';
import {useMarket} from '../state';
import type {MarketEvent} from '../types';

export function useMarketStream(enabled:boolean){
  const queryClient=useQueryClient();
  useEffect(()=>{
    if(!enabled) return;
    let closed=false;
    let ws:WebSocket|null=null;
    let timer:ReturnType<typeof setTimeout>|null=null;
    let attempts=0;
    async function connect(){
      try{
        const {ticket}=await createWsTicket();
        if(closed) return;
        const url=new URL('/api/v1/stream',window.location.href);
        url.protocol=window.location.protocol==='https:'?'wss:':'ws:';
        url.searchParams.set('ticket',ticket);
        ws=new WebSocket(url);
        ws.onopen=()=>{
          attempts=0;
          useMarket.getState().setConnection(true);
        };
        ws.onmessage=event=>{
          let batch:MarketEvent[];
          try{batch=JSON.parse(event.data) as MarketEvent[];}
          catch{return;}
          if(!Array.isArray(batch)) return;
          useMarket.getState().applyBatch(batch);
          if(batch.some(item=>item.kind==='feed_status' && item.state==='resync_required')){
            void queryClient.invalidateQueries({queryKey:['stocks']});
            void queryClient.invalidateQueries({queryKey:['options']});
          }
        };
        ws.onclose=()=>restart('行情流已断开，自动重新连接');
        ws.onerror=()=>ws?.close();
      }catch(err){
        restart(err instanceof Error ? err.message:'无法连接行情');
      }
    }
    function restart(reason:string){
      if(closed) return;
      useMarket.getState().setConnection(false,reason);
      attempts++;
      timer=setTimeout(()=>void connect(),Math.min(20_000,800*2**Math.min(attempts,5)));
    }
    void connect();
    return ()=>{closed=true;if(timer)clearTimeout(timer);ws?.close();}
  },[enabled,queryClient]);
}
