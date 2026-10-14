import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-device-theme-browser-'));
process.env.DB_PATH=join(folder,'synthetic.db');
Object.assign(process.env,{SESSION_SECRET:'synthetic-theme-browser-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js'),{createDevice,normalizeDevicePreferences,deviceHash}=await import('../server/services/devices.js'),{defaultNamedAppearance}=await import('../public/utils/named-appearance.js');const d=get(),password='SyntheticThemeBrowserOnly!';
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'reviewparent','Synthetic parent',?,'admin','parent',1)").run(await hashPassword(password,4));
d.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run('named_appearance:user:1',JSON.stringify({...defaultNamedAppearance(),theme:'coffee'}));
function fixture(name,theme,allow=true){const preferences=normalizeDevicePreferences(d,{});preferences.allow_theme_changes=allow;preferences.appearance.named_appearance={...defaultNamedAppearance(),theme};preferences.appearance.ui_sounds={version:1,mode:'off',pack:'wood',volume:15};const device=createDevice(d,{name,preferences},1),token='synthetic-browser-theme-'+device.id;d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),'synthetic-browser-context-'+device.id);return{device,token};}
const first=fixture('First review display','hanukkah'),second=fixture('Second review display','christmas',false);const old=JSON.parse(d.prepare('SELECT preferences_json FROM household_devices WHERE id=?').get(first.device.id).preferences_json);delete old.allow_theme_changes;d.prepare('UPDATE household_devices SET preferences_json=? WHERE id=?').run(JSON.stringify(old),first.device.id);
let server,browser,origin;const errors=[];
test.before(async()=>{server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let log='';for(const stream of[server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-4000));origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),30000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+log));});});browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe':undefined)});});
test.after(async()=>{await browser?.close();if(server?.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}d.close();});
const call=(page,method,path,body)=>page.evaluate(async({method,path,body})=>(await import('/api.js')).api[method](path,body),{method,path,body});
async function pageFor(display,width=1280){const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(12000);await page.setViewport({width,height:1000});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);page.on('pageerror',error=>errors.push(error.message));await page.evaluateOnNewDocument(paired=>{localStorage.setItem('yuvomi-locale','en');localStorage.setItem('yuvomi-lang','en');if(paired)localStorage.setItem('vidamia-paired-device','1');},!!display);if(display)await page.setCookie({name:'vidamia.device',value:display.token,url:origin,httpOnly:true});await page.goto(origin+(display?'/device':'/login'));return{page,context};}
async function login(page){await page.waitForSelector('#username');await page.type('#username','reviewparent');await page.type('#password',password);await page.click('[type=submit]');await page.waitForSelector('.dashboard');}
const stored=id=>JSON.parse(d.prepare('SELECT preferences_json FROM household_devices WHERE id=?').get(id).preferences_json);

test('Confirm is present outside the scrolling theme catalog',async()=>{
  const display=fixture('Confirm footer review','fern'),{page,context}=await pageFor(display);
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');
    assert.equal(await page.$eval('.modal-panel',panel=>!!panel.querySelector(':scope > .modal-panel__footer [data-shared-theme-confirm]')),true);
  }finally{await context.close();}
});

