import {normalizeUiSounds,NAMED_THEMES} from './named-appearance.js';
const RECIPES=Object.freeze({soft:{pack:'soft',wave:'sine',frequency:330,decay:.065,gain:.18},glass:{pack:'glass',wave:'sine',frequency:880,decay:.14,gain:.12},wood:{pack:'wood',wave:'triangle',frequency:190,decay:.055,gain:.12},playful:{pack:'playful',wave:'sine',frequency:520,decay:.095,gain:.15}});
export function createUiSoundEngine({clock=()=>performance.now(),isForeground=()=>document.visibilityState!=='hidden'&&document.hasFocus(),emit,unlock=()=>{}}={}){
  let config=normalizeUiSounds(null),theme=null,last=-Infinity,voice=null,epoch=0;const tickets=new WeakSet();
  function stop(){try{voice?.();}catch{}voice=null;}
  function configure(value,id){stop();epoch++;config=normalizeUiSounds(value);theme=typeof id==='object'?id?.id:id;}
  function eligible(event){return event?.isTrusted===true&&isForeground()&&config.mode!=='off'&&config.volume>0&&(config.mode!=='theme'||NAMED_THEMES.find(t=>t.id===theme)?.sound!=='off');}
  function play(kind,event){if(!['select','open','close','complete'].includes(kind)||!eligible(event)||clock()-last<75)return false;last=clock();stop();const pack=config.mode==='theme'?(NAMED_THEMES.find(t=>t.id===theme)?.sound||'soft'):config.pack;try{unlock();voice=emit?.({...RECIPES[pack],frequency:RECIPES[pack].frequency*(kind==='complete'?1.2:kind==='close'?.9:1)},Math.min(.075,config.volume/100*.45));return true;}catch{return false;}}
  function capture(event){if(!eligible(event))return null;try{unlock();}catch{}const ticket={epoch};tickets.add(ticket);return ticket;}
  function confirm(ticket,success){if(!ticket||!tickets.has(ticket))return false;tickets.delete(ticket);return success===true&&ticket.epoch===epoch&&play('complete',{isTrusted:true});}
  return{configure,play,capture,confirm,stop,interrupt(){stop();epoch++;},configuration:()=>({...config}),reset(){configure(null,null);}};
}
let context=null,voice=null,trustedContext=false,soundTheme=null;
let weatherOptIn=false,weatherTimer=null,weatherVoice=null,weatherGeneration=0,lastWeatherId=null;
const foreground=()=>typeof document!=='undefined'&&document.visibilityState!=='hidden'&&document.hasFocus();
function unlock(){
  const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)throw new Error('Audio unavailable');
  if(!context||context.state==='closed'){
    context=new Audio();const owned=context;
    owned.addEventListener?.('statechange',()=>{if(context===owned&&owned.state!=='running'){cancelWeatherThunder({resetOptIn:owned.state==='closed'});if(owned.state==='closed')trustedContext=false;}});
  }
  trustedContext=true;if(context.state==='suspended'){const owned=context,generation=weatherGeneration;void owned.resume().catch(()=>{if(context===owned&&generation===weatherGeneration)cancelWeatherThunder();});}
}
function emit(recipe,volume){unlock();voice?.();const ctx=context,osc=ctx.createOscillator(),gain=ctx.createGain(),now=ctx.currentTime;osc.type=recipe.wave;osc.frequency.value=recipe.frequency;gain.gain.setValueAtTime(.00001,now);gain.gain.exponentialRampToValueAtTime(Math.max(.00001,volume*recipe.gain),now+.003);gain.gain.exponentialRampToValueAtTime(.00001,now+recipe.decay);osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+recipe.decay+.01);let stopped=false;const stop=()=>{if(stopped)return;stopped=true;try{osc.stop();}catch{}osc.disconnect();gain.disconnect();};osc.onended=stop;voice=stop;return stop;}
const engine=createUiSoundEngine({emit,unlock});
const previews=createUiSoundEngine({emit,unlock});
export function configureUiSounds(config,theme){cancelWeatherThunder();soundTheme=typeof theme==='object'?theme?.id:theme;voice?.();previews.interrupt();engine.configure(config,theme);}
export function currentUiSounds(){return engine.configuration();}
export function playUiSound(kind,event){return engine.play(kind,event);}
export function captureCompletionSound(event){return engine.capture(event);}
export function confirmCompletionSound(ticket,success){return engine.confirm(ticket,success);}
export function previewUiSound(config,event,theme){previews.configure(config,theme);return previews.play('select',event);}
// Consent belongs to the current appearance owner, never the persisted v1 config.
export function weatherThunderEnabled(){return weatherOptIn;}
export function cancelWeatherThunder({resetOptIn=false}={}){
  weatherGeneration++;if(weatherTimer!==null)clearTimeout(weatherTimer);weatherTimer=null;
  try{weatherVoice?.();}catch{}weatherVoice=null;
  if(resetOptIn){weatherOptIn=false;lastWeatherId=null;}
}
export function setWeatherThunderOptIn(value,event){
  cancelWeatherThunder();
  if(value!==true){weatherOptIn=false;return false;}
  if(event?.isTrusted!==true||!foreground())return false;
  try{unlock();weatherOptIn=true;return true;}catch{weatherOptIn=false;return false;}
}
function weatherEligible(){
  const config=engine.configuration();
  return weatherOptIn&&foreground()&&config.mode!=='off'&&config.volume>0&&(config.mode!=='theme'||NAMED_THEMES.find(t=>t.id===soundTheme)?.sound!=='off')&&trustedContext&&context?.state==='running';
}
function emitWeatherRumble(volume){
  const ctx=context,duration=2.2;let source=null,filter=null,gain=null,stopped=false;
  const stop=()=>{
    if(stopped)return;stopped=true;
    try{source?.stop();}catch{}
    for(const node of[source,filter,gain])try{node?.disconnect();}catch{}
    if(voice===stop)voice=null;if(weatherVoice===stop)weatherVoice=null;
  };
  try{
    const buffer=ctx.createBuffer(1,Math.floor(ctx.sampleRate*duration),ctx.sampleRate),data=buffer.getChannelData(0);let low=0,sum=0;
    for(let i=0;i<data.length;i++){low=low*.985+(Math.random()*2-1)*.015;data[i]=low;sum+=low*low;}
    const normalizer=.28/Math.max(.001,Math.sqrt(sum/data.length));
    for(let i=0;i<data.length;i++){const t=i/ctx.sampleRate,envelope=Math.min(1,t/.09)*Math.pow(Math.max(0,1-t/duration),1.15);data[i]=Math.max(-.8,Math.min(.8,data[i]*normalizer))*envelope;}
    source=ctx.createBufferSource();filter=ctx.createBiquadFilter();gain=ctx.createGain();source.buffer=buffer;filter.type='lowpass';filter.frequency.value=280;filter.Q.value=.3;
    gain.gain.value=Math.min(.025,volume/100*.1);source.connect(filter);filter.connect(gain);gain.connect(ctx.destination);source.onended=stop;
    voice?.();voice=weatherVoice=stop;source.start();
  }catch{stop();}
}
export function queueWeatherThunder({id,delayMs,isCurrent=()=>true}={}){
  const stillCurrent=()=>{try{return typeof isCurrent==='function'&&isCurrent()===true;}catch{return false;}};
  if(!weatherEligible()||!(typeof id==='string'&&id.length>0&&id.length<=128||typeof id==='number'&&Number.isFinite(id))||!Number.isFinite(delayMs)||id===lastWeatherId||!stillCurrent())return false;
  cancelWeatherThunder();lastWeatherId=id;const generation=weatherGeneration;
  weatherTimer=setTimeout(()=>{
    if(generation!==weatherGeneration||id!==lastWeatherId)return;
    weatherTimer=null;if(weatherEligible()&&stillCurrent())emitWeatherRumble(engine.configuration().volume);
  },Math.min(4000,Math.max(0,delayMs)));return true;
}
export function resetUiSounds(){cancelWeatherThunder({resetOptIn:true});engine.reset();previews.reset();voice?.();voice=null;trustedContext=false;soundTheme=null;if(context){const owned=context;context=null;try{void owned.close().catch(()=>{});}catch{}}}
if(typeof window!=='undefined'&&window.addEventListener){
  window.addEventListener('auth:context-ending',resetUiSounds);
  window.addEventListener('blur',()=>{cancelWeatherThunder();engine.interrupt();previews.interrupt();});
  window.addEventListener('pagehide',resetUiSounds);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){cancelWeatherThunder();engine.interrupt();previews.interrupt();}});
  window.addEventListener('named-appearance-changed',event=>configureUiSounds(engine.configuration(),event.detail?.theme));
}
