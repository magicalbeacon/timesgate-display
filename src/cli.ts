import {parsePomodoroSetup} from './pomodoro-profile.ts';
import {readFileSync,statSync} from 'node:fs';
import {loadConfig,fingerprint,weatherFingerprint,pomodoroFingerprint} from './config.ts';
import {Control} from './control.ts';
import {readNextId,deviceFailureReason} from './device.ts';
import {guardedFetch} from './writer.ts';
const [command,...args]=process.argv.slice(2);
async function main(){
  if(!command||command==='help'){console.log('Commands: status | stop | probe | arm --apply | restore --layout /app/state/stock-layout.json --apply. Stocks target screens1–2 only. Weather: weather setup --apply targets screen5 only. Pomodoro: pomodoro setup --apply [--poll-seconds 1|10] [--background static|animated|sleeping|phase] targets screen4 only; defaults static/10s. The phase profile uses typing cat for focus and sleeping cat for breaks.');return;}
  if(!['status','stop','probe','arm','restore','weather','pomodoro'].includes(command))throw new Error('Unknown command');
  if(['arm','restore','weather','pomodoro'].includes(command)&&!args.includes('--apply'))throw new Error('Explicit --apply required; no action taken');
  const config=loadConfig();const control=new Control(config);
  if(command==='stop'){control.stop();console.log('Stop requested. An already-sent request may finish; no subsequent image writes will start.');}
  else if(command==='status'){let runtime:unknown=null;try{runtime=JSON.parse(readFileSync(control.path('STATUS'),'utf8'));}catch{}console.log(JSON.stringify({control:control.status(),runtime},null,2));}
  else if(command==='probe'){await readNextId(config.device,guardedFetch(config,()=>false));console.log('Read-only next-image-ID probe succeeded. No screen changed.');}
  else if(command==='arm'){
    let heartbeat=0;try{heartbeat=Date.parse(JSON.parse(readFileSync(control.path('STATUS'),'utf8')).heartbeat);}catch{}
    if(!Number.isFinite(heartbeat)||Date.now()-heartbeat>45000)throw new Error('Service heartbeat missing or old; start the service before requesting arm');
    control.requestArm();console.log('Arm requested for exactly the configured two screens. The running service probes first; check status for armed or halted.');
  }else if(command==='weather'){
    if(args[0]!=='setup'||control.isArmed()||!config.writesEnabled)throw new Error('Use weather setup --apply after stopping stock rotation');
    let heartbeat=0;try{heartbeat=Date.parse(JSON.parse(readFileSync(control.path('STATUS'),'utf8')).heartbeat);}catch{}
    if(!Number.isFinite(heartbeat)||Date.now()-heartbeat>45000)throw new Error('Service heartbeat missing or old');
    control.write('WEATHER_REQUEST',{fingerprint:weatherFingerprint(config),stopVersion:control.stopVersion(),at:Date.now()});
    console.log('Native weather setup requested for screen5 only. Check status. Stock rotation remains stopped until explicitly armed.');
  }else if(command==='pomodoro'){
    const profile=parsePomodoroSetup(args);
    if(args[0]!=='setup'||control.isArmed()||!config.writesEnabled)throw new Error('Use pomodoro setup --apply after stopping stock rotation');
    let heartbeat=0;try{heartbeat=Date.parse(JSON.parse(readFileSync(control.path('STATUS'),'utf8')).heartbeat);}catch{}
    if(!Number.isFinite(heartbeat)||Date.now()-heartbeat>45000)throw new Error('Service heartbeat missing or old');
    control.write('POMODORO_REQUEST',{fingerprint:pomodoroFingerprint(config,profile),profile,stopVersion:control.stopVersion(),at:Date.now()});
    console.log(`Native Pomodoro setup requested for screen4 only: ${profile.background}, ${profile.pollSeconds}-second text polling. Check status and the physical panel. Stock rotation remains stopped.`);
  }else if(command==='restore'){
    if(control.isArmed()||!config.writesEnabled)throw new Error('Stop rotation first and enable explicit device writes');
    const flag=args.indexOf('--layout');if(flag<0||!args[flag+1])throw new Error('Provide --layout with a token-free stock-app layout export');
    let layout:unknown;try{if(statSync(args[flag+1]).size>65536)throw new Error();const bytes=readFileSync(args[flag+1]);if(bytes.length>65536)throw new Error();layout=JSON.parse(bytes.toString());if(!Array.isArray(layout)||layout.length!==5)throw new Error();}catch{throw new Error('Expected a bounded five-screen layout JSON export');}
    control.write('RESTORE_REQUEST',{layout,fingerprint:fingerprint(config),stopVersion:control.stopVersion(),at:Date.now()});console.log('Selected-screen restore requested. Check status; this does not restore custom app screens or start rotation.');
  }
}
main().catch((error)=>{console.error(command==='probe'?`Read-only probe failed (${deviceFailureReason(error)}); no screen changed.`:'Command failed. Check local configuration, required --apply, service status and file paths; no secrets or provider responses logged.');process.exitCode=1;});
