export type Right = 'call' | 'put';
export type Broker = 'alpaca' | 'ibkr' | 'schwab';
export type OrderKind = 'stock' | 'option' | 'vertical';
export type Side = 'buy' | 'sell';
export type NetEffect = 'debit' | 'credit';

export interface StockSnapshot {
  symbol: string;
  last: number | null;
  previous_close: number | null;
  change_percent: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  updated_at: string | null;
  feed: string;
}
export interface BarsResponse {
  symbol: string;
  timeframe: string;
  feed: string;
  bars: {time:string;open:number;high:number;low:number;close:number;volume:number}[];
}
export interface OptionContract {
  symbol: string;
  underlying: string;
  expiration: string;
  right: Right;
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  bid_size: number | null;
  ask_size: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  updated_at: string | null;
  feed: string;
}
export interface OptionChainResponse {
  underlying:string;
  expiration:string;
  feed:string;
  source:string;
  as_of:string;
  truncated:boolean;
  contracts: OptionContract[];
}
export interface StockResponse {
  snapshots: StockSnapshot[];
  feed: string;
  source: string;
  as_of: string;
}
export interface GatewayStatus {
  service:string;
  market_credentials_present:boolean;
  stock_feed:string;
  option_feed:string;
  market_data_provider:string;
  execution_mode:'disabled'|'paper';
  configured_adapters:Broker[];
  max_option_subscriptions:number;
  active_option_subscriptions:number;
  stock_symbols:string[];
  as_of:string;
}
export type MarketEvent =
  | {kind:'stock_quote';symbol:string;bid:number|null;ask:number|null;timestamp:string}
  | {kind:'stock_trade';symbol:string;price:number;size:number;timestamp:string}
  | {kind:'option_quote';symbol:string;bid:number|null;ask:number|null;bid_size:number|null;ask_size:number|null;timestamp:string}
  | {kind:'option_trade';symbol:string;price:number;size:number;timestamp:string}
  | {kind:'feed_status';feed:string;state:string;timestamp:string};

export interface OrderLeg {symbol:string;side:Side}
export interface OrderIntent {
  broker:Broker;
  environment:'paper';
  kind:OrderKind;
  symbol:string|null;
  quantity:number;
  limit_price:number;
  net_effect:NetEffect;
  legs:OrderLeg[];
}
export interface PreviewResult {
  preview_id:string;
  expires_at:string;
  estimated_max_loss:number;
  currency:string;
  intent:OrderIntent;
}
export interface OptionRow {strike:number;call:OptionContract|null;put:OptionContract|null}
