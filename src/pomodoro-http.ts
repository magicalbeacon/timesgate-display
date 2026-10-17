import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';

export type PomodoroHttpView={phase:string;status:string;remainingSeconds:number;durationSeconds:number;progress:number;revision:number};
export type PomodoroHttpAction={action:'start'|'pause'|'resume'|'reset';expectedRevision:number};
export type PomodoroHttpResult={ok:boolean;reason?:string;message?:string;view:PomodoroHttpView};
export type PomodoroHttpOptions={origin:string;view:()=>PomodoroHttpView;action:(input:PomodoroHttpAction)=>PomodoroHttpResult};

const MAX_BODY_BYTES=512;
const BODY_TIMEOUT_MS=2000;
const MAX_RESPONSE_BYTES=4096;
const ACTIONS=new Set(['start','pause','resume','reset']);
const ROUTES=new Set(['/api/pomodoro','/api/pomodoro/control','/api/pomodoro/action']);
const ERRORS={
  forbidden:{ok:false,reason:'forbidden',message:'Request rejected.'},
  method:{ok:false,reason:'method_not_allowed',message:'Method not allowed.'},
  request:{ok:false,reason:'invalid_request',message:'Invalid request.'},
  json:{ok:false,reason:'invalid_json',message:'Invalid JSON action.'},
  media:{ok:false,reason:'unsupported_media_type',message:'JSON content required.'},
  large:{ok:false,reason:'payload_too_large',message:'Request body too large.'},
  timeout:{ok:false,reason:'request_timeout',message:'Request body timed out.'},
  internal:{ok:false,reason:'internal_error',message:'Timer unavailable.'},
} as const;
type ErrorKind=keyof typeof ERRORS;
class BodyError extends Error {
  status:number;kind:ErrorKind;
  constructor(status:number,kind:ErrorKind){super(kind);this.status=status;this.kind=kind;}
}

/** Duplicate security headers are invalid even when Node discards or joins them. */
function header(req:IncomingMessage,name:string):string|undefined|null {
  let count=0;
  for(let n=0;n<req.rawHeaders.length;n+=2)if(req.rawHeaders[n].toLowerCase()===name)count++;
  const value=req.headers[name];
  return count>1||Array.isArray(value)?null:value;
}

function reply(res:ServerResponse,status:number,value:unknown):void {
  if(res.destroyed||res.writableEnded)return;
  let body:string;
  try{body=JSON.stringify(value);if(typeof body!=='string'||Buffer.byteLength(body)>MAX_RESPONSE_BYTES)throw new Error();}
  catch{status=500;body=JSON.stringify(ERRORS.internal);}
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Length',Buffer.byteLength(body));
  res.end(body);
}

function reject(res:ServerResponse,status:number,kind:ErrorKind,close=false):void {
  if(close&&!res.destroyed&&!res.writableEnded){res.shouldKeepAlive=false;res.setHeader('Connection','close');}
  reply(res,status,ERRORS[kind]);
}

function readBody(req:IncomingMessage):Promise<Buffer> {
  return new Promise((resolve,rejectBody)=>{
    const chunks:Buffer[]=[];let length=0;let finished=false;
    const cleanup=()=>{clearTimeout(timer);req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('error',onError);req.removeListener('aborted',onAbort);req.removeListener('close',onClose);};
    const fail=(error:BodyError)=>{if(finished)return;finished=true;cleanup();req.pause();rejectBody(error);};
    const onData=(chunk:Buffer|string)=>{
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      length+=bytes.length;
      if(length>MAX_BODY_BYTES){fail(new BodyError(413,'large'));return;}
      chunks.push(bytes);
    };
    const onEnd=()=>{if(finished)return;finished=true;cleanup();resolve(Buffer.concat(chunks,length));};
    const onError=()=>fail(new BodyError(400,'request'));
    const onAbort=()=>fail(new BodyError(400,'request'));
    const onClose=()=>{if(!req.complete)fail(new BodyError(400,'request'));};
    const timer=setTimeout(()=>fail(new BodyError(408,'timeout')),BODY_TIMEOUT_MS);timer.unref();
    req.on('data',onData);req.once('end',onEnd);req.once('error',onError);req.once('aborted',onAbort);req.once('close',onClose);
  });
}

