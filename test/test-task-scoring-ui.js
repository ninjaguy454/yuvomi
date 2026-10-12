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
let editing=null, preview=null, previewDelay=0, previewError=null;
const app=express();app.use(express.json());
const fixturePermissions=allowed=>({admin:allowed,capabilities:Object.fromEntries(['tasks.create','tasks.change_priority','tasks.change_points','tasks.change_category_tags','tasks.change_dates','tasks.change_assignment','tasks.change_required_skills','activities.view','workflows.view','workflows.run'].map(key=>[key,key==='tasks.change_points'&&!allowed?'deny':'allow']))});
app.use('/api/v1',(req,res)=>{
  requests.push({method:req.method,path:req.path,body:structuredClone(req.body)});
  if(req.path==='/auth/me')return res.json({user:members[0],permissions:fixturePermissions(!req.headers.cookie?.includes('scoring-points=deny'))});
  if(req.path==='/tasks/70/scoring-preview') { const value=structuredClone(preview),error=structuredClone(previewError);return setTimeout(()=>error?res.status(error.status).json(error):res.json({data:value}),previewDelay); }
  if(req.path==='/tasks/70')return res.json({data:req.method==='PUT'?{...editing,revision:editing.revision+1}:editing,series_edit:req.method==='PUT'?{scope:req.body.edit_scope,current_preserved:req.body.edit_scope==='future_only',revision:9,created_actions:[]}:undefined});
  if(req.path==='/tasks'&&req.method==='POST')return res.json({data:{id:99,...req.body}});
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
  browser=await puppeteer.launch({headless:true,pipe:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--disable-dev-shm-usage']});
  const processHandle=browser.process();ownedBrowser={pid:processHandle.pid,profile:processHandle.spawnargs.find(arg=>arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length),processHandle};
});
test.after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve)||resolve());if(ownedBrowser)console.log('SCORING_UI_OWNED_CLEANUP',JSON.stringify({node_pid:process.pid,chrome_pid:ownedBrowser.pid,chrome_exit:ownedBrowser.processHandle.exitCode,server_listening:server.listening,profile:ownedBrowser.profile,profile_removed:ownedBrowser.profile?!existsSync(ownedBrowser.profile):null}));});
async function mounted({task=null,width=390,pointsAllowed=true}={}){
  editing=task?structuredClone(task):null;requests.length=0;
  const context=await browser.createBrowserContext(),page=await context.newPage();await page.setViewport({width,height:900});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);page.setDefaultTimeout(6000);
  const pageErrors=[];page.on('pageerror',error=>{pageErrors.push(error.message);console.error('SCORING_FIXTURE_PAGE_ERROR',error.stack);});
  await page.goto(`${base}/scoring-test`);
  await page.evaluate(async pointsAllowed=>{
    document.cookie=`scoring-points=${pointsAllowed?'allow':'deny'};path=/`;
    localStorage.setItem('yuvomi-lang','en');window.toasts=[];window.yuvomi={user:{id:1,role:'admin'},showToast:message=>window.toasts.push(message)};
    const i18n=await import('/i18n.js');await i18n.initI18n();await i18n.setLocale('en');await import('/components/datepicker.js');
    const {setPermissions}=await import('/permissions.js');setPermissions({admin:pointsAllowed,capabilities:Object.fromEntries(['tasks.create','tasks.change_priority','tasks.change_points','tasks.change_category_tags','tasks.change_dates','tasks.change_assignment','tasks.change_required_skills','activities.view','workflows.view','workflows.run'].map(key=>[key,key==='tasks.change_points'&&!pointsAllowed?'deny':'allow']))});
    const {render}=await import('/pages/tasks.js');window.disposeScoringPage=await render(document.querySelector('#fixture'),{user:{id:1,role:'admin'}});
  },pointsAllowed);
  if(task){await page.evaluate(async()=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(70,{user:{id:1,role:'admin'}});});await page.click('#detail-view-edit');}
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
test('invalid active root amount is rejected without truncation or a create request',async()=>{
  const page=await mounted();try{await set(page,'#task-title','Invalid points');await set(page,'#task-points','10001');await page.$eval('#task-submit-btn',el=>el.click());await page.waitForFunction(()=>!document.querySelector('#task-form')||!document.querySelector('#task-form-error')?.hidden);
    assert.equal(requests.some(r=>r.method==='POST'&&r.path==='/tasks'),false);assert.equal(await page.$eval('#task-points',el=>el.getAttribute('aria-invalid')),'true');
  }finally{await page.dispose();}
});
test('authoritative personal gross total and explicit unavailable scoring never use configured points',async()=>{
  const page=await mounted();try{const values=await page.evaluate(async task=>{const {taskCompletionPoints}=await import('/utils/task-fields.js');return [taskCompletionPoints(task),taskCompletionPoints({...task,scoring:null})];},task);assert.deepEqual(values,[7,null]);}
  finally{await page.dispose();}
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

test('cards label authoritative earned and potential while keeping circles numeric',async()=>{
  const page=await mounted();try{const values=await page.evaluate(async task=>{const {__test}=await import('/pages/tasks.js');return [__test.renderTaskCard(task),__test.renderTaskCard({...task,scoring:null})];},task);
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
  const page=await mounted();try{const result=await page.evaluate(async task=>{const {__test}=await import('/pages/tasks.js');const {parseDateInput}=await import('/i18n.js');const editor=new DOMParser().parseFromString(__test.renderModalContent({task,users:[]}),'text/html');return {card:__test.renderTaskCard(task),date:__test.taskCalendarDate(task),chip:__test.renderTaskCalendarChip(task),agenda:__test.renderTaskCalendarAgendaRow(task),editorDue:parseDateInput(editor.querySelector('#task-due-date').getAttribute('value')),raw:task.due_date};},trip);assert.equal(result.date,'2026-11-07');assert.equal(result.raw,'2026-11-02');assert.match(result.card,/Next: &lt;Pack safely&gt;/);assert.equal(result.editorDue,'2026-11-02');assert.doesNotMatch(result.card,/>999</);assert.match(result.chip,/10:00/);assert.match(result.agenda,/10:00/);}
  finally{await page.dispose();}
});
for(const width of [320,390])test(`named editable targets fit ${width}px and retain at least44px height`,async()=>{
  const page=await mounted({width});try{const sizes=await page.$$eval('.task-scoring__modes label,#task-points',nodes=>nodes.map(node=>({height:node.getBoundingClientRect().height,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})));assert.ok(sizes.every(size=>size.height>=44&&size.left>=0&&size.right<=width),JSON.stringify(sizes));}
  finally{await page.dispose();}
});
