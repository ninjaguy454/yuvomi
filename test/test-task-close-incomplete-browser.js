import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import puppeteer from 'puppeteer';

const temporary=mkdtempSync(join(tmpdir(),'vidamia-close-browser-'));
Object.assign(process.env,{DB_PATH:join(temporary,'synthetic.db'),DB_ENCRYPTION_KEY:'',SESSION_SECRET:'synthetic-close-browser-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js');
const d=get(),output=process.env.CLOSE_INCOMPLETE_QA_OUTPUT||join(temporary,'evidence');mkdirSync(output,{recursive:true});
const password='Synthetic-Close-Only-2026!',errors=[],results=[],requests=[];let browser,server,origin,log='',browserProcess,profile;
const contexts=[],serverReceipts=[];
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const ledgers=()=>JSON.stringify(Object.fromEntries(['reward_ledger','reward_task_awards','task_completions','task_scoring_settlements','task_scoring_completion_events'].map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all().map(value=>JSON.stringify(value)).sort()])));
const api=(page,method,path,body)=>page.evaluate(async({method,path,body})=>(await import('/api.js')).api[method](path,body),{method,path,body});
async function open(page,id){await page.evaluate(async()=>{await(await import('/components/modal.js')).closeModal({force:true});});await page.waitForSelector('#shared-modal-overlay',{hidden:true});await page.evaluate(async id=>{await(await import('/pages/tasks.js')).openTaskById(id,{user:window.yuvomi.user});},id);await page.waitForSelector('#shared-modal-overlay .modal-panel');}
async function press(page,selector){await page.waitForSelector(selector,{visible:true});await page.focus(selector);await page.keyboard.press('Enter');}
async function client(width,username='Close Parent'){
  const context=await browser.createBrowserContext();contexts.push(context);const page=await context.newPage();page.setDefaultTimeout(15000);
  await page.setViewport({width,height:width<500?844:960,isMobile:width<500,hasTouch:width<500});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/v1/tasks')&&request.method()!=='GET')requests.push({method:request.method(),path:url.pathname,body:JSON.parse(request.postData()||'{}')});});
  await page.setRequestInterception(true);page.on('request',request=>{if(request.isInterceptResolutionHandled())return;const url=new URL(request.url());if(url.origin!==origin||url.pathname==='/sw.js')request.abort();else request.continue();});
  await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');});
  await page.goto(origin+'/login');
  assert.equal(await page.evaluate(async({username,password})=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})).status,{username,password}),200);
  await page.goto(origin+'/tasks');await page.waitForSelector('#btn-new-task');await page.waitForNetworkIdle({idleTime:300,concurrency:2});return page;
}

async function startServer(){
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{windowsHide:true,env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
  for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>log+=chunk);
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic server startup timed out '+log.slice(-1500))),45000);server.once('message',message=>{clearTimeout(timer);assert.match(message.origin,/^http:\/\/127\.0\.0\.1:/);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Synthetic server exited '+code+' '+log.slice(-1500)));});});
}
test.before(async()=>{
  const hash=await hashPassword(password,4);
  for(const [id,name,role,family] of [[1,'Close Parent','admin','parent'],[2,'Close Mom','member','mom'],[3,'Close Child','member','child']])d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,1)').run(id,name,name,hash,role,family);
  d.exec("INSERT INTO reward_participants(user_id,enabled) VALUES(2,1),(3,1); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','UTC')");
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--disable-dev-shm-usage']});
  browserProcess=browser.process();assert.ok(!browserProcess.spawnargs.includes('--no-sandbox')&&!browserProcess.spawnargs.includes('--disable-setuid-sandbox'));
  profile=browserProcess.spawnargs.find(value=>value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
});
test.beforeEach(startServer);
test.afterEach(async()=>{
  for(const context of contexts)await context.close().catch(()=>{});contexts.length=0;
  if(server?.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
  if(server)serverReceipts.push({pid:server.pid,exit:server.exitCode,signal:server.signalCode});server=null;
});

test.after(async()=>{
  for(const context of contexts)await context.close().catch(()=>{});
  await browser?.close();
  if(server?.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
  d.close();
  const cleanup={chrome_pid:browserProcess?.pid,chrome_exit:browserProcess?.exitCode,profile_removed:!profile||!existsSync(profile),servers:serverReceipts};
  writeFileSync(join(output,'results.json'),JSON.stringify({results,errors,requests,cleanup,synthetic:true,loopback_only:true},null,2));writeFileSync(join(output,'server.log'),log);
  assert.equal(browserProcess?.exitCode,0);assert.equal(cleanup.profile_removed,true);
  assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));assert.ok(temporary.startsWith(join(tmpdir(),'vidamia-close-browser-')));rmSync(temporary,{recursive:true,force:true});
});

