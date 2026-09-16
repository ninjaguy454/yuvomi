import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/router.js',import.meta.url),'utf8');
const forget=source.slice(source.indexOf('function forgetSessionState()'),source.indexOf('let sessionReloading = false;'));
const boundary=source.slice(source.indexOf('function enforceWallPrivacyBoundary()'),source.indexOf('function refreshAfterSessionChange()'));
const listeners=source.slice(source.indexOf("window.addEventListener('yuvomi:wall-lock'"),source.indexOf("window.addEventListener('pageshow', (event)"));

function harness({startedInWall=false,navigating=false,offline=false}={}) {
  const calls=[],events={},state={enabled:startedInWall,modal:true,privateContent:true,disposals:0,reloads:0};
  const noOp=()=>{};
  const document={documentElement:{style:{}},getElementById:()=>({replaceChildren(){state.privateContent=false;calls.push('clear-content');}})};
  const context=vm.createContext({
    currentUser:{id:1},_preferencesLoaded:true,_hiddenModules:new Set(),_moduleOrder:[],_mobileNavOrder:[],
    _renderedModule:{},_renderedModuleName:'tasks',_renderedDispose(){state.disposals++;},
    _wallOnlyDocument:startedInWall,_wallPrivacyTransitioning:false,isNavigating:navigating,
    clearApiCache(){calls.push('clear-api-cache');},forgetLayoutHint:noOp,forgetScrollPositions:noOp,
    resetModuleCounts:noOp,resetNavBadges:noOp,stopThirdPartyModulePolling:noOp,stopReminders:noOp,stopPush:noOp,resetAppearancePreferences:noOp,
    closeAllOverlays(){state.modal=false;calls.push('close-modal');},
    isWallModeEnabled:()=>state.enabled,document,navigator:{onLine:!offline},
    window:{addEventListener(type,fn){events[type]=fn;},location:{replace(path){assert.equal(path,'/');assert.equal(document.documentElement.style.visibility,'hidden');assert.equal(state.modal,false);state.reloads++;calls.push('reload');}}},
  });
  vm.runInContext(forget+boundary+listeners,context);
  return {state,calls,document,events,context,enter(){state.enabled=true;events['storage']({key:'yuvomi-wall-mode',newValue:'1'});}};
}

test('entering Wall closes an existing private modal and disposes/clears its personal view before replacement',()=>{
  const env=harness();env.enter();
  assert.equal(env.state.modal,false);assert.equal(env.state.privateContent,false);
  assert.equal(env.state.disposals,1);assert.equal(env.state.reloads,1);
  assert.ok(env.calls.indexOf('close-modal')<env.calls.indexOf('reload'));
  assert.ok(env.calls.indexOf('clear-api-cache')<env.calls.indexOf('reload'));
});

test('Wall entry interrupts an in-flight navigation and late private callbacks remain invisible',()=>{
  const env=harness({navigating:true});env.enter();
  assert.equal(env.state.reloads,1,'an in-flight navigate must not drop the privacy transition');
  // An old module may still finish before document replacement. Its private
  // overlay/content cannot flash because the old document is hidden first.
  env.state.modal=true;env.state.privateContent=true;
  assert.equal(env.document.documentElement.style.visibility,'hidden');
  env.events['yuvomi:wall-lock']();assert.equal(env.state.reloads,1);
});

test('a document that booted in Wall keeps its live view and dialogs through repeated lock events',()=>{
  const env=harness({startedInWall:true});
  env.events['yuvomi:wall-lock']();env.events['yuvomi:wall-mode-change']({detail:{enabled:true}});
  env.events.storage({key:'yuvomi-wall-mode',newValue:'1'});
  assert.equal(env.state.reloads,0);assert.equal(env.state.disposals,0);
  assert.equal(env.document.documentElement.style.visibility,undefined);
});

test('offline entry uses the persisted Wall route and does not retain personal content',()=>{
  const env=harness({navigating:true,offline:true});env.enter();
  assert.equal(env.state.enabled,true);assert.equal(env.state.reloads,1);assert.equal(env.state.privateContent,false);
  const resumed=harness({startedInWall:true,offline:true});resumed.events['yuvomi:wall-lock']();
  assert.equal(resumed.state.reloads,0,'an offline Wall shell must not reload in a loop');
});

test('leaving Wall then entering again establishes a new privacy boundary',()=>{
  const env=harness({startedInWall:true});env.state.enabled=false;
  env.events.storage({key:'yuvomi-wall-mode',newValue:null});env.enter();
  assert.equal(env.state.reloads,1);
});
