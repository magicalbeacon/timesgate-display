import {POMODORO_CAT_SLEEP_ANIMATION} from '../src/pomodoro-cat-sleep-animation.ts';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {request,type IncomingHttpHeaders} from 'node:http';
import {readFileSync} from 'node:fs';
import {makeServer} from '../src/server.ts';
import {PomodoroTimer} from '../src/pomodoro.ts';
import {POMODORO_CAT_ANIMATION} from '../src/pomodoro-cat-animation.ts';
import {POMODORO_CAT_BACKGROUND} from '../src/pomodoro-cat-background.ts';
import {POMODORO_FIELDS} from '../src/pomodoro-device.ts';

const HOST='192.168.240.42:8081',ORIGIN=`http://${HOST}`;
type Response={status:number;headers:IncomingHttpHeaders;text:string;json:any;bytes:Buffer};
type Options={method?:string;headers?:Record<string,string>;body?:string};
async function fixture(t:TestContext,enabled=true){
  let now=0,calls=0;
  const timer=new PomodoroTimer({}, {monotonicClock:()=>now,wallClock:()=>Date.UTC(2026,9,17)+now});
  const server=makeServer({status:()=>({control:{targetScreens:[1,2],armed:false},pomodoro:enabled?timer.view():null}),image:()=>undefined,
    ...(enabled?{pomodoro:{origin:ORIGIN,view:()=>timer.view(),action:input=>{calls++;return timer.action(input);}}}:{})});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  t.after(async()=>{const closing=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();await closing;});
  function send(path:string,options:Options={}):Promise<Response>{return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method:options.method??'GET',headers:{host:HOST,...options.headers}},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.once('error',reject);res.once('end',()=>{
        const bytes=Buffer.concat(chunks);const text=bytes.toString('utf8');let json:any;try{json=JSON.parse(text);}catch{}
        resolve({status:res.statusCode!,headers:res.headers,text,json,bytes});
      });
    });req.once('error',reject);req.end(options.body);
  });}
  const control=()=>send('/api/pomodoro/control');
  const post=(token:string,action:string,expectedRevision:number)=>send('/api/pomodoro/action',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json','x-pomodoro-csrf':token},body:JSON.stringify({action,expectedRevision})});
  return {send,control,post,timer,advance:(ms:number)=>{now+=ms;},actionCalls:()=>calls};
}
function secured(response:Response){
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
  assert.equal(response.headers['x-frame-options'],'DENY');assert.equal(response.headers['referrer-policy'],'no-referrer');
  assert.match(String(response.headers['content-security-policy']),/frame-ancestors 'none'/);
  assert.match(String(response.headers['content-security-policy']),/base-uri 'none'/);
  assert.match(String(response.headers['content-security-policy']),/form-action 'none'/);
  assert.equal(response.headers['set-cookie'],undefined);
  for(const name of Object.keys(response.headers))assert(!name.startsWith('access-control-'),name);
}

test('integrated dashboard, native reads, JSON, errors, and controls all deny framing and caching',async t=>{
  const f=await fixture(t);
  for(const path of ['/','/healthz','/api/status','/api/pomodoro','/api/pomodoro/control','/pomodoro/static-v1.gif','/pomodoro/cat-v2.gif','/pomodoro/cat-loop-v1.gif','/pomodoro/cat-sleep-v1.gif',...POMODORO_FIELDS.map(field=>'/pomodoro/4/'+field),'/missing'])secured(await f.send(path));
  const page=await f.send('/');assert.match(page.text,/data-action="start" disabled/);assert.match(page.text,/browser-only/);
  assert.match(page.text,/server restart clears the timer and session count/i);assert.match(page.text,/Screen 4 keeps its existing layout until explicit setup/);
  assert.equal((await f.send('/pomodoro/static-v1.gif')).headers['content-type'],'image/gif');
  const token=(await f.control()).json.csrfToken;const started=await f.post(token,'start',0);secured(started);assert.equal(started.status,200);
  const stale=await f.post(token,'reset',0);secured(stale);assert.equal(stale.status,409);
});

