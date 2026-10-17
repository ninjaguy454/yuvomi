import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';

const folder=mkdtempSync(join(tmpdir(),'vidamia-weather-scene-app-'));
Object.assign(process.env,{DB_PATH:join(folder,'synthetic.db'),SESSION_SECRET:'synthetic-scene-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js'),{defaultNamedAppearance}=await import('../public/utils/named-appearance.js');
const {saveWallConfig,WALL_DEFAULTS}=await import('../server/services/wall.js');
const {createDevice,normalizeDevicePreferences,deviceHash}=await import('../server/services/devices.js');
const db=get(),password='SyntheticSceneOnly!',selected={...defaultNamedAppearance(),theme:'local-weather'};
db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'scenereview','Synthetic parent',?,'admin','parent',1)").run(await hashPassword(password,4));
for(const [key,value] of Object.entries({weather_provider:'open-meteo',weather_lat:'40',weather_lon:'-75',weather_city:'Synthetic household','weather_lat:user:1':'1','weather_lon:user:1':'2','weather_city:user:1':'PRIVATE TEST LOCATION','named_appearance:user:1':JSON.stringify(selected)}))db.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run(key,value);
for(let i=0;i<6;i++){
  const task=Number(db.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,points,card_color,card_color_choice) VALUES(?,1,1,'all',5,'slot-03-v1',?)").run('Synthetic scene task '+i,JSON.stringify({version:1,mode:'fixed',slot:'slot-03-v1'})).lastInsertRowid);
  db.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,1)').run(task);
}
db.prepare("INSERT INTO notes(title,content,created_by,pinned,color,card_color_slot) VALUES('Synthetic scene note','Readable household note',1,1,'#e3d69e','slot-04-v1')").run();
const calendarNow=new Date(),calendarDay=[calendarNow.getFullYear(),String(calendarNow.getMonth()+1).padStart(2,'0'),String(calendarNow.getDate()).padStart(2,'0')].join('-');
const calendarEventId=Number(db.prepare("INSERT INTO calendar_events(title,start_datetime,end_datetime,all_day,created_by) VALUES('Synthetic scene calendar event',?,?,1,1)").run(calendarDay+'T00:00',calendarDay+'T23:59').lastInsertRowid);
saveWallConfig(db,{...structuredClone(WALL_DEFAULTS),widgets:WALL_DEFAULTS.widgets.map(widget=>({...widget,visible:['tasks','notes'].includes(widget.id)})),appearance:{...WALL_DEFAULTS.appearance,named_appearance:selected}});
const snapshot=()=>db.prepare('SELECT id,card_color,card_color_choice FROM tasks ORDER BY id').all();
let server,browser,origin;const errors=[],requests=[];
const report={prototypeOnly:false,syntheticData:true,checks:[],captures:[],errors,limitations:['Headless desktop Chrome is not physical Wall/GPU/speaker validation.']};
function check(label,value){assert.ok(value,label);report.checks.push(label);}
test.before(async()=>{
  server=fork(new URL('./helpers/local-weather-scene-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-5000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),30000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+log));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--mute-audio']});report.browserPid=browser.process()?.pid;report.serverPid=server.pid;
});
test.after(async()=>{
  await browser?.close();report.browserClosed=true;
  if(server?.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}report.serverClosed=true;db.close();
  if(process.env.LOCAL_WEATHER_REVIEW_DIR){mkdirSync(process.env.LOCAL_WEATHER_REVIEW_DIR,{recursive:true});writeFileSync(join(process.env.LOCAL_WEATHER_REVIEW_DIR,'integration-full-app-verification.json'),JSON.stringify(report,null,2)+'\n');}
});
async function capture(page,name){if(process.env.LOCAL_WEATHER_REVIEW_DIR){mkdirSync(process.env.LOCAL_WEATHER_REVIEW_DIR,{recursive:true});const file=join(process.env.LOCAL_WEATHER_REVIEW_DIR,name+'.png');await page.screenshot({path:file});report.captures.push(name+'.png');}}
async function login(page){await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');});await page.goto(origin+'/login');await page.waitForSelector('#username');await page.type('#username','scenereview');await page.type('#password',password);await page.click('[type=submit]');await page.waitForSelector('.dashboard');}
function track(page){page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/v1/weather'))requests.push(url.pathname);});page.setDefaultTimeout(15000);}

test('real personal app receives whitelisted household facts and mounts approved art without changing task choices',async()=>{
  const context=await browser.createBrowserContext(),page=await context.newPage();track(page);await page.setViewport({width:1920,height:1080});const before=snapshot();
  try{
    await login(page);await page.goto(origin+'/tasks?view=list');await page.waitForSelector('.activity-card');await page.waitForFunction(()=>!!document.querySelector('.local-weather-scene'));
    await page.waitForFunction(()=>[...document.querySelectorAll('.local-weather-art')].every(image=>image.complete&&image.naturalWidth));
    check('real app shell cannot obscure the selected painting',await page.evaluate(()=>{const shell=getComputedStyle(document.querySelector('.app-shell')),content=getComputedStyle(document.querySelector('.app-content'));return shell.backgroundColor==='rgba(0, 0, 0, 0)'&&shell.backgroundImage==='none'&&content.backgroundColor==='rgba(0, 0, 0, 0)'&&content.backgroundImage==='none';}));
    const envelope=await page.evaluate(async()=>{const {api}=await import('/api.js');return(await api.get('/weather/scene?city=PRIVATE&lat=1&lon=2')).data;});
    check('real route returns scene66 with converted household wind',envelope.scene?.condition_code===66&&envelope.scene.wind.speed_mps===4&&envelope.scene.wind.gust_mps===8);
    check('scene route exposes only theme and scene, with no private location',Object.keys(envelope).sort().join(',')==='scene,theme'&&!JSON.stringify(envelope).includes('PRIVATE'));
    const legacy=await page.evaluate(async()=>{const {api}=await import('/api.js');return(await api.get('/weather/theme')).data;});
    check('existing seven-field theme route remains unchanged',Object.keys(legacy).sort().join(',')==='condition,expires_at,fetched_at,is_day,observed_at,sunrise_at,sunset_at');
    check('appearance uses scene route',requests.includes('/api/v1/weather/scene'));
    check('readable artwork credit is present',await page.$eval('.local-weather-credit',node=>node.textContent.includes('Thomas Cole')));
    check('artwork credit uses flow placement instead of covering task controls',await page.$eval('.local-weather-credit',node=>getComputedStyle(node).position==='static'));
    for(const viewport of [{width:1920,height:1080},{width:3440,height:1440},{width:2048,height:667},{width:390,height:844},{width:320,height:720}]){
      await page.setViewport({...viewport,deviceScaleFactor:1});await new Promise(resolve=>setTimeout(resolve,100));
      check(viewport.width+'px has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      if(viewport.width>700)check(viewport.width+'px keeps the approved full-width bounded camera',await page.$eval('.local-weather-scene',node=>{const rect=node.getBoundingClientRect();return rect.width/rect.height<=2.11&&getComputedStyle(node.querySelector('.local-weather-art')).objectFit==='cover';}));
      check(viewport.width+'px card controls stay untransformed',await page.$$eval('.activity-card',nodes=>nodes.every(node=>getComputedStyle(node).transform==='none')));
      await capture(page,'integration-app-'+viewport.width);
      if(viewport.width===2048){
        await page.evaluate(()=>{const host=document.querySelector('.app-content');host.scrollTop=document.querySelector('.local-weather-scene').getBoundingClientRect().height-innerHeight;});
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('.local-weather-scene')).transform!=='none');
        check('wide app scrolling reveals lower artwork',await page.$eval('.local-weather-scene',node=>node.getBoundingClientRect().top<0));
        await capture(page,'integration-app-2048-scrolled');await page.evaluate(()=>{document.querySelector('.app-content').scrollTop=0;});
      }
    }
    check('weather never changes stored task color choices',JSON.stringify(snapshot())===JSON.stringify(before));
    await page.goto(origin+'/calendar');await page.waitForSelector('.local-weather-scene');
    const eventSelector=`:is(.month-day__event,.agenda-event,.week-event,.day-event,.allday-event)[data-id="${calendarEventId}"]`;
    await page.waitForSelector(eventSelector);await page.$eval(eventSelector,node=>node.scrollIntoView({block:'center'}));
    await page.waitForFunction(selector=>{const node=document.querySelector(selector);if(!node)return false;const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(hit===node||node.contains(hit));},{},eventSelector);
    check('settled Calendar event keeps its clickable hit target',await page.$eval(eventSelector,node=>node.textContent.includes('Synthetic scene calendar event')));await capture(page,'integration-calendar');
    await page.click(eventSelector);await page.waitForSelector('.modal-panel');check('real Calendar event opens through the Weather overlay',await page.$eval('.modal-panel',node=>node.textContent.includes('Synthetic scene calendar event')));await page.keyboard.press('Escape');
    await page.goto(origin+'/notes');await page.waitForSelector('.note-card');await page.waitForSelector('.local-weather-scene');await capture(page,'integration-notes');
    await page.evaluate(async()=>{const runtime=await import('/utils/named-appearance-runtime.js');const {defaultNamedAppearance}=await import('/utils/named-appearance.js');runtime.applyNamedAppearance({...defaultNamedAppearance(),theme:'coffee'},{persist:false});});
    check('theme exit removes scene and all card rim decorations',await page.evaluate(()=>!document.querySelector('.local-weather-scene,.local-weather-card-rim')));
    check('real app has no runtime errors',errors.length===0);
  }finally{await context.close();}
});

test('real weather Kanban keeps translucent groups and readable phone and wall-tablet controls',async()=>{
  const context=await browser.createBrowserContext(),page=await context.newPage();track(page);
  try{
    await page.setViewport({width:390,height:844,hasTouch:true});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await login(page);
    for(const [width,height]of [[390,844],[1280,800]]){
      await page.setViewport({width,height,hasTouch:true});await page.goto(origin+'/tasks?view=kanban');await page.waitForSelector('.task-board__bucket .activity-card');await page.waitForSelector('.local-weather-card-rim[data-active=true]');
      await page.waitForFunction(()=>[...document.querySelectorAll('.local-weather-art')].every(image=>image.complete&&image.naturalWidth));
      const geometry=await page.evaluate(()=>{const sample=value=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=value;c.fillRect(0,0,1,1);return c.getImageData(0,0,1,1).data[3]/255;};return{alpha:sample(getComputedStyle(document.querySelector('.task-board__bucket')).backgroundColor),sway:[...document.querySelectorAll('.activity-card')].some(node=>getComputedStyle(node).transform!=='none'),overflow:document.documentElement.scrollWidth>innerWidth+1};});
      await capture(page,'weather-visibility-real-kanban-'+width);
      assert.ok(geometry.alpha<=.65,'real Kanban column reveals the landscape');assert.equal(geometry.sway,false);assert.equal(geometry.overflow,false);
      await page.tap('.activity-card__open');await page.waitForSelector('.modal-panel');assert.ok(await page.$eval('.modal-panel',node=>node.textContent.includes('Synthetic scene task')),'real Task detail remains touch accessible');await page.keyboard.press('Escape');
    }
  }finally{await context.close();}
});

