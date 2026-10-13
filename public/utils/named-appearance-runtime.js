import { NAMED_THEMES, normalizeNamedAppearance, resolveNamedAppearance, namedThemeVariables } from './named-appearance.js';
export const NAMED_APPEARANCE_CACHE='vidamia-named-appearance';
let config=null,resolved=null,timer=null,previousTheme=null,previousMetas=[],variables=[],listeners=false;
const storage=()=>{try{return localStorage;}catch{return null;}};
function cacheEligible(){try{return localStorage.getItem('vidamia-paired-device')!=='1'&&document.documentElement.getAttribute('data-wall-mode')==null;}catch{return false;}}
function paint(now){
  const next=resolveNamedAppearance(config,now);if(!next)return null;const root=document.documentElement,t=next.theme;
  if(resolved?.theme.id===t.id&&root.getAttribute('data-named-theme')===t.id){resolved=next;return next;}
  resolved=next;root.setAttribute('data-named-theme',t.id);root.setAttribute('data-named-material',t.motif);root.setAttribute('data-theme',t.kind);root.style?.setProperty('color-scheme',t.kind);
  const values=namedThemeVariables(t);variables=Object.keys(values);for(const [key,value]of Object.entries(values))root.style?.setProperty(key,value);
  for(const meta of document.querySelectorAll?.('meta[name="theme-color"]')||[])meta.setAttribute('content',t.canvas);
  window.dispatchEvent(new CustomEvent('named-appearance-changed',{detail:{theme:t.id,reason:next.reason}}));return next;
}
export function refreshNamedAppearance(now=new Date()){return config?paint(now):null;}
export function currentNamedTheme(){return resolved?.theme??null;}
export function currentCardTheme(){const mode=document.documentElement.getAttribute('data-theme');return currentNamedTheme()||NAMED_THEMES.find(t=>t.id===(mode==='dark'||mode==null&&globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches?'graphite':'neutral'));}
export function currentNamedAppearance(){return config?structuredClone(config):null;}
export function clearNamedAppearance({removeCache=true}={}){
  if(timer!==null)clearInterval(timer);timer=null;const root=document.documentElement;
  const prepaint=root.getAttribute?.('data-named-legacy-theme');
  if(prepaint!=null){previousTheme=prepaint==='system'?null:prepaint;variables=Object.keys(namedThemeVariables(NAMED_THEMES.find(t=>t.id===root.getAttribute('data-named-theme'))||NAMED_THEMES[0]));previousMetas=[...(document.querySelectorAll?.('meta[name="theme-color"]')||[])].map(m=>[m,m.getAttribute('data-named-legacy-color')??m.getAttribute('content')]);}
  if(config||prepaint!=null){if(previousTheme==null)root.removeAttribute('data-theme');else root.setAttribute('data-theme',previousTheme);for(const [meta,value]of previousMetas){meta.setAttribute('content',value);meta.removeAttribute('data-named-legacy-color');}}
  root.removeAttribute('data-named-legacy-theme');
  root.removeAttribute('data-named-theme');root.removeAttribute('data-named-material');for(const key of variables)root.style?.removeProperty(key);root.style?.removeProperty('color-scheme');
  config=null;resolved=null;previousMetas=[];variables=[];previousTheme=null;
  if(removeCache)try{storage()?.removeItem(NAMED_APPEARANCE_CACHE);}catch{}
}
export function applyNamedAppearance(value,{persist=true,now=new Date()}={}){
  const valid=normalizeNamedAppearance(value);if(!valid){clearNamedAppearance();return null;}
  if(!config){const root=document.documentElement,legacy=root.getAttribute('data-named-legacy-theme');previousTheme=legacy==='system'?null:legacy??root.getAttribute('data-theme')??null;root.removeAttribute('data-named-legacy-theme');previousMetas=[...(document.querySelectorAll?.('meta[name="theme-color"]')||[])].map(m=>{const color=m.getAttribute('data-named-legacy-color')??m.getAttribute('content');m.removeAttribute('data-named-legacy-color');return[m,color];});}
  config=valid;const result=paint(now);
  if(persist&&cacheEligible())try{storage()?.setItem(NAMED_APPEARANCE_CACHE,JSON.stringify(valid));}catch{}
  else if(!cacheEligible())try{storage()?.removeItem(NAMED_APPEARANCE_CACHE);}catch{}
  if(timer!==null)clearInterval(timer);timer=setInterval(()=>{if(document.visibilityState!=='hidden')refreshNamedAppearance();},60000);timer.unref?.();
  if(!listeners){listeners=true;document.addEventListener?.('visibilitychange',()=>{if(document.visibilityState!=='hidden')refreshNamedAppearance();});window.addEventListener?.('auth:context-ending',()=>clearNamedAppearance());}
  return result;
}
