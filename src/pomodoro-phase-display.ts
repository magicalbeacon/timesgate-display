import type {Config} from './config.ts';
import {Control} from './control.ts';
import {deviceFailureReason,type Fetcher} from './device.ts';
import {setupPomodoro} from './pomodoro-device.ts';
import type {PomodoroPhase,PomodoroView} from './pomodoro.ts';

/** Opt-in, process-local screen-4 phase switching after one acknowledged setup. */
export class PomodoroPhaseDisplay {
  #generation:string|null=null;
  #phase:PomodoroPhase|null=null;
  #pollSeconds:1|10=10;
  #haltRevision=0;
  #busy=false;
  #config:Config;
  #control:Control;
  #fetcher:Fetcher;
  constructor(config:Config,control:Control,fetcher:Fetcher=fetch){this.#config=config;this.#control=control;this.#fetcher=fetcher;}
  get active(){return this.#generation!==null;}
  get acknowledgedPhase(){return this.#phase;}
  disable(){this.#generation=null;this.#phase=null;}
  activate(view:PomodoroView,stopVersion:string,pollSeconds:1|10){
    this.disable();
    if(!this.#config.pomodoroEnabled||!this.#config.writesEnabled||this.#control.isArmed()||stopVersion!==this.#control.stopVersion())return;
    this.#generation=stopVersion;this.#phase=view.phase;this.#pollSeconds=pollSeconds;this.#haltRevision=this.#control.haltRevision();
  }
  /** No retries: the next explicit setup is required after an uncertain write. */
  async sync(view:PomodoroView):Promise<'unchanged'|'disabled'|'acknowledged'|`failed (${string})`>{
    if(this.#generation===null)return 'disabled';
    if(this.#generation!==this.#control.stopVersion()||this.#haltRevision!==this.#control.haltRevision()||this.#control.isArmed()||!this.#config.writesEnabled){this.disable();return 'disabled';}
    if(this.#busy||this.#phase===view.phase)return 'unchanged';
    this.#busy=true;
    try{
      await setupPomodoro(this.#config,this.#control,true,this.#generation,this.#fetcher,{pollSeconds:this.#pollSeconds,background:'phase'},view);
      if(this.#generation===this.#control.stopVersion())this.#phase=view.phase;
      else this.disable();
      return 'acknowledged';
    }catch(error){this.disable();return `failed (${deviceFailureReason(error)})`;}
    finally{this.#busy=false;}
  }
}
