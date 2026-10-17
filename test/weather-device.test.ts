// Private addresses and credential values below are synthetic, mocked test fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,requireWeatherServer,weatherFingerprint} from '../src/config.ts';
import {Control} from '../src/control.ts';
import {weatherLayout,setupWeather} from '../src/weather-device.ts';
import {WEATHER_BACKGROUND,WEATHER_ILLUSTRATED_BACKGROUND,WEATHER_SEPARATED_BACKGROUND,WEATHER_CENTERED_BACKGROUND,WEATHER_THERMOMETER_BACKGROUND} from '../src/weather-background.ts';
import {WeatherCache,WEATHER_FIELDS} from '../src/weather.ts';
import {makeServer} from '../src/server.ts';
const env={TARGET_SCREENS:'1,2',TICKERS:'AAPL,MSFT',DEVICE_IP:'192.168.240.50',FINNHUB_API_KEY:'SECRET',DEVICE_WRITES_ENABLED:'true',WEATHER_ENABLED:'true',SERVER_BASE_URL:'http://192.168.240.20:8081'};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'tg-weather-'));const config=loadConfig({...env,STATE_DIR:dir});const control=new Control(config);control.stop();return{config,control,clean:()=>rmSync(dir,{recursive:true,force:true})};}
test('weather origin must be private LAN HTTP with no credentials, path, query or fragment',()=>{
 for(const base of ['','http://localhost:8081','http://127.0.0.1:8081','http://8.8.8.8','https://192.168.240.2','http://192.168.240.2/path','http://user:secret@192.168.240.2','http://192.168.240.2/?key=x','http://192.168.240.2/#x'])assert.throws(()=>requireWeatherServer(loadConfig({...env,SERVER_BASE_URL:base})));
 assert.equal(requireWeatherServer(loadConfig(env)),env.SERVER_BASE_URL);assert.throws(()=>requireWeatherServer(loadConfig({...env,WEATHER_ENABLED:'false'})));
 assert.notEqual(weatherFingerprint(loadConfig(env)),weatherFingerprint(loadConfig({...env,SERVER_BASE_URL:'http://192.168.240.21:8081'})));
});
test('weather native layout targets only physical screen5 with7 bounded type23 rows and real128GIF',()=>{
 const payload=weatherLayout(loadConfig(env));assert.equal(payload.LcdIndex,4);assert.equal(payload.Command,'Draw/SendHttpItemList');assert.equal(payload.NewFlag,1);assert.equal(payload.ItemList.length,7);
 assert.equal(new Set(payload.ItemList.map(r=>r.TextId)).size,7);assert(payload.ItemList.every(r=>r.type===23&&r.y+r.Textheight<=128&&r.x+r.TextWidth<=128&&r.TextId>=33&&r.TextId<40&&r.update_time===60&&r.TextString.startsWith(env.SERVER_BASE_URL+'/weather/5/')));
 assert(!JSON.stringify(payload).includes('SECRET'));assert(!JSON.stringify(payload).includes('LocalToken'));assert.equal(WEATHER_BACKGROUND.subarray(0,3).toString(),'GIF');assert.equal(WEATHER_BACKGROUND.readUInt16LE(6),128);assert.equal(WEATHER_BACKGROUND.readUInt16LE(8),128);
 assert.equal(payload.BackgroudGif,env.SERVER_BASE_URL+'/weather/thermometer-v42.gif');assert.equal(WEATHER_ILLUSTRATED_BACKGROUND.subarray(0,3).toString(),'GIF');assert.equal(WEATHER_ILLUSTRATED_BACKGROUND.readUInt16LE(6),128);assert.equal(WEATHER_ILLUSTRATED_BACKGROUND.readUInt16LE(8),128);assert.equal(WEATHER_SEPARATED_BACKGROUND.readUInt16LE(6),128);assert.equal(WEATHER_SEPARATED_BACKGROUND.readUInt16LE(8),128);
 assert.equal(payload.ItemList.filter(row=>row.font===246).length,1);assert.equal(payload.ItemList.filter(row=>row.font===492).length,1);assert(payload.ItemList.every(row=>[4,246,492].includes(row.font)));assert.equal(WEATHER_CENTERED_BACKGROUND.subarray(0,3).toString(),'GIF');assert.equal(WEATHER_CENTERED_BACKGROUND.readUInt16LE(6),128);assert.equal(WEATHER_CENTERED_BACKGROUND.readUInt16LE(8),128);assert.equal(WEATHER_THERMOMETER_BACKGROUND.subarray(0,3).toString(),'GIF');assert.equal(WEATHER_THERMOMETER_BACKGROUND.readUInt16LE(6),128);assert.equal(WEATHER_THERMOMETER_BACKGROUND.readUInt16LE(8),128);
});
test('explicit weather setup makes exactlyone selectednative write, no imageID/clear/global/otherpanel request',async()=>{
 const f=fixture();try{const sent:any[]=[];await setupWeather(f.config,f.control,true,f.control.stopVersion(),(async(_u,init)=>{sent.push(JSON.parse(init!.body as string));return new Response('{"error_code":0}');}) as typeof fetch);
 assert.equal(sent.length,1);assert.equal(sent[0].LcdIndex,4);assert.equal(sent[0].Command,'Draw/SendHttpItemList');assert(!('LcdArray'in sent[0]));assert(!('LcdId'in sent[0]));assert(!('PicID'in sent[0]));
 }finally{f.clean();}
});
test('weather refuses missingapply, writesdisabled, stockarmed or interveningstop before any network',async()=>{
 const f=fixture();try{let calls=0;const fake=(async()=>{calls++;return new Response('{"error_code":0}');}) as typeof fetch;
 await assert.rejects(()=>setupWeather(f.config,f.control,false,f.control.stopVersion(),fake));f.config.writesEnabled=false;await assert.rejects(()=>setupWeather(f.config,f.control,true,f.control.stopVersion(),fake));f.config.writesEnabled=true;
 f.control.arm();await assert.rejects(()=>setupWeather(f.config,f.control,true,f.control.stopVersion(),fake));f.control.stop();const old=f.control.stopVersion();f.control.stop();await assert.rejects(()=>setupWeather(f.config,f.control,true,old,fake));assert.equal(calls,0);
 }finally{f.clean();}
});
test('weather timeout latches halt without rawresponse exposure or automatic retries',async()=>{
 const f=fixture();try{let calls=0;await assert.rejects(()=>setupWeather(f.config,f.control,true,f.control.stopVersion(),(async()=>{calls++;throw new Error('SECRET token');}) as typeof fetch));assert.equal(calls,1);assert.equal(f.control.status().halted,true);assert(!readFileSync(f.control.path('HALTED'),'utf8').includes('SECRET'));}finally{f.clean();}
});
test('stop clears queuedweather so startupcannot replay setup',()=>{
 const f=fixture();try{f.control.write('WEATHER_REQUEST',{fingerprint:weatherFingerprint(f.config),stopVersion:f.control.stopVersion(),at:Date.now()});assert.equal(f.control.status().weatherSetupRequested,true);f.control.stop();assert.equal(f.control.status().weatherSetupRequested,false);}finally{f.clean();}
});
test('nativeweather endpoints are cachedGETonly and cannot target3or4',async()=>{
 const cache=new WeatherCache();const server=makeServer({status:()=>({}),image:()=>undefined,weather:()=>cache.view()});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{for(const field of WEATHER_FIELDS){const r=await fetch(base+'/weather/5/'+field);assert.equal(r.status,200);const data=await r.json();assert.equal(typeof data.DispData,'string');assert(!JSON.stringify(data).includes('SECRET'));}
 assert.equal((await fetch(base+'/weather/3/heading')).status,404);assert.equal((await fetch(base+'/weather/4/heading')).status,404);assert.equal((await fetch(base+'/weather/5/unknown')).status,404);assert.equal((await fetch(base+'/weather/5/heading',{method:'POST'})).status,405);assert.equal((await fetch(base+'/weather/black.gif')).headers.get('content-type'),'image/gif');assert.equal((await fetch(base+'/weather/illustrated-v3.gif')).headers.get('content-type'),'image/gif');assert.equal((await fetch(base+'/weather/separated-v4.gif')).headers.get('content-type'),'image/gif');assert.deepEqual(Buffer.from(await (await fetch(base+'/weather/centred-v41.gif')).arrayBuffer()),WEATHER_CENTERED_BACKGROUND);assert.deepEqual(Buffer.from(await (await fetch(base+'/weather/thermometer-v42.gif')).arrayBuffer()),WEATHER_THERMOMETER_BACKGROUND);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('humidity and complete percentage groups centre inside bounded cells with no neighbouring overlap',()=>{
 const rows=weatherLayout(loadConfig(env)).ItemList;const humidity=rows.find(r=>r.TextString.endsWith('/humidityBrief'))!;const rain=rows.find(r=>r.TextString.endsWith('/rainPercent'))!;const hour=rows.find(r=>r.TextString.endsWith('/rainWindow'))!;const source=rows.find(r=>r.TextString.endsWith('/rainSource'))!;
 assert.equal(humidity.align,3);assert.equal(humidity.x+humidity.TextWidth/2,108);assert.equal(humidity.font,4);assert(humidity.TextWidth>=5*8);
 assert.equal(rain.align,3);assert.equal(rain.font,492);assert(rain.Textheight>=26);assert.equal(rain.x+rain.TextWidth/2,49);assert(rain.TextWidth>=4*12);assert(rain.x+rain.TextWidth<=hour.x);assert(rain.y+rain.Textheight<=source.y);
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){const a=rows[i],b=rows[j];assert(a.x+a.TextWidth<=b.x||b.x+b.TextWidth<=a.x||a.y+a.Textheight<=b.y||b.y+b.Textheight<=a.y,'polling text rectangles must not overlap');}
});
