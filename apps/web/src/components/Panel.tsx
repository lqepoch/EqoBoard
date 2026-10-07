import type {ReactNode} from 'react';
import {GripVertical} from 'lucide-react';
export function Panel({title,kicker,children,aside,className=''}:{
  title:string;kicker?:string;children:ReactNode;aside?:ReactNode;className?:string;
}){
  return <section className={'terminal-panel '+className}>
    <header className="panel-handle">
      <div className="panel-title-group">
        <GripVertical size={13} className="grip"/>
        <div><span className="panel-title">{title}</span>{kicker&&<span className="panel-kicker">{kicker}</span>}</div>
      </div>
      {aside&&<div className="panel-aside">{aside}</div>}
    </header>
    <div className="panel-body">{children}</div>
  </section>;
}
