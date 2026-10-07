import type {OptionContract,OptionRow} from './types';
export function newYorkDate(date=new Date()):string {
  return new Intl.DateTimeFormat('en-CA',{
    timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'
  }).format(date);
}
export function money(value:number|null|undefined,digits=2):string {
  return value==null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}
export function compact(value:number|null|undefined):string {
  if(value==null || !Number.isFinite(value)) return '—';
  return Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(value);
}
export function mid(contract:Pick<OptionContract,'bid'|'ask'>):number|null{
  return contract.bid!=null && contract.ask!=null && contract.ask>=contract.bid
    ? (contract.bid+contract.ask)/2 : null;
}
export function buildOptionRows(contracts:OptionContract[]):OptionRow[]{
  const map = new Map<number,OptionRow>();
  for (const c of contracts){
    if(!Number.isFinite(c.strike)) continue;
    const row=map.get(c.strike)??{strike:c.strike,call:null,put:null};
    if(c.right==='call') row.call=c;
    else row.put=c;
    map.set(c.strike,row);
  }
  return [...map.values()].sort((a,b)=>a.strike-b.strike);
}
export function secondsOld(value:string|null|undefined):number|null{
  if(!value) return null;
  const n=Date.parse(value);
  return Number.isFinite(n) ? Math.max(0,(Date.now()-n)/1000) : null;
}
export function humanTime(t:string|null|undefined):string{
  if(!t) return '—';
  const parsed=new Date(t);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString('zh-CN',{
    hour12:false,timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit'
  })+' ET' : '—';
}
