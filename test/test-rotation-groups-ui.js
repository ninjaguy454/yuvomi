import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Real resource, modal, API, SortableJS and EventSource modules; isolated HTTP data.
const members=Array.from({length:15},(_,index)=>({id:index+1,membership_id:index+101,
  display_name:['Grace','Eleanor','Frankie','Duane','Alexis','Sage'][index]||`Member ${index+1}`}));
const styles=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag])=>tag).join('');
const app=express();app.use(express.json());
let groups,track,history,corrections,requests,version,server,browser,base,listRequests,listDelay=0,listFails=false,mutationDelay=0;
const streams=new Set();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clone=value=>structuredClone(value);
function reset(){
 groups=[{id:7,name:'Kids',description:'Baseline order',active:1,revision:3,members:clone(members.slice(0,3))}];
 track={id:11,label:'Shower Order',display_label:'Get Ready for Bed · Shower Order',consumer_label:'Get Ready for Bed',consumer_status:'active',purpose_key:'shower_order',strategy:'rotating_order',revision:5,
  advance_count:2,next_membership_id:101,next:{members:clone(members.slice(0,3)),order:clone(members.slice(0,3))},
  previews:[{order:clone(members.slice(0,3))},{order:clone([members[1],members[2],members[0]])},{order:clone([members[2],members[0],members[1]])}]};
 history=[{id:21,track_id:11,strategy:'rotating_order',revision:4,status:'resolved',context:{label:'Tonight'},
  resolved_at:'2026-09-19T19:00:00Z',order:clone(members.slice(0,3)),original_order:clone(members.slice(0,3)),
  eligible:clone(members.slice(0,3)),member_ids:[1,2,3],skipped:[{...members[5],reason:'Outside this Group'}],
  config:{advance_policy:'per_occurrence',override_affects_next:true},advanced:false,advance_reason:'awaiting_finalization'}];
 corrections=[];requests=[];version=1;listRequests=0;listDelay=0;listFails=false;mutationDelay=0;
}
function broadcast(){version++;for(const stream of streams)stream.write(`event: change\ndata: ${JSON.stringify({version})}\n\n`);}
function updateOrder(occ,ids){occ.order=ids.map(id=>clone(members.find(m=>m.id===id)));occ.member_ids=ids;}
app.use('/api/v1',async(req,res)=>{
 const path=req.path;
 if(path==='/preferences')return res.json({data:{language:'en',date_format:'mdy'}});
 if(path==='/automation/rotation-changes'){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
  streams.add(res);res.write(`event: change\ndata: ${JSON.stringify({version})}\n\n`);req.on('close',()=>streams.delete(res));return;
 }
 if(path==='/automation/rotation-members')return res.json({data:members});
 if(path==='/automation/rotation-groups'&&req.method==='GET'){
  listRequests++;const snapshot=clone(groups);if(listDelay)await wait(listDelay);if(listFails)return res.status(503).json({error:'Connection temporarily unavailable.'});return res.json({data:snapshot});
 }
 if(path==='/automation/rotation-groups'&&req.method==='POST'){
  requests.push({path,body:req.body});const group={...req.body,id:8,active:req.body.active?1:0,revision:1,members:req.body.member_ids.map(id=>clone(members.find(m=>m.id===id)))};
  groups.push(group);broadcast();return res.status(201).json({data:group});
 }
 if(path==='/automation/rotation-groups/7/usage-preview'){
  requests.push({path,body:req.body});return res.json({data:{confirmation_token:'preview-revision-3',effective_date:req.body.shared_config?.effective_date||'2026-09-20',
   proposed_order:clone([members[2],members[0],members[1]]),consumers:[{consumer_type:'task_series',consumer_id:'42',purpose_key:'shower_order',display_label:'Bedtime · Shower Order',current_order:clone(members.slice(0,3))}],exceptions:[{reason:'A completed occurrence keeps its historical snapshot.'}]}});
 }
 if(path.match(/^\/automation\/rotation-groups\/\d+$/)){
  const group=groups.find(g=>g.id===Number(path.split('/').at(-1)));
  if(req.method==='PUT'){
   requests.push({path,body:req.body});
   if(req.body.expected_revision!==group.revision)return res.status(409).json({error:'This Group changed elsewhere. Reload before saving.'});
   Object.assign(group,req.body,{revision:group.revision+1,active:req.body.active?1:0,members:req.body.member_ids.map(id=>clone(members.find(m=>m.id===id)))});
   broadcast();
  }
  return res.json({data:{...group,tracks:group.id===7?[track]:[]}});
 }
 if(path==='/automation/rotation-tracks/11')return res.json({data:track});
 if(path==='/automation/rotation-tracks/11/history')return res.json({data:history,events:corrections});
 if(path==='/automation/rotation-tracks/11/correct'){
  requests.push({path,body:req.body});if(req.body.expected_revision!==track.revision)return res.status(409).json({error:'Track changed elsewhere.'});
  const previous=members.find(m=>m.membership_id===track.next_membership_id),next=members.find(m=>m.id===req.body.next_member_id);
  corrections.push({id:31,event_type:'track_corrected',actor_user_id:4,actor_name:'Duane',created_at:'2026-09-19T20:15:00Z',details:{previous_next_member_name:previous.display_name,next_member_name:next.display_name,next_member_id:next.id,reason:req.body.reason}});
  track.next_membership_id=next.membership_id;track.revision++;
  track.next.order=[...members.slice(req.body.next_member_id-1,3),...members.slice(0,req.body.next_member_id-1)];
  track.previews[0].order=clone(track.next.order);broadcast();return res.json({data:track});
 }
 const match=path.match(/^\/automation\/rotation-occurrences\/(\d+)\/(override|finalize|skip|recheck)$/);
 if(match){
  const occ=history.find(o=>o.id===Number(match[1]));requests.push({path,body:req.body});
  if(mutationDelay)await wait(mutationDelay);
  if(req.body.expected_revision!==occ.revision)return res.status(409).json({error:'This occurrence changed elsewhere. Reload before saving.'});
  if(match[2]==='override'){updateOrder(occ,req.body.member_ids);occ.overridden_at='2026-09-19T19:05:00Z';}
  if(match[2]==='skip')occ.status='skipped';
  if(match[2]==='finalize'){occ.status=req.body.outcome||'finalized';occ.advanced=true;track.advance_count++;}
  if(match[2]==='recheck'){occ.eligible=clone(members.slice(0,3));updateOrder(occ,[1,2,3]);}
  occ.revision++;broadcast();return res.json({data:occ});
 }
 return res.status(404).json({error:`Unexpected fixture request ${path}`});
});
app.get('/rotation-groups-fixture.js',(_req,res)=>res.type('text/javascript').send(`
 import { initI18n,setLocale } from '/i18n.js';
 import { setPermissions } from '/permissions.js';
 import { renderRotationGroups } from '/components/rotation-groups.js';
 import { renderRotationBindings,bindRotationBindings } from '/components/rotation-bindings.js';
 import { variableReferenceOptions } from '/components/variable-expression-editor.js';
 await initI18n();await setLocale('en');setPermissions({admin:true});
 window.yuvomi={user:{id:1,role:'admin'},navigate(){},showToast(){},isModuleDisabled(){return false;}};
 window.fixture={renderRotationGroups,setPermissions,variableReferenceOptions,async renderBindings(value,options={}){const body=document.querySelector('#fixture');body.rotationDispose?.();body.innerHTML=renderRotationBindings(value,options);window.bindingEditor=bindRotationBindings(body,options);await window.bindingEditor.ready;}};window.unhandled=[];
 window.addEventListener('unhandledrejection',event=>window.unhandled.push(String(event.reason)));
 await renderRotationGroups(document.querySelector('#fixture'));window.fixtureReady=true;
`));
app.get('/rotation-groups-fixture',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<script src="/lucide.min.js"></script></head><body><main id="main-content"><div id="fixture"></div></main><div id="fab-layer"></div><script type="module" src="/rotation-groups-fixture.js"></script></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
test.before(async()=>{
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--no-sandbox']});
 mkdirSync(new URL('../.qa/rotation-groups-20260919/',import.meta.url),{recursive:true});
});
test.after(async()=>{await browser?.close();for(const stream of streams)stream.end();await new Promise(resolve=>server?.close(resolve)||resolve());});
async function pageTest(fn,{width=1440,height=900,setup}={}){
 reset();setup?.();const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.setViewport({width,height,isMobile:width<768,hasTouch:width<768});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`${base}/rotation-groups-fixture`);await page.waitForFunction(()=>window.fixtureReady);while(listRequests<2)await wait(10);
  await fn(page);assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.unhandled),[]);
 }finally{await page.close();}
}
const active='#shared-modal-overlay';
const form='[data-rotation-group-form]';
const list='[data-rotation-member-list]';
const submit=`${active} [type=submit]`;
async function openGroup(page){await page.click('[data-rotation-open="7"]');await page.waitForSelector('[data-rotation-group-detail]');}
async function editGroup(page){await openGroup(page);await page.click('[data-rotation-edit]');await page.waitForSelector(form);}
async function openHistory(page){await openGroup(page);await page.click('[data-rotation-history="11"]');await page.waitForSelector('[data-rotation-track-detail]');}
async function order(page){return page.$$eval(`${active} ${list} [data-rotation-member]`,rows=>rows.map(row=>Number(row.dataset.rotationMember)));}
async function fill(page,selector,value){await page.$eval(selector,(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},value);}
// The shared toggle pattern deliberately clips its native checkbox. Exercise
// the visible control rather than Puppeteer's click on a hidden 1 px input.
async function clickSwitch(page,name){
 const selector=`${active} [name="${name}"]`;
 const track=await page.$eval(selector,input=>{
  const label=input.labels?.[0],track=label?.querySelector('.toggle__track');
  if(!track)return null;track.scrollIntoView({block:'center'});
  return true;
 });
 assert.ok(track,`${name} must expose the established visible toggle control`);
 const input=await page.$(selector),label=await input.evaluateHandle(el=>el.labels[0]);
 const control=await label.$('.toggle__track');await control.click();
 await control.dispose();await label.dispose();await input.dispose();
}
async function assertSwitchVisible(page,name){
 const result=await page.$eval(`${active} [name="${name}"]`,input=>{
  const label=input.labels?.[0],track=label?.querySelector('.toggle__track');
  if(!track)return null;
  const rect=track.getBoundingClientRect(),style=getComputedStyle(track);
  return{width:rect.width,height:rect.height,display:style.display,visibility:style.visibility,opacity:style.opacity,label:label.innerText.trim(),checked:input.checked};
 });
 assert.ok(result,`${name} has a labeled visible track`);
 assert.ok(result.width>=28&&result.height>=16,`${name} track has usable dimensions`);
 assert.notEqual(result.display,'none');assert.notEqual(result.visibility,'hidden');assert.notEqual(result.opacity,'0');assert.ok(result.label);
 return result.checked;
}
async function assertFitsViewport(page,scope='#fixture'){
 const sizes=await page.$eval(scope,el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth}));
 assert.ok(sizes.scrollWidth<=sizes.width+2,`${scope} must not scroll horizontally: ${JSON.stringify(sizes)}`);
 assert.ok(sizes.documentWidth<=sizes.viewport+2,`page must not scroll horizontally: ${JSON.stringify(sizes)}`);
}
async function assertFooterReachable(page){
 await page.$eval(`${active} .modal-panel__body`,el=>{el.scrollTop=0;});
 const rect=await page.$eval(submit,el=>{const r=el.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight};});
 assert.ok(rect.top>=0&&rect.bottom<=rect.viewport+1&&rect.height>=32,'save action stays visible while the long form scrolls');
}
async function drag(page,fromId,toId,touch=false){
 const first=`${active} [data-rotation-member="${fromId}"] .rotation-member-handle`,last=`${active} [data-rotation-member="${toId}"]`;
 // Settle initial focus and the modal's existing 300 ms keyboard-scroll timer
 // before positioning a real drag in this longer editor.
 await wait(380);
 await page.$eval(first,el=>el.scrollIntoView({block:'center'}));await wait(100);
 const a=await page.$eval(first,el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
 const b=await page.$eval(last,el=>{const r=el.getBoundingClientRect();return{x:r.x+30,y:r.bottom-2};});
 assert.ok(b.y<page.viewport().height,'drag target must be on screen');
 if(touch){
  const client=await page.createCDPSession();const point=(x,y)=>[{x,y,id:1,radiusX:2,radiusY:2,force:1}];
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:point(a.x,a.y)});await wait(190);
  for(let i=1;i<=12;i++){await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:point(a.x+(b.x-a.x)*i/12,a.y+(b.y-a.y)*i/12)});await wait(16);}
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await client.detach();
 }else{
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(a.x+4,a.y+5);await wait(50);
  await page.mouse.move(b.x,b.y,{steps:18});await wait(100);await page.mouse.up();
 }
 await wait(100);
}

