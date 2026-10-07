/**
 * Adapted from ErTasselli/OpenTerminal web/components/Workspace.tsx (MIT),
 * commit aed097c680cd8ec1c391ae06966babe7d6d91fc6.
 * EqoBoard changes: react-grid-layout v2, Alpine SIP/OPRA-safe widget renderer,
 * compact symbol-link controls and typed widget registry.
 */
import {useEffect,useRef,useState,type ReactNode} from 'react';
import ReactGridLayout,{useContainerWidth,verticalCompactor} from 'react-grid-layout';
import {Link2,Link2Off,Plus,RotateCcw,X,Search} from 'lucide-react';
import {normalizeSymbol} from './symbol';
import {useTerminal,useWidgetSymbol,type WidgetInstance,type WidgetType} from './store';
import {OpenTerminalCommandPalette} from './CommandPalette';
import './workspace.css';

const TITLES:Record<WidgetType,string>={
  quote:'股票行情',chart:'价格图表',watchlist:'自选股',
  options:'OPRA 期权链',iv:'IV Skew',tape:'逐笔成交',vertical:'垂直价差'
};
const SHORTCUTS:readonly WidgetType[]=[
  'chart','quote','watchlist','options','iv','tape','vertical'
];
export const OPEN_TERMINAL_WIDGET_TYPES=Object.keys(TITLES) as WidgetType[];

function SymbolTag({widget,activeSymbol}:{widget:WidgetInstance;activeSymbol:string}){
  const update=useTerminal(s=>s.setWidgetSymbol);
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState('');
  const input=useRef<HTMLInputElement>(null);
  const shown=widget.linked?activeSymbol:(widget.symbol??activeSymbol);
  useEffect(()=>{
    if(editing){setDraft(shown);requestAnimationFrame(()=>input.current?.select());}
  },[editing,shown]);
  if(editing) return <input ref={input} aria-label="Widget ticker"
    className="ot-symbol-input" value={draft} onChange={e=>setDraft(e.target.value.toUpperCase())}
    onMouseDown={e=>e.stopPropagation()}
    onKeyDown={e=>{
      if(e.key==='Enter'){
        const ticker=normalizeSymbol(draft);
        if(ticker) update(widget.id,ticker);
        setEditing(false);
      }
      if(e.key==='Escape')setEditing(false);
    }} onBlur={()=>setEditing(false)}/>;
  return <button type="button" className="ot-symbol-tag" title="点击固定该 Widget 的股票代码"
    onMouseDown={e=>e.stopPropagation()} onClick={()=>setEditing(true)}>
    {shown}
  </button>;
}
function Frame({widget,render}:{widget:WidgetInstance;render:(widget:WidgetInstance,symbol:string)=>ReactNode}){
  const symbol=useWidgetSymbol(widget);
  const remove=useTerminal(s=>s.removeWidget);
  const toggle=useTerminal(s=>s.toggleLinked);
  return <div className="ot-panel-frame">
    <div className="ot-panel-controls">
      <div className="ot-panel-drag">
        <span className="ot-panel-name">{TITLES[widget.type]}</span>
        {['quote','chart','options','iv','vertical'].includes(widget.type)&&
          <SymbolTag widget={widget} activeSymbol={symbol}/>}
      </div>
      <div className="ot-panel-buttons">
        {['quote','chart','options','iv'].includes(widget.type)&&
          <button type="button" title={widget.linked?'取消全局联动':'恢复全局联动'}
            onMouseDown={e=>e.stopPropagation()} onClick={()=>toggle(widget.id)}>
            {widget.linked?<Link2 size={13}/>:<Link2Off size={13}/>}
          </button>}
        <button type="button" aria-label={'移除'+TITLES[widget.type]} onMouseDown={e=>e.stopPropagation()}
          title="关闭 Widget" onClick={()=>remove(widget.id)}><X size={13}/></button>
      </div>
    </div>
    <div className="ot-panel-content">{render(widget,symbol)}</div>
  </div>;
}

/** OpenTerminal-derived widget registry & persistence, injected EqoBoard renderers. */
export function OpenTerminalWorkspace({render}:{render:(widget:WidgetInstance,symbol:string)=>ReactNode}){
  const {width,containerRef,mounted}=useContainerWidth();
  const widgets=useTerminal(s=>s.widgets);
  const layout=useTerminal(s=>s.layout);
  const setLayout=useTerminal(s=>s.setLayout);
  const addWidget=useTerminal(s=>s.addWidget);
  const resetWorkspace=useTerminal(s=>s.resetWorkspace);
  const setCommandOpen=useTerminal(s=>s.setCommandOpen);
  useEffect(()=>{
    const handle=(event:KeyboardEvent)=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){
        event.preventDefault();
        setCommandOpen(true);
      }
      if(event.altKey&&/^[1-7]$/.test(event.key)){
        event.preventDefault();addWidget(SHORTCUTS[Number(event.key)-1]);
      }
    };
    window.addEventListener('keydown',handle);
    return()=>window.removeEventListener('keydown',handle);
  },[addWidget,setCommandOpen]);
  return <>
    <div className="ot-toolbar">
      <span>OPEN TERMINAL WORKSPACE</span>
      <label className="ot-add"><Plus size={14}/>
        <select aria-label="添加模块" defaultValue="" onChange={event=>{
          const type=event.currentTarget.value as WidgetType;
          if(type)addWidget(type);
          event.currentTarget.value='';
        }}>
          <option value="">添加模块</option>
          {OPEN_TERMINAL_WIDGET_TYPES.map(type=><option key={type} value={type}>{TITLES[type]}</option>)}
        </select>
      </label>
      <button type="button" onClick={()=>setCommandOpen(true)} title="Ctrl/⌘+K 搜索股票">
        <Search size={14}/> 搜索 Ctrl K
      </button>
      <button type="button" title="恢复默认布局" onClick={()=>{
        if(window.confirm('恢复初始工作台布局？'))resetWorkspace();
      }}><RotateCcw size={14}/> 重置</button>
    </div>
    <div ref={containerRef} className="workspace-container ot-workspace">
      {mounted&&<ReactGridLayout width={width} layout={layout}
        gridConfig={{cols:12,rowHeight:57,margin:[12,12],containerPadding:[0,0]}}
        dragConfig={{enabled:true,handle:'.ot-panel-drag',cancel:'button,input,select'}}
        resizeConfig={{enabled:true}} compactor={verticalCompactor}
        onLayoutChange={next=>setLayout(next.map(({i,x,y,w,h})=>({i,x,y,w,h})))}>
        {widgets.map(widget=><div className="widget-shell" key={widget.id}>
          <Frame widget={widget} render={render}/>
        </div>)}
      </ReactGridLayout>}
    </div>
    <OpenTerminalCommandPalette/>
  </>;
}
