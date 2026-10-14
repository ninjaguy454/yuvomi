import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';

process.env.DB_PATH=join(mkdtempSync(join(tmpdir(),'vidamia-weather-catalog-')),'synthetic.db');
Object.assign(process.env,{SESSION_SECRET:'synthetic-weather-catalog-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js');
const {createDevice,normalizeDevicePreferences,deviceHash}=await import('../server/services/devices.js');
const {defaultNamedAppearance}=await import('../public/utils/named-appearance.js');
const d=get(),password='SyntheticWeatherCatalogOnly!';
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'catalogreview','Synthetic parent',?,'admin','parent',1)").run(await hashPassword(password,4));
for(const [key,value]of Object.entries({weather_lat:'40',weather_lon:'-75',weather_city:'Synthetic household'}))d.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run(key,value);
const preferences=normalizeDevicePreferences(d,{});preferences.allow_theme_changes=true;preferences.appearance.named_appearance={...defaultNamedAppearance(),theme:'fern'};
const device=createDevice(d,{name:'Synthetic weather catalog display',preferences},1),token='synthetic-weather-catalog-token';
d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),'synthetic-weather-catalog-context');
let server,browser,origin;const errors=[];
const stored=()=>JSON.parse(d.prepare('SELECT preferences_json FROM household_devices WHERE id=?').get(device.id).preferences_json);
test.before(async()=>{
 server=fork(new URL('./helpers/local-weather-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let log='';for(const stream of[server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-4000));
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),30000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+log));});});
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe':undefined)});
});
test.after(async()=>{await browser?.close();if(server?.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}d.close();});
async function pageFor(locale='en',paired=false){
 const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(15000);await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);page.on('pageerror',error=>errors.push(error.message));
 await page.evaluateOnNewDocument(({locale,paired})=>{localStorage.setItem('yuvomi-lang',locale);localStorage.setItem('yuvomi-locale',locale);if(paired)localStorage.setItem('vidamia-paired-device','1');},{locale,paired});
 if(paired)await page.setCookie({name:'vidamia.device',value:token,url:origin,httpOnly:true});
 await page.goto(origin+(paired?'/device':'/login'));
 if(!paired){await page.waitForSelector('#username');await page.type('#username','catalogreview');await page.type('#password',password);await page.click('[type=submit]');await page.waitForSelector('.dashboard');await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('[data-personal-named-appearance] .named-theme-tile');}
 return{context,page};
}
const search=(page,value)=>page.$eval('[data-theme-search]',(node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));},value);
const capture=async(page,name)=>{if(process.env.LOCAL_WEATHER_REVIEW_DIR){mkdirSync(process.env.LOCAL_WEATHER_REVIEW_DIR,{recursive:true});await page.screenshot({path:join(process.env.LOCAL_WEATHER_REVIEW_DIR,name+'.png')});}};

// Regresses the fixed-only catalog: a dynamic choice must be browsable and
// selectable from search without pretending its sample is a live forecast.
for(const [locale,name,query,example,current]of[['en','Local Weather','weather','Example preview','Current conditions preview'],['de','Lokales Wetter','Wetter','Beispielvorschau','Vorschau der aktuellen Bedingungen']])test(`real mobile personal ${locale} catalog discovers Local Weather and follows filter and live preview context`,async()=>{
 const {context,page}=await pageFor(locale);
 try{
  assert.equal(await page.$$eval('.named-theme-tile',nodes=>nodes.length),47);
  await search(page,query);assert.equal(await page.$$eval('.named-theme-tile',nodes=>nodes.length),1);
  assert.equal(await page.$eval('[data-theme-choice="local-weather"] .named-theme-name',node=>node.textContent),name);
  assert.match(await page.$eval('[data-theme-choice="local-weather"] small',node=>node.textContent),new RegExp(example));
  assert.equal(await page.$eval('[data-theme-choice="local-weather"]',node=>node.dataset.material),'weather-sun');
  await page.click('[data-theme-filter="light"]');assert.equal(await page.$eval('[data-theme-choice="local-weather"]',node=>node.dataset.material),'stars');
  await page.select('[data-theme-group]','Cafe');assert.equal(await page.$('[data-theme-choice="local-weather"]'),null);
  await page.select('[data-theme-group]','dynamic');assert.ok(await page.$('[data-theme-choice="local-weather"]'));
  await page.click('[data-theme-filter="light"]');await page.click('[data-theme-choice="local-weather"]');
  await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='local-weather-sunny-day'&&!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));
  assert.equal(JSON.parse(d.prepare("SELECT value FROM sync_config WHERE key='named_appearance:user:1'").get().value).theme,'local-weather');
  assert.equal(await page.$eval('[data-theme-choice="local-weather"]',node=>node.getAttribute('aria-pressed')),'true');
  assert.match(await page.$eval('[data-theme-choice="local-weather"] small',node=>node.textContent),new RegExp(current));
  assert.equal(await page.$$eval('[data-named-field="theme"] option[value="local-weather"]',nodes=>nodes.length),1);
  assert.equal(await page.$$eval('[data-season] option[value="local-weather"],[data-window-field="theme"] option[value="local-weather"]',nodes=>nodes.length),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await capture(page,'catalog-personal-'+locale);
  await page.select('[data-named-field="theme"]','');await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-named-theme')&&!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));
  assert.match(await page.$eval('[data-theme-choice="local-weather"] small',node=>node.textContent),new RegExp(example),'leaving live weather refreshes its illustrative preview label');
 }finally{await context.close();d.prepare("DELETE FROM sync_config WHERE key='named_appearance:user:1'").run();}
});

