import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const app=express();let browser,server,base,reads,writes,permissions,futureOffer,projectedTask,identity,detailReadStatus;
const task={id:7,title:'Prepare the garden',description:'Choose this regular task to help outside.',category:'household',assigned_to:null,assigned_users:[],created_by:1,revision:4,visibility:'all',status:'open',priority:'none',points:5,countdown:1,due_date:'2099-12-31',due_time:null,tags:[],subtasks:[],is_offer:true,permissions:{view:true,accept:true,complete:false,edit:false,delete_archive:false}};
const note={id:1,title:'Family plans',content:'Dinner at six.',visibility:'all',revision:1,color:'#EFE3BE',permissions:{view:true,edit:true,delete:true},layout:{x:0,y:0,width:4,height:6,revision:0}};
const links=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>m[0]).join('');
app.use(express.json());app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.get('/open-board-test',(_q,r)=>r.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<link rel="stylesheet" href="/styles/notes.css"><script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style></head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1',(req,res)=>{
  reads.push(req.originalUrl);
  if(req.path==='/auth/me')return res.json(identity);
  if(req.path==='/notes/board')return res.json({data:{notes:[note],groups:[]}});
  if(req.path==='/notes')return res.json({data:[note]});
  if(req.path==='/tasks') {
    if(futureOffer && req.query.offers==='1') {
      const waiting=futureOffer.reads++===0;
      return res.json({data:waiting?[]:[task],visibility:{server_now:1000,next_start_at:waiting?1300:null}});
    }
    return res.json({data:[projectedTask]});
  }
  if(req.path==='/tasks/7')return detailReadStatus===200?res.json({data:projectedTask}):res.status(detailReadStatus).json({error:'Task unavailable'});
  if(req.path==='/tasks/7/acceptance'){
    const paired=identity.principal?.kind==='device',primary=paired?Number(req.query.primary_user_id)||null:1;
    const helpers=permissions.capabilities?.['device_tasks.accept_with_helpers']==='allow';
    const members=[{id:1,display_name:'Alex'},{id:2,display_name:'Grace'}];
    return res.json({data:{task:projectedTask,expected_revision:4,primary_mode:paired?'choose':'self',primary_user_id:primary,
      primary_candidates:paired?members:[members[0]],can_add_helpers:helpers,coassignee_candidates:helpers?members.filter(m=>m.id!==primary):[],
      subtasks:projectedTask.subtasks.map(child=>({...child,allocatable:helpers,eligible_assignee_ids:helpers?[1,2]:[]})),
      subtask_snapshot:projectedTask.subtasks.map(({id,revision})=>({id,revision}))}});
  }
  if(req.path==='/tasks/7/accept'){writes.push(req.body);return res.json({data:{...task,is_offer:false,assigned_to:1}});}
  if(req.path==='/tasks/meta/options')return res.json({users:[{id:1,display_name:'Alex'}],categories:[{key:'household',name:'Household'}],tags:[]});
  if(req.path==='/preferences')return res.json({data:{}});
  if(req.path==='/automation/activity-options')return res.json({data:{activities:[],skills:[]}});
  if(req.method!=='GET')writes.push({path:req.path,body:req.body});
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount(width=1280,{denied=false,tasks=false,future=false,height=900,touch=false,viewer='admin',acceptanceHelpers=false,taskOverrides={}}={}){
  reads=[];writes=[];futureOffer=future?{reads:0}:null;permissions=denied?{modules:{notes:'write',tasks:'none'}}:tasks?{modules:{notes:'none',tasks:'read'}}:{admin:true};
  if(viewer==='member')permissions={modules:{notes:'write',tasks:'write'}};
  if(viewer==='paired')permissions={principal_kind:'device',modules:{notes:'read',tasks:'read'},capabilities:{'device_notes.view':'allow',
    'tasks.view_household':'allow','tasks.change_assignment':'none','tasks.reassign':'none','tasks.edit_others':'none',
    'device_tasks.claim':taskOverrides.permissions?.accept===false?'none':'allow','device_tasks.accept_with_helpers':acceptanceHelpers?'allow':'none'}};
  projectedTask=structuredClone({...task,...taskOverrides});
  detailReadStatus=200;
  identity=viewer==='paired'?{user:null,device:{id:99},principal:{kind:'device',id:99},authContext:'paired-fixture',permissions,csrfToken:'fixture'}:{user:{id:viewer==='member'?2:1,role:viewer==='member'?'member':'admin'},authContext:viewer+'-fixture',permissions,csrfToken:'fixture'};
  const page=await browser.newPage();page.setDefaultTimeout(6000);await page.setViewport({width,height,isMobile:touch,hasTouch:touch});
  // Loopback server is reachable in this isolated network-none container.
  await page.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'onLine',{get:()=>true}));
  await page.goto(base+'/open-board-test'+(tasks?'?offers=1&view=list':''));
  await page.evaluate(async({identity,tasks})=>{localStorage.clear();localStorage.setItem('yuvomi-locale','en');window.yuvomi={showToast(){}};window.EventSource=class{addEventListener(){}close(){}};await(await import('/i18n.js')).initI18n();(await import('/utils/device-context.js')).acceptAuthentication(identity);(await import('/permissions.js')).setPermissions(identity.permissions);window.stopPage=await(await import(tasks?'/pages/tasks.js':'/pages/notes.js')).render(document.querySelector('#main-content'),{user:identity.user});},{identity,tasks});
  return page;
}
test('Notes offer countdown is readable, refreshes in place, and stops with the board',async()=>{
  const page=await mount(390);try{
    await page.waitForSelector('[data-open-task="7"]');
    const countdown=await page.$('[data-open-task="7"] [data-task-countdown]');
    assert.ok(countdown,'countdown-enabled offers show their remaining time');
    const initial=await countdown.evaluate(el=>({text:el.textContent,title:el.title,muted:el.classList.contains('text-muted')}));
    assert.match(initial.text,/left/);assert.ok(initial.title.includes('2099'));assert.equal(initial.muted,true);
    const spacing=await countdown.evaluate(el=>{const points=el.previousElementSibling.getBoundingClientRect(),timer=el.getBoundingClientRect();return {gap:timer.left-points.right,below:timer.top>=points.bottom-1};});
    assert.ok(spacing.below||spacing.gap>=4,'points and countdown must have visible separation: '+JSON.stringify(spacing));
    const updated=await countdown.evaluate(el=>{el.dataset.dueDate='2000-01-01';window.dispatchEvent(new Event('focus'));return {text:el.textContent,overdue:el.classList.contains('task-countdown--overdue')};});
    assert.match(updated.text,/Overdue/);assert.equal(updated.overdue,true);
    const stopped=await countdown.evaluate(el=>{const board=document.querySelector('#notes-open-tasks');window.stopPage();board.append(el);el.dataset.dueDate='2099-12-31';window.dispatchEvent(new Event('focus'));return el.textContent;});
    assert.equal(stopped,updated.text,'stopping the board removes countdown refresh listeners');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [780,840])test(`short landscape ${width}x360 keeps full task cards in the page scroll`,async()=>{
  const page=await mount(width,{height:360,touch:true});try{
    await page.waitForSelector('[data-open-task="7"]');
    // Reserve the paired banner above the real module styles, as in the app shell.
    await page.$eval('#main-content',el=>{el.classList.add('app-content');el.style.height='calc(100dvh - 64px)';});
    const size=await page.evaluate(()=>{const panel=document.querySelector('.notes-open-tasks'),card=panel.querySelector('[data-open-task]'),notes=document.querySelector('.notes-scroll'),main=document.querySelector('#main-content');return {panel:panel.clientHeight,panelContent:panel.scrollHeight,card:card.getBoundingClientRect().height,notes:notes.clientHeight,note:notes.querySelector('.note-card').getBoundingClientRect().height,page:main.clientHeight,pageContent:main.scrollHeight};});
    assert.ok(size.panel>=size.panelContent-1,'task section must not become a nested scroll trap: '+JSON.stringify(size));
    assert.ok(size.panel>=size.card,'a whole task card fits in its section');
    assert.ok(size.notes>=size.note,'Notes grows with its cards instead of sharing a tiny remainder');
    assert.ok(size.pageContent>size.page,'the page carries the overflow');
    await page.$eval('[data-open-task="7"]',el=>el.scrollIntoView({block:'center'}));
    const target=await page.$eval('[data-open-task="7"]',el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,top:r.top,bottom:r.bottom};});
    assert.ok(target.top>=0&&target.bottom<=360,'whole card can be brought into view');
    await page.touchscreen.tap(target.x,target.y);await page.waitForSelector('#task-detail-claim');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [390,1440])test(`Notes and ordinary offers share the page at ${width}px without sharing layout`,async()=>{
  const page=await mount(width);try{
    await page.waitForSelector('[data-open-task="7"]');assert.ok(await page.$('.note-card'));
    assert.equal(await page.$eval('.open-task-board__header h2',el=>el.textContent.trim()),'Bounty Tasks');
    assert.equal(await page.$eval('.open-task-board',el=>el.getAttribute('aria-label')),'Bounty Tasks');
    const boardText=await page.$eval('.open-task-board',el=>el.textContent);assert.equal(await page.$eval('.open-task-board__description',el=>el.textContent.trim()),'Take on these tasks and earn extra points when you finish them!');assert.ok(!boardText.includes('Choose an unassigned task'));assert.ok(!boardText.includes('Create a regular task'));
    const geometry=await page.evaluate(()=>{const n=document.querySelector('.notes-scroll').getBoundingClientRect(),o=document.querySelector('#notes-open-tasks').getBoundingClientRect();return {nt:n.top,nr:n.right,ot:o.top,ol:o.left,ob:o.bottom,scroll:document.documentElement.scrollWidth,width:innerWidth};});
    if(width<1400)assert.ok(geometry.ob<=geometry.nt+1);else assert.ok(geometry.nr<=geometry.ol+1);
    assert.ok(geometry.scroll<=geometry.width+1);
    if(process.env.OPEN_TASK_SCREENSHOTS){mkdirSync(process.env.OPEN_TASK_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.OPEN_TASK_SCREENSHOTS}/notes-open-tasks-${width}.png`});}
    await page.click('[data-open-task="7"]');await page.waitForSelector('#task-detail-claim');assert.ok(await page.$('.detail-view__pane'));
    await page.click('#task-detail-claim');await page.waitForSelector('[data-acceptance-helper-unavailable]');await page.click('[data-acceptance-next]');await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.length,1);
    assert.ok(!reads.some(path=>path.includes('/notes/')&&path.includes('layout')));
  }finally{await page.close();}
});

for(const width of [690,720,738,752,800,820,1280,1920])test(`Bounty sidebar stays right with a usable canvas at ${width}px`,async()=>{
  const page=await mount(width,{touch:width<=800});try{
    await page.waitForSelector('[data-open-task="7"]');
    assert.equal(await page.$eval('#notes-grid',el=>el.dataset.boardView),'canvas','open Fold and larger pages retain their canvas beside the rail');
    const size=await page.evaluate(()=>{const n=document.querySelector('.notes-scroll').getBoundingClientRect(),o=document.querySelector('#notes-open-tasks').getBoundingClientRect();return {canvas:n.width,sidebar:o.width,nr:n.right,ol:o.left,nt:n.top,ot:o.top,scroll:document.documentElement.scrollWidth,width:innerWidth};});
    assert.ok(size.nr<=size.ol+1&&Math.abs(size.nt-size.ot)<2,'offers belong beside the canvas: '+JSON.stringify(size));
    assert.ok(size.canvas>=470,'canvas keeps usable space: '+JSON.stringify(size));
    assert.ok(size.sidebar>=220&&size.sidebar<=290,'sidebar has readable cards: '+JSON.stringify(size));
    assert.ok(size.scroll<=size.width+1,'document must not overflow horizontally');
  }finally{await page.close();}
});

for(const points of [0,5])test(`Bounty offer shows configured ${points} completion points`,async()=>{
  const page=await mount(390,{taskOverrides:{points,subtasks:[{id:8,title:'A separately scored step',points:100,status:'open'}]}});try{
    await page.waitForSelector('[data-open-task="7"]');
    const labels=await page.$$eval('[data-open-task="7"] .text-muted:not([data-task-countdown])',elements=>elements.map(el=>el.textContent.trim()));
    assert.ok(labels.includes(`${points} points`),'configured reward is a separate readable value: '+JSON.stringify(labels));
    assert.doesNotMatch(await page.$eval('[data-open-task="7"]',el=>el.textContent),/100 points|105 points/,'subtask points are not added to the parent completion reward');
  }finally{await page.close();}
});

for(const helpers of [false,true])for(const children of [false,true])test(`paired Bounty acceptance ignores denied generic assignment (helpers ${helpers}, subtasks ${children})`,async()=>{
  const page=await mount(1280,{viewer:'paired',acceptanceHelpers:helpers,taskOverrides:{
    permissions:{...task.permissions,change_assignment:false,reassign:false},
    subtasks:children?[{id:8,title:'Synthetic step',revision:2,status:'open'}]:[],
  }});try{
    await page.waitForSelector('[data-open-task="7"]');await page.click('[data-open-task="7"]');await page.waitForSelector('#task-detail-claim');
    assert.equal(await page.$('#detail-view-edit,#task-detail-delete,.task-comments__form,.subtask-check'),null);
    await page.click('#task-detail-claim');await page.waitForSelector('[data-acceptance-primary]');await page.select('[data-acceptance-primary]','1');await page.click('[data-acceptance-next]');
    await page.waitForSelector('[data-task-acceptance][data-stage="helpers"]');
    if(helpers)await page.click('[data-acceptance-helper="2"]');else assert.ok(await page.$('[data-acceptance-helper-unavailable]'));
    await page.click('[data-acceptance-next]');
    assert.equal(await page.$eval('[data-task-acceptance]',el=>el.dataset.stage),helpers&&children?'allocation':'confirm');
    if(helpers&&children){await page.click('[data-acceptance-target="8"]');await page.click('[data-acceptance-choice="2"]');await page.click('[data-acceptance-next]');}
    await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));
    assert.equal(writes.length,1);assert.equal(writes[0].primary_user_id,1);assert.deepEqual(writes[0].coassignee_ids,helpers?[2]:[]);
    assert.deepEqual(writes[0].subtask_assignments,helpers&&children?[{id:8,user_id:2}]:[]);
    const current=await page.evaluate(async()=>({device:(await import('/utils/device-context.js')).isDevicePrincipal(),capabilities:(await import('/permissions.js')).getPermissions().capabilities}));
    assert.equal(current.device,true);for(const key of ['tasks.change_assignment','tasks.reassign','tasks.edit_others'])assert.equal(current.capabilities[key],'none');
  }finally{await page.close();}
});

const managementPermissions={view:true,accept:true,complete:true,edit:true,delete_archive:true,comment:true,change_dates:true};
const managementTask={description:'Read this instruction.\n- [ ] A checklist',permissions:managementPermissions,subtasks:[{id:8,title:'Inspect the soil',status:'open',points:2,revision:1,permissions:managementPermissions}]};
for(const viewer of ['admin','member','paired'])test(`Bounty inspection stays read only for ${viewer}, including refreshed permissions`,async()=>{
  const page=await mount(752,{viewer,taskOverrides:{...managementTask,permissions:{...managementPermissions,accept:viewer!=='paired'}}});try{
    assert.equal(await page.evaluate(async()=>{const {isDevicePrincipal}=await import('/utils/device-context.js');return isDevicePrincipal();}),viewer==='paired','fixture uses the actual principal context');
    await page.waitForSelector('[data-open-task="7"]');await page.click('[data-open-task="7"]');await page.waitForSelector('.detail-view__pane');
    const forbidden='select,input,textarea,[data-task-operation],.subtask-check,.note-md-box[data-md-line],#detail-view-edit,#task-detail-delete,#task-detail-archive,.task-comments__form';
    assert.equal(await page.$(`.modal-panel ${forbidden.split(',').join(',.modal-panel ')}`),null,'inspection exposes no management controls');
    assert.match(await page.$eval('.detail-view__pane',el=>el.textContent),/Inspect the soil/,'subtask instructions remain readable');
    assert.equal(!!await page.$('#task-detail-claim'),viewer!=='paired','Accept follows the server projection');
    projectedTask={...projectedTask,title:'Updated garden offer',revision:5,permissions:{...managementPermissions,accept:viewer!=='paired'}};
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('.modal-panel__title')?.textContent==='Updated garden offer');
    assert.equal(await page.$(`.modal-panel ${forbidden.split(',').join(',.modal-panel ')}`),null,'live refresh cannot restore management controls');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});

test('ordinary Task details retain their management controls',async()=>{
  const page=await mount(752,{taskOverrides:managementTask});try{
    await page.evaluate(async()=>{const response=await(await import('/api.js')).api.get('/tasks/7');(await import('/components/task-detail.js')).openTaskDetail({task:response.data,currentUserId:1,isAdmin:true,edit:{mount(){}}});});
    await page.waitForSelector('.detail-view__pane');
    for(const selector of ['.task-detail-status select','.task-comments__form','#detail-view-edit','#task-detail-delete','#task-detail-archive'])assert.ok(await page.$(selector),'ordinary management remains: '+selector);
    assert.equal(writes.length,0);
  }finally{await page.close();}
});

test('Bounty inspection removes Accept after revocation and closes on auth loss',async()=>{
  const page=await mount(752,{taskOverrides:managementTask});try{
    await page.waitForSelector('[data-open-task="7"]');await page.click('[data-open-task="7"]');await page.waitForSelector('#task-detail-claim');
    projectedTask={...projectedTask,permissions:{...managementPermissions,accept:false}};
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('#task-detail-claim')?.hidden);
    const count=reads.filter(path=>path.includes('/acceptance')).length;
    await page.$eval('#task-detail-claim',el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    assert.equal(reads.filter(path=>path.includes('/acceptance')).length,count,'even a dispatched event cannot bypass revoked acceptance');
    await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));
    await page.waitForFunction(()=>!document.querySelector('.detail-view__pane'));
    assert.equal(writes.length,0);
  }finally{await page.close();}
});

for(const loss of [403,404,'view'])test(`Bounty inspection conceals the title and body after read loss ${loss}`,async()=>{
  const page=await mount(752,{taskOverrides:managementTask});try{
    await page.waitForSelector('[data-open-task="7"]');await page.click('[data-open-task="7"]');await page.waitForSelector('#task-detail-claim');
    if(loss==='view')projectedTask={...projectedTask,permissions:{...managementPermissions,view:false}};else detailReadStatus=loss;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('.modal-panel__title')?.textContent==='Task unavailable');
    assert.doesNotMatch(await page.$eval('.modal-panel',el=>el.textContent),/Prepare the garden|Inspect the soil|Read this instruction/);
    assert.equal(await page.$('#task-detail-claim'),null);assert.equal(writes.length,0);
  }finally{await page.close();}
});
test('Notes does not request or expose Tasks when that module is denied',async()=>{
  const page=await mount(1280,{denied:true});try{assert.ok(await page.$('.note-card'));assert.equal(await page.$('[data-open-task]'),null);assert.equal(reads.some(path=>path.includes('/tasks')),false);}finally{await page.close();}
});
test('Tasks has an independent open filter and normal details without Notes access',async()=>{
  const page=await mount(1280,{tasks:true});try{
    await page.waitForSelector('.task-card');assert.ok(reads.some(path=>path.startsWith('/api/v1/tasks?')&&path.includes('offers=1')));assert.equal(reads.some(path=>path.includes('/notes')),false);
    await page.click('#filter-toggle-btn');await page.waitForSelector('#filter-open-tasks');assert.equal(await page.$eval('#filter-open-tasks',el=>el.getAttribute('aria-pressed')),'true');
    const previous=reads.length;await page.click('#filter-open-tasks');await page.waitForFunction(()=>document.querySelector('#filter-open-tasks').getAttribute('aria-pressed')==='false');await page.waitForNetworkIdle({idleTime:100});assert.ok(reads.slice(previous).some(path=>path.startsWith('/api/v1/tasks?')&&!path.includes('offers='))||reads.slice(previous).includes('/api/v1/tasks'));
  }finally{await page.close();}
});

test('Notes offers refresh at the server visibility boundary without an event or navigation',async()=>{
  const page=await mount(1280,{future:true});try{
    await page.waitForSelector('.open-task-board');
    assert.equal(await page.$('[data-open-task="7"]'),null,'future offer starts hidden');
    await page.waitForSelector('[data-open-task="7"]',{timeout:1500});
    assert.equal(futureOffer.reads,2,'visibility envelope arms one canonical re-read');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
