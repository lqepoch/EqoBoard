import {useMarket} from '../state';
import {money,humanTime} from '../utils';
import {Panel} from './Panel';
export function ActivityTape(){
  const trades=useMarket(s=>s.recentTrades);
  return <Panel title="期权逐笔成交" kicker="OPRA / TAPE" aside={<span className="subtle">最多保留 150 笔</span>}>
    <div className="tape-header"><span>时间 ET</span><span>合约</span><span>价格</span><span>张数</span></div>
    <div className="tape-list">
      {trades.length?trades.slice(0,35).map((trade,index)=><div className="tape-row" key={trade.timestamp+trade.symbol+index}>
        <span>{humanTime(trade.timestamp).replace(' ET','')}</span>
        <span className="tape-contract" title={trade.symbol}>{trade.symbol}</span>
        <strong>{money(trade.price)}</strong><span>{trade.size}</span>
      </div>):<div className="empty-state">暂无当前订阅合约的 OPRA 逐笔成交</div>}
    </div>
    <div className="metric-footnote">逐笔成交来自真实 TradeEvent，未推断买卖主动方向。</div>
  </Panel>;
}
