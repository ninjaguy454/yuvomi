import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-subtask-points-'));
process.env.DB_PATH=join(folder,'synthetic.db');delete process.env.DB_ENCRYPTION_KEY;
Object.assign(process.env,{SESSION_SECRET:'synthetic-subtask-points-browser',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-Points-Only-2026!',output=process.env.SUBTASK_POINTS_EVIDENCE||join(folder,'evidence');
mkdirSync(output,{recursive:true});let server,browser,origin,log='';
const evidence={scope:'Real app and auth, disposable synthetic database, sandboxed Chromium, loopback only',steps:[],errors:[],screenshots:[],writes:[]};
test.before(async()=>{
 assert.match(String(puppeteer.launch),/QA browser sandbox disabled/,'Use the preloaded default Puppeteer singleton');
 d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'Points QA','Synthetic Parent',?,'admin','parent',1)").run(await hashPassword(password,4));
 const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--disable-background-networking','--disable-dev-shm-usage']});
 assert.ok(!browser.process().spawnargs.includes('--no-sandbox'));
});
// Each synthetic case gets fresh production rate-limit state; no limiter bypass.
test.beforeEach(async()=>{
 server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [server.stdout,server.stderr])stream.on('data',c=>log=(log+c).slice(-8000));
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),60000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin)});server.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+' '+log))});});
});
test.afterEach(async()=>{if(server&&server.exitCode===null){server.kill();await new Promise(r=>server.once('exit',r));}});
test.after(async()=>{writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2));writeFileSync(join(output,'server.log'),log);await browser?.close();d.close();for(const suffix of ['','-wal','-shm'])try{unlinkSync(join(folder,'synthetic.db'+suffix));}catch{}try{rmdirSync(folder)}catch{}});
const press=async(page,selector)=>{await page.waitForSelector(selector);await page.focus(selector);await page.keyboard.press('Enter');};
const set=(page,selector,value)=>page.$eval(selector,(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String(value));
const points='[data-task-subtask-points]',titles='[data-task-subtask-title]',rows='[data-task-subtask-row]';
async function shot(page,name){await page.waitForFunction(()=>![...document.querySelectorAll('.toast')].some(el=>el.checkVisibility()),{timeout:15000});await page.$eval('[data-task-subtask-row]',el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:join(output,name+'.png')});evidence.screenshots.push(name+'.png');}
async function menu(page,index,action){await press(page,rows+':nth-child('+index+') summary[aria-label*="actions"]');await press(page,rows+':nth-child('+index+') [data-task-subtask-action="'+action+'"]');}
async function save(page,method,path){const response=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method);await press(page,'#task-submit-btn');if(method==='PUT'){await page.waitForSelector('#task-scoring-confirm');await press(page,'#task-scoring-confirm');}const r=await response;assert.equal(r.status(),method==='POST'?201:200,await r.text());const result=await r.json();await page.waitForSelector('#task-form',{hidden:true});return result.data;}
async function openEdit(page,id){await page.evaluate(async id=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id,{user:window.yuvomi.user});},id);await press(page,'#detail-view-edit');await page.waitForSelector('#task-form');}
for(const width of [1280,390,320])test('real new/edit form preserves subtask points at width '+width,{timeout:150000},async()=>{
 const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(18000);await page.setViewport({width,height:width<500?844:960,isMobile:width<500,hasTouch:width<500});
 await page.setRequestInterception(true);page.on('request',r=>{if(r.isInterceptResolutionHandled())return;const url=new URL(r.url());if(url.pathname==='/sw.js')return void r.abort();return void r.continue();});
 page.on('pageerror',e=>evidence.errors.push(e.message));page.on('request',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/api/v1/tasks')&&['POST','PUT','PATCH','DELETE'].includes(r.method()))evidence.writes.push({method:r.method(),path:url.pathname,body:JSON.parse(r.postData()||'{}')});});
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');});
 try{
 await page.goto(origin+'/login');assert.equal(await page.evaluate(async password=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Points QA',password})})).status,password),200);
 await page.goto(origin+'/tasks');await page.waitForSelector('#btn-new-task');await page.waitForNetworkIdle({idleTime:500,concurrency:2});await press(page,width<640?'#fab-new-task':'#btn-new-task');await page.waitForSelector('#task-form');await set(page,'#task-title','Synthetic points '+width);await set(page,'#task-points',5);
 await page.click('[name="scoring_mode"][value="subtasks"]');
 for(let i=1;i<=3;i++){await press(page,'[data-task-subtask-add]');await set(page,rows+':nth-child('+i+') '+titles,['Zero step','Seven step','Three step'][i-1]);}
 await shot(page,'create-'+width);assert.equal(await page.$$(points).then(x=>x.length),3,'Each new Task subtask must offer a visible Points input');
 for(let i=1;i<=3;i++){const selector=rows+':nth-child('+i+') '+points;assert.deepEqual(await page.$eval(selector,el=>({type:el.type,label:el.closest('label').innerText.trim(),min:el.min,max:el.max,step:el.step,inputmode:el.inputMode})),{type:'number',label:'Points',min:'0',max:'10000',step:'1',inputmode:'numeric'});await set(page,selector,[0,7,3][i-1]);}
 if(width<500){await page.$eval(points,el=>el.scrollIntoView({block:'center'}));await page.tap(points);await page.keyboard.press('ArrowUp');assert.equal(await page.$eval(points,el=>el.value),'1');await page.keyboard.press('ArrowDown');}
 const draftSnapshot=()=>page.evaluate(async()=>{const {taskDraftSnapshot}=await import('/utils/task-draft.js');return taskDraftSnapshot(document.querySelector('#task-form'));});const beforeValidation=await draftSnapshot();
 for(const value of [-1,1.5,10001]){await set(page,points,value);const count=evidence.writes.length;await press(page,'#task-submit-btn');assert.equal(evidence.writes.length,count,'Invalid points make no write');assert.ok(await page.$eval(points,el=>!el.validity.valid||el.getAttribute('aria-invalid')==='true'));}
 await set(page,points,0);
 assert.equal(await draftSnapshot(),beforeValidation,'Validation focus IDs do not change the restored draft snapshot');
 await menu(page,2,'up');await set(page,points,-1);await press(page,'#task-submit-btn');
 const errorIds=await page.$$eval(points,els=>els.map(el=>el.id).filter(Boolean));assert.equal(new Set(errorIds).size,errorIds.length,'Validation focus IDs stay unique after reordering');assert.equal(await page.$eval(points,el=>document.activeElement===el),true);
 await set(page,points,7);await menu(page,1,'down');
 for(let i=0;i<3;i++){await menu(page,3,'up');await menu(page,2,'down');await press(page,'[data-task-subtask-add]');await set(page,rows+':nth-child(4) '+titles,'Temporary');await set(page,rows+':nth-child(4) '+points,9);await menu(page,4,'remove');}
 await page.waitForFunction(()=>![...document.querySelectorAll('.toast')].some(el=>el.classList.contains('toast--danger')));await shot(page,'ready-'+width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 const geometry=await page.$$eval(points,els=>els.map(el=>{const r=el.getBoundingClientRect();return {w:r.width,h:r.height,visible:getComputedStyle(el).display!=='none'};}));for(const rect of geometry){assert.ok(rect.w>=44&&rect.h>=44,JSON.stringify(rect));assert.equal(rect.visible,true);}
 let task=await save(page,'POST','/api/v1/tasks');assert.equal(task.scoring_mode,'subtasks');assert.equal(task.points,5,'Inactive parent definition remains retained');assert.deepEqual(task.subtasks.map(s=>s.points),[0,7,3]);const ids=task.subtasks.map(s=>s.id);
 await openEdit(page,task.id);assert.deepEqual(await page.$$eval(points,els=>els.map(el=>Number(el.value))),[0,7,3]);
 await set(page,rows+':nth-child(1) '+points,4);await set(page,rows+':nth-child(2) '+points,0);await menu(page,3,'up');await shot(page,'edit-'+width);task=await save(page,'PUT','/api/v1/tasks/'+task.id);assert.deepEqual(task.subtasks.map(s=>[s.id,s.points]),[[ids[0],4],[ids[2],3],[ids[1],0]]);
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#btn-new-task');await openEdit(page,task.id);assert.deepEqual(await page.$$eval(points,els=>els.map(el=>Number(el.value))),[4,3,0]);await shot(page,'persisted-'+width);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);assert.equal(d.prepare("SELECT COUNT(*) n FROM tasks WHERE status!='open'").get().n,0);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_settlements').get().n,0);
 evidence.steps.push({width,create:true,edit:true,reload:true,zero:true,nonzero:true,validation:true,repeatedReorder:true,addRemove:true,noAwards:true});assert.deepEqual(evidence.errors,[]);
 }catch(error){await page.screenshot({path:join(output,'failure-'+width+'.png')});throw error;}finally{await context.close();}
});

test('points-only recurring edits offer occurrence and future scope before saving', {timeout:90000}, async()=>{
 const {taskSeriesState,seriesDefinitionForGeneration}=await import('../server/services/task-series.js');
 for(const [width,scope] of [[1280,'occurrence'],[390,'future'],[320,'future_only']]){
  const context=await browser.createBrowserContext(),page=await context.newPage();
  try{
   await page.setViewport({width,height:844,isMobile:width<500,hasTouch:width<500});
   await page.setRequestInterception(true);page.on('request',r=>{if(r.isInterceptResolutionHandled())return;return void(new URL(r.url()).pathname==='/sw.js'?r.abort():r.continue());});
   page.on('pageerror',e=>evidence.errors.push(e.message));
   await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
   await page.goto(origin+'/login');assert.equal(await page.evaluate(async password=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Points QA',password})})).status,password),200);
   await page.goto(origin+'/tasks');await page.waitForNetworkIdle({idleTime:500,concurrency:2});
   const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
   const task=await page.evaluate(async date=>{const {api}=await import('/api.js');return(await api.post('/tasks',{title:'Synthetic recurring points',points:0,due_date:date,is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Recurring step',points:2}]})).data;},date);
   await openEdit(page,task.id);
   if(scope==='future_only'){await press(page,'#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-scoring-scope')?.value==='future_only'&&!document.querySelector('#task-submit-btn').disabled);}
   await set(page,points,5);await press(page,'#task-submit-btn');await page.waitForSelector(scope==='future_only'?'#task-scoring-confirm':'#task-edit-scope-form');
   assert.equal(d.prepare('SELECT points FROM tasks WHERE id=?').get(task.subtasks[0].id).points,2,'Scope choice precedes persistence');
   await page.screenshot({path:join(output,'scope-'+scope+'-'+width+'.png')});evidence.screenshots.push('scope-'+scope+'-'+width+'.png');
   const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/tasks/'+task.id&&r.request().method()==='PUT');if(scope!=='future_only'){await page.click('[name="edit_scope"][value="'+scope+'"]');await press(page,'#task-scope-apply');await page.waitForSelector('#task-scoring-confirm');}await press(page,'#task-scoring-confirm');
   const response=await pending;assert.equal(response.status(),200,await response.text());const body=JSON.parse(response.request().postData());assert.equal(body.edit_scope,scope);assert.equal(body.expected_series_revision,scope==='occurrence'?undefined:task.recurrence_series_revision);await page.waitForSelector('#task-form',{hidden:true});
   assert.equal(d.prepare('SELECT points FROM tasks WHERE id=?').get(task.subtasks[0].id).points,scope==='future_only'?2:5);const state=taskSeriesState(d,task.id),definition=scope==='future_only'?seriesDefinitionForGeneration(d,state.series_id,state.occurrence.generation+1):state.definition;assert.equal(definition.data.subtasks[0].task.points,scope==='occurrence'?2:5);if(scope==='future_only'){assert.ok(body.future_patch.actions.update[0].action_key);assert.equal(Object.hasOwn(body,'subtasks'),false);assert.equal(d.prepare('SELECT revision FROM tasks WHERE id=?').get(task.id).revision,task.revision);}
   assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions').get().n,0);assert.deepEqual(evidence.errors,[]);
   assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_settlements').get().n,0);
   evidence.steps.push({width,pointsOnlyScope:scope,persisted:true,noAwards:true});
  }finally{await context.close();}
 }
});