test('theme choices preview locally and persist only through Confirm',async()=>{
  const display=fixture('Unsaved preview review','fern'),{page,context}=await pageFor(display);
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme] [data-named-field=theme]');
    await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='coffee');
    assert.equal(stored(display.device.id).appearance.named_appearance.theme,'fern','a preview must not already be saved');
    await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));
    assert.equal(stored(display.device.id).appearance.named_appearance.theme,'coffee');assert.equal(await page.$('#confirm-modal-ok'),null);
  }finally{await context.close();}
});
test('default-enabled shared Theme entry edits only device appearance and temporary/switching cleanup preserves owners',async()=>{
  const {page,context}=await pageFor(first);try{
    await page.waitForSelector('.nav-sidebar [data-device-theme]');assert.equal(await page.$eval('[data-device-theme]',n=>n.disabled),false);assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'hanukkah');const credential=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(first.device.id).context_key;
    await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme] [data-named-field=theme]');assert.equal(await page.$$eval('[data-shared-device-theme] .named-theme-tile',n=>n.length),46);assert.equal(await page.$('[data-shared-device-theme] [data-sound-mode]'),null);
    await page.select('[data-shared-device-theme] [data-named-field=theme]','ocean-glass');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='ocean-glass');assert.equal(stored(first.device.id).appearance.named_appearance.theme,'hanukkah');await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored(first.device.id).appearance.named_appearance.theme,'ocean-glass');assert.deepEqual(stored(first.device.id).appearance.ui_sounds,{version:1,mode:'off',pack:'wood',volume:15});assert.equal(d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(first.device.id).context_key,credential);assert.equal(JSON.parse(d.prepare("SELECT value FROM sync_config WHERE key='named_appearance:user:1'").get().value).theme,'coffee');
    await page.bringToFront();await page.click('[data-device-login]');await login(page);await page.evaluate(()=>window.yuvomi.navigate('/settings/personal/appearance'));await page.waitForSelector('[data-personal-named-appearance]');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');assert.equal(await page.$('[data-device-theme]'),null);
    await page.select('[data-named-field=theme]','medieval-parchment');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));assert.equal(stored(first.device.id).appearance.named_appearance.theme,'ocean-glass');await page.click('[data-device-return]');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='ocean-glass');assert.equal(await page.evaluate(()=>localStorage.getItem('vidamia-named-appearance')),null);assert.equal(await page.evaluate(()=>localStorage.getItem('yuvomi-appearance')),null);
    await page.setCookie({name:'vidamia.device',value:second.token,url:origin,httpOnly:true});await page.goto(origin+'/device');await page.waitForSelector('[data-device-theme]');assert.equal(await page.$eval('[data-device-theme]',n=>n.disabled),true);assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'christmas');assert.equal(stored(first.device.id).appearance.named_appearance.theme,'ocean-glass');
    await page.setViewport({width:390,height:1000});await page.click('#more-btn');await page.waitForSelector('.more-sheet [data-device-theme]');assert.equal(await page.$eval('.more-sheet [data-device-theme]',n=>n.disabled),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test('an open picker follows a second tab and recovers from a stale save without replaying it',async()=>{
  const display=await pageFor(first),peer=await pageFor(first);let held,hold=true;
  try{
    await display.page.waitForSelector('[data-device-theme]');await peer.page.waitForSelector('[data-device-theme]');
    await display.page.click('.nav-sidebar [data-device-theme]');await display.page.waitForSelector('[data-shared-device-theme] [data-named-field=theme]');
    let current=(await call(peer.page,'get','/device/appearance')).data;
    await call(peer.page,'patch','/device/appearance',{revision:current.revision,theme_revision:current.theme_revision,named_appearance:{...defaultNamedAppearance(),theme:'fern'}});
    await display.page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='fern');
    assert.equal(await display.page.$eval('[data-shared-device-theme] [data-named-field=theme]',n=>n.value),'fern','idle picker reconciles the current device choice');
    await display.page.setRequestInterception(true);
    const captured=new Promise(resolve=>display.page.on('request',request=>{if(request.isInterceptResolutionHandled())return;if(hold&&request.method()==='PATCH'&&request.url().endsWith('/device/appearance')){held=request;resolve();}else void request.continue();}));
    await display.page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await display.page.click('[data-shared-theme-confirm]');await captured;
    current=(await call(peer.page,'get','/device/appearance')).data;
    await call(peer.page,'patch','/device/appearance',{revision:current.revision,theme_revision:current.theme_revision,named_appearance:{...defaultNamedAppearance(),theme:'christmas'}});
    hold=false;await held.continue();
    await display.page.waitForFunction(()=>document.querySelector('[data-shared-device-theme] [data-named-field=theme]')?.value==='christmas'&&!document.querySelector('[data-shared-device-theme] .named-appearance-picker').hasAttribute('aria-busy'));
    assert.equal(stored(first.device.id).appearance.named_appearance.theme,'christmas','failed Coffee choice is never replayed');
    await display.page.select('[data-shared-device-theme] [data-named-field=theme]','hanukkah');await display.page.click('[data-shared-theme-confirm]');await display.page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored(first.device.id).appearance.named_appearance.theme,'hanukkah');
  }finally{hold=false;if(held&&!held.isInterceptResolutionHandled())await held.continue();await display.context.close();await peer.context.close();}
});
test('administrator toggle defaults checked, preserves unrelated grants and locks stale device UI',async()=>{
  const admin=await pageFor(),display=await pageFor(first);try{
    await login(admin.page);await admin.page.goto(origin+'/settings/admin/devices');await admin.page.waitForSelector(`[data-device-edit="${first.device.id}"]`);await admin.page.click(`[data-device-edit="${first.device.id}"]`);await admin.page.waitForSelector('[name=allow_theme_changes]');assert.equal(await admin.page.$eval('[name=allow_theme_changes]',n=>n.checked),true);
    const permissions=d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(first.device.id).permissions_json;await display.page.waitForSelector('[data-device-theme]');await display.page.click('.nav-sidebar [data-device-theme]');await display.page.waitForSelector('[data-shared-device-theme]');const oldContext=await display.page.evaluate(async()=>(await import('/utils/device-context.js')).deviceContext()),revision=(await call(display.page,'get','/device/appearance')).data.revision;
    await admin.page.click('[name=allow_theme_changes]');await admin.page.click('[data-device-save]');await admin.page.waitForFunction(()=>!document.querySelector('[data-device-config]'));assert.equal(stored(first.device.id).allow_theme_changes,false);assert.equal(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(first.device.id).permissions_json,permissions);
    const attempted=await display.page.evaluate(async({oldContext,revision})=>{const response=await fetch('/api/v1/device/appearance',{method:'PATCH',headers:{'Content-Type':'application/json','X-Auth-Context':oldContext,'X-CSRF-Token':(await import('/api.js')).getCsrfToken?.()||document.cookie.match(/csrf-token=([^;]+)/)?.[1]||''},body:JSON.stringify({revision,named_appearance:{version:1,theme:'coffee'}})});return response.status;},{oldContext,revision});assert.ok([403,409].includes(attempted));
    await display.page.goto(origin+'/device');await display.page.waitForSelector('[data-device-theme]');assert.equal(await display.page.$eval('[data-device-theme]',n=>n.disabled),true);assert.equal(await display.page.$('[data-shared-device-theme]'),null);
    await admin.page.click(`[data-device-edit="${first.device.id}"]`);await admin.page.waitForSelector('[name=allow_theme_changes]');assert.equal(await admin.page.$eval('[name=allow_theme_changes]',n=>n.checked),false);await admin.page.select('[data-named-field=theme]','hanukkah');await admin.page.click('[data-device-save]');await admin.page.waitForFunction(()=>!document.querySelector('[data-device-config]'));assert.equal(stored(first.device.id).appearance.named_appearance.theme,'hanukkah');assert.equal(stored(first.device.id).allow_theme_changes,false);
  }finally{await admin.context.close();await display.context.close();}
});

