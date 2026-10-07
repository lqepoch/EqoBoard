import { NextRequest, NextResponse } from "next/server";
import { getApiKey } from "@/lib/api-key";
import {eqoStatus,eqoQuotes,eqoHistory,eqoChain,EqoUpstreamError} from "@/lib/eqo-market";

/**
 * Native OpenTerminal UI, EqoBoard-first routing.
 * Prices/options/historical charts ALWAYS use Alpaca SIP/OPRA via the Rust gateway.
 * OpenTerminal's existing Node server provides supplementary research widgets only.
 */
const API_URL=process.env.API_URL ?? "http://127.0.0.1:4000";
type RouteContext={params:Promise<{path:string[]}>};

async function proxy(req:NextRequest,path:string[]):Promise<NextResponse>{
  if (req.method==="GET") {
    try {
      if (path.length===1 && path[0]==="status") return NextResponse.json(await eqoStatus());
      if (path.length===1 && path[0]==="quotes") {
        return NextResponse.json(await eqoQuotes(req.nextUrl.searchParams.get("symbols")??""));
      }
      if (path.length===2 && path[0]==="history") {
        return NextResponse.json(await eqoHistory(path[1],req.nextUrl.searchParams.get("range")??"6M"));
      }
      if (path.length===2 && path[0]==="options") {
        return NextResponse.json(await eqoChain(path[1],req.nextUrl.searchParams.get("expiry")??undefined));
      }
    }catch(e){
      const status=e instanceof EqoUpstreamError?e.status:502;
      const msg=e instanceof Error?e.message:"market-data failure";
      return NextResponse.json({error:msg},{status});
    }
  }
  // Block any non-read attempts against Eqo market routes: no fallback to public Yahoo/Nasdaq providers.
  if (["status","quotes","history","options"].includes(path[0])) {
    return NextResponse.json({error:"Only read-only market-data requests are supported"},{status:405});
  }
  const url=API_URL.replace(/\/+$/,"")+"/api/"+path.map(encodeURIComponent).join("/")+req.nextUrl.search;
  const headers=new Headers();
  const contentType=req.headers.get("content-type");
  if(contentType) headers.set("content-type",contentType);
  const apiKey=getApiKey();
  if(apiKey) headers.set("x-api-key",apiKey);
  const hasBody=!["GET","HEAD","DELETE"].includes(req.method);
  try {
    const upstream=await fetch(url,{
      method:req.method,headers,body:hasBody?await req.text():undefined,
      cache:"no-store",signal:AbortSignal.timeout(15_000)
    });
    const body=upstream.status===204?null:await upstream.arrayBuffer();
    return new NextResponse(body,{status:upstream.status,
      headers:{"content-type":upstream.headers.get("content-type")??"application/json"}});
  }catch{
    return NextResponse.json({error:"OpenTerminal supplementary research provider unavailable"},{status:502});
  }
}
export async function GET(req:NextRequest,ctx:RouteContext){return proxy(req,(await ctx.params).path);}
export async function POST(req:NextRequest,ctx:RouteContext){return proxy(req,(await ctx.params).path);}
export async function DELETE(req:NextRequest,ctx:RouteContext){return proxy(req,(await ctx.params).path);}
export async function PATCH(req:NextRequest,ctx:RouteContext){return proxy(req,(await ctx.params).path);}
export async function PUT(req:NextRequest,ctx:RouteContext){return proxy(req,(await ctx.params).path);}