test('real Wall scene retains house permissions and device denial remains neutral',async()=>{
  const personal=await browser.createBrowserContext(),page=await personal.newPage();track(page);await page.setViewport({width:1920,height:1080});
  try{
    await login(page);await page.evaluate(async()=>{await(await import('/api.js')).api.post('/wall/enter',{});(await import('/utils/wall-mode.js')).setWallModeEnabled(true);});await page.goto(origin+'/');await page.waitForSelector('[data-wall-grid]');await page.waitForSelector('.local-weather-scene');
    const envelope=await page.evaluate(async()=>{return(await(await import('/api.js')).api.get('/wall/weather/scene')).data;});
    check('real Wall receives permitted household scene',envelope.scene?.condition_code===66);
    check('Wall status labels retain opaque surfaces and readable contrast',await page.$$eval('.wall-dashboard__connection,.wall-dashboard__footer',nodes=>{
      const rgb=value=>(value.match(/[\d.]+/g)||[]).map(Number),light=channels=>channels.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      return nodes.length===2&&nodes.every(node=>{const css=getComputedStyle(node),background=rgb(css.backgroundColor);if(background.length===4&&background[3]!==1)return false;const a=light(rgb(css.color)),b=light(background);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;});
    }));await capture(page,'integration-wall');await page.setViewport({width:1280,height:800,hasTouch:true});await page.waitForSelector('.wall-dashboard__connection',{visible:true});await page.waitForSelector('.local-weather-scene');await page.waitForFunction(()=>[...document.querySelectorAll('.local-weather-art')].every(image=>image.complete&&image.naturalWidth));await capture(page,'weather-visibility-real-wall-tablet');
  }finally{await personal.close();}
  const preferences=normalizeDevicePreferences(db,{});preferences.allow_theme_changes=true;preferences.appearance.named_appearance=selected;
  const device=createDevice(db,{name:'Synthetic weather-denied scene display',preferences},1),token='synthetic-scene-device-'+device.id;
  db.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),'synthetic-scene-context-'+device.id);
  const before=db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json;
  const context=await browser.createBrowserContext(),paired=await context.newPage();track(paired);
  try{
    await paired.evaluateOnNewDocument(()=>{localStorage.setItem('vidamia-paired-device','1');localStorage.setItem('yuvomi-lang','en');});await paired.setCookie({name:'vidamia.device',value:token,url:origin,httpOnly:true});await paired.goto(origin+'/device');await paired.waitForSelector('[data-device-theme]');await paired.waitForFunction(()=>document.documentElement.dataset.namedTheme==='neutral');
    check('weather-denied paired display mounts no scene',await paired.$('.local-weather-scene')===null);
    check('appearance never expands device grants',db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json===before);
    check('Wall/device paths have no runtime errors',errors.length===0);
  }finally{await context.close();}
});