test('catalog browsing closes cleanly; rejecting Discard retains the preview, accepting it restores the saved theme',async()=>{
  const display=fixture('Discard review','fern'),{page,context}=await pageFor(display);
  const open=async()=>{await page.evaluate(async()=>{await(await import('/components/device-theme.js')).openDeviceTheme();});await page.waitForSelector('[data-shared-device-theme]');};
  try{
    await page.waitForSelector('[data-device-theme]');await open();await page.type('[data-theme-search]','coffee');await page.select('[data-theme-group]','Food & drink');
    await page.click('[data-shared-theme-cancel]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(await page.$('#confirm-modal-ok'),null);
    await open();await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme] .named-appearance-picker').hasAttribute('aria-busy'));
    await page.click('[data-shared-theme-cancel]');await page.waitForSelector('#confirm-modal-cancel');await page.click('#confirm-modal-cancel');await page.waitForSelector('#shared-modal-overlay [data-shared-device-theme]');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');assert.equal(stored(display.device.id).appearance.named_appearance.theme,'fern');
    await page.keyboard.press('Escape');await page.waitForSelector('#confirm-modal-ok');await page.click('#confirm-modal-ok');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'fern');assert.equal(stored(display.device.id).appearance.named_appearance.theme,'fern');
  }finally{await context.close();}
});

