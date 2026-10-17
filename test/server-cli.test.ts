// Private addresses and credential values below are synthetic, mocked test fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeServer} from '../src/server.ts';
import {Control} from '../src/control.ts';
import {loadConfig} from '../src/config.ts';
test('HTTP serves bounded selected previews/status and never accepts control mutations',async()=>{
 const server=makeServer({status:()=>({control:{targetScreens:[1,2],armed:false},quotes:[{symbol:'AAPL',price:1}]}),image:n=>n===0?Buffer.from('pngfixture'):undefined});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
 try{assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/screen/1.png')).status,200);assert.equal((await fetch(base+'/screen/3.png')).status,404);assert.equal((await fetch(base+'/api/arm',{method:'POST'})).status,405);assert.equal((await fetch(base+'/api/status')).headers.get('cache-control'),'no-store');assert((await(await fetch(base+'/')).text()).includes('SERVER UNREACHABLE'));}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('CLI defaults help and requires apply before inspecting secrets or networking',()=>{
 const cwd=fileURLToPath(new URL('..',import.meta.url));
 const help=spawnSync(process.execPath,['src/cli.ts'],{cwd,encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(help.status,0);assert.match(help.stdout,/Commands/);
 for(const args of [['arm'],['restore'],['push']]){const result=spawnSync(process.execPath,['src/cli.ts',...args],{cwd,encoding:'utf8',env:{PATH:process.env.PATH,FINNHUB_API_KEY:'DO_NOT_PRINT'}});assert.equal(result.status,1);assert(!result.stderr.includes('DO_NOT_PRINT'));}
});
test('persistent stop generation wins even when stop occurs inside an arm transition',()=>{
 const dir=mkdtempSync(join(tmpdir(),'tg-stop-race-'));try{
 const cfg=loadConfig({TARGET_SCREENS:'1,2',TICKERS:'AAPL,MSFT',DEVICE_IP:'192.168.240.1',FINNHUB_API_KEY:'SECRET',DEVICE_WRITES_ENABLED:'true',STATE_DIR:dir});const control=new Control(cfg);const before=control.stopVersion();control.stop();control.arm(before);assert.equal(control.isArmed(),false);
 control.requestArm();control.write('RESTORE_REQUEST',{fake:true});control.stop();assert.equal(control.takeArmRequest(),null);assert.throws(()=>readFileSync(control.path('RESTORE_REQUEST')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('migration preserves old env, refuses overwrite, copies only connection values, and keeps writes disabled',async()=>{
 const {migrateEnv}=await import('../src/migrate.ts');const {writeFileSync,statSync}=await import('node:fs');const dir=mkdtempSync(join(tmpdir(),'tg-migrate-'));
 try{const old=join(dir,'old.env'),next=join(dir,'new.env');const original='FINNHUB_API_KEY="SECRET$key"\nDEVICE_IP=192.168.240.5\nLOCAL_TOKEN=0\nDEVICE_ENDPOINT=post\nTICKERS=OLD,SET\nPROVIDER=mock\nUNRELATED_SECRET=hidden\n';writeFileSync(old,original);migrateEnv(old,next);const result=readFileSync(next,'utf8');assert.equal(readFileSync(old,'utf8'),original);assert(result.includes('FINNHUB_API_KEY="SECRET$key"'));assert(result.includes('TARGET_SCREENS=1,2'));assert(result.includes('DEVICE_WRITES_ENABLED=false'));assert(!result.includes('UNRELATED_SECRET'));assert(!result.includes('TICKERS=OLD'));assert(!result.split('\n').find(line=>line.startsWith('TICKERS='))!.includes('VALL'));assert.equal(result.split('\n').find(line=>line.startsWith('TICKERS='))!.split('=')[1].split(',').length,2);
 // Windows does not expose POSIX permission mode bits.
 if(process.platform!=='win32')assert.equal(statSync(next).mode&0o777,0o600);
 assert.throws(()=>migrateEnv(old,next));}finally{rmSync(dir,{recursive:true,force:true});}
});
