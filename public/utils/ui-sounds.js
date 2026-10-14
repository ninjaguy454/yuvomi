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
let context=null,voice=null;
function unlock(){const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)throw new Error('Audio unavailable');context??=new Audio();if(context.state==='suspended')void context.resume().catch(()=>{});}
function emit(recipe,volume){unlock();voice?.();const ctx=context,osc=ctx.createOscillator(),gain=ctx.createGain(),now=ctx.currentTime;osc.type=recipe.wave;osc.frequency.value=recipe.frequency;gain.gain.setValueAtTime(.00001,now);gain.gain.exponentialRampToValueAtTime(Math.max(.00001,volume*recipe.gain),now+.003);gain.gain.exponentialRampToValueAtTime(.00001,now+recipe.decay);osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+recipe.decay+.01);let stopped=false;const stop=()=>{if(stopped)return;stopped=true;try{osc.stop();}catch{}osc.disconnect();gain.disconnect();};osc.onended=stop;voice=stop;return stop;}
const engine=createUiSoundEngine({emit,unlock});
const previews=createUiSoundEngine({emit,unlock});
export function configureUiSounds(config,theme){voice?.();previews.interrupt();engine.configure(config,theme);}
export function currentUiSounds(){return engine.configuration();}
export function playUiSound(kind,event){return engine.play(kind,event);}
export function captureCompletionSound(event){return engine.capture(event);}
export function confirmCompletionSound(ticket,success){return engine.confirm(ticket,success);}
export function previewUiSound(config,event,theme){previews.configure(config,theme);return previews.play('select',event);}
export function resetUiSounds(){engine.reset();previews.reset();voice?.();if(context){void context.close().catch(()=>{});context=null;}}
if(typeof window!=='undefined'&&window.addEventListener){
  window.addEventListener('auth:context-ending',resetUiSounds);
  window.addEventListener('blur',()=>{engine.interrupt();previews.interrupt();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){engine.interrupt();previews.interrupt();}});
  window.addEventListener('named-appearance-changed',event=>configureUiSounds(engine.configuration(),event.detail?.theme));
}
