import {post,type Fetcher} from './device.ts';
import {requirePomodoroServer,type Config} from './config.ts';
import {Control} from './control.ts';
import type {PomodoroView} from './pomodoro.ts';
export const POMODORO_SCREEN=3;
export const POMODORO_POLL_SECONDS=10;
export const POMODORO_ROWS=[
 {field:'phase',x:0,y:19,width:128,height:16,font:4,align:3,color:'#64DFFF'},
 {field:'countdown',x:9,y:39,width:110,height:33,font:400,align:3,color:'#FFFFFF'},
 {field:'progress',x:0,y:77,width:128,height:16,font:4,align:3,color:'#FFCB70'},
 {field:'status',x:0,y:94,width:128,height:16,font:4,align:3,color:'#D5ADFF'},
 {field:'updated',x:0,y:112,width:128,height:16,font:4,align:3,color:'#8DABBF'},
] as const;
export const POMODORO_FIELDS=POMODORO_ROWS.map(row=>row.field);
export function pomodoroText(view:PomodoroView,field:string,now=Date.now()):string {
 switch(field){
  case 'phase':return view.phase==='focus'?'FOCUS':'BREAK';
  case 'countdown':{const seconds=Math.max(0,Math.min(5999,Math.ceil(view.remainingSeconds)));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  case 'progress':return `${Math.max(0,Math.min(100,Math.floor(view.progress*100)))}% COMPLETE`;
  case 'status':return ({idle:'READY',running:'RUNNING',paused:'PAUSED',completed:'DONE - START WEB'} as const)[view.status];
  case 'updated':return `${new Date(now+8*60*60*1000).toISOString().slice(11,19)} SGT`;
  default:throw new Error('Unsupported Pomodoro field');
 }
}
export function pomodoroLayout(config:Config){
 const base=requirePomodoroServer(config);
 return {Command:'Draw/SendHttpItemList',LcdIndex:POMODORO_SCREEN,NewFlag:1,BackgroudGif:`${base}/pomodoro/static-v1.gif`,ItemList:POMODORO_ROWS.map((row,i)=>({TextId:25+i,type:23,x:row.x,y:row.y,dir:0,font:row.font,TextWidth:row.width,Textheight:row.height,TextString:`${base}/pomodoro/4/${row.field}`,speed:100,color:row.color,update_time:POMODORO_POLL_SECONDS,align:row.align}))};
}
/** One explicit isolated setup. Web timer actions never call this function. */
export async function setupPomodoro(config:Config,control:Control,apply=false,stopVersion=control.stopVersion(),fetcher:Fetcher=fetch):Promise<void>{
 if(!apply||!config.writesEnabled||control.isArmed())throw new Error('Stop stock rotation and explicitly apply Pomodoro setup with writes enabled');
 const payload=pomodoroLayout(config);
 if(stopVersion!==control.stopVersion())throw new Error('Pomodoro setup cancelled by stop');
 const guarded=(async(url,init)=>{
  if(String(url)!==config.device.url||init?.method!=='POST'||typeof init.body!=='string')throw new Error('Blocked invalid Pomodoro request');
  const p=JSON.parse(init.body);const {LocalToken,...withoutToken}=p;
  if(JSON.stringify(withoutToken)!==JSON.stringify(payload)||p.Command!=='Draw/SendHttpItemList'||p.LcdIndex!==POMODORO_SCREEN||control.isArmed()||stopVersion!==control.stopVersion())throw new Error('Blocked Pomodoro write outside explicit scope');
  return fetcher(url,init);
 }) as Fetcher;
 try{await post(config.device,payload,guarded);}catch(error){control.halt();throw error;}
}
