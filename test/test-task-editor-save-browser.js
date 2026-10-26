import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Real public modules and DOM events; policy/ledger behavior is independently
// verified by the API suites. This fixture owns only disposable loopback state.
const members=[{id:1,display_name:'Alex',role:'admin'},{id:2,display_name:'Eleanor',role:'admin'},{id:3,display_name:'Sam',role:'admin'}];
const requests=[];
let editing=null, preview=null, previewDelay=0, previewError=null, listDelay=0, heldListResponse=null, heldPutResponse=null, holdPut=false, putOutcome=null, heldCreateResponse=null, holdCreate=false, postOutcome=null, createdResult=null, heldDocumentResponse=null, holdDocument=false, documentSerial=210, statusRejectOnce=false;
const app=express();app.use(express.json());
const fixturePermissions=allowed=>({admin:allowed,capabilities:Object.fromEntries(['tasks.create','tasks.change_priority','tasks.change_points','tasks.change_category_tags','tasks.change_dates','tasks.change_assignment','tasks.change_required_skills','activities.view','workflows.view','workflows.run'].map(key=>[key,key==='tasks.change_points'&&!allowed?'deny':'allow']))});
app.use('/api/v1',(req,res)=>{
  requests.push({method:req.method,path:req.path,body:structuredClone(req.body)});
  if(req.path==='/auth/me'){
    const role=req.headers.cookie?.includes('scoring-role=member')?'member':'admin';
    const permissions=fixturePermissions(!req.headers.cookie?.includes('scoring-points=deny'));
    permissions.admin=permissions.admin&&role==='admin';
    return res.json({user:{...members[0],role},permissions});
  }
  if(req.path==='/tasks/70/scoring-preview') { const value=structuredClone(preview),error=structuredClone(previewError);return setTimeout(()=>error?res.status(error.status).json(error):res.json({data:value}),previewDelay); }
  if(req.path==='/documents'&&req.method==='POST'){
    const result={data:{id:++documentSerial,name:req.body.name,mime_type:'text/plain'}};
    if(holdDocument){heldDocumentResponse={res,result};holdDocument=false;return;}
    return res.json(result);
  }
  if(/^\/tasks\/(70|99)\/documents$/.test(req.path)&&req.method==='PUT')return res.json({task_revision:(editing?.revision||1)+1});
  if(req.path==='/tasks/70/status'&&req.method==='PATCH'){
    if(statusRejectOnce){statusRejectOnce=false;return res.status(429).json({error:'Too many requests. Please wait a moment.',code:429});}
    editing={...editing,status:req.body.status,revision:editing.revision+1};
    return res.json({data:editing});
  }
  if(req.path==='/tasks/70'||req.path==='/tasks/99'){
    if(req.method==='PUT'){
      if(putOutcome==='conflict'){putOutcome=null;return res.status(409).json({error:'Task revision changed'});}
      if(putOutcome==='unapplied_unknown'){putOutcome=null;return res.status(503).json({error:'Response unavailable'});}
      if(putOutcome==='future_unknown'){
        putOutcome=null;editing={...editing,recurrence_series_revision:Number(editing.recurrence_series_revision||0)+1};
        return res.status(503).json({error:'Response unavailable'});
      }
      editing={...editing,...req.body,revision:editing.revision+1};
      if(putOutcome==='applied_unknown'){putOutcome=null;return res.status(503).json({error:'Response unavailable'});}
      const result={data:editing,series_edit:{scope:req.body.edit_scope,current_preserved:req.body.edit_scope==='future_only',revision:9,created_actions:[]}};
      if(holdPut){heldPutResponse={res,result};return;}
      return res.json(result);
    }
    return res.json({data:editing});
  }
  if(req.path==='/tasks'&&req.method==='POST'){
    const result=createdResult||{data:{id:99,revision:1,...req.body}};
    createdResult=result;
    if(postOutcome==='applied_unknown'){postOutcome=null;editing=structuredClone(result.data);return res.status(503).json({error:'Response unavailable'});}
    editing=structuredClone(result.data);
    if(holdCreate){heldCreateResponse={res,result};return;}
    return res.json(result);
  }
  if(req.path==='/tasks'&&req.method==='GET'){
    if(listDelay<0){heldListResponse=res;return;}
    return setTimeout(()=>res.json({data:[]}),listDelay);
  }
  if(req.path==='/tasks/meta/options')return res.json({users:members,categories:[{key:'misc',label:'General'}],tags:[],default_points:3});
  if(req.path==='/automation/activity-options')return res.json({data:{activities:[],skills:[]}});
  if(req.path==='/automation/quick-add')return res.json({data:[],activities:[],members,places:[]});
  if(req.path==='/preferences')return res.json({data:{}});
  if(req.path==='/reminders')return res.json({data:null});
  return res.json({data:[]});
});
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
const styles=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag])=>tag).join('');
app.get('/scoring-test',(_req,res)=>res.send(`<!doctype html><html lang="en" data-theme="light" data-color-theme="warm"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/tasks.css"></head><body><main id="fixture"></main></body></html>`));
let server,browser,base,ownedBrowser;
test.before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser=await puppeteer.launch({headless:true,pipe:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),
    args:['--disable-dev-shm-usage',...(process.env.VIDAMIA_TEST_BROWSER_NO_SANDBOX==='1'?['--no-sandbox']:[])]});
  const processHandle=browser.process();ownedBrowser={pid:processHandle.pid,profile:processHandle.spawnargs.find(arg=>arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length),processHandle};
});
test.after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve)||resolve());if(ownedBrowser)console.log('SCORING_UI_OWNED_CLEANUP',JSON.stringify({node_pid:process.pid,chrome_pid:ownedBrowser.pid,chrome_exit:ownedBrowser.processHandle.exitCode,server_listening:server.listening,profile:ownedBrowser.profile,profile_removed:ownedBrowser.profile?!existsSync(ownedBrowser.profile):null}));});
async function mounted({task=null,width=390,pointsAllowed=true,user={id:1,role:'admin'},refreshOnSave=false,quietLive=false}={}){
  editing=task?structuredClone(task):null;requests.length=0;listDelay=0;heldListResponse=null;heldPutResponse=null;holdPut=false;putOutcome=null;heldCreateResponse=null;holdCreate=false;postOutcome=null;createdResult=null;heldDocumentResponse=null;holdDocument=false;documentSerial=210;
  const context=await browser.createBrowserContext(),page=await context.newPage();await page.setViewport({width,height:900});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);page.setDefaultTimeout(6000);
  const pageErrors=[];page.on('pageerror',error=>{pageErrors.push(error.message);console.error('SCORING_FIXTURE_PAGE_ERROR',error.stack);});
  await page.goto(`${base}/scoring-test`);
  await page.evaluate(async ({pointsAllowed,user,quietLive})=>{
    if(quietLive)window.EventSource=class{addEventListener(){}close(){}};
    document.cookie=`scoring-points=${pointsAllowed?'allow':'deny'};path=/`;
    document.cookie=`scoring-role=${user.role};path=/`;
    localStorage.setItem('yuvomi-lang','en');window.toasts=[];window.yuvomi={user,showToast:message=>window.toasts.push(message)};
    const i18n=await import('/i18n.js');await i18n.initI18n();await i18n.setLocale('en');await import('/components/datepicker.js');
    const {setPermissions}=await import('/permissions.js');setPermissions({admin:pointsAllowed&&user.role==='admin',capabilities:Object.fromEntries(['tasks.create','tasks.change_priority','tasks.change_points','tasks.change_category_tags','tasks.change_dates','tasks.change_assignment','tasks.change_required_skills','activities.view','workflows.view','workflows.run'].map(key=>[key,key==='tasks.change_points'&&!pointsAllowed?'deny':'allow']))});
    const {render}=await import('/pages/tasks.js');window.disposeScoringPage=await render(document.querySelector('#fixture'),{user});
  },{pointsAllowed,user,quietLive});
  if(task){await page.evaluate(async({user,refreshOnSave})=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(70,{user,onChanged:refreshOnSave?async()=>{window.__saveRefreshStarted=true;if(window.__failSaveRefresh)throw Error('Synthetic refresh failure');await fetch('/api/v1/tasks');window.__saveRefreshFinished=true;}:()=>{}});},{user,refreshOnSave});await page.click('#detail-view-edit');}
  else await page.$eval(width<1024?'#fab-new-task':'#btn-new-task',el=>el.click());
  await page.waitForSelector('#task-form');page.dispose=async()=>{await page.evaluate(()=>window.disposeScoringPage?.());await context.close();assert.deepEqual(pageErrors,[],'fixture has no unhandled page errors');};return page;
}
async function set(page,selector,value){await page.$eval(selector,(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);}
const scoring={mode:'whole_task',root_task_id:70,mode_locked:false,review_required:false,earned:[{user_id:1,points:4}],potential:[{user_id:1,points:3}],personal_total:7,settled_task_ids:[],settlements:[]};
const task={id:70,title:'Routine',description:'',status:'open',points:999,assigned_to:1,assigned_users:[members[0]],priority:'none',category:'misc',revision:4,subtasks:[],scoring};
const completionTask=()=>({...task,points:5,scoring:{...scoring,earned:[],potential:[{user_id:1,points:5}],personal_total:5},documents:[],
  permissions:{view:true,edit:true,complete:true,change_assignment:true,change_points:true,change_required_skills:true},
  subtasks:[{id:71,title:'Required action',status:'open',points:2,parent_task_id:70},{id:72,title:'Optional action',status:'open',points:3,is_optional:1,parent_task_id:70}]});

for(const choice of [false,true])test(`editor status Done offers the shared completion choice ${choice} and sends it through PUT`,async()=>{
  const page=await mounted({task:completionTask(),width:choice?1366:390,quietLive:true});try{
    await set(page,'#task-status','done');await page.click('#task-submit-btn');
    await page.waitForSelector('#confirm-modal-checkbox');
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,0);
    if(!choice)await page.click('#confirm-modal-checkbox');await page.click('#confirm-modal-ok');
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const saved=requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70');assert.equal(saved.length,1);assert.equal(saved[0].body.status,'done');assert.equal(saved[0].body.complete_remaining,choice);
    assert.equal(requests.filter(row=>row.method==='PATCH'&&row.path==='/tasks/70/status').length,0);
  }finally{await page.dispose();}
});

