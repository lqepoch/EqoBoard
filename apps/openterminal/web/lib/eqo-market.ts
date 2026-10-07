import type { MarketSnapshotWatermark } from "./api";
import { usesSIPEquitySymbol } from "../../server/src/providers/market-symbol.ts";
import { splitSnapshotWatermarks } from "../../server/src/providers/snapshot-watermarks.ts";
import { resolveMarketSource, type MarketSourceFields } from "../../server/src/providers/market-source.ts";
export { usesSIPEquitySymbol };

/**
 * EqoBoard's single source of truth for U.S. equity/options prices.
 * OpenTerminal visuals consume the existing Rust gateway's SIP/OPRA contract.
 * Never fall back to Yahoo, Nasdaq, Stooq or indicative feeds for these routes.
 * No Alpaca credentials are sent to the browser or this Next.js package.
 */
export class EqoUpstreamError extends Error {
  constructor(public readonly status: number, reason: string) { super(reason); }
}
type Snapshot = MarketSourceFields & { gateway_instance_id?: string; received_at?: string | null;
  symbol: string; last: number | null; previous_close: number | null;
  change_percent: number | null; open?: number | null; high?: number | null;
  low?: number | null; bid: number | null; ask: number | null;
  volume: number | null; feed: string;
  quote_at?: string | null; trade_at?: string | null; daily_bar_at?: string | null;
  previous_daily_bar_at?: string | null; last_as_of?: string | null;
  last_basis?: "trade" | "daily_bar" | "unknown" | null;
  /** Compatibility field; never treated as the timestamp for non-trade fields. */
  updated_at?: string | null;
};
export type SnapshotWatermark = MarketSnapshotWatermark;
type GatewaySnapshotWatermark = {
  gateway_instance_id?: string;
  feed?: "stocks" | "options";
  connection_epoch: number;
  request_start_sequence?: number | null;
  local_sequence: number;
};
type BarsResponse = MarketSourceFields & { gateway_instance_id?: string; received_at?: string | null; feed: string; bars: Array<MarketSourceFields & { gateway_instance_id?: string; received_at?: string | null;
  time: string; open: number; high: number; low: number; close: number; volume: number
}>; watermark?: GatewaySnapshotWatermark };
export type EqoHistory = { bars: Array<{time:number;open:number;high:number;low:number;close:number;volume:number;asOf:string;received_at?:string|null;gateway_instance_id?:string} & MarketSourceFields>;
  source:string;source_mode?:unknown;source_label?:unknown;gateway_instance_id?:string;received_at?:string|null;asOf:string|null;watermark?:GatewaySnapshotWatermark|null };
type RawOption = MarketSourceFields & { gateway_instance_id?:string; received_at?:string|null;
  symbol: string; right: "call" | "put"; strike: number; bid: number | null;
  ask: number | null; last: number | null; iv: number | null;
  delta: number | null; gamma: number | null; theta: number | null;
  vega: number | null; bid_size: number | null; ask_size: number | null;
  quote_at?: string | null; trade_at?: string | null; model_as_of?: string | null;
  /** Compatibility field; this may mix quote and trade time and is not used for freshness. */
  updated_at?: string | null
};
type Option = RawOption & {
  greeksSource: string;
  greeksAsOf: string | null;
};
export type EqoChain = {
  symbol: string; underlyingPrice: number | null; selectedDate: string;
  source: string; source_mode?: unknown; source_label?: unknown; gateway_instance_id?: string; received_at?: string | null; asOf: string; truncated: boolean;
  /** Captured by the browser before starting the REST request, not sent to the Gateway. */
  clientGatewayInstanceGeneration?: number;
  /** Legacy mixed-time barrier; retained for older clients, never used for LIVE state. */
  watermark?: SnapshotWatermark | null;
  watermarks: SnapshotWatermark[];
  calls: Option[]; puts: Option[];
};

