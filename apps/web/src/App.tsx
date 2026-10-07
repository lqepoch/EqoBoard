import {useEffect,useMemo,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import ReactGridLayout,{useContainerWidth,verticalCompactor,type Layout} from 'react-grid-layout';
import {Activity,BarChart3,Database,Layers,LayoutDashboard,Search,
  Settings2,ShieldCheck,Wifi,WifiOff,RefreshCw,AlertTriangle} from 'lucide-react';
import {getBars,getChain,getStatus,getStocks,getToken,setToken} from './api';
import {useMarket,useUi,type Page} from './state';
import {humanTime,money} from './utils';
import {useMarketStream} from './hooks/useMarketStream';
import {Panel} from './components/Panel';
import {QuoteList} from './components/QuoteList';
import {StockChart} from './components/StockChart';
import {OptionChain} from './components/OptionChain';
import {VolatilityChart} from './components/VolatilityChart';
import {ActivityTape} from './components/ActivityTape';
import {VerticalBuilder} from './components/VerticalBuilder';

const DEFAULT_LAYOUT:Layout=[
  {i:'watch',x:0,y:0,w:3,h:5,minW:2,minH:3},
  {i:'chart',x:3,y:0,w:6,h:5,minW:3,minH:3},
  {i:'builder',x:9,y:0,w:3,h:5,minW:3,minH:4},
  {i:'chain',x:0,y:5,w:8,h:8,minW:6,minH:4},
  {i:'iv',x:8,y:5,w:4,h:4,minW:3,minH:3},
  {i:'tape',x:8,y:9,w:4,h:4,minW:3,minH:3}
];
const TABS:{id:Page;name:string;icon:typeof LayoutDashboard}[]=[
  {id:'overview',name:'综合交易台',icon:LayoutDashboard},
  {id:'stocks',name:'股票行情',icon:BarChart3},
  {id:'options',name:'期权链',icon:Layers},
  {id:'vertical',name:'垂直价差',icon:ShieldCheck},
  {id:'system',name:'系统状态',icon:Settings2}
];
function readLayout():Layout{
  try{
    const parsed:unknown=JSON.parse(localStorage.getItem('eqoboard:layout-v1')||'null');
    if(Array.isArray(parsed) && parsed.length===DEFAULT_LAYOUT.length &&
      parsed.every(p=>p&&typeof p.i==='string' && DEFAULT_LAYOUT.some(d=>d.i===p.i) &&
        ['x','y','w','h'].every(k=>Number.isInteger(p[k]) && p[k]>=0 && p[k]<100))) {
      return parsed as Layout;
    }
  }catch{/* corrupted/old layout -> default */}
  return DEFAULT_LAYOUT;
}
function SystemPanel({statusError}:{statusError:string|null}){
  const status=useQuery({queryKey:['status'],queryFn:getStatus,refetchInterval:30_000});
  const feedStatus=useMarket(s=>s.feedStatus);
  const connected=useMarket(s=>s.connected);
  const [tokenDraft,setTokenDraft]=useState(getToken);
  return <Panel title="系统和数据源" kicker="HEALTH / SECURITY / ENTITLEMENTS">
    <div className="system-panel">
      <div className="system-grid">
        <div><small>Alpaca 凭据</small><strong>{status.data?.market_credentials_present?'已加载到网关':'未配置/不可用'}</strong></div>
        <div><small>股票数据源</small><strong>{status.data?.stock_feed.toUpperCase()??'SIP'}</strong></div>
        <div><small>期权数据源</small><strong>{status.data?.option_feed.toUpperCase()??'OPRA'}</strong></div>
        <div><small>WebSocket</small><strong>{connected?'浏览器在线':'断开'}</strong></div>
        <div><small>股票上游</small><strong>{feedStatus.stocks??'未知'}</strong></div>
        <div><small>期权上游</small><strong>{feedStatus.options??'未知'}</strong></div>
        <div><small>交易门闩</small><strong>{status.data?.execution_mode??'disabled'}</strong></div>
        <div><small>OPRA 活动订阅</small><strong>{status.data?.active_option_subscriptions??0} / {status.data?.max_option_subscriptions??500}</strong></div>
      </div>
      <h3>券商执行服务</h3>
      <div className="adapter-status">{(['alpaca','ibkr','schwab'] as const).map(b=><span key={b}>
        {b.toUpperCase()} <b className={status.data?.configured_adapters.includes(b)?'positive':'subtle'}>
          {status.data?.configured_adapters.includes(b)?'配置完成':'未配置'}
        </b></span>)}</div>
      <h3>API 访问令牌</h3>
      <p className="subtle">仅供本地/测试使用；Token 存储在当前浏览器会话中，不参与构建。公开部署应使用 OIDC 和 HTTPS。</p>
      <div className="token-entry"><input type="password" placeholder="EQO_ACCESS_TOKEN"
        value={tokenDraft} onChange={e=>setTokenDraft(e.target.value)}/>
        <button type="button" className="secondary-button" onClick={()=>{setToken(tokenDraft);window.location.reload()}}>应用并重新连接</button>
      </div>
      {statusError&&<div className="inline-error">{statusError}</div>}
      <p className="metric-footnote">配置数据源 ≠ 已验证实时授权；403/429 以 Alpaca 原始权限/限流结果为准。订单执行适配器仍需独立 Paper 验收。</p>
    </div>
  </Panel>;
}
function Workspace({elements}:{elements:Record<string,React.ReactNode>}){
  const {width,containerRef,mounted}=useContainerWidth();
  const [layout,setLayout]=useState<Layout>(readLayout);
  return <div ref={containerRef} className="workspace-container">
    {mounted&&<ReactGridLayout width={width} layout={layout}
      gridConfig={{cols:12,rowHeight:57,margin:[12,12],containerPadding:[0,0]}}
      dragConfig={{enabled:true,handle:'.panel-handle',cancel:'button,input,select'}}
      resizeConfig={{enabled:true}}
      compactor={verticalCompactor}
      onLayoutChange={(next)=>{setLayout(next);localStorage.setItem('eqoboard:layout-v1',JSON.stringify(next));}}>
      {Object.entries(elements).map(([key,child])=><div key={key} className="widget-shell">{child}</div>)}
    </ReactGridLayout>}
  </div>;
}
function CurrentTime(){
  const [now,setNow]=useState(new Date());
  useEffect(()=>{const timer=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(timer)},[]);
  return <span className="exchange-clock">{humanTime(now.toISOString())}</span>;
}
export function App(){
  const queryClient=useQueryClient();
  const page=useUi(s=>s.page);
  const setPage=useUi(s=>s.setPage);
  const symbol=useUi(s=>s.selectedSymbol);
  const setSymbol=useUi(s=>s.setSymbol);
  const expiration=useUi(s=>s.expiration);
  const setExpiration=useUi(s=>s.setExpiration);
  const [input,setInput]=useState(symbol);
  const [timeframe,setTimeframe]=useState('1Min');
  const status=useQuery({queryKey:['status'],queryFn:getStatus,refetchInterval:30_000});
  useMarketStream(status.data?.market_credentials_present===true);
  const connected=useMarket(s=>s.connected);
  const streamError=useMarket(s=>s.error);
  const universe=useMemo(()=>[...new Set([...(status.data?.stock_symbols??['SPY','QQQ','IWM','NVDA','TSLA']),symbol])],
    [status.data?.stock_symbols,symbol]);
  const stocks=useQuery({queryKey:['stocks',universe.join(',')],queryFn:()=>getStocks(universe),
    enabled:status.data?.market_credentials_present===true,refetchInterval:15_000});
  const selectedStock=stocks.data?.snapshots.find(s=>s.symbol===symbol);
  const live=useMarket(s=>s.stockEvents[symbol]);
  const last=live?.kind==='stock_trade'?live.price:selectedStock?.last;
  const previous=selectedStock?.previous_close;
  const change=last!=null&&previous!=null&&previous>0?(last/previous-1)*100:null;
  const bars=useQuery({queryKey:['bars',symbol,timeframe],queryFn:()=>getBars(symbol,timeframe),
    enabled:status.data?.market_credentials_present===true&&page!=='system',
    refetchInterval:30_000});
  const range=last!=null&&last>0?{gte:Math.max(0.01,Math.floor(last*0.85/5)*5),
    lte:Math.ceil(last*1.15/5)*5}:undefined;
  const rangeKey=range?range.gte+':'+range.lte:'all';
  const chain=useQuery({queryKey:['options',symbol,expiration,rangeKey],
    queryFn:()=>getChain(symbol,expiration,range),
    enabled:status.data?.market_credentials_present===true&&!['system','stocks'].includes(page),
    refetchInterval:30_000});
  const statusError=status.error?.message??null;
  const stocksError=stocks.error?.message??null;
  const barsError=bars.error?.message??null;
  const chainError=chain.error?.message??null;
  const widgets={
    watch:<QuoteList stocks={stocks.data?.snapshots??[]} loading={stocks.isFetching} error={stocksError}/>,
    chart:<StockChart selected={symbol} data={bars.data} loading={bars.isFetching} error={barsError}
      timeframe={timeframe} onTimeframe={setTimeframe}/>,
    chain:<OptionChain data={chain.data} loading={chain.isFetching} error={chainError}
      spot={last} maxSubscriptions={status.data?.max_option_subscriptions??500}/>,
    iv:<VolatilityChart contracts={chain.data?.contracts??[]} truncated={chain.data?.truncated??false}/>,
    tape:<ActivityTape/>,
    builder:<VerticalBuilder enabled={status.data?.execution_mode==='paper'}
      adapters={status.data?.configured_adapters??[]}/>
  };
  const submitSymbol=(e:React.FormEvent)=>{
    e.preventDefault();
    const next=input.trim().toUpperCase();
    if(/^[A-Z][A-Z.-]{0,11}$/.test(next))setSymbol(next);
  };
  return <div className="eqo-app">
    <aside className="navigation">
      <div className="brand-mark" title="EqoBoard">EQ</div>
      <div className="nav-items">
        {TABS.map(({id,name,icon:Icon})=><button type="button" key={id}
          className={'nav-link '+(page===id?'active':'')} title={name} onClick={()=>setPage(id)}>
          <Icon size={20}/><span>{name}</span></button>)}
      </div>
      <div className="nav-bottom"><Database size={19}/><small>v0.1</small></div>
    </aside>
    <div className="main-area">
      <header className="top-header">
        <div className="brand-name">Eqo<span>Board</span><small>MARKET TERMINAL</small></div>
        <div className="header-search">
          <form onSubmit={submitSymbol}><Search size={16}/>
            <input aria-label="查询美股标的" value={input} onChange={e=>setInput(e.target.value)}
              placeholder="输入股票代码"/><kbd>↵</kbd>
          </form>
        </div>
        <div className="header-right">
          <div className="feed-pills"><span className="source-tag">STOCKS: {status.data?.stock_feed.toUpperCase()??'SIP'}</span>
            <span className="source-tag option-tag">OPTIONS: {status.data?.option_feed.toUpperCase()??'OPRA'}</span></div>
          <div className={'connection '+(connected?'online':'offline')}>
            {connected?<Wifi size={14}/>:<WifiOff size={14}/>}
            {connected?'STREAM ONLINE':'STREAM OFFLINE'}
          </div>
          <CurrentTime/>
        </div>
      </header>
      <main className="content">
        <div className="page-heading">
          <div><div className="eyebrow">EQO / {page.toUpperCase()} / US MARKETS</div>
            <h1>{TABS.find(t=>t.id===page)?.name}</h1></div>
          <button type="button" className="refresh-button" onClick={()=>void queryClient.invalidateQueries()}>
            <RefreshCw size={15}/> 刷新快照
          </button>
        </div>
        {statusError&&<div className="banner critical"><AlertTriangle size={17}/>网关异常：{statusError} · 请检查启动状态或访问令牌。</div>}
        {status.data&&!status.data.market_credentials_present&&<div className="banner critical">
          <AlertTriangle size={17}/> 未读取到 ALPACA_KEY / ALPACA_SECRET。行情功能关闭，当前页面没有模拟数据。
        </div>}
        {streamError&&status.data?.market_credentials_present&&<div className="banner warning">
          <AlertTriangle size={16}/>{streamError}。行情数据可能过时，订单执行服务必须重新取价。
        </div>}
        {page!=='system'&&<div className="market-toolbar">
          <div className="instrument"><span className="instrument-icon">{symbol.slice(0,1)}</span>
            <div><strong>{symbol}</strong><small>US EQUITY · ALPACA SIP</small></div></div>
          <strong className="instrument-price">{money(last)}</strong>
          <span className={'instrument-change '+(change==null?'':change>=0?'positive':'negative')}>
            {change==null?'—':(change>=0?'+':'')+money(change)+'%'}
          </span>
          <div className="toolbar-spacer"/>
          {(page==='overview'||page==='options'||page==='vertical')&&<label className="expiration-picker">
            <span>到期日 / EXPIRATION</span>
            <input type="date" value={expiration} onChange={e=>setExpiration(e.target.value)}/>
          </label>}
          <span className="asof">行情时间：{humanTime(live?.timestamp??selectedStock?.updated_at)}</span>
        </div>}
        {page==='overview'&&<Workspace elements={widgets}/>}
        {page==='stocks'&&<div className="focused-layout two-col">
          {widgets.watch}{widgets.chart}
        </div>}
        {page==='options'&&<div className="focused-layout options-layout">
          {widgets.chain}{widgets.iv}{widgets.tape}
        </div>}
        {page==='vertical'&&<div className="focused-layout vertical-layout">
          {widgets.chain}{widgets.builder}{widgets.tape}
        </div>}
        {page==='system'&&<SystemPanel statusError={statusError}/>}
        <footer className="terminal-footer"><Activity size={13}/>
          <span>EqoBoard · {new Date().getFullYear()}</span>
          <span>报价用于信息展示，非交易确认 · 数据权属 Alpaca/交易所</span>
          <span>全部时间戳按原始消息，页面时间显示 ET</span>
        </footer>
      </main>
    </div>
  </div>;
}
