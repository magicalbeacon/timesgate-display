import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WeatherCache,weatherText} from '../src/weather.ts';
const empty=()=>new WeatherCache().view();
const rain=(probability:number|null,status='OK')=>({source:'Open-Meteo.com',timezone:'Asia/Singapore',location:'Yishun',probability,validFrom:'2026-10-16T15:00:00.000Z',validTo:'2026-10-16T16:00:00.000Z',fetchedAt:'2026-10-16T15:40:00.000Z',stale:status!=='OK',status,error:null}) as any;
test('illustrated weather panel visibly credits probability source and preserves exact midnight hour',()=>{
 const view={...empty(),rain:rain(52)};
 assert.equal(weatherText(view,'rain'),'52% 23-00 SGT');
 assert.equal(weatherText(view,'rainSource'),'Open-Meteo.com');
 assert.equal(weatherText(view,'panelHeading'),'YISHUN 2H');
});
test('missing probability never becomes zero, while genuine zero remains0%',()=>{
 assert.equal(weatherText({...empty(),rain:rain(null,'NO DATA')},'rain'),'--% 23-00 SGT');
 assert.equal(weatherText({...empty(),rain:rain(0)},'rain'),'0% 23-00 SGT');
 assert.equal(weatherText(empty(),'rain'),'--% -- SGT');
});
test('NEA and probability freshness remain independently visible',()=>{
 assert.equal(weatherText({...empty(),status:'OK',rain:rain(50,'STALE')},'panelStatus'),'NEA OK OM STALE');
 assert.equal(weatherText({...empty(),status:'STALE',rain:rain(50)},'panelStatus'),'NEA STALE OM OK');
 assert.equal(weatherText({...empty(),status:'STALE',rain:rain(50,'STALE')},'panelStatus'),'NEA/OM STALE');
 assert.equal(weatherText({...empty(),status:'OK',rain:rain(null,'NO DATA')},'panelStatus'),'NEA OK OM --');
});
test('compact observation preserves older source day/time and labels nearby Sembawang',()=>{
 const view={...empty(),observation:{temperatureC:27.9,relativeHumidity:93.6,temperatureObservedAt:'2026-10-16T13:48:00.000Z',humidityObservedAt:'2026-10-16T11:48:00.000Z',observedAt:'2026-10-16T11:48:00.000Z',retrievedAt:'2026-10-16T13:53:00.000Z'}};
 assert.equal(weatherText(view,'conditionsCompact'),'27.9C 94% RH');
 assert.equal(weatherText(view,'observedCompact'),'16 19:48 SGT');
 assert.equal(weatherText(view,'station'),'S80 SEMBAWANG');
 assert.equal(weatherText(view,'observed'),'OBS 16 19:48 SGT');
});
function compact(){return {...empty(),forecast:{text:'Cloudy',issuedAt:'2026-10-16T13:00:00.000Z',updatedAt:'2026-10-16T13:01:00.000Z',validFrom:'2026-10-16T13:00:00.000Z',validTo:'2026-10-16T15:00:00.000Z',retrievedAt:'2026-10-16T13:53:00.000Z'},forecastStale:false,observationStale:false,status:'OK' as const,observation:{temperatureC:27.6,relativeHumidity:94.5,temperatureObservedAt:'2026-10-16T13:48:00.000Z',humidityObservedAt:'2026-10-16T11:48:00.000Z',observedAt:'2026-10-16T11:48:00.000Z',retrievedAt:'2026-10-16T13:53:00.000Z'},rain:rain(14)};}
test('separated layout has compact large numbers, nearby-station date and exact rain window',()=>{
 const v=compact();assert.equal(weatherText(v,'temperatureLarge'),'27.6');assert.equal(weatherText(v,'humidityBrief'),'95%');assert.equal(weatherText(v,'observationBrief'),'Semb.16 19:48');assert.equal(weatherText(v,'rainPercent'),'14%');assert.equal(weatherText(v,'rainWindow'),'23-00');
});
test('0 and100 percent are actual values, never treated as missing or overflowing their native widths',()=>{
 for(const p of [0,8,14,100]){const v=compact();v.rain=rain(p);v.observation.relativeHumidity=p;assert.equal(weatherText(v,'rainPercent'),`${p}%`);assert.equal(weatherText(v,'humidityBrief'),`${p}%`);assert(weatherText(v,'rainPercent').length<=4);assert(weatherText(v,'humidityBrief').length<=5);}
});
test('stale warnings are local and stale observations retain their dated nearby-station caption',()=>{
 const v=compact();assert.equal(weatherText({...v,forecastStale:true},'forecastCompact'),'STALE');assert.equal(weatherText({...v,forecastStale:true},'temperatureLarge'),'27.6');
 assert.equal(weatherText({...v,observationStale:true},'temperatureLarge'),'...');assert.equal(weatherText({...v,observationStale:true},'humidityBrief'),'STALE');assert.equal(weatherText({...v,observationStale:true},'observationBrief'),'Semb.16 19:48');assert.equal(weatherText({...v,observationStale:true},'rainPercent'),'14%');
 assert.equal(weatherText({...v,rain:rain(14,'STALE')},'rainPercent'),'%' );assert.equal(weatherText({...v,rain:rain(14,'STALE')},'rainWindow'),'STALE');assert.equal(weatherText({...v,rain:rain(14,'STALE')},'temperatureLarge'),'27.6');
});
test('missing large numeric values use supported dot or percent placeholders, not zeros or uncertain blank clears',()=>{
 const v=empty();assert.equal(weatherText(v,'temperatureLarge'),'...');assert.equal(weatherText(v,'humidityBrief'),'--%');assert.equal(weatherText(v,'observationBrief'),'Semb. NO DATA');assert.equal(weatherText(v,'rainPercent'),'%' );assert.equal(weatherText(v,'rainWindow'),'N/A');assert.equal(weatherText(v,'forecastCompact'),'NO DATA');
});
test('numeric-only native font never removes negative temperature signs or receives unsupported characters',()=>{
 const v=compact();v.observation.temperatureC=-1;assert.equal(weatherText(v,'temperatureLarge'),'...');assert.equal(weatherText(v,'observationBrief'),'Semb.16 19:48');assert.equal(weatherText(v,'humidityBrief'),'RANGE');
 assert(/^[\d.]+$/.test(weatherText(v,'temperatureLarge')));assert(/^\d{1,3}%$/.test(weatherText(v,'rainPercent')));
});
test('long forecast stays in its native polling field while adjacent source and time text remain short',()=>{
 const v=compact();v.forecast.text='Thundery Showers with Gusty Winds';assert.equal(weatherText(v,'forecastCompact'),'THUNDERY SHOWERS WITH GUSTY WINDS');assert(weatherText(v,'observationBrief').length<=16);assert(weatherText(v,'rainWindow').length<=5);assert.equal(weatherText(v,'rainSource'),'Open-Meteo.com');
});