const ticker = /^[A-Z][A-Z0-9.-]{0,11}$/;
const ranges: Record<string, { timeframe:string; days:number; limit:number }> = {
  "1D": { timeframe:"1Min",days:4,limit:500 },
  "5D": { timeframe:"5Min",days:14,limit:500 },
  "1M": { timeframe:"1Hour",days:45,limit:500 },
  "6M": { timeframe:"1Day",days:210,limit:500 },
  "YTD": { timeframe:"1Day",days:380,limit:500 },
  "1Y": { timeframe:"1Day",days:390,limit:500 },
  "5Y": { timeframe:"1Week",days:1950,limit:520 },
  "MAX": { timeframe:"1Month",days:10500,limit:600 }
};
function validateTicker(s: string): string {
  const sym=s.trim().toUpperCase();
  if (!ticker.test(sym)) throw new EqoUpstreamError(400, "Invalid ticker symbol");
  return sym;
}
function requireFeed(feed: string, expected: "sip" | "opra"): void {
  if (feed !== expected) throw new EqoUpstreamError(409,
    "EqoBoard configured feed is "+feed+"; "+expected+" required. No silent fallback.");
}
async function getRust<T>(path: string, authorization: string): Promise<T> {
  const host = process.env.EQO_RUST_URL ?? "http://127.0.0.1:8080";
  if (!authorization || authorization.trim() !== authorization || /\s/.test(authorization)) {
    throw new EqoUpstreamError(401, "A verified market:read identity is required");
  }
  // Server-managed deployment configuration; never accept a URL from a client.
  const headers: Record<string,string> = { Authorization: `Bearer ${authorization}` };
  const response = await fetch(host.replace(/\/+$/, "")+path, {
    cache:"no-store", headers, signal:AbortSignal.timeout(15_000)
  }).catch(()=> { throw new EqoUpstreamError(502,"Rust market-data gateway unavailable"); });
  if (!response.ok) {
    // Do not expose headers or internal credentials in the response.
    throw new EqoUpstreamError(response.status,
      "EqoBoard market-data gateway returned HTTP "+response.status);
  }
  return response.json() as Promise<T>;
}
export async function eqoStatus(authorization: string) {
  const data=await getRust<MarketSourceFields & {market_credentials_present:boolean;stock_feed:string;option_feed:string;
    execution_mode:string;adapter_endpoints_configured:string[];
    broker_capabilities:Record<string, {paper:{enabled:boolean;implementation:string};live:{enabled:boolean;implementation:string}}>;
    as_of:string}>("/api/v1/status", authorization);
  return {
    ok:data.market_credentials_present, ai:false,
    providers:[{name:data.stock_feed.toUpperCase()+" (configured protocol)",ok:0,failed:0,lastLatencyMs:null},
      {name:data.option_feed.toUpperCase()+" (configured protocol)",ok:0,failed:0,lastLatencyMs:null}],
    dataSource:resolveMarketSource(data,data.stock_feed==="sip"?"sip":"opra").label,
    source_mode:data.source_mode,source_label:data.source_label,
    stockFeed:data.stock_feed,optionFeed:data.option_feed,
    executionMode:data.execution_mode,
    adapterEndpointsConfigured:data.adapter_endpoints_configured,
    brokerCapabilities:data.broker_capabilities,
    note:"Configured subscription does not prove real-time entitlement; 401/403/429 are propagated",
    asOf:data.as_of
  };
}
export async function eqoQuotes(input: string, authorization: string) {
  const symbols = [...new Set(input.split(",").map(validateTicker))];
  if (!symbols.length||symbols.length>50) throw new EqoUpstreamError(400,"Expected 1..50 stock symbols");
  const data=await getRust<MarketSourceFields & {gateway_instance_id?:string;received_at?:string|null;feed:string;snapshots:Snapshot[];watermark?:GatewaySnapshotWatermark}>(
    "/api/v1/stocks/snapshots?symbols="+encodeURIComponent(symbols.join(",")), authorization);
  requireFeed(data.feed,"sip");
  return data.snapshots.map(s=>{
    const sourceFields={source_mode:s.source_mode===undefined?data.source_mode:s.source_mode,
      source_label:s.source_label===undefined?data.source_label:s.source_label,
      gateway_instance_id:s.gateway_instance_id??data.gateway_instance_id??data.watermark?.gateway_instance_id};
    const source=resolveMarketSource(sourceFields,"sip");
    return {
    symbol:s.symbol,name:null,price:s.last,change:s.last!=null && s.previous_close!=null?s.last-s.previous_close:null,
    changePercent:s.change_percent,open:s.open??null,high:s.high??null,low:s.low??null,
    previousClose:s.previous_close,bid:s.bid,ask:s.ask,volume:s.volume,
    avgVolume:null,marketCap:null,pe:null,eps:null,dividendYield:null,
    week52High:null,week52Low:null,beta:null,sharesOutstanding:null,
    currency:"USD",exchange:null,marketState:null,source:source.label,
    source_mode:sourceFields.source_mode,source_label:sourceFields.source_label,
    gateway_instance_id:sourceFields.gateway_instance_id,
    received_at:s.received_at===undefined?data.received_at:s.received_at,asOf:s.last_as_of??null,
    quoteAt:s.quote_at??null,tradeAt:s.trade_at??null,
    dailyBarAt:s.daily_bar_at??null,previousDailyBarAt:s.previous_daily_bar_at??null,
    lastAsOf:s.last_as_of??null,lastBasis:s.last_basis??"unknown",
    // Old gateway payloads expose only updated_at, which is trade-only and
    // cannot safely establish which source produced `last`; keep it visible
    // as tradeAt but do not use it to mark either channel LIVE.
    ...(s.trade_at===undefined&&s.updated_at?{tradeAt:s.updated_at}:{}),
    watermarks:splitSnapshotWatermarks("stocks",data.watermark ? {
      ...data.watermark,gateway_instance_id:data.watermark.gateway_instance_id??data.gateway_instance_id
    } : null,[{
      symbol:s.symbol,quote_at:s.quote_at??null,
      trade_at:s.trade_at??(s.last_basis==="trade"?s.updated_at:null)
    }]),
  };});
}
export async function eqoHistory(symbol: string, range: string, authorization: string) {
  const sym=validateTicker(symbol), r=ranges[range];
  if (!r) throw new EqoUpstreamError(400,"Unsupported historical range");
  const query=new URLSearchParams({
    symbol:sym,timeframe:r.timeframe,limit:String(r.limit),days:String(r.days)
  });
  const data=await getRust<BarsResponse>("/api/v1/stocks/bars?"+query.toString(), authorization);
  requireFeed(data.feed,"sip");
  // OpenTerminal charts use UNIX seconds. Preserve upstream bars without inventing candles.
  const bars=data.bars.map(b=>({
    time:Math.floor(Date.parse(b.time)/1000),
    open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,asOf:b.time,
    source_mode:b.source_mode===undefined?data.source_mode:b.source_mode,
    source_label:b.source_label===undefined?data.source_label:b.source_label,
    gateway_instance_id:b.gateway_instance_id??data.gateway_instance_id??data.watermark?.gateway_instance_id,
    received_at:b.received_at===undefined?data.received_at:b.received_at
  })).filter(b=>Number.isFinite(b.time)).sort((a,b)=>a.time-b.time);
  const filtered=range==="YTD" ? (()=>{
    const year=new Date().toLocaleDateString("en-US",{timeZone:"America/New_York",year:"numeric"});
    const start=Date.parse(year+"-01-01T00:00:00Z")/1000;
    return bars.filter(b=>b.time>=start);
  })() : bars;
  const source=resolveMarketSource(data,"sip");
  return {bars:filtered,source:source.label,source_mode:data.source_mode,source_label:data.source_label,
    gateway_instance_id:data.gateway_instance_id??data.watermark?.gateway_instance_id,
    received_at:data.received_at,
    asOf:filtered.length?new Date(filtered[filtered.length-1].time*1000).toISOString():null,
    watermark:data.watermark ? {...data.watermark,gateway_instance_id:data.watermark.gateway_instance_id??data.gateway_instance_id}:null} satisfies EqoHistory;
}
export async function eqoChain(symbol: string, expiry: string | undefined, authorization: string): Promise<EqoChain> {
  const sym=validateTicker(symbol);
  const nyDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",
    year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const date=expiry||nyDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date+"T12:00:00Z")))
    throw new EqoUpstreamError(400,"Invalid option expiry");
  const query=new URLSearchParams({underlying:sym,expiration:date});
  const raw=await getRust<MarketSourceFields & {gateway_instance_id?:string;received_at?:string|null;feed:string;as_of:string;truncated:boolean;contracts:RawOption[];watermark?:GatewaySnapshotWatermark}>(
    "/api/v1/options/chain?"+query.toString(), authorization);
  requireFeed(raw.feed,"opra");
  const underlying = (await eqoQuotes(sym, authorization)).find((quote) => quote.symbol === sym);
  const gatewayWatermark=raw.watermark?{
    ...raw.watermark,gateway_instance_id:raw.watermark.gateway_instance_id??raw.gateway_instance_id
  }:null;
  const watermarks=splitSnapshotWatermarks("options",gatewayWatermark,raw.contracts);
  const source=resolveMarketSource(raw,"opra");
  const mapContract=(contract:RawOption):Option=>{
    const sourceFields={source_mode:contract.source_mode===undefined?raw.source_mode:contract.source_mode,
      source_label:contract.source_label===undefined?raw.source_label:contract.source_label,
      gateway_instance_id:contract.gateway_instance_id??raw.gateway_instance_id??raw.watermark?.gateway_instance_id,
      received_at:contract.received_at===undefined?raw.received_at:contract.received_at};
    const contractSource=resolveMarketSource(sourceFields,"opra");
    const greeksSource=contractSource.mode==="alpaca"?"Alpaca REST option snapshot model":
      contractSource.mode==="offline_mock"?"OFFLINE MOCK — NOT MARKET DATA":"option model source unknown";
    return {...contract,...sourceFields,greeksSource,greeksAsOf:contract.model_as_of??null};
  };
  return {
    symbol:sym,underlyingPrice:underlying?.price ?? null,selectedDate:date,source:source.label,
    source_mode:raw.source_mode,source_label:raw.source_label,gateway_instance_id:raw.gateway_instance_id??raw.watermark?.gateway_instance_id,received_at:raw.received_at,
    asOf:raw.as_of,truncated:raw.truncated,
    // Do not derive a quote or trade barrier from the legacy mixed updated_at.
    watermarks,
    watermark:watermarks[0]??null,
    calls:raw.contracts.filter(c=>c.right==="call").map(mapContract),
    puts:raw.contracts.filter(c=>c.right==="put").map(mapContract)
  };
}
