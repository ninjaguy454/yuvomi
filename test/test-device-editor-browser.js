import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-device-editor-browser-'));
process.env.DB_PATH=join(folder,'test.db');delete process.env.DB_ENCRYPTION_KEY;
process.env.SESSION_SECRET='isolated-device-editor-browser-tests-only';process.env.SESSION_SECURE='false';process.env.BACKUP_ENABLED='false';process.env.NODE_ENV='development';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-device-editor-parent-2026!';let server,browser,origin,adminPage,display,taskId;
const admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('Editor parent','Editor parent','pending','admin','parent',1)").run().lastInsertRowid);
const kids=['Grace','Eleanor'].map(name=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,'no-login','member','child',1)").run(name,name).lastInsertRowid));
const claimTasks=['Claim from board','Claim from details'].map(title=>{
  const id=Number(d.prepare("INSERT INTO tasks(title,points,created_by,visibility) VALUES(?,0,?,'all')").run(title,admin).lastInsertRowid);
  d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state,source) VALUES(?,'open_claimable','open','planning_context')").run(id);
  for(const child of kids)d.prepare('INSERT INTO task_claim_eligibility(task_id,user_id) VALUES(?,?)').run(id,child);
  return id;
});
test.before(async()=>{
  d.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password),admin);
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});let output='';
  server.stdout.on('data',data=>output=(output+data).slice(-6000));server.stderr.on('data',data=>output=(output+data).slice(-6000));
  origin=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(output)),60000);server.once('message',message=>{clearTimeout(timeout);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Server exited ${code}: ${output}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
  adminPage=await (await browser.createBrowserContext()).newPage();display=await (await browser.createBrowserContext()).newPage();
  for(const page of [adminPage,display]){page.setDefaultTimeout(20000);page.on('pageerror',error=>{page.appErrors??=[];page.appErrors.push(error.message);});await page.setViewport({width:1440,height:1050});await page.goto(`${origin}/login`);await page.evaluate(()=>localStorage.setItem('yuvomi-lang','en'));await page.reload();}
});
test.after(async()=>{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}d.close();for(const suffix of ['','-wal','-shm'])try{unlinkSync(join(folder,`test.db${suffix}`));}catch{}try{rmdirSync(folder);}catch{}});
test.afterEach(async context=>{if(context.error)console.log('DEVICE_EDITOR_FAILURE',context.error.stack,display.url(),display.appErrors||[],await display.$eval('body',node=>node.innerText.slice(-3000)).catch(()=>''));});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const card=id=>`article[data-task-id="${id}"]`;
async function request(page,path,method,body){return page.evaluate(async args=>{const{api}=await import('/api.js');return api[args.method](args.path,args.body);},{path,method,body});}
async function tasks(){await display.bringToFront();const cdp=await display.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});await cdp.detach();for(let attempt=0;attempt<30;attempt++){await display.evaluate(()=>window.yuvomi.navigate('/tasks?view=list'));if(new URL(display.url()).pathname==='/tasks')break;await wait(50);}await display.waitForSelector('#btn-new-task');}

test('administrator enables plain editing and the device creates a Task using the normal editor',{timeout:90000},async()=>{
  await adminPage.type('#username','Editor parent');await adminPage.type('#password',password);await adminPage.click('[type=submit]');await adminPage.waitForFunction(()=>!location.pathname.startsWith('/login'));
  await display.goto(origin+'/device/pair');await display.waitForSelector('[data-pair-start]');await display.click('[data-pair-start]');await display.waitForSelector('[data-pair-code]');const code=await display.$eval('[data-pair-code]',el=>el.textContent);
  await adminPage.goto(origin+'/settings/admin/devices');await adminPage.waitForSelector('[data-device-approve]');await adminPage.click('[data-device-approve]');await adminPage.waitForSelector('[data-device-approve-form]');await adminPage.type('[name=code]',code);await adminPage.type('[name=name]','Editor Wall');await adminPage.click('[data-device-approve-form] [type=submit]');
  await display.waitForSelector('[data-pair-claim]');await display.click('[data-pair-claim]');await display.waitForSelector('[data-device-login]');
  await adminPage.waitForSelector('[data-device-edit]');await adminPage.click('[data-device-edit]');await adminPage.waitForSelector('[data-device-config]');
  for(const name of ['action:claim','definition:tasks.create','definition:tasks.edit_others','definition:tasks.change_assignment','definition:tasks.reassign','definition:tasks.change_dates'])await adminPage.click(`[name="${name}"]`);
  await adminPage.select('[name=members]',...kids.map(String));await adminPage.click('[data-device-config] [type=submit]');await adminPage.waitForFunction(()=>!document.querySelector('[data-device-config]'));
  await display.goto(origin+'/device');await display.waitForSelector('.dashboard');await tasks();await display.waitForFunction(()=>document.querySelector('#btn-new-task')?.hidden===false);
  await display.click('#btn-new-task');await display.waitForSelector('#task-form');await display.type('#task-title','Device editor chore');await display.type('#task-description','Created from the normal Task editor.');
  await display.click(`label.user-ms__option:has([data-ms-input="task_assigned"][value="${kids[0]}"])`);
  assert.equal(await display.$eval('#task-points',node=>node.disabled),true);
  assert.equal(await display.$eval('#task-priority',node=>node.disabled),true);
  const response=display.waitForResponse(res=>new URL(res.url()).pathname==='/api/v1/tasks'&&res.request().method()==='POST');await display.click('#task-submit-btn');const result=await response;const saved=await result.json();assert.equal(result.status(),201,JSON.stringify(saved));taskId=saved.data.id;
  await display.waitForFunction(()=>!document.querySelector('#task-form'));await display.waitForSelector(card(taskId));
  const stored=d.prepare('SELECT title,description,assigned_to,points,created_by,source_device_name FROM tasks WHERE id=?').get(taskId);
  assert.deepEqual(stored,{title:'Device editor chore',description:'Created from the normal Task editor.',assigned_to:kids[0],points:0,created_by:null,source_device_name:'Editor Wall'});
  assert.ok(d.prepare('SELECT 1 FROM device_task_creation_receipts WHERE task_id=?').get(taskId));
  assert.equal((await request(display,'/auth/me','get')).user.id,null);
});

