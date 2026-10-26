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
async function press(page,selector){await page.waitForSelector(selector,{visible:true});if(page.viewport().hasTouch)await page.locator(selector).click();else {await page.focus(selector);await page.keyboard.press('Enter');}}
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

for(const width of [390,1366])for(const choice of [false,true])test(`real completion choice ${choice} at ${width}px uses done and retains truthful progress`,{timeout:120000},async()=>{
  const desktop=await client(width),observer=await client(1280);
  const mode=width<500?'subtasks':'whole_task',date=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const root=(await api(desktop,'post','/tasks',{title:`Synthetic completion ${width} ${choice}`,assigned_to:[3],scoring_mode:mode,points:5,
    is_recurring:true,recurrence_from_completion:true,recurrence_rule:'FREQ=DAILY;INTERVAL=3',start_date:date,due_date:date,
    subtasks:[{title:'Already earned',points:2},{title:'Remaining action',points:3}]})).data;
  const first=(await api(desktop,'get',`/tasks/${root.subtasks[0].id}`)).data,current=(await api(desktop,'get',`/tasks/${root.id}`)).data;
  await api(desktop,'patch',`/tasks/${first.id}/status`,{status:'done',expected_revision:first.revision,expected_parent_revision:current.revision});
  const untouched=row(root.subtasks[1].id);
  await open(desktop,root.id);await open(observer,root.id);
  assert.equal(await desktop.$('#task-detail-close-incomplete'),null);
  assert.equal(await desktop.$('#task-detail-reopen-incomplete'),null);
  await desktop.select('[data-focus-key="status"]','done');
  await desktop.waitForSelector('#confirm-modal-checkbox',{visible:true});
  assert.equal(await desktop.$eval('#confirm-modal-checkbox',element=>element.checked),true);
  const text=await desktop.$eval('#confirm-modal-ok',element=>element.closest('.modal-panel').textContent);
  assert.match(text,/Complete remaining subtasks/);assert.doesNotMatch(text,/Closed without completing remaining subtasks/);
  await press(desktop,'#confirm-modal-cancel');assert.equal(row(root.id).status,'in_progress');assert.deepEqual(row(root.subtasks[1].id),untouched);
  await desktop.waitForSelector('#confirm-modal-checkbox',{hidden:true});
  await desktop.waitForFunction(()=>{const select=document.querySelector('[data-focus-key="status"]');return select?.value==='in_progress'&&!select.disabled;});
  await desktop.select('[data-focus-key="status"]','done');await desktop.waitForSelector('#confirm-modal-checkbox',{visible:true});
  // The ordinary first-install update toast can cover the mobile checkbox for
  // fifteen seconds. Wait for its normal dismissal before testing the choice.
  await desktop.waitForFunction(()=>{const element=document.getElementById('confirm-modal-checkbox'),rect=element?.getBoundingClientRect();return rect&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===element;},{timeout:30000});
  if(!choice)await desktop.click('#confirm-modal-checkbox');
  await desktop.screenshot({path:join(output,`${width}-${choice}-confirmation.png`),fullPage:true});
  await press(desktop,'#confirm-modal-ok');
  await desktop.waitForFunction(()=>document.querySelector('[data-focus-key="status"]')?.value==='done');
  await observer.waitForFunction(()=>document.querySelector('[data-focus-key="status"]')?.value==='done');
  assert.equal(row(root.id).status,'done');assert.equal(row(root.subtasks[1].id).status,choice?'done':'open');
  if(!choice)assert.deepEqual(row(root.subtasks[1].id),untouched);
  const ids=[root.id,...root.subtasks.map(child=>child.id)],marks=ids.map(()=>'?').join(',');
  const points=d.prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM reward_ledger WHERE task_id IN (${marks})`).get(...ids).n;
  assert.equal(points,mode==='whole_task'?5:choice?5:2);
  const successors=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(root.id);assert.equal(successors.length,1);
  const writes=requests.filter(request=>request.path===`/api/v1/tasks/${root.id}/status`&&request.body.status==='done');
  assert.equal(writes.length,1);assert.equal(writes[0].body.complete_remaining,choice);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(root.id).n,1);
  await desktop.screenshot({path:join(output,`${width}-${choice}-completed.png`),fullPage:true});
  await desktop.select('[data-focus-key="status"]','in_progress');
  await desktop.waitForFunction(()=>document.querySelector('[data-focus-key="status"]')?.value==='in_progress');
  assert.equal(row(root.subtasks[1].id).status,choice?'done':'open');assert.ok(row(successors[0].id));
  const statusOptions=await desktop.$$eval('[data-focus-key="status"] option',nodes=>nodes.map(node=>node.value));assert.ok(!statusOptions.includes('closed_incomplete'));
  results.push({width,choice,mode,status:'done',points,successor_count:successors.length});
  assert.deepEqual(errors,[]);
});

test('legacy saved filters and collapse preferences show converted Done work through archive and restore',{timeout:90000},async()=>{
  const page=await client(1366),root=(await api(page,'post','/tasks',{title:'Synthetic converted legacy completion',assigned_to:[3],points:5,scoring_mode:'whole_task',subtasks:[{title:'Saved unfinished action',points:5}]})).data;
  const at=new Date().toISOString(),child=row(root.subtasks[0].id);
  d.transaction(()=>{
    d.prepare("UPDATE tasks SET status='done',completion_kept_subtasks=1,closed_incomplete_at=? WHERE id=?").run(at,root.id);
    d.prepare('INSERT INTO task_incomplete_closures(task_id,first_closed_at,recurrence_handled) VALUES(?,?,0)').run(root.id,at);
    d.prepare('INSERT INTO task_completion_choices(task_id,first_completed_at,legacy_incomplete,completion_recorded) VALUES(?,?,1,0)').run(root.id,at);
    d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(?,?,1,'closed_incomplete',?)").run(root.id,root.id,JSON.stringify({closed_incomplete_at:at,points_awarded:0}));
  })();
  await page.evaluate(()=>{
    localStorage.setItem('yuvomi:recentTaskFilters',JSON.stringify([{status:'closed_incomplete'}]));
    localStorage.setItem('yuvomi:taskCollapsedGroups',JSON.stringify(['status:closed_incomplete']));
  });
  await page.goto(origin+'/tasks');await page.waitForSelector('#btn-new-task');
  await page.evaluate(async()=>{
    const module=await import('/pages/tasks.js');
    module.__test.state.filters=JSON.parse(localStorage.getItem('yuvomi:recentTaskFilters'))[0];
    module.__test.state.collapsedBoardSections.add('household:status:closed_incomplete:closed_incomplete');
    await module.render(document.getElementById('main-content'),{user:window.yuvomi.user});
  });
  await page.waitForFunction(async id=>{const state=(await import('/pages/tasks.js')).__test.state;return state.filters.status.includes('done')&&state.tasks.some(task=>task.id===id&&task.status==='done');},{},root.id);
  const preferences=await page.evaluate(async()=>{const state=(await import('/pages/tasks.js')).__test.state;return {filters:state.filters.status,collapsed:[...state.collapsedGroups,...state.collapsedBoardSections],stored:JSON.parse(localStorage.getItem('yuvomi:taskCollapsedGroups'))};});
  assert.deepEqual(preferences.filters,['done']);assert.ok(!preferences.collapsed.some(key=>key.includes('closed_incomplete')));assert.deepEqual(preferences.stored,[]);
  assert.ok(!(await page.$eval('body',element=>element.innerText)).includes('Closed without completing remaining subtasks'));
  await api(page,'patch',`/tasks/${root.id}/archive`,{archived:true,expected_revision:row(root.id).revision});
  await api(page,'patch',`/tasks/${root.id}/archive`,{archived:false,expected_revision:row(root.id).revision});
  await open(page,root.id);assert.equal(await page.$eval('[data-focus-key="status"]',element=>element.value),'done');
  assert.deepEqual(row(root.subtasks[0].id),child);assert.equal(row(root.id).completion_kept_subtasks,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(root.id).n,0);
  assert.equal(await page.$('#task-detail-close-incomplete'),null);
  await page.screenshot({path:join(output,'legacy-filter-restored-done.png'),fullPage:true});
  results.push({legacy_filter:'done',obsolete_collapse_removed:true,restored_status:'done',legacy_new_points:0});
});
