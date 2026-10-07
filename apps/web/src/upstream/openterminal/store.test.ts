import {beforeEach,describe,expect,it} from 'vitest';
import {useTerminal} from './store';
import {useUi} from '../../state';

describe('OpenTerminal MIT widget state adapted to EqoBoard',()=>{
  beforeEach(()=>{
    useTerminal.getState().resetWorkspace();
    useTerminal.getState().setActiveSymbol('QQQ');
  });
  it('adds/removes widget instances with collision-safe IDs',()=>{
    const before=useTerminal.getState().widgets.length;
    useTerminal.getState().addWidget('options');
    useTerminal.getState().addWidget('options');
    const widgets=useTerminal.getState().widgets;
    expect(widgets.length).toBe(before+2);
    expect(new Set(widgets.map(w=>w.id)).size).toBe(widgets.length);
    useTerminal.getState().removeWidget(widgets.at(-1)!.id);
    expect(useTerminal.getState().widgets.length).toBe(before+1);
  });
  it('captures current symbol when un-linking and respects US equity grammar',()=>{
    const id=useTerminal.getState().widgets.find(w=>w.type==='chart')!.id;
    useTerminal.getState().toggleLinked(id);
    const detached=useTerminal.getState().widgets.find(w=>w.id===id)!;
    expect(detached.linked).toBe(false);
    expect(detached.symbol).toBe('QQQ');
    useTerminal.getState().setActiveSymbol('SPY');
    expect(useUi.getState().selectedSymbol).toBe('SPY');
    const remains=useTerminal.getState().widgets.find(w=>w.id===id)!;
    expect(remains.symbol).toBe('QQQ');
    useTerminal.getState().setWidgetSymbol(id,'../../bad');
    expect(useTerminal.getState().widgets.find(w=>w.id===id)!.symbol).toBe('QQQ');
  });
  it('retains OpenTerminal behavior when restoring default layout',()=>{
    useTerminal.getState().addWidget('quote');
    useTerminal.getState().resetWorkspace();
    expect(useTerminal.getState().widgets.some(w=>w.type==='quote')).toBe(false);
    expect(useTerminal.getState().layout.length).toBe(useTerminal.getState().widgets.length);
  });
});