test('rain font492 receives a complete percent group without spaces or unsupported placeholder glyphs',()=>{
 for(const probability of [0,8,14,100]){const v=compact();v.rain=rain(probability);assert.equal(weatherText(v,'rainPercent'),`${probability}%`);assert(/^[0-9]+%$/.test(weatherText(v,'rainPercent')));}
 for(const v of [empty(),{...compact(),rain:rain(14,'STALE')}]){assert.equal(weatherText(v,'rainPercent'),'%');assert(['N/A','STALE'].includes(weatherText(v,'rainWindow')));}
});

test('prior numeric-only rain endpoint retains its digits and dots until explicit layout replacement',()=>{
 for(const probability of [0,8,14,100]){const v=compact();v.rain=rain(probability);assert.equal(weatherText(v,'rainLarge'),String(probability));}
 assert.equal(weatherText(empty(),'rainLarge'),'...');assert.equal(weatherText({...compact(),rain:rain(14,'STALE')},'rainLarge'),'...');
});

test('temperature values retain four decimal-font cells beside the static thermometer;100 is never clipped',()=>{
 const v=compact();for(const n of [0,8,27.6,28.8,60,99.9]){v.observation.temperatureC=n;const text=weatherText(v,'temperatureLarge');assert.equal(text,n.toFixed(1));assert(text.length*18<=74);}
 v.observation.temperatureC=100;assert.equal(weatherText(v,'temperatureLarge'),'...');assert.equal(weatherText(v,'humidityBrief'),'RANGE');
});