test('editor completion false survives an uncertain unapplied PUT retry while preserving newer draft edits',async()=>{
  const page=await mounted({task:completionTask(),width:390,quietLive:true});try{
    await set(page,'#task-title','First completion draft');await set(page,'#task-status','done');putOutcome='unapplied_unknown';
    await page.click('#task-submit-btn');await page.waitForSelector('#confirm-modal-checkbox');await page.click('#confirm-modal-checkbox');await page.click('#confirm-modal-ok');
    await page.waitForSelector('#task-form-save-status [data-task-save-check]');
    await set(page,'#task-title','Newer completion draft');await page.click('#task-form-save-status [data-task-save-check]');
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-title',element=>element.value),'Newer completion draft');
    await page.click('#task-submit-btn');await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const saves=requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70');assert.equal(saves.length,2);assert.deepEqual(saves.map(row=>row.body.complete_remaining),[false,false]);
    assert.deepEqual(saves.map(row=>row.body.title),['First completion draft','Newer completion draft']);assert.equal(saves[1].body.expected_revision,saves[0].body.expected_revision);
  }finally{putOutcome=null;await page.dispose();}
});

test('editor completion acknowledgement preserves newer draft edits without repeating completion',async()=>{
  const page=await mounted({task:completionTask(),width:390,quietLive:true});try{
    await set(page,'#task-status','done');holdPut=true;await page.click('#task-submit-btn');
    await page.waitForSelector('#confirm-modal-checkbox');await page.click('#confirm-modal-checkbox');await page.click('#confirm-modal-ok');
    for(let attempt=0;attempt<100&&!heldPutResponse;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(heldPutResponse);
    await set(page,'#task-title','Newer draft while completion saves');const first=heldPutResponse;heldPutResponse=null;holdPut=false;first.res.json(first.result);
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-title',element=>element.value),'Newer draft while completion saves');
    await page.click('#task-submit-btn');await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const saves=requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70');assert.equal(saves.length,2);assert.equal(saves[0].body.complete_remaining,false);assert.equal(saves[1].body.complete_remaining,undefined);
    assert.equal(saves[1].body.title,'Newer draft while completion saves');assert.equal(saves[1].body.expected_revision,saves[0].body.expected_revision+1);
  }finally{holdPut=false;heldPutResponse?.res.json(heldPutResponse.result);heldPutResponse=null;await page.dispose();}
});

test('named modes switch active labeled controls and retain zero and inactive values',async()=>{
  const page=await mounted();try{
    assert.equal(await page.$eval('#task-points',el=>el.value),'3');
    assert.equal(await page.$('input[name="scoring_mode"][value="whole_task"]')!==null,true,'real Whole task radio exists');
    await page.$eval('[data-task-subtask-add]',el=>el.click());await page.waitForSelector('[data-task-subtask-title]');await set(page,'[data-task-subtask-title]','Wash');await set(page,'[data-task-subtask-points]','0');
    await page.click('input[name="scoring_mode"][value="subtasks"]');
    assert.equal(await page.$eval('input[name="scoring_mode"][value="subtasks"]',el=>el.checked),true,'Each subtask choice is checked');
    assert.equal(await page.$eval('#task-points',el=>el.disabled),true);
    assert.equal(await page.$eval('[data-task-subtask-points]',el=>el.disabled),false);
    await page.click('input[name="scoring_mode"][value="whole_task"]');
    assert.equal(await page.$eval('[data-task-subtask-points]',el=>el.value),'0');
    await page.click('input[name="scoring_mode"][value="subtasks"]');await set(page,'#task-title','Zero work');await page.click('#task-submit-btn');
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const saved=requests.find(r=>r.method==='POST'&&r.path==='/tasks');assert.equal(saved.body.scoring_mode,'subtasks');assert.equal(saved.body.subtasks[0].points,0);
  }finally{await page.dispose();}
});

test('a saved editor cannot close a different draft after delayed list refresh',async()=>{
  const source={...task,permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:1366,refreshOnSave:true});try{
    await set(page,'#task-title','Saved before refresh');
    listDelay=-1;
    const reads=requests.filter(row=>row.method==='GET'&&row.path==='/tasks').length;
    await page.click('#task-submit-btn');
    for(let attempt=0;attempt<100&&!heldListResponse;attempt++)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(await page.evaluate(()=>window.__saveRefreshStarted),true,'held read belongs to save refresh');
    assert.ok(heldListResponse&&requests.filter(row=>row.method==='GET'&&row.path==='/tasks').length>reads,'save reached its held refresh');
    listDelay=0;
    await page.evaluate(async()=>{const {closeModal}=await import('/components/modal.js');await closeModal({force:true});});
    await page.evaluate(async()=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(70,{user:{id:1,role:'admin'}});});
    await page.click('#detail-view-edit');await page.waitForSelector('#task-form');await set(page,'#task-title','Second unsaved draft');
    const response=heldListResponse;heldListResponse=null;listDelay=0;response.json({data:[]});
    await page.waitForFunction(()=>window.__saveRefreshFinished===true);
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await page.$eval('#task-title',element=>element.value),'Second unsaved draft');
  }finally{listDelay=0;heldListResponse?.json({data:[]});heldListResponse=null;await page.dispose();}
});