for(const width of [1440,390])test(`Rotation Group create validation, duplicate prevention and ordered payload at ${width}px`,()=>pageTest(async page=>{
 await page.click('[data-rotation-create]');await page.waitForSelector(form);await wait(180);
 await page.click(submit);assert.equal(await page.evaluate(()=>document.activeElement.name),'name');
 assert.match(await page.$eval(`${active} [data-rotation-error]`,el=>el.textContent),/Enter a Rotation Group name/);
 assert.equal(requests.length,0);
 await fill(page,`${form} [name=name]`,'Children');await page.click(submit);
 assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-rotation-add-member')),true);
 assert.match(await page.$eval(`${active} [data-rotation-error]`,el=>el.textContent),/at least one/);
 for(const id of ['1','2','3'])await page.select('[data-rotation-add-member]',id);
 assert.equal(await page.$eval('[data-rotation-add-member] option[value="1"]',el=>el.disabled),true);
 await page.$eval('[data-rotation-add-member]',el=>{el.value='1';el.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.deepEqual(await order(page),[1,2,3]);
 await page.focus('[data-rotation-member="3"] .rotation-member-handle');await page.keyboard.down('Alt');await page.keyboard.press('ArrowUp');await page.keyboard.up('Alt');
 assert.deepEqual(await order(page),[1,3,2]);assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-rotation-member]').dataset.rotationMember),'3');
 await page.click(submit);await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
 assert.deepEqual(requests[0].body,{name:'Children',description:'',active:true,member_ids:[1,3,2]});
 assert.ok(await page.$('[data-rotation-open="8"]'));
},{width}));

test('Group validation alone does not mark a pristine editor dirty',()=>pageTest(async page=>{
 await page.click('[data-rotation-create]');await page.waitForSelector(form);await wait(180);await page.click(submit);
 await page.click(`${active} [data-rotation-cancel]`);await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
 assert.equal(await page.$('.modal-panel'),null);assert.equal(requests.length,0);
}));

test('Edit supports mouse handle drag, keyboard action menu, removal, revision and deactivation',()=>pageTest(async page=>{
 await editGroup(page);await drag(page,1,3);assert.deepEqual(await order(page),[2,3,1]);
 await page.click('[data-rotation-member="3"] summary');await page.click('[data-rotation-member="3"] [data-rotation-up]');assert.deepEqual(await order(page),[3,2,1]);
 await page.click('[data-rotation-member="3"] [data-rotation-remove]');assert.deepEqual(await order(page),[2,1]);
 assert.equal(await page.$eval('[data-rotation-add-member] option[value="3"]',el=>el.disabled),false);
 await fill(page,`${form} [name=name]`,'Kids renamed');await clickSwitch(page,'active');await page.click(submit);
 await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
 assert.equal(requests[0].body.expected_revision,3);assert.equal(requests[0].body.active,false);assert.deepEqual(requests[0].body.member_ids,[2,1]);
 await page.waitForFunction(()=>document.querySelector('#shared-modal-title').textContent==='Kids renamed');
 assert.match(await page.$eval('[data-rotation-group-detail]',el=>el.innerText),/Inactive/);
 await page.screenshot({path:fileURLToPath(new URL('../.qa/rotation-groups-20260919/rotation-groups-desktop.png',import.meta.url))});
}));

test('Intentional touch handle drag reorders; rapid row scrolling does not',()=>pageTest(async page=>{
 await editGroup(page);await drag(page,1,3,true);assert.deepEqual((await order(page)).slice(0,3),[2,3,1]);
 const before=await order(page),content=`${active} .modal-panel__body`;
 await page.$eval(content,el=>{el.scrollTop=300;});
 const bounds=await page.$eval(content,el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width*.65,top:r.top,bottom:r.bottom};});
 const client=await page.createCDPSession();
 for(let pass=0;pass<3;pass++){
  const y=bounds.bottom-40;await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:bounds.x,y,id:1}]});
  for(let step=1;step<=6;step++)await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:bounds.x,y:y-step*45,id:1}]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(80);
 }
 await client.detach();assert.deepEqual(await order(page),before);assert.ok(await page.$eval(content,el=>el.scrollTop)>300);
 await page.screenshot({path:fileURLToPath(new URL('../.qa/rotation-groups-20260919/rotation-groups-mobile.png',import.meta.url))});
},{width:390,height:700,setup:()=>{groups[0].members=clone(members);}}));