test('integrated action endpoint requires POST, exact Host and Origin, and the process CSRF token',async t=>{
  const f=await fixture(t),token=(await f.control()).json.csrfToken;
  const valid={host:HOST,origin:ORIGIN,'content-type':'application/json','x-pomodoro-csrf':token};
  for(const method of ['GET','HEAD','PUT','PATCH','DELETE','OPTIONS']){
    const response=await f.send('/api/pomodoro/action',{method,headers:valid});assert.equal(response.status,405,method);assert.equal(response.headers.allow,'POST');secured(response);
  }
  for(const bad of [{host:'evil.invalid:8081'},{origin:'https://evil.invalid'},{origin:'null'},{origin:''},{'x-pomodoro-csrf':''},{'x-pomodoro-csrf':'x'.repeat(43)},{'sec-fetch-site':'cross-site'}]){
    const response=await f.send('/api/pomodoro/action',{method:'POST',headers:{...valid,...bad},body:JSON.stringify({action:'start',expectedRevision:0})});
    assert.equal(response.status,403,JSON.stringify(bad));secured(response);assert(!response.text.includes(token));
  }
  const missingOrigin={host:HOST,'content-type':'application/json','x-pomodoro-csrf':token};
  assert.equal((await f.send('/api/pomodoro/action',{method:'POST',headers:missingOrigin,body:'{"action":"start","expectedRevision":0}'})).status,403);
  assert.equal(f.actionCalls(),0);assert.equal(f.timer.view().status,'idle');
  for(const path of ['/api/arm','/api/stop','/api/restore','/api/pomodoro/setup','/pomodoro/4/countdown'])assert.equal((await f.send(path,{method:'POST'})).status,405,path);
  assert.equal((await f.post(token,'start',0)).status,200);assert.equal(f.actionCalls(),1);
});

test('native Pomodoro field routes expose only screen4 and never mutate timer state',async t=>{
  const f=await fixture(t),initial=f.timer.view();
  for(const field of POMODORO_FIELDS){const response=await f.send('/pomodoro/4/'+field);assert.equal(response.status,200);assert.deepEqual(Object.keys(response.json),['DispData']);assert.equal(typeof response.json.DispData,'string');}
  assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'25:00');
  assert.equal((await f.send('/pomodoro/4/status')).json.DispData,'READY');
  for(const screen of [0,1,2,3,5,6])assert.equal((await f.send(`/pomodoro/${screen}/countdown`)).status,404);
  for(const path of ['/pomodoro/4/','/pomodoro/4/unknown','/pomodoro/4/start','/pomodoro/4/countdown/extra','/pomodoro/04/countdown','/pomodoro/4/%63ountdown'])assert.equal((await f.send(path)).status,404,path);
  assert.deepEqual(f.timer.view(),initial);assert.equal(f.actionCalls(),0);
});

test('Pomodoro disabled leaves all timer data and native routes unavailable',async t=>{
  const f=await fixture(t,false);
  for(const path of ['/api/pomodoro','/api/pomodoro/control','/api/pomodoro/action','/pomodoro/static-v1.gif','/pomodoro/cat-v2.gif','/pomodoro/cat-loop-v1.gif','/pomodoro/cat-sleep-v1.gif',...POMODORO_FIELDS.map(field=>'/pomodoro/4/'+field)]){
    const response=await f.send(path);assert.equal(response.status,404,path);secured(response);
  }
  assert.equal((await f.send('/api/pomodoro/action',{method:'POST',body:'{"action":"start","expectedRevision":0}'})).status,405);
  assert.equal((await f.send('/api/status')).json.pomodoro,null);assert.equal((await f.send('/healthz')).status,200);assert.equal(f.actionCalls(),0);
});

