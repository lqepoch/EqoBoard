import {useMarket} from '../state';
import {humanTime,money,compact} from '../utils';
import type {StockSnapshot} from '../types';
import {Panel} from './Panel';

export function QuoteSummary({symbol,quote,loading,error}:{symbol:string;quote:StockSnapshot|undefined;
  loading:boolean;error:string|null}){
  const live=useMarket(s=>s.stockEvents[symbol]);
  const last=live?.kind==='stock_trade'?live.price:quote?.last;
  const bbo=live?.kind==='stock_quote'?live:{bid:quote?.bid,ask:quote?.ask};
  const change=last!=null&&quote?.previous_close!=null&&quote.previous_close>0
    ?(last/quote.previous_close-1)*100:null;
  return <Panel title={symbol+' 行情快照'} kicker={'ALPACA · '+(quote?.feed?.toUpperCase()??'SIP')}>
    {error&&<div className="inline-error">{error}</div>}
    {!quote&&!error&&<div className="empty-state">{loading?'正在加载 SIP 数据':'没有可用报价'}</div>}
    {quote&&<div className="ot-quote-summary">
      <div className="ot-quote-main"><strong>{money(last)}</strong>
        <span className={change!=null&&change>=0?'positive':'negative'}>
          {change==null?'—':(change>=0?'+':'')+money(change)+'%'}</span></div>
      <div className="ot-quote-metrics">
        <div><span>Bid</span><b>{money(bbo.bid)}</b></div>
        <div><span>Ask</span><b>{money(bbo.ask)}</b></div>
        <div><span>昨收</span><b>{money(quote.previous_close)}</b></div>
        <div><span>成交量</span><b>{compact(quote.volume)}</b></div>
      </div>
      <div className="metric-footnote">真实 SIP · 报价时间 {humanTime(live?.timestamp??quote.updated_at)}</div>
    </div>}
  </Panel>;
}