test('Used by, three-step preview and open history converge through real SSE without modal teardown',()=>pageTest(async page=>{
 await openGroup(page);assert.match(await page.$eval('[data-rotation-usage="11"]',el=>el.innerText),/Rotating Order.*Next: Grace → Eleanor → Frankie/s);
 assert.equal(await page.$eval('[data-rotation-usage="11"] strong',el=>el.textContent),'Get Ready for Bed · Shower Order');
 track.next.order=clone([members[2],members[0],members[1]]);broadcast();
 await page.waitForFunction(()=>document.querySelector('[data-rotation-usage="11"]').innerText.includes('Next: Frankie'));
 await page.click('[data-rotation-history="11"]');await page.waitForSelector('[data-rotation-track-detail]');assert.equal(await page.$$eval('[data-rotation-previews] li',els=>els.length),3);
 assert.equal(await page.$eval('#shared-modal-title',el=>el.textContent),'Get Ready for Bed · Shower Order');
 // Observe the shared modal's delayed initial focus before testing whether
 // live reconciliation preserves an established explanation-summary focus.
 await page.waitForFunction(()=>document.activeElement===document.querySelector('#shared-modal-overlay [data-action="close-modal"]'));
 await page.click('[data-rotation-explanation="21"] summary');await page.evaluate(()=>window.savedHistoryPanel=document.querySelector('#shared-modal-overlay .modal-panel'));
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.rotationExplanationToggle),'21','explanation owns focus before the live update');
 history[0].context.label='Tonight updated';broadcast();
 await page.waitForFunction(()=>document.querySelector('[data-rotation-occurrence="21"]').innerText.includes('Tonight updated'));
 assert.equal(await page.$eval('[data-rotation-explanation="21"]',el=>el.open),true);
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.rotationExplanationToggle),'21');
 assert.equal(await page.evaluate(()=>window.savedHistoryPanel===document.querySelector('#shared-modal-overlay .modal-panel')),true);
}));

