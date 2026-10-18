/** Deliberate, independent screen-4 experiments. No environment or device access. */
export type PomodoroProfile={pollSeconds:1|10;background:'static'|'animated'|'sleeping'|'phase'};
export function pomodoroProfile(value:unknown=undefined):PomodoroProfile {
 if(value===undefined)return {pollSeconds:10,background:'static'};
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Pomodoro display profile');
 const p=value as Record<string,unknown>;
 if(Object.keys(p).length!==2||!Object.hasOwn(p,'pollSeconds')||!Object.hasOwn(p,'background')||
    (p.pollSeconds!==1&&p.pollSeconds!==10)||(p.background!=='static'&&p.background!=='animated'&&p.background!=='sleeping'&&p.background!=='phase'))throw new Error('Invalid Pomodoro display profile');
 return {pollSeconds:p.pollSeconds,background:p.background};
}
export function parsePomodoroSetup(args:string[]):PomodoroProfile {
 if(args[0]!=='setup')throw new Error('Use Pomodoro setup');
 const profile=pomodoroProfile();const seen=new Set<string>();
 for(let i=1;i<args.length;i++){
  const flag=args[i];if(seen.has(flag))throw new Error('Duplicate Pomodoro setup option');seen.add(flag);
  if(flag==='--apply')continue;
  const value=args[++i];
  if(flag==='--poll-seconds'&&(value==='1'||value==='10'))profile.pollSeconds=Number(value) as 1|10;
  else if(flag==='--background'&&(value==='static'||value==='animated'||value==='sleeping'||value==='phase'))profile.background=value;
  else throw new Error('Invalid Pomodoro setup option');
 }
 if(!seen.has('--apply'))throw new Error('Explicit --apply required');
 return profile;
}
