import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.ts';
import {Control} from '../src/control.ts';
import {pomodoroLayout,pomodoroText,POMODORO_PHASE_ROWS} from '../src/pomodoro-device.ts';
import {PomodoroPhaseDisplay} from '../src/pomodoro-phase-display.ts';
import {pomodoroProfile,parsePomodoroSetup} from '../src/pomodoro-profile.ts';
import {PomodoroTimer,type PomodoroView} from '../src/pomodoro.ts';

const env={TARGET_SCREENS:'1,2',TICKERS:'VALL,SPCX',DEVICE_IP:'192.168.240.50',DEVICE_WRITES_ENABLED:'true',POMODORO_ENABLED:'true',SERVER_BASE_URL:'http://192.168.240.20:8081'};
const profile={pollSeconds:1,background:'phase'} as const;
const base=()=>new PomodoroTimer({}, {monotonicClock:()=>0}).view();
const focus=(completed=0):PomodoroView=>({...base(),phase:'focus',focusSessionInCycle:completed%4+1,completedFocusSessions:completed});
const resting=(completed=1):PomodoroView=>({...base(),phase:'break',status:'running',breakKind:completed%4===0?'long':'short',focusSessionInCycle:(completed-1)%4+1,completedFocusSessions:completed});

test('phase profile is explicit, keeps the one-second setting, and uses only screen-4 native polls',()=>{
 assert.deepEqual(parsePomodoroSetup(['setup','--apply','--poll-seconds','1','--background','phase']),profile);
 assert.deepEqual(pomodoroProfile(profile),profile);
 const config=loadConfig(env);
 assert.throws(()=>pomodoroLayout(config,profile),/current timer view/);
 for(const [view,background] of [[focus(),'cat-loop-v1.gif'],[resting(),'cat-sleep-v1.gif'],[resting(4),'cat-sleep-v1.gif']] as const){
  const payload=pomodoroLayout(config,profile,view);
  assert.equal(payload.Command,'Draw/SendHttpItemList');assert.equal(payload.LcdIndex,3);
  assert.equal(payload.BackgroudGif,`${env.SERVER_BASE_URL}/pomodoro/${background}`);
  assert.deepEqual(payload.ItemList.map(row=>row.TextId),[24,25,26]);
  assert.deepEqual(payload.ItemList.map(row=>row.TextString),POMODORO_PHASE_ROWS.map(row=>`${env.SERVER_BASE_URL}/pomodoro/4/${row.field}`));
  assert(payload.ItemList.every(row=>row.type===23&&row.update_time===1&&row.x+row.TextWidth<=128&&row.y+row.Textheight<=128));
  assert(!JSON.stringify(payload).includes('LocalToken'));
 }
 assert.equal(pomodoroText(focus(),'phase-label'),'FOCUS');
 assert.equal(pomodoroText(resting(),'phase-label'),'SHORT BREAK');
 assert.equal(pomodoroText(resting(4),'phase-label'),'LONG BREAK');
 assert.equal(pomodoroText(focus(),'session-dots'),'. . . .');
 assert.equal(pomodoroText(resting(),'session-dots'),'O . . .');
 assert.equal(pomodoroText(resting(4),'session-dots'),'O O O O');
 assert.equal(pomodoroText(focus(4),'session-dots'),'. . . .');
});

test('one acknowledged setup enables serialized phase writes; duplicates and a stop make no writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tg-phase-'));
 try{
  const config=loadConfig({...env,STATE_DIR:dir}),control=new Control(config);control.stop();control.halt();
  const sent:any[]=[];
  const display=new PomodoroPhaseDisplay(config,control,async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return new Response('{"error_code":0}');});
  assert.equal(await display.sync(resting()),'disabled');
  display.activate(focus(),control.stopVersion(),1);
  assert.equal(await display.sync(focus()),'unchanged');
  assert.deepEqual(await Promise.all([display.sync(resting()),display.sync(resting())]),['acknowledged','unchanged']);
  assert.equal(sent.length,1);assert.deepEqual(sent[0],pomodoroLayout(config,profile,resting()));
  assert.equal(await display.sync(resting(2)),'unchanged');
  assert.equal(await display.sync(focus(1)),'acknowledged');
  assert.equal(sent.length,2);assert.equal(sent[1].BackgroudGif,`${env.SERVER_BASE_URL}/pomodoro/cat-loop-v1.gif`);
  assert.equal(control.status().halted,true);assert.equal(control.isArmed(),false);
  control.halt();assert.equal(await display.sync(resting(2)),'disabled');assert.equal(sent.length,2);
  display.activate(focus(1),control.stopVersion(),1);control.stop();
  assert.equal(await display.sync(resting(2)),'disabled');assert.equal(sent.length,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a failed phase acknowledgement disables automation without retrying or clearing the stock hold',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tg-phase-fail-'));
 try{
  const config=loadConfig({...env,STATE_DIR:dir}),control=new Control(config);control.stop();control.halt();let calls=0;
  const display=new PomodoroPhaseDisplay(config,control,async()=>{calls++;return new Response('{"error_code":7}');});
  display.activate(focus(),control.stopVersion(),1);
  assert.equal(await display.sync(resting()),'failed (device error_code 7)');
  assert.equal(display.active,false);assert.equal(await display.sync(resting()),'disabled');
  assert.equal(calls,1);assert.equal(control.status().halted,true);assert.equal(control.isArmed(),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
