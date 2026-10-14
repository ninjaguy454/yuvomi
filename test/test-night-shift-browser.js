import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-night-shift-'));
process.env.DB_PATH=join(folder,'synthetic.db');
Object.assign(process.env,{SESSION_SECRET:'synthetic-night-shift-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js'),{saveWallConfig,WALL_DEFAULTS}=await import('../server/services/wall.js'),{createDevice,normalizeDevicePreferences,deviceHash}=await import('../server/services/devices.js'),{CARD_SLOTS,NAMED_THEMES,defaultNamedAppearance}=await import('../public/utils/named-appearance.js');
const d=get(),password='SyntheticNightShiftOnly!',appearance=theme=>({...defaultNamedAppearance(),theme});
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'nightreview','Duane (synthetic)',?,'admin','parent',1)").run(await hashPassword(password,4));
d.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run('named_appearance:user:1',JSON.stringify(appearance('coffee')));
d.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run('ui_sounds:user:1',JSON.stringify({version:1,mode:'off',pack:'wood',volume:15}));
for(const [i,slot]of CARD_SLOTS.entries()){
 const id=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,points,card_color,card_color_choice) VALUES(?,1,1,'all',5,?,?)").run(['Set the table for pizza night','Put away the toys and games','Pack the school bag'][i%3]+' '+(i+1),slot,JSON.stringify({version:1,mode:'fixed',slot})).lastInsertRowid);
 d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,1)').run(id);
 d.prepare("INSERT INTO notes(title,content,created_by,pinned,color,card_color_slot) VALUES(?,?,1,1,'#e3d69e',?)").run('The night crew '+(i+1),'Pizza in the oven. Pick a game and grab a cozy spot. Tonight everyone is on the team.',slot);
}
// Keep baseline RED runnable: the assertions below detect a missing catalog entry.
saveWallConfig(d,{...structuredClone(WALL_DEFAULTS),widgets:WALL_DEFAULTS.widgets.map(w=>({...w,visible:['tasks','notes'].includes(w.id)})),appearance:{...WALL_DEFAULTS.appearance,named_appearance:appearance(NAMED_THEMES.some(t=>t.id==='night-shift')?'night-shift':'coffee')}});
function device(name,allow=true){const preferences=normalizeDevicePreferences(d,{});preferences.allow_theme_changes=allow;preferences.appearance.named_appearance=appearance('coffee');preferences.appearance.ui_sounds={version:1,mode:'off',pack:'wood',volume:15};const value=createDevice(d,{name,preferences},1),token='synthetic-night-shift-'+value.id;d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(value.id,deviceHash(token),'synthetic-night-shift-context-'+value.id);return{device:value,token};}
const display=device('Night crew display'),locked=device('Locked display',false);
const stored=id=>JSON.parse(d.prepare('SELECT preferences_json FROM household_devices WHERE id=?').get(id).preferences_json);
const snapshot=()=>({tasks:d.prepare('SELECT id,card_color,card_color_choice FROM tasks ORDER BY id').all(),notes:d.prepare('SELECT id,card_color_slot FROM notes ORDER BY id').all(),household:d.prepare("SELECT key,value FROM sync_config WHERE key NOT LIKE '%:user:%' ORDER BY key").all()});
let server,browser,origin;const errors=[],external=[],measurements=[];
test.before(async()=>{
 server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let log='';for(const stream of[server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-3000));
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),20000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin)});server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+log))})});
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--disable-background-networking']});
});
test.after(async()=>{
 await browser?.close();if(server?.exitCode===null){server.kill();await new Promise(r=>server.once('exit',r))}d.close();
 if(process.env.NIGHT_SHIFT_REVIEW_DIR){mkdirSync(process.env.NIGHT_SHIFT_REVIEW_DIR,{recursive:true});writeFileSync(join(process.env.NIGHT_SHIFT_REVIEW_DIR,'results.json'),JSON.stringify({measurements,errors,external,closedOwnedBrowser:true},null,2))}
 if(resolve(folder).startsWith(resolve(tmpdir())+'\\vidamia-night-shift-'))rmSync(folder,{recursive:true,force:true});
});
async function pageFor(paired){const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(12000);await page.setViewport({width:1440,height:1000});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);page.on('request',r=>{if(r.url().startsWith(origin)||r.url().startsWith('data:'))r.continue();else{external.push(r.url());r.abort()}});await page.evaluateOnNewDocument(value=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');if(value)localStorage.setItem('vidamia-paired-device','1')},!!paired);if(paired)await page.setCookie({name:'vidamia.device',value:paired.token,url:origin,httpOnly:true});await page.goto(origin+(paired?'/device':'/login'));return{context,page}}
async function capture(page,name){if(process.env.NIGHT_SHIFT_REVIEW_DIR){mkdirSync(process.env.NIGHT_SHIFT_REVIEW_DIR,{recursive:true});await page.screenshot({path:join(process.env.NIGHT_SHIFT_REVIEW_DIR,name+'.png')})}}
const settled=page=>page.waitForFunction(()=>!document.querySelector('.named-appearance-picker')?.hasAttribute('aria-busy'));
async function inspect(page,label){const m=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,theme:document.documentElement.dataset.namedTheme,material:document.documentElement.dataset.namedMaterial,decorations:[...document.querySelectorAll('.dashboard-overview,.wall-dashboard__header')].map(n=>({content:getComputedStyle(n,'::after').content,image:getComputedStyle(n,'::after').backgroundImage,height:getComputedStyle(n,'::after').height})),animations:document.getAnimations().filter(a=>a.playState==='running').length}));assert.equal(m.overflow,false,label);measurements.push({label,...m});if(m.theme==='night-shift')for(const art of m.decorations)assert.ok(parseFloat(art.height)>=100,label+' decorative art must remain visible');return m}

