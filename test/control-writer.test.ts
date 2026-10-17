// Private addresses and credential values below are synthetic, mocked test fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,pairFor} from '../src/config.ts';
import {Control} from '../src/control.ts';
import {Writer,guardedFetch} from '../src/writer.ts';
const env={TARGET_SCREENS:'1,2',TICKERS:'VWRA,AAPL,MSFT,SPY,SPCX',DEVICE_IP:'192.168.240.50',FINNHUB_API_KEY:'SECRET_FOR_TEST',DEVICE_WRITES_ENABLED:'true'};
const image=Buffer.alloc(128);image[0]=255;image[1]=216;image[126]=255;image[127]=217;
function fixture(){const dir=mkdtempSync(join(tmpdir(),'tg-combined-'));const config=loadConfig({...env,STATE_DIR:dir});const control=new Control(config);return{config,control,clean:()=>rmSync(dir,{recursive:true,force:true})};}
const ok=()=>new Response(JSON.stringify({error_code:0,PicId:7}),{status:200});
test('configuration requires explicit two distinct human targets and explicit bounded ticker order',()=>{
 for(const target of ['', '1','1,1','0,1','1,6','1,2,3','1.0,2','3,4','2,1'])assert.throws(()=>loadConfig({...env,TARGET_SCREENS:target}));
 const config=loadConfig(env);assert.deepEqual(config.screens,[0,1]);assert.deepEqual(config.tickers,['VWRA.L','AAPL','MSFT','SPY','SPCX']);assert.equal(config.rotationSeconds,15);
 assert.throws(()=>loadConfig({...env,TICKERS:''}));assert.throws(()=>loadConfig({...env,TICKERS:'AAPL,AAPL'}));assert.throws(()=>loadConfig({...env,ROTATION_SECONDS:'1'}));
 assert.equal(loadConfig({...env,TICKERS:'VALL,USD/JPY'}).tickers[1],'USD/JPY');
});
test('pair rotation is deterministic for odd and even lists',()=>{
 const odd=['A','B','C','D','E'];assert.deepEqual(Array.from({length:5},(_,i)=>pairFor(odd,i)),[['A','B'],['C','D'],['E','A'],['B','C'],['D','E']]);
 assert.deepEqual(pairFor(['A','B','C','D'],2),['A','B']);assert.throws(()=>pairFor(['A'],0));
});
test('control defaults stopped and requires flag plus fingerprint-matching arm; halt persists',()=>{
 const f=fixture();try{assert.equal(f.control.isArmed(),false);f.control.arm();assert.equal(f.control.isArmed(),true);f.control.halt();assert.equal(new Control(f.config).isArmed(),false);assert.equal(f.control.status().halted,true);f.control.arm();f.config.tickers=['AAPL','MSFT'];assert.equal(f.control.isArmed(),false);assert(!JSON.stringify(f.control.status()).includes('SECRET'));}finally{f.clean();}
});
test('network guard rejects all non-selected clears, masks, restores and global resets',async()=>{
 const f=fixture();try{let sent=0;const fetcher=guardedFetch(f.config,()=>true,(async()=>{sent++;return ok();}) as typeof fetch);
 const bad=[{Command:'Draw/ResetHttpGifId'},{Command:'Draw/ClearHttpText',LcdId:2,TextId:-1},{Command:'Draw/ClearHttpText',LcdId:0,TextId:2},{Command:'Draw/SendHttpGif',LcdArray:[1,1,0,0,0]},{Command:'Draw/SendHttpGif',LcdArray:[0,0,1,0,0]},{Command:'Draw/SendHttpGif',LcdArray:[0,0,0,0,1]},{Command:'Draw/SendHttpItemList',LcdIndex:4}];
 for(const body of bad)await assert.rejects(()=>fetcher(f.config.device.url,{method:'POST',body:JSON.stringify(body)}));assert.equal(sent,0);
 }finally{f.clean();}
});
test('one serialized pair targets only indices0,1 and obtains a fresh ID for each',async()=>{
 const f=fixture();try{f.control.arm();const payloads:any[]=[];let active=0,max=0;
 const writer=new Writer(f.config,f.control,(async(_url,init)=>{active++;max=Math.max(max,active);payloads.push(JSON.parse(init!.body as string));await new Promise(r=>setTimeout(r,2));active--;return ok();}) as typeof fetch);
 const first=writer.pair([image,image]);assert.equal(await writer.pair([image,image]),false);assert.equal(await first,true);assert.equal(max,1);
 assert.deepEqual(payloads.map(p=>p.Command),['Draw/GetHttpGifId','Draw/ClearHttpText','Draw/SendHttpGif','Draw/GetHttpGifId','Draw/ClearHttpText','Draw/SendHttpGif']);
 assert.deepEqual(payloads.filter(p=>p.LcdArray).map(p=>p.LcdArray),[[1,0,0,0,0],[0,1,0,0,0]]);assert.deepEqual(payloads.filter(p=>p.LcdId!==undefined).map(p=>p.LcdId),[0,1]);
 }finally{f.clean();}
});
test('uncertain write halts persistently and never retries or touches the second screen',async()=>{
 const f=fixture();try{f.control.arm();let calls=0;const writer=new Writer(f.config,f.control,(async()=>{calls++;if(calls===3)throw new Error('SECRET raw response');return ok();}) as typeof fetch);
 assert.equal(await writer.pair([image,image]),false);assert.equal(calls,3);assert.equal(f.control.status().halted,true);assert.equal(await writer.pair([image,image]),false);assert.equal(calls,3);assert(!readFileSync(f.control.path('HALTED'),'utf8').includes('SECRET'));
 }finally{f.clean();}
});
test('stop between ID read and clear blocks every subsequent device write',async()=>{
 const f=fixture();try{f.control.arm();const sent:any[]=[];const writer=new Writer(f.config,f.control,(async(_u,init)=>{sent.push(JSON.parse(init!.body as string));f.control.stop();return ok();}) as typeof fetch);
 assert.equal(await writer.pair([image,image]),false);assert.deepEqual(sent.map(p=>p.Command),['Draw/GetHttpGifId']);assert.equal(f.control.isArmed(),false);
 }finally{f.clean();}
});
test('stop during arm probe wins over delayed successful read',async()=>{
 const f=fixture();try{f.control.requestArm();const writer=new Writer(f.config,f.control,(async()=>{f.control.stop();return ok();}) as typeof fetch);assert.equal(await writer.processArm(),false);assert.equal(f.control.isArmed(),false);}finally{f.clean();}
});
function layout(){return Array.from({length:5},(_,i)=>({Command:'Draw/SendHttpItemList',LcdIndex:i,NewFlag:1,BackgroudGif:'http://192.168.240.20:8080/black.gif',ItemList:['symbol','price','change','status','date','time'].map((field,j)=>({TextId:j+1,type:23,x:0,y:j*20,dir:0,font:4,TextWidth:128,Textheight:16,TextString:`http://192.168.240.20:8080/disp/${i}/${field}`,speed:100,color:'#FFFFFF',update_time:30,align:1}))}));}
test('restore targets only selected native layouts; validates both before any write',async()=>{
 const f=fixture();try{f.control.stop();const sent:any[]=[];const writer=new Writer(f.config,f.control,(async(_u,init)=>{sent.push(JSON.parse(init!.body as string));return ok();}) as typeof fetch);
 const bad=layout();bad[1].ItemList[0].TextString='http://8.8.8.8/secret';assert.equal(await writer.restore(bad,true),false);assert.equal(sent.length,0);
 assert.equal(await writer.restore(layout(),true),true);assert.deepEqual(sent.map(p=>p.LcdIndex),[0,1]);assert(sent.every(p=>p.Command==='Draw/SendHttpItemList'));
 }finally{f.clean();}
});
test('Docker context keeps env excluded and explicitly copied metadata available to tests',()=>{
 const ignore=readFileSync(new URL('../.dockerignore',import.meta.url),'utf8');assert(ignore.split('\n').includes('.env'));assert(ignore.includes('.env.*'));assert(ignore.includes('!.env.example'));
});

test('published template has no connection credentials and build context excludes private runtime exports',()=>{
 const template=readFileSync(new URL('../.env.example',import.meta.url),'utf8');
 for(const key of ['DEVICE_IP','LOCAL_TOKEN','FINNHUB_API_KEY','SERVER_BASE_URL'])assert.equal(template.split('\n').find(line=>line.startsWith(key+'=')),key+'=');
 const ignore=readFileSync(new URL('../.dockerignore',import.meta.url),'utf8').split('\n');
 for(const rule of ['.env','*.env','*.env.*','!.env.example','state','runtime','cache','snapshots','stock-layout.json*','test-results*','credentials','private','*.pem','*.key'])assert(ignore.includes(rule));
});