test('normal edit saves permitted title dates and reassignment while retaining device identity',{timeout:60000},async()=>{
  assert.ok(taskId);await tasks();await display.click(card(taskId)+' .activity-card__open');await display.waitForSelector('#detail-view-edit');await display.click('#detail-view-edit');await display.waitForSelector('#task-form');
  await display.focus('#task-title');await display.keyboard.down('Control');await display.keyboard.press('A');await display.keyboard.up('Control');await display.keyboard.press('Backspace');await display.type('#task-title','Updated device chore');
  await display.click(`label.user-ms__option:has([data-ms-input="task_assigned"][value="${kids[0]}"])`);await display.click(`label.user-ms__option:has([data-ms-input="task_assigned"][value="${kids[1]}"])`);
  await display.$eval('[name=due_date]',input=>{input.value='2099-02-03';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
  const response=display.waitForResponse(res=>new URL(res.url()).pathname===`/api/v1/tasks/${taskId}`&&res.request().method()==='PUT');await display.click('#task-submit-btn');const result=await response;assert.equal(result.status(),200,JSON.stringify(await result.json()));
  await display.waitForFunction(()=>!document.querySelector('#task-form'));
  const stored=d.prepare('SELECT title,due_date,assigned_to,points,created_by FROM tasks WHERE id=?').get(taskId);assert.deepEqual(stored,{title:'Updated device chore',due_date:'2099-02-03',assigned_to:kids[1],points:0,created_by:null});
  assert.equal((await request(display,'/auth/me','get')).user.kind,'device');await display.keyboard.press('Escape');assert.deepEqual(display.appErrors||[],[]);
});

test('board and detail claims use an explicit action-local recipient and never switch the device identity',{timeout:60000},async()=>{
  await tasks();await display.waitForSelector(`[data-action="claim-activity"][data-id="${claimTasks[0]}"]`);await display.click(`[data-action="claim-activity"][data-id="${claimTasks[0]}"]`);await display.waitForSelector('[data-device-claim]');
  assert.equal(await display.$eval('#device-claim-member',node=>node.value),'');await display.click('[data-claim-cancel]');await display.waitForFunction(()=>!document.querySelector('[data-device-claim]'));assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(claimTasks[0]).assigned_to,null);
  await display.click(`[data-action="claim-activity"][data-id="${claimTasks[0]}"]`);await display.waitForSelector('[data-device-claim]');await display.select('#device-claim-member',String(kids[0]));
  let response=display.waitForResponse(res=>res.url().includes(`/automation/tasks/${claimTasks[0]}/claim`));await display.click('.modal-panel [type=submit]');let result=await response;assert.equal(result.status(),200,JSON.stringify(await result.json()));
  await display.waitForFunction(()=>!document.querySelector('[data-device-claim]'));await display.waitForSelector(card(claimTasks[1])+' .activity-card__open');await display.click(card(claimTasks[1])+' .activity-card__open');
  await display.waitForSelector('#task-detail-claim');await display.click('#task-detail-claim');await display.waitForSelector('[data-device-claim]');assert.equal(await display.$eval('#device-claim-member',node=>node.value),'');await display.select('#device-claim-member',String(kids[1]));
  response=display.waitForResponse(res=>res.url().includes(`/automation/tasks/${claimTasks[1]}/claim`));await display.click('.modal-panel [type=submit]');result=await response;assert.equal(result.status(),200,JSON.stringify(await result.json()));
  assert.deepEqual(claimTasks.map(id=>d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to),kids);
  const events=d.prepare("SELECT actor_user_id,details_json FROM task_activity_events WHERE event_type='claimed'").all();assert.equal(events.length,2);assert.ok(events.every(event=>event.actor_user_id===null&&JSON.parse(event.details_json).source_device.name==='Editor Wall'));
  const identity=await request(display,'/auth/me','get');assert.equal(identity.user.id,null);assert.equal(identity.principal.name,'Editor Wall');assert.equal(identity.temporary,undefined);assert.deepEqual(display.appErrors||[],[]);
});