test('repeated Confirm sends one save and normal close paths wait for it',async()=>{
  const display=fixture('Pending confirm review','fern'),{page,context}=await pageFor(display);let held,hold=true,writes=0;
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');
    await page.setRequestInterception(true);
    const captured=new Promise(resolve=>page.on('request',request=>{if(request.isInterceptResolutionHandled())return;if(request.method()==='PATCH'&&request.url().endsWith('/device/appearance')){writes++;if(hold){held=request;resolve();return;}}void request.continue();}));
    const before=stored(display.device.id),row=d.prepare('SELECT revision,permissions_json FROM household_devices WHERE id=?').get(display.device.id),credential=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(display.device.id).context_key;
    await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.evaluate(()=>{const button=document.querySelector('[data-shared-theme-confirm]');button.click();button.click();});await captured;
    assert.equal(await page.evaluate(async()=>await(await import('/components/modal.js')).closeModal()),false);await page.keyboard.press('Escape');
    assert.equal(await page.$eval('[data-shared-theme-confirm]',n=>n.disabled),true);assert.equal(await page.$eval('[data-shared-theme-cancel]',n=>n.disabled),true);assert.equal(await page.$eval('.modal-panel__close',n=>n.disabled),true);assert.equal(await page.$eval('[data-shared-device-theme]',n=>n.inert),true);assert.equal(await page.$('#confirm-modal-ok'),null);assert.equal(writes,1);
    hold=false;await held.continue();await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(writes,1);assert.equal(stored(display.device.id).appearance.named_appearance.theme,'coffee');assert.equal(stored(display.device.id).theme_revision,before.theme_revision+1);assert.deepEqual(stored(display.device.id).appearance.ui_sounds,before.appearance.ui_sounds);assert.deepEqual(d.prepare('SELECT revision,permissions_json FROM household_devices WHERE id=?').get(display.device.id),row);assert.equal(d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(display.device.id).context_key,credential);
  }finally{hold=false;if(held&&!held.isInterceptResolutionHandled())await held.continue();await context.close();}
});

test('a peer save while Discard is open resumes a clean picker without a false second discard prompt',async()=>{
  const display=fixture('Suspended confirm review','fern'),firstPage=await pageFor(display),peer=await pageFor(display);
  try{
    const page=firstPage.page;await page.waitForSelector('[data-device-theme]');await peer.page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.click('[data-shared-theme-cancel]');await page.waitForSelector('#confirm-modal-cancel');
    const model=(await call(peer.page,'get','/device/appearance')).data;await call(peer.page,'patch','/device/appearance',{revision:model.revision,theme_revision:model.theme_revision,named_appearance:{...defaultNamedAppearance(),theme:'christmas'}});await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='christmas');await page.click('#confirm-modal-cancel');await page.waitForFunction(()=>document.querySelector('#shared-modal-overlay [data-shared-device-theme] [data-named-field=theme]')?.value==='christmas');
    const closed=await page.evaluate(async()=>{const closing=(await import('/components/modal.js')).closeModal();await new Promise(resolve=>setTimeout(resolve,0));return{prompt:!!document.querySelector('#confirm-modal-ok'),themeDialog:!!document.querySelector('[data-shared-device-theme]')};});assert.equal(closed.prompt,false,'a peer-reconciled canonical choice is clean');assert.equal(closed.themeDialog,false);assert.equal(stored(display.device.id).appearance.named_appearance.theme,'christmas');
  }finally{await firstPage.context.close();await peer.context.close();}
});

