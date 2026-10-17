// Private addresses and credential values below are synthetic, mocked test fixtures.
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,pomodoroFingerprint,requirePomodoroServer,weatherFingerprint} from '../src/config.ts';
import {Control} from '../src/control.ts';
import {deviceFailureReason,type Fetcher} from '../src/device.ts';
import {POMODORO_FIELDS,POMODORO_POLL_SECONDS,POMODORO_ROWS,POMODORO_SCREEN,pomodoroLayout,pomodoroText,setupPomodoro} from '../src/pomodoro-device.ts';
import {PomodoroTimer,type PomodoroView} from '../src/pomodoro.ts';

// These explicit, token-free fixtures never load .env, inherit process.env,
// inspect credentials, or contact a device. Every setup has a local mock fetch.
const env={TARGET_SCREENS:'1,2',TICKERS:'VWRA,VALL',DEVICE_IP:'192.168.240.50',DEVICE_WRITES_ENABLED:'true',POMODORO_ENABLED:'true',SERVER_BASE_URL:'http://192.168.240.20:8081'};
const fields=['phase','countdown','progress','status','updated'];
const ok=()=>new Response('{"error_code":0}');
function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'tg-pomodoro-device-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const config=loadConfig({...env,STATE_DIR:dir});const control=new Control(config);control.stop();
 return {config,control};
}
function view(overrides:Partial<PomodoroView>={}):PomodoroView {
 return {...new PomodoroTimer({}, {monotonicClock:()=>0}).view(),...overrides};
}
function queueRequests(control:Control){
 control.requestArm();
 control.write('RESTORE_REQUEST',{fixture:true});
 control.write('WEATHER_REQUEST',{fixture:true});
 control.write('POMODORO_REQUEST',{fingerprint:pomodoroFingerprint(control.config),stopVersion:control.stopVersion(),at:Date.now()});
}
function assertRequestsCleared(control:Control){
 for(const name of ['ARM_REQUEST','RESTORE_REQUEST','WEATHER_REQUEST','POMODORO_REQUEST'])assert.equal(existsSync(control.path(name)),false,name);
 const status=control.status();assert.equal(status.armRequested,false);assert.equal(status.weatherSetupRequested,false);assert.equal(status.pomodoroSetupRequested,false);
}

test('Pomodoro is independently opt-in and accepts only explicit boolean configuration',()=>{
 const {POMODORO_ENABLED,...withoutPomodoro}=env;
 for(const value of [undefined,'','false'])assert.equal(loadConfig({...withoutPomodoro,POMODORO_ENABLED:value}).pomodoroEnabled,false);
 assert.equal(loadConfig(env).pomodoroEnabled,true);assert.equal(loadConfig(env).weatherEnabled,false);
 assert.equal(loadConfig({...withoutPomodoro,WEATHER_ENABLED:'true'}).pomodoroEnabled,false);
 for(const value of ['TRUE','False','1','yes',' true ','false\n'])assert.throws(()=>loadConfig({...env,POMODORO_ENABLED:value}),/POMODORO_ENABLED/);
 assert.deepEqual(loadConfig(env).screens,[0,1]);
});

test('Pomodoro polling origin must be clean private-LAN IPv4 HTTP',()=>{
 for(const base of [
  '', 'not a URL', 'http://localhost:8081', 'http://127.0.0.1:8081', 'http://0.0.0.0', 'http://8.8.8.8',
  'http://169.254.1.2', 'http://172.15.1.2', 'http://172.32.1.2', 'http://192.169.1.2',
  'http://[::1]', 'http://[fd00::1]', 'http://192.168.240.2.example.invalid', 'https://192.168.240.2',
  'ftp://192.168.240.2', 'http://user:password@192.168.240.2', 'http://192.168.240.2/path',
  'http://192.168.240.2/?key=x', 'http://192.168.240.2/#fragment',
 ])assert.throws(()=>requirePomodoroServer(loadConfig({...env,SERVER_BASE_URL:base})),base);
 for(const base of ['http://10.1.2.3:8081','http://172.16.0.1','http://172.31.255.254:8081','http://192.168.0.1'])assert.equal(requirePomodoroServer(loadConfig({...env,SERVER_BASE_URL:base})),base);
 assert.equal(requirePomodoroServer(loadConfig({...env,SERVER_BASE_URL:env.SERVER_BASE_URL+'/'})),env.SERVER_BASE_URL);
 assert.throws(()=>requirePomodoroServer(loadConfig({...env,POMODORO_ENABLED:'false'})),/Enable Pomodoro/);
});