test('browser actions and read polling change only in-memory timer state, never device/network calls',async t=>{
  const f=await fixture(t),token=(await f.control()).json.csrfToken;
  const outbound:string[]=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async input=>{outbound.push(String(input));throw new Error('External/device requests forbidden in this test');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  let response=await f.post(token,'start',0);assert.equal(response.json.view.remainingSeconds,1500);
  f.advance(12_500);response=await f.post(token,'pause',1);assert.equal(response.json.view.status,'paused');assert.equal(response.json.view.remainingSeconds,1488);
  f.advance(100_000);assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'24:48');
  response=await f.post(token,'resume',2);assert.equal(response.json.view.status,'running');
  response=await f.post(token,'reset',3);assert.equal(response.json.view.status,'idle');assert.equal(response.json.view.revision,4);
  assert.deepEqual(outbound,[]);assert.equal(f.actionCalls(),4);
  // Main's web callback is timer-only; actual device setup is gated separately by a CLI request.
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.match(main,/action:input=>pomodoro\.action\(input\)/);
  assert.match(main,/existsSync\(control\.path\('POMODORO_REQUEST'\)\)/);
  const server=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  assert.doesNotMatch(server,/\b(?:setupPomodoro|setupWeather|Writer|\.arm\(|\.restore\(|\.pair\()/);
});

test('four focus sessions automatically count down three short breaks and one long break without device requests or art changes',async t=>{
  const outbound:string[]=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async input=>{outbound.push(String(input));throw new Error('External/device requests forbidden in this test');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const f=await fixture(t),token=(await f.control()).json.csrfToken;
  const paths=['/pomodoro/static-v1.gif','/pomodoro/cat-v2.gif','/pomodoro/cat-loop-v1.gif','/pomodoro/cat-sleep-v1.gif'];
  const artwork=await Promise.all(paths.map(async path=>({path,bytes:(await f.send(path)).bytes})));
  const unchangedArtwork=async()=>{for(const {path,bytes} of artwork)assert.deepEqual((await f.send(path)).bytes,bytes,path);};
  let view=(await f.send('/api/pomodoro')).json;
  assert.equal(view.completedFocusSessions,0);assert.equal(view.focusSessionInCycle,1);assert.equal(view.breakDurationSeconds,300);assert.equal(view.longBreakDurationSeconds,900);
  for(let session=1;session<=4;session++){
    const started=await f.post(token,'start',view.revision);assert.equal(started.status,200);view=started.json.view;
    assert.equal(view.phase,'focus');assert.equal(view.status,'running');assert.equal(view.remainingSeconds,1500);assert.equal(view.durationSeconds,1500);
    assert.equal(view.completedFocusSessions,session-1);assert.equal(view.focusSessionInCycle,session);assert.equal(view.breakKind,null);assert.equal(view.revision,3*session-2);
    assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'25:00');await unchangedArtwork();
    f.advance(1_499_999);assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'00:01');assert.equal((await f.send('/api/pomodoro')).json.phase,'focus');
    f.advance(1);
    const duration=session===4?900:300;
    view=(await f.send('/api/pomodoro')).json;
    assert.equal(view.phase,'break');assert.equal(view.status,'running');assert.equal(view.breakKind,session===4?'long':'short');
    assert.equal(view.remainingSeconds,duration);assert.equal(view.durationSeconds,duration);assert.equal(view.breakDurationSeconds,300);assert.equal(view.longBreakDurationSeconds,900);
    assert.equal(view.completedFocusSessions,session);assert.equal(view.focusSessionInCycle,session);assert.equal(view.revision,3*session-1);assert.equal(view.updatedAt,started.json.view.updatedAt);
    assert.deepEqual(view.availableActions,['pause','reset']);assert.deepEqual((await f.control()).json.view,view);assert.deepEqual((await f.send('/api/status')).json.pomodoro,view);
    assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,session===4?'15:00':'05:00');assert.equal((await f.send('/pomodoro/4/phase')).json.DispData,'BREAK');
    assert.equal((await f.send('/pomodoro/4/status')).json.DispData,'RUNNING');await unchangedArtwork();assert.equal(f.actionCalls(),session);
    f.advance(1000);assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,session===4?'14:59':'04:59');assert.equal((await f.send('/api/pomodoro')).json.revision,view.revision);
    f.advance((duration-1)*1000);view=(await f.send('/api/pomodoro')).json;
    assert.equal(view.phase,'break');assert.equal(view.status,'completed');assert.equal(view.remainingSeconds,0);assert.equal(view.completedFocusSessions,session);assert.equal(view.revision,3*session);
    assert.deepEqual(view.availableActions,['start','reset']);assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'00:00');assert.equal((await f.send('/pomodoro/4/status')).json.DispData,'DONE - START WEB');
    f.advance(60_000);assert.deepEqual((await f.send('/api/pomodoro')).json,view);assert.deepEqual((await f.control()).json.view,view);await unchangedArtwork();assert.equal(f.actionCalls(),session);
  }
  const fifth=await f.post(token,'start',view.revision);assert.equal(fifth.status,200);
  assert.equal(fifth.json.view.phase,'focus');assert.equal(fifth.json.view.remainingSeconds,1500);assert.equal(fifth.json.view.completedFocusSessions,4);assert.equal(fifth.json.view.focusSessionInCycle,1);assert.equal(fifth.json.view.revision,13);
  const reset=await f.post(token,'reset',fifth.json.view.revision);assert.equal(reset.status,200);assert.equal(reset.json.view.status,'idle');assert.equal(reset.json.view.completedFocusSessions,0);assert.equal(reset.json.view.focusSessionInCycle,1);assert.equal(reset.json.view.breakKind,null);
  await unchangedArtwork();assert.equal(f.actionCalls(),6);assert.deepEqual(outbound,[]);
});

