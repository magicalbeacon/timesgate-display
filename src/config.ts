import {isIP} from 'node:net';
import { createHash } from 'node:crypto';
import { loadDevice, type DeviceConfig } from './device.ts';
export type Config={device:DeviceConfig;screens:[number,number];tickers:string[];rotationSeconds:number;quoteRefreshSeconds:number;historyRefreshHours:number;staleQuoteSeconds:number;apiKey:string;writesEnabled:boolean;port:number;stateDir:string;runtimeDir:string;weatherEnabled:boolean;pomodoroEnabled:boolean;serverBaseUrl:string};
function integer(raw:string|undefined,fallback:number,min:number,max:number,name:string){const value=raw?Number(raw):fallback;if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} is outside its supported range`);return value;}
export function loadConfig(env:Record<string,string|undefined>=process.env):Config {
  // Human-facing numbering is deliberately 1–5. Never infer or default device targets.
  const screens=(env.TARGET_SCREENS||'').split(',').map(s=>s.trim());
  if(screens.length!==2||screens.some(s=>! /^[1-5]$/.test(s))||new Set(screens).size!==2)throw new Error('TARGET_SCREENS must explicitly select exactly two distinct screen numbers 1–5');
  if(screens[0]!=='1'||screens[1]!=='2')throw new Error('This package is authorized only for TARGET_SCREENS=1,2');
  const tickers=(env.TICKERS||'').split(',').map(s=>s.trim().toUpperCase()==='VWRA'?'VWRA.L':s.trim().toUpperCase());
  if(tickers.length<2||tickers.length>20||new Set(tickers).size!==tickers.length||tickers.some(s=>s!=='VWRA.L'&&s!=='USD/JPY'&&!/^[A-Z][A-Z0-9.-]{0,9}$/.test(s)))throw new Error('TICKERS must explicitly list 2–20 distinct US symbols and optional VWRA.L');
  const apiKey=env.FINNHUB_API_KEY?.trim()||'';
  if(tickers.some(s=>!['VWRA.L','VALL','SPCX','USD/JPY'].includes(s))&&!apiKey)throw new Error('FINNHUB_API_KEY is required for US quotes; enter it only in the local .env');
  if(env.POMODORO_ENABLED&&!['true','false'].includes(env.POMODORO_ENABLED))throw new Error('POMODORO_ENABLED must be true or false');
  if(env.WEATHER_ENABLED&&!['true','false'].includes(env.WEATHER_ENABLED))throw new Error('WEATHER_ENABLED must be true or false');
  if(env.DEVICE_WRITES_ENABLED&&!['true','false'].includes(env.DEVICE_WRITES_ENABLED))throw new Error('DEVICE_WRITES_ENABLED must be true or false');
  return {device:loadDevice(env),screens:screens.map(s=>Number(s)-1) as [number,number],tickers,apiKey,
    rotationSeconds:integer(env.ROTATION_SECONDS,15,10,300,'ROTATION_SECONDS'),quoteRefreshSeconds:integer(env.QUOTE_REFRESH_SECONDS,30,30,60,'QUOTE_REFRESH_SECONDS'),
    historyRefreshHours:integer(env.HISTORY_REFRESH_HOURS,6,6,24,'HISTORY_REFRESH_HOURS'),staleQuoteSeconds:integer(env.STALE_QUOTE_SECONDS,180,60,3600,'STALE_QUOTE_SECONDS'),
    weatherEnabled:env.WEATHER_ENABLED==='true',pomodoroEnabled:env.POMODORO_ENABLED==='true',serverBaseUrl:env.SERVER_BASE_URL?.trim()||'',writesEnabled:env.DEVICE_WRITES_ENABLED==='true',port:integer(env.PORT,8081,1024,65535,'PORT'),stateDir:env.STATE_DIR||'/app/state',runtimeDir:env.RUNTIME_DIR||(env.STATE_DIR?`${env.STATE_DIR}/runtime`:'/tmp/timesgate-combined')};
}
export function fingerprint(config:Config):string{return createHash('sha256').update(JSON.stringify({url:config.device.url,screens:config.screens,tickers:config.tickers,rotationSeconds:config.rotationSeconds})).digest('hex');}
export function pairFor(tickers:string[],step:number):[string,string]{if(tickers.length<2||!Number.isSafeInteger(step)||step<0)throw new Error('Invalid rotation');return [tickers[(step*2)%tickers.length],tickers[(step*2+1)%tickers.length]];}

export function requireWeatherServer(config:Config):string {
  if(!config.weatherEnabled)throw new Error('Enable weather before setup');
  return requirePrivateServer(config);
}
function requirePrivateServer(config:Config):string {
  let url:URL;try{url=new URL(config.serverBaseUrl);}catch{throw new Error('Set SERVER_BASE_URL to the Pi private-LAN HTTP origin');}
  const [a,b]=url.hostname.split('.').map(Number);
  if(url.protocol!=='http:'||isIP(url.hostname)!==4||!(a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168))||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('SERVER_BASE_URL must be a clean private-LAN HTTP origin');
  return url.origin;
}
export function weatherFingerprint(config:Config):string{return createHash('sha256').update(JSON.stringify({stock:fingerprint(config),server:requireWeatherServer(config),screen:4})).digest('hex');}

export function requirePomodoroServer(config:Config):string {if(!config.pomodoroEnabled)throw new Error('Enable Pomodoro before setup');return requirePrivateServer(config);}
export function pomodoroFingerprint(config:Config):string{return createHash('sha256').update(JSON.stringify({stock:fingerprint(config),server:requirePomodoroServer(config),screen:3})).digest('hex');}