test('Removed consumer context remains understandable in Used by and historical controls',()=>pageTest(async page=>{
 await openGroup(page);assert.equal(await page.$eval('[data-rotation-usage="11"] strong',el=>el.textContent),'Historical bedtime · Shower Order');
 assert.match(await page.$eval('[data-rotation-usage="11"] [data-rotation-consumer-status]',el=>el.textContent),/Previous consumer.*History retained/);
 await page.click('[data-rotation-history="11"]');await page.waitForSelector('[data-rotation-track-detail]');
 assert.equal(await page.$eval('#shared-modal-title',el=>el.textContent),'Historical bedtime · Shower Order');
 assert.match(await page.$eval('[data-rotation-track-detail] [data-rotation-consumer-status]',el=>el.textContent),/Previous consumer/);
 assert.ok(await page.$('[data-rotation-occurrence="21"]'));
},{setup:()=>{track.display_label='Historical bedtime · Shower Order';track.consumer_status='previous';}}));

test('Group draft, focus and order survive SSE; stale save reports conflict and preserves draft',()=>pageTest(async page=>{
 await editGroup(page);await fill(page,`${form} [name=name]`,'My unsaved name');await page.focus(`${form} [name=description]`);await page.type(`${form} [name=description]`,' draft');
 await page.evaluate(()=>window.savedForm=document.querySelector('[data-rotation-group-form]'));
 groups[0].name='Remote name';groups[0].revision++;broadcast();
 await page.waitForFunction(()=>!document.querySelector('[data-rotation-draft-notice]').hidden);
 assert.equal(await page.$eval(`${form} [name=name]`,el=>el.value),'My unsaved name');assert.equal(await page.evaluate(()=>document.activeElement.name),'description');
 assert.equal(await page.evaluate(()=>window.savedForm===document.querySelector('[data-rotation-group-form]')),true);assert.deepEqual(await order(page),[1,2,3]);
 await page.click(submit);await page.waitForFunction(()=>document.querySelector('[data-rotation-error]:not([hidden])')?.textContent.includes('changed elsewhere'));
 assert.equal(requests[0].body.expected_revision,3);assert.equal(await page.$eval(`${form} [name=name]`,el=>el.value),'My unsaved name');
}));

