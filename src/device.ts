import { isIP } from 'node:net';
export type DeviceConfig={url:string;token?:number;timeout:number};
export type Fetcher=typeof fetch;
export function loadDevice(env:Record<string,string|undefined>=process.env):DeviceConfig {
  const ip=env.DEVICE_IP?.trim()||'';const [a,b]=ip.split('.').map(Number);
  if(isIP(ip)!==4||!(a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168)))throw new Error('DEVICE_IP must be a private LAN IPv4 address');
  const endpoint=env.DEVICE_ENDPOINT||'post';if(!['post','divoom_api'].includes(endpoint))throw new Error('DEVICE_ENDPOINT must be post or divoom_api');
  const token=env.LOCAL_TOKEN?.trim();
  if(token&&(!/^\d+$/.test(token)||!Number.isSafeInteger(Number(token))))throw new Error('LOCAL_TOKEN must be a nonnegative safe integer');
  return {url:endpoint==='post'?`http://${ip}/post`:`http://${ip}:9000/divoom_api`,token:token?Number(token):undefined,timeout:5000};
}
type FailureKind='network'|'timeout'|'interrupted'|'http'|'empty_response'|'response_too_large'|'invalid_json'|'invalid_response'|'missing_error_code'|'invalid_error_code'|'device_error'|'redacted_device_code';
const FAILURE_TEXT:Record<FailureKind,string>={network:'network request failed',timeout:'request timed out',interrupted:'request interrupted',http:'HTTP status',empty_response:'empty response',response_too_large:'response exceeded 32 KiB',invalid_json:'response was not valid JSON',invalid_response:'response was not a JSON object',missing_error_code:'response omitted error_code',invalid_error_code:'response had an unsupported error_code',device_error:'device error_code',redacted_device_code:'device rejected command (code redacted)'};
class DeviceRequestError extends Error {
  readonly #reason:string;
  constructor(kind:FailureKind,value?:number){
    const detail=kind==='http'&&Number.isInteger(value)&&value!>=100&&value!<=599?` ${value}`
      :kind==='device_error'&&Number.isInteger(value)&&Math.abs(value!)<=65535?` ${value}`:'';
    const reason=FAILURE_TEXT[kind]+detail;super(reason);this.name='DeviceRequestError';this.#reason=reason;
  }
  safeReason(){return this.#reason;}
}
/** Only application-created classifications and bounded status codes can reach public diagnostics. */
export function deviceFailureReason(error:unknown):string {
  return error instanceof DeviceRequestError?error.safeReason():'local validation or operation failed';
}
export async function post(config:DeviceConfig,payload:Record<string,unknown>,fetcher:Fetcher):Promise<Record<string,unknown>> {
  let result:unknown;const signal=AbortSignal.timeout(config.timeout);
  try {
    const res=await fetcher(config.url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...payload,...(config.token!==undefined?{LocalToken:config.token}:{})}),
      signal,redirect:'error'});
    if(!res.ok)throw new DeviceRequestError('http',res.status);
    if(!res.body)throw new DeviceRequestError('empty_response');
    const reader=res.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>32768){await reader.cancel().catch(()=>{});throw new DeviceRequestError('response_too_large');}chunks.push(chunk.value);}
    try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DeviceRequestError('invalid_json');}
  } catch(error) {
    if(error instanceof DeviceRequestError)throw error;
    if(signal.aborted)throw new DeviceRequestError('timeout');
    if(error instanceof Error&&error.name==='AbortError')throw new DeviceRequestError('interrupted');
    throw new DeviceRequestError('network');
  }
  if(!result||typeof result!=='object'||Array.isArray(result))throw new DeviceRequestError('invalid_response');
  const code=(result as Record<string,unknown>).error_code;
  if(code===0||code==='0')return result as Record<string,unknown>;
  if(code===undefined)throw new DeviceRequestError('missing_error_code');
  const numeric=typeof code==='number'?code:typeof code==='string'&&/^-?\d{1,5}$/.test(code)?Number(code):NaN;
  if(Number.isInteger(numeric)&&numeric!==0&&Math.abs(numeric)<=65535){
    if(config.token!==undefined&&Math.abs(numeric)===config.token)throw new DeviceRequestError('redacted_device_code');
    throw new DeviceRequestError('device_error',numeric);
  }
  throw new DeviceRequestError('invalid_error_code');
}
export async function readNextId(config:DeviceConfig,fetcher:Fetcher=fetch):Promise<number> {
  const data=await post(config,{Command:'Draw/GetHttpGifId'},fetcher);
  if(!Number.isInteger(data.PicId)||Number(data.PicId)<1||Number(data.PicId)>65535)throw new Error('Read-only next-image-ID probe unsupported or invalid; no screen changed');
  return Number(data.PicId);
}
export async function pushImage(config:DeviceConfig,screen:number,image:Buffer,apply:boolean,fetcher:Fetcher=fetch):Promise<number> {
  if(!apply)throw new Error('No device requests made. Add --apply to replace the selected screen with one chart snapshot');
  if(!Number.isInteger(screen)||screen<0||screen>4)throw new Error('Screen must be an integer from 0 to 4');
  if(image.length<100||image.length>256*1024||image[0]!==255||image[1]!==216||image.at(-2)!==255||image.at(-1)!==217)throw new Error('Expected a bounded complete JPEG');
  const nextId=await readNextId(config,fetcher);
  try {await post(config,{Command:'Draw/ClearHttpText',LcdId:screen,TextId:-1},fetcher);}
  catch {throw new Error(`Screen ${screen} overlay clear failed or timed out; it may have changed. No image sent; no automatic retry`);}
  try {await post(config,{Command:'Draw/SendHttpGif',LcdArray:Array.from({length:5},(_,i)=>i===screen?1:0),
    PicNum:1,PicWidth:128,PicOffset:0,PicID:nextId,PicSpeed:1000,PicData:image.toString('base64')},fetcher);}
  catch {throw new Error(`Screen ${screen} image write failed or timed out after its overlay was cleared. It may be blank or changed; no automatic retry`);}
  return nextId;
}

