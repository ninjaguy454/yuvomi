import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-paired-shell-'));
Object.assign(process.env,{DB_PATH:join(folder,'test.db'),SESSION_SECRET:'synthetic-paired-shell-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-shell-family-2026!';
const hash=await hashPassword(password);
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'Alex','Alex Parent',?,'admin','parent',1)").run(hash);
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(2,'Sam','Sam Member',?,'member','child',1)").run(hash);
d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('family_name','Maple Grove')").run();
let server,browser,origin,admin,display,member;
const call=(page,method,path,body)=>page.evaluate(async({method,path,body})=>{const {api}=await import('/api.js');return api[method](path,body);},{method,path,body});
async function login(page,name='Alex') {
  await page.bringToFront();await page.waitForSelector('#username');
  await page.type('#username',name);await page.type('#password',password);await page.click('[type=submit]');
  await page.waitForSelector('.dashboard-overview__title');
}
async function snapshot(name,page=display) {
  if(!process.env.SHELL_EVIDENCE)return;
  mkdirSync(process.env.SHELL_EVIDENCE,{recursive:true});await page.screenshot({path:join(process.env.SHELL_EVIDENCE,`${name}.png`),fullPage:true});
}
test.before(async()=>{
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
  let output='';for(const stream of [server.stdout,server.stderr])stream.on('data',v=>output=(output+v).slice(-5000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(output)),60000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin);});server.once('exit',code=>{clearTimeout(timer);reject(new Error(`${code}: ${output}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--no-sandbox']});
  const pages=[];for(let n=0;n<3;n++){const context=await browser.createBrowserContext();const page=await context.newPage();page.setDefaultTimeout(12000);await page.setViewport({width:1440,height:1000});await page.goto(origin+'/login');await page.evaluate(()=>localStorage.setItem('yuvomi-locale','en'));await page.reload();pages.push(page);}
  [admin,display,member]=pages;await login(admin);await login(member,'Sam');
  const pair=await call(display,'post','/device/pair',{});
  await call(admin,'post','/devices/pairing-approve',{code:pair.code,name:'wall'});
  await call(display,'post','/device/pair/claim',{confirm_transition:true});
  await display.goto(origin+'/device');await display.waitForSelector('.dashboard-overview__title');
});
test.after(async()=>{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(r=>server.once('exit',r));}d.close();rmSync(folder,{recursive:true,force:true});});
test('paired dashboard uses family name without header banner or personal authority',async()=>{
  await display.bringToFront();await snapshot('desktop-household');
  assert.equal(await display.$('.device-access-banner'),null);
  assert.equal(await display.$('.device-temporary-banner'),null);
  assert.match(await display.$eval('.dashboard-overview__title',n=>n.textContent),/^Hello,? Maple Grove Family[.!]?$/);
  assert.equal(await display.$('.nav-sidebar [data-route="/settings"]'),null,'relocating login never grants Settings');
  assert.equal(await display.$eval('.nav-sidebar [data-device-login]',n=>n.checkVisibility()),true);
  const me=await call(display,'get','/auth/me');assert.equal(me.principal.kind,'device');assert.equal(me.user.id,null);
  await assert.rejects(call(display,'put','/preferences',{family_name:'Device write'}));
});
test('normal users keep first-name greetings and only admin sees Family Name editor',async()=>{
  assert.match(await admin.$eval('.dashboard-overview__title',n=>n.textContent),/Alex/);
  assert.doesNotMatch(await admin.$eval('.dashboard-overview__title',n=>n.textContent),/Maple|Parent/);
  assert.match(await member.$eval('.dashboard-overview__title',n=>n.textContent),/Sam/);
  await admin.bringToFront();await admin.goto(origin+'/settings/admin/system');await admin.waitForSelector('#household-family-name');
  assert.equal(await admin.$eval('#household-family-name',n=>n.value),'Maple Grove');
  await admin.focus('#household-family-name');await admin.keyboard.down('Control');await admin.keyboard.press('A');await admin.keyboard.up('Control');await admin.keyboard.type('  Maple Grove  ');
  const saved=admin.waitForResponse(r=>r.url().endsWith('/preferences')&&r.request().method()==='PUT');
  await admin.click('#household-profile-form [type="submit"]');assert.equal((await saved).status(),200);
  await admin.waitForFunction(()=>document.querySelector('#household-profile-status')?.textContent==='Family Name saved.');
  assert.equal(await admin.$eval('#household-family-name',n=>n.value),'Maple Grove');
  await snapshot('family-name-setting',admin);
  await member.goto(origin+'/settings/admin/system');assert.equal(await member.$('#household-family-name'),null);
});
test('family suffix appears once; unset name is generic and never falls back to device or member name',async()=>{
  for(const [name,expected] of [['Jones Family','Hello Jones Family'],['Jones family','Hello Jones family'],['Family of Oaks','Hello Family of Oaks'],['<b>Oak</b>','Hello <b>Oak</b> Family'],['','Hello household']]) {
    await call(admin,'put','/preferences',{family_name:name});await display.reload();await display.waitForSelector('.dashboard-overview__title');
    assert.equal((await display.$eval('.dashboard-overview__title',n=>n.textContent)).replace(/[,!.]/g,''),expected);
    assert.equal(await display.$('.dashboard-overview__title b'),null,'configured name stays text');
  }
  await call(admin,'put','/preferences',{family_name:'Maple Grove'});
});
for(const width of [320,390,1440])test(`session control remains keyboard/touch reachable at ${width}px`,async()=>{
  await display.bringToFront();await display.setViewport({width,height:900,isMobile:width<640,hasTouch:width<640});await display.reload();await display.waitForSelector('.dashboard-overview__title');
  if(width<640){await display.click('#more-btn');await display.waitForSelector('.more-sheet [data-device-login]',{visible:true});}
  else await display.evaluate(()=>document.documentElement.classList.add('sidebar-collapsed'));
  await display.waitForFunction(()=>!document.querySelector('#more-sheet')?.getAnimations().some(a=>a.playState==='running'));
  const selector=width<640?'.more-sheet [data-device-login]':'.nav-sidebar [data-device-login]';
  await display.focus(selector);
  const target=await display.$eval(selector,n=>{n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{visible:n.checkVisibility(),focused:document.activeElement===n,label:n.getAttribute('aria-label'),width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
  assert.equal(target.visible,true);assert.equal(target.focused,true);assert.match(target.label,/Sign in temporarily/);
  assert.ok(target.width>=(width<640?48:44)&&target.height>=(width<640?48:44));assert.ok(target.left>=0&&target.right<=width&&target.top>=0&&target.bottom<=900,JSON.stringify(target));
  await snapshot(`session-control-${width}`);
  if(width<640)await display.keyboard.press('Escape');
});
test('locale changes refresh both session actions and retain navigation focus behavior',async()=>{
  await display.bringToFront();await display.setViewport({width:1440,height:1000});
  const selector='.nav-sidebar [data-device-login]';
  await display.focus(selector);
  try {
    const retained=await display.evaluate(async()=>{
      let retained=false;
      window.addEventListener('locale-changed',()=>{retained=document.activeElement===document.querySelector('.nav-sidebar [data-device-login]');},{once:true});
      await (await import('/i18n.js')).setLocale('de');return retained;
    });
    assert.equal(retained,true,'the navigation rebuild preserves focus on its replaced control');
    await display.waitForFunction(()=>document.querySelector('.more-sheet [data-device-login]')?.getAttribute('aria-label')==='Vorübergehend anmelden');
    const state=await display.$eval(selector,n=>({text:n.textContent.trim(),label:n.getAttribute('aria-label'),title:n.title}));
    assert.equal(state.text,'Vorübergehend anmelden');assert.equal(state.label,state.text);assert.equal(state.title,state.text);
    // Locale changes also rerender the current page; its normal route-focus
    // behavior takes over after the synchronous navigation rebuild.
    await display.waitForFunction(()=>document.activeElement?.id==='main-content');
  } finally {
    await display.evaluate(async()=>{await (await import('/i18n.js')).setLocale('en');});
    await display.waitForFunction(()=>document.querySelector('.nav-sidebar [data-device-login]')?.getAttribute('aria-label')==='Sign in temporarily');
  }
});
test('temporary login and expiry switch personal greeting back to household with no residual private context',async()=>{
  await display.bringToFront();await display.setViewport({width:1440,height:1000});await display.reload();await display.waitForSelector('.nav-sidebar [data-device-login]');
  await display.click('.nav-sidebar [data-device-login]');await login(display);
  assert.match(await display.$eval('.dashboard-overview__title',n=>n.textContent),/Alex/);
  assert.doesNotMatch(await display.$eval('.dashboard-overview__title',n=>n.textContent),/Maple|Family/);
  assert.equal(await display.$('.device-temporary-banner'),null);
  const order=await display.$eval('.nav-sidebar [data-device-return]',n=>({beforeSettings:n.nextElementSibling?.dataset.route==='/settings',label:n.getAttribute('aria-label')}));
  assert.equal(order.beforeSettings,true);assert.match(order.label,/Return to household/);
  await snapshot('temporary-personal');
  d.prepare('UPDATE device_credentials SET temporary_started_at=?,temporary_idle_at=? WHERE temporary_user_id=1').run(Date.now()-86_400_000,Date.now()-86_400_000);
  await call(display,'get','/tasks').catch(()=>{});
  await display.waitForFunction(()=>document.querySelector('.dashboard-overview__title')?.textContent.includes('Maple Grove Family'));
  assert.equal(await display.$('[data-device-return]'),null);
  assert.equal(await display.$('.nav-sidebar [data-route="/settings"]'),null);
  const me=await call(display,'get','/auth/me');assert.equal(me.principal.kind,'device');assert.equal(me.user.id,null);
  await snapshot('expired-household');
});