test('Override and correction carry revisions, preserve parent view and refresh after child closes',()=>pageTest(async page=>{
 await openHistory(page);await page.evaluate(()=>window.savedHistoryPanel=document.querySelector('#shared-modal-overlay .modal-panel'));
 await page.click('[data-rotation-occurrence="21"] [data-rotation-override]');await page.waitForSelector('[data-rotation-override-form]');
 assert.equal(await page.$('[data-rotation-remove]'),null);
 await page.focus('[data-rotation-member="3"] .rotation-member-handle');await page.keyboard.down('Alt');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.up('Alt');
 broadcast();await page.waitForFunction(()=>!document.querySelector('[data-rotation-override-form] [data-rotation-draft-notice]').hidden);
 assert.deepEqual(await order(page),[3,1,2]);await page.click(submit);await page.waitForFunction(()=>!document.querySelector('[data-rotation-override-form]'));
 assert.deepEqual(requests[0].body,{expected_revision:4,member_ids:[3,1,2]});
 await page.waitForFunction(()=>document.querySelector('[data-rotation-occurrence="21"]').innerText.includes('Frankie → Grace → Eleanor'));
 assert.equal(await page.evaluate(()=>window.savedHistoryPanel===document.querySelector('#shared-modal-overlay .modal-panel')),true);
 await page.click('[data-rotation-correct]');await page.waitForSelector('[data-rotation-correct-form]');await page.select('[data-rotation-correct-form] [name=member]','2');
 await fill(page,'[data-rotation-correct-form] [name=reason]','Parent correction');await page.click(submit);
 await page.waitForFunction(()=>!document.querySelector('[data-rotation-correct-form]'));assert.deepEqual(requests[1].body,{expected_revision:5,next_member_id:2,reason:'Parent correction'});
 await page.waitForFunction(()=>document.querySelector('[data-rotation-previews] li > span:last-child').textContent.startsWith('Eleanor'));
 await page.waitForSelector('[data-rotation-correction="31"]');
 const correction=await page.$eval('[data-rotation-correction="31"]',el=>el.innerText);
 assert.match(correction,/Next member corrected/);assert.match(correction,/Grace → Eleanor/);assert.match(correction,/Duane/);assert.match(correction,/2026-09-19T20:15:00Z/);assert.match(correction,/Parent correction/);
 assert.equal(await page.$$eval('[data-rotation-occurrence]',nodes=>nodes.length),1,'corrections stay separate from occurrence outcomes');
}));

test('An existing empty Group can deactivate without inventing a replacement member',()=>pageTest(async page=>{
 await editGroup(page);await clickSwitch(page,'active');await page.click(submit);
 await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
 assert.deepEqual(requests[0].body.member_ids,[]);assert.equal(requests[0].body.active,false);
},{setup:()=>{groups[0].members=[];}}));

test('Unresolved keep-position occurrence can resolve with eligible members; empty eligibility cannot override',()=>pageTest(async page=>{
 await openHistory(page);assert.equal(await page.$('[data-rotation-finalize]'),null);
 await page.click('[data-rotation-override]');await page.waitForSelector('[data-rotation-override-form]');assert.deepEqual(await order(page),[2,3]);
 await page.click(submit);await page.waitForFunction(()=>!document.querySelector('[data-rotation-override-form]'));assert.deepEqual(requests[0].body,{expected_revision:4,member_ids:[2,3]});
 history[0].eligible=[];history[0].order=[];history[0].member_ids=[];broadcast();
 await page.waitForFunction(()=>!document.querySelector('[data-rotation-override]'));
 assert.ok(await page.$('[data-rotation-recheck]'));assert.equal(await page.$('[data-rotation-finalize]'),null);
},{setup:()=>{history[0].order=[];history[0].member_ids=[];history[0].eligible=clone(members.slice(1,3));}}));

test('Finalize and manual advance submit once; skip and recheck use canonical actions',()=>pageTest(async page=>{
 await openHistory(page);await page.click('[data-rotation-finalize]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-finalize]'));
 assert.deepEqual(requests[0].body,{expected_revision:4});assert.match(await page.$eval('[data-rotation-occurrence="21"]',el=>el.innerText),/Advanced once/);
 history[0].advanced=false;history[0].config.advance_policy='manual';history[0].revision++;broadcast();await page.waitForSelector('[data-rotation-advance]');
 await page.click('[data-rotation-advance]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-advance]'));
 assert.deepEqual(requests[1].body,{expected_revision:6,manual:true,outcome:'finalized'});
 history[0].status='resolved';history[0].advanced=false;history[0].order=[];history[0].eligible=[];history[0].revision++;broadcast();await page.waitForSelector('[data-rotation-recheck]');
 await page.click('[data-rotation-recheck]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-recheck]'));assert.match(requests[2].path,/\/recheck$/);
 await page.click('[data-rotation-skip]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-skip]'));assert.match(requests[3].path,/\/skip$/);
}));

test('Read-only capability view hides Group and occurrence mutation controls',()=>pageTest(async page=>{
 await page.evaluate(async()=>{window.fixture.setPermissions({capabilities:{'rotations.view':'allow','rotations.history':'allow'}});await window.fixture.renderRotationGroups(document.querySelector('#fixture'));});
 assert.equal(await page.$('[data-rotation-create]'),null);await openHistory(page);
 for(const selector of ['[data-rotation-edit]','[data-rotation-override]','[data-rotation-correct]','[data-rotation-finalize]','[data-rotation-skip]'])assert.equal(await page.$(selector),null);
}));

