/**
 * Adapted from ErTasselli/OpenTerminal web/components/CommandPalette.tsx
 * (MIT; aed097c680cd8ec1c391ae06966babe7d6d91fc6).
 * EqoBoard does not call OpenTerminal's unlicensed/free search providers.
 * User-entered US stock ticker and current watchlist only.
 */
import {useEffect,useMemo,useRef,useState} from 'react';
import {useTerminal} from './store';
import {normalizeSymbol} from './symbol';

export function OpenTerminalCommandPalette(){
  const open=useTerminal(s=>s.commandOpen);
  const setOpen=useTerminal(s=>s.setCommandOpen);
  const setActiveSymbol=useTerminal(s=>s.setActiveSymbol);
  const addToWatchlist=useTerminal(s=>s.addToWatchlist);
  const watchlist=useTerminal(s=>s.watchlist);
  const [query,setQuery]=useState('');
  const [selected,setSelected]=useState(0);
  const input=useRef<HTMLInputElement>(null);
  const symbols=useMemo(()=>{
    const typed=normalizeSymbol(query);
    const options=[...new Set([...(typed?[typed]:[]),...watchlist])];
    return options.filter(s=>query? s.includes(query.trim().toUpperCase()):true).slice(0,15);
  },[query,watchlist]);
  useEffect(()=>{
    if(open){
      setQuery('');setSelected(0);
      const timer=setTimeout(()=>input.current?.focus(),20);
      return()=>clearTimeout(timer);
    }
  },[open]);
  useEffect(()=>setSelected(0),[symbols.length]);
  if(!open)return null;
  const pick=(value:string,watch:boolean)=>{
    const symbol=normalizeSymbol(value);
    if(!symbol)return;
    setActiveSymbol(symbol);
    if(watch)addToWatchlist(symbol);
    setOpen(false);
  };
  return <div className="ot-palette-overlay" role="presentation" onMouseDown={()=>setOpen(false)}>
    <div className="ot-palette" role="dialog" aria-modal="true" aria-label="搜索股票代码"
      onMouseDown={e=>e.stopPropagation()}>
      <div className="ot-palette-label">OPEN TERMINAL · STOCK COMMAND</div>
      <input ref={input} value={query} aria-label="输入美股股票代码" placeholder="QQQ、SPY、NVDA… | Enter 选择 · Shift+Enter 加入自选"
        onChange={e=>setQuery(e.target.value)}
        onKeyDown={e=>{
          if(e.key==='Escape')setOpen(false);
          if(e.key==='ArrowDown'){e.preventDefault();setSelected(s=>Math.min(s+1,symbols.length-1));}
          if(e.key==='ArrowUp'){e.preventDefault();setSelected(s=>Math.max(0,s-1));}
          if(e.key==='Enter'&&symbols[selected])pick(symbols[selected],e.shiftKey);
        }}/>
      <div className="ot-palette-results">
        {symbols.map((ticker,index)=><button key={ticker} type="button"
          className={index===selected?'ot-palette-selected':''}
          onMouseEnter={()=>setSelected(index)} onClick={()=>pick(ticker,false)}>
          <strong>{ticker}</strong><small>{watchlist.includes(ticker)?'已在自选股':'美股代码'} · Alpaca SIP</small>
        </button>)}
        {!symbols.length&&<div className="empty-state">请输入有效美股代码（只支持美股股票 / ETF）</div>}
      </div>
    </div>
  </div>;
}
