import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-member-labels-'));
Object.assign(process.env,{DB_PATH:join(folder,'test.db'),SESSION_SECRET:'synthetic-member-labels-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js');
const {hashPassword}=await import('../server/utils/password.js');
const {todayKey}=await import('../server/utils/timezone.js');
const d=get(),password='Synthetic-label-family-2026!',hash=await hashPassword(password);
for(const [id,username,name,role] of [[1,'alex.parent','Alex','admin'],[2,'alex.child','Alex','member'],[3,'riley','Riley','member']]) {
 d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,onboarding_version) VALUES(?,?,?,?,?,1)').run(id,username,name,hash,role);
}
const date=todayKey(d),birth=String(Number(date.slice(0,4))-12)+date.slice(4);
d.prepare("INSERT INTO birthdays(name,birth_date,family_user_id,created_by) VALUES('Alex',?,2,1)").run(birth);
d.exec("INSERT INTO notes(title,content,created_by,visibility) VALUES('Parent note','Parent text',1,'all'),('Child note','Child text',2,'all'),('Riley note','Riley text',3,'all')");
d.exec("INSERT INTO tasks(title,created_by,assigned_to,visibility) VALUES('Assigned task',1,2,'all')");
let server,browser,origin,admin,display,displayId;
const call=(page,method,path,body)=>page.evaluate(async({method,path,body})=>{const {api}=await import('/api.js');return api[method](path,body);},{method,path,body});
const names=page=>page.evaluate(async()=>{const {memberLabel}=await import('/utils/member-label.js');return [1,2,3].map(id=>memberLabel({id,display_name:id===3?'Riley':'Alex'}));});
const screenshot=async(name,page=admin)=>{if(process.env.MEMBER_EVIDENCE){mkdirSync(process.env.MEMBER_EVIDENCE,{recursive:true});await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:join(process.env.MEMBER_EVIDENCE,name+'.png'),fullPage:true});}};
test.before(async()=>{
 server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
 let output='';for(const stream of [server.stdout,server.stderr])stream.on('data',v=>output=(output+v).slice(-5000));
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(output)),60000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin);});server.once('exit',code=>{clearTimeout(timer);reject(new Error(`${code}: ${output}`));});});
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--no-sandbox']});
 for(const kind of ['admin','display']) {
  const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(15000);await page.setViewport({width:390,height:900});await page.goto(origin+'/login');
  await page.evaluate(()=>localStorage.setItem('yuvomi-locale','en'));await page.reload();
  await page.waitForFunction(()=>navigator.serviceWorker?.controller?.state==='activated');await page.reload();
  if(kind==='admin')admin=page;else display=page;
 }
 await admin.type('#username','alex.parent');await admin.type('#password',password);await admin.click('[type=submit]');await admin.waitForSelector('.dashboard-overview__title');
 const pair=await call(display,'post','/device/pair',{});
 displayId=(await call(admin,'post','/devices/pairing-approve',{code:pair.code,name:'Label test wall'})).data.id;
 await call(display,'post','/device/pair/claim',{confirm_transition:true});
 await display.goto(origin+'/device');await display.waitForSelector('.dashboard-overview__title');
});
test.after(async()=>{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(r=>server.once('exit',r));}d.close();rmSync(folder,{recursive:true,force:true});});

test('paired household labels use age or username without exposing birthday or granting Settings',async()=>{
 assert.deepEqual(await names(display),['Alex (alex.parent)','Alex (12)','Riley']);
 const payload=await call(display,'get','/auth/member-labels');
 assert.ok(!JSON.stringify(payload).includes(birth));
 assert.deepEqual(Object.keys(payload.data[0]).sort(),['age','display_name','first_name','id','last_name','name_collisions','username']);
 await assert.rejects(call(display,'get','/family/members'));
 assert.equal(await display.$('[data-route="/settings"]'),null);
 await screenshot('paired-dashboard',display);
});
test('a scoped paired browser disambiguates a hidden household collision without adding candidates',async()=>{
 const revision=d.prepare('SELECT revision FROM household_devices WHERE id=?').get(displayId).revision;
 await call(admin,'patch',`/devices/${displayId}`,{revision,scope:{member_ids:[2]}});
 await display.goto(origin+'/device');await display.waitForSelector('.dashboard-overview__title');
 const labels=await call(display,'get','/auth/member-labels');
 assert.deepEqual(labels.data.map(row=>row.id),[2]);
 assert.deepEqual(await names(display),['Alex','Alex (12)','Riley']);
 assert.deepEqual((await call(display,'get','/auth/users')).data.map(row=>row.id),[2]);
 await assert.rejects(call(display,'get','/family/members'));
 await assert.rejects(call(display,'post','/tasks',{title:'Forbidden',assigned_to:1}));
 await screenshot('scoped-paired-dashboard',display);
});