function privateOrigin(url:string):URL {
  let parsed:URL;try {parsed=new URL(url);}catch{throw new Error('Restore layout has an invalid URL');}
  const [a,b]=parsed.hostname.split('.').map(Number);
  if(parsed.protocol!=='http:'||isIP(parsed.hostname)!==4||!(a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168))||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Restore URLs must be clean private-LAN HTTP URLs');
  return parsed;
}
/** Restore one exported native layout, never all five and never arbitrary commands. */
export async function restoreLayout(config:DeviceConfig,screen:number,input:unknown,apply:boolean,fetcher:Fetcher=fetch):Promise<void> {
  if(!apply)throw new Error('No device requests made. Add --apply to restore only the selected screen');
  if(!Number.isInteger(screen)||screen<0||screen>4)throw new Error('Screen must be an integer from 0 to 4');
  if(!Array.isArray(input)||input.length!==5)throw new Error('Expected a five-screen stock-app layout export');
  const matches=input.filter(p=>p&&typeof p==='object'&&p.LcdIndex===screen);
  if(matches.length!==1)throw new Error('Restore export must contain exactly one matching screen');
  const p=matches[0] as Record<string,unknown>;
  const allowed=['Command','LcdIndex','NewFlag','BackgroudGif','ItemList'];
  if(Object.keys(p).some(key=>!allowed.includes(key))||p.Command!=='Draw/SendHttpItemList'||p.NewFlag!==1||typeof p.BackgroudGif!=='string'||!Array.isArray(p.ItemList)||![6,7].includes(p.ItemList.length))throw new Error('Only a native stock-app polling layout can be restored');
  const background=privateOrigin(p.BackgroudGif);
  if(!['/black.gif','/bold.gif'].includes(background.pathname))throw new Error('Unrecognized stock-app background');
  const itemKeys=['TextId','type','x','y','dir','font','TextWidth','Textheight','TextString','speed','color','update_time','align'];
  const ids=new Set<number>();
  for(const row of p.ItemList) {
    if(!row||typeof row!=='object'||Object.keys(row).some(key=>!itemKeys.includes(key))||row.type!==23||typeof row.TextString!=='string')throw new Error('Restore items must be native stock-app text polls');
    for(const key of ['TextId','x','y','font','TextWidth','Textheight','speed','update_time','align','dir'])if(!Number.isInteger(row[key]))throw new Error('Restore layout has invalid numeric fields');
    if(row.TextId<0||row.TextId>=40||ids.has(row.TextId)||row.x<0||row.y<0||row.TextWidth<1||row.Textheight<1||row.x+row.TextWidth>128||row.y+row.Textheight>128||![4,246].includes(row.font)||row.update_time<30||row.update_time>60||row.align!==1||row.dir!==0||row.speed<0||row.speed>1000||!/^#[A-Fa-f0-9]{6}$/.test(row.color))throw new Error('Restore layout is outside the supported stock-app bounds');
    ids.add(row.TextId);
    const text=privateOrigin(row.TextString);
    if(text.origin!==background.origin||!new RegExp(`^/disp/${screen}/(symbol|price|change|status|date|time|heading|value|gain|loss)$`).test(text.pathname))throw new Error('Restore poll URLs must match the selected screen and stock server');
  }
  // Older stock exports reused IDs across screens; normalize without changing URLs or style.
  const payload={...p,ItemList:p.ItemList.map((row,index)=>({...row,TextId:screen*8+index+1}))};
  try {await post(config,payload,fetcher);}
  catch {throw new Error(`Screen ${screen} restore failed or timed out; it may have changed. No automatic retry`);}
}
