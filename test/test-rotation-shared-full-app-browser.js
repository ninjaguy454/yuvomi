import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-rotation-shared-ui-'));
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
async function submit(page,selector){
  const id=await page.$eval(selector,el=>el.id);
  const control=await page.$(`${selector} [type=submit]`)?`${selector} [type=submit]`:`[type=submit][form="${id}"]`;
  await click(page,control);
}
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
const manager=(page,tab)=>page.evaluate(async tab=>{const {openAutomationManager}=await import('/components/activity-automation.js');await openAutomationManager(tab)},tab);
async function until(check,message){for(let i=0;i<100;i++){if(check())return;await wait(100)}assert.fail(message)}
async function tasksReady(page){await page.waitForSelector('#btn-new-task');await page.waitForFunction(()=>document.querySelector('#task-list')&&!document.querySelector('#task-list .widget-skeleton'));}

test('real app: independent bedtime series share one scheduled Group, assignee text and second-client override',{timeout:180000},async()=>{
  const page=await openClient();let second;
  try {
    await manager(page,'rotations');await page.waitForSelector('[data-rotation-create]');await click(page,'[data-rotation-create]');
    await page.waitForSelector('[data-rotation-group-form]');await set(page,'[data-rotation-group-form] [name=name]','Kids Shower Order');
    for(const kid of kids)await page.select('[data-rotation-add-member]',String(kid));
    await page.select('[name=usage_mode]','shared');await page.select('[name=shared_strategy]','rotating_order');
    await set(page,'[name=shared_effective_date]',todayKey(db));await set(page,'[name=shared_active_time]','00:00');
    await set(page,'[name=shared_finalize_time]','23:59');await page.select('[name=shared_finalize_day_offset]','0');
    await submit(page,'[data-rotation-group-form]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
    const group=db.prepare("SELECT * FROM rotation_groups WHERE name='Kids Shower Order'").get();
    assert.equal(await page.evaluate(async id=>(await(await fetch(`/api/v1/automation/rotation-groups/${id}`)).json()).data.usage_mode,group.id),'shared');
    await manager(page,'activities');await page.waitForSelector('#automation-add-activity');await click(page,'#automation-add-activity');
    await page.waitForSelector('#automation-activity-form');
    await set(page,'#automation-activity-form [name=name]','Independent bedtime');await set(page,'[name=title_template]','Bedtime routine');
    await set(page,'#automation-activity-form [name=description]','Each child owns an independent recurring Activity.');
    await page.select('#automation-assignment-strategy','fixed');await page.select('[name=fixed_user_id]',String(kids[0]));
    await page.$eval('[name=subject_required]',el=>{el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}))});
    await page.select('#activity-rrule-freq','DAILY');await page.select('#activity-due-offset','0');
    await click(page,'[data-rotation-add]');await set(page,'[data-rotation-label]','Shower Order');await set(page,'[data-rotation-key]','shower_order');
    await page.waitForSelector(`[data-rotation-group] option[value="${group.id}"]`);await page.select('[data-rotation-group]',String(group.id));
    assert.match(await page.$eval('[data-rotation-shared-notice]',el=>el.innerText),/Using shared rotation: Kids Shower Order/);
    await click(page,'[data-task-subtask-add]');
    const title='[data-task-subtask-row]:last-child [data-task-subtask-title]';
    await page.focus(title);await page.type(title,'Take shower · @assignee position');
    await page.waitForSelector('.automation-mention-option');
    const option=await page.$eval('.automation-mention-option',el=>el.innerText);assert.match(option,/This action’s assignee position/);
    await page.keyboard.press('Enter');assert.equal(await page.$eval(title,el=>el.value),'Take shower · {{shower_order.position_label}}');
    await submit(page,'#automation-activity-form');
    await until(()=>!!db.prepare("SELECT id FROM activity_templates WHERE name='Independent bedtime'").get(),'Template save failed');
    const template=db.prepare("SELECT * FROM activity_templates WHERE name='Independent bedtime'").get();
    const owners=[];
    for(const [index,kid] of kids.entries()) {
      await page.goto(`${origin}/tasks?view=list`);await tasksReady(page);await click(page,'#btn-new-task');await page.waitForSelector('#task-form');
      await page.select('#task-activity-template',String(template.id));await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Bedtime routine');
      await set(page,'#task-title',`${['Gracelynn','Eleanor','Frankie'][index]} bedtime`);await set(page,'#task-start-date',todayKey(db));
      await set(page,'#task-start-time',index===2?'20:00':'19:00');await set(page,'#task-due-time',index===2?'22:00':'21:00');
      await page.$eval('[data-ms-input="task_assigned"]',(_el,kid)=>{for(const input of document.querySelectorAll('[data-ms-input="task_assigned"]')){input.checked=Number(input.value)===kid;input.dispatchEvent(new Event('change',{bubbles:true}));}},kid);
      if(index===2)await page.select('[data-task-subtask-assignee]',String(kid));
      await click(page,'#task-submit-btn');await page.waitForFunction(()=>!document.querySelector('#task-form'));
      const owner=db.prepare('SELECT * FROM tasks WHERE parent_task_id IS NULL AND title=? ORDER BY id DESC').get(`${['Gracelynn','Eleanor','Frankie'][index]} bedtime`);assert.ok(owner);
      assert.equal(owner.assigned_to,kid);assert.equal(owner.is_recurring,1);assert.equal(owner.parent_task_id,null);owners.push(owner);
    }
    const children=()=>owners.map(owner=>db.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL ORDER BY id').get(owner.id));
    const links=owners.map(owner=>db.prepare('SELECT * FROM task_rotation_occurrences WHERE owner_task_id=? AND retired_at IS NULL').get(owner.id));
    assert.ok(links.every(link=>link));assert.equal(new Set(links.map(link=>link.track_id)).size,1);assert.equal(new Set(links.map(link=>link.occurrence_id)).size,1);
    assert.deepEqual(children().map(child=>child.title),['Take shower · 1st','Take shower · 2nd','Take shower · 3rd']);
    assert.deepEqual(children().map((child,index)=>child.assigned_to||owners[index].assigned_to),kids);
    assert.equal(children()[2].assigned_to,kids[2],'explicit action assignment is preserved');
    for(const [index,child] of children().entries()) {
      await page.evaluate(async id=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id)},child.id);
      await page.waitForSelector('.detail-view__pane [data-task-rotation-context]');assert.match(await page.$eval('.detail-view__pane [data-task-rotation-context]',el=>el.innerText),new RegExp(['1st','2nd','3rd'][index]));
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.detail-view__pane'));
    }
    second=await openClient();await second.evaluate(async id=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id)},children()[0].id);
    await second.waitForFunction(()=>document.querySelector('#shared-modal-overlay')?.innerText.includes('Take shower · 1st'));
    // Canonical HTTP manual edit must detach only its authored field.
    const manual=children()[2];const manualResponse=await page.evaluate(async task=>{const {api}=await import('/api.js');const {taskRevision}=await import('/utils/task-state.js');const {data:current}=await api.get(`/tasks/${task.id}`);return await api.put(`/tasks/${task.id}`,{title:'Take shower when ready',...taskRevision(current)});},manual);
    assert.equal(manualResponse.data.id,manual.id);
    await manager(page,'rotations');await page.waitForSelector(`[data-rotation-open="${group.id}"]`);await click(page,`[data-rotation-open="${group.id}"]`);
    await page.waitForSelector('[data-rotation-shared-override]');await click(page,'[data-rotation-shared-override]');await page.waitForSelector('[data-rotation-override-form]');
    assert.match(await page.$eval('[data-rotation-override-form]',el=>el.innerText),/every Activity using this Group/);
    await page.focus(`[data-rotation-override-form] [data-rotation-member="${kids[2]}"] .rotation-member-handle`);
    await page.keyboard.down('Alt');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.up('Alt');
    await submit(page,'[data-rotation-override-form]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-override-form]'));
    await second.waitForFunction(()=>document.querySelector('#shared-modal-overlay')?.innerText.includes('Take shower · 2nd')&&document.querySelector('.detail-view__pane [data-task-rotation-context]')?.innerText.includes('2nd'));
    assert.deepEqual(children().map(child=>child.title),['Take shower · 2nd','Take shower · 3rd','Take shower when ready']);
    assert.equal(db.prepare('SELECT advance_count FROM rotation_tracks WHERE id=?').get(links[0].track_id).advance_count,0);
    // A touch viewport reads the same actual backend and preserves ordinary scrolling.
    await page.setViewport({width:390,height:780,isMobile:true,hasTouch:true});await page.goto(`${origin}/tasks?view=list`);await tasksReady(page);
    await page.evaluate(async id=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id)},children()[1].id);
    await page.waitForSelector('.detail-view__pane [data-task-rotation-context]');assert.match(await page.$eval('.detail-view__pane [data-task-rotation-context]',el=>el.innerText),/3rd/);
    assert.deepEqual(page.appErrors||[],[]);assert.deepEqual(second.appErrors||[],[]);assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }catch(error){console.error('Shared Rotation browser diagnostic',await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(-7000)})),second?await second.evaluate(()=>document.body.innerText.slice(-5000)):null,serverOutput);throw error;}
  finally{await page.close();await second?.close();}
});