test('real mobile paired catalog searches Local Weather and saves only through Confirm',async()=>{
 const before=stored(),permissions=d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json,{context,page}=await pageFor('en',true);
 try{
  await page.waitForSelector('[data-device-theme]');await page.click('#more-btn');await page.click('.more-sheet [data-device-theme]');await page.waitForSelector('[data-shared-theme-picker] .named-theme-tile');
  await search(page,'Local Weather');assert.equal(await page.$$eval('.named-theme-tile',nodes=>nodes.length),1);assert.deepEqual(stored(),before,'search does not save preferences');
  await page.click('[data-theme-choice="local-weather"]');await page.waitForFunction(()=>document.querySelector('[data-named-field="theme"]').value==='local-weather');
  assert.equal(stored().appearance.named_appearance.theme,'fern','a tile choice remains an unsaved device preview');
  assert.match(await page.$eval('[data-theme-choice="local-weather"] small',node=>node.textContent),/Example preview/,'weather-denied display uses an explicit illustration');
  await capture(page,'catalog-paired-preview');await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));
  assert.equal(stored().appearance.named_appearance.theme,'local-weather');assert.equal(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json,permissions);
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('an administrator preview for a different device stays illustrative even with personal weather active',async()=>{
 const {context,page}=await pageFor();
 try{
  await page.select('[data-named-field="theme"]','local-weather');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='local-weather-sunny-day');
  await page.goto(origin+'/settings/admin/devices');await page.waitForSelector(`[data-device-edit="${device.id}"]`);await page.click(`[data-device-edit="${device.id}"]`);await page.waitForSelector('[data-device-named-appearance] .named-theme-tile');
  await search(page,'weather');assert.ok(await page.$('[data-theme-choice="local-weather"]'));assert.match(await page.$eval('[data-theme-choice="local-weather"] small',node=>node.textContent),/Example preview/);
  await capture(page,'catalog-admin-device');
 }finally{await context.close();d.prepare("DELETE FROM sync_config WHERE key='named_appearance:user:1'").run();}
});

test('actual Wall settings offers Cozy Cafe and the dynamic weather catalog without changing configuration',async()=>{
 const {context,page}=await pageFor();
 try{
  // Entering Wall replaces the document at the privacy boundary. Wait for
  // that real transition instead of racing it with a second page.goto().
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.evaluate(async()=>{await(await import('/api.js')).api.post('/wall/enter',{});(await import('/utils/wall-mode.js')).setWallModeEnabled(true);})]);await page.waitForSelector('[data-wall-grid]');
  await page.click('[data-wall-settings]');await page.waitForSelector('[data-wall-identify-form]');await page.select('[data-wall-identify-form] [name="user_id"]','1');await page.type('[data-wall-identify-form] [name="password"]',password);await page.click('[data-wall-identify-form] [type="submit"]');await page.waitForSelector('[data-wall-named-appearance] .named-theme-tile');
  await search(page,'Cozy');assert.ok(await page.$('[data-theme-choice="cozy-cafe"]'));
  await search(page,'Weather');assert.ok(await page.$('[data-theme-choice="local-weather"]'));assert.equal(await page.$$eval('.named-theme-tile',nodes=>nodes.length),1);
  assert.match(await page.$eval('[data-theme-choice="local-weather"] small',node=>node.textContent),/Example preview/);await capture(page,'catalog-wall-settings');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
