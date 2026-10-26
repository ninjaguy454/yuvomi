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
const fixturePermissions=allowed=>({admin:allowed,capabilities:Object.fromEntries(['tasks.create','tasks.change_priority','tasks.change_points','tasks.change_category_tags','tasks.change_dates','tasks.change_assignment','tasks.reassign','tasks.change_required_skills','activities.view','workflows.view','workflows.run'].map(key=>[key,key==='tasks.change_points'&&!allowed?'deny':'allow']))});
app.use('/api/v1',(req,res)=>{
  requests.push({method:req.method,path:req.path,body:structuredClone(req.body)});
  if(req.path==='/auth/me'){
    const role=req.headers.cookie?.includes('scoring-role=member')?'member':'admin';
    const permissions=fixturePermissions(!req.headers.cookie?.includes('scoring-points=deny'));
    permissions.admin=permissions.admin&&role==='admin';
    return res.json({user:{...members[0],role},permissions});
  }
  if(req.path==='/tasks/70/scoring-preview') { const value=structuredClone(preview),error=structuredClone(previewError);return setTimeout(()=>error?res.status(error.status).json(error):res.json({data:value}),previewDelay); }
  if(req.path==='/tasks/70/subtasks/reassign/preview')return res.json({data:{preview_hash:'a'.repeat(64),can_apply:true,conflicts:[],
    changes:req.body.task_ids.map(id=>({task_id:id,title:'Step',before_user_ids:[2],after_user_ids:[3],changed:true}))}});
  if(req.path==='/tasks/70/subtasks/reassign/apply'){
    editing.subtasks[0]={...editing.subtasks[0],assigned_to:3,assigned_users:[members[2]],assigned_user_ids:[3],revision:editing.subtasks[0].revision+1,
      occurrence_assignment_override:{mode:'replace',after_user_ids:[3]}};
    editing.revision++;
    return res.json({data:{changes:[{task_id:71,title:'Step',before_user_ids:[2],after_user_ids:[3],changed:true}]}});
  }
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
    const {setPermissions}=await import('/permissions.js');setPermissions({admin:pointsAllowed&&user.role==='admin',capabilities:Object.fromEntries(['tasks.create','tasks.change_priority','tasks.change_points','tasks.change_category_tags','tasks.change_dates','tasks.change_assignment','tasks.reassign','tasks.change_required_skills','activities.view','workflows.view','workflows.run'].map(key=>[key,key==='tasks.change_points'&&!pointsAllowed?'deny':'allow']))});
    const {render}=await import('/pages/tasks.js');window.disposeScoringPage=await render(document.querySelector('#fixture'),{user});
  },{pointsAllowed,user,quietLive});
  if(task){await page.evaluate(async({user,refreshOnSave})=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(70,{user,onChanged:refreshOnSave?async()=>{window.__saveRefreshStarted=true;if(window.__failSaveRefresh)throw Error('Synthetic refresh failure');await fetch('/api/v1/tasks');window.__saveRefreshFinished=true;}:()=>{}});},{user,refreshOnSave});await page.click('#detail-view-edit');}
  else await page.$eval(width<1024?'#fab-new-task':'#btn-new-task',el=>el.click());
  await page.waitForSelector('#task-form');page.dispose=async()=>{await page.evaluate(()=>window.disposeScoringPage?.());await context.close();assert.deepEqual(pageErrors,[],'fixture has no unhandled page errors');};return page;
}
async function set(page,selector,value){await page.$eval(selector,(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);}
const scoring={mode:'whole_task',root_task_id:70,mode_locked:false,review_required:false,earned:[{user_id:1,points:4}],potential:[{user_id:1,points:3}],personal_total:7,settled_task_ids:[],settlements:[]};
const task={id:70,title:'Routine',description:'',status:'open',points:999,assigned_to:1,assigned_users:[members[0]],priority:'none',category:'misc',revision:4,subtasks:[],scoring};

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

test('mobile occurrence Reassign previews and saves separately while retaining the activity draft',async()=>{
  const editable={edit:true,change_assignment:true,reassign:true,change_points:true,change_required_skills:true};
  const source={...task,permissions:editable,subtasks:[{id:71,title:'Step',status:'open',points:0,revision:1,
    assigned_to:2,assigned_users:[members[1]],assigned_user_ids:[2],permissions:editable}]};
  const page=await mounted({task:source,width:390});try{
    await set(page,'#task-title','Unsaved parent title');
    await page.click('[data-occurrence-person="2"]');
    await page.click('[data-occurrence-task="71"]');
    await set(page,'[data-occurrence-replacement]','3');
    assert.equal(await page.$eval('[data-occurrence-mode] option[value="rebalance"]',el=>el.disabled),true);
    await page.click('[data-occurrence-preview]');
    await page.waitForSelector('[data-occurrence-apply]:not([hidden])');
    assert.equal(requests.filter(row=>row.path.endsWith('/subtasks/reassign/apply')).length,0);
    await page.click('[data-occurrence-apply]');
    await page.waitForFunction(()=>document.querySelector('[data-occurrence-result]')?.textContent.includes('Saved for this occurrence'));
    assert.equal(await page.$eval('#task-title',el=>el.value),'Unsaved parent title');
    assert.equal(await page.$eval('[data-task-subtask-assignee]',el=>el.value),'3');
    assert.equal(requests.filter(row=>row.path.endsWith('/subtasks/reassign/apply')).length,1);
    assert.equal(requests.some(row=>row.method==='PUT'&&row.path==='/tasks/70'),false);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    assert.equal(overflow,false);
  }finally{await page.dispose();}
});
test('invalid active root amount is rejected without truncation or a create request',async()=>{
  const page=await mounted();try{await set(page,'#task-title','Invalid points');await set(page,'#task-points','10001');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form')||!document.querySelector('#task-form-error')?.hidden);
    assert.equal(requests.some(r=>r.method==='POST'&&r.path==='/tasks'),false);assert.equal(await page.$eval('#task-points',el=>el.getAttribute('aria-invalid')),'true');
  }finally{await page.dispose();}
});
test('authoritative personal gross total and explicit unavailable scoring never use configured points',async()=>{
  const page=await mounted();try{const values=await page.evaluate(async task=>{const {taskCompletionPoints}=await import('/utils/task-fields.js');return [taskCompletionPoints(task),taskCompletionPoints({...task,scoring:null})];},task);assert.deepEqual(values,[7,null]);}
  finally{await page.dispose();}
});

for(const [name,bootstrap,expected] of [
  ['anonymous device',{principal:{kind:'device'},device:{id:9}},2],
  ['temporary device member',{principal:{kind:'member'},user:{id:1},device:{id:9},temporary:{}},2],
  ['personal member',{principal:{kind:'member'},user:{id:1}},0],
])test(`${name} uses the same score on real cards, accessible badges and Task Details`,async()=>{
    const page=await mounted({user:{id:1,role:'member'}});editing={...task,points:2,assigned_to:2,scoring:{...scoring,configured_total:2,personal_total:0,earned:[],potential:[{user_id:2,points:2}]}};
  try{
    const card=await page.evaluate(async({task,bootstrap})=>{
      const {closeModal}=await import('/components/modal.js');await closeModal({force:true});
      const {acceptAuthentication}=await import('/utils/device-context.js');acceptAuthentication({authContext:'badge-fixture',...bootstrap});
      const {__test}=await import('/pages/tasks.js');__test.state.currentUserId=1;
      const card=new DOMParser().parseFromString(__test.renderTaskCard(task),'text/html').querySelector('.activity-card__points');
      const {openTaskDetail}=await import('/components/task-detail.js');openTaskDetail({task,currentUserId:1});
      return {points:card.textContent,label:card.getAttribute('aria-label'),title:card.title};
    },{task:editing,bootstrap});
    assert.equal(card.points,String(expected));assert.equal(card.label,card.title);
    await page.waitForSelector('.task-detail-points');
    const detail=await page.$eval('.task-detail-points',el=>el.textContent);assert.equal(detail,card.label);
    if(expected===2){assert.match(card.label,/2/);assert.doesNotMatch(card.label,/Known earned|Potential/i);}
    else assert.match(card.label,/0/);
  }finally{await page.dispose();}
});
test('canonical executable Activity under a Workflow still offers its root mode and action editor',async()=>{
  const page=await mounted();try{const markup=await page.evaluate(async task=>{const {__test}=await import('/pages/tasks.js');return __test.renderModalContent({task:{...task,parent_task_id:50},users:[]});},task);assert.match(markup,/name="scoring_mode"/);assert.match(markup,/data-task-subtask-editor/);}
  finally{await page.dispose();}
});

test('resolved non-admin denied points capability disables mode and amount controls',async()=>{
  const page=await mounted({pointsAllowed:false});try{assert.equal(await page.$eval('#task-scoring-mode',el=>el.disabled),true);assert.equal(await page.$eval('#task-points',el=>el.disabled),true);}finally{await page.dispose();}
});
test('invalid inactive amount stays in the local draft and is omitted from a valid whole-task create',async()=>{
  const page=await mounted();try{await page.$eval('[data-task-subtask-add]',el=>el.click());await page.waitForSelector('[data-task-subtask-title]');await set(page,'[data-task-subtask-title]','Optional draft');await set(page,'[data-task-subtask-points]','1.5');await set(page,'#task-title','Whole task');
    assert.equal(await page.$eval('[data-task-subtask-points]',el=>el.value),'1.5');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const saved=requests.find(r=>r.method==='POST'&&r.path==='/tasks');assert.equal(saved.body.scoring_mode,'whole_task');assert.equal(Object.hasOwn(saved.body.subtasks[0],'points'),false);
  }finally{await page.dispose();}
});
const futureFields={title:'Canonical future',description:null,category:'misc',priority:'none',scoring_mode:'subtasks',points:11,assigned_to:[2],skill_ids:[],tags:[],assignment_mode:'fixed',rotation_user_ids:[],rotation_group:null,rotation_slot:0,start_date:null,start_time:null,due_date:'2026-11-02',due_time:null,is_recurring:1,recurrence_rule:'FREQ=DAILY',recurrence_from_completion:0,visibility:'all',countdown:0,locked:0,expiration_policy:'keep_overdue'};
const futureTask={...task,is_recurring:1,recurrence_rule:'FREQ=DAILY',recurrence_series_id:40,recurrence_series_revision:8,permissions:Object.fromEntries(['edit','edit_series','change_points','change_dates','change_assignment','change_required_skills','change_priority','change_category_tags','complete'].map(key=>[key,true]))};
function futurePreview(){return {mode:'subtasks',mode_locked:true,review_required:false,valid:true,scope:'future_only',current_preserved:true,earned:[{user_id:1,points:4}],before:[{user_id:3,points:7}],after:[{user_id:3,points:7}],warnings:[],settlements:[],before_units:[{ref:{kind:'action',action_key:'a'},title:'Future action',is_optional:false,points:7,recipients:[{user_id:3,points:7}],outcome:'earned'}],after_units:[{ref:{kind:'action',action_key:'a'},title:'Future action',is_optional:false,points:7,recipients:[{user_id:3,points:7}],outcome:'earned'}],forecast_context:{kind:'next_occurrence',effective_generation:1,as_of_date:'2026-11-01',before:{due_date:'2026-11-02',preparation:'fresh'},after:{due_date:'2026-11-02',preparation:'fresh'},conditions:[]},edit_definition:{task_id:70,effective_generation:1,review_required:false,permissions:futureTask.permissions,fields:futureFields,actions:[{action_key:'a',fields:{title:'Future action',points:7,is_optional:false,skill_ids:[],assigned_user_ids:[]},permissions:futureTask.permissions}],revisions:{expected_revision:4,expected_series_revision:8}}};}

function twoActionPreview(){
  const value=futurePreview();value.edit_definition.actions.push({action_key:'b',fields:{title:'Second action',points:5,is_optional:true,skill_ids:[7],assigned_user_ids:[]},permissions:futureTask.permissions});
  for(const phase of ['before','after'])value[`${phase}_units`].push({ref:{kind:'action',action_key:'b'},title:'Second action',is_optional:true,points:5,recipients:[{user_id:3,points:5}],outcome:'earned'});
  return value;
}
async function enterFuture(page){await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');}
async function submitPreview(page){const sent=page.waitForRequest(req=>req.method()==='POST'&&req.url().endsWith('/tasks/70/scoring-preview'));await page.$eval('#task-submit-btn',el=>el.click());await sent;}
async function waitPreviewResult(page){await page.waitForFunction(()=>document.querySelector('#task-scoring-confirm')||document.querySelector('#task-form-error')?.textContent.includes('draft changed'));}
const rowSelector=key=>`[data-task-subtask-row][data-action-key="${key}"]`;

for(const mutation of ['remove','reorder'])test(`round1 delayed ${mutation} rejects the old patch and saves only fresh stable-key intent`,async()=>{
  preview=twoActionPreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{
    await enterFuture(page);await set(page,`${rowSelector('a')} [data-task-subtask-points]`,'8');previewDelay=500;await submitPreview(page);
    await page.$eval(`${rowSelector('b')} [data-task-subtask-action="${mutation==='remove'?'remove':'up'}"]`,el=>el.click());
    const order=await page.$$eval('[data-task-subtask-row]',rows=>rows.map(row=>row.dataset.actionKey));assert.deepEqual(order,mutation==='remove'?['a']:['b','a']);await waitPreviewResult(page);
    const state=await page.evaluate(()=>({confirmation:!!document.querySelector('#task-scoring-confirm'),enabled:document.querySelector('#task-scoring-confirm')?.disabled===false,error:document.querySelector('#task-form-error')?.textContent}));
    console.log('SCORING_ROUND1_DELAYED',JSON.stringify({mutation,order,state,old_patch:requests.filter(row=>row.path.endsWith('/scoring-preview')).at(-1).body.future_patch}));assert.equal(state.confirmation,false,'an old structural preview cannot be confirmed');assert.match(state.error,/draft changed/);assert.equal(requests.some(row=>row.method==='PUT'),false);
    previewDelay=0;await page.waitForFunction(()=>!document.querySelector('#task-submit-btn').disabled);await submitPreview(page);await page.waitForSelector('#task-scoring-confirm');assert.equal(await page.$eval('#task-scoring-confirm',el=>el.disabled),false);
    const fresh=requests.filter(row=>row.path.endsWith('/scoring-preview')).at(-1).body;assert.deepEqual(fresh.future_patch,{actions:{update:[{action_key:'a',fields:{points:8}}],...(mutation==='remove'?{remove:['b']}:{ }),order}});
    await page.focus('#task-scoring-confirm');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#task-form'));const saves=requests.filter(row=>row.method==='PUT');assert.equal(saves.length,1);assert.deepEqual(saves[0].body,fresh);
  }finally{previewDelay=0;await page.dispose();}
});

test('round1 button-only addition and optional changes invalidate delayed preview without losing client keys',async()=>{
  for(const mutation of ['add','optional']){
    preview=twoActionPreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{
      await enterFuture(page);await set(page,`${rowSelector('a')} [data-task-subtask-points]`,'8');previewDelay=500;await submitPreview(page);
      if(mutation==='add')await page.$eval('[data-task-subtask-add]',el=>el.click());else await page.$eval(`${rowSelector('b')} [data-task-subtask-optional]`,el=>el.click());await waitPreviewResult(page);assert.equal(await page.$('#task-scoring-confirm'),null);assert.equal(requests.some(row=>row.method==='PUT'),false);
      if(mutation==='add'){
        await set(page,'[data-task-subtask-row]:last-child [data-task-subtask-title]','Extra action');await set(page,'[data-task-subtask-row]:last-child [data-task-subtask-points]','0');previewDelay=0;await submitPreview(page);await page.waitForSelector('#task-scoring-confirm');const intent=requests.filter(row=>row.path.endsWith('/scoring-preview')).at(-1).body.future_patch;const key=intent.actions.add[0].client_key;assert.equal(intent.actions.add[0].fields.points,0);assert.deepEqual(intent.actions.order,['a','b',`new:${key}`]);await page.$eval('[data-scoring-cancel]',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-scoring-preview-form'));assert.equal(await page.$eval('[data-task-subtask-row]:last-child',el=>el.dataset.clientKey),key);assert.equal(await page.$eval('#task-submit-btn',el=>el===document.activeElement),true);assert.equal(requests.some(row=>row.method==='PUT'),false);
      }
    }finally{previewDelay=0;await page.dispose();}
  }
});

test('round1 already-open preview rejects a programmatic structural control activation safeguard',async()=>{
  // The parent form is inert under a child modal. This deliberately invokes its
  // semantic handler; it is not evidence of reachable background pointer input.
  preview=twoActionPreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{
    await enterFuture(page);await set(page,`${rowSelector('a')} [data-task-subtask-points]`,'8');await submitPreview(page);await page.waitForSelector('#task-scoring-confirm');await page.$eval(`${rowSelector('b')} [data-task-subtask-action="remove"]`,el=>el.click());assert.equal(await page.$eval('#task-scoring-confirm',el=>el.disabled),true);await page.$eval('#task-scoring-preview-form',el=>el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(requests.some(row=>row.method==='PUT'),false);await page.$eval('[data-scoring-cancel]',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-scoring-preview-form'));assert.equal(await page.$eval(`${rowSelector('a')} [data-task-subtask-points]`,el=>el.value),'8');assert.equal(await page.$(rowSelector('b')),null);
  }finally{await page.dispose();}
});

test('round1 actual GET suppressed history uses neutral wording and preserves outcome opposites',async()=>{
  const rows=[{task_id:2,points:4,recipients:[{user_id:2,points:4}],mode:'subtasks',outcome:'earned',settled_at:'2026-10-12T04:50:51.395Z'},{task_id:3,points:0,recipients:[],mode:'subtasks',outcome:'zero',settled_at:'2026-10-12T04:50:51.439Z'},{task_id:1,points:0,recipients:[],mode:'subtasks',outcome:'suppressed',settled_at:'2026-10-12T04:50:51.447Z'},{task_id:1,points:5,recipients:[],mode:'whole_task',outcome:'no_recipients'},{task_id:1,points:null,recipients:[],mode:'legacy',outcome:'earned'}];
  const page=await mounted();try{
    const result=await page.evaluate(async({rows,members})=>{
      const {renderTaskScoringHistory}=await import('/utils/task-fields.js');const doc=new DOMParser().parseFromString(renderTaskScoringHistory({scoring:{settlements:rows}},members),'text/html');
      return {heading:doc.querySelector('summary').textContent,items:[...doc.querySelectorAll('li')].map(row=>row.textContent),identities:doc.querySelectorAll('[data-scoring-settlement]').length};
    },{rows,members});console.log('SCORING_ROUND1_HISTORY',JSON.stringify(result));
    assert.equal(result.items.length,5);assert.equal(result.identities,0);assert.match(result.items[2],/: 0.*No points awarded/);assert.doesNotMatch(result.items[2],/Known earned|eligible|expired|skipped/i);assert.equal(result.heading,'Points history');
    assert.match(result.items[0],/Eleanor: 4/);assert.match(result.items[1],/Zero points/);assert.match(result.items[3],/No eligible recipient/);assert.match(result.items[4],/Original amount unavailable/);assert.doesNotMatch(result.items[4],/Known earned|No eligible recipient/);
  }finally{await page.dispose();}
});

test('round1 canonical rebase and scope restore keep sparse intent empty and matching confirmation usable',async()=>{
  preview=twoActionPreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{
    await enterFuture(page);await submitPreview(page);await page.waitForSelector('#task-scoring-confirm');assert.deepEqual(requests.filter(row=>row.path.endsWith('/scoring-preview')).at(-1).body.future_patch,{});assert.equal(await page.$eval('#task-scoring-confirm',el=>el.disabled),false);await page.$eval('[data-scoring-cancel]',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-scoring-preview-form')&&!document.querySelector('#task-submit-btn').disabled);
    await page.select('#task-scoring-scope','occurrence');await page.select('#task-scoring-scope','future_only');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');assert.deepEqual(await page.$$eval('[data-task-subtask-row]',rows=>rows.map(row=>row.dataset.actionKey)),['a','b']);await submitPreview(page);await page.waitForSelector('#task-scoring-confirm');assert.deepEqual(requests.filter(row=>row.path.endsWith('/scoring-preview')).at(-1).body.future_patch,{});assert.equal(await page.$eval('#task-scoring-confirm',el=>el.disabled),false);await page.$eval('[data-scoring-cancel]',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-scoring-preview-form'));assert.equal(requests.some(row=>row.method==='PUT'),false);
  }finally{await page.dispose();}
});

test('round1 current occurrence structural changes reject a delayed scoring preview too',async()=>{
  const current={...task,points:11,permissions:futureTask.permissions,scoring:{...scoring,mode:'subtasks'},subtasks:[{id:71,title:'First current action',status:'open',points:7,skill_ids:[],permissions:futureTask.permissions},{id:72,title:'Second current action',status:'open',points:5,skill_ids:[7],is_optional:true,permissions:futureTask.permissions}]};
  preview={...twoActionPreview(),scope:'occurrence',forecast_context:undefined,edit_definition:undefined};previewError=null;previewDelay=0;const page=await mounted({task:current});try{
    await set(page,'#task-form [data-subtask-id="71"] [data-task-subtask-points]','8');previewDelay=500;await submitPreview(page);await page.$eval('#task-form [data-subtask-id="72"] [data-task-subtask-action="remove"]',el=>el.click());await waitPreviewResult(page);assert.equal(await page.$('#task-scoring-confirm'),null);assert.match(await page.$eval('#task-form-error',el=>el.textContent),/draft changed/);assert.equal(requests.some(row=>row.method==='PUT'),false);assert.equal(await page.$('#task-form [data-subtask-id="72"]'),null);assert.equal(await page.$eval('#task-form [data-subtask-id="71"] [data-task-subtask-points]',el=>el.value),'8');
  }finally{previewDelay=0;await page.dispose();}
});
test('future-only loads canonical fields and absent-current actions then previews and saves identical sparse intent',async()=>{
  preview=futurePreview();previewError=null;previewDelay=0;
  const page=await mounted({task:futureTask});try{
    assert.equal(await page.$eval('#task-title',el=>el.value),'Routine');await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');assert.equal(await page.$eval('#task-scoring-scope',el=>el.value),'future_only');
    assert.equal(await page.$eval('[data-task-subtask-title]',el=>el.value),'Future action');
    await page.click('[name="scoring_mode"][value="whole_task"]');await set(page,'#task-points','0');
    await page.$eval('#task-submit-btn',el=>el.click());await page.waitForSelector('#task-scoring-confirm');await page.focus('#task-scoring-confirm');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const save=requests.find(r=>r.method==='PUT'&&r.path==='/tasks/70'),check=requests.filter(r=>r.path.endsWith('/scoring-preview')).at(-1);
    assert.deepEqual(save.body.future_patch,{fields:{points:0,scoring_mode:'whole_task'}});assert.deepEqual(save.body.future_patch,check.body.future_patch);
    assert.deepEqual(Object.keys(save.body).sort(),['edit_scope','expected_revision','expected_series_revision','future_patch'].sort());assert.equal(requests.some(r=>['POST','DELETE'].includes(r.method)&&r.path==='/reminders'),false);
  }finally{await page.dispose();}
});

test('personal member cards label authoritative earned and potential while keeping circles numeric',async()=>{
  const page=await mounted({user:{id:1,role:'member'}});try{const values=await page.evaluate(async task=>{const {__test}=await import('/pages/tasks.js');return [__test.renderTaskCard(task),__test.renderTaskCard({...task,scoring:null})];},task);
    assert.match(values[0],/Known earned.*4.*Potential.*3/);assert.doesNotMatch(values[1],/>null</);assert.doesNotMatch(values[1],/>999</);
  }finally{await page.dispose();}
});
test('settlement history keeps unknown and compensated rows distinct from readonly configured amounts',async()=>{
  const frozen={...task,scoring:{...scoring,mode:'legacy',mode_locked:true,settled_task_ids:[70],settlements:[{settlement_id:10,task_id:70,points:4,title:'Historical work',recipients:[{user_id:1,points:4}],mode:'legacy',outcome:'earned'},{settlement_id:11,task_id:70,points:null,title:'Historical work',recipients:[],mode:'legacy',outcome:'earned'}]},permissions:futureTask.permissions};
  const page=await mounted({task:frozen});try{
    assert.equal(await page.$eval('#task-points',el=>el.value),'999');assert.equal(await page.$eval('#task-points',el=>el.disabled),true);
    assert.equal(await page.$$eval('[data-scoring-settlement]',rows=>new Set(rows.map(row=>row.dataset.scoringSettlement)).size),2);
    assert.doesNotMatch(await page.$eval('[data-scoring-settlement="11"]',row=>row.textContent),/No eligible recipient/,'lost original evidence is unknown, not ineligible');
    await set(page,'#task-title','Unrelated title');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const save=requests.find(r=>r.method==='PUT'&&r.path==='/tasks/70');assert.equal(Object.hasOwn(save.body,'points'),false);assert.equal(Object.hasOwn(save.body,'scoring_mode'),false);assert.equal(requests.some(r=>r.path.endsWith('/scoring-preview')),false);
  }finally{await page.dispose();}
});
test('late preview cannot confirm a newer future draft',async()=>{
  preview=futurePreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{
    await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');previewDelay=150;
    await set(page,'[data-task-subtask-points]','8');await page.$eval('#task-submit-btn',el=>el.click());
    await set(page,'#task-title','Newer draft');await page.waitForFunction(()=>document.querySelector('#task-form-error')?.textContent.includes('draft changed'));
    assert.equal(requests.some(r=>r.method==='PUT'),false);assert.equal(await page.$('#task-scoring-confirm'),null);
  }finally{previewDelay=0;await page.dispose();}
});

test('ordinary summary history preserves separate neutral rows while preview retains immutable IDs',async()=>{
  const page=await mounted();try{
    const result=await page.evaluate(async()=>{
      const {renderTaskScoringHistory}=await import('/utils/task-fields.js');const {renderTaskScoringPreview}=await import('/utils/task-edit-scope.js');
      const rows=[{task_id:70,points:4,recipients:[{user_id:77,points:4}],mode:'legacy',outcome:'earned'},{task_id:70,points:null,recipients:[],mode:'legacy',outcome:'earned'}];
      const doc=new DOMParser().parseFromString(renderTaskScoringHistory({scoring:{settlements:rows}},[{id:1,display_name:'Alex'}]),'text/html');
      return {summary:doc.body.innerHTML,rowCount:doc.querySelectorAll('li').length,identities:doc.querySelectorAll('[data-scoring-settlement]').length,preview:renderTaskScoringPreview({earned:[],before:[],after:[],settlements:rows.map((row,index)=>({...row,settlement_id:10+index,title:'Frozen work'}))})};
    });assert.equal(result.rowCount,2);assert.equal(result.identities,0);assert.doesNotMatch(result.summary,/undefined|Frozen work|No eligible recipient/);assert.match(result.summary,/Unknown: 4/);assert.match(result.preview,/data-scoring-settlement="10"/);assert.match(result.preview,/data-scoring-settlement="11"/);assert.match(result.preview,/Unknown/);
  }finally{await page.dispose();}
});

test('a child cannot change its canonical owner mode and explicit unavailable owner has no amount authority',async()=>{
  for(const summary of [{...scoring,root_task_id:60,mode:'subtasks',personal_total:3},null]){
    const page=await mounted({task:{...task,parent_task_id:60,scoring:summary,permissions:futureTask.permissions}});try{
      assert.equal(await page.$eval('#task-scoring-mode',el=>el.disabled),true);assert.equal(await page.$('[data-task-subtask-editor]'),null);
      assert.equal(await page.$eval('#task-points',el=>el.disabled),summary===null);assert.match(await page.$eval('#task-scoring-message',el=>el.textContent),summary===null?/unavailable/i:/owns/i);
    }finally{await page.dispose();}
  }
});

test('settled zero and no-recipient work keep amount readonly and omit it from ordinary edits',async()=>{
  for(const outcome of ['zero','no_recipients']){
    const page=await mounted({task:{...task,points:0,permissions:futureTask.permissions,scoring:{...scoring,mode_locked:true,settled_task_ids:[70],settlements:[{task_id:70,points:0,recipients:[],mode:'whole_task',outcome}]}}});try{
      assert.equal(await page.$eval('#task-points',el=>el.disabled),true);await set(page,'#task-title',`Edit ${outcome}`);await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form'));const body=requests.find(row=>row.method==='PUT').body;assert.equal(Object.hasOwn(body,'points'),false);assert.equal(Object.hasOwn(body,'scoring_mode'),false);
    }finally{await page.dispose();}
  }
});

test('explicit unavailable scoring permits unrelated title edits without sending configured amount',async()=>{
  const page=await mounted({task:{...task,scoring:null,permissions:futureTask.permissions}});try{
    await set(page,'#task-title','Safe title');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form'));const body=requests.find(row=>row.method==='PUT').body;assert.equal(Object.hasOwn(body,'points'),false);assert.equal(Object.hasOwn(body,'scoring_mode'),false);assert.equal(requests.some(row=>row.path.endsWith('/scoring-preview')),false);
  }finally{await page.dispose();}
});

test('older API absence leaves edit mode unconfirmed while an ordinary edit omits mode intent',async()=>{
  const page=await mounted({task:{...task,scoring:undefined,permissions:futureTask.permissions}});try{
    assert.equal(await page.$('[name="scoring_mode"]:checked'),null);assert.match(await page.$eval('#task-scoring-message',el=>el.textContent),/older response/i);await set(page,'#task-title','Older edit');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form'));assert.equal(Object.hasOwn(requests.find(row=>row.method==='PUT').body,'scoring_mode'),false);
  }finally{await page.dispose();}
});

test('active fractional subtask rejects save, preserves row identity and focuses the labeled input',async()=>{
  const page=await mounted();try{
    await set(page,'#task-title','Strict actions');await page.click('[name="scoring_mode"][value="subtasks"]');await page.$eval('[data-task-subtask-add]',el=>el.click());await set(page,'[data-task-subtask-title]','Work');await set(page,'[data-task-subtask-points]','1.5');await page.$eval('#task-submit-btn',el=>el.click());const first=await page.$eval('[data-task-subtask-points]',el=>({id:el.id,focus:el===document.activeElement,value:el.value,label:el.getAttribute('aria-label')}));assert.ok(first.id);assert.equal(first.focus,true);assert.equal(first.value,'1.5');assert.match(first.label,/points/);await page.$eval('#task-submit-btn',el=>el.click());assert.equal(await page.$eval('[data-task-subtask-points]',el=>el.id),first.id);assert.equal(requests.some(row=>row.method==='POST'&&row.path==='/tasks'),false);
  }finally{await page.dispose();}
});

test('zero Whole-task prize completion remains governed by the server permission',async()=>{
  const page=await mounted();try{const result=await page.evaluate(async task=>{
    const {__test}=await import('/pages/tasks.js');const render=allowed=>new DOMParser().parseFromString(__test.renderTaskCard({...task,points:0,linked_redemption_id:18,permissions:{complete:allowed},scoring:{...task.scoring,earned:[],potential:[],personal_total:0}}),'text/html').querySelector('[data-action="toggle-status"]').disabled;return [render(true),render(false)];
  },task);assert.deepEqual(result,[false,true]);}finally{await page.dispose();}
});

test('future permissions allow public mode changes despite a locked current mode and scope restore preserves drafts',async()=>{
  preview=futurePreview();previewError=null;previewDelay=0;const page=await mounted({task:{...futureTask,scoring:{...scoring,mode_locked:true}}});try{
    await set(page,'#task-title','Current draft');await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');assert.equal(await page.$eval('#task-scoring-mode',el=>el.disabled),false);await set(page,'[data-task-subtask-points]','1.5');await page.click('[name="scoring_mode"][value="whole_task"]');await page.select('#task-scoring-scope','occurrence');assert.equal(await page.$eval('#task-title',el=>el.value),'Current draft');await page.select('#task-scoring-scope','future_only');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');assert.equal(await page.$eval('[data-task-subtask-points]',el=>el.value),'1.5');assert.equal(await page.$eval('[name="scoring_mode"][value="whole_task"]',el=>el.checked),true);
    await page.$eval('#task-submit-btn',el=>el.click());await page.waitForSelector('#task-scoring-confirm');const patch=requests.filter(row=>row.path.endsWith('/scoring-preview')).at(-1).body.future_patch;assert.deepEqual(patch,{fields:{scoring_mode:'whole_task'}});await page.$eval('[data-scoring-cancel]',el=>el.click());assert.equal(requests.some(row=>row.method==='PUT'),false);
  }finally{await page.dispose();}
});

test('an invalid review preview blocks save while a valid unresolved forecast remains conditional',async()=>{
  preview=futurePreview();preview.valid=false;preview.review_required=true;preview.forecast_context.conditions=['completion_date_assumed','binding_assignment_reprepared','prospective_supervision_unresolved'];preview.warnings=[{reason:'prospective_supervision_unresolved'}];previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{
    await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');await set(page,'[data-task-subtask-points]','8');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForSelector('#task-scoring-confirm');assert.equal(await page.$eval('#task-scoring-confirm',el=>el.disabled),true);assert.match(await page.$eval('.task-scoring-preview',el=>el.textContent),/next occurrence/i);assert.match(await page.$eval('.task-scoring-preview',el=>el.textContent),/supervision.*not currently resolved/i);assert.equal(requests.some(row=>row.method==='PUT'),false);await page.$eval('[data-scoring-cancel]',el=>el.click());
    await page.waitForFunction(()=>!document.querySelector('#task-scoring-preview-form')&&!document.querySelector('#task-submit-btn').disabled);preview.valid=true;await page.$eval('#task-submit-btn',el=>el.click());await page.waitForSelector('#task-scoring-confirm');assert.equal(await page.$eval('#task-scoring-confirm',el=>el.disabled),false);await page.$eval('[data-scoring-cancel]',el=>el.click());assert.equal(requests.some(row=>row.method==='PUT'),false);
  }finally{await page.dispose();}
});

test('canonical future permissions refresh accessible point state and preserve denied action skills',async()=>{
  preview=futurePreview();preview.edit_definition.permissions={...futureTask.permissions,change_required_skills:false};preview.edit_definition.actions[0].fields.skill_ids=[7];preview.edit_definition.actions[0].permissions={...futureTask.permissions,change_required_skills:false};previewError=null;previewDelay=0;
  const page=await mounted({task:{...futureTask,permissions:{...futureTask.permissions,change_priority:false}}});try{
    await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');await page.click('[name="scoring_mode"][value="whole_task"]');assert.equal(await page.$eval('#task-points',el=>el.disabled),false);assert.equal(await page.$eval('#task-priority',el=>el.disabled),false);assert.notEqual(await page.$eval('#task-priority',el=>el.getAttribute('aria-disabled')),'true');assert.equal(await page.$eval('[data-task-subtask-row] [data-task-skill-picker]',el=>el.disabled),true);
  }finally{await page.dispose();}
});

test('canonical future rotation roster replaces current configuration without recipient inference',async()=>{
  preview=futurePreview();preview.edit_definition.fields={...futureFields,assignment_mode:'round_robin',rotation_user_ids:[3,2]};previewError=null;previewDelay=0;
  const page=await mounted({task:futureTask});try{await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');const values=await page.evaluate(async()=>{const {getRotationUserIds}=await import('/components/user-rotation-order.js');return getRotationUserIds(document.querySelector('#task-form'));});assert.deepEqual(values,[3,2]);}
  finally{await page.dispose();}
});
test('ordinary recurring title edits retain the existing occurrence chooser and make no scoring preview',async()=>{
  preview=futurePreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{await set(page,'#task-title','Current title only');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForSelector('#task-edit-scope-form');assert.equal(await page.$eval('[name="edit_scope"]:checked',el=>el.value),'occurrence');await page.focus('#task-scope-apply');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#task-form'));assert.equal(requests.some(r=>r.path.endsWith('/scoring-preview')),false);assert.equal(requests.find(r=>r.method==='PUT').body.edit_scope,'occurrence');}
  finally{await page.dispose();}
});

test('a preserved next target shows authoritative unavailable guidance without a save',async()=>{
  preview=futurePreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');previewError={status:409,reason:'scoring_projection_unavailable',conditions:['target_preserved'],error:'The next occurrence cannot be forecast yet.'};await set(page,'[data-task-subtask-points]','8');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form-error').hidden);assert.match(await page.$eval('#task-form-error',el=>el.textContent),/preserved/i);assert.equal(requests.some(r=>r.method==='PUT'),false);}
  finally{previewError=null;await page.dispose();}
});
test('cancelled preview keeps the original future draft and its stable addition key',async()=>{
  preview=futurePreview();previewError=null;previewDelay=0;const page=await mounted({task:futureTask});try{await page.click('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Canonical future');await page.$eval('[data-task-subtask-add]',el=>el.click());await page.waitForSelector('[data-task-subtask-title]');await set(page,'[data-task-subtask-row]:last-child [data-task-subtask-title]','Extra');await set(page,'[data-task-subtask-row]:last-child [data-task-subtask-points]','0');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForSelector('[data-scoring-cancel]');const key=requests.filter(r=>r.path.endsWith('/scoring-preview')).at(-1).body.future_patch.actions.add[0].client_key;await page.$eval('[data-scoring-cancel]',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-scoring-preview-form'));assert.equal(await page.$eval('[data-task-subtask-row]:last-child',el=>el.dataset.clientKey),key);assert.equal(await page.$eval('[data-task-subtask-row]:last-child [data-task-subtask-title]',el=>el.value),'Extra');assert.equal(requests.some(r=>r.method==='PUT'),false);}
  finally{await page.dispose();}
});
test('Trip presentation deadlines and escaped Next survive scoring while raw editor deadlines stay canonical',async()=>{
  const trip={...task,trip_group:{id:12},due_date:'2026-11-02',due_time:'09:00',display_due_date:'2026-11-07',display_due_time:'10:00',next_trip_step:{title:'<Pack safely>'}};
  const page=await mounted({user:{id:1,role:'member'}});try{const result=await page.evaluate(async task=>{const {__test}=await import('/pages/tasks.js');const {parseDateInput}=await import('/i18n.js');const editor=new DOMParser().parseFromString(__test.renderModalContent({task,users:[]}),'text/html');return {card:__test.renderTaskCard(task),date:__test.taskCalendarDate(task),chip:__test.renderTaskCalendarChip(task),agenda:__test.renderTaskCalendarAgendaRow(task),editorDue:parseDateInput(editor.querySelector('#task-due-date').getAttribute('value')),raw:task.due_date};},trip);assert.equal(result.date,'2026-11-07');assert.equal(result.raw,'2026-11-02');assert.match(result.card,/Next: &lt;Pack safely&gt;/);assert.equal(result.editorDue,'2026-11-02');assert.doesNotMatch(result.card,/>999</);assert.match(result.chip,/10:00/);assert.match(result.agenda,/10:00/);}
  finally{await page.dispose();}
});
for(const width of [320,390])test(`named editable targets fit ${width}px and retain at least44px height`,async()=>{
  const page=await mounted({width});try{const sizes=await page.$$eval('.task-scoring__modes label,#task-points',nodes=>nodes.map(node=>({height:node.getBoundingClientRect().height,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})));assert.ok(sizes.every(size=>size.height>=44&&size.left>=0&&size.right<=width),JSON.stringify(sizes));}
  finally{await page.dispose();}
});
