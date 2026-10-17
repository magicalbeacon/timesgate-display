// Private addresses and credential values below are synthetic, mocked test fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer,request} from 'node:http';
import {loadConfig,pomodoroFingerprint} from '../src/config.ts';
import {Control} from '../src/control.ts';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){for(let n=0;n<100;n++){if(check())return;await wait(50);}assert.fail('Mock service state did not settle');}

test('whole main/CLI: manual LCD3 only, web timer has no device calls, stocks stay LCD0/1, failure halts and restart resets',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tg-pomo-main-'));const cwd=new URL('..',import.meta.url).pathname;
 const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
 const env={PATH:process.env.PATH!,NODE_OPTIONS:'--max-old-space-size=128',TARGET_SCREENS:'1,2',TICKERS:'AAPL,MSFT',DEVICE_IP:'192.168.240.50',DEVICE_WRITES_ENABLED:'true',FINNHUB_API_KEY:'SYNTHETIC_KEY',LOCAL_TOKEN:'987654321',POMODORO_ENABLED:'true',WEATHER_ENABLED:'false',SERVER_BASE_URL:`http://192.168.240.20:${port}`,PORT:String(port),STATE_DIR:dir,MOCK_DEVICE_LOG:join(dir,'calls'),MOCK_FAILURE:join(dir,'failure')};
 const mock=join(dir,'fetch-mock.mjs');writeFileSync(mock,`import {appendFileSync,existsSync} from 'node:fs';globalThis.fetch=async(input,init)=>{if(String(input)==='http://192.168.240.50/post'){const p=JSON.parse(init.body);appendFileSync(process.env.MOCK_DEVICE_LOG,JSON.stringify({Command:p.Command,LcdIndex:p.LcdIndex,LcdId:p.LcdId,LcdArray:p.LcdArray})+'\\n');return new Response(JSON.stringify({error_code:existsSync(process.env.MOCK_FAILURE)?7:0,PicId:3}));}return new Response('{}',{status:503});};`);
 const cli=(...args:string[])=>spawnSync(process.execPath,['src/cli.ts',...args],{cwd,env,encoding:'utf8'});
 const config=loadConfig(env),control=new Control(config);control.write('POMODORO_REQUEST',{old:true});
 let child:ChildProcess|undefined,output='';
 const start=()=>{child=spawn(process.execPath,['--import',pathToFileURL(mock).href,'src/main.ts'],{cwd,env,stdio:['ignore','pipe','pipe']});child.stdout!.on('data',b=>output+=b);child.stderr!.on('data',b=>output+=b);};
 const stop=async()=>{if(child&&child.exitCode===null){const ended=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await ended;}};
 const state=()=>JSON.parse(readFileSync(control.path('STATUS'),'utf8'));
 const calls=()=>existsSync(env.MOCK_DEVICE_LOG)?readFileSync(env.MOCK_DEVICE_LOG,'utf8').trim().split('\n').map(s=>JSON.parse(s)):[];
 const http=(path:string,method='GET',body?:unknown,csrf?:string)=>new Promise<any>((resolve,reject)=>{const headers:Record<string,string>={Host:`192.168.240.20:${port}`,Connection:'close'};if(body){headers.Origin=env.SERVER_BASE_URL;headers['Content-Type']='application/json';headers['X-Pomodoro-CSRF']=csrf!;}const req=request({host:'127.0.0.1',port,path,method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 try{
  start();await until(()=>existsSync(control.path('STATUS')));assert.equal(state().pomodoro.status,'idle');assert.deepEqual(calls(),[]);assert.equal(existsSync(control.path('POMODORO_REQUEST')),false);
  assert.equal(cli('pomodoro','setup').status,1);assert.deepEqual(calls(),[]);
  control.write('POMODORO_REQUEST',{fingerprint:pomodoroFingerprint(config),stopVersion:control.stopVersion(),at:Date.now()-61000});await until(()=>state().lastPomodoroSetup?.includes('rejected'));assert.deepEqual(calls(),[]);
  assert.equal(cli('pomodoro','setup','--apply').status,0);await until(()=>state().lastPomodoroSetup==='Screen4 native Pomodoro setup acknowledged');assert.deepEqual(calls(),[{Command:'Draw/SendHttpItemList',LcdIndex:3}]);
  const before=await http('/api/pomodoro/control');assert.equal(before.status,200);const action=await http('/api/pomodoro/action','POST',{action:'start',expectedRevision:before.data.view.revision},before.data.csrfToken);assert.equal(action.status,200);await until(()=>state().pomodoro.status==='running');assert.equal(calls().length,1);
  assert.equal(cli('arm','--apply').status,0);await until(()=>calls().length===8);assert.deepEqual(calls().filter(p=>p.LcdArray).map(p=>p.LcdArray),[[1,0,0,0,0],[0,1,0,0,0]]);assert.deepEqual(calls().filter(p=>p.LcdId!==undefined).map(p=>p.LcdId),[0,1]);assert.equal(cli('pomodoro','setup','--apply').status,1);
  assert.equal(cli('stop').status,0);writeFileSync(env.MOCK_FAILURE,'fail');assert.equal(cli('pomodoro','setup','--apply').status,0);await until(()=>state().lastPomodoroSetup?.includes('error_code 7'));assert.equal(state().control.halted,true);assert.equal(calls().length,9);assert.equal(calls().at(-1).LcdIndex,3);await wait(700);assert.equal(calls().length,9);
  const report=cli('status');for(const secret of ['SYNTHETIC_KEY','987654321']){assert(!report.stdout.includes(secret));assert(!output.includes(secret));}
  await stop();const lastHeartbeat=state().heartbeat;start();await until(()=>state().heartbeat!==lastHeartbeat);assert.equal(state().pomodoro.status,'idle');assert.equal(state().control.armed,false);assert.equal(calls().length,9);
 }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
