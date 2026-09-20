import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-device-browser-'));
process.env.DB_PATH=join(folder,'test.db');delete process.env.DB_ENCRYPTION_KEY;
process.env.SESSION_SECRET='isolated-device-browser-tests-only';process.env.SESSION_SECURE='false';process.env.BACKUP_ENABLED='false';process.env.NODE_ENV='development';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-device-parent-2026!';let server,browser,origin,adminPage,display,adminContext,displayContext,ids=[],kids=[];
const admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('Device parent','Device parent','pending','admin','parent',1)").run().lastInsertRowid);
for(const name of ['Grace','Eleanor','Frankie']){
  const id=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,'no-login','member','child',1)").run(name,name).lastInsertRowid);kids.push(id);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  const root=Number(d.prepare("INSERT INTO tasks(title,assigned_to,points,created_by,visibility) VALUES(?,?,2,?,'all')").run(`${name} morning`,id,admin).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(root,id);
  const children=[];for(const title of ['Brush teeth','Get dressed','Ready'])children.push(Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility) VALUES(?,?,?,'all')").run(title,root,admin).lastInsertRowid));
  ids.push({root,children});
}
test.before(async()=>{
  d.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(password),admin);
  const {saveRotationGroupUsage}=await import('../server/services/rotation-shared.js');
  const {todayKey}=await import('../server/utils/timezone.js');
  saveRotationGroupUsage(d,{name:'Kids Shower Order',member_ids:kids,usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:kids[0],effective_date:todayKey(d),weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},{actorId:admin});
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});let output='';server.stdout.on('data',data=>output=(output+data).slice(-6000));server.stderr.on('data',data=>output=(output+data).slice(-6000));
  origin=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(output)),60000);server.once('message',message=>{clearTimeout(timeout);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Server exited ${code}: ${output}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
  adminContext=await browser.createBrowserContext();displayContext=await browser.createBrowserContext();adminPage=await adminContext.newPage();display=await displayContext.newPage();
  for(const page of [adminPage,display]){page.setDefaultTimeout(20000);page.on('pageerror',error=>{page.appErrors??=[];page.appErrors.push(error.message);});await page.setViewport({width:1440,height:1000});await page.goto(`${origin}/login`);await page.evaluate(()=>localStorage.setItem('yuvomi-lang','en'));await page.reload();}
});
test.after(async()=>{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}d.close();for(const suffix of ['','-wal','-shm'])try{unlinkSync(join(folder,`test.db${suffix}`));}catch{}try{rmdirSync(folder);}catch{}});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const browserRunStarted=Date.now();
let rapidScenariosRan=false;
test.afterEach(async context=>{if(context.error)console.log('DEVICE_ERROR',context.error.cause?.stack||context.error.stack);if(context.error)for(const [label,page] of [['admin',adminPage],['display',display]])console.log('DEVICE_FAILURE',label,page.url(),page.appErrors||[],await page.$eval('body',node=>node.innerText.slice(-1600)).catch(()=>''));});
async function login(page){await page.bringToFront();await page.waitForSelector('#username',{visible:true});await page.type('#username','Device parent');await page.type('#password',password);const response=page.waitForResponse(res=>res.url().endsWith('/api/v1/auth/login')&&res.request().method()==='POST');await page.click('[type=submit]');const result=await response;assert.equal(result.status(),200,JSON.stringify(await result.json()));await page.waitForFunction(()=>!location.pathname.startsWith('/login'));}
async function settings(){await adminPage.bringToFront();await adminPage.goto(`${origin}/settings/admin/devices`);await adminPage.waitForSelector('[data-device-approve]');}
const status=id=>d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;


const card=id=>'article[data-task-id="'+id+'"]';
const step=id=>'[data-action="toggle-subtask"][data-id="'+id+'"]';
async function tasks(page=display,view='list'){
  await page.bringToFront();
  const session=await page.createCDPSession();await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});await session.detach();
  await page.waitForFunction(()=>!!document.querySelector('.app-shell'));
  for(let attempt=0;attempt<30;attempt++){await page.evaluate(path=>window.yuvomi.navigate(path),'/tasks?view='+view);if(new URL(page.url()).pathname==='/tasks'&&new URL(page.url()).searchParams.get('view')===view)break;await wait(50);}
  await page.waitForSelector(card(ids[0].root));
}
async function expand(page,id){
  const selector='[data-action="toggle-subtasks"][data-id="'+id+'"]';
  await page.waitForSelector(selector);
  if(await page.$eval(selector,node=>node.getAttribute('aria-expanded')!=='true'))await page.click(selector);
}
async function pairedIdentity(page=display){return page.evaluate(async()=>{const {auth}=await import('/api.js');return auth.me();});}