function parseAction(body:Buffer):PomodoroHttpAction|null {
  try{
    const text=new TextDecoder('utf-8',{fatal:true}).decode(body);
    const value=JSON.parse(text);
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const keys=Object.keys(value);
    if(keys.length!==2||!Object.hasOwn(value,'action')||!Object.hasOwn(value,'expectedRevision'))return null;
    if(typeof value.action!=='string'||!ACTIONS.has(value.action)||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)return null;
    // JSON.parse otherwise silently accepts duplicate object keys. The only
    // permitted shape has two primitive fields, so it must have two unquoted
    // colons. Count outside strings, including JSON-escaped property names.
    let quoted=false,escaped=false,colons=0;
    for(const character of text){
      if(quoted){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;}
      else if(character==='"')quoted=true;
      else if(character===':')colons++;
    }
    return colons===2?{action:value.action,expectedRevision:value.expectedRevision}:null;
  }catch{return null;}
}

/**
 * Isolated local timer HTTP routes. No device, file, cookie, or network access.
 * The caller validates the private, fixed-port dashboard origin at startup.
 * Keep one handler instance for the lifetime of the HTTP server: its random
 * CSRF token stays in process memory and is never accepted from a URL.
 */
export function createPomodoroHttp(options:PomodoroHttpOptions):(req:IncomingMessage,res:ServerResponse)=>Promise<boolean> {
  let canonical:URL;
  try{canonical=new URL(options.origin);}catch{throw new Error('Invalid Pomodoro origin');}
  if(canonical.protocol!=='http:'||canonical.origin!==options.origin||canonical.username||canonical.password)throw new Error('Invalid Pomodoro origin');
  const origin=canonical.origin,host=canonical.host;
  const csrfToken=randomBytes(32).toString('base64url');
  const csrfBytes=Buffer.from(csrfToken);

  return async(req,res)=>{
    const path=req.url?.split('?')[0]??'';
    if(!ROUTES.has(path))return false;
    const isAction=path==='/api/pomodoro/action';
    const close=req.method!=='GET';
    if(header(req,'host')!==host){reject(res,403,'forbidden',close);return true;}
    if(req.url!==path){reject(res,400,'request',close);return true;}
    const method=isAction?'POST':'GET';
    if(req.method!==method){res.setHeader('Allow',method);reject(res,405,'method',close);return true;}

    if(path==='/api/pomodoro/control'||isAction){
      const requestOrigin=header(req,'origin');
      const fetchSite=header(req,'sec-fetch-site');
      const allowedFetchSite=fetchSite===undefined||fetchSite==='same-origin'||(!isAction&&fetchSite==='none');
      if((isAction?requestOrigin!==origin:requestOrigin!==undefined&&requestOrigin!==origin)||!allowedFetchSite){
        reject(res,403,'forbidden',close);return true;
      }
    }

    if(!isAction){
      try{const view=options.view();reply(res,200,path==='/api/pomodoro/control'?{csrfToken,view}:view);}
      catch{reject(res,500,'internal');}
      return true;
    }

    const providedToken=header(req,'x-pomodoro-csrf');
    if(typeof providedToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(providedToken)||!timingSafeEqual(Buffer.from(providedToken),csrfBytes)){
      reject(res,403,'forbidden',true);return true;
    }
    const contentType=header(req,'content-type');
    const contentEncoding=header(req,'content-encoding');
    if(typeof contentType!=='string'||!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType)||contentEncoding!==undefined){
      reject(res,415,'media',true);return true;
    }
    const contentLength=header(req,'content-length');
    const transferEncoding=header(req,'transfer-encoding');
    if(contentLength===null||transferEncoding===null||
      (contentLength!==undefined&&!/^\d+$/.test(contentLength))||
      (transferEncoding!==undefined&&(transferEncoding!=='chunked'||contentLength!==undefined))){
      reject(res,400,'request',true);return true;
    }
    if(contentLength!==undefined&&Number(contentLength)>MAX_BODY_BYTES){reject(res,413,'large',true);return true;}
    try{
      const input=parseAction(await readBody(req));
      if(!input){reject(res,400,'json');return true;}
      // This is the sole state-changing call, after every request guard passes.
      const result=options.action(input);
      reply(res,result.ok?200:result.reason==='stale_revision'?409:400,result);
    }catch(error){
      if(error instanceof BodyError)reject(res,error.status,error.kind,true);
      else reject(res,500,'internal',true);
    }
    return true;
  };
}
