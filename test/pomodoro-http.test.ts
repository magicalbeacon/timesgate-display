// Private addresses and credential values below are synthetic, mocked test fixtures.
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request,type IncomingHttpHeaders,type Server} from 'node:http';
import {PomodoroTimer} from '../src/pomodoro.ts';
import {createPomodoroHttp,type PomodoroHttpOptions} from '../src/pomodoro-http.ts';

const HOST='192.168.50.42:8081';
const ORIGIN=`http://${HOST}`;
type Headers=Record<string,string|string[]>;
type Response={status:number;headers:IncomingHttpHeaders;text:string;json:any};
type Request={method?:string;headers?:Headers;body?:string|Buffer;host?:string|string[]|null};

async function listen(server:Server):Promise<number>{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return (server.address() as {port:number}).port;
}
function send(port:number,path:string,options:Request={}):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const headers:Headers={...(options.host===null?{}:{host:options.host??HOST}),...options.headers};
    const headerPairs=Object.entries(headers).flatMap(([name,value])=>(Array.isArray(value)?value:[value]).flatMap(item=>[name,item]));
    const req=request({hostname:'127.0.0.1',port,path,method:options.method??'GET',headers:headerPairs,setHost:false},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.once('error',reject);res.once('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');let json:any;
        try{json=JSON.parse(text);}catch{json=undefined;}
        resolve({status:res.statusCode!,headers:res.headers,text,json});
      });
    });
    req.once('error',reject);req.end(options.body);
  });
}
async function fixture(t:TestContext,overrides:Partial<PomodoroHttpOptions>={}){
  let now=0,actionCalls=0,viewCalls=0;
  const timer=new PomodoroTimer({focusSeconds:60,breakSeconds:10},{monotonicClock:()=>now,wallClock:()=>Date.UTC(2026,0,1)+now});
  const handler=createPomodoroHttp({origin:ORIGIN,view:()=>{viewCalls++;return timer.view();},action:input=>{actionCalls++;return timer.action(input);},...overrides});
  const server=createServer((req,res)=>{
    handler(req,res).then(handled=>{if(!handled){res.statusCode=404;res.end('unrelated');}}).catch(error=>{res.statusCode=599;res.end(String(error));});
  });
  const port=await listen(server);
  t.after(async()=>{const closing=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();await closing;});
  const get=(path='/api/pomodoro',options:Request={})=>send(port,path,options);
  const token=async()=>{const response=await get('/api/pomodoro/control');assert.equal(response.status,200);return response.json.csrfToken as string;};
  const post=(csrfToken:string,body:string|Buffer,headers:Headers={})=>get('/api/pomodoro/action',{method:'POST',body,headers:{origin:ORIGIN,'content-type':'application/json','x-pomodoro-csrf':csrfToken,...headers}});
  return {port,get,token,post,timer,advance:(ms:number)=>{now+=ms;},actionCalls:()=>actionCalls,viewCalls:()=>viewCalls};
}
function assertNoCors(response:Response){
  for(const name of Object.keys(response.headers))assert(!name.startsWith('access-control-'),name);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.headers['set-cookie'],undefined);
  assert.equal(response.headers['x-content-type-options'],'nosniff');
  assert(Buffer.byteLength(response.text)<=4096);
}
const action=(name='start',revision=0)=>JSON.stringify({action:name,expectedRevision:revision});

test('HTTP options require an exact canonical HTTP origin',()=>{
  const timer=new PomodoroTimer();
  for(const origin of ['','not a url','https://192.168.240.1:8081','http://192.168.240.1:8081/','http://192.168.240.1:8081/a','http://user:pass@192.168.240.1:8081','http://192.168.240.1:8081?x=1','http://192.168.240.1:8081#x']){
    assert.throws(()=>createPomodoroHttp({origin,view:()=>timer.view(),action:input=>timer.action(input)}),/Invalid Pomodoro origin/);
  }
});

test('unrelated routes are untouched and public GET has no nonce or mutation',async t=>{
  const f=await fixture(t);const before=f.timer.view();
  const unrelated=await f.get('/api/status');assert.equal(unrelated.status,404);assert.equal(unrelated.text,'unrelated');assert.equal(unrelated.headers['cache-control'],undefined);
  for(let n=0;n<3;n++){
    const response=await f.get('/api/pomodoro',{headers:{origin:'https://example.invalid','sec-fetch-site':'cross-site'}});
    assert.equal(response.status,200);assert.deepEqual(response.json,before);assert.equal(response.json.csrfToken,undefined);assertNoCors(response);
  }
  assert.equal(f.actionCalls(),0);assert.deepEqual(f.timer.view(),before);
});

