import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';

const folder=mkdtempSync(join(tmpdir(),'vidamia-archive-menu-'));
process.env.DB_PATH=join(folder,'browser.db');
delete process.env.DB_ENCRYPTION_KEY;
process.env.SESSION_SECRET='isolated-archive-menu-browser-tests-only';
process.env.SESSION_SECURE='false';process.env.BACKUP_ENABLED='false';
process.env.NODE_ENV='development';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');
const {hashPassword}=await import('../server/utils/password.js');
const db=get(),password='Isolated-Archive-Browser-Only-2026!';
let server,browser,origin,serverOutput='';

test.before(async()=>{
  const hash=await hashPassword(password);
  const admin=Number(db.prepare("INSERT INTO users(username,display_name,first_name,password_hash,role,family_role,onboarding_version) VALUES('Archive tester','Archive tester','Archive',?,'admin','parent',1)").run(hash).lastInsertRowid);
  const other=Number(db.prepare("INSERT INTO users(username,display_name,first_name,password_hash,role,family_role,onboarding_version) VALUES('Other private','Other private','Other',?,'member','parent',1)").run(hash).lastInsertRowid);
  for(let i=0;i<35;i++){
    const title=`Archived sample ${String(i).padStart(2,'0')}`;
    db.prepare("INSERT INTO tasks(title,category,status,created_by,assigned_to,archived_at) VALUES(?,'household','done',?,?,'2026-10-01T00:00:00Z')").run(title,admin,admin);
  }
  db.prepare("INSERT INTO tasks(title,category,status,created_by,assigned_to) VALUES('Active sample','household','done',?,?)").run(admin,admin);
  db.prepare("INSERT INTO tasks(title,category,status,created_by,assigned_to,visibility,archived_at) VALUES('Other private archived','household','done',?,?,'private','2026-10-01T00:00:00Z')").run(other,other);
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{
    env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc'],
  });
  server.stdout.on('data',data=>{serverOutput=(serverOutput+data).slice(-6000);});
  server.stderr.on('data',data=>{serverOutput=(serverOutput+data).slice(-6000);});
  origin=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`Full app did not start: ${serverOutput}`)),60000);
    server.once('message',message=>{clearTimeout(timeout);resolve(message.origin);});
    server.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Full app exited ${code}: ${serverOutput}`));});
  });
  browser=await puppeteer.launch({headless:true,
    executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':undefined),
    args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{
  await browser?.close();
  if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}
  db.close();
  for(const suffix of ['','-wal','-shm']){try{unlinkSync(join(folder,`browser.db${suffix}`));}catch{}}
  try{rmdirSync(folder);}catch{}
});

async function signedPage(mobile=false){
  const context=await browser.createBrowserContext(),page=await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror',error=>console.error('Archive browser error:',error.message));
  await page.setViewport(mobile?{width:390,height:844,isMobile:true,hasTouch:true}:{width:1280,height:900});
  await page.goto(`${origin}/login`);
  const code=await page.evaluate(async password=>(await fetch('/api/v1/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Archive tester',password})})).status,password);
  assert.equal(code,200);
  return {context,page};
}

test('dedicated Archive menu paginates, searches, restores and keeps private/active work separate',async()=>{
  const {context,page}=await signedPage();
  try{
    await page.goto(`${origin}/archive`);
    await page.waitForFunction(()=>document.querySelectorAll('.task-archive__row').length===30);
    assert.equal(await page.$eval('#task-archive-count',el=>el.textContent.trim()),'30 of 35 Tasks loaded.');
    assert.ok(await page.$('[data-route="/archive"][aria-current="page"]'));
    assert.equal(await page.$eval('#task-archive-more',el=>el.hidden),false);
    const offscreen=db.prepare("SELECT id,revision FROM tasks WHERE title='Archived sample 33'").get();
    await page.evaluate(async row=>(await import('/api.js')).api.patch(`/tasks/${row.id}/archive`,
      {archived:false,expected_revision:row.revision}),offscreen);
    await page.click('#task-archive-more');
    await page.waitForFunction(()=>document.querySelector('#task-archive-count')?.textContent==='30 of 34 Tasks loaded.');
    assert.equal(await page.$$eval('.task-archive__row',rows=>new Set(rows.map(row=>row.dataset.archiveId)).size),30);
    await page.click('#task-archive-more');
    await page.waitForFunction(()=>document.querySelectorAll('.task-archive__row').length===34);
    assert.equal(await page.evaluate(()=>document.body.textContent.includes('Other private archived')),false);
    await page.type('#task-archive-search','Archived sample 34');
    await page.waitForFunction(()=>document.querySelectorAll('.task-archive__row').length===1);
    await page.focus('[data-archive-restore]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.task-archive__row').length===0);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'task-archive-search');
    assert.match(await page.$eval('#task-archive-results',el=>el.textContent),/No results/i);
    assert.equal(db.prepare("SELECT archived_at FROM tasks WHERE title='Archived sample 34'").get().archived_at,null);
    await page.goto(`${origin}/tasks?view=kanban`);
    await page.waitForSelector('#task-list');
    assert.equal(await page.$('[data-board-section="archived"]'),null);
    assert.equal(await page.evaluate(()=>document.querySelector('#task-list')?.textContent.includes('Archived sample 33')),false);
    await page.goto(`${origin}/tasks?view=list`);
    await page.waitForSelector('#task-list');
    assert.equal(await page.$('[data-filter="status"][data-value="archived"]'),null);
  }finally{await context.close();}
});

test('mobile Archive route retains a separate searchable list',async()=>{
  const {context,page}=await signedPage(true);
  try{
    await page.goto(`${origin}/archive`);
    await page.waitForFunction(()=>document.querySelectorAll('.task-archive__row').length===30);
    assert.equal(await page.$eval('#task-archive-count',el=>el.textContent.trim()),'30 of 33 Tasks loaded.');
    assert.ok(await page.$('#task-archive-search'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
  }finally{await context.close();}
});

test('paired device omits unsupported Archive destination and redirects its deep link',async()=>{
  const {context:adminContext,page:admin}=await signedPage();
  const displayContext=await browser.createBrowserContext(),display=await displayContext.newPage();
  try{
    await display.goto(`${origin}/login`);
    const call=(page,method,path,body)=>page.evaluate(async({method,path,body})=>
      (await import('/api.js')).api[method](path,body),{method,path,body});
    const pairing=await call(display,'post','/device/pair',{});
    await call(admin,'post','/devices/pairing-approve',{code:pairing.code,name:'Synthetic Archive device'});
    await call(display,'post','/device/pair/claim',{confirm_transition:true});
    await display.goto(`${origin}/device`);
    await display.waitForSelector('[data-device-login]');
    assert.equal(await display.$('[data-route="/archive"]'),null);
    await display.goto(`${origin}/archive`);
    await display.waitForFunction(()=>location.pathname!=='/archive');
    assert.equal(await display.$('#task-archive-results'),null);
  }finally{await displayContext.close();await adminContext.close();}
});
