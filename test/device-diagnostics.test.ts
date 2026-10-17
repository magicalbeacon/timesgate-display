// Private addresses and credential values below are synthetic, mocked test fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {post,deviceFailureReason,type Fetcher} from '../src/device.ts';
import {loadConfig} from '../src/config.ts';
import {Control} from '../src/control.ts';
import {setupWeather} from '../src/weather-device.ts';
const SECRET='DO_NOT_DISCLOSE_API_TOKEN_OR_RESPONSE';
const config={url:'http://192.168.240.50/post',token:123456789,timeout:1000};
async function reason(fetcher:Fetcher,timeout=1000){
 try{await post({...config,timeout},{Command:'Draw/SendHttpItemList',LcdIndex:4},fetcher);assert.fail('Expected failure');}
 catch(error){const value=deviceFailureReason(error);assert(!value.includes(SECRET));assert(!String(error).includes(SECRET));assert(!value.includes('123456789'));return value;}
}
const response=(body:string,status=200)=>async()=>new Response(body,{status,headers:{'X-Secret':SECRET}});
test('device diagnostics retain only bounded HTTP status, never response body or headers',async()=>{
 assert.equal(await reason(response(SECRET,401)),'HTTP status 401');assert.equal(await reason(response(SECRET,503)),'HTTP status 503');
});
test('non-JSON, empty and structurally invalid responses have distinct safe classifications',async()=>{
 assert.equal(await reason(response(SECRET)),'response was not valid JSON');
 assert.equal(await reason(async()=>new Response(null,{status:204})),'empty response');
 for(const data of ['null','[]','true','42','"'+SECRET+'"'])assert.equal(await reason(response(data)),'response was not a JSON object');
 assert.equal(await reason(response(JSON.stringify({message:SECRET}))),'response omitted error_code');
});
test('nonzero device numeric codes are retained without any other firmware fields',async()=>{
 for(const code of [1,7,-1,65535,'21','-2'])assert.equal(await reason(response(JSON.stringify({error_code:code,message:SECRET,LocalToken:123456789}))),`device error_code ${Number(code)}`);
});
test('unsupported or unbounded error codes never expose arbitrary firmware text or echoed numeric tokens',async()=>{
 for(const code of [SECRET,{secret:SECRET},[SECRET],true,null,1.5,123456789,'123456789','1e3','000000','1 '+SECRET])assert.equal(await reason(response(JSON.stringify({error_code:code}))),'response had an unsupported error_code');
 assert.equal(deviceFailureReason(new Error(SECRET)),'local validation or operation failed');
 assert.equal(deviceFailureReason({name:'DeviceRequestError',safeReason:()=>SECRET}),'local validation or operation failed');
});
test('network errors, interrupted calls and elapsed deadlines are sanitized without retries',async()=>{
 let calls=0;assert.equal(await reason(async()=>{calls++;throw new Error(SECRET);}),'network request failed');assert.equal(calls,1);
 assert.equal(await reason(async()=>{throw new DOMException(SECRET,'AbortError');}),'request interrupted');
 assert.equal(await reason(async()=>{await new Promise(r=>setTimeout(r,15));throw new Error(SECRET);},5),'request timed out');
});
test('oversized device response remains bounded and its cancellation exception cannot leak',async()=>{
 let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(32769));},cancel(){cancelled=true;throw new Error(SECRET);}});
 assert.equal(await reason(async()=>new Response(body)),'response exceeded 32 KiB');assert(cancelled);
});
test('successful explicit numeric and string zero acknowledgements retain their original behavior',async()=>{
 for(const code of [0,'0'])assert.deepEqual(await post(config,{Command:'Draw/GetHttpGifId'},response(JSON.stringify({error_code:code,PicId:7}))),{error_code:code,PicId:7});
});
test('weather propagates a safe diagnostic, halts, and makes only one screen5 request on failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tg-weather-diagnostic-'));
 try{
  const c=loadConfig({TARGET_SCREENS:'1,2',TICKERS:'AAPL,MSFT',DEVICE_IP:'192.168.240.50',FINNHUB_API_KEY:SECRET,LOCAL_TOKEN:'123456789',DEVICE_WRITES_ENABLED:'true',WEATHER_ENABLED:'true',SERVER_BASE_URL:'http://192.168.240.20:8081',STATE_DIR:dir});
  const control=new Control(c);control.stop();const sent:any[]=[];let caught:unknown;
  try{await setupWeather(c,control,true,control.stopVersion(),async(_u,init)=>{sent.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({error_code:7,message:SECRET,LocalToken:123456789}));});}catch(error){caught=error;}
  assert.equal(deviceFailureReason(caught),'device error_code 7');assert.equal(control.status().halted,true);assert.equal(sent.length,1);assert.equal(sent[0].LcdIndex,4);assert.equal(sent[0].Command,'Draw/SendHttpItemList');
  assert(!readFileSync(control.path('HALTED'),'utf8').includes(SECRET));assert(!readFileSync(control.path('HALTED'),'utf8').includes('123456789'));
  const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');assert(main.includes('Weather setup failed (${deviceFailureReason(error)})'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('short configured LocalToken values echoed in device codes are redacted before exception creation',async()=>{
 for(const token of [1,7,12345,65535])for(const code of [token,String(token),-token,String(-token)]){
  let caught:unknown;try{await post({...config,token},{Command:'Draw/SendHttpItemList'},response(JSON.stringify({error_code:code})));}catch(error){caught=error;}
  assert.equal(deviceFailureReason(caught),'device rejected command (code redacted)');assert(!String(caught).includes(String(token)));
 }
});