test('late integrated polling anchors the automatic break to focus expiry and never starts another focus',async t=>{
  for(const lateSeconds of [75,300,86_400]){
    const f=await fixture(t),token=(await f.control()).json.csrfToken;const started=await f.post(token,'start',0);assert.equal(started.status,200);
    f.advance((1500+lateSeconds)*1000);
    const remaining=Math.max(0,300-lateSeconds),completed=remaining===0;
    const view=(await f.send('/api/pomodoro')).json;
    assert.equal(view.phase,'break');assert.equal(view.status,completed?'completed':'running');assert.equal(view.remainingSeconds,remaining);assert.equal(view.completedFocusSessions,1);assert.equal(view.revision,completed?3:2);
    assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,completed?'00:00':'03:45');assert.deepEqual((await f.control()).json.view,view);assert.equal(f.actionCalls(),1);
    f.advance(7*24*60*60*1000);const finished=(await f.send('/api/pomodoro')).json;
    assert.equal(finished.phase,'break');assert.equal(finished.status,'completed');assert.equal(finished.remainingSeconds,0);assert.equal(finished.completedFocusSessions,1);assert.equal(finished.revision,3);
    assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'00:00');assert.equal(f.actionCalls(),1);
    const next=await f.post(token,'start',finished.revision);assert.equal(next.status,200);assert.equal(next.json.view.phase,'focus');assert.equal(next.json.view.status,'running');assert.equal(next.json.view.remainingSeconds,1500);assert.equal(next.json.view.completedFocusSessions,1);assert.equal(next.json.view.focusSessionInCycle,2);
  }
});

test('a new process starts idle and its CSRF token cannot reuse a previous process token',async t=>{
  const before=await fixture(t),oldToken=(await before.control()).json.csrfToken;
  assert.equal((await before.post(oldToken,'start',0)).json.view.status,'running');before.advance(30_000);
  const restarted=await fixture(t),fresh=(await restarted.control()).json;
  assert.notEqual(fresh.csrfToken,oldToken);assert.equal(fresh.view.status,'idle');assert.equal(fresh.view.remainingSeconds,1500);assert.equal(fresh.view.revision,0);
  assert.equal((await restarted.post(oldToken,'pause',1)).status,403);assert.equal(restarted.actionCalls(),0);
  assert.equal((await restarted.post(fresh.csrfToken,'start',0)).status,200);
});

