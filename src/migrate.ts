import {readFileSync,writeFileSync,statSync} from 'node:fs';
/** Copies only locally supplied connection secrets; never prints their values. */
export function migrateEnv(source:string,target:string):void {
  if(statSync(source).size>65536)throw new Error('Source configuration too large');const content=readFileSync(source,'utf8');if(Buffer.byteLength(content)>65536)throw new Error('Source configuration too large');
  const allowed=new Set(['DEVICE_IP','DEVICE_ENDPOINT','LOCAL_TOKEN','FINNHUB_API_KEY']);const selected=new Map<string,string>();
  for(const line of content.split(/\r?\n/)){
    const match=line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);if(match&&allowed.has(match[1]))selected.set(match[1],match[2]);
  }
  let template=readFileSync(new URL('../.env.example',import.meta.url),'utf8');
  for(const [key,value]of selected){
    // Preserve local dotenv quoting verbatim; input values never become code or command text.
    if(key==='DEVICE_ENDPOINT'&&!['post','"post"',"'post'",'divoom_api','"divoom_api"',"'divoom_api'"].includes(value.trim()))continue;
    template=template.replace(new RegExp(`^${key}=.*$`,'m'),()=>`${key}=${value}`);
  }
  writeFileSync(target,template,{flag:'wx',mode:0o600});
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
  const from=process.argv.indexOf('--from'),to=process.argv.indexOf('--to');
  try{if(from<0||to<0||!process.argv[from+1]||!process.argv[to+1])throw new Error();migrateEnv(process.argv[from+1],process.argv[to+1]);console.log('Created a separate .env with selected local connection settings. Device writes remain disabled.');}
  catch{console.error('Migration failed. Check paths; an existing destination is never overwritten. No configuration values printed.');process.exitCode=1;}
}