test('Task, Calendar and Kitchen use one formatter with unchanged assignment IDs',async()=>{
 for(const route of ['/tasks','/calendar','/meals?legacy=1']){
  await admin.goto(origin+route);
  await admin.waitForFunction(async()=>{const {memberLabel}=await import('/utils/member-label.js');return memberLabel({id:2,display_name:'Alex'})==='Alex (12)';});
  assert.deepEqual(await names(admin),['Alex (alex.parent)','Alex (12)','Riley']);
 }
 await admin.goto(origin+'/tasks');await admin.waitForSelector('[data-action="toggle-activity-details"]');
 await admin.click('[data-action="toggle-activity-details"]');
 await admin.waitForSelector('[data-action="show-participant-profile"][data-user-id="2"]');
 assert.equal(await admin.$eval('[data-action="show-participant-profile"][data-user-id="2"]',node=>node.getAttribute('aria-label')),'Alex (12)');
 await screenshot('tasks');
});
test('Notes author chips distinguish duplicate names and filter by the selected creator',async()=>{
 await admin.goto(origin+'/notes');await admin.waitForSelector('[data-creator]');
 const chips=await admin.$$eval('[data-creator]',nodes=>nodes.map(n=>({label:n.textContent,value:n.dataset.creator})));
 const child=chips.find(c=>c.label==='Alex (12)'),parent=chips.find(c=>c.label==='Alex (alex.parent)');
 assert.ok(child&&parent,JSON.stringify(chips));assert.notEqual(child.value,parent.value);
 await admin.locator(`[data-creator="${child.value}"]`).click();
 const titles=await admin.$$eval('.note-card__title',nodes=>nodes.map(n=>n.textContent));
 assert.deepEqual(titles,['Child note']);
 await screenshot('notes-filter');
 await call(admin,'delete','/notes/2');
 await admin.waitForFunction(()=>!document.querySelector('.note-card'));
 const empty=await admin.$eval('#notes-grid',node=>node.textContent);
 assert.ok(empty.includes('Alex (12)'),empty);
 assert.ok(!empty.includes('member:2'),empty);
});
test('Family labels change while editable display names remain canonical',async()=>{
 await admin.goto(origin+'/settings/admin/family');await admin.waitForSelector('[data-edit-user="2"]');
 assert.equal(await admin.$eval('.settings-member[data-id="2"] .settings-member__name',n=>n.textContent),'Alex (12)');
 await admin.click('[data-edit-user="2"]');await admin.waitForSelector('#edit-member-display-name');
 assert.equal(await admin.$eval('#edit-member-display-name',n=>n.value),'Alex');
 assert.equal(d.prepare('SELECT display_name FROM users WHERE id=2').get().display_name,'Alex');
 await screenshot('family-edit');
});

test('creating, renaming and deleting a member refreshes labels without navigating',async()=>{
 await admin.goto(origin+'/settings/admin/family');await admin.waitForSelector('[data-edit-user="2"]');
 const created=await admin.evaluate(async password=>{
  const {auth}=await import('/api.js');return auth.createUser({username:'riley.two',display_name:'Riley',password,role:'member'});
 },password);
 assert.equal((await names(admin))[2],'Riley (riley)');
 await admin.evaluate(async id=>{const {auth}=await import('/api.js');await auth.updateUser(id,{display_name:'Taylor'});},created.user.id);
 assert.equal((await names(admin))[2],'Riley');
 await admin.evaluate(async id=>{const {auth}=await import('/api.js');await auth.deleteUser(id);},created.user.id);
 assert.equal((await names(admin))[2],'Riley');
});