// Background reads cannot change the timer or invoke any transport. The image is
// intentionally phase-independent until firmware refresh behavior is verified.
test('static cat background stays identical through focus, break and reset; legacy art remains available',async t=>{
 const f=await fixture(t),initial=f.timer.view();
 const art=await f.send('/pomodoro/cat-v2.gif');assert.equal(art.status,200);secured(art);
 assert.equal(art.headers['content-type'],'image/gif');assert.deepEqual(art.bytes,POMODORO_CAT_BACKGROUND);
 assert.equal(art.bytes.readUInt16LE(6),128);assert.equal(art.bytes.readUInt16LE(8),128);
 assert.deepEqual(f.timer.view(),initial);assert.equal(f.actionCalls(),0);
 const legacy=await f.send('/pomodoro/static-v1.gif');assert.equal(legacy.status,200);assert.notDeepEqual(legacy.bytes,art.bytes);
 const token=(await f.control()).json.csrfToken;
 await f.post(token,'start',0);f.advance(1500000);
 const resting=(await f.send('/api/pomodoro')).json;assert.equal(resting.status,'running');assert.equal(resting.phase,'break');assert.equal(resting.breakKind,'short');assert.equal(f.actionCalls(),1);
 assert.deepEqual((await f.send('/pomodoro/cat-v2.gif')).bytes,art.bytes);
 assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'05:00');
 await f.post(token,'reset',resting.revision);
 assert.deepEqual((await f.send('/pomodoro/cat-v2.gif')).bytes,art.bytes);
 assert.equal((await f.send('/pomodoro/cat-break.gif')).status,404);
 assert.equal((await f.send('/pomodoro/cat-v2.gif',{method:'POST'})).status,405);
});


test('animated cat GET is fixed, opt-in and phase-independent; every-second native reads have no side effects',async t=>{
 const f=await fixture(t),initial=f.timer.view();const art=await f.send('/pomodoro/cat-loop-v1.gif');
 assert.equal(art.status,200);assert.equal(art.headers['content-type'],'image/gif');secured(art);assert.deepEqual(art.bytes,POMODORO_CAT_ANIMATION);assert.notDeepEqual(art.bytes,POMODORO_CAT_BACKGROUND);
 assert.deepEqual(f.timer.view(),initial);assert.equal(f.actionCalls(),0);
 const token=(await f.control()).json.csrfToken;await f.post(token,'start',0);
 for(let i=0;i<5;i++){f.advance(1000);assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,`24:${59-i}`);assert.deepEqual((await f.send('/pomodoro/cat-loop-v1.gif')).bytes,art.bytes);}
 const paused=await f.post(token,'pause',1);f.advance(3000);assert.equal((await f.send('/pomodoro/4/countdown')).json.DispData,'24:55');assert.deepEqual((await f.send('/pomodoro/cat-loop-v1.gif')).bytes,art.bytes);
 await f.post(token,'reset',paused.json.view.revision);assert.deepEqual((await f.send('/pomodoro/cat-loop-v1.gif')).bytes,art.bytes);
 assert.equal((await f.send('/pomodoro/cat-loop-v1.gif',{method:'POST'})).status,405);
 const page=(await f.send('/')).text;assert.match(page,/continues while paused or idle/);assert.match(page,/Lost polling can leave the countdown frozen/);
});


test('sleeping loop stays a separate fixed GET asset through the automatic break',async t=>{
 const f=await fixture(t);const art=await f.send('/pomodoro/cat-sleep-v1.gif');
 assert.equal(art.status,200);assert.equal(art.headers['content-type'],'image/gif');secured(art);assert.deepEqual(art.bytes,POMODORO_CAT_SLEEP_ANIMATION);assert.notDeepEqual(art.bytes,POMODORO_CAT_ANIMATION);assert.equal(f.actionCalls(),0);
 const token=(await f.control()).json.csrfToken;await f.post(token,'start',0);f.advance(1500000);const resting=(await f.control()).json.view;assert.equal(resting.status,'running');assert.equal(resting.phase,'break');assert.equal(resting.breakKind,'short');
 assert.deepEqual((await f.send('/pomodoro/cat-sleep-v1.gif')).bytes,art.bytes);assert.deepEqual((await f.send('/pomodoro/cat-loop-v1.gif')).bytes,POMODORO_CAT_ANIMATION);
 assert.equal((await f.send('/pomodoro/cat-sleep-v1.gif',{method:'POST'})).status,405);assert.equal(f.actionCalls(),1);
});
