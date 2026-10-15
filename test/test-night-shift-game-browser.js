import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-night-game-'));
process.env.DB_PATH=join(folder,'synthetic.db');
Object.assign(process.env,{SESSION_SECRET:'synthetic-night-game-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js'),{defaultNamedAppearance}=await import('../public/utils/named-appearance.js'),{createDevice,normalizeDevicePreferences,deviceHash}=await import('../server/services/devices.js');
const db=get(),password='SyntheticNightGameOnly!';
db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'nightgame','Night review (synthetic)',?,'admin','parent',1)").run(await hashPassword(password,4));
db.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run('named_appearance:user:1',JSON.stringify({...defaultNamedAppearance(),theme:'night-shift'}));
db.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run('ui_sounds:user:1',JSON.stringify({version:1,mode:'off',pack:'wood',volume:15}));
db.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,points) VALUES('Synthetic conservation task',1,1,'all',7)").run();
const prefs=normalizeDevicePreferences(db,{});prefs.allow_theme_changes=false;prefs.appearance.named_appearance={...defaultNamedAppearance(),theme:'night-shift'};
const shared=createDevice(db,{name:'Synthetic locked Night Shift display',preferences:prefs},1),token='synthetic-night-game-device-'+shared.id;
db.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(shared.id,deviceHash(token),'synthetic-night-game-context');
const snapshot=()=>({tasks:db.prepare('SELECT * FROM tasks ORDER BY id').all(),points:db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%point%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'"').all()]),settings:db.prepare('SELECT * FROM sync_config ORDER BY key').all(),devices:db.prepare('SELECT * FROM household_devices ORDER BY id').all(),users:db.prepare('SELECT id,role,family_role FROM users ORDER BY id').all()});
let server,browser,origin;const errors=[],external=[],mutations=[],checks=[],layouts=[];
test.before(async()=>{
  server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-3000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),20000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin)});server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+log))})});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--mute-audio','--disable-background-networking','--disable-component-update']});
});
test.after(async()=>{
  await browser?.close();if(server?.exitCode===null){server.kill();await new Promise(r=>server.once('exit',r))}db.close();
  if(process.env.NIGHT_GAME_REVIEW_DIR){mkdirSync(process.env.NIGHT_GAME_REVIEW_DIR,{recursive:true});writeFileSync(join(process.env.NIGHT_GAME_REVIEW_DIR,'browser-results.json'),JSON.stringify({checks,layouts,errors,external,mutations,closedOwnedBrowser:true,verifiedAt:new Date().toISOString()},null,2));}
  if(resolve(folder).toLowerCase().startsWith((resolve(tmpdir())+'\\vidamia-night-game-').toLowerCase()))rmSync(folder,{recursive:true,force:true});
});
async function pageFor(paired=false,options={}){
  const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(12000);
  await page.setViewport({width:1440,height:1000});page.on('pageerror',e=>errors.push(e.message));
  await page.setRequestInterception(true);page.on('request',req=>{if(options.holdStyle&&req.url()===origin+'/styles/night-shift-game.css')return;if(req.url().startsWith(origin)||req.url().startsWith('data:'))req.continue();else{external.push(req.url());req.abort()}});
  await page.evaluateOnNewDocument(paired=>{
    localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');if(paired)localStorage.setItem('vidamia-paired-device','1');
    window.__gameAudio={created:0,closed:0,starts:[],stops:0};const Native=window.AudioContext;
    window.AudioContext=class extends Native{constructor(...args){super(...args);window.__gameAudio.created++}close(){window.__gameAudio.closed++;return super.close()}};
    const start=AudioBufferSourceNode.prototype.start,stop=AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start=function(...args){window.__gameAudio.starts.push({duration:this.buffer?.duration,time:performance.now()});return start.apply(this,args)};
    AudioBufferSourceNode.prototype.stop=function(...args){window.__gameAudio.stops++;return stop.apply(this,args)};
  },paired);
  if(paired)await page.setCookie({name:'vidamia.device',value:token,url:origin,httpOnly:true});
  await page.goto(origin+(paired?'/device':'/login'));
  if(!paired){await page.waitForSelector('#username');await page.type('#username','nightgame');await page.type('#password',password);await page.click('[type=submit]');}
  await page.waitForSelector('.dashboard-overview');await page.waitForSelector('[data-night-shift-entry]');
  return{context,page};
}
const opened=async page=>{await page.click('[data-night-shift-entry]');await page.waitForSelector('[data-night-shift-console][open]');};
const closed=page=>page.waitForFunction(()=>!document.querySelector('[data-night-shift-console]'));
async function accelerate(page,{win=false,scare=null}={}){await page.evaluate(async({win,scare})=>{
  const {Game}=await import('/utils/night-shift-game.js');const original=Game.prototype.step;window.__nightOriginalStep=original;
  Game.prototype.step=function(dt){window.__gameModel=this;
    if(scare){const bot=this.state.bots.find(b=>b.id===scare);bot.position=bot.route.length-1;bot.room=bot.route.at(-1);bot.attackIn=.1;if(scare==='fox')bot.running=true;original.call(this,.2);return;}
    for(let i=0;i<Math.ceil(dt*100/.1);i++){if(win)for(const side of ['left','right'])this.setShutter(side,this.state.bots.some(b=>b.room===side+'-door'));original.call(this,.1);}
  };
}, {win,scare});}
async function capture(page,name){if(process.env.NIGHT_GAME_REVIEW_DIR)await page.screenshot({path:join(process.env.NIGHT_GAME_REVIEW_DIR,name+'.png')});}

