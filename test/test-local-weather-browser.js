import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-local-weather-browser-'));
process.env.DB_PATH=join(folder,'synthetic.db');
Object.assign(process.env,{SESSION_SECRET:'synthetic-weather-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js'),{saveWallConfig,WALL_DEFAULTS}=await import('../server/services/wall.js'),{CARD_SLOTS,defaultNamedAppearance}=await import('../public/utils/named-appearance.js');
const db=get(),password='SyntheticWeatherOnly!',selected={...defaultNamedAppearance(),theme:'local-weather'};
const {createDevice,normalizeDevicePreferences,deviceHash}=await import('../server/services/devices.js');
db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'weatherreview','Synthetic parent',?,'admin','parent',1)").run(await hashPassword(password,4));
for(const [index,slot]of CARD_SLOTS.entries()){
  const task=Number(db.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,points,card_color,card_color_choice) VALUES(?,1,1,'all',5,?,?)").run('Synthetic weather task '+(index+1),slot,JSON.stringify({version:1,mode:'fixed',slot})).lastInsertRowid);db.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,1)').run(task);
  db.prepare("INSERT INTO notes(title,content,created_by,pinned,color,card_color_slot) VALUES(?,?,1,1,'#e3d69e',?)").run('Synthetic weather note '+(index+1),'A household reminder.',slot);
}
for(const [key,value]of Object.entries({weather_lat:'40',weather_lon:'-75',weather_city:'Household weather', 'weather_lat:user:1':'1','weather_lon:user:1':'2','weather_city:user:1':'PRIVATE PERSONAL LOCATION'}))db.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run(key,value);
saveWallConfig(db,{...structuredClone(WALL_DEFAULTS),widgets:WALL_DEFAULTS.widgets.map(widget=>({...widget,visible:['tasks','notes'].includes(widget.id)})),appearance:{...WALL_DEFAULTS.appearance,named_appearance:selected}});
const snapshot=()=>({tasks:db.prepare('SELECT id,card_color,card_color_choice FROM tasks ORDER BY id').all(),notes:db.prepare('SELECT id,card_color_slot FROM notes ORDER BY id').all()});
let server,browser,origin;const errors=[];
test.before(async()=>{
  server=fork(new URL('./helpers/local-weather-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let log='';for(const stream of[server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-4000));origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),30000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+log));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe':undefined)});
});
test.after(async()=>{await browser?.close();if(server?.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}db.close();});
const capture=async(page,name)=>{if(process.env.LOCAL_WEATHER_REVIEW_DIR){mkdirSync(process.env.LOCAL_WEATHER_REVIEW_DIR,{recursive:true});await page.screenshot({path:join(process.env.LOCAL_WEATHER_REVIEW_DIR,name+'.png')});}};