test('Night Shift is discoverable, persists personally, paints real stable cards, and leaves no decoration after switching',async()=>{
 const {context,page}=await pageFor();
 try{
  await page.waitForSelector('#username');await page.type('#username','nightreview');await page.type('#password',password);await page.click('[type=submit]');await page.waitForSelector('.dashboard');const before=snapshot();
  await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('[data-personal-named-appearance]');
  for(const alias of ['FNAF',"Five Nights at Freddy's"]){await page.$eval('[data-theme-search]',(n,value)=>{n.value=value;n.dispatchEvent(new Event('input',{bubbles:true}))},alias);assert.equal(await page.$$eval('[data-theme-choice="night-shift"]',nodes=>nodes.length),1,'fan alias must find Night Shift');assert.equal(JSON.parse(d.prepare("SELECT value FROM sync_config WHERE key='named_appearance:user:1'").get().value).theme,'coffee','searching never saves');}
  await page.click('[data-theme-choice="night-shift"]');await settled(page);assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'night-shift');await capture(page,'night-shift-catalog');
  await page.reload();await page.waitForSelector('[data-personal-named-appearance]');assert.equal(await page.$eval('[data-named-field=theme]',n=>n.value),'night-shift');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'night-shift');
  assert.deepEqual(JSON.parse(d.prepare("SELECT value FROM sync_config WHERE key='ui_sounds:user:1'").get().value),{version:1,mode:'off',pack:'wood',volume:15});
  const art=await page.evaluate(async()=>{const image=new Image();image.src='/assets/themes/night-shift-stage.svg';await image.decode();return{width:image.naturalWidth,height:image.naturalHeight}});assert.deepEqual(art,{width:600,height:180});
  await page.goto(origin+'/tasks?view=list');await page.waitForSelector('.activity-card[data-card-color="slot-01-v1"]');
  const fills=await page.evaluate(async()=>{const {NAMED_THEMES,CARD_SLOTS,cardColor,contrastRatio}=await import('/utils/named-appearance.js'),t=NAMED_THEMES.find(t=>t.id==='night-shift');return CARD_SLOTS.map(slot=>{const node=document.querySelector('.activity-card[data-card-color="'+slot+'"]');if(!node)return{slot,missing:true};const p=cardColor(t,slot),probe=document.createElement('span');probe.style.backgroundColor=p.fill;document.body.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return{slot,fill:getComputedStyle(node).backgroundColor,expected,textContrast:contrastRatio(p.text,p.fill),mutedContrast:contrastRatio(p.muted,p.fill)}})});
  for(const p of fills){assert.equal(p.missing,undefined,p.slot);assert.equal(p.fill,p.expected,p.slot);assert.ok(p.textContrast>=4.5);assert.ok(p.mutedContrast>=4.5)}measurements.push({label:'13-real-task-colors',fills});
  await page.goto(origin+'/');await page.waitForSelector('.dashboard-overview');assert.match((await inspect(page,'desktop-1440')).decorations[0].image,/night-shift-stage\.svg/);await capture(page,'night-shift-desktop');
  for(const width of [390,320]){await page.setViewport({width,height:844});await inspect(page,'phone-'+width);await capture(page,'night-shift-phone-'+width)}
  await page.goto(origin+'/notes');await page.waitForSelector('.note-card[data-card-color="slot-01-v1"]');assert.equal(await page.$$eval('.note-card[data-card-color]',n=>new Set(n.map(n=>n.dataset.cardColor)).size),13);await inspect(page,'phone-notes');
  await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('[data-personal-named-appearance]');await page.select('[data-named-field=theme]','coffee');await settled(page);await page.goto(origin+'/');await page.waitForSelector('.dashboard-overview');const cleared=await inspect(page,'switched-coffee');assert.equal(cleared.theme,'coffee');assert.equal(cleared.decorations[0].content,'none');assert.doesNotMatch(cleared.decorations[0].image,/night-shift/);
  await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('[data-personal-named-appearance]');await page.select('[data-named-field=theme]','');await settled(page);assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),undefined,'clearing restores the legacy appearance');await page.select('[data-named-field=theme]','night-shift');await settled(page);
  await page.setViewport({width:1920,height:1080});await page.evaluate(async()=>{await(await import('/api.js')).api.post('/wall/enter',{});(await import('/utils/wall-mode.js')).setWallModeEnabled(true)});await page.goto(origin+'/');await page.waitForSelector('[data-wall-grid]');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='night-shift');assert.match((await inspect(page,'wall-1920')).decorations[0].image,/night-shift-stage\.svg/);await capture(page,'night-shift-wall');
  assert.deepEqual(snapshot(),before,'appearance cannot change household defaults or stored card slots');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 }finally{await context.close()}
});

