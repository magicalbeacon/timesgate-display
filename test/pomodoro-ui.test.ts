import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {POMODORO_HTML,POMODORO_SCRIPT} from '../src/pomodoro-ui.ts';
import {PomodoroTimer,type PomodoroView} from '../src/pomodoro.ts';

type PendingRequest={path:string;options:any;resolve:(value:any)=>void;reject:(error:Error)=>void};
function fixture(){
  let now=0;const requests:PendingRequest[]=[],intervals:{callback:()=>void;ms:number}[]=[];
  const elements=new Map<string,any>();
  for(const id of ['pomodoro','pomo-ring','pomo-phase','pomo-time','pomo-state','pomo-message'])elements.set('#'+id,{hidden:id==='pomodoro',textContent:'',style:{values:new Map<string,string>(),setProperty(name:string,value:string){this.values.set(name,value);}}});
  const buttons=['start','pause','resume','reset'].map(action=>({dataset:{action},disabled:true,textContent:'',listener:undefined as undefined|(()=>Promise<void>),addEventListener(event:string,callback:()=>Promise<void>){assert.equal(event,'click');this.listener=callback;}}));
  const timer=new PomodoroTimer({}, {monotonicClock:()=>now,wallClock:()=>Date.UTC(2026,9,17)+now});
  runInNewContext(POMODORO_SCRIPT,{
    document:{querySelector:(id:string)=>{assert(elements.has(id),id);return elements.get(id);},querySelectorAll:(selector:string)=>{assert.equal(selector,'#pomodoro button');return buttons;}},
    fetch:(path:string,options:any)=>new Promise((resolve,reject)=>requests.push({path,options,resolve,reject})),
    performance:{now:()=>now},AbortSignal:{timeout:(ms:number)=>{assert.equal(ms,3000);return {timeout:ms};}},
    setInterval:(callback:()=>void,ms:number)=>{intervals.push({callback,ms});return intervals.length;},
  });
  const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
  const respond=async(index:number,status:number,data:any)=>{requests[index].resolve({status,ok:status>=200&&status<300,json:async()=>data});await flush();};
  const reject=async(index:number)=>{requests[index].reject(new Error('Network unavailable'));await flush();};
  const button=(action:string)=>buttons.find(value=>value.dataset.action===action)!;
  const tick=(ms:number)=>{for(const interval of intervals)if(interval.ms===ms)interval.callback();};
  return {requests,elements,buttons,timer,respond,reject,flush,button,tick,advance:(ms:number)=>{now+=ms;},text:(id:string)=>elements.get('#'+id).textContent,
    handshake:async(token='a'.repeat(43),view=timer.view())=>respond(0,200,{csrfToken:token,view}),
    click:(action:string)=>button(action).listener!(),posts:()=>requests.filter(value=>value.options.method==='POST')};
}
function enabled(f:ReturnType<typeof fixture>){return f.buttons.filter(button=>!button.disabled).map(button=>button.dataset.action);}
function posted(request:PendingRequest){return JSON.parse(request.options.body);}

test('UI starts safely disabled, fetches control capability, and does not auto-start',async()=>{
  assert.equal((POMODORO_HTML.match(/data-action="(?:start|pause|resume|reset)" disabled/g)||[]).length,4);
  const f=fixture();assert.deepEqual(enabled(f),[]);assert.equal(f.elements.get('#pomodoro').hidden,true);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/pomodoro/control');assert.equal(f.requests[0].options.cache,'no-store');
  await f.handshake();assert.equal(f.elements.get('#pomodoro').hidden,false);assert.equal(f.text('pomo-time'),'25:00');assert.equal(f.text('pomo-state'),'Ready when you are');
  assert.deepEqual(enabled(f),['start','reset']);assert.equal(f.button('start').textContent,'Start focus');
  f.advance(60_000);f.tick(1000);await f.respond(1,200,f.timer.view());assert.equal(f.requests[1].path,'/api/pomodoro');assert.equal(f.posts().length,0);assert.equal(f.text('pomo-time'),'25:00');
});

