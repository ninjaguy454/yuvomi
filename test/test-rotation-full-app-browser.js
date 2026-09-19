import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-rotation-closure-'));
process.env.DB_PATH = join(folder, 'browser.db');
delete process.env.DB_ENCRYPTION_KEY;
process.env.SESSION_SECRET = 'isolated-card-feedback-browser-tests-only';
process.env.SESSION_SECURE = 'false'; process.env.BACKUP_ENABLED = 'false';
process.env.NODE_ENV = 'development'; process.env.LOG_LEVEL = 'error';
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const { todayKey } = await import('../server/utils/timezone.js');
const { reconcileTaskSupervision } = await import('../server/services/task-supervision.js');
const { changeTaskStatus } = await import('../server/services/task-lifecycle.js');
const { saveRotationGroup } = await import('../server/services/rotation.js');
const { bindTaskRotations } = await import('../server/services/task-rotation.js');
// The real lifecycle intentionally requires the Tasks adapter for recurrence.
await import('../server/routes/tasks.js');
const db = get();
let server, browser, otherBrowser, origin, client = 60, serverOutput = '';
const kids=[];
const password = 'Isolated-Card-Browser-Only-2026!';
const createUser = (name, role, family) => Number(db.prepare("INSERT INTO users(username,display_name,first_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,'test',?,?,1)").run(name, name, name, role, family).lastInsertRowid);
const admin = createUser('QA card parent', 'admin', 'parent');
const learner = createUser('QA card learner', 'member', 'child');
db.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
db.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(learner);
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
  await browser?.close(); await otherBrowser?.close();
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