test('control GET returns one random process-local nonce and is mutation-free',async t=>{
  const f=await fixture(t),g=await fixture(t);const before=f.timer.view();
  const token=await f.token();assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(await f.token(),token);assert.notEqual(await g.token(),token);
  for(const headers of [{},{origin:ORIGIN},{'sec-fetch-site':'same-origin'},{'sec-fetch-site':'none'},{origin:ORIGIN,'sec-fetch-site':'same-origin'}]){
    const response=await f.get('/api/pomodoro/control',{headers});assert.equal(response.status,200);assert.equal(response.json.csrfToken,token);assert.deepEqual(response.json.view,before);assertNoCors(response);
  }
  assert.equal(f.actionCalls(),0);assert.deepEqual(f.timer.view(),before);
  assert.equal((await f.post(await g.token(),action())).status,403);assert.equal(f.actionCalls(),0);
});

test('control GET denies mismatched, null, duplicate and cross-site origins',async t=>{
  const f=await fixture(t);
  const cases:Headers[]=[{origin:'https://evil.invalid'},{origin:'null'},{origin:ORIGIN+'/'},{origin:'https://'+HOST},{origin:[ORIGIN,ORIGIN]},{'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'Same-Origin'},{'sec-fetch-site':['same-origin','same-origin']}];
  for(const headers of cases){const response=await f.get('/api/pomodoro/control',{headers});assert.equal(response.status,403,JSON.stringify(headers));assert.equal(response.json.reason,'forbidden');assert.equal(response.json.csrfToken,undefined);assertNoCors(response);}
  assert.equal(f.viewCalls(),0);assert.equal(f.actionCalls(),0);
});

test('every timer route checks exact Host and rejects rebinding hosts and duplicates',async t=>{
  const f=await fixture(t);
  for(const path of ['/api/pomodoro','/api/pomodoro/control','/api/pomodoro/action']){
    for(const host of ['evil.invalid:8081','192.168.50.42','192.168.50.42:8080','192.168.50.42.:8081',HOST+'.evil.invalid',[HOST,HOST],null]){
      const response=await f.get(path,{host});assert([400,403].includes(response.status),JSON.stringify({path,host,response}));assert.equal(response.json?.csrfToken,undefined);
    }
  }
  assert.equal(f.actionCalls(),0);assert.equal(f.viewCalls(),0);
});

test('wrong methods including GET action and CORS preflights cannot mutate',async t=>{
  const f=await fixture(t);const before=f.timer.view();
  for(const path of ['/api/pomodoro','/api/pomodoro/control','/api/pomodoro/action']){
    for(const method of path.endsWith('/action')?['GET','HEAD','OPTIONS','PUT','DELETE']:['POST','HEAD','OPTIONS','PUT','DELETE']){
      const response=await f.get(path,{method,headers:{origin:'https://evil.invalid','access-control-request-method':'POST'}});
      assert.equal(response.status,405,`${method} ${path}`);assert.equal(response.headers.allow,path.endsWith('/action')?'POST':'GET');assertNoCors(response);
    }
  }
  assert.deepEqual(f.timer.view(),before);assert.equal(f.actionCalls(),0);assert.equal(f.viewCalls(),0);
});

test('nonce and action parameters in URL queries are always rejected',async t=>{
  const f=await fixture(t);const token=await f.token();
  for(const path of ['/api/pomodoro','/api/pomodoro/control','/api/pomodoro/action']){
    const response=await f.get(path+'?csrfToken='+token+'&action=start',{method:path.endsWith('/action')?'POST':'GET',body:path.endsWith('/action')?action():undefined,headers:{origin:ORIGIN,'content-type':'application/json','x-pomodoro-csrf':token}});
    assert.equal(response.status,400);assert(!response.text.includes(token));assertNoCors(response);
  }
  assert.equal(f.actionCalls(),0);
});

test('POST requires exact Origin and same-origin fetch metadata when supplied',async t=>{
  const f=await fixture(t);const token=await f.token();
  const base:Headers={'content-type':'application/json','x-pomodoro-csrf':token};
  for(const origin of [undefined,'null','https://evil.invalid',ORIGIN+'/',ORIGIN+'.evil.invalid',[ORIGIN,ORIGIN]]){
    const response=await f.get('/api/pomodoro/action',{method:'POST',body:action(),headers:{...base,...(origin===undefined?{}:{origin})}});
    assert.equal(response.status,403);assert.equal(response.json.reason,'forbidden');assertNoCors(response);
  }
  for(const fetchSite of ['cross-site','same-site','none','Same-Origin',['same-origin','same-origin']]){
    assert.equal((await f.post(token,action(),{'sec-fetch-site':fetchSite})).status,403);
  }
  assert.equal(f.actionCalls(),0);
  assert.equal((await f.post(token,action(),{'sec-fetch-site':'same-origin'})).status,200);
});

test('POST rejects absent, incorrect, malformed and duplicated CSRF headers without throwing',async t=>{
  const f=await fixture(t);const token=await f.token();
  for(const provided of [undefined,'','wrong',token.slice(0,-1),token+'a','a'.repeat(43),'é'.repeat(43),[token,token]]){
    const response=await f.get('/api/pomodoro/action',{method:'POST',body:action(),headers:{origin:ORIGIN,'content-type':'application/json',...(provided===undefined?{}:{'x-pomodoro-csrf':provided})}});
    assert.equal(response.status,403);assert.equal(response.json.reason,'forbidden');assert(!response.text.includes(token));assertNoCors(response);
  }
  assert.equal(f.actionCalls(),0);
});

test('POST rejects form, non-JSON, duplicate media types and encoded bodies',async t=>{
  const f=await fixture(t);const token=await f.token();
  for(const contentType of [undefined,'text/plain','application/x-www-form-urlencoded','multipart/form-data; boundary=x','application/json; charset=iso-8859-1','application/json; other=value',['application/json','application/json']]){
    const response=await f.get('/api/pomodoro/action',{method:'POST',body:action(),headers:{origin:ORIGIN,'x-pomodoro-csrf':token,...(contentType===undefined?{}:{'content-type':contentType})}});
    assert.equal(response.status,415);assertNoCors(response);
  }
  assert.equal((await f.post(token,action(),{'content-encoding':'gzip'})).status,415);
  assert.equal(f.actionCalls(),0);
  assert.equal((await f.post(token,action(),{'content-type':'application/json; charset=UTF-8'})).status,200);
});

test('JSON rejects malformed bodies, extra or duplicate keys, unsupported actions and unsafe revisions',async t=>{
  const f=await fixture(t);const token=await f.token();
  const bodies=[
    '', '{', 'null', 'true', '[]', '{}', '"start"',
    '{"action":"start"}', '{"expectedRevision":0}',
    '{"action":"start","expectedRevision":0,"device":"arm"}',
    '{"action":"start","expectedRevision":0,"__proto__":{}}',
    '{"action":"start","action":"reset","expectedRevision":0}',
    '{"action":"start","expectedRevision":0,"expectedRevision":0}',
    '{"action":"start","expectedRevision":0,"\\u0061ction":"reset"}',
    '{"action":"start","expectedRevision":"0"}',
    '{"action":"start","expectedRevision":null}',
    '{"action":"start","expectedRevision":false}',
    '{"action":"start","expectedRevision":-1}',
    '{"action":"start","expectedRevision":1.5}',
    '{"action":"start","expectedRevision":9007199254740992}',
    '{"action":"start","expectedRevision":1e999}',
    action('arm'),action('stop'),action('START'),action(' start '),
    Buffer.from([0xff,0xfe,0x7b,0x7d]),
  ];
  const before=f.timer.view();
  for(const body of bodies){const response=await f.post(token,body);assert.equal(response.status,400,String(body));assert.equal(response.json.reason,'invalid_json');assertNoCors(response);}
  assert.deepEqual(f.timer.view(),before);assert.equal(f.actionCalls(),0);
});

test('valid actions update only timer state and stale or duplicate submissions return 409',async t=>{
  const f=await fixture(t);const token=await f.token();
  let response=await f.post(token,action());assert.equal(response.status,200);assert.equal(response.json.view.status,'running');assert.equal(response.json.view.revision,1);assertNoCors(response);
  const started=response.json.view;
  response=await f.post(token,action());assert.equal(response.status,409);assert.equal(response.json.reason,'stale_revision');assert.deepEqual(response.json.view,started);
  f.advance(5100);
  response=await f.post(token,action('pause',1));assert.equal(response.status,200);assert.equal(response.json.view.status,'paused');assert.equal(response.json.view.remainingSeconds,55);
  f.advance(30_000);
  response=await f.post(token,action('resume',2));assert.equal(response.status,200);assert.equal(response.json.view.status,'running');assert.equal(response.json.view.remainingSeconds,55);
  response=await f.post(token,action('reset',3));assert.equal(response.status,200);assert.equal(response.json.view.status,'idle');assert.equal(response.json.view.remainingSeconds,60);assert.equal(response.json.view.revision,4);
  const reset=response.json.view;
  response=await f.post(token,action('reset',3));assert.equal(response.status,409);assert.deepEqual(response.json.view,reset);
  response=await f.post(token,action('resume',4));assert.equal(response.status,400);assert.equal(response.json.reason,'invalid_action');assert.deepEqual(response.json.view,reset);
});

test('parallel duplicate actions cannot both apply and GET expiration never starts next phase',async t=>{
  const f=await fixture(t);const token=await f.token();
  const responses=await Promise.all([f.post(token,action()),f.post(token,action())]);
  assert.deepEqual(responses.map(value=>value.status).sort(),[200,409]);assert.equal(f.timer.view().revision,1);
  f.advance(70_000);
  const completed=await f.get();assert.equal(completed.json.status,'completed');assert.equal(completed.json.remainingSeconds,0);assert.equal(completed.json.phase,'focus');assert.equal(completed.json.revision,2);
  for(let n=0;n<3;n++){assert.deepEqual((await f.get()).json,completed.json);assert.deepEqual((await f.get('/api/pomodoro/control')).json.view,completed.json);}
  assert.equal(f.actionCalls(),2);
  assert.equal((await f.post(token,action('reset',1))).status,409);
  const next=await f.post(token,action('start',2));assert.equal(next.status,200);assert.equal(next.json.view.phase,'break');assert.equal(next.json.view.status,'running');
});

test('body size is limited to 512 bytes for Content-Length and chunked requests',async t=>{
  const f=await fixture(t);const token=await f.token();
  for(const headers of [{'content-length':'513'},{'transfer-encoding':'chunked'}]){
    const response=await f.post(token,action().padEnd(513,' '),headers);assert.equal(response.status,413);assert.equal(response.json.reason,'payload_too_large');assertNoCors(response);
  }
  const bytes=Buffer.concat([Buffer.from(action().padEnd(510,' ')),Buffer.from('😀')]);
  assert.equal((await f.post(token,bytes,{'transfer-encoding':'chunked'})).status,413);assert.equal(f.actionCalls(),0);
  const exact=await f.post(token,action().padEnd(512,' '),{'content-length':'512'});assert.equal(exact.status,200);assert.equal(f.actionCalls(),1);
});

test('unfinished request bodies time out without action, nonce disclosure or retries',async t=>{
  const f=await fixture(t);const token=await f.token();const before=f.timer.view();const started=performance.now();
  const response=await new Promise<Response>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:f.port,path:'/api/pomodoro/action',method:'POST',headers:{host:HOST,origin:ORIGIN,'content-type':'application/json','x-pomodoro-csrf':token,'transfer-encoding':'chunked'}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});res.once('end',()=>{resolve({status:res.statusCode!,headers:res.headers,text,json:JSON.parse(text)});req.destroy();});
    });
    req.once('error',reject);req.write('{"action":');
  });
  assert.equal(response.status,408);assert.equal(response.json.reason,'request_timeout');assert.equal(response.headers.connection,'close');assert(!response.text.includes(token));assert(performance.now()-started<5000);assertNoCors(response);
  assert.equal(f.actionCalls(),0);assert.deepEqual(f.timer.view(),before);
});

