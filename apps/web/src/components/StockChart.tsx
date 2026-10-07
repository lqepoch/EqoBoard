import {useEffect,useRef} from 'react';
import {CandlestickSeries,ColorType,createChart,type UTCTimestamp} from 'lightweight-charts';
import {useMarket} from '../state';
import type {BarsResponse} from '../types';
import {Panel} from './Panel';

export function StockChart({data,loading,error,timeframe,onTimeframe,selected}:{
  data:BarsResponse|undefined;loading:boolean;error:string|null;
  timeframe:string;onTimeframe:(v:string)=>void;selected:string;
}){
  const node=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!node.current || !data?.bars.length) return;
    const chart=createChart(node.current,{
      layout:{background:{type:ColorType.Solid,color:'#0c1723'},textColor:'#91a8bf',fontSize:11},
      width:node.current.clientWidth,height:node.current.clientHeight,
      grid:{vertLines:{color:'#1a2937'},horzLines:{color:'#1a2937'}},
      rightPriceScale:{borderColor:'#243748'},
      timeScale:{borderColor:'#243748',timeVisible:true,secondsVisible:false}
    });
    const candle=chart.addSeries(CandlestickSeries,{
      upColor:'#20be98',downColor:'#f1768f',
      borderUpColor:'#20be98',borderDownColor:'#f1768f',
      wickUpColor:'#20be98',wickDownColor:'#f1768f'
    });
    const initial=data.bars.map(bar=>({
      time:Math.floor(new Date(bar.time).getTime()/1000) as UTCTimestamp,
      open:bar.open,high:bar.high,low:bar.low,close:bar.close
    })).filter(bar=>Number.isFinite(bar.time)).sort((a,b)=>a.time-b.time);
    candle.setData(initial);
    chart.timeScale().fitContent();
    const obs=new ResizeObserver(()=>{
      if(node.current) chart.resize(node.current.clientWidth,node.current.clientHeight);
    });
    obs.observe(node.current);
    let last=initial.at(-1);
    const unsubscribe=useMarket.subscribe((now,before)=>{
      if(before.revision===now.revision || timeframe!=='1Min') return;
      for(const event of now.lastBatch){
        if(event.kind!=='stock_trade' || event.symbol!==selected) continue;
        const time=(Math.floor(new Date(event.timestamp).getTime()/60_000)*60) as UTCTimestamp;
        if(!Number.isFinite(time) || !last || time<last.time) continue;
        last=time===last.time?
          {...last,high:Math.max(last.high,event.price),low:Math.min(last.low,event.price),
            close:event.price}:
          {time,open:event.price,high:event.price,low:event.price,close:event.price};
        candle.update(last);
      }
    });
    return ()=>{unsubscribe();obs.disconnect();chart.remove()};
  },[data,selected,timeframe]);
  return <Panel title={selected+' 价格走势'} kicker={'ALPACA / '+(data?.feed??'SIP').toUpperCase()}
    aside={<div className="segmented">
      {['1Min','5Min','15Min','1Hour','1Day'].map(v=><button key={v}
        className={v===timeframe?'active':''} type="button" onClick={()=>onTimeframe(v)}>
        {v.replace('Min','m').replace('Hour','h').replace('Day','D')}</button>)}
    </div>}>
    <div className="chart-container">
      {loading&&<div className="chart-overlay subtle">正在加载真实 SIP K 线…</div>}
      {error&&<div className="chart-overlay inline-error">{error}</div>}
      {!data?.bars.length&&!loading&&!error&&<div className="chart-overlay subtle">此时间窗口无 K 线数据</div>}
      <div ref={node} className="chart-canvas"/>
    </div>
  </Panel>;
}
