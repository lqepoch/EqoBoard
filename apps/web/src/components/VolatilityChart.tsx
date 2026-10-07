import {useEffect,useRef} from 'react';
import * as echarts from 'echarts/core';
import {LineChart} from 'echarts/charts';
import {GridComponent,TooltipComponent,LegendComponent} from 'echarts/components';
import {CanvasRenderer} from 'echarts/renderers';
import type {OptionContract} from '../types';
import {Panel} from './Panel';
echarts.use([LineChart,GridComponent,TooltipComponent,LegendComponent,CanvasRenderer]);

export function VolatilityChart({contracts,truncated}:{
  contracts:OptionContract[];truncated:boolean;
}){
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!host.current||contracts.length===0) return;
    const chart=echarts.init(host.current,undefined,{renderer:'canvas'});
    const calls=contracts.filter(c=>c.right==='call'&&c.iv!=null).map(c=>[c.strike,c.iv!*100]);
    const puts=contracts.filter(c=>c.right==='put'&&c.iv!=null).map(c=>[c.strike,c.iv!*100]);
    chart.setOption({
      animation:false,backgroundColor:'transparent',
      textStyle:{color:'#94a9bd',fontFamily:'Inter, sans-serif',fontSize:11},
      grid:{left:42,right:18,top:30,bottom:30},
      legend:{top:0,right:8,textStyle:{color:'#94a9bd'},data:['Call IV','Put IV']},
      tooltip:{trigger:'axis',backgroundColor:'#142638',borderColor:'#254057',textStyle:{color:'#dce6f4'}},
      xAxis:{type:'value',name:'Strike',nameTextStyle:{color:'#7b96ae'},
        axisLine:{lineStyle:{color:'#365065'}},splitLine:{lineStyle:{color:'#1d3142'}}},
      yAxis:{type:'value',axisLabel:{formatter:'{value}%'},splitLine:{lineStyle:{color:'#1d3142'}}},
      series:[
        {name:'Call IV',type:'line',showSymbol:false,symbolSize:4,data:calls,
          lineStyle:{color:'#31caa5',width:2},itemStyle:{color:'#31caa5'}},
        {name:'Put IV',type:'line',showSymbol:false,symbolSize:4,data:puts,
          lineStyle:{color:'#86a8ff',width:2},itemStyle:{color:'#86a8ff'}}
      ]
    });
    const obs=new ResizeObserver(()=>chart.resize());
    obs.observe(host.current);
    return ()=>{obs.disconnect();chart.dispose()};
  },[contracts]);
  return <Panel title="隐含波动率曲线" kicker="ALPACA SNAPSHOT / IV SKEW"
    aside={<span className="subtle">{truncated?'⚠ 数据不完整':'按执行价'}</span>}>
    <div className="chart-container compact-chart">
      {contracts.length?<div className="chart-canvas" ref={host}/>:<div className="empty-state">选择合约到期日后展示真实快照 IV</div>}
    </div>
    <div className="metric-footnote">IV 取 Alpaca 快照字段；同一横截面可能有异步时间差。此图仅为单到期日 Skew。</div>
  </Panel>;
}