test('Background refresh failure cannot steal an editor draft or focus',()=>pageTest(async page=>{
 await editGroup(page);await fill(page,`${form} [name=name]`,'Keep this draft');await page.focus(`${form} [name=description]`);
 listFails=true;broadcast();await page.waitForFunction(()=>document.querySelector('#fixture [data-rotation-error]')?.textContent.includes('temporarily unavailable'));
 assert.equal(await page.evaluate(()=>document.activeElement.name),'description');assert.equal(await page.$eval(`${form} [name=name]`,el=>el.value),'Keep this draft');
}));

test('SSE replacement during pending finalization does not allow a duplicate mutation',()=>pageTest(async page=>{
 await openHistory(page);mutationDelay=300;await page.evaluate(()=>window.savedFinalize=document.querySelector('[data-rotation-finalize]'));
 await page.click('[data-rotation-finalize]');broadcast();
 await page.waitForFunction(()=>document.querySelector('[data-rotation-finalize]')!==window.savedFinalize);
 await page.click('[data-rotation-finalize]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-finalize]'));
 assert.equal(requests.filter(req=>req.path.endsWith('/finalize')).length,1);
}));

test('Mobile Round Robin override retains draft on stale revision and supports keyboard selection',()=>pageTest(async page=>{
 await openHistory(page);await page.click('[data-rotation-override]');await page.waitForSelector('[data-rotation-override-form]');
 await page.focus('[data-rotation-override-form] [name=member]');await page.keyboard.press('ArrowDown');
 assert.equal(await page.$eval('[data-rotation-override-form] [name=member]',el=>el.value),'2');
 history[0].revision++;broadcast();await page.waitForFunction(()=>!document.querySelector('[data-rotation-override-form] [data-rotation-draft-notice]').hidden);
 await page.click(submit);await page.waitForFunction(()=>document.querySelector('[data-rotation-override-form] [data-rotation-error]')?.textContent.includes('changed elsewhere'));
 assert.deepEqual(requests[0].body,{expected_revision:4,member_ids:[2]});assert.equal(await page.$eval('[data-rotation-override-form] [name=member]',el=>el.value),'2');
},{width:390,setup:()=>{track.strategy='round_robin';history[0].strategy='round_robin';updateOrder(history[0],[1]);}}));

test('A second open client receives a saved Group update without closing its detail',{timeout:20000},()=>pageTest(async page=>{
 const other=await browser.newPage();
 try{
  await other.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await other.goto(`${base}/rotation-groups-fixture`);await other.waitForFunction(()=>window.fixtureReady);await openGroup(other);
  await other.evaluate(()=>window.savedDetail=document.querySelector('#shared-modal-overlay .modal-panel'));
  await page.bringToFront();await editGroup(page);await fill(page,`${form} [name=name]`,'Shared updated name');await page.click(submit);
  await other.bringToFront();
  await other.waitForFunction(()=>document.querySelector('#shared-modal-title').textContent==='Shared updated name');
  assert.equal(await other.evaluate(()=>window.savedDetail===document.querySelector('#shared-modal-overlay .modal-panel')),true);
 }finally{await other.close();}
}));

