import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-cozy-cafe-browser-'));
process.env.DB_PATH=join(folder,'synthetic.db');
Object.assign(process.env,{SESSION_SECRET:'synthetic-cozy-cafe-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error',AUTH_ALLOW_PASSWORD_LOGIN:'true'});delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js'),{saveWallConfig,WALL_DEFAULTS}=await import('../server/services/wall.js'),{CARD_SLOTS,defaultNamedAppearance}=await import('../public/utils/named-appearance.js');
const d=get(),password='SyntheticCafeOnly!';
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'cafereview','Synthetic parent',?,'admin','parent',1)").run(await hashPassword(password,4));
for(const [index,slot]of CARD_SLOTS.entries()){
  const task=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,points,card_color,card_color_choice) VALUES(?,1,1,'all',5,?,?)").run('Synthetic cafe task '+(index+1),slot,JSON.stringify({version:1,mode:'fixed',slot})).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,1)').run(task);
  d.prepare("INSERT INTO notes(title,content,created_by,pinned,color,card_color_slot) VALUES(?,?,1,1,'#e3d69e',?)").run('Synthetic cafe note '+(index+1),'A quiet household reminder.',slot);
}
saveWallConfig(d,{...structuredClone(WALL_DEFAULTS),widgets:WALL_DEFAULTS.widgets.map(widget=>({...widget,visible:['tasks','notes'].includes(widget.id)})),appearance:{...WALL_DEFAULTS.appearance,named_appearance:{...defaultNamedAppearance(),theme:'cozy-cafe'}}});
const snapshot=()=>({tasks:d.prepare('SELECT id,card_color,card_color_choice FROM tasks ORDER BY id').all(),notes:d.prepare('SELECT id,card_color_slot FROM notes ORDER BY id').all()});
let server,browser,origin;const errors=[];
test.before(async()=>{
  server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let log='';for(const stream of[server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-4000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),30000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code+log));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe':undefined)});
});
test.after(async()=>{await browser?.close();if(server?.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}d.close();});
const capture=async(page,name)=>{if(process.env.COZY_CAFE_REVIEW_DIR){mkdirSync(process.env.COZY_CAFE_REVIEW_DIR,{recursive:true});await page.screenshot({path:join(process.env.COZY_CAFE_REVIEW_DIR,name+'.png')});}};

test('Cozy Cafe persists through personal settings and renders real stable Task/Note slots on desktop, mobile and Wall',async()=>{
  const page=await browser.newPage(),before=snapshot();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1280,height:900});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');});
  try{
    await page.goto(origin+'/login');await page.waitForSelector('#username');await page.type('#username','cafereview');await page.type('#password',password);await page.click('[type=submit]');await page.waitForSelector('.dashboard');await page.goto(origin+'/settings/personal/appearance');await page.waitForSelector('[data-personal-named-appearance]');await page.select('[data-named-field=theme]','cozy-cafe');await page.waitForFunction(()=>!document.querySelector('.named-appearance-picker').hasAttribute('aria-busy'));assert.equal(await page.$eval('html',node=>node.dataset.namedTheme),'cozy-cafe');assert.equal(JSON.parse(d.prepare("SELECT value FROM sync_config WHERE key='named_appearance:user:1'").get().value).theme,'cozy-cafe');
    const image=await page.evaluate(async()=>{const art=new Image();art.src='/assets/themes/cozy-cafe.svg';await art.decode();return{width:art.naturalWidth,height:art.naturalHeight};});assert.deepEqual(image,{width:520,height:420});
    await page.goto(origin+'/tasks?view=list');await page.waitForSelector('[data-card-color="slot-01-v1"].activity-card');
    const colors=await page.evaluate(async()=>{const {NAMED_THEMES,CARD_SLOTS,cardColor}=await import('/utils/named-appearance.js'),theme=NAMED_THEMES.find(theme=>theme.id==='cozy-cafe');return CARD_SLOTS.map(slot=>{const node=document.querySelector('.activity-card[data-card-color="'+slot+'"]');if(!node)return{slot,missing:true};const css=getComputedStyle(node),probe=document.createElement('span');probe.style.background=cardColor(theme,slot).fill;document.body.append(probe);const expected=getComputedStyle(probe).backgroundColor;probe.remove();return{slot,fill:css.backgroundColor,expected};});});for(const color of colors){assert.equal(color.missing,undefined,JSON.stringify(color));assert.equal(color.fill,color.expected,color.slot);}await capture(page,'cozy-desktop-tasks');
    await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await capture(page,'cozy-mobile-tasks');
    await page.goto(origin+'/notes');await page.waitForSelector('.note-card[data-card-color="slot-01-v1"]');assert.equal(await page.$$eval('.note-card[data-card-color]',nodes=>new Set(nodes.map(node=>node.dataset.cardColor)).size),13);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await capture(page,'cozy-mobile-notes');
    await page.setViewport({width:1920,height:1080});await page.evaluate(async()=>{await(await import('/api.js')).api.post('/wall/enter',{});(await import('/utils/wall-mode.js')).setWallModeEnabled(true);});await page.goto(origin+'/');await page.waitForSelector('[data-wall-grid]');await page.waitForFunction(()=>document.documentElement.dataset.namedTheme==='cozy-cafe');assert.ok(await page.$('[data-wall-grid] [data-widget="tasks"]'));assert.ok(await page.$('[data-wall-grid] [data-widget="notes"]'));await capture(page,'cozy-wall');
    assert.deepEqual(snapshot(),before,'rendering changes neither stable slot IDs nor persisted task/note choices');assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
