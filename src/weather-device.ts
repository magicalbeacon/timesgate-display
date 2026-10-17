import {post,type Fetcher} from './device.ts';
import {requireWeatherServer,type Config} from './config.ts';
import {Control} from './control.ts';
export const WEATHER_SCREEN=4;
export const WEATHER_PANEL_ROWS=[
  {field:'forecastCompact',x:36,y:17,width:92,height:16,font:4,align:1,color:'#FFCB70'},
  {field:'temperatureLarge',x:0,y:41,width:74,height:24,font:246,align:1,color:'#FF9A94'},
  {field:'humidityBrief',x:88,y:49,width:40,height:16,font:4,align:3,color:'#D5ADFF'},
  {field:'observationBrief',x:0,y:66,width:128,height:16,font:4,align:1,color:'#8DABBF'},
  {field:'rainPercent',x:16,y:86,width:66,height:26,font:492,align:3,color:'#62CCFF'},
  {field:'rainWindow',x:86,y:95,width:42,height:16,font:4,align:1,color:'#FFD478'},
  {field:'rainSource',x:0,y:112,width:128,height:16,font:4,align:1,color:'#8DABBF'},
] as const;
export const WEATHER_PANEL_FIELDS=WEATHER_PANEL_ROWS.map(row=>row.field);
export function weatherLayout(config:Config){
  const base=requireWeatherServer(config);
  return {Command:'Draw/SendHttpItemList',LcdIndex:WEATHER_SCREEN,NewFlag:1,BackgroudGif:`${base}/weather/thermometer-v42.gif`,
    ItemList:WEATHER_PANEL_ROWS.map((row,i)=>({TextId:33+i,type:23,x:row.x,y:row.y,dir:0,font:row.font,TextWidth:row.width,Textheight:row.height,TextString:`${base}/weather/5/${row.field}`,speed:100,color:row.color,update_time:60,align:row.align}))};
}
/** Single explicit weather setup; no image IDs, text clear, channel switch or other LCD targets. */
export async function setupWeather(config:Config,control:Control,apply=false,stopVersion=control.stopVersion(),fetcher:Fetcher=fetch):Promise<void>{
  if(!apply||!config.writesEnabled||control.isArmed())throw new Error('Stop stock rotation and explicitly apply weather setup with writes enabled');
  const payload=weatherLayout(config);
  if(stopVersion!==control.stopVersion())throw new Error('Weather setup cancelled by stop');
  const guarded=(async(url,init)=>{
    if(String(url)!==config.device.url||init?.method!=='POST'||typeof init.body!=='string')throw new Error('Blocked invalid weather request');
    const p=JSON.parse(init.body);const {LocalToken,...withoutToken}=p;
    if(JSON.stringify(withoutToken)!==JSON.stringify(payload)||p.Command!=='Draw/SendHttpItemList'||p.LcdIndex!==WEATHER_SCREEN||control.isArmed()||stopVersion!==control.stopVersion())throw new Error('Blocked weather write outside its explicit scope');
    return fetcher(url,init);
  }) as Fetcher;
  try{await post(config.device,payload,guarded);}catch(error){control.halt();throw error;}
}