for(const width of [1440,390])test(`Shared Group schedule is explicit and saved from the editor at ${width}px`,()=>pageTest(async page=>{
 await page.click('[data-rotation-create]');await page.waitForSelector(form);await wait(180);
 await fill(page,`${form} [name=name]`,'Kids Shower Order');for(const id of ['1','2','3'])await page.select('[data-rotation-add-member]',id);
 await page.select(`${form} [name=usage_mode]`,'shared');assert.equal(await page.$eval('[data-rotation-shared-fields]',el=>el.hidden),false);
 await page.select(`${form} [name=shared_starting_member]`,'3');await fill(page,`${form} [name=shared_effective_date]`,'2026-09-20');
 await fill(page,`${form} [name=shared_active_time]`,'18:00');await fill(page,`${form} [name=shared_finalize_time]`,'03:30');
 await page.select(`${form} [name=shared_finalize_day_offset]`,'1');
 await page.$eval('[data-rotation-weekday][value="0"]',el=>{el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.match(await page.$eval('[data-rotation-shared-preview]',el=>el.textContent),/Frankie → Grace → Eleanor/);
 await page.click(submit);await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
 const payload=requests.find(row=>row.path==='/automation/rotation-groups').body;
 assert.equal(payload.usage_mode,'shared');assert.deepEqual(payload.shared_config.weekdays,[1,2,3,4,5,6]);
 assert.equal(payload.shared_config.starting_member_id,3);assert.equal(payload.shared_config.active_time,'18:00');assert.equal(payload.shared_config.finalize_time,'03:30');
 assert.equal(payload.shared_config.finalize_day_offset,1);assert.equal(payload.shared_config.advance_on_skip,false);
},{width}));

test('Changing usage requires a preview and explicit confirmation; Cancel preserves the complete draft',()=>pageTest(async page=>{
 await editGroup(page);await wait(180);await fill(page,`${form} [name=description]`,'Preserved draft');await page.select(`${form} [name=usage_mode]`,'shared');
 await page.select(`${form} [name=shared_starting_member]`,'3');await fill(page,`${form} [name=shared_effective_date]`,'2026-09-20');
 await page.click(submit);await page.waitForSelector('[data-rotation-usage-confirm]');
 assert.match(await page.$eval('[data-rotation-usage-confirm]',el=>el.innerText),/Frankie → Grace → Eleanor/);
 assert.match(await page.$eval('[data-rotation-usage-confirm]',el=>el.innerText),/completed occurrence keeps its historical snapshot/);
 await page.click(`${active} [data-rotation-cancel]`);await page.waitForFunction(()=>!document.querySelector('[data-rotation-usage-confirm]'));
 assert.equal(requests.filter(row=>row.path==='/automation/rotation-groups/7').length,0);
 assert.equal(await page.$eval(`${form} [name=description]`,el=>el.value),'Preserved draft');
 assert.equal(await page.$eval(`${form} [name=shared_starting_member]`,el=>el.value),'3');
 await page.click(submit);await page.waitForSelector('[data-rotation-usage-confirm]');await page.click(submit);
 assert.equal(requests.filter(row=>row.path==='/automation/rotation-groups/7').length,0);
 await assertSwitchVisible(page,'confirm_usage');await clickSwitch(page,'confirm_usage');await page.click(submit);await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
 assert.equal(requests.find(row=>row.path==='/automation/rotation-groups/7').body.confirmation_token,'preview-revision-3');
}));

test('Shared binding inherits configuration and exposes resolved-assignee position without internal IDs',()=>pageTest(async page=>{
 await page.evaluate(()=>window.fixture.renderBindings([{purpose_key:'shower_order',label:'Shower Order',group_id:7,strategy:'round_robin',advance_policy:'manual',workflow_operations:['resolve','finalize','skip']}],{workflowOperations:true}));
 assert.match(await page.$eval('[data-rotation-shared-notice]',el=>el.textContent),/Using shared rotation: Kids/);
 assert.match(await page.$eval('[data-rotation-shared-notice]',el=>el.textContent),/deliberately joins/);
 for(const selector of ['strategy','advance','skip','presence','operation-finalize','operation-skip'])assert.equal(await page.$eval(`[data-rotation-${selector}]`,el=>el.disabled),true);
 const value=await page.evaluate(()=>window.bindingEditor.getValue()[0]);assert.equal(value.strategy,'rotating_order');assert.deepEqual(value.workflow_operations,['resolve']);
 const references=await page.evaluate(()=>window.fixture.variableReferenceOptions([{id:'shower_order',label:'Shower Order',type:'rotation_occurrence'}]));
 assert.equal(references.find(row=>row.token==='{{shower_order.position_label}}').label,'Shower Order · This action’s assignee position');
 await page.select('[data-rotation-period-offset]','-1');assert.equal((await page.evaluate(()=>window.bindingEditor.getValue()[0])).period_date_offset_days,-1);
},{setup:()=>{groups[0].usage_mode='shared';groups[0].shared_config={strategy:'rotating_order',advance_on_skip:false};}}));

test('Shared to independent conversion requires an explicit effective date and each consumer starting member',()=>pageTest(async page=>{
 await editGroup(page);await wait(180);await page.select(`${form} [name=usage_mode]`,'independent');
 assert.equal(await page.$eval('[data-rotation-independent-date]',el=>el.hidden),false);
 await fill(page,`${form} [name=independent_effective_date]`,'2026-09-21');await page.click(submit);await page.waitForSelector('[data-rotation-usage-confirm]');
 await assertSwitchVisible(page,'confirm_usage');await clickSwitch(page,'confirm_usage');await page.click(submit);
 assert.match(await page.$eval('[data-rotation-usage-confirm] [data-rotation-error]',el=>el.textContent),/starting member for each consumer/);
 await page.select('[data-rotation-independent-start="0"]','2');await page.click(submit);await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
 const payload=requests.find(row=>row.path==='/automation/rotation-groups/7').body;
 assert.equal(payload.effective_date,'2026-09-21');assert.equal(payload.usage_mode,'independent');
 assert.deepEqual(payload.independent_starts,[{consumer_type:'task_series',consumer_id:'42',purpose_key:'shower_order',next_member_id:2}]);
 assert.equal(requests.filter(row=>row.path.endsWith('/usage-preview')).length,2,'selected explicit states are included in the final preview token');
},{setup:()=>{groups[0].usage_mode='shared';groups[0].shared_config={strategy:'rotating_order',starting_member_id:1,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'17:00',finalize_time:'04:00',finalize_day_offset:1};}}));

test('Shared history exposes group-wide override and skip scope without consumer finalization',()=>pageTest(async page=>{
 await openHistory(page);assert.equal(await page.$('[data-rotation-finalize]'),null);assert.match(await page.$eval('[data-rotation-skip]',el=>el.textContent),/Skip this evening/);
 await page.click('[data-rotation-override]');await page.waitForSelector('[data-rotation-override-form]');
 assert.match(await page.$eval('[data-rotation-override-form]',el=>el.innerText),/every Activity using this Group for this evening/);
 assert.equal(await page.$eval('#shared-modal-title',el=>el.textContent),'Change this evening’s order');
},{setup:()=>{track.consumer_type='rotation_group';history[0].period_date='2026-09-19';}}));

test('Disposal closes SSE and delayed obsolete renders cannot reopen a stream',()=>pageTest(async page=>{
 assert.equal(streams.size,1);listDelay=120;
 await page.evaluate(()=>{const body=document.querySelector('#fixture');void window.fixture.renderRotationGroups(body);body.rotationDispose();});
 await wait(230);assert.equal(streams.size,0);
 listDelay=0;await page.evaluate(()=>window.fixture.renderRotationGroups(document.querySelector('#fixture')));await wait(100);assert.equal(streams.size,1);
 await page.evaluate(()=>document.querySelector('#fixture').remove());await wait(100);assert.equal(streams.size,0);
}));

for(const width of [1440,390])for(const theme of ['light','dark'])test(`Rotation controls remain visible and usable in ${theme} mode at ${width}px`,()=>pageTest(async page=>{
 await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.colorTheme='warm';},theme);
 const screenshot=async suffix=>page.screenshot({path:fileURLToPath(new URL(`../.qa/rotation-groups-20260919/refined-${width}-${theme}-${suffix}.png`,import.meta.url))});
 await assertFitsViewport(page);await screenshot('list');
 await openGroup(page);await assertFitsViewport(page,`${active} .modal-panel__body`);
 assert.match(await page.$eval('[data-rotation-shared-state]',el=>el.innerText),/Shared schedule/);
 await screenshot('details');
 await page.click('[data-rotation-edit]');await page.waitForSelector(form);await wait(400);
 assert.equal(await assertSwitchVisible(page,'active'),true);
 await clickSwitch(page,'active');assert.equal(await page.$eval(`${form} [name=active]`,input=>input.checked),false);
 await clickSwitch(page,'active');assert.equal(await page.$eval(`${form} [name=active]`,input=>input.checked),true);
 const unlabeled=await page.$$eval(`${form} input:not([type=hidden]), ${form} select, ${form} textarea`,fields=>fields.filter(field=>![...field.labels||[]].some(label=>label.textContent.trim())&&!field.getAttribute('aria-label')&&!field.getAttribute('aria-labelledby')).map(field=>field.name||field.outerHTML));
 assert.deepEqual(unlabeled,[],'every visible editor control has an associated label');
 await assertFitsViewport(page,`${active} .modal-panel__body`);await assertFooterReachable(page);await screenshot('editor');
 const sunday='[data-rotation-weekday][value="0"]';
 const weekdayStyle=()=>page.$eval(sunday,input=>{const span=input.labels[0].querySelector('span'),style=getComputedStyle(span),rect=span.getBoundingClientRect();return{checked:input.checked,background:style.backgroundColor,color:style.color,border:style.borderColor,width:rect.width,height:rect.height};});
 const selected=await weekdayStyle();assert.equal(selected.checked,true);assert.ok(selected.width>=32&&selected.height>=32,'weekdays have visible touch targets');
 const luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(value=>{const channel=Number(value)/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
 const colors=[luminance(selected.color),luminance(selected.background)].sort((a,b)=>a-b);
 assert.ok((colors[1]+.05)/(colors[0]+.05)>=4.5,'selected weekday text retains readable contrast');
 await page.$eval(sunday,input=>input.scrollIntoView({block:'center'}));await page.focus(sunday);await page.keyboard.press('Space');
 const unselected=await weekdayStyle();assert.equal(unselected.checked,false);assert.notDeepEqual([unselected.background,unselected.border],[selected.background,selected.border],'weekday selection must have a visible state change');
 await page.keyboard.press('Space');assert.equal((await weekdayStyle()).checked,true);
 await screenshot('weekdays');
 assert.equal(await assertSwitchVisible(page,'shared_advance_on_skip'),false);await clickSwitch(page,'shared_advance_on_skip');
 assert.equal(await page.$eval(`${form} [name=shared_advance_on_skip]`,input=>input.checked),true);
 await page.$eval(`${active} .modal-panel__body`,el=>{el.scrollTop=el.scrollHeight;});await assertFitsViewport(page,`${active} .modal-panel__body`);await screenshot('schedule');
 if(width===1440&&theme==='light'){
  await page.select(`${form} [name=shared_strategy]`,'fixed_order');
  assert.equal(await page.$eval('[data-rotation-starting-field]',el=>el.hidden),true);
  assert.equal(await page.$eval(`${form} [name=shared_advance_on_skip]`,el=>el.closest('.rotation-switch').hidden),true);
  assert.equal(await page.$eval('[data-rotation-finalize-label]',el=>el.textContent),'Finalize at');
  assert.equal(await page.$eval(`${form} [name=shared_advance_on_skip]`,el=>el.checked),true,'hiding inapplicable control preserves its draft value');
  await page.select(`${form} [name=shared_strategy]`,'rotating_order');
  assert.equal(await page.$eval('[data-rotation-starting-field]',el=>el.hidden),false);
  assert.equal(await page.$eval(`${form} [name=shared_advance_on_skip]`,el=>el.closest('.rotation-switch').hidden),false);
 }
 assert.equal(requests.length,0,'presentation and local control changes must not mutate rotation state');
},{width,height:width<768?740:980,setup:()=>{
 groups[0].name='Kids Shower Order';groups[0].usage_mode='shared';groups[0].usage_effective_date='2026-09-19';
 groups[0].shared_config={strategy:'rotating_order',starting_member_id:1,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'17:00',finalize_time:'04:00',finalize_day_offset:1,advance_on_skip:false};
 groups[0].shared={schedule:{timezone:'America/New_York'},current:{...clone(history[0]),period_date:'2026-09-19'},next:{order:clone([members[1],members[2],members[0]])}};
}}));
