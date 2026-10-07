import type {StockSnapshot} from '../types';
import {useMarket,useUi} from '../state';
import {compact,money,humanTime} from '../utils';
import {Panel} from './Panel';

export function QuoteList({stocks,loading,error}:{
  stocks:StockSnapshot[];loading:boolean;error:string|null;
}){
  const selected=useUi(s=>s.selectedSymbol);
  const setSymbol=useUi(s=>s.setSymbol);
  const quotes=useMarket(s=>s.stockEvents);
  return <Panel title="自选与行情" kicker="US EQUITIES / SIP" className="watchlist-panel"
    aside={<span className="subtle">{loading?'更新中':'自动刷新'}</span>}>
    <div className="watchlist-header"><span>代码</span><span>最新价</span><span>涨跌幅</span></div>
    {error&&<div className="inline-error">SIP 获取失败：{error}</div>}
    {!stocks.length && !error&&<div className="empty-state">暂无行情。填写后端密钥并确认 SIP 授权。</div>}
    {stocks.map(stock=>{
      const live=quotes[stock.symbol];
      const last=live?.kind==='stock_trade'?live.price:stock.last;
      const change=last!=null&&stock.previous_close&&stock.previous_close>0?
        (last/stock.previous_close-1)*100:stock.change_percent;
      return <button type="button" onClick={()=>setSymbol(stock.symbol)}
        className={'watchlist-row '+(stock.symbol===selected?'selected':'')} key={stock.symbol}
        title={'行情时间 '+humanTime(live?.timestamp??stock.updated_at)}>
        <span className="stock-code">{stock.symbol}<small>{stock.feed.toUpperCase()}</small></span>
        <span className="stock-price">{money(last)}</span>
        <span className={'stock-change '+(change==null?'':change>=0?'positive':'negative')}>
          {change==null?'—':(change>=0?'+':'')+money(change)+'%'}
        </span>
      </button>;
    })}
    <div className="watchlist-footer"><span>报价源: Alpaca SIP</span><span>美东时间</span></div>
    <div className="watchlist-note">实时 WS 默认订阅服务端 EQO_STOCK_SYMBOLS；其他输入代码可查询 SIP 快照。</div>
    <div className="watchlist-footer"><span>自选标的</span><span>{stocks.length} 个</span></div>
    {stocks.length>0&&<div className="watchlist-notional">
      <span>当日成交量（所选）</span>
      <strong>{compact(stocks.find(s=>s.symbol===selected)?.volume)}</strong>
    </div>}
  </Panel>;
}