test('Local Weather saves through real personal settings, paints all ten variants, stable slots and actual Wall',async()=>{
  const page=await browser.newPage(),before=snapshot();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1280,height:900});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');window.__weatherSounds=0;window.addEventListener('vidamia-ui-feedback',()=>window.__weatherSounds++);});
  try{
    await page.goto(origin+'/login');await page.waitForSelector('#username');await page.type('#username','weatherreview');await page.type('#password',password);await page.click('[type=submit]');await page.waitForSelector('.dashboard');await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('[data-personal-named-appearance]');
    assert.equal(await page.$$eval('[data-named-field=theme] optgroup[label="Dynamic themes"] option',nodes=>nodes.length),3);await page.select('[data-named-field=theme]','local-weather');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='local-weather-sunny-day');assert.equal(await page.$eval('.named-date-context',node=>node.hidden),true);assert.equal(JSON.parse(db.prepare("SELECT value FROM sync_config WHERE key='named_appearance:user:1'").get().value).theme,'local-weather');
    const projection=await page.evaluate(async()=>{const {api}=await import('/api.js');return(await api.get('/weather/theme?city=PRIVATE')).data;});assert.deepEqual(Object.keys(projection).sort(),['condition','expires_at','fetched_at','is_day','observed_at','sunrise_at','sunset_at']);assert.ok(!JSON.stringify(projection).includes('PRIVATE'));
    await page.goto(origin+'/tasks?view=list');await page.waitForSelector('[data-card-color="slot-01-v1"].activity-card');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='local-weather-sunny-day');
    let synthetic=null,weatherReads=0;await page.setRequestInterception(true);page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/weather/theme'&&synthetic){weatherReads++;request.respond({status:200,contentType:'application/json',body:JSON.stringify({data:synthetic})});}else request.continue();});
    for(const condition of['sunny','cloudy','rain','storm','snow'])for(const is_day of[true,false]){
      const time=Date.now();synthetic={condition,is_day,observed_at:new Date(time).toISOString(),fetched_at:new Date(time).toISOString(),expires_at:new Date(time+90*60000).toISOString(),sunrise_at:null,sunset_at:null};
      await page.evaluate(async selected=>{const runtime=await import('/utils/named-appearance-runtime.js');runtime.clearNamedAppearance({removeCache:false});runtime.applyNamedAppearance(selected,{persist:false});},selected);const identity=`local-weather-${condition}-${is_day?'day':'night'}`;await page.waitForFunction(identity=>document.documentElement.dataset.namedTheme===identity,{},identity);
      const colors=await page.evaluate(async({selected,synthetic})=>{const {resolveNamedAppearance,CARD_SLOTS,cardColor}=await import('/utils/named-appearance.js'),theme=resolveNamedAppearance(selected,new Date(),synthetic).theme;return CARD_SLOTS.map(slot=>{const node=document.querySelector('.activity-card[data-card-color="'+slot+'"]');if(!node)return{slot,missing:true};const css=getComputedStyle(node),probe=document.createElement('span');probe.style.background=cardColor(theme,slot).fill;document.body.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return{slot,fill:css.backgroundColor,expected};});},{selected,synthetic});for(const color of colors){assert.equal(color.missing,undefined,JSON.stringify(color));assert.equal(color.fill,color.expected,identity+' '+color.slot);}
      assert.equal(await page.$eval('html',node=>node.dataset.theme),is_day?'light':'dark');await capture(page,identity+'-desktop');
    }
    assert.equal(weatherReads,10);await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await capture(page,'weather-mobile-tasks');await page.goto(origin+'/notes');await page.waitForSelector('.note-card[data-card-color="slot-01-v1"]');assert.equal(await page.$$eval('.note-card[data-card-color]',nodes=>new Set(nodes.map(node=>node.dataset.cardColor)).size),13);await capture(page,'weather-mobile-notes');
    synthetic=null;await page.setViewport({width:1920,height:1080});await page.evaluate(async()=>{await(await import('/api.js')).api.post('/wall/enter',{});(await import('/utils/wall-mode.js')).setWallModeEnabled(true);});await page.goto(origin+'/');await page.waitForSelector('[data-wall-grid]');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='local-weather-sunny-day');await capture(page,'weather-wall');assert.ok(await page.$('[data-wall-grid] [data-widget="tasks"]'));assert.ok(await page.$('[data-wall-grid] [data-widget="notes"]'));
    assert.deepEqual(snapshot(),before,'weather rendering never mutates stable task/note choices');assert.equal(await page.evaluate(()=>window.__weatherSounds),0);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('offline saved Local Weather remains selected, uses Neutral and makes no weather request',async()=>{
  const page=await browser.newPage(),reads=[];await page.evaluateOnNewDocument(selected=>{localStorage.setItem('vidamia-named-appearance',JSON.stringify(selected));},selected);page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/v1/weather'))reads.push(request.url());});
  try{await page.goto(origin+'/offline.html');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='neutral');await page.evaluate(async()=>{await import('/utils/offline-appearance.js');});assert.equal(await page.$eval('html',node=>node.dataset.namedTheme),'neutral');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('vidamia-named-appearance')).theme),'local-weather');assert.deepEqual(reads,[]);}finally{await page.close();}
});

test('paired Local Weather previews and confirms without adding Weather permission or date controls',async()=>{
  const preferences=normalizeDevicePreferences(db,{});preferences.allow_theme_changes=true;preferences.appearance.named_appearance={...defaultNamedAppearance(),theme:'fern'};const device=createDevice(db,{name:'Synthetic weather-denied display',preferences},1),token='synthetic-weather-browser-'+device.id;
  db.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),'synthetic-weather-browser-context-'+device.id);
  const before=db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json,stored=()=>JSON.parse(db.prepare('SELECT preferences_json FROM household_devices WHERE id=?').get(device.id).preferences_json),context=await browser.createBrowserContext(),page=await context.newPage();let reads=0;
  await page.setViewport({width:1280,height:900});await page.evaluateOnNewDocument(()=>{localStorage.setItem('vidamia-paired-device','1');localStorage.setItem('yuvomi-lang','en');});await page.setCookie({name:'vidamia.device',value:token,url:origin,httpOnly:true});page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/weather/theme')reads++;});
  try{
    await page.goto(origin+'/device');await page.waitForSelector('[data-device-theme]');await page.click('.nav-sidebar [data-device-theme]');await page.waitForSelector('[data-shared-device-theme]');await page.select('[data-shared-device-theme] [data-named-field=theme]','local-weather');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='neutral');
    assert.equal(stored().appearance.named_appearance.theme,'fern');assert.equal(await page.$eval('.named-date-context',node=>node.hidden),true);await page.click('[data-shared-theme-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));assert.equal(stored().appearance.named_appearance.theme,'local-weather');assert.equal(db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json,before);
    const settled=reads;await page.evaluate(()=>window.dispatchEvent(new Event('online')));assert.ok(reads<=settled+1&&reads<=3,'denial never causes an automatic retry loop');assert.equal(await page.$eval('html',node=>node.dataset.namedTheme),'neutral');
  }finally{await context.close();}
});