test('Start, Pause, Resume, Reset use one exact revisioned POST and disable repeat clicks',async()=>{
  const f=fixture();await f.handshake();
  for(const [action,label,actions] of [
    ['start','In progress',['pause','reset']],['pause','Paused',['resume','reset']],['resume','In progress',['pause','reset']],['reset','Ready when you are',['start','reset']],
  ] as const){
    const revision=f.timer.view().revision,index=f.requests.length;const done=f.click(action);
    assert.deepEqual(enabled(f),[]);await f.click(action);f.tick(1000);assert.equal(f.requests.length,index+1);
    const request=f.requests[index];assert.equal(request.path,'/api/pomodoro/action');assert.equal(request.options.method,'POST');assert.equal(request.options.headers['Content-Type'],'application/json');assert.equal(request.options.headers['X-Pomodoro-CSRF'],'a'.repeat(43));
    assert.deepEqual(posted(request),{action,expectedRevision:revision});
    const result=f.timer.action({action,expectedRevision:revision});await f.respond(index,200,result);await done;
    assert.equal(f.text('pomo-state'),label);assert.deepEqual(enabled(f),actions);f.advance(1500);
  }
  assert.equal(f.posts().length,4);assert.equal(f.text('pomo-time'),'25:00');
});

test('browser ring and countdown animate while fresh, stop on pause, and never advance phase automatically',async()=>{
  const f=fixture();const running=f.timer.action({action:'start',expectedRevision:0}).view;await f.handshake('a'.repeat(43),running);
  f.advance(1200);f.tick(100);assert.equal(f.text('pomo-time'),'24:59');assert.notEqual(f.elements.get('#pomo-ring').style.values.get('--turn'),'0deg');
  const index=f.requests.length,paused=f.click('pause');await f.respond(index,200,f.timer.action({action:'pause',expectedRevision:1}));await paused;
  const frozen=f.text('pomo-time');f.advance(2000);f.tick(100);assert.equal(f.text('pomo-time'),frozen);assert.equal(f.text('pomo-state'),'Paused');
  const completed:PomodoroView={...f.timer.view(),status:'completed',phase:'focus',remainingSeconds:0,progress:1,revision:3,availableActions:['start','reset']};
  f.tick(1000);await f.respond(f.requests.length-1,200,completed);assert.equal(f.text('pomo-state'),'Session complete');assert.equal(f.button('start').textContent,'Start break');
  f.advance(1000);f.tick(100);assert.equal(f.text('pomo-time'),'00:00');assert.equal(f.posts().length,1);
});

test('an older GET cannot overwrite a newer action response, even when responses arrive out of order',async()=>{
  for(const lateFails of [false,true]){
    const f=fixture();await f.handshake();f.tick(1000);assert.equal(f.requests[1].path,'/api/pomodoro');
    const old=f.timer.view(),done=f.click('start');assert.equal(f.requests[2].options.method,'POST');
    await f.respond(2,200,f.timer.action({action:'start',expectedRevision:0}));await done;assert.equal(f.text('pomo-state'),'In progress');
    if(lateFails)await f.reject(1);else await f.respond(1,200,old);
    assert.equal(f.text('pomo-state'),'In progress');assert.deepEqual(enabled(f),['pause','reset']);assert.equal(f.text('pomo-message'),'Timer updated.');
    f.tick(1000);assert.equal(f.requests.length,4);assert.equal(f.requests[3].path,'/api/pomodoro');
  }
});

test('concurrent tabs produce an explicit conflict and no automatic POST retry',async()=>{
  const f=fixture();await f.handshake();const other=f.timer.action({action:'start',expectedRevision:0});
  const done=f.click('start');await f.respond(1,409,{ok:false,reason:'stale_revision',view:other.view});await done;
  assert.match(f.text('pomo-message'),/changed elsewhere/);assert.equal(f.text('pomo-state'),'In progress');assert.deepEqual(enabled(f),['pause','reset']);
  f.tick(1000);await f.respond(2,200,f.timer.view());assert.equal(f.posts().length,1);
});

test('unknown action outcome disables controls, resynchronizes with GET, and never repeats the POST',async()=>{
  const f=fixture();await f.handshake();const done=f.click('start');f.timer.action({action:'start',expectedRevision:0});
  await f.reject(1);await done;assert.deepEqual(enabled(f),[]);assert.match(f.text('pomo-message'),/outcome unknown.*no automatic retry/);
  assert.equal(f.requests.length,3);assert.equal(f.requests[2].path,'/api/pomodoro/control');assert.equal(f.posts().length,1);
  await f.respond(2,200,{csrfToken:'b'.repeat(43),view:f.timer.view()});assert.equal(f.text('pomo-state'),'In progress');assert.deepEqual(enabled(f),['pause','reset']);
  f.tick(1000);await f.respond(3,200,f.timer.view());assert.equal(f.posts().length,1);
});

