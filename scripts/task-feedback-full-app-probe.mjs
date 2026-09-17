// Isolated full application QA. Real auth, CSS, routing, database, SSE and scheduler.
// Evidence distinguishes DOM/rAF from captured raster pixels; no claim of physical presentation.
import net from 'node:net';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFeedbackFixtures} from '../test/helpers/task-feedback-fixtures.mjs';
if(process.argv.includes('--help')) {
 console.log(`Opt-in isolated full-app feedback probe. Never point at production data.
APP_ROOT: application source/runtime directory (default current directory).
OUTPUT_DIR: evidence directory (required; a new synthetic DB is created here).
PHASE: evidence label. SOURCE_SHA: provenance label.
SURFACES: modal,card,kanban. CASES: required-first,required-middle,optional,required-final-recurring,supervised-helper,delegated-helper,reopen-step.
HOLD_MS: explicit before-network status transport hold (default 500, use 0 for native HTTP).
LIGHT=1: no screenshot/DevTools trace during timing; default captures raster+trace evidence.
FRAMES=1: additionally capture timestamped DevTools screencast raster frames (separate from light timing).
ROUNDS: samples per surface/case (default 1). PUPPETEER_EXECUTABLE_PATH: installed Chromium.
Run with a disposable, network-isolated runtime containing app dependencies.`);
 process.exit(0);
}
const phase=process.env.PHASE||'baseline',holdMs=Number(process.env.HOLD_MS||500);
const appRoot=resolve(process.env.APP_ROOT||process.cwd());
assert.ok(process.env.OUTPUT_DIR,'OUTPUT_DIR is required for isolated synthetic data');
const out=resolve(process.env.OUTPUT_DIR,phase);mkdirSync(out,{recursive:true});
process.chdir(out);
const appImport=relative=>import(pathToFileURL(resolve(appRoot,relative)));
process.env.DB_PATH=`${out}/synthetic-${Date.now()}.db`;delete process.env.DB_ENCRYPTION_KEY;
Object.assign(process.env,{SESSION_SECRET:'synthetic-full-app-feedback-followup',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',PORT:'0',LOG_LEVEL:'error'});
const {get}=await appImport('server/db.js');const d=get();
const {hashPassword}=await appImport('server/utils/password.js');
const {reconcileTaskSupervision,inspectTaskSupervision}=await appImport('server/services/task-supervision.js');
const {changeTaskStatus}=await appImport('server/services/task-lifecycle.js');
const {setTaskSkills}=await appImport('server/services/task-skills.js');
const {todayKey}=await appImport('server/utils/timezone.js');
const seed=createFeedbackFixtures(d,{reconcileTaskSupervision,inspectTaskSupervision,changeTaskStatus,setTaskSkills,todayKey});
const password='Synthetic-Feedback-Probe!';d.prepare('UPDATE users SET password_hash=?,onboarding_version=1').run(await hashPassword(password));
let ready;const originReady=new Promise(r=>ready=r),listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){if(args[0]==='0'){args[0]=0;args.splice(1,0,'127.0.0.1');this.once('listening',()=>ready(`http://127.0.0.1:${this.address().port}`));}return listen.apply(this,args);};
await appImport('server/index.js');const origin=await originReady;
const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
let client=60;const contexts=new Map(),results=[];
async function contextFor(actor){
 if(contexts.has(actor))return contexts.get(actor);const context=await browser.createBrowserContext(),page=await context.newPage();
 await page.setExtraHTTPHeaders({'X-Forwarded-For':`198.51.100.${++client}`});await page.goto(`${origin}/login`,{waitUntil:'domcontentloaded'});
 const username=d.prepare('SELECT username FROM users WHERE id=?').get(actor).username;
 const login=await page.evaluate(async({username,password})=>{const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});return{status:r.status,body:await r.json()};},{username,password});
 assert.equal(login.status,200,JSON.stringify(login.body));await page.close();contexts.set(actor,context);return context;
}
async function instrument(page){
 await page.evaluateOnNewDocument((holdMs)=>{
  window.probe={active:false,events:[]};const stamp=(name,extra={})=>{if(window.probe.active){const t=performance.now();window.probe.events.push({name,t,...extra});performance.mark(`probe:${name}`);}};
  window.probeStamp=stamp;
  const sel=()=>window.probe.selector,control=()=>document.querySelector(sel());
  function state(){const el=control();if(!el)return{missing:true};const path=el.querySelector('svg path'),css=getComputedStyle(el),svg=el.querySelector('svg'),svgcss=svg&&getComputedStyle(svg);return{pressed:el.getAttribute('aria-pressed'),busy:el.getAttribute('aria-busy'),status:el.dataset.status,done:el.classList.contains('detail-subtask__toggle--done')||el.classList.contains('subtask-item__checkbox--done'),disabled:el.disabled,path:path?.getAttribute('d')||'',svg:!!svg,opacity:css.opacity,visibility:css.visibility,display:css.display,color:css.color,svgStroke:svgcss?.stroke,svgOpacity:svgcss?.opacity,checkboxBackground:getComputedStyle(el,'::before').backgroundColor,transition:css.transition,animation:css.animation,rect:{x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}};}
  window.probeState=state;
  const oldAdd=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(name,cb,opts){if(name==='click'&&typeof cb==='function'&&this instanceof HTMLElement&&(this.classList.contains('detail-subtask__toggle')||this.id==='task-list')){const original=cb;cb=function(e){if(e.target.closest('.detail-subtask__toggle,[data-action="toggle-subtask"]'))stamp('handler_enter');const result=original.call(this,e);if(e.target.closest('.detail-subtask__toggle,[data-action="toggle-subtask"]'))stamp('handler_sync_end');return result;};}return oldAdd.call(this,name,cb,opts);};
  const oldSet=Map.prototype.set;Map.prototype.set=function(key,value){if(window.probe.active&&Number(key)===Number(window.probe.target)&&value?.status)stamp('pending_map_set',{status:value.status});return oldSet.call(this,key,value);};
  const oldAttr=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){const result=oldAttr.call(this,name,value);if(name==='d'&&this.tagName==='path'&&this.closest('.detail-subtask__toggle,[data-action="toggle-subtask"]')===control())stamp('check_path_mutation',{path:String(value)});return result;};
  const originalFetch=fetch;window.fetch=async(...args)=>{const path=String(args[0]),method=args[1]?.method||'GET';stamp('request_dispatch',{path,method});if(window.probe.active&&method==='PATCH'&&/\/status$/.test(path)&&holdMs){stamp('synthetic_transport_hold_begin');await new Promise(r=>setTimeout(r,holdMs));stamp('synthetic_transport_hold_end');}const r=await originalFetch(...args);stamp('response_headers',{path,method,status:r.status});const json=r.json.bind(r);r.json=async()=>{const data=await json();stamp('response_json',{path,method,status:r.status});return data;};return r;};
  const ES=EventSource;window.EventSource=class extends ES{constructor(...args){super(...args);for(const name of ['change','message'])this.addEventListener(name,e=>stamp('live_invalidation',{event:name,data:e.data}));}};
  for(const name of ['pointerdown','pointerup','click'])document.addEventListener(name,e=>{if(e.target.closest('.detail-subtask__toggle,[data-action="toggle-subtask"]')){stamp(name,{pointerType:e.pointerType});if(name==='click'){requestAnimationFrame(()=>{stamp('raf1',{state:state()});requestAnimationFrame(()=>stamp('raf2',{state:state()}));});}}},{capture:true});
  new PerformanceObserver(list=>{for(const e of list.getEntries())stamp('long_task',{start:e.startTime,duration:e.duration});}).observe({type:'longtask',buffered:true});
  let last='';new MutationObserver(records=>{if(!window.probe.active)return;for(const record of records){for(const n of record.removedNodes){if(n===window.probe.row||n.contains?.(window.probe.row))stamp('target_row_removed');if(n.nodeType===1&&(n.matches?.('.detail-task-subtasks')||n.querySelector?.('.detail-task-subtasks')))stamp('detail_list_replaced');}if(record.target.id==='task-list')stamp('surrounding_list_patch');}const current=state(),key=JSON.stringify(current);if(key!==last){last=key;stamp('dom_state',{state:current});requestAnimationFrame(()=>{stamp('mutation_raf1',{state:state()});requestAnimationFrame(()=>stamp('mutation_raf2',{state:state()}));});}}).observe(document,{subtree:true,attributes:true,childList:true});
 },holdMs);
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function open(f,surface){
 const context=await contextFor(f.actor),page=await context.newPage();await page.setViewport({width:1280,height:1000});await page.setExtraHTTPHeaders({'X-Forwarded-For':`198.51.100.${++client}`});
 await instrument(page);page.on('pageerror',error=>console.log('PAGEERROR',error.message));
 const detail=f.detail||d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(f.target).parent_task_id||f.root;
 const selector=surface==='modal'?`[data-subtask-id="${f.target}"] .detail-subtask__toggle`:`[data-action="toggle-subtask"][data-id="${f.target}"]`;
 await page.goto(`${origin}/tasks${surface==='modal'?`?open=${detail}`:`?view=${surface==='kanban'?'kanban':'list'}`}`,{waitUntil:'domcontentloaded'});
 if(surface!=='modal'){ await delay(2000);
  const expander=`[data-action="toggle-subtasks"][data-id="${detail}"]`;await page.waitForSelector(expander,{timeout:60000});
  if(await page.$eval(expander,el=>el.getAttribute('aria-expanded')!=='true'))await page.locator(expander).click();
 }
 await page.waitForSelector(selector,{visible:true,timeout:60000});await page.waitForFunction(sel=>!document.querySelector(sel).disabled,{timeout:15000},selector);await delay(1800);
 await page.$eval(selector,el=>el.scrollIntoView({block:'center',inline:'nearest'}));await delay(400);
 return {page,selector};
}
function summarize(events,wantedDone){
 const first=name=>events.find(e=>e.name===name),pointer=first('pointerdown')?.t,click=first('click')?.t;
 const matches=e=>e.t>=click&&e.state&&!e.state.missing&&e.state.done===wantedDone&&(wantedDone?!!e.state.path:!e.state.path);
 const raf1=events.find(e=>(e.name==='mutation_raf1'||e.name==='raf1')&&matches(e));
 const raf2=events.find(e=>(e.name==='mutation_raf2'||e.name==='raf2')&&matches(e));
 const json=events.find(e=>e.name==='response_json'&&e.method==='PATCH');
 return {pointerToHandler:first('handler_enter')?.t-pointer,pointerToRaf1CorrectPath:raf1?raf1.t-pointer:null,pointerToRaf2CorrectPath:raf2?raf2.t-pointer:null,dispatchToJson:json?.t-events.find(e=>e.name==='request_dispatch'&&e.method==='PATCH')?.t,HTTP:json?.status,rowRemovalCount:events.filter(e=>e.name==='target_row_removed').length,longTasks:events.filter(e=>e.name==='long_task').map(e=>({start:e.start,duration:e.duration}))};
}
try{
 const cases=(process.env.CASES||'required-first,required-middle,optional,required-final-recurring,supervised-helper,delegated-helper,reopen-step').split(',');
 const surfaces=(process.env.SURFACES||'modal,card').split(',');
 for(const surface of surfaces)for(const kind of cases)for(let round=0;round<Number(process.env.ROUNDS||1);round++){
  const f={...seed.fixture(kind),kind};
  const {page,selector}=await open(f,surface),name=`${surface}-${kind}-${round}`,prefix=`${out}/${name}`;
  const frames=[],frameAcks=new Set(),frameErrors=[];let cast,stoppingCast=false;
  if(process.env.FRAMES==='1'){
   cast=await page.createCDPSession();
   cast.on('Page.screencastFrame',frame=>{
    const file=`${prefix}-frame-${String(frames.length).padStart(3,'0')}.jpg`;
    writeFileSync(file,Buffer.from(frame.data,'base64'));
    frames.push({file,metadata:frame.metadata});
    const ack=cast.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(error=>{if(!stoppingCast)frameErrors.push(error.message);}).finally(()=>frameAcks.delete(ack));
    frameAcks.add(ack);
   });
   await cast.send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:1280,maxHeight:1000,everyNthFrame:1});await delay(100);
  }
  if(process.env.LIGHT!=='1')await page.screenshot({path:`${prefix}-before.png`,captureBeyondViewport:false});
  if(process.env.LIGHT!=='1')await page.tracing.start({path:`${prefix}-trace.json`,screenshots:true,categories:['devtools.timeline','blink.user_timing','disabled-by-default-devtools.timeline','disabled-by-default-devtools.screenshot','toplevel']});
  await page.evaluate(({target,selector})=>{window.probe={active:true,target,selector,events:[],row:document.querySelector(selector).closest('[data-subtask-id]'),timeOrigin:performance.timeOrigin};window.probeStamp('baseline',{state:window.probeState()});},{target:f.target,selector});
  await page.locator(selector).click();await delay(70);
  const shotBegin=await page.evaluate(()=>{window.probeStamp('held_screenshot_begin');return performance.now();});
  if(process.env.LIGHT!=='1')await page.screenshot({path:`${prefix}-held.png`,captureBeyondViewport:false});
  const held=await page.evaluate(()=>{window.probeStamp('held_screenshot_end');return{t:performance.now(),state:window.probeState()};});
  try {
   await page.waitForFunction(()=>window.probe.events.some(e=>e.name==='response_json'&&e.method==='PATCH'),{timeout:20000});
   await page.waitForFunction(({done,root,surface})=>{
    const state=window.probeState();
    return (!state.missing&&state.done===done&&(done?!!state.path:!state.path))
      ||(surface!=='modal'&&!document.querySelector(`[data-task-id="${root}"]`));
   },{timeout:20000},{done:f.status==='done',root:f.root,surface});
  } catch(error) { writeFileSync(prefix+'-failure.json',JSON.stringify(await page.evaluate(()=>({events:window.probe.events,html:document.body.innerHTML,state:window.probeState()})),null,2));await page.screenshot({path:prefix+'-failure.png'});if(process.env.LIGHT!=='1')await page.tracing.stop();throw error;} await delay(200);
  if(process.env.LIGHT!=='1'){await page.screenshot({path:`${prefix}-settled.png`,captureBeyondViewport:false});await page.screenshot({path:`${prefix}-full.png`});}
  const evidence=await page.evaluate(()=>({timeOrigin:window.probe.timeOrigin,events:window.probe.events,rowRetained:document.querySelector(window.probe.selector)?.closest('[data-subtask-id]')===window.probe.row,final:window.probeState()}));
  if(cast){stoppingCast=true;await cast.send('Page.stopScreencast');await Promise.all([...frameAcks]);await cast.detach();assert.deepEqual(frameErrors,[],'Unexpected raster capture protocol failure');}
  if(process.env.LIGHT!=='1')await page.tracing.stop();const trace=process.env.LIGHT==='1'?{traceEvents:[]}:JSON.parse(readFileSync(`${prefix}-trace.json`,'utf8'));
  const events=trace.traceEvents||[],costs=Object.fromEntries(['UpdateLayoutTree','Layout','Paint','CompositeLayers','RasterTask'].map(name=>[name,{count:events.filter(e=>e.name===name&&e.ph==='X').length,totalMs:events.filter(e=>e.name===name&&e.ph==='X').reduce((s,e)=>s+e.dur/1000,0)}]));
  const canonical={targetStatus:d.prepare('SELECT status FROM tasks WHERE id=?').get(f.target).status,parentStatus:d.prepare('SELECT status FROM tasks WHERE id=?').get(f.root).status,parentEarns:d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(f.root).n,successors:d.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(f.root).n};
  assert.equal(canonical.targetStatus,f.status);
  if(kind==='required-final-recurring'){assert.equal(canonical.parentStatus,'done');assert.equal(canonical.parentEarns,1);assert.equal(canonical.successors,1);}
  const pointerWall=evidence.timeOrigin+evidence.events.find(event=>event.name==='pointerdown').t;
  const result={phase,surface,kind,round,fixture:{root:f.root,target:f.target,actor:f.actor,required:9,optional:1,points:2,recurrence:'weekly weekdays',expiration:'expire_incomplete'},holdMs,summary:summarize(evidence.events,f.status==='done'),canonical,heldObservation:{begin:shotBegin,end:held.t,state:held.state,screenshotCaptured:process.env.LIGHT!=='1'},frames:frames.map(frame=>({...frame,pointerDeltaMs:frame.metadata.timestamp*1000-pointerWall})),traceCosts:costs,...evidence};
  results.push(result);writeFileSync(`${prefix}.json`,JSON.stringify(result,null,2));writeFileSync(`${out}/results.json`,JSON.stringify({phase,source:process.env.SOURCE_SHA||'working-tree',note:`rAF occurs before paint; captured raster evidence is not physical display measurement. ${holdMs?`Status transport deliberately held ${holdMs}ms before network send.`:'No artificial transport delay; local test server HTTP timing.'} Native HTTP+SSE otherwise unchanged.`,results},null,2));
  console.log(JSON.stringify({surface,kind,...result.summary,heldCheckPath:held.state.path,heldDone:held.state.done,traceCosts:costs}));assert.equal(result.summary.HTTP,200);await page.close();
 }
}catch(error){console.error(error);process.exitCode=1;}finally{await browser.close();d.close();}process.exit(process.exitCode||0);
