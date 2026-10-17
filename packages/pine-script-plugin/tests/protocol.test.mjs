import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectPineSource, normalizePineBars, normalizePinePlots,
  runReadOnlyPineIndicator, createPineTsAdapter, PinePluginError,
} from "../src/index.mjs";

const script = '//@version=6\nindicator("SMA 2", overlay=true)\nplot(ta.sma(close, 2), "SMA")';
const bars = [
  { time: 1704067200, open: 100, high: 104, low: 98, close: 103, volume: 100 },
  { time: 1704153600, open: 103, high: 109, low: 102, close: 107, volume: 110 },
  { time: 1704240000, open: 107, high: 111, low: 106, close: 110, volume: 120 },
];
const evidence = {provider:"synthetic-fixture",symbol:"SPY",resolution:"1d",completeness:"unverified",feed:"synthetic"};
function fails(fn,code) {
  assert.throws(fn,e=>e instanceof PinePluginError && e.code===code);
}
test("v5/v6 indicator admission and unsupported syntax",()=>{
  assert.equal(inspectPineSource(script).version,6);
  assert.equal(inspectPineSource(script.replace("version=6","version=5")).version,5);
  fails(()=>inspectPineSource(script.replace("version=6","version=4")),"UNSUPPORTED_VERSION");
  fails(()=>inspectPineSource(script.replace("indicator(","strategy(")),"UNSUPPORTED_SCRIPT");
  fails(()=>inspectPineSource(script+"\nrequest.security('QQQ','D',close)"),"UNSUPPORTED_DATA_REQUEST");
  fails(()=>inspectPineSource(script.repeat(900)),"INVALID_SOURCE");
});
test("bar validation rejects bad timestamps, OHLC and non-finite volume",()=>{
  const points=normalizePineBars(bars);
  assert.equal(points[0].openTime,bars[0].time*1000);
  assert.equal(points.length,3);
  fails(()=>normalizePineBars([...bars].reverse()),"INVALID_BARS");
  fails(()=>normalizePineBars([...bars,bars[2]]),"INVALID_BARS");
  fails(()=>normalizePineBars([{...bars[0],high:95}]),"INVALID_BARS");
  fails(()=>normalizePineBars([{...bars[0],volume:Infinity}]),"INVALID_BARS");
});
test("valid plots preserve gaps and map milliseconds to chart seconds",()=>{
  const b=normalizePineBars(bars);
  const p=normalizePinePlots({SMA:{data:[
    {time:b[0].openTime,value:null},
    {time:b[1].openTime,value:105},
    {time:b[2].openTime,value:108.5},
  ]}},b);
  assert.deepEqual(p[0].points,[
    {time:bars[1].time,value:105},
    {time:bars[2].time,value:108.5},
  ]);
  fails(()=>normalizePinePlots({SMA:{data:[{time:42,value:10}]}},b),"INVALID_OUTPUT");
  fails(()=>normalizePinePlots({SMA:{data:[{time:b[0].openTime,value:Infinity}]}},b),"INVALID_OUTPUT");
});
test("engine and source evidence are mandatory",async()=>{
  await assert.rejects(runReadOnlyPineIndicator({source:script,bars,evidence,engine:null}),{code:"ENGINE_UNAVAILABLE"});
  await assert.rejects(runReadOnlyPineIndicator({source:script,bars,evidence:null,engine:{id:"stub",evaluate:async()=>({plots:{}})}}),{code:"MISSING_EVIDENCE"});
});
test("PineTS runtime requires approved license and external isolation",()=>{
  class FakePineTS { async run(){return {plots:{}};} }
  fails(()=>createPineTsAdapter({PineTS:FakePineTS,licenseApproved:false,isolatedProcess:true}),"LICENSE_REQUIRED");
  fails(()=>createPineTsAdapter({PineTS:FakePineTS,licenseApproved:true,isolatedProcess:false}),"ISOLATION_REQUIRED");
  assert.equal(createPineTsAdapter({PineTS:FakePineTS,licenseApproved:true,isolatedProcess:true}).id,"pinets");
});
test("injected engine returns bounded read-only plots, never orders or alerts",async()=>{
  const seen=[];
  class FakePineTS {
    constructor(candles){seen.push(candles);}
    async run(source){
      assert.equal(source,script);
      return {plots:{SMA:{data:[
        {time:bars[1].time*1000,value:105},
        {time:bars[2].time*1000,value:108.5},
      ]}}};
    }
  }
  const engine=createPineTsAdapter({PineTS:FakePineTS,licenseApproved:true,isolatedProcess:true});
  const output=await runReadOnlyPineIndicator({source:script,bars,evidence,engine});
  assert.equal(output.protocolVersion,1);
  assert.equal(output.source.provider,"synthetic-fixture");
  assert.equal(output.source.completeness,"unverified");
  assert.equal(seen[0].length,bars.length);
  assert.deepEqual(output.plots[0].points[0],{time:bars[1].time,value:105});
  assert.deepEqual(output.orderIntents,[]);
  assert.deepEqual(output.alertDeliveries,[]);
});
test("invalid output rejects whole result",async()=>{
  await assert.rejects(runReadOnlyPineIndicator({
    source:script,bars,evidence,
    engine:{id:"bad",async evaluate(){return {plots:{X:{data:[{time:123,value:5}]}}};}},
  }),{code:"INVALID_OUTPUT"});
});
test("PineTS supported histogram and pane identity are preserved",()=>{
  const b=normalizePineBars(bars);
  const output=normalizePinePlots({
    histogram:{options:{style:"style_histogram",overlay:false,histbase:0},data:[
      {time:b[0].openTime,value:3},{time:b[1].openTime,value:-2},
    ]},
    close:{options:{style:"style_line",overlay:true},data:[{time:b[2].openTime,value:110}]},
  },b);
  assert.equal(output[0].kind,"histogram");
  assert.equal(output[0].pane,"indicator");
  assert.equal(output[1].kind,"line");
  assert.equal(output[1].pane,"price");
});
test("unsupported PineTS drawing/styles and offsets are refused, never drawn as lines",()=>{
  const b=normalizePineBars(bars);
  for(const options of [
    {style:"shape"},{style:"drawing_line"},
    {style:"style_linebr"},{style:"style_columns"},
    {style:"style_line",offset:1},{style:"style_histogram",histbase:50},
    {style:"style_line",show_last:3},
  ]) {
    fails(()=>normalizePinePlots({plot:{options,data:[{time:b[0].openTime,value:1}]}},b),"UNSUPPORTED_PLOT_STYLE");
  }
});
