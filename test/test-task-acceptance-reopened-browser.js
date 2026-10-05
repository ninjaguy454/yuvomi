/** Actual app, encrypted synthetic household, real auth and acceptance UI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-acceptance-reopened-'));
process.env.DB_PATH=join(folder,'household.db');process.env.DB_ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.SESSION_SECRET='synthetic-acceptance-reopened';process.env.SESSION_SECURE='false';
process.env.BACKUP_ENABLED='false';process.env.NODE_ENV='development';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-acceptance-household-2026!';
const evidence={scope:'Actual server, encrypted synthetic DB and production UI',steps:[],errors:[]};
const output=process.env.ACCEPTANCE_REOPENED_EVIDENCE||process.env.ACCEPTANCE_TOUCH_EVIDENCE||join(folder,'evidence');mkdirSync(output,{recursive:true});
let server,browser,origin,owner,member,display;
const touchSessions=new WeakMap();
async function touchSession(page){if(!touchSessions.has(page))touchSessions.set(page,await page.createCDPSession());return touchSessions.get(page);}
const grant=(id,key,value)=>d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,?) ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access").run(String(id),key,value);
test.before(async()=>{
  const hash=await hashPassword(password,4);
  for(const [id,name,role] of [[1,'Accept Parent','admin'],[2,'Accept Grace','member'],[3,'Accept Helper','member']])d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,1)').run(id,name,name,hash,role,role==='admin'?'parent':'child');
  for(const key of ['tasks.change_assignment','tasks.reassign','tasks.accept_with_helpers'])grant(2,key,'none');
  server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>log=(log+chunk).slice(-6000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Server startup failed')),60000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${log}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  assert.notEqual(readFileSync(process.env.DB_PATH).subarray(0,16).toString(),'SQLite format 3\0');
});
test.after(async()=>{
  writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2));await browser?.close();
  if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}
  d.close();rmSync(folder,{recursive:true,force:true});
});
test.afterEach(async context=>{if(context.error)for(const [name,page] of Object.entries({owner,member,display})){if(!page||page.isClosed())continue;console.log('ACCEPTANCE_FULL_APP_FAILURE',name,page.url(),await page.$eval('body',el=>el.innerText.slice(-1800)).catch(()=>''));await page.screenshot({path:join(output,`failure-${name}.png`)}).catch(()=>{});}});
async function pageFor(width=1280){
  const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(15000);await page.setViewport({width,height:width<500?844:960,isMobile:width<500,hasTouch:width<900});
  const cdp=await page.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');Object.defineProperty(navigator,'onLine',{get:()=>true});});
  await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin||url.pathname==='/sw.js')return request.abort();return request.continue();});
  page.on('pageerror',error=>evidence.errors.push(error.message));return page;
}
async function field(page,selector,value){await page.waitForSelector(selector);await page.$eval(selector,(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function press(page,selector){await page.bringToFront();await page.waitForSelector(selector);await page.focus(selector);await page.keyboard.press('Enter');}
async function login(page,name){await page.goto(origin+'/login');await field(page,'#username',name);await field(page,'#password',password);const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/login')&&r.request().method()==='POST');await press(page,'#auth-btn');assert.equal((await response).status(),200);await page.waitForSelector('.dashboard');}
async function create(title,{children=0}={}){
  const created=await owner.evaluate(async title=>{const {api}=await import('/api.js');return api.post('/tasks',{title,assigned_to:[],points:5});},title);const id=created.data.id;
  const steps=[];for(let i=0;i<children;i++)steps.push(Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id) VALUES(?,1,?)").run(`${title} step ${i+1}`,id).lastInsertRowid));
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,null);return {id,steps};
}
async function open(page,id){
  await page.bringToFront();await page.waitForFunction(()=>typeof window.yuvomi?.navigate==='function');
  for(let attempt=0;attempt<30;attempt++){await page.evaluate(()=>window.yuvomi.navigate('/notes'));if(new URL(page.url()).pathname==='/notes')break;await new Promise(resolve=>setTimeout(resolve,100));}
  await page.waitForSelector('.notes-page');
  await press(page,`[data-open-task="${id}"]`);
  await page.waitForFunction(()=>document.querySelector('[data-task-acceptance]')||document.querySelector('#task-detail-claim'));
  if(!await page.$('[data-task-acceptance]'))await press(page,'#task-detail-claim');
  await page.waitForFunction(()=>['primary','helpers'].includes(document.querySelector('[data-task-acceptance]')?.dataset.stage));
}
async function confirm(page,id){
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/v1/tasks/${id}/accept`)&&r.request().method()==='POST');
  await press(page,'[data-acceptance-confirm]');const saved=await response;assert.equal(saved.status(),200,await saved.text());await page.waitForSelector('[data-task-acceptance]',{hidden:true});
}
async function dragAvatar(page,userId,childId,touch=false){
  const from=await(await page.$(`[data-acceptance-person="${userId}"]`)).boundingBox(),to=await(await page.$(`[data-acceptance-target="${childId}"]`)).boundingBox();
  const start={x:from.x+from.width/2,y:from.y+from.height/2},end={x:to.x+to.width/2,y:to.y+to.height/2};
  if(touch){
    const cdp=await touchSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(end.x-start.x)*step/8,y:start.y+(end.y-start.y)*step/8,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }else{await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:8});await page.mouse.up();}
  await page.waitForSelector(`[data-acceptance-target="${childId}"][data-assignee="${userId}"]`);
}
const assigned=id=>d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(r=>r.user_id);

async function tap(page,selector){
  await page.bringToFront();await page.waitForSelector(selector);
  const box=await(await page.$(selector)).boundingBox();
  assert.equal(await page.evaluate(({selector,x,y})=>!!document.elementFromPoint(x,y)?.closest(selector),{selector,x:box.x+box.width/2,y:box.y+box.height/2}),true,`touch target visible: ${selector}`);
  const cdp=await touchSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2,id:1}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
const rights=()=>d.prepare('SELECT subject_type,subject_id,capability_key,access FROM access_capabilities ORDER BY subject_type,subject_id,capability_key').all();
const progress=ids=>ids.map(id=>d.prepare('SELECT id,status FROM tasks WHERE id=?').get(id));
async function reopened(title){
  const task=await create(title,{children:3});
  // Use the production status client and its revision-bound API; no status SQL fixture.
  for(const status of ['done','in_progress'])await owner.evaluate(async({id,status})=>{
    const {api}=await import('/api.js'),{changeTaskStatus}=await import('/utils/task-state.js');
    return changeTaskStatus((await api.get(`/tasks/${id}`)).data,status);
  },{id:task.steps[2],status});
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'in_progress');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(task.steps[2]).status,'in_progress');
  for(const id of [task.id,...task.steps])assert.deepEqual(assigned(id),[]);
  return task;
}

test('reopened unassigned child supports native touch allocation and atomic zero/partial acceptance for human and paired principals',{timeout:180000},async()=>{
  owner=await pageFor();await login(owner,'Accept Parent');
  grant(2,'tasks.accept_with_helpers','allow');member=await pageFor(390);await login(member,'Accept Grace');
  display=await pageFor(390);await display.goto(origin+'/device/pair');await press(display,'[data-pair-start]');await display.waitForSelector('[data-pair-code]');
  const code=await display.$eval('[data-pair-code]',el=>el.textContent);
  await owner.evaluate(async code=>{const {api}=await import('/api.js');return api.post('/devices/pairing-approve',{code,name:'Synthetic Reopened Display',scope:{member_ids:[2,3]},permissions:{capabilities:{'device_notes.view':'allow','device_tasks.claim':'allow','device_tasks.accept_with_helpers':'allow'}}});},code);
  await display.waitForSelector('[data-pair-claim]');await press(display,'[data-pair-claim]');await display.waitForFunction(()=>!!document.querySelector('[data-device-login]')&&!!document.querySelector('.dashboard'));
  const beforeRights=rights(),deviceBefore=d.prepare('SELECT id,revision,permissions_json,scope_json FROM household_devices').all();
  for(const [kind,page] of [['human',member],['paired',display]])for(const partial of [false,true]){
    const label=`${kind}-${partial?'partial':'zero'}`,task=await reopened(`Reopened ${label}`),child=task.steps[2],target=`[data-acceptance-target="${child}"]`;
    const beforeProgress=progress([task.id,...task.steps]);
    const projection=await page.evaluate(async id=>{const {api}=await import('/api.js');return (await api.get(`/tasks/${id}/acceptance?primary_user_id=2`)).data;},task.id);
    const projected=projection.subtasks.find(row=>row.id===child);evidence.steps.push({label,projection:projected});
    assert.equal(projected.allocatable,true,`reopened unassigned child: ${JSON.stringify(projected)}`);
    assert.equal(projected.reason,null);assert.ok(projected.eligible_assignee_ids.includes(2)&&projected.eligible_assignee_ids.includes(3));
    await open(page,task.id);
    if(kind==='paired'){await page.select('[data-acceptance-primary]','2');await press(page,'[data-acceptance-next]');}
    await tap(page,'[data-acceptance-helper="3"]');await press(page,'[data-acceptance-next]');
    assert.deepEqual(await page.$eval(target,el=>({disabled:el.disabled,text:el.textContent,border:getComputedStyle(el).borderStyle})),{disabled:false,text:'?',border:'dashed'});
    const identityBefore=await page.evaluate(async()=>structuredClone((await import('/permissions.js')).getPermissions()));
    const mutations=[],capture=request=>{if(new URL(request.url()).pathname.startsWith('/api/')&&!['GET','HEAD'].includes(request.method()))mutations.push({url:request.url(),method:request.method(),body:request.postData()});};page.on('request',capture);
    try{
      await tap(page,target);await page.waitForSelector('[data-acceptance-picker]');
      assert.deepEqual(await page.$$eval('[data-acceptance-choice]',els=>els.map(el=>el.dataset.acceptanceChoice)),['','2','3']);
      await page.screenshot({path:join(output,`${label}-empty-picker.png`)});
      await tap(page,'[data-acceptance-choice="3"]');await page.waitForSelector(`${target}[data-assignee="3"]`);
      await tap(page,target);await tap(page,'[data-acceptance-choice="2"]');await page.waitForSelector(`${target}[data-assignee="2"]`);
      await tap(page,target);await tap(page,'[data-acceptance-choice=""]');await page.waitForSelector(`${target}[data-assignee=""]`);
      await dragAvatar(page,2,child,true); // Native touch also hits the empty target.
      await dragAvatar(page,3,child,true); // Native touch replaces the assigned avatar.
      // Exercise keyboard clearing independently of Chromium's post-drag touch
      // compatibility-click recognition; native picker clearing was checked above.
      await press(page,target);await press(page,'[data-acceptance-choice=""]');
      if(partial)await dragAvatar(page,3,child,true);
      assert.deepEqual(mutations,[]);for(const id of [task.id,...task.steps])assert.deepEqual(assigned(id),[]);
      assert.deepEqual(progress([task.id,...task.steps]),beforeProgress);
      await page.screenshot({path:join(output,`${label}-draft.png`)});
      await press(page,'[data-acceptance-next]');await confirm(page,task.id);
      assert.equal(mutations.length,1);assert.equal(mutations[0].method,'POST');assert.ok(mutations[0].url.endsWith(`/api/v1/tasks/${task.id}/accept`));
      const payload=JSON.parse(mutations[0].body);assert.equal(payload.primary_user_id,2);assert.deepEqual(payload.coassignee_ids,[3]);
      assert.deepEqual(payload.subtask_assignments,task.steps.map(id=>({id,user_id:partial&&id===child?3:null})));
      assert.deepEqual(assigned(task.id),[2,3]);for(const id of task.steps)assert.deepEqual(assigned(id),partial&&id===child?[3]:[]);
      assert.deepEqual(progress([task.id,...task.steps]),beforeProgress);
      assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
      assert.deepEqual(await page.evaluate(async()=>structuredClone((await import('/permissions.js')).getPermissions())),identityBefore);
      evidence.steps.push({label,passed:true,payload,statuses:beforeProgress,mutations:mutations.length});
    }finally{page.off('request',capture);}
  }
  assert.deepEqual(rights(),beforeRights);assert.deepEqual(d.prepare('SELECT id,revision,permissions_json,scope_json FROM household_devices').all(),deviceBefore);
  assert.equal(await display.evaluate(async()=>(await import('/permissions.js')).getPermissions().principal_kind),'device');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts').get().n,4);assert.deepEqual(evidence.errors,[]);
});

test('reopened child picker and touch drop retain server skill recipient filtering',{timeout:60000},async()=>{
  const task=await reopened('Reopened filtered recipient'),child=task.steps[2],target=`[data-acceptance-target="${child}"]`;
  const {setTaskSkills}=await import('../server/services/task-skills.js');
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic reopened skill',0,'normal',1)").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(3,?,'excluded','manual',1)").run(skill);setTaskSkills(d,child,[skill]);
  const projection=await member.evaluate(async id=>{const {api}=await import('/api.js');return (await api.get(`/tasks/${id}/acceptance`)).data;},task.id);
  const row=projection.subtasks.find(row=>row.id===child);
  assert.equal(row.allocatable,true);assert.ok(row.eligible_assignee_ids.includes(2));assert.ok(!row.eligible_assignee_ids.includes(3));
  assert.ok(projection.coassignee_candidates.some(person=>person.id===3),'parent helper eligibility does not grant child skill eligibility');
  await open(member,task.id);await tap(member,'[data-acceptance-helper="3"]');await press(member,'[data-acceptance-next]');
  await tap(member,target);assert.deepEqual(await member.$$eval('[data-acceptance-choice]',els=>els.map(el=>el.dataset.acceptanceChoice)),['','2']);
  await tap(member,'[data-acceptance-choice="2"]');
  // Native drag to an ineligible target completes without assigning it.
  const from=await(await member.$('[data-acceptance-person="3"]')).boundingBox(),to=await(await member.$(target)).boundingBox(),cdp=await touchSession(member);
  {
    const start={x:from.x+from.width/2,y:from.y+from.height/2},end={x:to.x+to.width/2,y:to.y+to.height/2};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});
    for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(end.x-start.x)*step/8,y:start.y+(end.y-start.y)*step/8,id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
  assert.equal(await member.$eval(target,el=>el.dataset.assignee),'2');assert.deepEqual(assigned(child),[]);
  await press(member,'[data-acceptance-next]');await confirm(member,task.id);
  assert.deepEqual(assigned(child),[2]);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'in_progress');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
  evidence.steps.push({label:'filtered-helper',projection:row,passed:true});assert.deepEqual(evidence.errors,[]);
});

