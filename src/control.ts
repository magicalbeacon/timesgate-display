import {mkdirSync,writeFileSync,readFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fingerprint,type Config} from './config.ts';
export class Control {
  config:Config;
  constructor(config:Config){this.config=config;mkdirSync(config.stateDir,{recursive:true});mkdirSync(config.runtimeDir,{recursive:true});}
  path(name:string){return join(name==='STATUS'?this.config.runtimeDir:this.config.stateDir,name);}
  write(name:string,value:unknown){const temp=`${this.path(name)}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,this.path(name));}
  remove(name:string){try{unlinkSync(this.path(name));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  stopVersion(){try{return readFileSync(this.path('STOP'),'utf8');}catch{return '';}}
  stop(){this.write('STOP',{at:new Date().toISOString(),nonce:randomUUID()});this.remove('ARM_REQUEST');this.remove('RESTORE_REQUEST');this.remove('WEATHER_REQUEST');this.remove('POMODORO_REQUEST');}
  requestArm(){if(!this.config.writesEnabled)throw new Error('DEVICE_WRITES_ENABLED must be true before arming');this.write('ARM_REQUEST',{fingerprint:fingerprint(this.config),stopVersion:this.stopVersion(),at:Date.now()});}
  takeArmRequest():string|null {
    if(!existsSync(this.path('ARM_REQUEST')))return null;
    let parsed;try{parsed=JSON.parse(readFileSync(this.path('ARM_REQUEST'),'utf8'));}catch{this.remove('ARM_REQUEST');return null;}
    this.remove('ARM_REQUEST');return this.config.writesEnabled&&parsed.fingerprint===fingerprint(this.config)&&typeof parsed.stopVersion==='string'&&parsed.stopVersion===this.stopVersion()&&Number.isFinite(parsed.at)&&Date.now()-parsed.at>=0&&Date.now()-parsed.at<60000?parsed.stopVersion:null;
  }
  arm(stopVersion=this.stopVersion()){this.write('ARMED',{fingerprint:fingerprint(this.config),stopVersion,at:new Date().toISOString()});this.remove('HALTED');}
  halt(){this.write('HALTED',{at:new Date().toISOString(),reason:'Device operation failed or was interrupted; inspect affected screens before explicitly arming again'});this.remove('ARMED');this.remove('ARM_REQUEST');this.remove('RESTORE_REQUEST');this.remove('WEATHER_REQUEST');this.remove('POMODORO_REQUEST');}
  isArmed():boolean {
    if(!this.config.writesEnabled||existsSync(this.path('HALTED')))return false;
    try{const armed=JSON.parse(readFileSync(this.path('ARMED'),'utf8'));return armed.fingerprint===fingerprint(this.config)&&armed.stopVersion===this.stopVersion();}catch{return false;}
  }
  status(){return {armed:this.isArmed(),stopped:!this.isArmed(),halted:existsSync(this.path('HALTED')),armRequested:existsSync(this.path('ARM_REQUEST')),weatherSetupRequested:existsSync(this.path('WEATHER_REQUEST')),pomodoroSetupRequested:existsSync(this.path('POMODORO_REQUEST')),writesEnabled:this.config.writesEnabled,targetScreens:this.config.screens.map(s=>s+1)};}
}
