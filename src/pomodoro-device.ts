import {pomodoroProfile} from './pomodoro-profile.ts';
import {post,type Fetcher} from './device.ts';
import {requirePomodoroServer,type Config} from './config.ts';
import {Control} from './control.ts';
import type {PomodoroView} from './pomodoro.ts';
export const POMODORO_SCREEN=3;
export const POMODORO_POLL_SECONDS=10;
export const POMODORO_ROWS=[
 {field:'countdown',x:0,y:108,width:128,height:16,font:188,align:3,color:'#D0D9DF'},
] as const;
export const POMODORO_PHASE_ROWS=[
 {field:'phase-label',x:0,y:0,width:128,height:12,font:170,align:3,color:'#D0D9DF'},
 {field:'session-dots',x:0,y:12,width:128,height:10,font:196,align:3,color:'#D0D9DF'},
 ...POMODORO_ROWS,
] as const;
// Preserve read-only fields for already-installed v1 layouts until explicit setup.
export const POMODORO_FIELDS=['phase','countdown','progress','status','updated','phase-label','session-dots'] as const;
export function pomodoroText(view:PomodoroView,field:string,now=Date.now()):string {
 switch(field){
  case 'phase':return view.phase==='focus'?'FOCUS':'BREAK';
  case 'phase-label':return view.phase==='focus'?'FOCUS':view.breakKind==='long'?'LONG BREAK':'SHORT BREAK';
  case 'session-dots':{
   // Font 196 includes uppercase O and period; Unicode circles are unsupported.
   const completed=Math.max(0,Math.min(4,view.phase==='break'?view.focusSessionInCycle:view.focusSessionInCycle-1));
   return Array.from({length:4},(_,i)=>i<completed?'O':'.').join(' ');
  }
  case 'countdown':{const seconds=Math.max(0,Math.min(5999,Math.ceil(view.remainingSeconds)));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
  case 'progress':return `${Math.max(0,Math.min(100,Math.floor(view.progress*100)))}% COMPLETE`;
  case 'status':return ({idle:'READY',running:'RUNNING',paused:'PAUSED',completed:'DONE - START WEB'} as const)[view.status];
  case 'updated':return `${new Date(now+8*60*60*1000).toISOString().slice(11,19)} SGT`;
  default:throw new Error('Unsupported Pomodoro field');
 }
}
export function pomodoroLayout(config:Config,options:unknown=undefined,view?:PomodoroView){
 const profile=pomodoroProfile(options);
 const base=requirePomodoroServer(config);
 if(profile.background==='phase'&&!view)throw new Error('Phase display requires the current timer view');
 const background=profile.background==='phase'?(view!.phase==='break'?'cat-sleep-v1.gif':'cat-loop-v1.gif'):
  profile.background==='animated'?'cat-loop-v1.gif':profile.background==='sleeping'?'cat-sleep-v1.gif':'cat-v2.gif';
 const rows=profile.background==='phase'?POMODORO_PHASE_ROWS:POMODORO_ROWS;
 return {Command:'Draw/SendHttpItemList',LcdIndex:POMODORO_SCREEN,NewFlag:1,BackgroudGif:`${base}/pomodoro/${background}`,ItemList:rows.map((row,i)=>({TextId:profile.background==='phase'?24+i:26,type:23,x:row.x,y:row.y,dir:0,font:row.font,TextWidth:row.width,Textheight:row.height,TextString:`${base}/pomodoro/4/${row.field}`,speed:100,color:row.color,update_time:profile.pollSeconds,align:row.align}))};
}
/** One explicit isolated setup. Web timer actions never call this function. */
export async function setupPomodoro(config:Config,control:Control,apply=false,stopVersion=control.stopVersion(),fetcher:Fetcher=fetch,options:unknown=undefined,view?:PomodoroView):Promise<void>{
 if(!apply||!config.writesEnabled||control.isArmed())throw new Error('Stop stock rotation and explicitly apply Pomodoro setup with writes enabled');
 const payload=pomodoroLayout(config,options,view);
 if(stopVersion!==control.stopVersion())throw new Error('Pomodoro setup cancelled by stop');
 const guarded=(async(url,init)=>{
  if(String(url)!==config.device.url||init?.method!=='POST'||typeof init.body!=='string')throw new Error('Blocked invalid Pomodoro request');
  const p=JSON.parse(init.body);const {LocalToken,...withoutToken}=p;
  if(JSON.stringify(withoutToken)!==JSON.stringify(payload)||p.Command!=='Draw/SendHttpItemList'||p.LcdIndex!==POMODORO_SCREEN||control.isArmed()||stopVersion!==control.stopVersion())throw new Error('Blocked Pomodoro write outside explicit scope');
  return fetcher(url,init);
 }) as Fetcher;
 try{await post(config.device,payload,guarded);}catch(error){control.halt();throw error;}
}
