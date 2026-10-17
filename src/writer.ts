import {pushImage,readNextId,restoreLayout,type Fetcher} from './device.ts';
import type {Config} from './config.ts';
import {Control} from './control.ts';
/** Every outgoing command is checked again at the network boundary. */
export function guardedFetch(config:Config,canWrite:()=>boolean,fetcher:Fetcher=fetch):Fetcher {
  return (async (url,init)=>{
    if(String(url)!==config.device.url||init?.method!=='POST'||typeof init.body!=='string')throw new Error('Blocked unexpected device request');
    const p=JSON.parse(init.body);const selected=(n:unknown)=>typeof n==='number'&&config.screens.includes(n);
    if(p.Command==='Draw/GetHttpGifId'){/* read only */}
    else {
      if(!canWrite())throw new Error('Device writes stopped');
      if(p.Command==='Draw/ClearHttpText'){if(!selected(p.LcdId)||p.TextId!==-1)throw new Error('Blocked non-selected clear');}
      else if(p.Command==='Draw/SendHttpGif'){
        if(!Array.isArray(p.LcdArray)||p.LcdArray.length!==5||p.LcdArray.some((v:unknown)=>v!==0&&v!==1)||p.LcdArray.reduce((a:number,b:number)=>a+b,0)!==1||!selected(p.LcdArray.indexOf(1)))throw new Error('Blocked non-selected image write');
      } else if(p.Command==='Draw/SendHttpItemList'){if(!selected(p.LcdIndex))throw new Error('Blocked non-selected restore');}
      else throw new Error('Blocked unsupported device command');
    }
    return fetcher(url,init);
  }) as Fetcher;
}
export class Writer {
  config:Config;control:Control;fetcher:Fetcher;busy=false;
  constructor(config:Config,control:Control,fetcher:Fetcher=fetch){this.config=config;this.control=control;this.fetcher=fetcher;}
  async processArm():Promise<boolean>{if(this.busy)return false;const stopVersion=this.control.takeArmRequest();if(stopVersion===null)return false;this.busy=true;try{await readNextId(this.config.device,guardedFetch(this.config,()=>false,this.fetcher));if(this.control.stopVersion()!==stopVersion)return false;this.control.arm(stopVersion);return true;}catch{this.control.halt();return false;}finally{this.busy=false;}}
  async pair(images:Buffer[]):Promise<boolean>{
    if(this.busy||!this.control.isArmed())return false;
    if(images.length!==2)throw new Error('Exactly two images required');
    this.busy=true;
    try{for(let i=0;i<2;i++){
      if(!this.control.isArmed())return false;
      await pushImage(this.config.device,this.config.screens[i],images[i],true,guardedFetch(this.config,()=>this.control.isArmed(),this.fetcher));
    }return true;}catch{this.control.halt();return false;}finally{this.busy=false;}
  }
  async restore(input:unknown,apply=false,stopVersion=this.control.stopVersion()):Promise<boolean>{
    if(!apply||!this.config.writesEnabled)throw new Error('Restore requires explicit apply and DEVICE_WRITES_ENABLED=true');
    if(this.busy||this.control.isArmed())throw new Error('Stop rotation and wait for the current request before restoring');
    if(stopVersion!==this.control.stopVersion())throw new Error('Restore was cancelled by a stop');
    this.busy=true;
    try{
      // Validate both selected exports before sending either restore.
      const validateOnly=(async()=>new Response(JSON.stringify({error_code:0}),{status:200})) as Fetcher;
      for(const screen of this.config.screens)await restoreLayout(this.config.device,screen,input,true,guardedFetch(this.config,()=>true,validateOnly));
      for(const screen of this.config.screens)await restoreLayout(this.config.device,screen,input,true,guardedFetch(this.config,()=>!this.control.isArmed()&&this.control.stopVersion()===stopVersion,this.fetcher));return true;}
    catch{this.control.halt();return false;}finally{this.busy=false;}
  }
}
