import {readFileSync,existsSync} from 'node:fs';
import {loadConfig,pairFor,fingerprint,weatherFingerprint} from './config.ts';
import {Control} from './control.ts';
import {Writer} from './writer.ts';
import {MarketCache} from './market.ts';
import {renderPanel} from './render.ts';
import {makeServer} from './server.ts';
import {RainCache,RAIN_SOURCE} from './rain.ts';
import {WeatherCache} from './weather.ts';
import {setupWeather} from './weather-device.ts';
import {deviceFailureReason} from './device.ts';
const config=loadConfig();const control=new Control(config);const writer=new Writer(config,control);
// A process restart can follow an uncertain in-flight device write. Always require a fresh explicit arm.
control.stop();
const market=new MarketCache({tickers:config.tickers,apiKey:config.apiKey,quoteRefreshSeconds:config.quoteRefreshSeconds,historyRefreshHours:config.historyRefreshHours,staleQuoteSeconds:config.staleQuoteSeconds});
const weather=config.weatherEnabled?new WeatherCache():undefined;
const rain=config.weatherEnabled?new RainCache():undefined;
function weatherView(){return weather?{...weather.view(),rain:{...rain!.view(),metadata:RAIN_SOURCE}}:null;}
let step=0,running=true,lastWrite:string|null=null,lastRestore:string|null=null,lastWeatherSetup:string|null=null,nextRotation=0;
const previews=new Map<number,Buffer>();let displayedSymbols:[string,string]=pairFor(config.tickers,0);
function status(){return {version:'0.4.3',control:control.status(),rotationSeconds:config.rotationSeconds,displayedSymbols,lastWrite,lastRestore,lastWeatherSetup,weather:weatherView(),quoteSource:'Finnhub US / Yahoo delayed price-only routes',historySource:'Yahoo unofficial completed daily OHLC',quotes:market.all()};}
const server=makeServer({status,image:screen=>previews.get(screen),...(weather?{weather:()=>weatherView()!}:{})});
server.listen(config.port,'0.0.0.0',()=>console.log(`Two-screen service listening on port ${config.port}; explicit arm required`));
market.start();weather?.start();rain?.start();
async function cycle(){
  if(!running)return;
  try {
    if(await writer.processArm()){step=0;nextRotation=0;}
    if(existsSync(control.path('RESTORE_REQUEST'))){
      let payload:any;try{payload=JSON.parse(readFileSync(control.path('RESTORE_REQUEST'),'utf8'));}catch{payload=null;}
      control.remove('RESTORE_REQUEST');
      if(!control.isArmed()&&payload?.fingerprint===fingerprint(config)&&payload?.stopVersion===control.stopVersion()&&Number.isFinite(payload?.at)&&Date.now()-payload.at>=0&&Date.now()-payload.at<60000){lastRestore=await writer.restore(payload.layout,true,payload.stopVersion)?'Selected native layouts restored':'Restore failed; inspect selected screens';}
      else lastRestore='Restore rejected while armed; stop first';
    }
    if(existsSync(control.path('WEATHER_REQUEST'))){
      let request:any;try{request=JSON.parse(readFileSync(control.path('WEATHER_REQUEST'),'utf8'));}catch{request=null;}
      control.remove('WEATHER_REQUEST');
      if(!control.isArmed()&&weather&&request?.fingerprint===weatherFingerprint(config)&&request?.stopVersion===control.stopVersion()&&Number.isFinite(request?.at)&&Date.now()-request.at>=0&&Date.now()-request.at<60000){
        try{await setupWeather(config,control,true,request.stopVersion);lastWeatherSetup='Screen5 native weather setup acknowledged';}
        catch(error){lastWeatherSetup=`Weather setup failed (${deviceFailureReason(error)}); inspect screen5 before retrying`;}
      } else lastWeatherSetup='Weather setup rejected; stop stock rotation and check configuration';
    }
    if(Date.now()>=nextRotation){
      displayedSymbols=pairFor(config.tickers,step);
      const images=displayedSymbols.map(symbol=>renderPanel({symbol,quote:market.quote(symbol),history:market.history(symbol)}));
      images.forEach((image,i)=>previews.set(config.screens[i],image.png));
      if(control.isArmed()){
        const success=await writer.pair(images.map(image=>image.jpeg));
        if(success){lastWrite=new Date().toISOString();step=(step+1)%config.tickers.length;}
      } else step=(step+1)%config.tickers.length;
      nextRotation=Date.now()+config.rotationSeconds*1000;
    }
    control.write('STATUS',{...status(),heartbeat:new Date().toISOString()});
  } catch {control.halt();console.error('Service cycle failed; device writes halted. No raw provider or device response logged');}
  if(running)setTimeout(()=>void cycle(),500);
}
void cycle();
function stop(){running=false;control.stop();market.stop();weather?.stop();rain?.stop();server.close();setTimeout(()=>process.exit(0),6000).unref();}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