test('pairing opens the normal application with device permissions and no extra household member',async()=>{
  await login(adminPage);await display.goto(origin+'/device/pair');await display.waitForSelector('[data-pair-start]');await display.click('[data-pair-start]');await display.waitForSelector('[data-pair-code]');const code=await display.$eval('[data-pair-code]',el=>el.textContent);
  await settings();await adminPage.click('[data-device-approve]');await adminPage.waitForSelector('[data-device-approve-form]');await adminPage.type('[name=code]',code);await adminPage.type('[name=name]','Kitchen Wall');await adminPage.click('[data-device-approve-form] [type=submit]');
  await display.waitForSelector('[data-pair-claim]');await display.click('[data-pair-claim]');await display.waitForSelector('[data-device-login]');await display.waitForSelector('.dashboard');
  assert.equal(await display.$('.device-dashboard'),null,'no separate limited application');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,4);
  const identity=await pairedIdentity();assert.equal(identity.principal.kind,'device');assert.equal(identity.user.kind,'device');assert.equal(identity.user.id,null);assert.equal(identity.permissions.admin,false);
  assert.equal(identity.permissions.capabilities['device_tasks.complete'],'allow');assert.equal(identity.permissions.capabilities['device_tasks.reopen'],'none');
  assert.equal(await display.$('[data-device-identity-picker]'),null);
  assert.equal(await display.$('.nav-sidebar [data-route="/settings"]'),null);
  assert.equal(await display.$('.nav-sidebar [data-route="/birthdays"]'),null);
  assert.equal(await display.$('.nav-item--search'),null);
  assert.equal(await display.$('#dashboard-customize-btn'),null,'display configuration remains administrator controlled');
  await display.waitForSelector('.widget--rotations');
  const sharedOrder=await display.$eval('.widget--rotations',node=>node.textContent);
  for(const value of ['Kids Shower Order','Grace','Eleanor','Frankie'])assert.ok(sharedOrder.includes(value),value+' remains visible in the normal dashboard');
  assert.equal(await display.$('.widget--rotations button'),null,'shared order is a read-only projection');
  await display.screenshot({path:'.qa-device-normal-dashboard.png'});
  await tasks();assert.equal(await display.$eval('#btn-new-task',node=>node.hidden),true);
});

test('permitted modules use their existing screens with personal actions unavailable',async()=>{
  for(const [path,selector] of [['/calendar','.calendar-page'],['/meals','.meals-page'],['/shopping','.shopping-page'],['/rewards','.rewards-page']]){
    await display.bringToFront();await display.evaluate(path=>window.yuvomi.navigate(path),path);await display.waitForSelector(selector);await display.waitForSelector('.module-readonly-banner');
    assert.equal(await display.$('.empty-state--error'),null,path+' loads its scoped response');
    assert.equal((await pairedIdentity()).user.kind,'device');
    if(path==='/meals'){
      assert.equal(await display.$eval('#meal-view-choices',node=>node.hidden),true);
      assert.equal(await display.$('[data-meal-decision]'),null);
    }
    if(path==='/rewards')assert.equal(await display.$('.rw-redeem-open'),null);
  }
  assert.deepEqual(display.appErrors||[],[]);await tasks();
});

