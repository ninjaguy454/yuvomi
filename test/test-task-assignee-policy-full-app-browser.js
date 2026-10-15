import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';

const folder=mkdtempSync(join(tmpdir(),'vidamia-count-full-app-'));
Object.assign(process.env,{DB_PATH:join(folder,'synthetic.db'),DB_ENCRYPTION_KEY:'',SESSION_SECRET:'synthetic-count-full-app',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js');
const {readTaskAssigneePolicy}=await import('../server/services/task-assignee-policy.js');
const d=get(),output=process.env.ASSIGNEE_FULL_APP_EVIDENCE||join(folder,'evidence');mkdirSync(output,{recursive:true});
let browser,server,page,origin,serverLog='';const requests=[],errors=[];
const api=(method,path,body)=>page.evaluate(async input=>(await import('/api.js')).api[input.method](input.path,input.body),{method,path,body});
const press=async selector=>{await page.waitForSelector(selector,{visible:true});await page.focus(selector);await page.keyboard.press('Enter');};
async function edit(id){
  await page.evaluate(async()=>{await(await import('/components/modal.js')).closeModal({force:true});});
  await page.waitForSelector('#shared-modal-overlay',{hidden:true});
  await page.evaluate(async id=>{await(await import('/pages/tasks.js')).openTaskById(id,{user:window.yuvomi.user});},id);
  await press('#detail-view-edit');await page.waitForSelector('#task-form');
}
const selected=()=>page.$$eval('#task-form input[data-ms-input="task_assigned"]:checked',nodes=>nodes.map(node=>Number(node.value)).sort((a,b)=>a-b));

test.before(async()=>{
  const hash=await hashPassword('Synthetic-Count-Only!',4);
  for(const [id,name,role] of [[1,'Count Admin','admin'],[2,'Count Member','member'],[3,'Child Participant','member']])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,'other',1)").run(id,name,name,hash,role);
  d.exec("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','UTC')");
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
  for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>serverLog+=chunk);
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(serverLog.slice(-3000))),45000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('fixture exit '+code));});});
  assert.match(origin,/^http:\/\/127\.0\.0\.1:/);
  browser=await puppeteer.launch({headless:true,pipe:false,args:['--mute-audio','--disable-background-networking','--disable-component-update']});
  assert.ok(!browser.process().spawnargs.includes('--no-sandbox'));
  page=await browser.newPage();page.setDefaultTimeout(15000);await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.setRequestInterception(true);page.on('request',request=>{if(!request.isInterceptResolutionHandled())new URL(request.url()).pathname==='/sw.js'?request.abort():request.continue();if(['POST','PUT','PATCH','DELETE'].includes(request.method())&&new URL(request.url()).pathname.startsWith('/api/v1/tasks'))requests.push({method:request.method(),path:new URL(request.url()).pathname,body:JSON.parse(request.postData()||'{}')});});
  page.on('pageerror',error=>errors.push(error.message));
  await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-locale','en');localStorage.setItem('yuvomi-lang','en');});
  await page.goto(origin+'/login');assert.equal(await page.evaluate(async()=> (await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Count Admin',password:'Synthetic-Count-Only!'})})).status),200);
  await page.goto(origin+'/tasks');await page.waitForSelector('#btn-new-task');
});
test.after(async()=>{
  if(page)await page.screenshot({path:join(output,'final-mobile.png'),fullPage:true}).catch(()=>{});
  const browserProcess=browser?.process();await browser?.close();
  if(server?.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
  writeFileSync(join(output,'server.log'),serverLog);writeFileSync(join(output,'result.json'),JSON.stringify({requests,errors,synthetic_db:folder,browser_exit:browserProcess?.exitCode,server_exit:server?.exitCode},null,2));d.close();
});

test('authentic mobile editor preserves direct selection and child visibility under a category cap',{timeout:90000},async()=>{
  await api('put','/tasks/categories/school',{max_assignees:1});
  const task=(await api('post','/tasks',{title:'Count parent',category:'school',assigned_to:[2],points:0,scoring_mode:'whole_task',subtasks:[{title:'Child',assigned_user_ids:[3]}]})).data;
  await edit(task.id);assert.deepEqual(await selected(),[2]);
  assert.match(await page.$eval('[data-task-assignee-limit]',node=>node.textContent),/1/);
  await page.$eval('#task-title',node=>{node.value='Count title saved';node.dispatchEvent(new Event('input',{bubbles:true}));});
  const response=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/v1/tasks/'+task.id);
  await press('#task-submit-btn');const saved=await response;assert.equal(saved.status(),200,await saved.text());
  const body=JSON.parse(saved.request().postData());assert.deepEqual(body.assigned_to,[2]);assert.deepEqual(body.direct_assignee_ids,[2]);
  await page.waitForSelector('#task-form',{hidden:true});
  assert.deepEqual(readTaskAssigneePolicy(d,task.id).direct_assignee_ids,[2]);assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map(row=>row.user_id),[2,3]);
});

test('authentic future editor promotes child-only membership through preview and save',{timeout:90000},async()=>{
  const task=(await api('post','/tasks',{title:'Future direct intent',category:'household',assigned_to:[2],points:0,scoring_mode:'whole_task',is_recurring:true,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',subtasks:[{title:'Child',assigned_user_ids:[3]}]})).data;
  await edit(task.id);await press('#task-scoring-edit');await page.waitForFunction(()=>document.querySelector('#task-scoring-scope')?.value==='future_only'&&!document.querySelector('#task-submit-btn')?.disabled);
  assert.deepEqual(await selected(),[2]);
  await page.$eval('input[data-ms-input="task_assigned"][value="3"]',node=>node.click());assert.deepEqual(await selected(),[2,3]);
  await press('#task-submit-btn');await page.waitForSelector('#task-scoring-confirm');
  const preview=requests.filter(request=>request.path.endsWith('/scoring-preview')).at(-1);assert.deepEqual([...preview.body.future_patch.fields.assigned_to].sort((a,b)=>a-b),[2,3]);
  await page.screenshot({path:join(output,'future-promotion-preview.png'),fullPage:true});
  const response=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/v1/tasks/'+task.id);
  await press('#task-scoring-confirm');const saved=await response;assert.equal(saved.status(),200,await saved.text());await page.waitForSelector('#task-form',{hidden:true});
  assert.deepEqual(readTaskAssigneePolicy(d,task.id).direct_assignee_ids,[2]);
  const definition=d.prepare('SELECT definition_json FROM task_recurrence_definitions WHERE series_id=(SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?) ORDER BY id DESC').get(task.id);
  assert.deepEqual(JSON.parse(definition.definition_json).assignee_policy.direct_assignee_ids.sort((a,b)=>a-b),[2,3]);assert.deepEqual(errors,[]);
});