test('a failed Confirm stays open with a visible error and can retry without a discard prompt',async()=>{
  const display=fixture('Failed confirm review','fern'),{page,context}=await pageFor(display);let fail=true,writes=0;
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');await page.setRequestInterception(true);
    page.on('request',request=>{if(request.isInterceptResolutionHandled())return;if(request.method()==='PATCH'&&request.url().endsWith('/device/appearance')){writes++;if(fail){void request.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic save failed'})});return;}}void request.continue();});
    await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.click('[data-shared-theme-confirm]');await page.waitForSelector('[data-shared-theme-error]:not([hidden])');await page.waitForFunction(()=>!document.querySelector('[data-shared-theme-confirm]').disabled);assert.equal(stored(display.device.id).appearance.named_appearance.theme,'fern');assert.equal(await page.$eval('[data-shared-theme-error]',n=>n.textContent),'Synthetic save failed');assert.equal(await page.$('#confirm-modal-ok'),null);
    fail=false;await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored(display.device.id).appearance.named_appearance.theme,'coffee');assert.equal(writes,2);
  }finally{await context.close();}
});

test('an unconfirmed save blocks dismissal until a fresh read can resolve it, and never automatically retries a write',async()=>{
  const display=fixture('Unknown confirm review','fern'),{page,context}=await pageFor(display);let failure=true,writes=0;
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');await page.setRequestInterception(true);
    page.on('request',request=>{if(request.isInterceptResolutionHandled())return;if(request.url().endsWith('/device/appearance')&&failure){if(request.method()==='PATCH')writes++;void request.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic connection unavailable'})});return;}if(request.method()==='PATCH'&&request.url().endsWith('/device/appearance'))writes++;void request.continue();});
    await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.click('[data-shared-theme-confirm]');await page.waitForSelector('[data-shared-theme-error]:not([hidden])');await page.waitForFunction(()=>!document.querySelector('[data-shared-theme-confirm]').disabled);assert.equal(await page.evaluate(async()=>await(await import('/components/modal.js')).closeModal()),false);assert.equal(await page.$eval('[data-shared-theme-cancel]',n=>n.disabled),true);assert.equal(writes,1);
    failure=false;await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(writes,2,'only an explicit second Confirm retries after reading current state');assert.equal(stored(display.device.id).appearance.named_appearance.theme,'coffee');
  }finally{await context.close();}
});

test('forced session cleanup discards a preview and a late save cannot repaint or close the replacement dialog',async()=>{
  const display=fixture('Ending confirm review','fern'),{page,context}=await pageFor(display);let held,hold=true;
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');await page.setRequestInterception(true);
    const captured=new Promise(resolve=>page.on('request',request=>{if(request.isInterceptResolutionHandled())return;if(hold&&request.method()==='PATCH'&&request.url().endsWith('/device/appearance')){held=request;resolve();return;}void request.continue();}));
    await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.click('[data-shared-theme-confirm]');await captured;
    await page.evaluate(async()=>{const context=await import('/utils/device-context.js');context.concealPersonalContext();const modal=await import('/components/modal.js');await modal.closeModal({force:true});modal.openModal({title:'Synthetic replacement',content:'<p data-replacement-dialog>Replacement context</p>'});});
    hold=false;await held.continue();await page.waitForSelector('[data-replacement-dialog]');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme||null),null);assert.equal(await page.$('[data-shared-device-theme]'),null);
  }finally{hold=false;if(held&&!held.isInterceptResolutionHandled())await held.continue();await context.close();}
});

test('Confirm remains visible on small screens, after catalog scrolling, and works by keyboard',async()=>{
  const display=fixture('Responsive confirm review','fern'),{page,context}=await pageFor(display);
  try{
    await page.waitForSelector('[data-device-theme]');await page.evaluate(async()=>{await(await import('/components/device-theme.js')).openDeviceTheme();});await page.waitForSelector('[data-shared-theme-confirm]');
    for(const viewport of[{width:320,height:480},{width:390,height:844},{width:844,height:390},{width:390,height:360},{width:1280,height:900}]){
      await page.setViewport(viewport);await page.evaluate(()=>{const body=document.querySelector('.modal-panel__body');body.scrollTop=body.scrollHeight;});
      const rect=await page.$eval('[data-shared-theme-confirm]',node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,footer:node.closest('.modal-panel__footer').parentElement.classList.contains('modal-panel')};});assert.equal(rect.footer,true);assert.ok(rect.x>=0&&rect.y>=0&&rect.right<=viewport.width+1&&rect.bottom<=viewport.height+1,JSON.stringify({viewport,rect}));assert.ok(rect.width>=44&&rect.height>=44,JSON.stringify(rect));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.focus('[data-shared-theme-confirm]');await page.keyboard.press('Tab');assert.equal(await page.$eval('.modal-panel__close',n=>n===document.activeElement),true);await page.focus('[data-shared-theme-confirm]');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored(display.device.id).appearance.named_appearance.theme,'coffee');assert.equal(await page.$('#confirm-modal-ok'),null);
  }finally{await context.close();}
});

