import {NextRequest,NextResponse} from "next/server";
export const runtime="nodejs";
export const dynamic="force-dynamic";

/** SSE relay: only the Next.js server knows the Rust gateway's access token. */
export async function GET(req:NextRequest) {
  const base=(process.env.EQO_RUST_URL??"http://127.0.0.1:8080").replace(/\/+$/,"");
  const headers:Record<string,string>={Accept:"text/event-stream"};
  if(process.env.EQO_ACCESS_TOKEN)headers.Authorization="Bearer "+process.env.EQO_ACCESS_TOKEN;
  try {
    const upstream=await fetch(base+"/api/v1/stream/sse",{
      method:"GET",cache:"no-store",headers,signal:req.signal
    });
    if(!upstream.ok||!upstream.body){
      return NextResponse.json({error:"Rust SSE feed unavailable",status:upstream.status},
        {status:upstream.ok?502:upstream.status});
    }
    return new Response(upstream.body,{
      status:200,
      headers:{
        "Content-Type":"text/event-stream",
        "Cache-Control":"no-cache, no-transform",
        "X-Accel-Buffering":"no"
      }
    });
  }catch{
    return NextResponse.json({error:"Cannot connect to Rust live data feed"},{status:502});
  }
}