test('paired Night Shift preview, Cancel and Confirm preserve separate owners and existing locked-device permission',async()=>{
 const personalBefore=d.prepare("SELECT value FROM sync_config WHERE key='named_appearance:user:1'").get().value,firstBefore=stored(display.device.id),lockedBefore=stored(locked.device.id),before=snapshot();
 const {context,page}=await pageFor(display);
 try{
  await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme] [data-named-field=theme]');assert.equal(await page.$$eval('[data-shared-device-theme] [data-named-field=theme] option[value="night-shift"]',n=>n.length),1,'shared picker must offer Night Shift');await page.select('[data-shared-device-theme] [data-named-field=theme]','night-shift');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='night-shift');assert.deepEqual(stored(display.device.id),firstBefore,'preview writes no device settings');
  await page.click('[data-shared-theme-cancel]');await page.waitForSelector('#confirm-modal-ok');await page.click('#confirm-modal-ok');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='coffee');assert.deepEqual(stored(display.device.id),firstBefore);
  await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme] [data-named-field=theme]');await page.select('[data-shared-device-theme] [data-named-field=theme]','night-shift');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='night-shift');await capture(page,'night-shift-device-preview');await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored(display.device.id).appearance.named_appearance.theme,'night-shift');assert.deepEqual(stored(display.device.id).appearance.ui_sounds,firstBefore.appearance.ui_sounds);
  await page.reload();await page.waitForSelector('[data-device-theme]');assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'night-shift');assert.equal(await page.evaluate(()=>localStorage.getItem('vidamia-named-appearance')),null,'paired selection stays out of personal cache');
  assert.equal(d.prepare("SELECT value FROM sync_config WHERE key='named_appearance:user:1'").get().value,personalBefore);assert.deepEqual(stored(locked.device.id),lockedBefore);assert.deepEqual(snapshot(),before);
  await page.setCookie({name:'vidamia.device',value:locked.token,url:origin,httpOnly:true});await page.goto(origin+'/device');await page.waitForSelector('[data-device-theme]');assert.equal(await page.$eval('[data-device-theme]',n=>n.disabled),true);assert.equal(await page.$eval('html',n=>n.dataset.namedTheme),'coffee');
  const denied=await page.evaluate(async()=>{const {api}=await import('/api.js');try{const current=(await api.get('/device/appearance')).data;await api.patch('/device/appearance',{revision:current.revision,theme_revision:current.theme_revision,named_appearance:{...current.named_appearance,theme:'night-shift'}});return false}catch{return true}});assert.equal(denied,true);assert.deepEqual(stored(locked.device.id),lockedBefore);assert.deepEqual(errors,[]);
 }finally{await context.close()}
});