test('forced context cleanup cannot resume a theme dialog parked under Discard',async()=>{
  const display=fixture('Parked cleanup review','fern'),{page,context}=await pageFor(display);
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');await page.select('[data-shared-device-theme] [data-named-field=theme]','coffee');await page.click('[data-shared-theme-cancel]');await page.waitForSelector('#confirm-modal-cancel');
    await page.evaluate(async()=>{(await import('/utils/device-context.js')).concealPersonalContext();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(await page.$('[data-shared-device-theme]'),null);assert.equal(await page.$('#confirm-modal-cancel'),null);assert.equal(await page.$eval('html',node=>node.dataset.namedTheme||null),null);assert.equal(await page.$eval('body',node=>node.style.overflow),'');
  }finally{await context.close();}
});

test('legacy choices discard truthfully and dynamic field validation prevents Confirm from saving hidden old values',async()=>{
  const display=fixture('Legacy confirm review','fern'),{page,context}=await pageFor(display);
  try{
    await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');
    await page.select('[data-shared-device-theme] [data-named-field=theme]','');await page.waitForFunction(()=>!document.querySelector('[data-shared-legacy]').hidden);await page.select('[data-shared-legacy-theme]','dark');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme||null),null);assert.equal(await page.$eval('html',n=>n.dataset.theme),'dark');assert.equal(stored(display.device.id).appearance.named_appearance.theme,'fern');
    await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored(display.device.id).appearance.named_appearance,null);assert.equal(stored(display.device.id).appearance.theme,'dark');
    await page.evaluate(async()=>{await(await import('/components/device-theme.js')).openDeviceTheme();});await page.waitForSelector('[data-shared-device-theme]');await page.select('[data-shared-device-theme] [data-named-field=theme]','seasons');await page.focus('[data-named-field=timeZone]');await page.$eval('[data-named-field=timeZone]',n=>n.value='Invalid/Timezone');await page.keyboard.press('Enter');await page.waitForSelector('[data-named-error]:not([hidden])');assert.equal(await page.$('[data-shared-device-theme]')!==null,true);assert.equal(stored(display.device.id).appearance.named_appearance,null);
    await page.$eval('[data-named-field=timeZone]',n=>n.value='UTC');await page.focus('[data-named-field=timeZone]');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored(display.device.id).appearance.named_appearance.theme,'seasons');assert.equal(stored(display.device.id).appearance.named_appearance.timeZone,'UTC');
  }finally{await context.close();}
});