test('edits typed during a pending save remain in the same editor and can be saved next',async()=>{
  const source={...task,documents:[],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,refreshOnSave:true,quietLive:true});try{
    await set(page,'#task-title','First saved title');
    holdPut=true;
    await page.click('#task-submit-btn');
    for(let attempt=0;attempt<100&&!heldPutResponse;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(heldPutResponse,'the first PUT reached the server');
    await set(page,'#task-title','Second unsaved title');
    const first=heldPutResponse;heldPutResponse=null;holdPut=false;first.res.json(first.result);
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-title',el=>el.value),'Second unsaved title');
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
    await page.click('#task-submit-btn');
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const saves=requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70');
    assert.deepEqual(saves.map(row=>row.body.title),['First saved title','Second unsaved title']);
    assert.equal(saves[1].body.expected_revision,saves[0].body.expected_revision+1);
  }finally{holdPut=false;heldPutResponse?.res.json(heldPutResponse.result);heldPutResponse=null;await page.dispose();}
});

test('edits typed during creation remain after the first Task is acknowledged',async()=>{
  const page=await mounted({width:390,quietLive:true});try{
    await set(page,'#task-title','Created version');holdCreate=true;
    await page.click('#task-submit-btn');
    for(let attempt=0;attempt<100&&!heldCreateResponse;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(heldCreateResponse);
    await set(page,'#task-title','Later local version');
    const first=heldCreateResponse;heldCreateResponse=null;holdCreate=false;first.res.json(first.result);
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-id',el=>el.value),'99');
    assert.equal(await page.$eval('#task-title',el=>el.value),'Later local version');
    assert.equal(requests.filter(row=>row.method==='POST'&&row.path==='/tasks').length,1);
    assert.equal(await page.$eval('#task-submit-btn',el=>el.textContent.trim()),'Save');
  }finally{holdCreate=false;heldCreateResponse?.res.json(heldCreateResponse.result);heldCreateResponse=null;await page.dispose();}
});

test('recovered create plus uncertain follow-up PUT retains the new Task revision and draft',async()=>{
  const page=await mounted({width:390,quietLive:true});try{
    postOutcome='applied_unknown';await set(page,'#task-title','Original create');await page.click('#task-submit-btn');
    await page.waitForFunction(()=>/couldn.t confirm/i.test(document.querySelector('#task-form-error')?.textContent||''));
    await set(page,'#task-title','Newer draft');putOutcome='unapplied_unknown';
    await page.click('#task-submit-btn');
    await page.waitForSelector('#task-form-save-status [data-task-save-check]');
    assert.equal(await page.$eval('#task-id',el=>el.value),'99');
    assert.equal(await page.$eval('#task-title',el=>el.value),'Newer draft');
    assert.equal(requests.filter(row=>row.method==='POST'&&row.path==='/tasks').length,2);
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/99').length,1);
    await page.click('#task-form-save-status [data-task-save-check]');
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-title',el=>el.value),'Newer draft');
  }finally{postOutcome=null;putOutcome=null;await page.dispose();}
});

test('an uncertain unapplied edit requires a current read before deliberate retry',async()=>{
  const source={...task,permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,quietLive:true});try{
    putOutcome='unapplied_unknown';await set(page,'#task-title','Retry after check');await page.click('#task-submit-btn');
    await page.waitForSelector('#task-form-save-status [data-task-save-check]');
    assert.equal(await page.$eval('#task-submit-btn',el=>el.disabled),true);
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
    await page.click('#task-form-save-status [data-task-save-check]');
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-title',el=>el.value),'Retry after check');
    await page.click('#task-submit-btn');
    for(let attempt=0;attempt<100&&requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length<2;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,2);
  }finally{putOutcome=null;await page.dispose();}
});