for(const mode of (process.env.CLOSE_INCOMPLETE_QA_MODES?.split(',')||['one-off','calendar','completion-relative']))test(`real Activity Details ${mode}: Cancel, keyboard close, unchecked steps, preserved points and observer refresh`,{timeout:150000},async()=>{
  const desktop=await client(1366),mobile=await client(390),observer=await client(1280);
  const today=new Date().toISOString().slice(0,10),yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const root=(await api(desktop,'post','/tasks',{title:`Synthetic close ${mode}`,assigned_to:[3],scoring_mode:'subtasks',points:5,
    ...(mode==='one-off'?{}:{is_recurring:true,recurrence_from_completion:mode==='completion-relative',recurrence_rule:'FREQ=DAILY;INTERVAL=3',start_date:yesterday,due_date:yesterday}),
    subtasks:[{title:'Already earned',points:2},{title:'Leave unchecked',points:3}]})).data;
  const first=(await api(desktop,'get',`/tasks/${root.subtasks[0].id}`)).data,current=(await api(desktop,'get',`/tasks/${root.id}`)).data;
  await api(desktop,'patch',`/tasks/${first.id}/status`,{status:'done',expected_revision:first.revision,expected_parent_revision:current.revision});
  const earned=ledgers(),unchecked=row(root.subtasks[1].id);
  await open(mobile,root.id);await open(observer,root.id);
  assert.ok(await mobile.$eval('[data-focus-key="status"]',select=>[...select.options].some(option=>option.value==='done'&&option.textContent==='Completed')));
  await mobile.screenshot({path:join(output,mode+'-phone-before.png'),fullPage:true});
  console.log('CLOSE_BUTTON_GEOMETRY',mode,await mobile.$eval('#task-detail-close-incomplete',element=>{const rect=element.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,disabled:element.disabled,hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.outerHTML.slice(0,180),viewport:{width:innerWidth,height:innerHeight}};}));
  // The real first-install update toast lasts 15 seconds and can cover the
  // existing footer. Wait for its ordinary dismissal before exercising a tap.
  await mobile.waitForFunction(()=>{const element=document.getElementById('task-detail-close-incomplete');if(!element)return false;const rect=element.getBoundingClientRect();return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('button')===element;},{timeout:30000});
  await mobile.locator('#task-detail-close-incomplete').click();await mobile.waitForSelector('#confirm-modal-ok',{visible:true});
  const confirmation=await mobile.$eval('#confirm-modal-ok',element=>element.closest('.modal-panel').textContent);
  assert.match(confirmation,/Unfinished subtasks stay unchecked/);assert.match(confirmation,/earned points remain/);
  await mobile.screenshot({path:join(output,mode+'-phone-confirm.png'),fullPage:true});
  const before=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
  await mobile.locator('#confirm-modal-cancel').click();assert.equal(row(root.id).status,'in_progress');assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,before);
  await open(desktop,root.id);await press(desktop,'#task-detail-close-incomplete');await press(desktop,'#confirm-modal-ok');
  await desktop.waitForFunction(()=>document.querySelector('[data-focus-key="status"]')?.value==='closed_incomplete');
  await observer.waitForFunction(()=>document.querySelector('[data-focus-key="status"]')?.value==='closed_incomplete');
  assert.equal(row(root.id).status,'closed_incomplete');assert.deepEqual(row(root.subtasks[1].id),unchecked);assert.equal(ledgers(),earned);
  const summary=await desktop.$eval('.task-detail-summary',element=>element.textContent);assert.match(summary,/Closed without completing remaining subtasks/);assert.doesNotMatch(summary,/Expired incomplete/);
  const button=await desktop.$eval(`[data-subtask-id="${root.subtasks[1].id}"] .detail-subtask__toggle`,element=>({disabled:element.disabled,pressed:element.getAttribute('aria-pressed')}));
  assert.deepEqual(button,{disabled:true,pressed:'false'});
  const successors=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(root.id);
  assert.equal(successors.length,mode==='one-off'?0:1);
  if(mode!=='one-off'){const base=mode==='completion-relative'?today:yesterday;assert.equal(successors[0].due_date,new Date(Date.parse(base+'T00:00:00Z')+3*86400000).toISOString().slice(0,10));}
  await desktop.screenshot({path:join(output,mode+'-desktop-closed.png'),fullPage:true});await open(mobile,root.id);await mobile.screenshot({path:join(output,mode+'-phone-closed.png'),fullPage:true});
  const child=await client(390,'Close Child');await open(child,root.id);assert.equal(await child.$('#task-detail-close-incomplete'),null);assert.equal(await child.$('#task-detail-reopen-incomplete'),null);
  const denied=await child.evaluate(async id=>{try{await(await import('/api.js')).api.post(`/tasks/${id}/close-incomplete`,{operation_id:'child-denied',expected_revision:1});return 200;}catch(error){return error.status;}},root.id);assert.equal(denied,403);
  await press(desktop,'#task-detail-reopen-incomplete');await press(desktop,'#confirm-modal-ok');
  await desktop.waitForFunction(()=>document.querySelector('[data-focus-key="status"]')?.value==='in_progress');
  assert.equal(ledgers(),earned);assert.deepEqual(row(root.subtasks[1].id),unchecked);
  await press(desktop,`[data-subtask-id="${root.subtasks[1].id}"] .detail-subtask__toggle`);
  await desktop.waitForFunction(()=>document.querySelector('[data-focus-key="status"]')?.value==='done');
  assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(root.id),successors);
  assert.equal(d.prepare('SELECT SUM(delta) total FROM reward_ledger WHERE task_id IN (?,?)').get(root.subtasks[0].id,root.subtasks[1].id).total,5);
  await desktop.screenshot({path:join(output,mode+'-reopened-completed.png'),fullPage:true});
  assert.deepEqual(errors,[]);results.push({mode,cancel:true,keyboard:true,phone:true,observer:true,unchecked:true,earnedPreserved:true,childDenied:true,reopened:true,normalNewEarnings:true,successorsPreserved:true,successors:successors.length});
});