test('real Dashboard mounts a deliberate sparse game, preserves data and cleans route/theme/history ownership',async()=>{
  const {context,page}=await pageFor();try{
    const before=snapshot();const writes=[];page.on('request',req=>{if(!['GET','HEAD'].includes(req.method()))writes.push(req.url())});
    assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').some(r=>r.name.includes('/components/night-shift-console.js'))),false,'console loads only on entry');
    await page.evaluate(()=>{const other=document.createElement('button');other.id='synthetic-other-camera';other.dataset.camera='west';document.body.append(other);});
    await accelerate(page,{win:true});await opened(page);assert.equal(await page.evaluate(()=>window.__gameAudio.created),0);
    for(const key of ['/','?','n','g','t'])await page.keyboard.press(key);
    assert.equal(await page.$eval('#search-overlay',n=>n.classList.contains('search-overlay--visible')),false,'game owns keys before the Dashboard search shortcut');
    assert.equal(await page.$$('.modal-overlay').then(n=>n.length),0,'Dashboard help and create shortcuts stay inactive');
    assert.equal(new URL(page.url()).pathname,'/','Dashboard navigation chords stay inactive');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[data-night-shift-console]')),true,'native focus traversal remains inside the dialog');
    assert.equal(await page.$eval('#ns-play',n=>n.hidden),true);assert.equal(await page.$eval('#ns-sound',n=>n.checked),false);
    await page.click('#ns-start');await page.waitForFunction(()=>!!window.__gameModel);const originalCamera=await page.evaluate(()=>window.__gameModel.state.camera);await page.evaluate(()=>document.getElementById('synthetic-other-camera').click());assert.equal(await page.evaluate(()=>window.__gameModel.state.camera),originalCamera,'game must not bind other page camera controls');await page.evaluate(()=>document.getElementById('synthetic-other-camera').remove());await page.click('[data-camera="store"]');await page.keyboard.press('a');await page.keyboard.press('d');await page.keyboard.press('p');
    assert.equal(await page.$eval('#ns-paused',n=>n.hidden),false);await page.click('#ns-resume');
    await page.keyboard.press('Escape');await closed(page);assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-night-shift-entry')),true);
    await page.keyboard.press('/');await page.waitForFunction(()=>document.getElementById('search-overlay').classList.contains('search-overlay--visible'));await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('search-overlay').classList.contains('search-overlay--visible'));
    await opened(page);await page.click('#ns-start');await page.evaluate(()=>history.back());await closed(page);assert.equal(new URL(page.url()).pathname,'/','Back closes the game first');
    await opened(page);await page.click('#ns-start');await page.evaluate(()=>window.yuvomi.navigate('/tasks'));await closed(page);await page.waitForSelector('.activity-card');assert.equal(await page.$$('[data-night-shift-entry]').then(n=>n.length),0);
    await page.evaluate(()=>window.yuvomi.navigate('/'));await page.waitForSelector('[data-night-shift-entry]');await opened(page);await page.click('#ns-start');
    await page.evaluate(()=>document.documentElement.dataset.namedTheme='coffee');await closed(page);await page.waitForFunction(()=>!document.querySelector('[data-night-shift-entry]'));
    assert.equal(await page.$$('[data-night-shift-style]').then(n=>n.length),0);
    assert.deepEqual(snapshot(),before);assert.deepEqual(writes,[]);mutations.push(...writes);checks.push('real personal Dashboard: lazy console, deliberate silent start, keyboard/map/pause, Escape/focus, Back, navigation, theme cleanup; task/points/settings/device snapshots unchanged');
  }finally{await context.close()}
});
test('real game renders four attributed popups with original scream and closes audio/timer on exit',async()=>{
  for(const [id,name,closeBy]of[['bunny','Bonnie'],['chicken','Chica'],['bear','Freddy'],['fox','Foxy'],['bear','Freddy','theme'],['fox','Foxy','navigation']]){
    const{context,page}=await pageFor();try{
      const before=snapshot();await accelerate(page,{scare:id});await opened(page);await page.click('#ns-sound');await page.click('#ns-start');await page.waitForFunction(()=>window.__gameModel?.state.phase==='lost');
      assert.equal(await page.$eval('#ns-result-title',n=>n.textContent),name);assert.equal(await page.$eval('#ns-attack-overlay',n=>n.hidden),false);
      const sound=await page.evaluate(()=>window.__gameAudio.starts.find(s=>s.duration>.9));assert.ok(sound);const shown=await page.$eval('#ns-attack-overlay',n=>Number(n.dataset.shownAt));assert.ok(Math.abs(sound.time-shown)<100);
      if(id==='bunny'){await page.evaluate(async()=>{(await import('/utils/night-shift-game.js')).Game.prototype.step=window.__nightOriginalStep});await page.click('#ns-restart');assert.equal(await page.evaluate(()=>window.__gameModel.state.phase),'playing');assert.ok(await page.evaluate(()=>window.__gameAudio.stops>0),'restart stops scream');}
      if(id==='chicken'){await page.click('#ns-sound');assert.ok(await page.evaluate(()=>window.__gameAudio.stops>0),'mute stops an active scream');}
      if(closeBy==='theme')await page.evaluate(()=>document.documentElement.dataset.namedTheme='coffee');else if(closeBy==='navigation')await page.evaluate(()=>window.yuvomi.navigate('/tasks'));else await page.click('#ns-exit');await closed(page);await page.waitForFunction(()=>window.__gameAudio.closed===window.__gameAudio.created);assert.ok(await page.evaluate(()=>window.__gameAudio.stops>0));await new Promise(r=>setTimeout(r,1250));assert.equal(await page.$$('[data-night-shift-console]').then(n=>n.length),0);assert.deepEqual(snapshot(),before);
    }finally{await context.close()}
  }checks.push('all four real-app attributed popups and synchronized original scream; exit closes AudioContext and cancels late popup');
});