test('an applied edit with a lost response blocks replay and keeps the draft',async()=>{
  const source={...task,permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,quietLive:true});try{
    putOutcome='applied_unknown';await set(page,'#task-title','Saved without response');await page.click('#task-submit-btn');
    await page.waitForSelector('#task-form-save-status [data-task-save-check]');
    await page.click('#task-form-save-status [data-task-save-check]');
    await page.waitForFunction(()=>/changed/i.test(document.querySelector('#task-form-save-status')?.textContent||''));
    assert.equal(await page.$eval('#task-submit-btn',el=>el.disabled),true);
    assert.equal(await page.$eval('#task-title',el=>el.value),'Saved without response');
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
  }finally{putOutcome=null;await page.dispose();}
});

test('revision conflict keeps draft and cannot submit the stale version again',async()=>{
  const source={...task,permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,quietLive:true});try{
    putOutcome='conflict';await set(page,'#task-title','My local title');await page.click('#task-submit-btn');
    await page.waitForSelector('#task-form-save-status [data-task-save-check]');
    assert.equal(await page.$eval('#task-submit-btn',el=>el.disabled),true);
    assert.equal(await page.$eval('#task-title',el=>el.value),'My local title');
    await page.click('#task-submit-btn');
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
  }finally{putOutcome=null;await page.dispose();}
});

