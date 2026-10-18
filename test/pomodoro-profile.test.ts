import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pomodoroProfile,parsePomodoroSetup} from '../src/pomodoro-profile.ts';
import {loadConfig,pomodoroFingerprint,fingerprint,weatherFingerprint} from '../src/config.ts';
import {pomodoroLayout,setupPomodoro} from '../src/pomodoro-device.ts';
import {Control} from '../src/control.ts';
const env={TARGET_SCREENS:'1,2',TICKERS:'AAPL,MSFT',DEVICE_IP:'192.168.240.50',FINNHUB_API_KEY:'SYNTHETIC_KEY',DEVICE_WRITES_ENABLED:'true',POMODORO_ENABLED:'true',WEATHER_ENABLED:'true',SERVER_BASE_URL:'http://192.168.240.20:8081'};
const profiles=[{pollSeconds:10,background:'static'},{pollSeconds:1,background:'static'},{pollSeconds:10,background:'animated'},{pollSeconds:1,background:'animated'},{pollSeconds:10,background:'sleeping'},{pollSeconds:1,background:'sleeping'}] as const;
test('experiments default to the working static10s profile, require explicit apply and accept only independent bounded options',()=>{
 assert.deepEqual(pomodoroProfile(),profiles[0]);assert.deepEqual(parsePomodoroSetup(['setup','--apply']),profiles[0]);
 for(const profile of profiles){
  assert.deepEqual(parsePomodoroSetup(['setup','--apply','--poll-seconds',String(profile.pollSeconds),'--background',profile.background]),profile);
  assert.deepEqual(parsePomodoroSetup(['setup','--background',profile.background,'--poll-seconds',String(profile.pollSeconds),'--apply']),profile);
 }
 assert.deepEqual(parsePomodoroSetup(['setup','--apply','--poll-seconds','1']),profiles[1]);
 assert.deepEqual(parsePomodoroSetup(['setup','--apply','--background','animated']),profiles[2]);
 for(const args of [[],['setup'],['setup','--poll-seconds','1'],['start','--apply'],['setup','--apply','--apply'],['setup','--apply','--poll-seconds'],['setup','--apply','--poll-seconds','0'],['setup','--apply','--poll-seconds','2'],['setup','--apply','--poll-seconds','01'],['setup','--apply','--poll-seconds','1','--poll-seconds','10'],['setup','--apply','--background','Animated'],['setup','--apply','--background','animated','--background','static'],['setup','--apply','--screen','5'],['setup','--apply','--poll-seconds=1'],['setup','--apply','EXTRA']])assert.throws(()=>parsePomodoroSetup(args),args.join(' '));
});
test('queued profiles require exact own properties and reject malformed or extra-scope data',()=>{
 for(const value of [null,false,'animated',[],{},1,{pollSeconds:'1',background:'animated'},{pollSeconds:1,background:'animated',screen:0},{pollSeconds:NaN,background:'static'},{pollSeconds:10,background:'http://evil.invalid/asset.gif'},Object.create(profiles[0])])assert.throws(()=>pomodoroProfile(value));
 const input={...profiles[0]};const normalized=pomodoroProfile(input);input.pollSeconds=1 as 10;assert.equal(normalized.pollSeconds,10);
});
test('each profile is bound to its queue fingerprint without changing stock or weather fingerprints',()=>{
 const config=loadConfig(env),stock=fingerprint(config),weather=weatherFingerprint(config);
 const hashes=profiles.map(p=>pomodoroFingerprint(config,p));assert.equal(new Set(hashes).size,6);
 assert.equal(pomodoroFingerprint(config),hashes[0]);
 assert.equal(fingerprint(config),stock);assert.equal(weatherFingerprint(config),weather);
});
test('six profiles change only LCD3 polling interval and static versus loop URL, with unchanged fallback',()=>{
 const config=loadConfig(env),baseline=pomodoroLayout(config);
 for(const profile of profiles){
  const payload=pomodoroLayout(config,profile);assert.equal(payload.LcdIndex,3);assert.equal(payload.NewFlag,1);assert.equal(payload.ItemList.length,1);assert.equal(payload.ItemList[0].TextId,26);
  assert.equal(payload.ItemList[0].update_time,profile.pollSeconds);
  assert.equal(payload.BackgroudGif,env.SERVER_BASE_URL+'/pomodoro/'+(profile.background==='animated'?'cat-loop-v1.gif':profile.background==='sleeping'?'cat-sleep-v1.gif':'cat-v2.gif'));
  const normalized=structuredClone(payload);normalized.BackgroudGif=baseline.BackgroudGif;normalized.ItemList[0].update_time=10;
  assert.deepEqual(normalized,baseline);
 }
});
test('each experiment remains one explicit screen4 setup, respects stop/arm guards, and leaves a prior halt intact',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tg-profile-'));
 try{
  const config=loadConfig({...env,STATE_DIR:dir}),control=new Control(config);control.stop();control.halt();
  for(const profile of profiles){
   const sent:any[]=[];const transport=async(_url:unknown,init?:RequestInit)=>{sent.push(JSON.parse(String(init?.body)));return new Response('{"error_code":0}');};
   await assert.rejects(()=>setupPomodoro(config,control,false,control.stopVersion(),transport,profile));assert.deepEqual(sent,[]);
   await setupPomodoro(config,control,true,control.stopVersion(),transport,profile);assert.deepEqual(sent,[pomodoroLayout(config,profile)]);
   assert.equal(control.isArmed(),false);assert.equal(control.status().halted,true);
   control.arm();await assert.rejects(()=>setupPomodoro(config,control,true,control.stopVersion(),transport,profile));assert.equal(sent.length,1);control.stop();control.halt();
  }
  let calls=0;await assert.rejects(()=>setupPomodoro(config,control,true,control.stopVersion(),async()=>{calls++;return new Response('{}');},{pollSeconds:0,background:'animated'}));assert.equal(calls,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
