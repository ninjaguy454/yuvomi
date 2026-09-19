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
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});let output='';server.stdout.on('data',data=>output=(output+data).slice(-6000));server.stderr.on('data',data=>output=(output+data).slice(-6000));
  origin=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(output)),60000);server.once('message',message=>{clearTimeout(timeout);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Server exited ${code}: ${output}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
  adminContext=await browser.createBrowserContext();displayContext=await browser.createBrowserContext();adminPage=await adminContext.newPage();display=await displayContext.newPage();
  for(const page of [adminPage,display]){page.setDefaultTimeout(20000);page.on('pageerror',error=>{page.appErrors??=[];page.appErrors.push(error.message);});await page.setViewport({width:1440,height:1000});await page.goto(`${origin}/login`);await page.evaluate(()=>localStorage.setItem('yuvomi-lang','en'));await page.reload();}
});
test.after(async()=>{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}d.close();for(const suffix of ['','-wal','-shm'])try{unlinkSync(join(folder,`test.db${suffix}`));}catch{}try{rmdirSync(folder);}catch{}});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test.afterEach(async context=>{if(context.error)for(const [label,page] of [['admin',adminPage],['display',display]])console.log('DEVICE_FAILURE',label,page.url(),page.appErrors||[]);});
async function login(page){await page.waitForSelector('#username');await page.type('#username','Device parent');await page.type('#password',password);await page.click('[type=submit]');await page.waitForFunction(()=>!location.pathname.startsWith('/login'));}
async function settings(){await adminPage.goto(`${origin}/settings/admin/devices`);await adminPage.waitForSelector('[data-device-approve]');}
const status=id=>d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;

test('real UI pairs an independent device with restrictive permissions, separate configuration and no extra member',async()=>{
  await login(adminPage);await display.goto(`${origin}/device/pair`);await display.waitForSelector('[data-pair-start]');await display.click('[data-pair-start]');await display.waitForSelector('[data-pair-code]');const code=await display.$eval('[data-pair-code]',el=>el.textContent);
  await settings();await adminPage.click('[data-device-approve]');await adminPage.waitForSelector('[data-device-approve-form]');await adminPage.type('[name=code]',code);await adminPage.type('[name=name]','Kitchen Wall');await adminPage.click('[data-device-approve-form] [type=submit]');
  await display.waitForSelector('[data-pair-claim]');await display.click('[data-pair-claim]');await display.waitForSelector('[data-device-login]');await display.waitForFunction(()=>document.querySelectorAll('[data-device-task]').length===3);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,4);assert.equal(d.prepare('SELECT COUNT(*) n FROM household_devices').get().n,1);
  const identity=await display.evaluate(async()=>{const {api}=await import('/api.js');return api.get('/auth/me');});assert.equal(identity.principal.kind,'device');assert.equal(identity.user,undefined);assert.equal(identity.permissions.admin,false);
  assert.equal(identity.permissions.capabilities['device_tasks.complete'],'allow');assert.equal(identity.permissions.capabilities['device_tasks.reopen'],'none');
  assert.equal(await display.$('[data-device-identity-picker]'),null);
  await settings();await adminPage.click('[data-device-edit]');await adminPage.waitForSelector('[data-device-config]');assert.equal(await adminPage.$eval('[name=idle]',el=>el.value),'120');assert.equal(await adminPage.$eval('[name=maximum]',el=>el.value),'600');await adminPage.click('[data-action=close-modal]');
});

test('List, Kanban and mobile checkboxes paint provisionally under held HTTP, suppress duplicate taps and preserve expansion',async()=>{
  const measurements=[];
  for(const [index,view] of ['list','kanban','wall'].entries()){
    if(index===2){await display.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await display.waitForSelector('[data-device-login]');}
    await display.click(`[data-device-view=${view}]`);
    const child=ids[index].children[0],selector=`[data-device-step="${child}"]`;
    await display.waitForSelector(`[data-device-detail="${ids[index].root}"]`);
    await display.click(`[data-device-detail="${ids[index].root}"]`);
    await display.setRequestInterception(true);let dispatched,release,count=0;const requestReady=new Promise(resolve=>dispatched=resolve);
    const intercept=request=>{if(request.url().endsWith(`/device/tasks/${child}/status`)){count++;release=()=>request.continue();dispatched();}else request.continue();};display.on('request',intercept);
    await display.$eval(selector,button=>{window.deviceTapAt=performance.now();button.click();button.click();});await requestReady;
    const feedback=await display.$eval(selector,button=>({checked:button.getAttribute('aria-checked'),busy:button.getAttribute('aria-busy'),elapsed:performance.now()-window.deviceTapAt}));
    assert.equal(feedback.checked,'true');assert.equal(feedback.busy,'true');assert.equal(status(child),'open');assert.equal(count,1);
    assert.equal(await display.$eval(`[data-device-task="${ids[index].root}"]`,node=>node.classList.contains('device-task--detail')),true);
    await display.screenshot({path:`.qa-device-feedback-${view}.png`,fullPage:true});
    await wait(450);release();await display.waitForFunction(id=>document.querySelector(`[data-device-step="${id}"]`)?.getAttribute('aria-busy')==='false',{},child);
    assert.equal(status(child),'done');measurements.push({view,observed_feedback_ms:feedback.elapsed,held_ack_ms:450});
    display.off('request',intercept);await display.setRequestInterception(false);
  }
  console.log('DEVICE_BROWSER_FEEDBACK',JSON.stringify(measurements));
  await display.setViewport({width:1920,height:1080,isMobile:false,hasTouch:false});await display.waitForSelector('[data-device-login]');
});