test('an interrupted request body cannot mutate state or break subsequent reads',async t=>{
  const f=await fixture(t);const token=await f.token();const before=f.timer.view();
  await new Promise<void>(resolve=>{
    const req=request({hostname:'127.0.0.1',port:f.port,path:'/api/pomodoro/action',method:'POST',headers:{host:HOST,origin:ORIGIN,'content-type':'application/json','x-pomodoro-csrf':token,'transfer-encoding':'chunked'}});
    req.on('error',()=>{});req.once('close',resolve);
    req.write('{"action":"start",',()=>setTimeout(()=>req.destroy(),10));
  });
  const response=await f.get();assert.equal(response.status,200);assert.deepEqual(response.json,before);assert.equal(f.actionCalls(),0);
  assert.equal((await f.post(token,action())).status,200);
});

test('callback failures and unbounded outputs return fixed bounded errors',async t=>{
  const secret='MUST_NOT_LEAK';
  const f=await fixture(t,{view:()=>{throw new Error(secret);}});
  for(const path of ['/api/pomodoro','/api/pomodoro/control']){const response=await f.get(path);assert.equal(response.status,500);assert.equal(response.json.reason,'internal_error');assert(!response.text.includes(secret));assertNoCors(response);}
  const g=await fixture(t,{action:()=>{throw new Error(secret);}});const token=await g.token();const failed=await g.post(token,action());assert.equal(failed.status,500);assert(!failed.text.includes(secret));assertNoCors(failed);
  const timer=new PomodoroTimer();const large=await fixture(t,{view:()=>({...timer.view(),extra:'x'.repeat(5000)})});const bounded=await large.get('/api/pomodoro/control');assert.equal(bounded.status,500);assert.equal(bounded.json.csrfToken,undefined);assertNoCors(bounded);
});
