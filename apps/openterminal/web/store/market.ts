"use client";

import {create} from "zustand";

export type StockQuoteEvent={kind:"stock_quote";symbol:string;bid:number|null;ask:number|null;timestamp:string};
export type StockTradeEvent={kind:"stock_trade";symbol:string;price:number;size:number;timestamp:string};
export type OptionQuoteEvent={kind:"option_quote";symbol:string;bid:number|null;ask:number|null;
  bid_size:number|null;ask_size:number|null;timestamp:string};
export type OptionTradeEvent={kind:"option_trade";symbol:string;price:number;size:number;timestamp:string};
export type FeedStatusEvent={kind:"feed_status";feed:string;state:string;timestamp:string};
export type MarketEvent=StockQuoteEvent|StockTradeEvent|OptionQuoteEvent|OptionTradeEvent|FeedStatusEvent;

type MarketState={
  connected:boolean;
  connectionError:string|null;
  subscriptionError:string|null;
  feedStatus:Record<string,FeedStatusEvent>;
  stockQuotes:Record<string,StockQuoteEvent>;
  stockTrades:Record<string,StockTradeEvent>;
  optionQuotes:Record<string,OptionQuoteEvent>;
  optionTrades:OptionTradeEvent[];
  lastBatch:MarketEvent[];
  revision:number;
  setConnection:(connected:boolean,error?:string|null)=>void;
  setSubscriptionError:(error:string|null)=>void;
  applyBatch:(batch:MarketEvent[])=>void;
};

export const useMarket=create<MarketState>((set)=>({
  connected:false,connectionError:null,subscriptionError:null,
  feedStatus:{},stockQuotes:{},stockTrades:{},optionQuotes:{},optionTrades:[],
  lastBatch:[],revision:0,
  setConnection:(connected,connectionError=null)=>set({connected,connectionError}),
  setSubscriptionError:(subscriptionError)=>set({subscriptionError}),
  applyBatch:(batch)=>set(state=>{
    let feedStatus=state.feedStatus;
    let stockQuotes=state.stockQuotes;
    let stockTrades=state.stockTrades;
    let optionQuotes=state.optionQuotes;
    let optionTrades=state.optionTrades;
    let feedCopied=false,stockQuotesCopied=false,stockTradesCopied=false,optionQuotesCopied=false;
    for(const event of batch){
      switch(event.kind){
        case "stock_quote":
          if(!stockQuotesCopied){stockQuotes={...stockQuotes};stockQuotesCopied=true;}
          stockQuotes[event.symbol]=event;
          break;
        case "stock_trade":
          if(!stockTradesCopied){stockTrades={...stockTrades};stockTradesCopied=true;}
          stockTrades[event.symbol]=event;
          break;
        case "option_quote":
          if(!optionQuotesCopied){optionQuotes={...optionQuotes};optionQuotesCopied=true;}
          optionQuotes[event.symbol]=event;
          break;
        case "option_trade":
          optionTrades=[event,...optionTrades].slice(0,500);
          break;
        case "feed_status":
          if(!feedCopied){feedStatus={...feedStatus};feedCopied=true;}
          feedStatus[event.feed]=event;
          break;
      }
    }
    return {feedStatus,stockQuotes,stockTrades,optionQuotes,optionTrades,
      lastBatch:batch,revision:state.revision+1};
  })
}));