test('real app: author shared nightly Activity, override and second client, next recurrence, independent consumers and Workflow operation authoring',{timeout:180000},async()=>{
  const page=await openClient();let second;
  try {
    await manager(page,'rotations');await page.waitForSelector('[data-rotation-create]');await click(page,'[data-rotation-create]');
    await page.waitForSelector('[data-rotation-group-form]');await set(page,'[data-rotation-group-form] [name=name]','Kids Shower Order');
    for(const kid of kids)await page.select('[data-rotation-add-member]',String(kid));
    await submit(page,'[data-rotation-group-form]');
    await page.waitForFunction(()=>!document.querySelector('[data-rotation-group-form]'));
    const group=db.prepare("SELECT * FROM rotation_groups WHERE name='Kids Shower Order'").get();assert.ok(group);
    await manager(page,'activities');await page.waitForSelector('#automation-add-activity');await click(page,'#automation-add-activity');
    await page.waitForSelector('#automation-activity-form');
    await set(page,'#automation-activity-form [name=name]','Get Ready for Bed');await set(page,'[name=title_template]','Get Ready for Bed');
    await set(page,'#automation-activity-form [name=description]','One nightly owner; individual bedtime Tasks share Shower Order.');
    await page.select('#automation-assignment-strategy','fixed');await page.select('[name=fixed_user_id]',String(admin));
    await page.$eval('[name=subject_required]',el=>{el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}))});
    await page.select('#activity-rrule-freq','DAILY');
    await page.select('#activity-due-offset','0');
    await click(page,'[data-rotation-add]');await set(page,'[data-rotation-label]','Shower Order');await set(page,'[data-rotation-key]','shower_order');
    await page.waitForSelector(`[data-rotation-group] option[value="${group.id}"]`);await page.select('[data-rotation-group]',String(group.id));
    for(const [index,name] of ['Gracelynn','Eleanor','Frankie'].entries()){
      await click(page,'[data-task-subtask-add]');await set(page,'[data-task-subtask-row]:last-child [data-task-subtask-title]',`${name} bedtime — {{shower_order.position}}`);
    }
    await submit(page,'#automation-activity-form');
    await until(()=>!!db.prepare("SELECT id FROM activity_templates WHERE name='Get Ready for Bed'").get(),'Template save failed');
    const template=db.prepare("SELECT * FROM activity_templates WHERE name='Get Ready for Bed'").get();
    await page.goto(`${origin}/tasks?view=list`);await page.waitForSelector('#btn-new-task');await click(page,'#btn-new-task');await page.waitForSelector('#task-form');
    await page.select('#task-activity-template',String(template.id));await page.waitForFunction(()=>document.querySelector('#task-title')?.value==='Get Ready for Bed');
    await set(page,'#task-start-date',todayKey(db));
    for(const [index,kid] of kids.entries())await page.select(`[data-task-subtask-row]:nth-child(${index+1}) [data-task-subtask-assignee]`,String(kid));
    await click(page,'#task-submit-btn');await page.waitForFunction(()=>!document.querySelector('#task-form'));
    const owner=db.prepare("SELECT * FROM tasks WHERE parent_task_id IS NULL AND title='Get Ready for Bed' ORDER BY id DESC").get();assert.ok(owner);
    assert.equal(owner.is_recurring,1);assert.equal(owner.due_date,todayKey(db));assert.equal(owner.due_date_offset_days,0);
    const children=()=>db.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY sort_order,id').all(owner.id);
    assert.deepEqual(children().map(child=>child.assigned_to),kids);assert.deepEqual(children().map(child=>child.title),['Gracelynn bedtime — 1','Eleanor bedtime — 2','Frankie bedtime — 3']);
    const occurrence=db.prepare('SELECT * FROM task_rotation_occurrences WHERE owner_task_id=?').get(owner.id);assert.ok(occurrence);
    for(const [index,child] of children().entries()){
      await page.evaluate(async id=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id)},child.id);
      await page.waitForSelector('.detail-view__pane [data-task-rotation-context]');assert.match(await page.$eval('.detail-view__pane [data-task-rotation-context]',el=>el.innerText),new RegExp(['1st','2nd','3rd'][index]));
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.detail-view__pane'));
    }
    second=await openClient();await second.evaluate(async id=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id)},children()[0].id);
    await second.waitForFunction(()=>document.body.innerText.includes('Gracelynn bedtime — 1'));
    await manager(page,'rotations');await page.waitForSelector(`[data-rotation-open="${group.id}"]`);await click(page,`[data-rotation-open="${group.id}"]`);
    await page.waitForSelector(`[data-rotation-history="${occurrence.track_id}"]`);await click(page,`[data-rotation-history="${occurrence.track_id}"]`);
    await page.waitForSelector(`[data-rotation-occurrence="${occurrence.occurrence_id}"] [data-rotation-override]`);await click(page,`[data-rotation-occurrence="${occurrence.occurrence_id}"] [data-rotation-override]`);
    await page.waitForSelector('[data-rotation-override-form]');await page.focus(`[data-rotation-override-form] [data-rotation-member="${kids[2]}"] .rotation-member-handle`);
    await page.keyboard.down('Alt');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.up('Alt');
    await submit(page,'[data-rotation-override-form]');await page.waitForFunction(()=>!document.querySelector('[data-rotation-override-form]'));
    await second.waitForFunction(()=>document.body.innerText.includes('Gracelynn bedtime — 2')&&document.querySelector('.detail-view__pane [data-task-rotation-context]')?.innerText.includes('2nd'));
    assert.deepEqual(children().map(child=>child.title),['Gracelynn bedtime — 2','Eleanor bedtime — 3','Frankie bedtime — 1']);
    const {createMealPlan,materializeMealPlanOccurrences}=await import('../server/services/meal-plans.js');
    const {configureRotationTrack,resolveRotation,finalizeRotation,getRotationTrack}=await import('../server/services/rotation.js');
    const third=configureRotationTrack(db,{consumer_type:'test',consumer_id:'independent',purpose_key:'chore',group_id:group.id,strategy:'round_robin'},{actorId:admin});
    const thirdOccurrence=resolveRotation(db,third.id,'one',{actorId:admin}),showerBefore=getRotationTrack(db,occurrence.track_id);
    for(const id of kids)db.prepare("INSERT OR REPLACE INTO user_skill_proficiency(user_id,skill_id,proficiency,source) SELECT ?,id,'normal','manual' FROM skills WHERE system_key IS NOT NULL").run(id);
    createMealPlan(db,{name:'Independent dinner',rules:[{weekdays:[0,1,2,3,4,5,6],meal_type:'dinner',policy:'round_robin',chooser_rotation_group_id:group.id,participant_ids:kids,cook_strategy:'none',supervisor_strategy:'none'}]},admin);
    materializeMealPlanOccurrences(db,{from:todayKey(db),to:todayKey(db),actorId:admin});
    assert.deepEqual(getRotationTrack(db,occurrence.track_id),showerBefore);assert.equal(getRotationTrack(db,third.id).advance_count,0);
    const mealTrack=db.prepare("SELECT * FROM rotation_tracks WHERE consumer_type='meal_plan'").get();assert.equal(mealTrack.advance_count,1);
    await page.goto(`${origin}/tasks?view=list`);await page.waitForSelector(`article[data-task-id="${owner.id}"] [data-action="toggle-subtasks"]`);
    await click(page,`article[data-task-id="${owner.id}"] [data-action="toggle-subtasks"]`);
    for(const child of children()){
      const control=`[data-action="toggle-subtask"][data-id="${child.id}"]`;await page.waitForSelector(control);await click(page,control);
      await until(()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(child.id).status==='done','Child completion failed');
    }
    await until(()=>!!db.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(owner.id),'Next nightly recurrence missing');
    const next=db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(owner.id);
    const nextLink=db.prepare('SELECT * FROM task_rotation_occurrences WHERE owner_task_id=?').get(next.id);assert.equal(nextLink.track_id,occurrence.track_id);
    const nextOrder=JSON.parse(db.prepare('SELECT order_json FROM rotation_occurrences WHERE id=?').get(nextLink.occurrence_id).order_json).map(value=>value.id);
    assert.deepEqual(nextOrder,kids); // Effective Frankie→Gracelynn→Eleanor advances to Gracelynn.
    assert.equal(getRotationTrack(db,occurrence.track_id).advance_count,1);assert.deepEqual(db.prepare('SELECT * FROM rotation_tracks WHERE id=?').get(mealTrack.id),mealTrack);
    assert.equal(getRotationTrack(db,third.id).advance_count,0);assert.equal(resolveRotation(db,third.id,'one',{actorId:admin}).id,thirdOccurrence.id);
    const oldOccurrence=db.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(occurrence.occurrence_id);
    finalizeRotation(db,oldOccurrence.id,{outcome:'completed',actorId:admin,expectedRevision:oldOccurrence.revision});assert.equal(getRotationTrack(db,occurrence.track_id).advance_count,1);
    await page.evaluate(async id=>{const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id)},owner.id);
    await page.waitForSelector('.detail-view__pane [data-rotation-recorded-completions]');
    await click(page,'.detail-view__pane [data-rotation-recorded-completions] summary');
    assert.match(await page.$eval('.detail-view__pane [data-rotation-recorded-completions]',el=>el.innerText),/not proof of the order activities happened/);
    assert.match(await page.$eval('.detail-view__pane [data-rotation-recorded-completions]',el=>el.innerText),/Gracelynn bedtime/);
    await manager(page,'workflows');await page.waitForSelector('#automation-add-workflow');await click(page,'#automation-add-workflow');await page.waitForSelector('#automation-workflow-form');
    await set(page,'#automation-workflow-form [name=name]','Authored Rotation operations');await click(page,'[data-rotation-add]');
    await set(page,'[data-rotation-label]','Independent order');await set(page,'[data-rotation-key]','independent_order');await page.select('[data-rotation-group]',String(group.id));
    await click(page,'[data-rotation-operation-finalize]');await click(page,'[data-rotation-operation-skip]');
    await submit(page,'#automation-workflow-form');
    await until(()=>!!db.prepare("SELECT id FROM workflow_templates WHERE name='Authored Rotation operations'").get(),'Workflow operation authoring failed');
    const authored=db.prepare("SELECT rotation_bindings_json FROM workflow_templates WHERE name='Authored Rotation operations'").get();
    assert.deepEqual(JSON.parse(authored.rotation_bindings_json)[0].workflow_operations,['resolve','finalize','skip']);
    assert.deepEqual(page.appErrors||[],[]);assert.deepEqual(second.appErrors||[],[]);assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } catch(error) {
    console.error('Rotation full-app diagnostic',await page.evaluate(()=>({url:location.href,text:document.body.innerText.slice(-7000)})),
      db.prepare('SELECT id,parent_task_id,title,status,is_recurring,recurrence_rule,start_date,due_date,due_date_offset_days FROM tasks').all(),serverOutput);throw error;
  } finally {await page.close();await second?.close();}
});