test('rapid mobile dialog replacement cleans up its current parked owner while the old close animation finishes',async()=>{
  const display=fixture('Rapid cleanup review','fern'),{page,context}=await pageFor(display,390);
  try{
    await page.waitForSelector('[data-device-theme]');await page.evaluate(async()=>{
      const theme=await import('/components/device-theme.js');await theme.openDeviceTheme();await theme.openDeviceTheme();
      const select=document.querySelector('#shared-modal-overlay [data-named-field=theme]');select.value='coffee';select.dispatchEvent(new Event('change',{bubbles:true}));
      void(await import('/components/modal.js')).closeModal();(await import('/utils/device-context.js')).concealPersonalContext();
    });await page.waitForFunction(()=>!document.querySelector('.modal-overlay'));assert.equal(await page.$('[data-shared-device-theme]'),null);assert.equal(await page.$eval('html',node=>node.dataset.namedTheme||null),null);assert.equal(stored(display.device.id).appearance.named_appearance.theme,'fern');
  }finally{await context.close();}
});

test('shared Appearance is in the utility regions with collapsed, mobile, keyboard and permission access',async()=>{
  const display=fixture('Appearance placement review','fern'),{page,context}=await pageFor(display);
  try{
    await page.waitForSelector('[data-device-theme]');assert.equal(await page.$eval('.nav-sidebar [data-device-theme]',node=>node.closest('.nav-sidebar__footer-actions')!==null),true);assert.equal(await page.$eval('.nav-sidebar [data-device-theme]',node=>node.getAttribute('aria-label')),'Appearance');
    await page.click('.nav-sidebar__toggle');await page.waitForFunction(()=>document.documentElement.classList.contains('sidebar-collapsed'));await page.focus('.nav-sidebar__footer-actions [data-device-theme]');await page.keyboard.press('Enter');await page.waitForSelector('[data-shared-device-theme]');await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));
    await page.evaluate(async()=>{await(await import('/i18n.js')).setLocale('de');});await page.waitForFunction(()=>document.querySelector('.nav-sidebar__footer-actions [data-device-theme]')?.getAttribute('aria-label')!=='Appearance');assert.equal(await page.$$eval('.nav-sidebar [data-device-theme]',nodes=>nodes.length),1);await page.evaluate(async()=>{await(await import('/i18n.js')).setLocale('en');});
    for(const width of[320,390,820]){
      await page.setViewport({width,height:844});await page.click('#more-btn');await page.waitForSelector('.more-sheet__system [data-device-theme]');const state=await page.$eval('.more-sheet__system [data-device-theme]',node=>{const rect=node.getBoundingClientRect();return{label:node.getAttribute('aria-label'),width:rect.width,height:rect.height,inside:rect.left>=0&&rect.right<=innerWidth+1,fullRow:node.classList.contains('more-action--device-session')};});assert.equal(state.label,'Appearance');assert.equal(state.fullRow,false);assert.ok(state.width>=44&&state.height>=44&&state.inside,JSON.stringify({width,state}));await page.focus('.more-sheet__system [data-device-theme]');await page.keyboard.press('Enter');await page.waitForSelector('[data-shared-device-theme]');assert.equal(await page.$eval('#more-sheet',node=>node.inert),true);await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));
    }
    const preferences=stored(display.device.id);preferences.allow_theme_changes=false;d.prepare('UPDATE household_devices SET preferences_json=? WHERE id=?').run(JSON.stringify(preferences),display.device.id);await page.goto(origin+'/device');await page.waitForSelector('[data-device-theme]');await page.click('#more-btn');await page.waitForSelector('.more-sheet__system [data-device-theme]');assert.equal(await page.$eval('.more-sheet__system [data-device-theme]',node=>node.disabled&&node.getAttribute('aria-disabled')==='true'),true);assert.equal(await page.$('[data-shared-device-theme]'),null);
  }finally{await context.close();}
});
