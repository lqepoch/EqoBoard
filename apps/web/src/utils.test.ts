import {describe,expect,it} from 'vitest';
import {buildOptionRows,mid,newYorkDate} from './utils';
import type {OptionContract} from './types';

const base = {symbol:'QQQ261007C00600000',underlying:'QQQ',
 expiration:'2026-10-07',right:'call' as const,strike:600,bid:1,ask:1.2,
 last:1.1,bid_size:10,ask_size:10,iv:.2,delta:.4,gamma:.02,theta:-.1,vega:.1,
 updated_at:'2026-10-07T12:00:00Z',feed:'opra'};
describe('option chain table',()=>{
 it('pivots strikes deterministically and keeps put/call distinct',()=>{
   const put:OptionContract={...base,right:'put',symbol:'QQQ261007P00600000'};
   const rows=buildOptionRows([put,{...base,strike:601},base]);
   expect(rows.map(r=>r.strike)).toEqual([600,601]);
   expect(rows[0].call?.right).toBe('call');
   expect(rows[0].put?.right).toBe('put');
 });
 it('never fabricates mid on inverted markets',()=>{
   expect(mid({bid:1,ask:1.2})).toBeCloseTo(1.1);
   expect(mid({bid:1.2,ask:1})).toBeNull();
   expect(mid({bid:null,ask:2})).toBeNull();
 });
 it('uses New York exchange date',()=>{
   expect(newYorkDate(new Date('2026-10-07T02:00:00Z'))).toBe('2026-10-06');
 });
});