test('temporary real administrator login, private view, manual return, reload and second-client invalidation',{timeout:90000},async()=>{
  console.log('DEVICE_TEMP_STEP','begin');
  await display.click('[data-device-login]');await display.waitForSelector('#username');await login(display);await display.waitForSelector('[data-temporary-access]');
  await display.waitForSelector('.dashboard');await wait(300);
  console.log('DEVICE_TEMP_STEP','authenticated');
  assert.match(await display.$eval('[data-temporary-access]',el=>el.textContent),/Signed in as Device parent/);
  await display.evaluate(()=>window.yuvomi.navigate('/settings/admin/devices'));await display.waitForSelector('[data-device-approve]');
  console.log('DEVICE_TEMP_STEP','personal-settings');
  await display.click('[data-temporary-access] button');await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-device-approve]'),null);assert.equal(await display.$('[data-temporary-access]'),null);
  console.log('DEVICE_TEMP_STEP','returned');
  assert.equal((await adminPage.evaluate(async()=>{const {auth}=await import('/api.js');return auth.me();})).user.id,admin,'unrelated personal session survives');
  await display.click('[data-device-login]');await display.waitForSelector('#username');await login(display);await display.waitForSelector('[data-temporary-access]');await display.reload();await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-temporary-access]'),null);
  console.log('DEVICE_TEMP_STEP','relaunched');
  const other=await displayContext.newPage();console.log('DEVICE_TEMP_STEP','other-created');other.on('pageerror',error=>console.log('DEVICE_OTHER_ERROR',error.message));other.on('response',response=>{if(response.url().includes('/api/v1/'))console.log('DEVICE_OTHER_RESPONSE',new URL(response.url()).pathname,response.status());});other.setDefaultTimeout(20000);await other.goto(`${origin}/device`);console.log('DEVICE_TEMP_STEP','other-loaded');await other.waitForSelector('[data-device-login]');
  console.log('DEVICE_TEMP_STEP','other-ready');
  // These represent two visible household screens, not a suspended background
  // tab. Background tabs intentionally close their invalidation stream.
  for(const page of [display,other]){const cdp=await page.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});}
  await display.bringToFront();console.log('DEVICE_TEMP_STEP','display-focused');
  const child=ids[0].children[1];await display.waitForSelector(`[data-device-step="${child}"]`);console.log('DEVICE_TEMP_STEP','display-ready');await display.click(`[data-device-step="${child}"]`);await wait(300);console.log('DEVICE_MUTATION',status(child),await display.$eval('[data-device-error]',el=>el.textContent));assert.equal(status(child),'done');console.log('DEVICE_TEMP_STEP','other-update-pending');await other.waitForFunction(id=>document.querySelector(`[data-device-step="${id}"]`)?.getAttribute('aria-checked')==='true',{},child);console.log('DEVICE_TEMP_STEP','other-updated');await other.close();
  assert.deepEqual(display.appErrors||[],[]);assert.deepEqual(adminPage.appErrors||[],[]);
});

test('touch scrolling does not complete work, rapid different-child taps stay independent, and configured widget layout is applied',{timeout:60000},async()=>{
  await display.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await display.waitForSelector('[data-device-login]');await display.click('[data-device-view=list]');
  const panId=ids[1].children[1],selector=`[data-device-step="${panId}"]`;
  await display.waitForSelector(selector);
  await display.$eval(selector,button=>button.scrollIntoView({block:'center'}));
  const rect=await display.$eval(selector,node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
  const cdp=await display.createCDPSession();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[rect]});
  for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x,y:rect.y-i*24}]});await wait(18);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(200);assert.equal(status(panId),'open','scroll gesture is not a completion');
  await display.$eval(selector,button=>button.scrollIntoView({block:'center'}));const tap=await display.$eval(selector,node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});await display.touchscreen.tap(tap.x,tap.y);await display.waitForFunction(id=>document.querySelector(`[data-device-step="${id}"]`)?.getAttribute('aria-busy')==='false',{},panId);assert.equal(status(panId),'done');
  const rapid=ids.map(item=>item.children[2]);await display.evaluate(values=>{for(const id of values)document.querySelector(`[data-device-step="${id}"]`).click();},rapid);
  await display.waitForFunction(values=>values.every(id=>document.querySelector(`[data-device-step="${id}"]`)?.getAttribute('aria-busy')==='false'),{},rapid);assert.deepEqual(rapid.map(status),['done','done','done']);
  await settings();await adminPage.click('[data-device-edit]');await adminPage.waitForSelector('[data-device-config]');
  await adminPage.evaluate(()=>{const form=document.querySelector('[data-device-config]');form.elements['widget:tasks'].checked=false;form.elements['order:rotations'].value='0';form.elements['size:rotations'].value='large';form.elements.density.value='compact';});await adminPage.click('[data-device-config] [type=submit]');await adminPage.waitForFunction(()=>!document.querySelector('[data-device-config]'));
  await display.goto(`${origin}/device`);await display.waitForSelector('[data-device-widget=rotations]');assert.equal(await display.$eval('[data-device-tasks]',node=>node.hidden),true);assert.equal(await display.$eval('[data-device-widgets]',node=>node.firstElementChild.dataset.deviceWidget),'rotations');assert.equal(await display.$eval('[data-device-widget=rotations]',node=>node.dataset.size),'large');assert.equal(await display.$eval('[data-density]',node=>node.dataset.density),'compact');
});