test('a pending console cannot appear after route cancellation and auth-context teardown releases ownership',async()=>{
  const options={holdStyle:true},{context,page}=await pageFor(false,options);try{
    const before=snapshot(),requested=page.waitForRequest(req=>req.url()===origin+'/styles/night-shift-game.css');
    await page.click('[data-night-shift-entry]');const request=await requested;
    await page.evaluate(()=>window.yuvomi.navigate('/tasks'));await page.waitForSelector('.activity-card');
    await page.waitForFunction(()=>!document.querySelector('[data-night-shift-style]'));
    options.holdStyle=false;if(!request.isInterceptResolutionHandled())await request.continue().catch(()=>{});
    await page.evaluate(()=>window.yuvomi.navigate('/'));await page.waitForSelector('[data-night-shift-entry]');
    await opened(page);assert.equal(await page.$$('[data-night-shift-console]').then(n=>n.length),1);
    await page.click('#ns-sound');await page.click('#ns-start');
    await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));await closed(page);
    await page.waitForFunction(()=>window.__gameAudio.closed===window.__gameAudio.created);
    assert.equal(await page.$$('[data-night-shift-entry],[data-night-shift-style]').then(n=>n.length),0);
    assert.deepEqual(snapshot(),before);checks.push('delayed stylesheet canceled during route change cannot reopen late; subsequent open succeeds; auth-context teardown removes entry, stylesheet, console and audio');
  }finally{await context.close()}
});
test('real-app win/restart, gentle/reduced motion, phone controls and locked shared-device settings remain independent',async()=>{
  const{context,page}=await pageFor(true);try{
    const before=snapshot();assert.equal(await page.$eval('[data-device-theme]',n=>n.disabled),true,'game never enables locked theme changes');
    await accelerate(page,{win:true});await opened(page);await page.click('#ns-start');await page.waitForFunction(()=>window.__gameModel?.state.phase==='won');assert.equal(await page.$eval('#ns-result-title',n=>n.textContent),'6 AM');await page.keyboard.press('Escape');await closed(page);
    await page.reload();await page.waitForSelector('[data-night-shift-entry]');await accelerate(page,{scare:'fox'});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await opened(page);await page.click('#ns-sound');await page.click('#ns-start');await page.waitForFunction(()=>window.__gameModel?.state.phase==='lost');assert.equal(await page.$eval('#ns-attack-overlay',n=>n.hidden),true);assert.equal(await page.evaluate(()=>window.__gameAudio.starts.some(s=>s.duration>.9)),false);await page.keyboard.press('Escape');await closed(page);
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);await page.reload();await page.waitForSelector('[data-night-shift-entry]');await accelerate(page,{scare:'bear'});await opened(page);await page.click('#ns-sound');await page.click('#ns-gentle');await page.click('#ns-start');await page.waitForFunction(()=>window.__gameModel?.state.phase==='lost');assert.equal(await page.$eval('#ns-attack-overlay',n=>n.hidden),true);assert.equal(await page.evaluate(()=>window.__gameAudio.starts.some(s=>s.duration>.9)),false);await page.click('#ns-gentle');assert.equal(await page.$eval('#ns-attack-overlay',n=>n.hidden),true,'changing Gentle after loss never triggers a retroactive scare');await page.keyboard.press('Escape');await closed(page);
    for(const[width,height]of[[1440,1000],[390,844],[320,700],[844,390]]){
      await page.setViewport({width,height,isMobile:width<900,hasTouch:width<900});await page.reload();await page.waitForSelector('[data-night-shift-entry]');await opened(page);await page.click('#ns-start');const camera=await page.$('[data-camera="east"]');if(width<900)await camera.tap();else await camera.click();
      const layout=await page.evaluate(()=>{const root=document.querySelector('[data-night-shift-console]'),header=root.querySelector('.console-header').getBoundingClientRect(),inside=selector=>{const r=root.querySelector(selector).getBoundingClientRect();return r.top>=header.bottom&&r.bottom<=innerHeight;};return{width:innerWidth,height:innerHeight,overflow:root.scrollWidth>root.clientWidth+1,tiny:[...root.querySelectorAll('button,input[type=range]')].filter(n=>n.getClientRects().length).filter(n=>{const r=n.getBoundingClientRect();return r.width<43.5||r.height<43.5}).length,camera:inside('.camera-frame'),shutters:inside('.shutters'),paragraphs:[...root.querySelectorAll('p')].filter(n=>{const r=n.getBoundingClientRect();return r.width>2&&r.height>2&&!n.classList.contains('eyebrow')}).length}});
      assert.equal(layout.overflow,false);assert.equal(layout.tiny,0);assert.equal(layout.camera,true);assert.equal(layout.shutters,true);assert.equal(layout.paragraphs,0);layouts.push(layout);await capture(page,'game-'+width);await page.keyboard.press('Escape');await closed(page);
    }
    assert.deepEqual(snapshot(),before);checks.push('real paired Dashboard: win, reduced-motion no scream, four layouts/touch, sparse UI and unchanged locked-device/theme/data settings');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await context.close()}
});
