/** Real app shell/auth/API; synthetic file DB and loopback provider only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-personal-appearance-shortcut-'));
process.env.DB_PATH=join(folder,'synthetic.db');
Object.assign(process.env,{SESSION_SECRET:'synthetic-phone-shortcut-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js');
const {hashPassword}=await import('../server/utils/password.js');
const {createDevice,normalizeDevicePreferences,deviceHash}=await import('../server/services/devices.js');
const {defaultNamedAppearance}=await import('../public/utils/named-appearance.js');
const d=get(),password='SyntheticAppearanceShortcutOnly!',output=process.env.PHONE_APPEARANCE_EVIDENCE||join(folder,'evidence');
mkdirSync(output,{recursive:true});
for(const [id,name,role]of [[1,'shortcutadmin','admin'],[2,'shortcutmember','member'],[3,'shortcutdenied','member']]){
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,1)').run(id,name,'Synthetic '+role,await hashPassword(password,4),role,'other');
  d.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run('named_appearance:user:'+id,JSON.stringify({...defaultNamedAppearance(),theme:'coffee'}));
}
d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','3','settings.personal','none')").run();
function display(allow){
  const preferences=normalizeDevicePreferences(d,{});preferences.allow_theme_changes=allow;preferences.appearance.named_appearance={...defaultNamedAppearance(),theme:'fern'};
  const device=createDevice(d,{name:'Synthetic '+(allow?'editable':'locked')+' display',preferences},1),token='synthetic-shortcut-token-'+device.id;
  d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),'synthetic-shortcut-context-'+device.id);
  return{device,token};
}
const editable=display(true),locked=display(false),evidence={scope:'Synthetic real full shell at 390x844 and 1280x900',cases:[],errors:[]};
let server,browser,origin,serverLog='';
const hash=value=>createHash('sha256').update(value).digest('hex');
const stored=id=>JSON.parse(d.prepare('SELECT preferences_json FROM household_devices WHERE id=?').get(id).preferences_json);
const snapshot=()=>JSON.stringify({personal:d.prepare("SELECT key,value FROM sync_config WHERE key LIKE 'named_appearance:user:%' ORDER BY key").all(),devices:d.prepare('SELECT id,revision,permissions_json,scope_json,preferences_json FROM household_devices ORDER BY id').all(),grants:d.prepare('SELECT * FROM access_capabilities ORDER BY subject_type,subject_id,capability_key').all(),permissions:d.prepare('SELECT * FROM access_permissions ORDER BY subject_type,subject_id,resource_type,resource_key').all()});
test.before(async()=>{
  server=fork(new URL('./helpers/local-weather-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  for(const stream of[server.stdout,server.stderr])stream.on('data',data=>serverLog=(serverLog+data).slice(-5000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(serverLog)),30000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Owned fixture exited '+code+serverLog));});});
  browser=await puppeteer.launch({headless:true,pipe:false,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined),args:['--disable-background-networking','--disable-component-update']});
});
test.after(async()=>{
  writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2)+'\n');
  await browser?.close();if(server?.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}d.close();assert.deepEqual(evidence.errors,[],'full shell has no page errors');
});
async function client(width=390,paired=null){
  const context=await browser.createBrowserContext(),page=await context.newPage(),writes=[];page.setDefaultTimeout(15000);
  await page.setViewport({width,height:width<640?844:900,isMobile:width<640,hasTouch:width<640,deviceScaleFactor:1});
  if(width<640)await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36');
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(paired=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');if(paired)localStorage.setItem('vidamia-paired-device','1');},!!paired);
  page.on('pageerror',error=>evidence.errors.push(error.message));
  page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(['POST','PUT','PATCH','DELETE'].includes(request.method())&&/^\/api\/v1\/(preferences(?:\/|$)|devices(?:\/|$)|device\/appearance(?:\/|$))/.test(pathname))writes.push({method:request.method(),path:pathname});});
  if(paired)await page.setCookie({name:'vidamia.device',value:paired.token,url:origin,httpOnly:true});
  return{context,page,writes};
}
async function submitLogin(page,name){await page.waitForSelector('#username');await page.type('#username',name);await page.type('#password',password);const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/auth/login'&&response.request().method()==='POST');await page.click('[type=submit]');return response;}
async function login(page,name){assert.equal((await submitLogin(page,name)).status(),200,'synthetic login succeeds');await page.waitForSelector('.dashboard');}
async function openMore(page){await page.click('#more-btn');await page.waitForSelector('.more-sheet__system');}
async function geometry(page,selector){
  const box=await page.$eval(selector,node=>{const r=node.getBoundingClientRect();return{width:r.width,height:r.height,label:node.textContent.trim()};});
  assert.ok(box.width>=44&&box.height>=44,JSON.stringify(box));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);return box;
}
async function usePersonalShortcut(f,width,label){
  const before=snapshot(),selector=width<640?'.more-sheet__system [data-personal-appearance]':'.nav-sidebar__footer-actions [data-personal-appearance]';
  if(width<640)await openMore(f.page);
  await f.page.screenshot({path:join(output,label+'-footer.png')});
  assert.equal((await f.page.$$(selector)).length,1,'signed-in utility footer exposes personal Appearance');
  assert.equal(await f.page.$('[data-device-theme]'),null,'personal action is not controlled by the paired-device theme binder');
  const box=await geometry(f.page,selector);
  await f.page.focus(selector);await f.page.keyboard.press('Enter');
  await f.page.waitForSelector('[data-personal-named-appearance] .named-theme-tile');
  assert.equal(new URL(f.page.url()).pathname,'/settings/personal/appearance');
  assert.equal(await f.page.$('[data-shared-device-theme]'),null);
  assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.equal(snapshot(),before,'opening/navigating never changes preferences, devices or grants');assert.deepEqual(f.writes,[]);
  await f.page.screenshot({path:join(output,label+'-personal-page.png')});
  evidence.cases.push({label,route:'/settings/personal/appearance',keyboard_enter:true,box,preference_and_grant_snapshot:hash(before),automatic_writes:0});
}
for(const [name,user]of [['ordinary member','shortcutmember'],['administrator','shortcutadmin']])for(const width of[390,1280])test(`${name} ${width===390?'phone':'desktop'} opens personal Appearance from its utility footer without writes`,async()=>{
  const f=await client(width);try{await f.page.goto(origin+'/login');await login(f.page,user);await usePersonalShortcut(f,width,name.replaceAll(' ','-')+'-'+width);
    if(width===1280){await f.page.focus('.nav-sidebar__footer-actions [data-personal-appearance]');await f.page.evaluate(()=>{window.yuvomi.setModuleOrder([]);window.yuvomi.setModuleOrder([]);});assert.equal((await f.page.$$('.nav-sidebar__footer-actions [data-personal-appearance]')).length,1);assert.equal(await f.page.evaluate(()=>document.activeElement?.hasAttribute('data-personal-appearance')),true);}
  }finally{await f.context.close();}
});
test('temporary signed-in administrator uses personal Appearance despite the paired display theme lock and returns safely',async()=>{
  const f=await client(390,locked);try{
    await f.page.goto(origin+'/device');await f.page.waitForSelector('[data-device-theme]');await openMore(f.page);await f.page.click('.more-sheet [data-device-login]');await login(f.page,'shortcutadmin');
    assert.equal(await f.page.evaluate(async()=>!!(await import('/utils/device-context.js')).deviceBootstrap()?.temporary),true);
    await usePersonalShortcut(f,390,'temporary-administrator');
    await openMore(f.page);await f.page.click('.more-sheet [data-device-return]');await f.page.waitForSelector('[data-device-theme]');
    assert.equal(await f.page.$eval('[data-device-theme]',node=>node.disabled),true);assert.equal(await f.page.$('[data-personal-appearance]'),null);assert.deepEqual(f.writes,[]);
  }finally{await f.context.close();}
});
test('paired display still rejects temporary member login under the existing administrator-only policy',async()=>{
  const f=await client(390,locked);try{
    await f.page.goto(origin+'/device');await f.page.waitForSelector('[data-device-theme]');await openMore(f.page);await f.page.click('.more-sheet [data-device-login]');const before=snapshot();
    const response=await submitLogin(f.page,'shortcutmember');assert.equal(response.status(),403);assert.match((await response.json()).error,/requires a household administrator/);
    assert.equal(snapshot(),before);assert.deepEqual(f.writes,[]);evidence.cases.push({label:'temporary-member-denied',server_status:403,existing_administrator_only_policy:true,preferences_and_grants_unchanged:true});
  }finally{await f.context.close();}
});
for(const [label,paired]of [['locked',locked],['editable',editable]])test(`paired ${label} phone retains its device Appearance control and Confirm policy`,async()=>{
  const f=await client(390,paired);try{
    await f.page.goto(origin+'/device');await f.page.waitForSelector('[data-device-theme]');const before=snapshot();await openMore(f.page);
    const selector='.more-sheet__system [data-device-theme]';assert.equal((await f.page.$$(selector)).length,1);assert.equal(await f.page.$('[data-personal-appearance]'),null);await geometry(f.page,selector);
    assert.equal(await f.page.$eval(selector,node=>node.disabled),label==='locked');
    await f.page.screenshot({path:join(output,'paired-'+label+'-footer.png')});
    if(label==='editable'){
      await f.page.click(selector);await f.page.waitForSelector('[data-shared-theme-confirm]');
      assert.equal(await f.page.$eval('[data-shared-theme-confirm]',node=>!!node.closest('.modal-panel__footer')),true);
      await f.page.select('[data-shared-device-theme] [data-named-field=theme]','cozy-cafe');
      assert.equal(snapshot(),before,'preview does not save');assert.deepEqual(f.writes,[]);
      await f.page.click('[data-shared-theme-confirm]');await f.page.waitForFunction(()=>!document.querySelector('[data-shared-device-theme]'));
      assert.equal(stored(paired.device.id).appearance.named_appearance.theme,'cozy-cafe');assert.deepEqual(f.writes,[{method:'PATCH',path:'/api/v1/device/appearance'}]);
    }else{await f.page.click(selector);assert.equal(await f.page.$('[data-shared-device-theme]'),null);assert.equal(snapshot(),before);assert.deepEqual(f.writes,[]);}
    evidence.cases.push({label:'paired-'+label,device_control:true,personal_control:false,confirm_preserved:label==='editable',automatic_writes:0});
  }finally{await f.context.close();}
});
test('member denied existing personal settings gets no shortcut and retains the server permission gate',async()=>{
  const f=await client();try{
    await f.page.goto(origin+'/login');await login(f.page,'shortcutdenied');await openMore(f.page);assert.equal(await f.page.$('[data-personal-appearance]'),null);assert.equal(await f.page.$('[data-device-theme]'),null);const before=snapshot();
    const status=await f.page.evaluate(async()=>{try{await(await import('/api.js')).api.put('/preferences',{heading_font:'serif'});return 200;}catch(error){return error.status;}});
    assert.equal(status,403);assert.equal(snapshot(),before);evidence.cases.push({label:'denied-personal-settings',shortcut:false,server_status:status,preferences_and_grants_unchanged:true});
  }finally{await f.context.close();}
});