test('legacy personal Wall can explicitly pair without retaining personal authority or terminating another session',{timeout:60000},async()=>{
  const context=await browser.createBrowserContext(),page=await context.newPage();await page.goto(`${origin}/login`);await page.evaluate(()=>localStorage.setItem('yuvomi-lang','en'));await page.reload();await login(page);await page.waitForSelector('.dashboard');await wait(300);
  await page.evaluate(async()=>{const {api}=await import('/api.js');await api.post('/wall/enter',{});const {setWallModeEnabled}=await import('/utils/wall-mode.js');setWallModeEnabled(true);});await page.goto(origin);await page.waitForSelector('a[href="/device/pair"]');await page.click('a[href="/device/pair"]');await page.waitForSelector('[data-pair-start]');await page.click('[data-pair-start]');await page.waitForSelector('[data-pair-code]');const code=await page.$eval('[data-pair-code]',el=>el.textContent);
  await settings();await adminPage.click('[data-device-approve]');await adminPage.waitForSelector('[data-device-approve-form]');await adminPage.type('[name=code]',code);await adminPage.type('[name=name]','Converted Wall');await adminPage.click('[data-device-approve-form] [type=submit]');await page.waitForSelector('[data-pair-claim]');await page.click('[data-pair-claim]');await page.waitForSelector('[data-device-login]');
  const result=await page.evaluate(async()=>{const {auth,api}=await import('/api.js');const me=await auth.me();let denied=false;try{await api.get('/devices');}catch(error){denied=error.status===403;}return{kind:me.principal.kind,user:me.user,denied};});assert.equal(result.kind,'device');assert.equal(result.user,undefined);assert.equal(result.denied,true);assert.equal((await adminPage.evaluate(async()=>{const {auth}=await import('/api.js');return auth.me();})).user.id,admin);await context.close();
});

test('server idle and absolute expiry conceal temporary views; revocation ends in a stable neutral recovery view',{timeout:60000},async()=>{
  await display.bringToFront();
  for(const boundary of ['idle','maximum']){
    await display.waitForSelector('[data-device-login]');await display.click('[data-device-login]');await display.waitForSelector('#username');await login(display);await display.waitForSelector('[data-temporary-access]');
    const credential=d.prepare('SELECT id FROM device_credentials WHERE temporary_user_id=?').get(admin);assert.ok(credential);
    d.prepare(`UPDATE device_credentials SET ${boundary==='idle'?'temporary_idle_at':'temporary_started_at'}=? WHERE id=?`).run(Date.now()-700_000,credential.id);
    const rejected=display.waitForResponse(response=>response.url().endsWith('/api/v1/devices')&&[401,409].includes(response.status()));
    await display.evaluate(()=>{import('/api.js').then(({api})=>api.get('/devices')).catch(()=>{});});await rejected;await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-temporary-access]'),null);assert.equal(d.prepare('SELECT temporary_sid FROM device_credentials WHERE id=?').get(credential.id).temporary_sid,null);
    await display.goBack().catch(()=>{});await display.waitForSelector('[data-device-login]');assert.equal(await display.$('[data-temporary-access]'),null);
  }
  await adminPage.evaluate(async()=>{const {api}=await import('/api.js');const devices=await api.get('/devices');const wall=devices.data.find(item=>item.name==='Kitchen Wall');await api.post(`/devices/${wall.id}/revoke`,{revision:wall.revision});});
  await display.waitForSelector('[data-device-retry]');let bootCount=0;const counted=request=>{if(request.url().endsWith('/api/v1/device/launch'))bootCount++;};display.on('request',counted);await display.reload();await display.waitForSelector('[data-device-retry]');await wait(600);assert.equal(bootCount,1,'revoked bootstrap never redirect loops');assert.equal(await display.$('[data-temporary-access]'),null);assert.equal(await display.$('[data-device-task]'),null);display.off('request',counted);
  assert.equal((await adminPage.evaluate(async()=>{const {auth}=await import('/api.js');return auth.me();})).user.id,admin);
});