test('real settings use trusted consent and native Web Audio while owner ending cancels delayed rumble',async()=>{
  const context=await browser.createBrowserContext(),page=await context.newPage();track(page);const focus=await page.createCDPSession();await focus.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.evaluateOnNewDocument(()=>{window.weatherAudioStarts=0;const start=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...args){window.weatherAudioStarts++;return start.apply(this,args);};});
  try{
    await login(page);await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('[data-weather-thunder]');
    check('thunder has no automatic Web Audio start',await page.evaluate(()=>window.weatherAudioStarts===0));
    check('thunder begins with session consent off',await page.$eval('[data-weather-thunder]',node=>!node.checked));
    await page.click('[data-weather-thunder]');
    check('consent alone respects canonical mute',await page.evaluate(async()=>!(await import('/utils/ui-sounds.js')).queueWeatherThunder({id:'muted',delayMs:0})));
    await page.focus('[data-sound-mode]');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-sound-mode]').value==='theme'&&!document.querySelector('[data-sound-mode]').disabled);
    await page.focus('[data-sound-mode]');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(async()=>{const sound=await import('/utils/ui-sounds.js');return sound.currentUiSounds().mode==='pack'&&!document.querySelector('[data-sound-mode]').disabled;});
    check('trusted consent-before-mode activates a bounded native rumble',await page.evaluate(async()=>{return(await import('/utils/ui-sounds.js')).queueWeatherThunder({id:'native-consented',delayMs:0,isCurrent:()=>true});}));
    await page.waitForFunction(()=>window.weatherAudioStarts===1);
    await page.evaluate(async()=>{const sound=await import('/utils/ui-sounds.js');sound.queueWeatherThunder({id:'ending-owner',delayMs:150});window.dispatchEvent(new Event('auth:context-ending'));});
    await new Promise(resolve=>setTimeout(resolve,250));
    check('ending owner resets consent and prevents delayed native playback',await page.evaluate(async()=>{const sound=await import('/utils/ui-sounds.js');return window.weatherAudioStarts===1&&!sound.weatherThunderEnabled();}));
    check('ending owner clears art and all card rims',await page.evaluate(()=>!document.querySelector('.local-weather-scene,.local-weather-card-rim')));
    check('native Web Audio path has no runtime errors',errors.length===0);
  }finally{await focus.detach();await context.close();}
});

