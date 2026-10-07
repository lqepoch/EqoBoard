"use client";

import {useEffect,useMemo,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {apiGet,fmt} from "../../lib/api";
import {useTerminal,useWidgetSymbol,type WidgetInstance,type OptionLeg} from "../../store/terminal";

type Broker="alpaca"|"ibkr"|"schwab";
type Status={executionMode?:string;adapters?:Broker[]};
type Preview={preview_id:string;expires_at:string;estimated_max_loss:number;currency:string};

async function postJson<T>(path:string,body:unknown):Promise<T>{
  const response=await fetch(path,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
  });
  const payload=await response.json().catch(()=>({detail:"Invalid response"})) as {detail?:string;error?:string};
  if(!response.ok)throw new Error(payload.detail??payload.error??("HTTP "+response.status));
  return payload as T;
}

export default function VerticalSpreadWidget({widget}:{widget:WidgetInstance}){
  const symbol=useWidgetSymbol(widget);
  const legs=useTerminal(s=>s.optionLegs);
  const clear=useTerminal(s=>s.clearOptionLegs);
  const setSide=useTerminal(s=>s.setOptionLegSide);
  const [broker,setBroker]=useState<Broker>("ibkr");
  const [qty,setQty]=useState("1");
  const [limit,setLimit]=useState("");
  const [effect,setEffect]=useState<"debit"|"credit">("debit");
  const [preview,setPreview]=useState<Preview|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [ack,setAck]=useState<string|null>(null);
  const {data:status}=useQuery({
    queryKey:["status"],queryFn:()=>apiGet<Status>("/api/status"),refetchInterval:30000
  });
  const fingerprint=JSON.stringify([legs,broker,qty,limit,effect]);
  useEffect(()=>{setPreview(null);setError(null);setAck(null);},[fingerprint]);
  const canPreview=useMemo(()=>legs.length===2&&legs[0].side!==legs[1].side&&
    Number.isInteger(Number(qty))&&Number(qty)>0&&Number(limit)>0&&Number.isFinite(Number(limit)),
    [legs,qty,limit]);

  async function createPreview(){
    setBusy(true);setError(null);
    try{
      const body={
        broker,environment:"paper",kind:"vertical",symbol:null,quantity:Number(qty),
        limit_price:Number(limit),net_effect:effect,
        legs:legs.map((x:OptionLeg)=>({symbol:x.symbol,side:x.side}))
      };
      const result=await postJson<{preview:Preview}>("/api/eqo/orders/preview",body);
      setPreview(result.preview);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }

  async function submitPaper(){
    if(!preview)return;
    if(!window.confirm("Confirm this two-leg order for the selected PAPER adapter?"))return;
    setBusy(true);setError(null);
    try{
      const result=await postJson<{client_order_id:string;ack:{status:string}}>(
        "/api/eqo/orders/submit",{preview_id:preview.preview_id,confirm:true});
      setAck(result.client_order_id+" · "+result.ack.status);
      setPreview(null);
    }catch(e){setError(e instanceof Error?e.message:String(e));setPreview(null);}
    finally{setBusy(false);}
  }

  const enabled=status?.executionMode==="paper";
  const adapters=status?.adapters??[];
  return <div className="h-full overflow-auto p-2 text-[11px]">
    <div className="flex justify-between items-center mb-2">
      <span className="amber font-semibold">{symbol} VERTICAL SPREAD</span>
      <span className={enabled?"up":"down"}>{enabled?"PAPER ENABLED":"EXECUTION DISABLED"}</span>
    </div>
    {[0,1].map(i=><div key={i} className="border border-[#333] bg-[#121212] p-2 mb-1 flex gap-2 items-center">
      <span className="dim">{String(i+1).padStart(2,"0")}</span>
      <div className="flex-1 min-w-0">
        <div className="truncate font-mono">{legs[i]?.symbol??"Select a contract in Option Chain"}</div>
        <div className="dim text-[9px]">{legs[i]?legs[i].right.toUpperCase()+" · strike "+fmt(legs[i].strike,1):"same expiry / same right required"}</div>
      </div>
      {legs[i]&&<select value={legs[i].side} onChange={e=>setSide(legs[i].symbol,e.target.value as OptionLeg["side"])}>
        <option value="buy">BUY</option><option value="sell">SELL</option>
      </select>}
    </div>)}
    <button className="term-btn w-full mb-2" onClick={clear}>CLEAR LEGS</button>
    <div className="grid grid-cols-2 gap-2">
      <label className="dim">Broker<select className="w-full mt-1" value={broker} onChange={e=>setBroker(e.target.value as Broker)}>
        {(["alpaca","ibkr","schwab"] as Broker[]).map(b=><option key={b} value={b}>{b.toUpperCase()} {adapters.includes(b)?"configured":"not configured"}</option>)}
      </select></label>
      <label className="dim">Qty<input className="w-full mt-1" type="number" min="1" step="1" value={qty} onChange={e=>setQty(e.target.value)}/></label>
      <label className="dim">Net<select className="w-full mt-1" value={effect} onChange={e=>setEffect(e.target.value as "debit"|"credit")}>
        <option value="debit">DEBIT</option><option value="credit">CREDIT</option>
      </select></label>
      <label className="dim">Limit / share<input className="w-full mt-1" type="number" min="0.01" step="0.01" value={limit} onChange={e=>setLimit(e.target.value)}/></label>
    </div>
    {error&&<div className="down mt-2">{error}</div>}
    {ack&&<div className="up mt-2">Adapter response: {ack}. Execution state still requires broker reconciliation.</div>}
    {preview&&<div className="border border-[#375b4b] bg-[#10251c] p-2 mt-2">
      <div className="flex justify-between"><span className="dim">Max loss estimate</span><b>USD {fmt(preview.estimated_max_loss)}</b></div>
      <div className="flex justify-between"><span className="dim">Preview</span><code>{preview.preview_id.slice(0,8)}…</code></div>
    </div>}
    <button disabled={!canPreview||busy} className="term-btn w-full mt-2" onClick={()=>void createPreview()}>1 · RISK PREVIEW</button>
    <button disabled={!preview||!enabled||!adapters.includes(broker)||busy}
      className="term-btn w-full mt-1 !border-[#75404a] !text-[#ff9cab]" onClick={()=>void submitPaper()}>
      2 · CONFIRM PAPER ADAPTER
    </button>
    <div className="dim text-[9px] mt-2">100 multiplier · single-use preview · atomic spread validation · live mode rejected server-side.</div>
  </div>;
}
