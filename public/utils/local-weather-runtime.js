import {authenticationSnapshot,deviceBootstrap,isDevicePrincipal} from './device-context.js';
import {sessionRevision,watchSessionChanges} from './session-lifecycle.js';
import {isWallModeEnabled} from './wall-mode.js';
import {normalizeWeatherObservation,WEATHER_THEME_REFRESH_MS} from './weather-appearance.js';
import {normalizeWeatherScene,normalizeWeatherSceneEnvelope} from './weather-scene-facts.js';

function browserOwner(){
  const auth=authenticationSnapshot(),device=deviceBootstrap();
  const wall=isWallModeEnabled()&&!isDevicePrincipal();
  return{key:JSON.stringify([sessionRevision(),auth.context,auth.epoch,device?.device?.id,device?.device?.revision,!!device?.temporary,device?.user?.id,wall]),path:wall?'/wall/weather/theme':'/weather/theme'};
}

// One non-persistent reader owns the active appearance. Ownership changes erase
// its observation and invalidate late responses, even if the theme stays selected.
export function startLocalWeather({onChange=()=>{},getOwner=browserOwner,sceneMode=false,
  read=async(path,signal)=>{const {api}=await import('../api.js');return api.get(path,{signal});},
  now=()=>Date.now(),visible=()=>document.visibilityState!=='hidden',online=()=>navigator.onLine!==false,
  schedule=(fn,delay)=>setTimeout(fn,delay),cancel=id=>clearTimeout(id),
  windowTarget=globalThis.window,documentTarget=globalThis.document,watchSession=watchSessionChanges}={}){
  let stopped=false,parked=false,owner=null,generation=0,value=null,scene=null,deadline=0,timer=null,pending=null;
  const events=[];
  const clearTimer=()=>{if(timer!==null)cancel(timer);timer=null;};
  function arm(){clearTimer();if(stopped||parked||pending||!owner||!visible()||!online())return;timer=schedule(tick,Math.max(1000,deadline-now()));timer?.unref?.();}
  function syncOwner(){
    const next=getOwner();
    if(next?.key===owner?.key)return;
    generation++;pending?.controller.abort();if(pending)cancel(pending.timeout);pending=null;clearTimer();owner=next;value=null;scene=null;deadline=0;onChange();
  }
  async function tick(){
    if(stopped||parked)return;syncOwner();
    if(!owner||!visible()||!online()){clearTimer();return;}
    if(pending||now()<deadline){arm();return;}
    const captured={...owner},run=generation,controller=new AbortController(),request={controller};pending=request;
    deadline=now()+WEATHER_THEME_REFRESH_MS;
    const timeout=schedule(()=>controller.abort(),15000);request.timeout=timeout;timeout?.unref?.();
    const current=()=>!stopped&&run===generation&&getOwner()?.key===captured.key&&!controller.signal.aborted;
    try{
      const path=sceneMode?captured.path.replace(/\/theme$/,'/scene'):captured.path;
      const response=await read(path,controller.signal);
      if(!current())return;
      if(sceneMode){const envelope=normalizeWeatherSceneEnvelope(response?.data,new Date(now()));value=envelope?.theme??null;scene=envelope?.scene??null;}
      else{value=normalizeWeatherObservation(response?.data,new Date(now()));scene=null;}
      if(value)deadline=Math.max(now()+60000,Date.parse(value.fetched_at)+WEATHER_THEME_REFRESH_MS);
      onChange();
    }catch(error){
      if(current()){value=[401,403,409].includes(error?.status)?null:normalizeWeatherObservation(value,new Date(now()));scene=value?normalizeWeatherScene(scene,value,new Date(now())):null;onChange();}
    }finally{
      cancel(timeout);
      if(pending===request){pending=null;if(!stopped&&getOwner()?.key!==captured.key){syncOwner();void tick();}else arm();}
    }
  }
  const resume=()=>{void tick();};
  const suspend=()=>{clearTimer();};
  const listen=(target,name,fn)=>{target?.addEventListener?.(name,fn);events.push(()=>target?.removeEventListener?.(name,fn));};
  listen(documentTarget,'visibilitychange',resume);
  for(const name of['online','vidamia:auth-context','yuvomi:wall-mode-change'])listen(windowTarget,name,resume);
  listen(windowTarget,'offline',suspend);
  listen(windowTarget,'pagehide',()=>{parked=true;suspend();});
  listen(windowTarget,'pageshow',()=>{parked=false;resume();});
  listen(windowTarget,'auth:context-ending',stop);
  const unwatch=watchSession(resume);
  function stop(){if(stopped)return;stopped=true;generation++;pending?.controller.abort();if(pending)cancel(pending.timeout);pending=null;clearTimer();value=null;scene=null;for(const remove of events)remove();unwatch?.();}
  void tick();
  return{getValue(){if(stopped)return null;syncOwner();return normalizeWeatherObservation(value,new Date(now()));},getScene(){if(stopped)return null;syncOwner();const theme=normalizeWeatherObservation(value,new Date(now()));return theme?normalizeWeatherScene(scene,theme,new Date(now())):null;},refresh:resume,stop};
}
