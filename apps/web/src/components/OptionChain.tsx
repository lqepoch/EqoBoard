import {useEffect,useMemo,useRef,useState} from 'react';
import {AgGridReact} from 'ag-grid-react';
import {
  AllCommunityModule,ModuleRegistry,themeQuartz,
  type ColDef,type ColGroupDef,type CellClickedEvent
} from 'ag-grid-community';
import {useMarket,useUi} from '../state';
import {postOptions} from '../api';
import type {OptionChainResponse,OptionContract,OptionRow} from '../types';
import {buildOptionRows,money,mid} from '../utils';
import {Panel} from './Panel';

ModuleRegistry.registerModules([AllCommunityModule]);
const theme=themeQuartz.withParams({
  backgroundColor:'#0c1723',
  foregroundColor:'#d7e4f0',
  headerBackgroundColor:'#102031',
  headerTextColor:'#9db3c6',
  accentColor:'#53a4ff',
  oddRowBackgroundColor:'#0e1b29',
  rowHoverColor:'#1a3448',
  borderColor:'#203447',
  fontSize:11,
  cellHorizontalPadding:8
});
type Side='call'|'put';
type NumericField='bid'|'ask'|'last'|'iv'|'delta'|'gamma'|'theta'|'vega';
function metric(side:Side,key:NumericField,title:string,width:number):ColDef<OptionRow>{
  return {colId:side+'.'+key,headerName:title,width,minWidth:width-15,
    sortable:true,filter:false,
    valueGetter:p=> {
      const contract=p.data?.[side];
      if(!contract) return null;
      return key==='iv' && contract.iv!=null ? contract.iv*100 : contract[key];
    },
    valueFormatter:p=>money(p.value, key==='delta'||key==='gamma'||key==='theta'||key==='vega'?3:2),
    cellClass:key==='bid'?'bid-cell':key==='ask'?'ask-cell':'number-cell'
  };
}
function columns():Array<ColDef<OptionRow>|ColGroupDef<OptionRow>>{
  return [
    {headerName:'CALL · 看涨',headerClass:'calls-header',children:[
      metric('call','delta','Δ',65),metric('call','iv','IV %',80),
      metric('call','last','最新',76),metric('call','bid','Bid',80),metric('call','ask','Ask',80)
    ]},
    {headerName:'执行价',field:'strike',colId:'strike',width:90,
      cellClass:'strike-cell',valueFormatter:p=>money(p.value,0)},
    {headerName:'PUT · 看跌',headerClass:'puts-header',children:[
      metric('put','bid','Bid',80),metric('put','ask','Ask',80),
      metric('put','last','最新',76),metric('put','iv','IV %',80),metric('put','delta','Δ',65)
    ]}
  ];
}
export function OptionChain({data,spot,error,loading,maxSubscriptions}:{
  data:OptionChainResponse|undefined;spot:number|null|undefined;
  error:string|null;loading:boolean;maxSubscriptions:number;
}){
  const active=useUi(s=>s.activeContract);
  const selectContract=useUi(s=>s.selectContract);
  const [subscriptionError,setSubscriptionError]=useState<string|null>(null);
  const ref=useRef<AgGridReact<OptionRow>>(null);
  const consumerId=useRef(crypto.randomUUID());
  const contracts=useMemo(()=>data?.contracts??[],[data]);
  const rows=useMemo(()=>buildOptionRows(contracts),[contracts]);
  const defs=useMemo(()=>columns(),[]);
  const index=useMemo(()=>{
    const map=new Map<string,{strike:number;side:Side}>();
    for(const c of contracts)map.set(c.symbol,{strike:c.strike,side:c.right});
    return map;
  },[contracts]);

  useEffect(()=>{
    if(!data?.contracts.length) return;
    const ranked=[...data.contracts].sort((a,b)=>
      (spot==null?0:Math.abs(a.strike-spot)-Math.abs(b.strike-spot)));
    const symbols=ranked.slice(0,Math.min(500,maxSubscriptions)).map(c=>c.symbol);
    let disposed=false;
    async function renew(){
      try{await postOptions(consumerId.current,symbols);if(!disposed)setSubscriptionError(null);}
      catch(e){if(!disposed)setSubscriptionError(e instanceof Error?e.message:String(e));}
    }
    void renew();
    const timer=setInterval(()=>void renew(),30_000);
    return ()=>{disposed=true;clearInterval(timer)};
  },[data,maxSubscriptions,spot]);

  useEffect(()=>{
    return useMarket.subscribe((now,previous)=>{
      if(now.revision===previous.revision||!ref.current?.api) return;
      const grid=ref.current.api;
      const updates=new Map<number,OptionRow>();
      for(const event of now.lastBatch){
        if(event.kind!=='option_quote') continue;
        const loc=index.get(event.symbol);
        if(!loc) continue;
        const baseline=updates.get(loc.strike)??grid.getRowNode(String(loc.strike))?.data;
        const contract=baseline?.[loc.side];
        if(!baseline||!contract) continue;
        const changed:OptionContract={...contract,bid:event.bid,ask:event.ask,
          bid_size:event.bid_size,ask_size:event.ask_size,updated_at:event.timestamp};
        updates.set(loc.strike,{...baseline,[loc.side]:changed});
      }
      if(updates.size) grid.applyTransactionAsync({update:[...updates.values()]});
    });
  },[index]);
  const onCell=(ev:CellClickedEvent<OptionRow>)=>{
    const side=ev.column.getColId().split('.')[0] as Side;
    if((side!=='put' && side!=='call')||!ev.data?.[side])return;
    selectContract(ev.data[side]!);
  };
  return <Panel title="美股期权链" kicker={'OPRA / '+(data?.underlying??'—')+' / '+(data?.expiration??'—')}
    className="chain-panel" aside={<div className="chain-info">
      <span>{rows.length} 个执行价</span>
      {data?.truncated&&<strong className="negative">⚠ 分页截断</strong>}
      {loading&&<span>加载中</span>}
    </div>}>
    {error&&<div className="inline-error">OPRA 期权链失败：{error}</div>}
    {subscriptionError&&<div className="inline-error">实时订阅受限：{subscriptionError}</div>}
    <div className="grid-host">
      <AgGridReact<OptionRow>
        ref={ref} theme={theme} rowData={rows} columnDefs={defs}
        getRowId={p=>String(p.data.strike)}
        defaultColDef={{resizable:true,sortable:true}}
        animateRows={false} suppressCellFocus
        rowHeight={33} headerHeight={31} groupHeaderHeight={30}
        onCellClicked={onCell} rowSelection={{mode:'singleRow',enableClickSelection:false}}
        getRowClass={p=>{
          if(spot==null||p.data==null)return '';
          return Math.abs(p.data.strike-spot)<0.51?'at-money-row':'';
        }}
        overlayNoRowsTemplate='<span class="grid-empty">无该日期期权数据，请选择到期日或检查 OPRA 权限</span>'
      />
    </div>
    <div className="chain-footer">
      <span>点击 CALL/PUT 单元格：加入两腿组合</span>
      <span>当前合约：{active?.symbol??'未选'}</span>
      <span>报价中值：{active?money(mid(active)):'—'}</span>
    </div>
  </Panel>;
}