test('uncertain future-series edit never unlocks on an unchanged occurrence revision',async()=>{
  const source={...task,recurrence_series_id:9,recurrence_series_revision:3,
    permissions:{edit:true,edit_series:true,change_dates:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,quietLive:true});try{
    putOutcome='future_unknown';await set(page,'#task-title','New future title');await page.click('#task-submit-btn');
    await page.waitForSelector('#task-edit-scope-form');
    await page.click('[name="edit_scope"][value="future"]');
    await page.click('#task-scope-apply');
    await page.waitForFunction(()=>/series save result is uncertain/i.test(document.querySelector('#task-form-save-status')?.textContent||''));
    assert.equal(await page.$eval('#task-submit-btn',el=>el.disabled),true);
    assert.equal(await page.$('#task-form-save-status [data-task-save-check]'),null);
    assert.equal(editing.revision,source.revision);
    assert.equal(editing.recurrence_series_revision,4);
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
  }finally{putOutcome=null;await page.dispose();}
});

test('an acknowledged save stays successful when its later list refresh fails',async()=>{
  const source={...task,permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:1366,refreshOnSave:true});try{
    await set(page,'#task-title','Saved despite refresh failure');
    await page.evaluate(()=>{window.__failSaveRefresh=true;});
    await page.click('#task-submit-btn');
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
    assert.equal(await page.evaluate(()=>window.toasts.some(message=>String(message).includes('Task saved, but the list could not refresh'))),true);
  }finally{await page.dispose();}
});