test('normal List, Kanban and Task Details paint provisional checkboxes while canonical HTTP is held',async()=>{
  const measurements=[];
  for(const [index,view] of ['list','kanban','details'].entries()){
    await tasks(display,view==='details'?'list':view);await expand(display,ids[index].root);
    const child=ids[index].children[0];let selector=step(child);
    if(view==='details'){
      await display.click(card(ids[index].root)+' .activity-card__open');
      selector='.detail-subtask[data-subtask-id="'+child+'"] .detail-subtask__toggle';
    }
    await display.waitForSelector(selector);
    await display.$eval(selector,button=>button.scrollIntoView({block:'center',inline:'nearest'}));
    await display.setRequestInterception(true);let dispatched,release,count=0;const ready=new Promise(resolve=>dispatched=resolve);
    const intercept=request=>{if(request.url().endsWith('/tasks/'+child+'/status')){count++;release=()=>request.continue();dispatched();}else request.continue();};display.on('request',intercept);
    await display.$eval(selector,button=>{window.deviceFeedbackPromise=new Promise(resolve=>button.addEventListener('click',()=>{const started=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({pressed:button.getAttribute('aria-pressed'),busy:button.getAttribute('aria-busy'),elapsed:performance.now()-started,checkmark:!!button.querySelector('svg path')?.getAttribute('d')})));},{capture:true,once:true}));});
    await display.click(selector);await display.$eval(selector,button=>button.click());
    const feedback=await display.evaluate(()=>window.deviceFeedbackPromise);
    await ready;assert.equal(feedback.pressed,'true');assert.equal(feedback.busy,'true');assert.equal(feedback.checkmark,true);assert.equal(status(child),'open');assert.equal(count,1);
    await display.screenshot({path:'.qa-device-feedback-'+view+'.png',fullPage:false});
    await wait(450);release();await display.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-busy')==='false',{},selector);assert.equal(status(child),'done');
    measurements.push({view,second_frame_ms:feedback.elapsed,held_ack_ms:450});display.off('request',intercept);await display.setRequestInterception(false);
    if(view==='details')await display.keyboard.press('Escape');
  }
  console.log('DEVICE_NORMAL_BROWSER_FEEDBACK',JSON.stringify(measurements));
});

test('normal Task board permits rapid different-child steps and synchronizes a second device client',async()=>{
  await tasks();const other=await displayContext.newPage();await other.goto(origin+'/device');await other.waitForSelector('[data-device-login]');await tasks(other);
  for(const page of [display,other]){const cdp=await page.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});for(const task of ids)await expand(page,task.root);}
  const rapid=ids.map(item=>item.children[1]);await display.evaluate(values=>{for(const id of values)document.querySelector('[data-action="toggle-subtask"][data-id="'+id+'"]').click();},rapid);
  await display.waitForFunction(values=>values.every(id=>document.querySelector('[data-action="toggle-subtask"][data-id="'+id+'"]')?.getAttribute('aria-busy')==='false'),{},rapid);
  await other.waitForFunction(values=>values.every(id=>document.querySelector('[data-action="toggle-subtask"][data-id="'+id+'"]')?.getAttribute('aria-pressed')==='true'),{},rapid);
  assert.deepEqual(rapid.map(status),['done','done','done']);assert.equal((await pairedIdentity()).user.id,null);await other.close();
  rapidScenariosRan=true;
});

test('touch scroll preserves work and display preferences apply to canonical screens without changing the administrator',{timeout:120000},async()=>{
  if(rapidScenariosRan)await wait(Math.max(0,65_000-(Date.now()-browserRunStarted)));
  await display.bringToFront();await display.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await display.goto(origin+'/device');await display.waitForSelector('.dashboard');await tasks();for(const task of ids)await expand(display,task.root);
  const id=ids[1].children[2],selector=step(id);await display.$eval(selector,button=>button.scrollIntoView({block:'center',inline:'nearest'}));
  const rect=await display.$eval(selector,node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});const cdp=await display.createCDPSession();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[rect]});
  for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x,y:rect.y-i*24}]});await wait(18);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(200);assert.equal(status(id),'open');
  await display.screenshot({path:'.qa-device-normal-mobile.png'});
  await adminPage.bringToFront();
  const before=await adminPage.evaluate(async()=>{const{api}=await import('/api.js');return api.get('/preferences');});
  await settings();await adminPage.click('[data-device-edit]');await adminPage.waitForSelector('[data-device-config]');await adminPage.select('[name=default_view]','kanban');await adminPage.select('[name=theme]','dark');await adminPage.select('[name=palette]','warm');await adminPage.select('[name=font]','serif');await adminPage.click('[data-device-save]');await adminPage.waitForFunction(()=>!document.querySelector('[data-device-config]'));
  await display.goto(origin+'/device');await display.waitForSelector('.kanban-board');assert.equal(await display.evaluate(()=>location.pathname+location.search),'/tasks?view=kanban');assert.equal(await display.$eval('html',node=>node.dataset.theme),'dark');assert.equal(await display.$eval('html',node=>node.dataset.colorTheme),'warm');
  const after=await adminPage.evaluate(async()=>{const{api}=await import('/api.js');return api.get('/preferences');});assert.deepEqual(after,before);
  await display.setViewport({width:1920,height:1080,isMobile:false,hasTouch:false});await display.waitForSelector('[data-device-login]');
});

