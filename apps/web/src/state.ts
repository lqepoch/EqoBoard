import {create} from 'zustand';
import type {MarketEvent, OptionContract, OrderLeg} from './types';
import {newYorkDate} from './utils';

export type Page = 'overview' | 'stocks' | 'options' | 'vertical' | 'system';
interface UiStore {
  page:Page;
  selectedSymbol:string;
  expiration:string;
  legs:OrderLeg[];
  activeContract:OptionContract|null;
  setPage:(p:Page)=>void;
  setSymbol:(s:string)=>void;
  setExpiration:(date:string)=>void;
  selectContract:(contract:OptionContract)=>void;
  clearLegs:()=>void;
  setLegSide:(symbol:string,side:'buy'|'sell')=>void;
}
export const useUi = create<UiStore>((set)=>({
  page:'overview',
  selectedSymbol:'QQQ',
  expiration:newYorkDate(),
  legs:[],
  activeContract:null,
  setPage:(page)=>set({page}),
  setSymbol:(selectedSymbol)=>set({selectedSymbol,legs:[],activeContract:null}),
  setExpiration:(expiration)=>set({expiration,legs:[],activeContract:null}),
  selectContract:(contract)=>set((state)=>{
    const exists=state.legs.find(l=>l.symbol===contract.symbol);
    if (exists) return {activeContract:contract};
    const newLegs = state.legs.length>=2 ? [{symbol:contract.symbol,side:'buy' as const}]
      : [...state.legs,{symbol:contract.symbol,side:state.legs.length===0?'buy' as const:'sell' as const}];
    return {activeContract:contract,legs:newLegs};
  }),
  clearLegs:()=>set({legs:[],activeContract:null}),
  setLegSide:(symbol,side)=>set(s=>({legs:s.legs.map(l=>l.symbol===symbol?{...l,side}:l)}))
}));

type StockLive = Extract<MarketEvent,{kind:'stock_quote'|'stock_trade'}>;
type OptionLive = Extract<MarketEvent,{kind:'option_quote'}>;
type OptionTrade = Extract<MarketEvent,{kind:'option_trade'}>;
interface MarketStore {
  connected:boolean;
  reconnecting:boolean;
  error:string|null;
  stockEvents:Record<string,StockLive>;
  optionQuotes:Record<string,OptionLive>;
  recentTrades:OptionTrade[];
  feedStatus:Record<string,string>;
  lastBatch:MarketEvent[];
  revision:number;
  setConnection:(connected:boolean,error?:string|null)=>void;
  applyBatch:(batch:MarketEvent[])=>void;
}
export const useMarket = create<MarketStore>((set)=>({
  connected:false,reconnecting:false,error:null,
  stockEvents:{},optionQuotes:{},recentTrades:[],feedStatus:{},
  lastBatch:[],revision:0,
  setConnection:(connected,error=null)=>set({connected,error,reconnecting:!connected}),
  applyBatch:(batch)=>set(s=>{
    const stockEvents={...s.stockEvents};
    const optionQuotes={...s.optionQuotes};
    let recentTrades=s.recentTrades;
    const feedStatus={...s.feedStatus};
    for(const event of batch){
      switch(event.kind){
        case 'stock_quote':
        case 'stock_trade': stockEvents[event.symbol]=event;break;
        case 'option_quote': optionQuotes[event.symbol]=event;break;
        case 'option_trade': recentTrades=[event,...recentTrades].slice(0,150);break;
        case 'feed_status': feedStatus[event.feed]=event.state;break;
      }
    }
    return {stockEvents,optionQuotes,recentTrades,feedStatus,lastBatch:batch,revision:s.revision+1};
  })
}));