test('title-only edit does not replace unchanged documents',async()=>{
  const source={...task,documents:[],tags:[],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:1366,quietLive:true});try{
    await set(page,'#task-title','Only the title changed');
    await page.click('#task-submit-btn');
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70/documents').length,0);
    assert.equal(requests.filter(row=>row.method==='GET'&&row.path==='/tasks/tags').length,1,
      'a save refreshes tags changed by another client');
  }finally{await page.dispose();}
});

test('removing a linked document still sends its replacement set',async()=>{
  const source={...task,documents:[{id:211,name:'Evidence',mime_type:'text/plain'}],tags:[],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:1366,quietLive:true});try{
    await page.click('[data-doc-attach-remove]');
    await page.click('#task-submit-btn');
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const replacement=requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70/documents');
    assert.equal(replacement.length,1);
    assert.deepEqual(replacement[0].body.document_ids,[]);
  }finally{await page.dispose();}
});

test('upload completion does not invent a newer draft or repeat the Task save',async()=>{
  const source={...task,documents:[],tags:[],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,quietLive:true});try{
    await set(page,'#task-title','Proof attached');
    await page.$eval('[data-doc-attach-input]',input=>{const files=new DataTransfer();files.items.add(new File(['one'],'proof.txt',{type:'text/plain'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.waitForSelector('[data-doc-attach-chips] [data-doc-attach-remove]');
    await page.click('#task-submit-btn');await page.waitForFunction(()=>!document.querySelector('#task-form'));
    assert.equal(requests.filter(row=>row.method==='POST'&&row.path==='/documents').length,1);
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70').length,1);
    assert.equal(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70/documents').length,1);
  }finally{await page.dispose();}
});

test('multiple pending uploads use the submitted private visibility after the form changes',async()=>{
  const source={...task,visibility:'private',documents:[],tags:[],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,quietLive:true});try{
    await set(page,'#task-title','Private proof');
    await page.$eval('[data-doc-attach-input]',input=>{const files=new DataTransfer();files.items.add(new File(['one'],'proof1.txt',{type:'text/plain'}));files.items.add(new File(['two'],'proof2.txt',{type:'text/plain'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
    holdDocument=true;await page.click('#task-submit-btn');
    for(let attempt=0;attempt<100&&!heldDocumentResponse;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(heldDocumentResponse);
    await set(page,'#task-visibility','all');
    const first=heldDocumentResponse;heldDocumentResponse=null;first.res.json(first.result);
    for(let attempt=0;attempt<100&&requests.filter(row=>row.method==='POST'&&row.path==='/documents').length<2;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(requests.filter(row=>row.method==='POST'&&row.path==='/documents').map(row=>row.body.visibility),['private','private']);
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-visibility',el=>el.value),'all','newer draft remains');
  }finally{holdDocument=false;heldDocumentResponse?.res.json(heldDocumentResponse.result);heldDocumentResponse=null;await page.dispose();}
});

test('a file added during an upload remains in the next draft',async()=>{
  const source={...task,documents:[],tags:[],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
  const page=await mounted({task:source,width:390,quietLive:true});try{
    await set(page,'#task-title','Attach one file');
    const add=async name=>page.$eval('[data-doc-attach-input]',(input,name)=>{
      const files=new DataTransfer();files.items.add(new File([name],name,{type:'text/plain'}));
      input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    },name);
    await add('first.txt');holdDocument=true;await page.click('#task-submit-btn');
    for(let attempt=0;attempt<100&&!heldDocumentResponse;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(heldDocumentResponse);
    await add('later.txt');
    const first=heldDocumentResponse;heldDocumentResponse=null;first.res.json(first.result);
    await page.waitForFunction(()=>document.querySelector('#task-submit-btn')?.disabled===false);
    assert.equal(await page.$eval('#task-title',el=>el.value),'Attach one file');
    assert.equal(requests.filter(row=>row.method==='POST'&&row.path==='/documents').length,1);
    assert.deepEqual(requests.filter(row=>row.method==='PUT'&&row.path==='/tasks/70/documents')[0].body.document_ids,[211]);
    assert.match(await page.$eval('#task-form-save-status',el=>el.textContent),/newer edits/i);
  }finally{holdDocument=false;heldDocumentResponse?.res.json(heldDocumentResponse.result);heldDocumentResponse=null;await page.dispose();}
});

test('adding a Task tag refreshes the filter catalogue after save',async()=>{
  const source={...task,documents:[],tags:[],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true,change_category_tags:true}};
  const page=await mounted({task:source,width:1366,quietLive:true});try{
    await set(page,'#task-tag-input','new-label');
    await page.click('#task-submit-btn');
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    assert.equal(requests.filter(row=>row.method==='GET'&&row.path==='/tasks/tags').length,1);
  }finally{await page.dispose();}
});

test('Task inspection uses saved skill names and defers form catalogues until Edit',async()=>{
  const page=await mounted({width:1366});try{
    editing={...task,skill_ids:[7],skills:[{id:7,name:'Hammer'}],permissions:{edit:true,change_assignment:true,change_points:true,change_required_skills:true}};
    await page.evaluate(async()=>{const {closeModal}=await import('/components/modal.js');await closeModal({force:true});});
    requests.length=0;
    await page.evaluate(async()=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(70,{user:{id:1,role:'admin'}});});
    assert.equal(requests.filter(row=>row.path==='/planning/places').length,0);
    assert.equal(requests.filter(row=>row.path==='/planning/place-search/status').length,0);
    assert.equal(requests.filter(row=>row.path==='/preferences').length,0);
    assert.equal(requests.filter(row=>row.path==='/automation/activity-options').length,0);
    assert.match(await page.$eval('.detail-view__pane',element=>element.textContent),/Hammer/);
    await page.click('#detail-view-edit');await page.waitForSelector('#task-form');
    assert.equal(requests.filter(row=>row.path==='/planning/places').length,1);
    assert.equal(requests.filter(row=>row.path==='/planning/place-search/status').length,1);
    assert.equal(requests.filter(row=>row.path==='/preferences').length,1);
    assert.equal(requests.filter(row=>row.path==='/automation/activity-options').length,1);
    await set(page,'#task-title','Retained unsaved title');
    await page.click('.modal-panel__action');
    await page.waitForSelector('.detail-view__pane:not([hidden])');
    await page.click('.modal-panel__action');
    await page.waitForSelector('#task-form');
    assert.equal(await page.$eval('#task-title',element=>element.value),'Retained unsaved title');
    assert.equal(requests.filter(row=>row.path==='/planning/places').length,1,'returning to draft does not refetch Places');
    assert.equal(requests.filter(row=>row.path==='/planning/place-search/status').length,1);
    assert.equal(requests.filter(row=>row.path==='/preferences').length,1);
    assert.equal(requests.filter(row=>row.path==='/automation/activity-options').length,1);
  }finally{await page.dispose();}
});

test('live Task refresh reads comments only when the Task revision changes',async()=>{
  const page=await mounted({task:{...task,permissions:{edit:true}},width:1366,quietLive:true});try{
    const count=path=>requests.filter(row=>row.method==='GET'&&row.path===path).length;
    for(let n=0;n<50&&!count('/tasks/70/comments');n++)await new Promise(resolve=>setTimeout(resolve,10));
    const initialComments=count('/tasks/70/comments');
    const initialDetails=count('/tasks/70');
    assert.equal(initialComments,1);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('task-data-changed')));
    for(let n=0;n<50&&count('/tasks/70')===initialDetails;n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(count('/tasks/70')>initialDetails,'live event still verifies Task access');
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(count('/tasks/70/comments'),initialComments,'unchanged revision does not reread comments');
    editing.revision++;
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('task-data-changed')));
    for(let n=0;n<50&&count('/tasks/70/comments')===initialComments;n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(count('/tasks/70/comments'),initialComments+1,'changed revision refreshes comments');
  }finally{await page.dispose();}
});

test('closed Activity history loads only when opened',async()=>{
  const page=await mounted({task:{...task,permissions:{edit:true}},width:1366,quietLive:true});try{
    const count=()=>requests.filter(row=>row.method==='GET'&&row.path==='/tasks/70/activity').length;
    assert.equal(count(),0,'closed disclosure should not fetch Activity history');
    await page.$eval('.task-detail-activity-disclosure',element=>{element.open=true;});
    for(let n=0;n<50&&!count();n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(count(),1,'opening Activity history fetches it');
  }finally{await page.dispose();}
});

test('a rejected rapid status change stays visible for a deliberate retry',async()=>{
  const source={...task,permissions:{edit:true,complete:true,reopen:true,change_assignment:true,change_points:true}};
  const page=await mounted({task:source,width:1366});try{
    await page.click('.modal-panel__action');
    await page.waitForSelector('.task-detail-status select');
    statusRejectOnce=true;
    await page.select('.task-detail-status select','in_progress');
    await page.waitForFunction(()=>window.toasts.some(message=>String(message).includes('Too many requests')));
    assert.equal(editing.status,'open','the rejected write never changed the task');
    assert.equal(await page.$eval('.task-detail-status select',element=>element.value),'open');
    await page.select('.task-detail-status select','in_progress');
    await page.waitForFunction(()=>document.querySelector('.task-detail-status select')?.value==='in_progress');
    assert.equal(editing.status,'in_progress');
    assert.equal(requests.filter(row=>row.path==='/tasks/70/status'&&row.method==='PATCH').length,2);
  }finally{statusRejectOnce=false;await page.dispose();}
});
