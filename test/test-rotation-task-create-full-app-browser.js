import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync, rmdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-rotation-create-ui-'));
process.env.DB_PATH = join(folder, 'browser.db');
delete process.env.DB_ENCRYPTION_KEY;
process.env.SESSION_SECRET = 'isolated-card-feedback-browser-tests-only';
process.env.SESSION_SECURE = 'false'; process.env.BACKUP_ENABLED = 'false';
process.env.NODE_ENV = 'development'; process.env.LOG_LEVEL = 'error';
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const { todayKey } = await import('../server/utils/timezone.js');
// The real lifecycle intentionally requires the Tasks adapter for recurrence.
await import('../server/routes/tasks.js');
const db = get();
let server, browser, origin, client = 60, serverOutput = '';
const kids=[];
const password = 'Isolated-Card-Browser-Only-2026!';
const createUser = (name, role, family) => Number(db.prepare("INSERT INTO users(username,display_name,first_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,'test',?,?,1)").run(name, name, name, role, family).lastInsertRowid);
const admin = createUser('QA card parent', 'admin', 'parent');
db.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
const launch = () => puppeteer.launch({ headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : undefined),
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });

test.before(async () => {
  for(const name of ['Gracelynn','Eleanor','Frankie'])kids.push(createUser(name,'member','child'));
  db.prepare('UPDATE users SET password_hash=?').run(await hashPassword(password));
  server = fork(new URL('./helpers/task-card-full-app-server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: '0', TASK_CARD_BROWSER_SERVER_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  server.stdout.on('data', data => { serverOutput = (serverOutput + data).slice(-6000); });
  server.stderr.on('data', data => { serverOutput = (serverOutput + data).slice(-6000); });
  origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Full app did not start: ${serverOutput}`)), 60000);
    server.once('message', message => { clearTimeout(timeout); resolve(message.origin); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Full app exited ${code}: ${serverOutput}`)); });
  });
  browser = await launch();
});
test.after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
  db.close();
  // Only known files in this suite's freshly created temporary directory.
  for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(join(folder, `browser.db${suffix}`)); } catch {} }
  try { rmdirSync(folder); } catch {}
});

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function click(page,selector){
  for(let attempt=0;attempt<3;attempt++)try{return await page.click(selector)}catch(error){
    if(!/detached/.test(error.message)||attempt===2)throw error;
    await page.waitForSelector(selector);await wait(100);
  }
}
const set=(page,selector,value)=>page.$eval(selector,(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);
async function openClient(){
  const context=await browser.createBrowserContext(),page=await context.newPage();
  await page.setExtraHTTPHeaders({'X-Forwarded-For':`198.51.100.${++client}`});await page.setViewport({width:1366,height:960});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  page.setDefaultTimeout(20000);page.on('pageerror',error=>{page.appErrors??=[];page.appErrors.push(error.message)});
  await page.goto(`${origin}/login`);
  assert.equal(await page.evaluate(async password=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'QA card parent',password})})).status,password),200);
  await page.evaluate(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-tasks-view','list')});
  const response=await page.goto(`${origin}/tasks?view=list`);assert.equal(response.status(),200,serverOutput);
  await wait(10000);await page.waitForSelector('#btn-new-task');return page;
}
async function tasksReady(page){await page.waitForSelector('#btn-new-task');await page.waitForFunction(()=>document.querySelector('#task-list')&&!document.querySelector('#task-list .widget-skeleton'));}

const output = process.env.ROTATION_CREATE_BROWSER_OUTPUT;
const api = (page, method, path, body) => page.evaluate(async ({method,path,body}) => {
  const {api}=await import('/api.js'); return api[method](path,body);
}, {method,path,body});

