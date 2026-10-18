import {POMODORO_CAT_SLEEP_ANIMATION} from './pomodoro-cat-sleep-animation.ts';
import {POMODORO_CAT_ANIMATION} from './pomodoro-cat-animation.ts';
import {createServer,type Server} from 'node:http';
import {WEATHER_BACKGROUND,WEATHER_ILLUSTRATED_BACKGROUND,WEATHER_SEPARATED_BACKGROUND,WEATHER_CENTERED_BACKGROUND,WEATHER_THERMOMETER_BACKGROUND} from './weather-background.ts';
import {WEATHER_FIELDS,weatherText,type WeatherView} from './weather.ts';
import {createPomodoroHttp,type PomodoroHttpOptions} from './pomodoro-http.ts';
import {POMODORO_BACKGROUND} from './pomodoro-background.ts';
import {POMODORO_CAT_BACKGROUND} from './pomodoro-cat-background.ts';
import {pomodoroText,POMODORO_FIELDS} from './pomodoro-device.ts';
import type {PomodoroView} from './pomodoro.ts';
import {POMODORO_CSS,POMODORO_HTML,POMODORO_SCRIPT} from './pomodoro-ui.ts';
export type ServerState={status:()=>unknown;image:(screen:number)=>Buffer|undefined;weather?:()=>WeatherView;pomodoro?:PomodoroHttpOptions & {view:()=>PomodoroView}};
export function makeServer(state:ServerState):Server {
  const pomodoro=state.pomodoro?createPomodoroHttp(state.pomodoro):undefined;
  const server=createServer({headersTimeout:5000,requestTimeout:10000,keepAliveTimeout:3000,maxHeaderSize:8192},async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    if(pomodoro&&await pomodoro(req,res))return;
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    const path=req.url?.split('?')[0];
    if(path==='/healthz'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));}
    else if(path==='/api/weather'&&state.weather){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state.weather()));}
    else if(path==='/weather/black.gif'&&state.weather){res.setHeader('Content-Type','image/gif');res.end(WEATHER_BACKGROUND);}
    else if(path==='/weather/illustrated-v3.gif'&&state.weather){res.setHeader('Content-Type','image/gif');res.end(WEATHER_ILLUSTRATED_BACKGROUND);}
    else if(path==='/weather/separated-v4.gif'&&state.weather){res.setHeader('Content-Type','image/gif');res.end(WEATHER_SEPARATED_BACKGROUND);}
    else if(path==='/weather/centred-v41.gif'&&state.weather){res.setHeader('Content-Type','image/gif');res.end(WEATHER_CENTERED_BACKGROUND);}
    else if(path==='/weather/thermometer-v42.gif'&&state.weather){res.setHeader('Content-Type','image/gif');res.end(WEATHER_THERMOMETER_BACKGROUND);}
    else if(path?.startsWith('/weather/5/')&&state.weather){const field=path.slice('/weather/5/'.length);if(!WEATHER_FIELDS.includes(field as any)){res.writeHead(404);res.end('Not found');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({DispData:weatherText(state.weather(),field as any)}));}
    else if(path==='/pomodoro/static-v1.gif'&&state.pomodoro){res.setHeader('Content-Type','image/gif');res.end(POMODORO_BACKGROUND);}
    else if(path==='/pomodoro/cat-v2.gif'&&state.pomodoro){res.setHeader('Content-Type','image/gif');res.end(POMODORO_CAT_BACKGROUND);}
    else if(path==='/pomodoro/cat-loop-v1.gif'&&state.pomodoro){res.setHeader('Content-Type','image/gif');res.end(POMODORO_CAT_ANIMATION);}
    else if(path==='/pomodoro/cat-sleep-v1.gif'&&state.pomodoro){res.setHeader('Content-Type','image/gif');res.end(POMODORO_CAT_SLEEP_ANIMATION);}
    else if(path?.startsWith('/pomodoro/4/')&&state.pomodoro){const field=path.slice('/pomodoro/4/'.length);if(!POMODORO_FIELDS.includes(field as any)){res.writeHead(404);res.end('Not found');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({DispData:pomodoroText(state.pomodoro.view(),field)}));}
    else if(path==='/api/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state.status()));}
    else if(/^\/screen\/[1-5]\.png$/.test(path||'')){const image=state.image(Number(path!.at(8))-1);if(!image){res.writeHead(404);res.end('No image');}else{res.setHeader('Content-Type','image/png');res.end(image);}}
    else if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(PAGE);}
    else{res.writeHead(404);res.end('Not found');}
  });
  server.maxConnections=16;return server;
}
const PAGE=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Times Gate two-screen rotation</title><style>body{font:16px system-ui;background:#03070b;color:#f4f7fa;max-width:960px;margin:32px auto;padding:20px}h1{color:#64dfff}#panels{display:flex;gap:24px;flex-wrap:wrap}img{width:256px;height:256px;image-rendering:pixelated;border:1px solid #1b2b38;border-radius:12px}pre{white-space:pre-wrap;font:13px monospace;color:#8dabbe}#mode{color:#ffd478}a{color:#64dfff}${POMODORO_CSS}</style><h1>Two-screen stock rotation</h1><p id="mode">Connecting…</p><div id="panels"></div><p>Software previews, not camera images of the device. Quotes and completed daily candles have separate timestamps. Yahoo data is unofficial; VWRA is delayed. Control the device only with the local CLI.</p>${POMODORO_HTML}<section id="weather"></section><p id="weather-credit" hidden>Probability data: <a href="https://open-meteo.com/" rel="noreferrer">Open-Meteo.com</a> · <a href="https://open-meteo.com/en/licence" rel="noreferrer">CC BY 4.0</a>. NEA forecast and Sembawang observations are separate.</p><pre id="details"></pre><script>
let screens='';async function update(){try{const r=await fetch('/api/status');if(!r.ok)throw 0;const d=await r.json();document.querySelector('#mode').textContent=d.control.halted?'HALTED: inspect selected panels; explicitly re-arm when ready':d.control.armed?'ARMED: selected screens rotate automatically':'STOPPED: data previews only';const ids=d.control.targetScreens.join(',');if(ids!==screens){screens=ids;document.querySelector('#panels').replaceChildren(...d.control.targetScreens.map(n=>{const box=document.createElement('div');const title=document.createElement('p');title.textContent='Screen '+n;const image=document.createElement('img');image.alt='Software preview of selected screen '+n;image.dataset.screen=n;box.append(title,image);return box;}));}document.querySelectorAll('img[data-screen]').forEach(img=>img.src='/screen/'+img.dataset.screen+'.png?t='+Date.now());document.querySelector('#details').textContent=JSON.stringify(d,null,2);const w=document.querySelector('#weather');document.querySelector('#weather-credit').hidden=!d.weather;w.textContent=d.weather?'Screen5 weather: '+d.weather.source+' / '+d.weather.status+' / '+(d.weather.forecast?.text||'NO DATA')+' | Hourly rain chance: '+(d.weather.rain?.probability==null?'--':d.weather.rain.probability)+'% · Open-Meteo.com · '+(d.weather.rain?.status||'NO DATA')+' · interval '+(d.weather.rain?.validFrom||'--')+' to '+(d.weather.rain?.validTo||'--')+' (explicit UTC ISO times; panel uses SGT). Fixed illustrations are decorative; they do not show current conditions.':'';}catch{document.querySelector('#mode').textContent='SERVER UNREACHABLE: previews may be stale; physical screens can freeze';}}update();setInterval(update,5000);
${POMODORO_SCRIPT}
</script></html>`;
