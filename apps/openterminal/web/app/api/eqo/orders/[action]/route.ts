import {NextRequest,NextResponse} from "next/server";
export const runtime="nodejs";
type Ctx={params:Promise<{action:string}>};
export async function POST(req:NextRequest,ctx:Ctx){
  const {action}=await ctx.params;
  if(action!=="preview"&&action!=="submit")
    return NextResponse.json({error:"Unsupported order action"},{status:404});
  let body:string;
  try{body=await req.text();JSON.parse(body);}catch{
    return NextResponse.json({error:"Invalid JSON"},{status:400});
  }
  const base=(process.env.EQO_RUST_URL??"http://127.0.0.1:8080").replace(/\/+$/,"");
  const headers:Record<string,string>={"content-type":"application/json"};
  if(process.env.EQO_ACCESS_TOKEN)headers.Authorization="Bearer "+process.env.EQO_ACCESS_TOKEN;
  try{
    const upstream=await fetch(base+"/api/v1/orders/"+action,{
      method:"POST",headers,body,cache:"no-store",signal:AbortSignal.timeout(15_000)
    });
    const data=await upstream.arrayBuffer();
    return new NextResponse(data,{status:upstream.status,
      headers:{"content-type":upstream.headers.get("content-type")??"application/json"}});
  }catch{
    return NextResponse.json({error:"Rust execution gateway unavailable"},{status:502});
  }
}