test('real app: Template to New Task accepts a draft-only shared Rotation and shower expression on initial Create', {timeout:120000}, async()=>{
  const page=await openClient(), writes=[];
  const capture=request=>{
    if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/tasks')writes.push(JSON.parse(request.postData()));
  };
  page.on('request',capture);
  try {
    const day=todayKey(db);
    await api(page,'post','/automation/admin/variables',{variable_key:'assignee',label:'Assignee',type:'household_member',kind:'value',default_value:null});
    const group=(await api(page,'post','/automation/rotation-groups',{
      name:'Kids Shower Order',member_ids:kids,usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:kids[0],
        effective_date:day,weekdays:[0,1,2,3,4,5,6],active_time:'00:00',finalize_time:'23:59',finalize_day_offset:0,advance_on_skip:false},
    })).data;
    const originalTitles=['Put on pajamas','Take shower','Brush teeth','Put in earrings'];
    const template=(await api(page,'post','/automation/admin/activity-templates',{
      name:'Get Ready for Bed',title_template:'{{assignee.display_name}} Get Ready for Bed',description:'Finish each required bedtime step.',points:2,
      assignment_strategy:'subject_skill',subject_required:true,presence_policy:'ignore',start_time:'00:00',due_time:'23:59',
      due_date_offset_days:0,recurrence_rule:'FREQ=DAILY',checklist:originalTitles.map((title_template,index)=>({title_template,is_optional:index===3})),
    })).data;
    const templateState=()=>({row:db.prepare('SELECT * FROM activity_templates WHERE id=?').get(template.id),
      checklist:db.prepare('SELECT * FROM activity_template_checklist_items WHERE activity_template_id=? ORDER BY sort_order,id').all(template.id)});
    const before=templateState();
    await page.goto(`${origin}/tasks?view=list`);await tasksReady(page);await click(page,'#btn-new-task');await page.waitForSelector('#task-form');
    await page.select('#task-activity-template',String(template.id));
    await page.waitForFunction(()=>document.querySelectorAll('[data-task-subtask-row]').length===4);
    await page.select('#task-activity-subject-user',String(kids[1]));
    await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Eleanor Get Ready for Bed');
    await set(page,'#task-start-date',day);
    await set(page,'#task-start-time','00:00');await set(page,'#task-due-time','23:59');
    assert.deepEqual(await page.$$eval('[data-task-subtask-title]',fields=>fields.map(field=>field.value)),originalTitles);
    await click(page,'[data-rotation-add]');await set(page,'[data-rotation-label]','Shower Order');
    const purposeKey=await page.$eval('[data-rotation-key]',field=>field.value);
    assert.match(purposeKey,/^[a-z][a-z0-9_-]*$/,'The ordinary creation flow supplies its own stable purpose key');
    await page.waitForSelector(`[data-rotation-group] option[value="${group.id}"]`);await page.select('[data-rotation-group]',String(group.id));
    await page.waitForFunction(()=>!document.querySelector('[data-rotation-shared-notice]').hidden);
    assert.match(await page.$eval('[data-rotation-shared-notice]',el=>el.innerText),/Using shared rotation: Kids Shower Order/);
    const shower='[data-task-subtask-row]:nth-child(2) [data-task-subtask-title]';
    if(process.env.ROTATION_CREATE_RAW_TOKEN==='1'){
      // Baseline diagnosis can reach the old server path before the Task form
      // gained the expression picker. Normal regression runs use the real UI.
      await set(page,shower,`Take shower · {{${purposeKey}.position_label}}`);
    }else{
      await set(page,shower,`Take shower · {{${purposeKey}.not_real}}`);
      const rejectedPromise=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/tasks');
      await page.focus('#task-submit-btn');await page.keyboard.press('Enter');
      const rejected=await rejectedPromise,reason=await rejected.json();
      assert.equal(rejected.status(),400,JSON.stringify(reason));
      assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0,'Invalid expression rolls back the entire initial creation');
      await page.waitForSelector('#task-form-error:not([hidden])');
      assert.match(await page.$eval('#task-form-error',el=>el.textContent),/not_real|property|unknown|not available/i);
      assert.doesNotMatch(await page.$eval('#task-form-error',el=>el.textContent),/Finish saving this Task to confirm its subtasks|you can edit them afterward/);
      assert.equal(await page.$eval(shower,el=>el.disabled),false);
      assert.equal(await page.$eval('#task-title',el=>el.value),'Eleanor Get Ready for Bed');
      assert.equal(await page.$eval('[data-rotation-group]',el=>Number(el.value)),group.id);
      await page.setViewport({width:390,height:844});
      await set(page,shower,'Take shower · ');await page.focus(shower);await page.type(shower,'@assignee position');
      await page.waitForSelector('.automation-mention-option');
      assert.match(await page.$eval('.automation-mention-option',el=>el.innerText),/This action’s assignee position/);
      const menu=await page.$eval('.automation-mention-menu',element=>{const bounds=element.getBoundingClientRect();
        return {position:getComputedStyle(element).position,left:bounds.left,right:bounds.right,width:bounds.width,top:bounds.top,bottom:bounds.bottom};});
      assert.equal(menu.position,'fixed','Fresh Tasks route loads the shared expression picker styles');
      assert.ok(menu.left>=0&&menu.right<=390&&menu.top>=0&&menu.bottom<=844&&menu.width>=200,JSON.stringify(menu));
      if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,'new-task-expression-menu-mobile.png')});}
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval(shower,el=>el.value),`Take shower · {{${purposeKey}.position_label}}`);
    }
    await page.select('[data-task-subtask-row]:nth-child(2) [data-task-subtask-assignee]',String(kids[1]));
    // The same retained creation form must remain usable at a touch viewport.
    // Switching Puppeteer's isMobile mode reloads the document. Resize only so
    // this assertion inspects the same unsaved draft and its responsive layout.
    await page.setViewport({width:390,height:844});
    if(await page.$('[data-rotation-text-settings]'))await page.$eval('[data-rotation-text-settings]',element=>{element.open=true;});
    const mobile=await page.$eval('[data-rotation-binding]',element=>{
      element.scrollIntoView({block:'start',behavior:'instant'});
      const selectors=['[data-rotation-label]','[data-rotation-group]','[data-rotation-period-offset]'];
      return {viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
        controls:selectors.map(selector=>{const field=element.querySelector(selector),rect=field.getBoundingClientRect();
          return {selector,width:rect.width,height:rect.height,left:rect.left,right:rect.right,disabled:field.disabled};}),
        notice:element.querySelector('[data-rotation-shared-notice]').innerText};
    });
    if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,'new-task-shared-rotation-mobile.png')});}
    const responsePromise=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/tasks');
    await page.focus('#task-submit-btn');await page.keyboard.press('Enter');
    const response=await responsePromise;
    const payload=await response.json();
    const evidence={mobile,request:writes.at(-1),status:response.status(),response:payload};
    if(output)writeFileSync(join(output,'initial-create-result.json'),JSON.stringify(evidence,null,2));
    assert.equal(response.status(),201,JSON.stringify(evidence));
    await page.waitForFunction(()=>!document.querySelector('#task-form'));
    assert.equal(writes.length,process.env.ROTATION_CREATE_RAW_TOKEN==='1'?1:2,'One atomic parent plus children request per Create attempt');
    const owner=db.prepare('SELECT * FROM tasks WHERE id=?').get(payload.data.id);
    const children=db.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL ORDER BY sort_order,id').all(owner.id);
    assert.equal(owner.assigned_to,kids[1]);assert.equal(owner.is_recurring,1);assert.equal(owner.points,2);
    assert.equal(owner.start_date,day);assert.equal(owner.due_date,day);assert.equal(owner.start_time,'00:00');assert.equal(owner.due_time,'23:59');
    assert.equal(JSON.parse(owner.rotation_bindings_json)[0].purpose_key,purposeKey);
    assert.deepEqual(children.map(child=>child.title),['Put on pajamas','Take shower · 2nd','Brush teeth','Put in earrings']);
    assert.deepEqual(children.map(child=>child.is_optional),[0,0,0,1]);assert.ok(children.every(child=>child.status==='open'));
    assert.equal(new Set(children.map(child=>child.id)).size,4);assert.equal(children[1].assigned_to,kids[1]);
    assert.ok(db.prepare('SELECT 1 FROM task_rotation_occurrences WHERE owner_task_id=? AND retired_at IS NULL').get(owner.id));
    assert.deepEqual(templateState(),before,'Draft-only changes never update the source Activity Template');
    assert.equal(mobile.overflow,false);assert.ok(mobile.controls.every(field=>field.width>=140&&field.height>=32&&field.left>=0&&field.right<=390&&!field.disabled),JSON.stringify(mobile));
    assert.deepEqual(page.appErrors||[],[]);assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }catch(error){
    const state=await page.evaluate(()=>({text:document.body.innerText.slice(-6500),error:document.querySelector('#task-form-error')?.textContent}));
    console.error('Initial Rotation create browser diagnostic',JSON.stringify({state,writes,serverOutput}));
    if(output){mkdirSync(output,{recursive:true});writeFileSync(join(output,'failure-state.json'),JSON.stringify({state,writes,serverOutput},null,2));}
    throw error;
  }finally{page.off('request',capture);await page.close();}
});
