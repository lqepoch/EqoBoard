/**
 * EqoBoard's single source of truth for U.S. equity/options prices.
 * OpenTerminal visuals consume the existing Rust gateway's SIP/OPRA contract.
 * Never fall back to Yahoo, Nasdaq, Stooq or indicative feeds for these routes.
 * No Alpaca credentials are sent to the browser or this Next.js package.
 */
export class EqoUpstreamError extends Error {
  constructor(public readonly status: number, reason: string) { super(reason); }
}
type Snapshot = {
  symbol: string; last: number | null; previous_close: number | null;
  change_percent: number | null; open?: number | null; high?: number | null;
  low?: number | null; bid: number | null; ask: number | null;
  volume: number | null; updated_at: string | null; feed: string;
};
type BarsResponse = { feed: string; bars: Array<{
  time: string; open: number; high: number; low: number; close: number; volume: number
}> };
type Option = {
  symbol: string; right: "call" | "put"; strike: number; bid: number | null;
  ask: number | null; last: number | null; iv: number | null;
  delta: number | null; gamma: number | null; theta: number | null;
  vega: number | null; bid_size: number | null; ask_size: number | null;
  updated_at: string | null
};
export type EqoChain = {
  symbol: string; underlyingPrice: number | null; selectedDate: string;
  source: string; asOf: string; truncated: boolean;
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
async function getRust<T>(path: string): Promise<T> {
  const host = process.env.EQO_RUST_URL ?? "http://127.0.0.1:8080";
  // Server-managed deployment configuration; never accept a URL from a client.
  const headers: Record<string,string> = {};
  if (process.env.EQO_ACCESS_TOKEN) headers.Authorization = "Bearer "+process.env.EQO_ACCESS_TOKEN;
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
export async function eqoStatus() {
  const data=await getRust<{market_credentials_present:boolean;stock_feed:string;option_feed:string;
    execution_mode:string;configured_adapters:string[];as_of:string}>("/api/v1/status");
  return {
    ok:data.market_credentials_present, ai:false,
    providers:[{name:"Alpaca "+data.stock_feed.toUpperCase()+" (configuration)",ok:0,failed:0,lastLatencyMs:null},
      {name:"Alpaca "+data.option_feed.toUpperCase()+" (configuration)",ok:0,failed:0,lastLatencyMs:null}],
    dataSource:"Alpaca",stockFeed:data.stock_feed,optionFeed:data.option_feed,
    executionMode:data.execution_mode, adapters:data.configured_adapters,
    note:"Configured subscription does not prove real-time entitlement; 401/403/429 are propagated",
    asOf:data.as_of
  };
}
export async function eqoQuotes(input: string) {
  const symbols = [...new Set(input.split(",").map(validateTicker))];
  if (!symbols.length||symbols.length>50) throw new EqoUpstreamError(400,"Expected 1..50 stock symbols");
  const data=await getRust<{feed:string;snapshots:Snapshot[]}>(
    "/api/v1/stocks/snapshots?symbols="+encodeURIComponent(symbols.join(",")));
  requireFeed(data.feed,"sip");
  return data.snapshots.map(s=>({
    symbol:s.symbol,name:null,price:s.last,change:s.last!=null && s.previous_close!=null?s.last-s.previous_close:null,
    changePercent:s.change_percent,open:s.open??null,high:s.high??null,low:s.low??null,
    previousClose:s.previous_close,bid:s.bid,ask:s.ask,volume:s.volume,
    avgVolume:null,marketCap:null,pe:null,eps:null,dividendYield:null,
    week52High:null,week52Low:null,beta:null,sharesOutstanding:null,
    currency:"USD",exchange:null,marketState:null,source:"Alpaca SIP",asOf:s.updated_at
  }));
}
export async function eqoHistory(symbol: string, range: string) {
  const sym=validateTicker(symbol), r=ranges[range];
  if (!r) throw new EqoUpstreamError(400,"Unsupported historical range");
  const query=new URLSearchParams({
    symbol:sym,timeframe:r.timeframe,limit:String(r.limit),days:String(r.days)
  });
  const data=await getRust<BarsResponse>("/api/v1/stocks/bars?"+query.toString());
  requireFeed(data.feed,"sip");
  // OpenTerminal charts use UNIX seconds. Preserve upstream bars without inventing candles.
  const bars=data.bars.map(b=>({
    time:Math.floor(Date.parse(b.time)/1000),
    open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume
  })).filter(b=>Number.isFinite(b.time)).sort((a,b)=>a.time-b.time);
  if (range==="YTD") {
    const year=new Date().toLocaleDateString("en-US",{timeZone:"America/New_York",year:"numeric"});
    const start=Date.parse(year+"-01-01T00:00:00Z")/1000;
    return bars.filter(b=>b.time>=start);
  }
  return bars;
}
export async function eqoChain(symbol: string, expiry?: string): Promise<EqoChain> {
  const sym=validateTicker(symbol);
  const nyDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",
    year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const date=expiry||nyDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date+"T12:00:00Z")))
    throw new EqoUpstreamError(400,"Invalid option expiry");
  const query=new URLSearchParams({underlying:sym,expiration:date});
  const raw=await getRust<{feed:string;as_of:string;truncated:boolean;contracts:Option[]}>(
    "/api/v1/options/chain?"+query.toString());
  requireFeed(raw.feed,"opra");
  return {
    symbol:sym,underlyingPrice:null,selectedDate:date,source:"Alpaca OPRA",
    asOf:raw.as_of,truncated:raw.truncated,
    calls:raw.contracts.filter(c=>c.right==="call"),
    puts:raw.contracts.filter(c=>c.right==="put")
  };
}