test('offline and stale views disable controls, recover from GET, and prevent background action retries',async()=>{
  const f=fixture();f.timer.action({action:'start',expectedRevision:0});await f.handshake();
  f.advance(3500);f.tick(100);assert.equal(f.text('pomo-state'),'Connection lost');assert.deepEqual(enabled(f),[]);assert.equal(f.elements.get('#pomo-ring').style.values.get('--accent'),'#617383');
  await f.click('pause');assert.equal(f.posts().length,0);
  f.tick(1000);await f.reject(1);assert.match(f.text('pomo-message'),/connection lost/i);assert.deepEqual(enabled(f),[]);
  f.advance(10_000);f.tick(1000);await f.respond(2,200,f.timer.view());assert.equal(f.text('pomo-state'),'In progress');assert.deepEqual(enabled(f),['pause','reset']);assert.equal(f.posts().length,0);
});

test('disabled routes stay hidden and stop polling; wrong origin never enables controls',async()=>{
  const disabled=fixture();await disabled.respond(0,404,{error:'Not found'});assert.equal(disabled.elements.get('#pomodoro').hidden,true);disabled.tick(1000);assert.equal(disabled.requests.length,1);assert.deepEqual(enabled(disabled),[]);
  const forbidden=fixture();await forbidden.respond(0,403,{reason:'forbidden'});assert.equal(forbidden.elements.get('#pomodoro').hidden,false);assert.match(forbidden.text('pomo-message'),/configured Pi LAN address/);assert.deepEqual(enabled(forbidden),[]);assert.equal(forbidden.posts().length,0);
});

test('a server restart resets the displayed state and stale CSRF refresh requires a new user choice',async()=>{
  const f=fixture();f.timer.action({action:'start',expectedRevision:0});await f.handshake();
  const restarted=new PomodoroTimer({}, {monotonicClock:()=>0,wallClock:()=>0});f.tick(1000);await f.respond(1,200,restarted.view());
  assert.equal(f.text('pomo-time'),'25:00');assert.equal(f.text('pomo-state'),'Ready when you are');assert.equal(f.posts().length,0);
  const first=f.click('start');await f.respond(2,403,{reason:'forbidden'});await first;assert.deepEqual(enabled(f),[]);assert.equal(f.requests[3].path,'/api/pomodoro/control');
  await f.respond(3,200,{csrfToken:'b'.repeat(43),view:restarted.view()});assert.deepEqual(enabled(f),['start','reset']);assert.equal(f.posts().length,1);
  const second=f.click('start');assert.equal(f.requests[4].options.headers['X-Pomodoro-CSRF'],'b'.repeat(43));assert.deepEqual(posted(f.requests[4]),{action:'start',expectedRevision:0});
  await f.respond(4,200,restarted.action({action:'start',expectedRevision:0}));await second;assert.equal(f.text('pomo-state'),'In progress');assert.equal(f.posts().length,2);
});

test('stale and offline countdowns freeze the last rendered interpolation, then recover from the authoritative view',async()=>{
  for(const cause of ['stale','offline']){
    const f=fixture();f.timer.action({action:'start',expectedRevision:0});await f.handshake();
    f.advance(3200);f.tick(100);
    const frozenTime=f.text('pomo-time'),frozenTurn=f.elements.get('#pomo-ring').style.values.get('--turn');
    assert.equal(frozenTime,'24:57');assert.notEqual(frozenTurn,'0deg');
    if(cause==='stale'){f.advance(300);f.tick(100);}
    else {f.tick(1000);await f.reject(1);}
    assert.equal(f.text('pomo-state'),'Connection lost');assert.deepEqual(enabled(f),[]);
    assert.equal(f.text('pomo-time'),frozenTime,`${cause}: losing freshness must not add seconds back`);
    assert.equal(f.elements.get('#pomo-ring').style.values.get('--turn'),frozenTurn,`${cause}: ring must not move backwards`);
    f.advance(10_000);f.tick(100);
    assert.equal(f.text('pomo-time'),frozenTime);assert.equal(f.elements.get('#pomo-ring').style.values.get('--turn'),frozenTurn);
    f.tick(1000);const current=f.timer.view();await f.respond(f.requests.length-1,200,current);
    const formatted=(seconds:number)=>String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
    assert.equal(f.text('pomo-time'),formatted(current.remainingSeconds),'a new response discards old interpolation');
    assert.equal(f.elements.get('#pomo-ring').style.values.get('--turn'),(current.progress*360)+'deg');
    assert.equal(f.text('pomo-state'),'In progress');assert.deepEqual(enabled(f),['pause','reset']);
    f.advance(1000);f.tick(100);assert.equal(f.text('pomo-time'),formatted(current.remainingSeconds-1));
    assert.equal(f.posts().length,0);
  }
});
