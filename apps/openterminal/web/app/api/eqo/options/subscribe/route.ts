import {NextRequest,NextResponse} from "next/server";
export const runtime="nodejs";
export async function POST(req:NextRequest) {
  let body:unknown;
  try{body=await req.json();}catch{return NextResponse.json({error:"Invalid JSON"},{status:400});}
  if(!body||typeof body!=="object")return NextResponse.json({error:"Invalid subscription"},{status:400});
  const args=body as {consumer_id?:unknown;symbols?:unknown};
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(typeof args.consumer_id!=="string"||!uuid.test(args.consumer_id)||
    !Array.isArray(args.symbols)||args.symbols.length>1000||
    !args.symbols.every(s=>typeof s==="string"&&/^[A-Z0-9]{1,6}\d{6}[CP]\d{8}$/.test(s))){
    return NextResponse.json({error:"Invalid consumer ID or OCC symbols"},{status:400});
  }
  const url=(process.env.EQO_RUST_URL??"http://127.0.0.1:8080").replace(/\/+$/,"")
    +"/api/v1/subscriptions/options";
  const headers:Record<string,string>={"content-type":"application/json"};
  if(process.env.EQO_ACCESS_TOKEN)headers.Authorization="Bearer "+process.env.EQO_ACCESS_TOKEN;
  try{
    const res=await fetch(url,{method:"POST",headers,cache:"no-store",
      body:JSON.stringify({consumer_id:args.consumer_id,symbols:args.symbols}),
      signal:AbortSignal.timeout(12_000)});
    const data=await res.json().catch(()=>({error:"Upstream response invalid"}));
    return NextResponse.json(data,{status:res.status});
  }catch{return NextResponse.json({error:"Subscription gateway unavailable"},{status:502});}
}
