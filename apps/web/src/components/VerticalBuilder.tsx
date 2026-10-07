import {useEffect,useMemo,useState} from 'react';
import {createPreview,submitOrder} from '../api';
import {useUi} from '../state';
import type {Broker,NetEffect,OrderIntent,PreviewResult} from '../types';
import {money} from '../utils';
import {Panel} from './Panel';

export function VerticalBuilder({enabled,adapters}:{enabled:boolean;adapters:Broker[]}){
  const legs=useUi(s=>s.legs);
  const clear=useUi(s=>s.clearLegs);
  const setLegSide=useUi(s=>s.setLegSide);
  const [broker,setBroker]=useState<Broker>('ibkr');
  const [qty,setQty]=useState('1');
  const [limit,setLimit]=useState('');
  const [effect,setEffect]=useState<NetEffect>('debit');
  const [preview,setPreview]=useState<PreviewResult|null>(null);
  const [pending,setPending]=useState(false);
  const [err,setErr]=useState<string|null>(null);
  const [ack,setAck]=useState<string|null>(null);
  const fingerprint=JSON.stringify([legs,broker,qty,limit,effect]);
  useEffect(()=>{setPreview(null);setErr(null);setAck(null);},[fingerprint]);

  const canPreview=useMemo(()=>legs.length===2 && legs[0].side!==legs[1].side
    && Number(qty)>0 && Number.isInteger(Number(qty))
    && Number.isFinite(Number(limit)) && Number(limit)>0,[legs,qty,limit]);
  async function doPreview(){
    setPending(true);setErr(null);setAck(null);
    const payload:OrderIntent={
      broker,environment:'paper',kind:'vertical',symbol:null,
      quantity:Number(qty),limit_price:Number(limit),net_effect:effect,legs
    };
    try{const r=await createPreview(payload);setPreview(r.preview);}
    catch(e){setErr(e instanceof Error?e.message:String(e));}
    finally{setPending(false);}
  }
  async function doSubmit(){
    if(!preview)return;
    if(!window.confirm('确认向 '+broker.toUpperCase()+' Paper 账户发送这笔两腿组合委托？'))return;
    setPending(true);setErr(null);
    try{const result=await submitOrder(preview.preview_id);
      setAck(result.client_order_id+' · '+result.ack.status);
      setPreview(null);
    }catch(e){setErr(e instanceof Error?e.message:String(e));setPreview(null);}
    finally{setPending(false);}
  }

  return <Panel title="两腿垂直期权" kicker="VERTICAL SPREAD / CONTROLLED PAPER"
    aside={<span className={'pill '+(enabled?'pill-warn':'pill-off')}>{enabled?'PAPER 可用':'下单禁用'}</span>}>
    <div className="builder-content">
      <div className="builder-legs">
        {[0,1].map(index=><div className="builder-leg" key={index}>
          <div className="leg-index">{String(index+1).padStart(2,'0')}</div>
          <div className="leg-details"><div>{legs[index]?.symbol??'点击期权链选择合约'}</div>
            <small>{index===0?'主腿':'对冲腿'} · 必须同一到期日/期权类型</small></div>
          {legs[index]&&<select value={legs[index].side}
            onChange={e=>setLegSide(legs[index].symbol,e.target.value as 'buy'|'sell')}>
            <option value="buy">买入</option><option value="sell">卖出</option>
          </select>}
        </div>)}
        <button className="button-text" type="button" onClick={clear}>清空组合</button>
      </div>
      <div className="builder-fields">
        <label>执行券商
          <select value={broker} onChange={e=>setBroker(e.target.value as Broker)}>
            {(['alpaca','ibkr','schwab'] as Broker[]).map(b=><option value={b} key={b}>
              {b.toUpperCase()}{adapters.includes(b)?' · 已配置':' · 未配置'}
            </option>)}
          </select>
        </label>
        <label>张数<input type="number" min="1" step="1" value={qty}
          onChange={e=>setQty(e.target.value)}/></label>
        <label>净额方向<select value={effect} onChange={e=>setEffect(e.target.value as NetEffect)}>
          <option value="debit">Debit / 净支出</option><option value="credit">Credit / 净收入</option>
        </select></label>
        <label>限价（美元/股）<input type="number" min="0.01" step="0.01"
          placeholder="填写组合净价" value={limit} onChange={e=>setLimit(e.target.value)}/></label>
      </div>
      <div className="builder-rules">Paper 模式 · 100 股/合约 · 执行服务二次核验保证金与两腿原子性。</div>
      {err&&<div className="inline-error">{err}</div>}
      {ack&&<div className="notice success">已发送给执行适配器：{ack}。成交状态请以券商对账为准。</div>}
      {preview&&<div className="risk-preview">
        <div><span>预览 ID</span><code>{preview.preview_id.slice(0,8)}…</code></div>
        <div><span>估算最大损失上限</span><strong>USD {money(preview.estimated_max_loss)}</strong></div>
        <div><span>预览有效期</span><span>{new Date(preview.expires_at).toLocaleTimeString('zh-CN')}</span></div>
      </div>}
      <button disabled={pending||!canPreview} type="button" onClick={()=>void doPreview()}
        className="primary-button">① 风控预览</button>
      <button disabled={pending||!preview||!enabled||!adapters.includes(broker)}
        type="button" onClick={()=>void doSubmit()} className="danger-button">② 确认 Paper 委托</button>
      {!enabled&&<div className="metric-footnote">需后端显式配置 EQO_EXECUTION_MODE=paper；当前保持只读。</div>}
      {enabled&&!adapters.includes(broker)&&<div className="metric-footnote">尚未配置 {broker.toUpperCase()} Rust 执行服务 URL。</div>}
    </div>
  </Panel>;
}
