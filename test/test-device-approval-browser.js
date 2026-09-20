/** Real browser + app + canonical supervised Task mutation, no mocked auth. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-inline-approval-'));
process.env.DB_PATH=join(folder,'test.db');delete process.env.DB_ENCRYPTION_KEY;
Object.assign(process.env,{SESSION_SECRET:'isolated-inline-approval-browser-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
const {get}=await import('../server/db.js');
const {hashPassword}=await import('../server/utils/password.js');
const {generateCode}=await import('../server/utils/totp.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
const d=get(),password='Synthetic-supervisor-browser-2026!',hash=await hashPassword(password);
for(const [id,name,role] of [[1,'Parent','admin'],[2,'Eleanor','member'],[3,'Other parent','admin']])
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,1)').run(id,name,name,hash,role,role==='admin'?'parent':'child');
const root=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by,points,visibility) VALUES('Eleanor routine',2,1,2,'all')").run().lastInsertRowid);
d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(root);
d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(2,1)').run();
const steps=['Supervised wash','Supervised dry'].map(title=>Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility) VALUES(?,?,1,'all')").run(title,root).lastInsertRowid));
const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic laundry skill',0,'normal',1)").run().lastInsertRowid);
for(const [id,value] of [[1,'normal'],[2,'supervised'],[3,'excluded']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,skill,value);
for(const id of steps)setTaskSkills(d,id,[skill]);reconcileTaskSupervision(d,root);
let server,browser,origin,admin,display,context,other;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const call=(page,method,path,body)=>page.evaluate(async({method,path,body})=>{const {api}=await import('/api.js');return api[method](path,body);},{method,path,body});
test.before(async()=>{
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});let output='';for(const stream of [server.stdout,server.stderr])stream.on('data',value=>output=(output+value).slice(-6000));
  origin=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(output)),60000);server.once('message',message=>{clearTimeout(timeout);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Server ${code}: ${output}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined),args:['--no-sandbox']});
  admin=await browser.newPage();context=await browser.createBrowserContext();display=await context.newPage();
  for(const page of [admin,display]){page.setDefaultTimeout(20000);page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));await page.setViewport({width:1440,height:1000});await page.goto(origin+'/login');await page.evaluate(()=>localStorage.setItem('yuvomi-lang','en'));await page.reload();}
  await admin.type('#username','Parent');await admin.type('#password',password);await admin.click('[type=submit]');await admin.waitForSelector('.dashboard');
  const pair=await call(display,'post','/device/pair',{});
  await call(admin,'post','/devices/pairing-approve',{code:pair.code,name:'Kitchen Wall'});
  await call(display,'post','/device/pair/claim',{confirm_transition:true});await display.goto(origin+'/device');await display.waitForSelector('[data-device-login]');await pause(1500);
});
test.after(async()=>{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}d.close();rmSync(folder,{recursive:true,force:true});});
async function board(page=display){
  await page.bringToFront();const cdp=await page.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});await cdp.detach();
  await page.waitForSelector('.app-shell');
  for(let attempt=0;attempt<30;attempt++){
    await page.evaluate(()=>window.yuvomi.navigate('/tasks?view=list'));
    if(new URL(page.url()).pathname==='/tasks' && new URL(page.url()).searchParams.get('view')==='list')break;
    await pause(50);
  }
  await page.waitForSelector('article[data-task-id="'+root+'"]');
  const selector='[data-action="toggle-subtasks"][data-id="'+root+'"]';if(await page.$eval(selector,node=>node.getAttribute('aria-expanded')!=='true'))await page.click(selector);
}

test.afterEach(async c=>{if(c.error){console.log('APPROVAL_BROWSER_STATE',display.url(),display.errors,await display.evaluate(()=>document.body.innerText.slice(-3000)));mkdirSync('.qa',{recursive:true});await display.screenshot({path:'.qa/approval-failure.png',fullPage:true});}});
const button=id=>`[data-action="approve-device-task"][data-id="${id}"]`;
async function credentials(name='Parent'){
  await display.waitForSelector('#device-task-approval');await display.waitForFunction(()=>!document.querySelector('[data-approval-submit]')?.disabled);
  await display.$eval('#approval-username',node=>node.value='');await display.type('#approval-username',name);
  await display.$eval('#approval-password',node=>node.value='');await display.type('#approval-password',password);
  await display.click('[data-approval-submit]');
}
test('in-place approval rejects unqualified authentication, preserves the board, completes once and another client converges',{timeout:90000},async()=>{
  await board();const scroll=await display.evaluate(()=>window.scrollY);
  await display.click(button(steps[0]));await display.waitForFunction(()=>!document.querySelector('[data-approval-submit]')?.disabled);
  mkdirSync('.qa',{recursive:true});await display.screenshot({path:'.qa/approval-desktop.png',fullPage:true});
  await credentials('Other parent');
  await display.waitForFunction(()=>document.querySelector('[data-approval-error]')?.hidden===false);
  assert.match(await display.$eval('[data-approval-error]',node=>node.textContent),/assigned qualified/);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(steps[0]).status,'open');
  await display.click('[data-approval-cancel]');await display.waitForFunction(()=>!document.querySelector('#device-task-approval'));
  assert.equal(display.url(),origin+'/tasks?view=list');assert.equal(await display.evaluate(()=>window.scrollY),scroll);
  other=await context.newPage();await other.goto(origin+'/device');await other.waitForSelector('[data-device-login]');await board(other);
  for(const page of [display,other]){const cdp=await page.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});}
  await display.bringToFront();await board();await display.click(button(steps[0]));await credentials();
  await display.waitForFunction(()=>!document.querySelector('#device-task-approval'));
  const completeSelector=`[data-action="toggle-subtask"][data-id="${steps[0]}"]`;
  await display.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-pressed')==='true',{},completeSelector);
  await other.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-pressed')==='true',{},completeSelector);
  const identity=await call(display,'get','/auth/me');assert.equal(identity.principal.kind,'device');assert.equal(identity.user.id,null);assert.equal(identity.temporary,undefined);
  assert.equal(await display.$('[data-temporary-access]'),null);assert.equal(d.prepare('SELECT temporary_sid FROM device_credentials').get().temporary_sid,null);
  assert.equal(d.prepare("SELECT count(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(steps[0]).n,1);
  assert.equal(d.prepare('SELECT count(*) n FROM reward_ledger').get().n,0,'unfinished parent not awarded');
  assert.deepEqual(display.errors,[]);
});
test('mobile Task Details keeps its place through approval and awards canonical parent points once',{timeout:60000},async()=>{
  await other.close();await display.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await display.goto(origin+'/device');await display.waitForSelector('.dashboard');await board();
  await display.click(`article[data-task-id="${root}"] .activity-card__open`);
  await display.waitForSelector(`[data-device-approval="${steps[1]}"]`);
  await display.click(`[data-device-approval="${steps[1]}"]`);await display.waitForSelector('#device-task-approval');await pause(250);assert.equal(await display.$eval('#shared-modal-title',node=>node.textContent),'Supervisor approval');
  await display.screenshot({path:'.qa/approval-mobile.png',fullPage:true});await display.click('[data-approval-cancel]');
  await display.waitForFunction(id=>!document.querySelector('#device-task-approval') && (()=>{const button=document.querySelector(`[data-device-approval="${id}"]`);return button&&!button.disabled&&!button.closest('[inert]');})(),{},steps[1]);
  assert.ok(await display.$('.detail-subtask'));
  await display.click(`[data-device-approval="${steps[1]}"]`);await credentials();
  await display.waitForFunction(()=>!document.querySelector('#device-task-approval'));
  await display.waitForFunction(id=>document.querySelector(`.detail-subtask[data-subtask-id="${id}"] .detail-subtask__toggle`)?.getAttribute('aria-pressed')==='true',{},steps[1]);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'done');
  assert.deepEqual(d.prepare('SELECT user_id,delta,created_by FROM reward_ledger').all(),[{user_id:2,delta:2,created_by:1}]);
  const completion=d.prepare('SELECT user_id,source_device_name FROM task_completions WHERE task_id=?').get(root);assert.deepEqual(completion,{user_id:1,source_device_name:'Kitchen Wall'});
  assert.equal((await call(display,'get','/auth/me')).principal.kind,'device');assert.deepEqual(display.errors,[]);
});

test('receipt-driven second factor continues in place, as required after an SSO callback',{timeout:60000},async()=>{
  await display.keyboard.press('Escape');
  const parent=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by,visibility) VALUES('Second-factor routine',2,1,'all')").run().lastInsertRowid);
  const step=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility) VALUES('Second-factor step',?,1,'all')").run(parent).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(parent);setTaskSkills(d,step,[skill]);reconcileTaskSupervision(d,parent);
  const setup=await call(admin,'post','/auth/2fa/setup',{}),secret=setup.secret??setup.data?.secret;
  const enabled=await call(admin,'post','/auth/2fa/enable',{code:generateCode(secret)}),recovery=enabled.recovery_codes??enabled.data?.recovery_codes;
  await display.evaluate(()=>window.yuvomi.navigate('/tasks?view=list'));await display.waitForSelector(`article[data-task-id="${parent}"]`);
  const toggle=`[data-action="toggle-subtasks"][data-id="${parent}"]`;if(await display.$eval(toggle,node=>node.getAttribute('aria-expanded')!=='true'))await display.click(toggle);
  await display.click(button(step));await display.waitForFunction(()=>!document.querySelector('[data-approval-submit]')?.disabled);
  const status=await call(display,'get','/device/approval');
  // Real first factor creates exactly the same bound server receipt as SSO.
  // Do not feed its direct response to the modal: continuation must use polling.
  const first=await call(display,'post','/auth/login',{username:'Parent',password,approval_id:status.approval.id});assert.equal(first.twoFactorRequired,true);
  await display.waitForFunction(()=>document.querySelector('[data-approval-factor]')?.hidden===false);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(step).status,'open');
  await display.type('#approval-code',recovery[0]);await display.click('[data-approval-submit]');
  await display.waitForFunction(()=>!document.querySelector('#device-task-approval'));
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(step).status,'done');
  assert.equal((await call(display,'get','/auth/me')).principal.kind,'device');
  assert.equal(d.prepare('SELECT temporary_sid FROM device_credentials').get().temporary_sid,null);
});