test('Pomodoro setup fingerprint binds device, stock configuration and polling origin and differs from weather',()=>{
 const config=loadConfig({...env,WEATHER_ENABLED:'true'});const original=pomodoroFingerprint(config);
 assert.match(original,/^[a-f0-9]{64}$/);assert.equal(pomodoroFingerprint(loadConfig({...env,WEATHER_ENABLED:'true'})),original);
 for(const changes of [{DEVICE_IP:'192.168.240.51'},{SERVER_BASE_URL:'http://192.168.240.21:8081'},{TICKERS:'VALL,VWRA'},{ROTATION_SECONDS:'30'}])assert.notEqual(pomodoroFingerprint(loadConfig({...env,...changes})),original);
 assert.notEqual(original,weatherFingerprint(config));
 assert.throws(()=>pomodoroFingerprint(loadConfig({...env,POMODORO_ENABLED:'false'})));
});

test('native Pomodoro layout targets only physical screen4 with exact bounded centered text rows',()=>{
 const payload=pomodoroLayout(loadConfig(env));
 assert.equal(POMODORO_SCREEN,3);assert.equal(POMODORO_POLL_SECONDS,10);assert.deepEqual(POMODORO_FIELDS,fields);
 assert.deepEqual(Object.keys(payload),['Command','LcdIndex','NewFlag','BackgroudGif','ItemList']);
 assert.equal(payload.Command,'Draw/SendHttpItemList');assert.equal(payload.LcdIndex,3);assert.equal(payload.NewFlag,1);
 assert.equal(payload.BackgroudGif,env.SERVER_BASE_URL+'/pomodoro/static-v1.gif');
 assert.deepEqual(POMODORO_ROWS.map(({field,x,y,width,height,font,align})=>({field,x,y,width,height,font,align})),[
  {field:'phase',x:0,y:19,width:128,height:16,font:4,align:3},
  {field:'countdown',x:9,y:39,width:110,height:33,font:400,align:3},
  {field:'progress',x:0,y:77,width:128,height:16,font:4,align:3},
  {field:'status',x:0,y:94,width:128,height:16,font:4,align:3},
  {field:'updated',x:0,y:112,width:128,height:16,font:4,align:3},
 ]);
 assert.equal(payload.ItemList.length,5);assert.deepEqual(payload.ItemList.map(row=>row.TextId),[25,26,27,28,29]);
 payload.ItemList.forEach((row,index)=>{
  assert.deepEqual(Object.keys(row),['TextId','type','x','y','dir','font','TextWidth','Textheight','TextString','speed','color','update_time','align']);
  assert.equal(row.type,23);assert.equal(row.dir,0);assert.equal(row.speed,100);assert.equal(row.update_time,10);assert.equal(row.align,3);
  assert.equal(row.TextString,`${env.SERVER_BASE_URL}/pomodoro/4/${fields[index]}`);
  assert(row.x>=0&&row.y>=0&&row.TextWidth>0&&row.Textheight>0&&row.x+row.TextWidth<=128&&row.y+row.Textheight<=128);
  assert.equal(row.x+row.TextWidth/2,64);assert.match(row.color,/^#[0-9A-F]{6}$/);
 });
 assert.equal(payload.ItemList.filter(row=>row.font===400).length,1);
 for(let i=0;i<payload.ItemList.length;i++)for(let j=i+1;j<payload.ItemList.length;j++){
  const a=payload.ItemList[i],b=payload.ItemList[j];
  assert(a.x+a.TextWidth<=b.x||b.x+b.TextWidth<=a.x||a.y+a.Textheight<=b.y||b.y+b.Textheight<=a.y,'polling text rectangles must not overlap');
 }
 assert(!JSON.stringify(payload).includes('LocalToken'));
});

test('LCD countdown uses padded mm:ss with upward rounding and a bounded five-character display',()=>{
 for(const [seconds,expected] of [[1500,'25:00'],[300,'05:00'],[61,'01:01'],[60,'01:00'],[59,'00:59'],[1,'00:01'],[0.01,'00:01'],[59.1,'01:00'],[0,'00:00'],[-5,'00:00'],[5999,'99:59'],[6000,'99:59'],[86400,'99:59']] as const){
  const text=pomodoroText(view({remainingSeconds:seconds}),'countdown');assert.equal(text,expected);assert.match(text,/^\d{2}:\d{2}$/);
 }
});

test('LCD labels distinguish phases and manual completion and keep standard text within 128 pixels',()=>{
 assert.equal(pomodoroText(view(),'phase'),'FOCUS');assert.equal(pomodoroText(view({phase:'break'}),'phase'),'BREAK');
 for(const [status,expected] of [['idle','READY'],['running','RUNNING'],['paused','PAUSED'],['completed','DONE - START WEB']] as const){
  const label=pomodoroText(view({status}),'status');assert.equal(label,expected);assert(label.length*8<=128);
 }
 for(const [progress,expected] of [[-1,'0% COMPLETE'],[0,'0% COMPLETE'],[0.019,'1% COMPLETE'],[0.999,'99% COMPLETE'],[1,'100% COMPLETE'],[2,'100% COMPLETE']] as const)assert.equal(pomodoroText(view({progress}),'progress'),expected);
 assert.equal(pomodoroText(view(),'updated',Date.UTC(2026,9,17,13,4,9)),'21:04:09 SGT');
 for(const field of ['unknown','constructor','__proto__','LocalToken'])assert.throws(()=>pomodoroText(view(),field),/Unsupported Pomodoro field/);
});

test('explicit setup sends exactly one native LCD3 write and leaves stock rotation stopped',async t=>{
 const f=fixture(t);const sent:Array<{url:string;method:string|undefined;body:unknown;redirect:RequestRedirect|undefined}>=[];
 const stopVersion=f.control.stopVersion();
 await setupPomodoro(f.config,f.control,true,stopVersion,async(url,init)=>{
  assert.equal(new Headers(init?.headers).get('content-type'),'application/json');assert(init?.signal instanceof AbortSignal);
  const body=JSON.parse(String(init?.body));assert.equal(Object.hasOwn(body,'LocalToken'),false);
  sent.push({url:String(url),method:init?.method,body,redirect:init?.redirect});return ok();
 });
 assert.deepEqual(sent,[{url:f.config.device.url,method:'POST',body:pomodoroLayout(f.config),redirect:'error'}]);
 assert.equal(f.control.isArmed(),false);assert.equal(f.control.status().halted,false);assert.equal(f.control.stopVersion(),stopVersion);
 for(const key of ['LcdArray','LcdId','PicID','PicId','PicData'])assert.equal(Object.hasOwn(sent[0].body as object,key),false,key);
});

test('missing apply, disabled writes or disabled Pomodoro cannot reach the mock transport',async t=>{
 const f=fixture(t);let calls=0;const fake:Fetcher=async()=>{calls++;return ok();};
 await assert.rejects(()=>setupPomodoro(f.config,f.control,false,f.control.stopVersion(),fake));
 f.config.writesEnabled=false;await assert.rejects(()=>setupPomodoro(f.config,f.control,true,f.control.stopVersion(),fake));
 f.config.writesEnabled=true;f.config.pomodoroEnabled=false;
 await assert.rejects(()=>setupPomodoro(f.config,f.control,true,f.control.stopVersion(),fake),/Enable Pomodoro/);
 assert.equal(calls,0);assert.equal(f.control.status().halted,false);
});

test('armed stock rotation and stale stop generations block Pomodoro before transport',async t=>{
 const f=fixture(t);let calls=0;const fake:Fetcher=async()=>{calls++;return ok();};
 f.control.arm();assert.equal(f.control.isArmed(),true);
 await assert.rejects(()=>setupPomodoro(f.config,f.control,true,f.control.stopVersion(),fake));
 f.control.stop();const old=f.control.stopVersion();f.control.stop();
 await assert.rejects(()=>setupPomodoro(f.config,f.control,true,old,fake),/cancelled by stop/);
 assert.equal(calls,0);assert.equal(f.control.isArmed(),false);
});

test('the last-moment guard rejects a stop between preflight and transport',async t=>{
 const f=fixture(t);const stopVersion=f.control.stopVersion();let checks=0,calls=0;
 const original=f.control.stopVersion.bind(f.control);
 t.mock.method(f.control,'stopVersion',()=>{if(++checks===2)f.control.stop();return original();});
 await assert.rejects(()=>setupPomodoro(f.config,f.control,true,stopVersion,async()=>{calls++;return ok();}));
 assert.equal(checks,2);assert.equal(calls,0);assert.equal(f.control.isArmed(),false);assert.equal(f.control.status().halted,true);
});

test('the last-moment guard rejects stock arming after preflight',async t=>{
 const f=fixture(t);const stopVersion=f.control.stopVersion();let checks=0,calls=0;
 const original=f.control.isArmed.bind(f.control);
 t.mock.method(f.control,'isArmed',()=>{if(++checks===2)f.control.arm();return original();});
 await assert.rejects(()=>setupPomodoro(f.config,f.control,true,stopVersion,async()=>{calls++;return ok();}));
 assert.equal(calls,0);assert.equal(f.control.status().halted,true);assert.equal(f.control.isArmed(),false);
});

test('exact-payload guard fails closed on any other command, LCD, poll URL or extra write scope',async t=>{
 const mutations:Array<[string,(payload:any)=>void]>=[
  ['image ID probe',p=>{p.Command='Draw/GetHttpGifId';}],
  ['overlay clear',p=>{p.Command='Draw/ClearHttpText';}],
  ['global reset',p=>{p.Command='Draw/ResetHttpGifId';}],
  ...[0,1,2,4,-1].map(index=>[`LCD ${index}`,(p:any)=>{p.LcdIndex=index;}] as [string,(payload:any)=>void]),
  ['replace flag',p=>{p.NewFlag=0;}],
  ['background URL',p=>{p.BackgroudGif='http://8.8.8.8/other.gif';}],
  ['empty rows',p=>{p.ItemList=[];}],
  ['different panel poll',p=>{p.ItemList[0].TextString=env.SERVER_BASE_URL+'/pomodoro/5/phase';}],
  ['different font',p=>{p.ItemList[1].font=246;}],
  ['out-of-bounds row',p=>{p.ItemList[0].TextWidth=129;}],
  ['extra display mask',p=>{p.LcdArray=[1,1,1,1,1];}],
  ['extra LCD ID',p=>{p.LcdId=2;}],
  ['extra image ID',p=>{p.PicID=7;}],
 ];
 for(const [name,mutate] of mutations){
  const f=fixture(t);let altered=false,calls=0;
  const stringify=JSON.stringify;
  // The guard is private. Alter only the single outgoing serialization, then
  // let its real comparison use the original function and untouched layout.
  const spy=t.mock.method(JSON,'stringify',function(value:any,...rest:any[]){
   if(!altered&&value?.Command==='Draw/SendHttpItemList'&&Array.isArray(value.ItemList)){
    altered=true;const changed=structuredClone(value);mutate(changed);return Reflect.apply(stringify,JSON,[changed,...rest]);
   }
   return Reflect.apply(stringify,JSON,[value,...rest]);
  });
  try {
   await assert.rejects(()=>setupPomodoro(f.config,f.control,true,f.control.stopVersion(),async()=>{calls++;return ok();}),name);
   assert.equal(altered,true,name);assert.equal(calls,0,name);assert.equal(f.control.status().halted,true,name);
  }finally{spy.mock.restore();}
 }
});

test('guard rejects a changed destination before even the mock transport is called',async t=>{
 const f=fixture(t);const original=f.config.device.url;let reads=0,calls=0;
 Object.defineProperty(f.config.device,'url',{configurable:true,get:()=>++reads===1?'http://192.168.240.99/post':original});
 await assert.rejects(()=>setupPomodoro(f.config,f.control,true,f.control.stopVersion(),async()=>{calls++;return ok();}));
 assert.equal(calls,0);assert.equal(f.control.status().halted,true);
});

test('stop during an already-sent setup remains effective after its delayed acknowledgement',async t=>{
 const f=fixture(t);const stopVersion=f.control.stopVersion();let calls=0;
 let release!:(value:Response)=>void;const response=new Promise<Response>(resolve=>{release=resolve;});
 const pending=setupPomodoro(f.config,f.control,true,stopVersion,async()=>{calls++;return response;});
 assert.equal(calls,1);queueRequests(f.control);f.control.stop();const stoppedVersion=f.control.stopVersion();
 assert.notEqual(stoppedVersion,stopVersion);assertRequestsCleared(f.control);
 release(ok());await pending;
 assert.equal(calls,1);assert.equal(f.control.stopVersion(),stoppedVersion);assert.equal(f.control.isArmed(),false);assertRequestsCleared(f.control);
 await assert.rejects(()=>setupPomodoro(f.config,f.control,true,stopVersion,async()=>{calls++;return ok();}));
 assert.equal(calls,1);
});

test('an uncertain setup latches a persistent halt and clears every queued device write',async t=>{
 const f=fixture(t);const marker='SYNTHETIC_RESPONSE_MUST_NOT_BE_LOGGED';let calls=0,caught:unknown;
 try {
  await setupPomodoro(f.config,f.control,true,f.control.stopVersion(),async()=>{
   calls++;queueRequests(f.control);throw new Error(marker);
  });
 }catch(error){caught=error;}
 assert.equal(calls,1);assert.equal(deviceFailureReason(caught),'network request failed');assert(!String(caught).includes(marker));
 assert.equal(f.control.status().halted,true);assert.equal(f.control.isArmed(),false);assertRequestsCleared(f.control);
 const persisted=new Control(f.config);assert.equal(persisted.status().halted,true);assert.equal(persisted.isArmed(),false);assertRequestsCleared(persisted);
 const halt=JSON.parse(readFileSync(f.control.path('HALTED'),'utf8'));assert.deepEqual(Object.keys(halt),['at','reason']);
 assert(!JSON.stringify(halt).includes(marker));assert(!JSON.stringify(halt).includes('LocalToken'));assert(!JSON.stringify(persisted.status()).includes(marker));
});

test('HTTP rejection, bad acknowledgement and interruption each halt once without exposing response content',async t=>{
 const marker='SYNTHETIC_RESPONSE_MUST_NOT_BE_LOGGED';
 const failures:Array<[string,Fetcher]>=[
  ['HTTP status 503',async()=>new Response(marker,{status:503})],
  ['response was not valid JSON',async()=>new Response(marker)],
  ['response omitted error_code',async()=>new Response(JSON.stringify({message:marker}))],
  ['device error_code 7',async()=>new Response(JSON.stringify({error_code:7,message:marker}))],
  ['request interrupted',async()=>{throw new DOMException(marker,'AbortError');}],
 ];
 for(const [expected,failure] of failures){
  const f=fixture(t);let calls=0,caught:unknown;
  try{await setupPomodoro(f.config,f.control,true,f.control.stopVersion(),async(...args)=>{calls++;return failure(...args);});}catch(error){caught=error;}
  assert.equal(calls,1);assert.equal(deviceFailureReason(caught),expected);assert(!String(caught).includes(marker));assert.equal(f.control.status().halted,true);
  assert(!readFileSync(f.control.path('HALTED'),'utf8').includes(marker));
 }
});

test('expired setup deadline halts without retrying the native write',async t=>{
 const f=fixture(t);f.config.device.timeout=1;let calls=0,caught:unknown;
 try{await setupPomodoro(f.config,f.control,true,f.control.stopVersion(),async(_url,init)=>{
  calls++;await new Promise(resolve=>setTimeout(resolve,15));assert.equal(init?.signal?.aborted,true);throw new Error('SYNTHETIC_TIMEOUT_DETAIL');
 });}catch(error){caught=error;}
 assert.equal(calls,1);assert.equal(deviceFailureReason(caught),'request timed out');assert(!String(caught).includes('SYNTHETIC_TIMEOUT_DETAIL'));assert.equal(f.control.status().halted,true);
});

test('stop removes queued Pomodoro and all other requests so startup cannot replay them',t=>{
 const f=fixture(t);queueRequests(f.control);assert.equal(f.control.status().pomodoroSetupRequested,true);const old=f.control.stopVersion();
 f.control.stop();assert.notEqual(f.control.stopVersion(),old);assertRequestsCleared(f.control);
 const restarted=new Control(f.config);assertRequestsCleared(restarted);assert.equal(restarted.takeArmRequest(),null);assert.equal(restarted.isArmed(),false);
});

test('halt removes armed state plus queued Pomodoro, restore, weather and arm requests',t=>{
 const f=fixture(t);f.control.arm();queueRequests(f.control);assert.equal(f.control.isArmed(),true);assert.equal(f.control.status().pomodoroSetupRequested,true);
 f.control.halt();assert.equal(existsSync(f.control.path('ARMED')),false);assert.equal(f.control.status().halted,true);assert.equal(f.control.isArmed(),false);assertRequestsCleared(f.control);
 const restarted=new Control(f.config);assert.equal(restarted.status().halted,true);assertRequestsCleared(restarted);
});