test('temporary real administrator access remains separate and return/reload remove personal screens',{timeout:90000},async()=>{
  await display.waitForSelector('[data-device-login]');await display.click('[data-device-login]');await display.waitForSelector('#username');await login(display);await display.waitForSelector('[data-temporary-access]');await display.waitForSelector('.dashboard');
  assert.match(await display.$eval('[data-temporary-access]',el=>el.textContent),/Signed in as Device parent/);
  await display.evaluate(()=>window.yuvomi.navigate('/settings/admin/devices'));await display.waitForSelector('[data-device-approve]');await Promise.all([display.waitForNavigation({waitUntil:'domcontentloaded'}),display.click('[data-temporary-access] button')]);await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-device-approve]'),null);assert.equal(await display.$('[data-temporary-access]'),null);
  assert.equal((await pairedIdentity(adminPage)).user.id,admin);
  await display.click('[data-device-login]');await display.waitForSelector('#username');await login(display);await display.waitForSelector('[data-temporary-access]');await display.reload();await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-temporary-access]'),null);assert.equal((await pairedIdentity()).user.kind,'device');
});

test('legacy personal Wall can explicitly pair without retaining personal authority',{timeout:90000},async()=>{
  const context=await browser.createBrowserContext(),page=await context.newPage();await page.bringToFront();await page.goto(origin+'/login');await page.evaluate(()=>localStorage.setItem('yuvomi-lang','en'));await page.reload();await login(page);await page.waitForSelector('.dashboard');await wait(300);
  await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('#wall-mode-toggle');await page.click('label:has(#wall-mode-toggle)');await page.waitForSelector('a[href="/device/pair"]');await page.click('a[href="/device/pair"]');await page.waitForSelector('[data-pair-start]');await page.click('[data-pair-start]');await page.waitForSelector('[data-pair-code]');const code=await page.$eval('[data-pair-code]',el=>el.textContent);
  await settings();await adminPage.click('[data-device-approve]');await adminPage.waitForSelector('[data-device-approve-form]');await adminPage.type('[name=code]',code);await adminPage.type('[name=name]','Converted Wall');await adminPage.click('[data-device-approve-form] [type=submit]');await page.waitForSelector('[data-pair-claim]');await page.click('[data-pair-claim]');await page.waitForSelector('[data-device-login]');
  const result=await page.evaluate(async()=>{const {auth,api}=await import('/api.js');const me=await auth.me();let denied=false;try{await api.get('/devices');}catch(error){denied=error.status===403;}return{kind:me.principal.kind,user:me.user,denied};});assert.equal(result.kind,'device');assert.equal(result.user.id,null);assert.equal(result.denied,true);assert.equal((await pairedIdentity(adminPage)).user.id,admin);await context.close();
});

test('server idle and absolute expiry conceal personal views; revoked device receives a stable neutral view',{timeout:60000},async()=>{
  await display.bringToFront();
  for(const boundary of ['idle','maximum']){
    await display.waitForSelector('[data-device-login]');await display.click('[data-device-login]');await display.waitForSelector('#username');await login(display);await display.waitForSelector('[data-temporary-access]');const credential=d.prepare('SELECT id FROM device_credentials WHERE temporary_user_id=?').get(admin);assert.ok(credential);
    d.prepare('UPDATE device_credentials SET '+(boundary==='idle'?'temporary_idle_at':'temporary_started_at')+'=? WHERE id=?').run(Date.now()-700_000,credential.id);
    const rejected=display.waitForResponse(response=>response.url().endsWith('/api/v1/devices')&&[401,409].includes(response.status()));await display.evaluate(()=>{import('/api.js').then(({api})=>api.get('/devices')).catch(()=>{});});await rejected;await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-temporary-access]'),null);assert.equal(d.prepare('SELECT temporary_sid FROM device_credentials WHERE id=?').get(credential.id).temporary_sid,null);
    await display.goBack().catch(()=>{});await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-temporary-access]'),null);
  }
  await adminPage.evaluate(async()=>{const {api}=await import('/api.js');const devices=await api.get('/devices');const wall=devices.data.find(item=>item.name==='Kitchen Wall');await api.post('/devices/'+wall.id+'/revoke',{revision:wall.revision});});await display.waitForSelector('[data-device-retry]');let bootCount=0;const counted=request=>{if(request.url().endsWith('/api/v1/device/launch'))bootCount++;};display.on('request',counted);await display.reload();await display.waitForSelector('[data-device-retry]');await wait(600);assert.equal(bootCount,1);assert.equal(await display.$('[data-temporary-access]'),null);assert.equal(await display.$('.task-card'),null);display.off('request',counted);assert.equal((await pairedIdentity(adminPage)).user.id,admin);
});