// Run separately by name: no screenshots/recordings or parallel browser suites.
test('performance probe measures cold and warm bounded weather in the real task app',{skip:process.env.LOCAL_WEATHER_PERFORMANCE!=='1'},async()=>{
  const context=await browser.createBrowserContext(),page=await context.newPage();track(page);const cdp=await page.createCDPSession();
  const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return{count:sorted.length,p95:sorted[Math.floor(sorted.length*.95)]||0,max:sorted.at(-1)||0,totalMs:sorted.reduce((a,b)=>a+b,0)};};
  const performanceReport={syntheticRealApp:true,viewport:{width:1920,height:1080,dpr:1},cpuThrottle:4,recording:false,screenshots:false,cases:[],errors,limitations:['Warm desktop Chrome traces do not validate physical Wall GPU/displayed frames/battery/thermal or compositor memory.','The controlled renderer uses actual task app/card DOM and validated synthetic facts; route/authorization behavior is verified separately.','Each case uses a fresh renderer,3s warmup then3s passive trace. Cold costs are recorded separately.']};
  try{
    await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});await login(page);await page.goto(origin+'/tasks?view=list');await page.waitForSelector('.activity-card');
    await page.evaluate(async()=>{const runtime=await import('/utils/named-appearance-runtime.js'),{defaultNamedAppearance}=await import('/utils/named-appearance.js');runtime.applyNamedAppearance({...defaultNamedAppearance(),theme:'neutral'},{persist:false});window.weatherProbe={ticks:[],long:[]};const raf=requestAnimationFrame.bind(window);window.requestAnimationFrame=fn=>raf(t=>{const start=performance.now();try{return fn(t);}finally{if(fn.name==='tick')window.weatherProbe.ticks.push(performance.now()-start);}});new PerformanceObserver(list=>window.weatherProbe.long.push(...list.getEntries().map(entry=>entry.duration))).observe({type:'longtask',buffered:false});});
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    for(const setting of [{name:'Clear idle',code:0,phenomena:['clear'],kind:'none'},{name:'Overcast',code:3,phenomena:['overcast'],kind:'none'},{name:'Rain/shared wind',code:63,phenomena:['rain'],kind:'rain'},{name:'Heavy snow',code:75,phenomena:['snow'],kind:'snow',heavy:true},{name:'Freezing rain',code:66,phenomena:['rain','freezing-liquid'],kind:'rain'},{name:'Thunder/hail/night',code:99,phenomena:['thunder','hail','rain'],kind:'rain',night:true,heavy:true},{name:'Snow grains',code:77,phenomena:['snow-grains'],kind:'snow-grains'},{name:'Owner-safe static fallback',code:null,phenomena:[],kind:'unknown'}]){
      const cold=await page.evaluate(async setting=>{
        window.sceneProbe?.dispose();weatherProbe.ticks=[];weatherProbe.long=[];
        const {mountLocalWeatherScene}=await import('/utils/local-weather-scene.js'),{normalizeWeatherScene}=await import('/utils/weather-scene-facts.js');
        const now=Date.now(),at=new Date(now).toISOString(),theme={condition:setting.kind==='snow'||setting.kind==='snow-grains'?'snow':setting.code===99?'storm':setting.kind==='rain'?'rain':setting.code===3?'cloudy':'sunny',is_day:!setting.night,observed_at:at,fetched_at:at,expires_at:new Date(now+90*60000).toISOString(),sunrise_at:null,sunset_at:null};
        const scene=setting.code===null?null:normalizeWeatherScene({version:1,provider:'open-meteo',observed_at:at,fetched_at:at,expires_at:theme.expires_at,condition_code:setting.code,phenomena:setting.phenomena,precipitation:{kind:setting.kind,intensity:setting.heavy?'heavy':'moderate',liquid_mm:null,snow_cm:null,snow_water_mm:null,interval_seconds:900,classification:'reported'},wind:{speed_mps:8,gust_mps:14,from_degrees:270},cloud_cover:setting.code===0?0:1,visibility_m:null,solar:{is_day:theme.is_day,sunrise_at:null,sunset_at:null}},theme,new Date(now));
        if(setting.code!==null&&!scene)throw Error('Invalid performance fixture');
        const begin=performance.now();window.sceneProbe=mountLocalWeatherScene();window.sceneProbe.update({theme,scene});return{mountAndFirstUpdateMs:performance.now()-begin};
      },setting);
      await page.waitForFunction(()=>[...document.querySelectorAll('.local-weather-art')].every(image=>image.complete&&image.naturalWidth));await new Promise(resolve=>setTimeout(resolve,3000));
      const before=await page.evaluate(()=>({stats:sceneProbe.getStats(),long:weatherProbe.long}));
      await page.tracing.start({categories:['devtools.timeline','disabled-by-default-devtools.timeline'],screenshots:false});await page.evaluate(()=>{weatherProbe.ticks=[];weatherProbe.long=[];});const begin=Date.now();await new Promise(resolve=>setTimeout(resolve,3000));
      const after=await page.evaluate(()=>({stats:sceneProbe.getStats(),ticks:weatherProbe.ticks,long:weatherProbe.long})),elapsed=Date.now()-begin,trace=JSON.parse(Buffer.from(await page.tracing.stop()).toString()),render={};
      for(const event of trace.traceEvents)if(event.ph==='X'&&['Paint','PrePaint','RasterTask','Layerize','UpdateLayerTree','CompositeLayers'].includes(event.name))(render[event.name]??=[]).push((event.dur||0)/1000);
      const row={name:setting.name,elapsedMs:elapsed,fps:(after.stats.frames-before.stats.frames)/elapsed*1000,cold:{...cold,frostBuildMs:before.stats.frostBuildMs||0,longTasks:summary(before.long)},tickMs:summary(after.ticks),warmLongTasks:summary(after.long),renderCosts:Object.fromEntries(Object.entries(render).map(([name,values])=>[name,summary(values)])),limits:{particles:after.stats.particles,activeMaterialFaces:after.stats.activeMaterialFaces,activeWaterBeads:after.stats.activeWaterBeads,activeSnowPatches:after.stats.activeSnowPatches,activeSnowFragments:after.stats.activeSnowFragments,trackedFaces:after.stats.materialFaces,canvas:after.stats.canvas}};
      assert.ok(row.limits.particles<=160&&row.limits.activeMaterialFaces<=6&&row.limits.activeWaterBeads<=24&&row.limits.activeSnowPatches<=6&&row.limits.activeSnowFragments<=12&&row.limits.canvas.width<=1280&&row.limits.canvas.height<=800);
      if(setting.code===0||setting.code===null)assert.equal(row.fps,0);performanceReport.cases.push(row);console.log('WEATHER_APP_PERF '+JSON.stringify({name:row.name,fps:row.fps,p95:row.tickMs.p95,warmLongTasks:row.warmLongTasks.count,coldMs:row.cold.mountAndFirstUpdateMs}));
    }
    await page.evaluate(()=>window.sceneProbe.dispose());assert.deepEqual(errors,[]);
  }finally{
    await cdp.detach();await context.close();
    if(process.env.LOCAL_WEATHER_REVIEW_DIR)writeFileSync(join(process.env.LOCAL_WEATHER_REVIEW_DIR,'integration-app-performance.json'),JSON.stringify(performanceReport,null,2)+'\n');
  }
});
