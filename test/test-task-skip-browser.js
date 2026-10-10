import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer';

const repo=fileURLToPath(new URL('..',import.meta.url));
if(process.env.TASK_SKIP_BROWSER_CHILD==='1')await run();
else test('real Task Details: keyboard/mobile confirmation, Cancel, history, permissions and second-client refresh',{timeout:180000},()=>{
  const temporary=!process.env.TASK_SKIP_QA_OUTPUT;
  const output=process.env.TASK_SKIP_QA_OUTPUT||mkdtempSync(path.join(tmpdir(),'task-skip-browser-'));
  mkdirSync(output,{recursive:true});
  try {
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{encoding:'utf8',timeout:170000,maxBuffer:8*1024*1024,
      env:{...process.env,TASK_SKIP_BROWSER_CHILD:'1',TASK_SKIP_QA_OUTPUT:output}});
    writeFileSync(path.join(output,'browser-child.log'),`${child.stdout}\n${child.stderr}`);
    assert.equal(child.status,0,`${child.error||''}\n${child.stdout}\n${child.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(path.join(output,'results.json'),'utf8')),
      {cancel:true,keyboard:true,mobile:true,skipped:true,liveClient:true,childDenied:true,successor:true,noPoints:true,pageErrors:[]});
  }finally{
    if(temporary){assert.equal(path.dirname(path.resolve(output)),path.resolve(tmpdir()));assert.ok(path.basename(output).startsWith('task-skip-browser-'));rmSync(output,{recursive:true,force:true});}
  }
});

async function run(){
  const output=process.env.TASK_SKIP_QA_OUTPUT;process.chdir(output);
  process.env.DB_PATH=path.join(output,`synthetic-skip-${process.pid}.db`);delete process.env.DB_ENCRYPTION_KEY;
  mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T12:30:00Z')});
  Object.assign(process.env,{SESSION_SECRET:'isolated-skip-browser-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',PORT:'0',LOG_LEVEL:'error'});
  const {get}=await import(pathToFileURL(path.join(repo,'server/db.js'))),d=get();
  const {hashPassword}=await import(pathToFileURL(path.join(repo,'server/utils/password.js')));
  const password='Synthetic-Skip-Only!';
  const insert=d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,1)");
  const admin=Number(insert.run('skipqa','Parent QA',await hashPassword(password),'admin','parent').lastInsertRowid);
  const child=Number(insert.run('skipchild','Child QA',await hashPassword(password),'member','child').lastInsertRowid);
  const other=Number(insert.run('skipother','Other QA','x','member','other').lastInsertRowid);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  for(const id of [child,other])d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  let resolve;const ready=new Promise(r=>resolve=r),listen=net.Server.prototype.listen;
  net.Server.prototype.listen=function(...args){if(args[0]==='0'){args[0]=0;args.splice(1,0,'127.0.0.1');this.once('listening',()=>resolve(`http://127.0.0.1:${this.address().port}`));}return listen.apply(this,args);};
  await import(pathToFileURL(path.join(repo,'server/index.js')));const origin=await ready;
  const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
  const pageErrors=[];
  async function client(width,username='skipqa'){
    const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(15000);
    await page.setViewport({width,height:900});page.on('pageerror',e=>pageErrors.push(e.message));
    await page.goto(`${origin}/login`,{waitUntil:'domcontentloaded'});
    await page.evaluate(async({username,password})=>{const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});if(!r.ok)throw new Error(`Login ${r.status}`);},{username,password});
    await page.goto(`${origin}/tasks`,{waitUntil:'domcontentloaded'});
    await new Promise(r=>setTimeout(r,5000));await page.waitForSelector('#btn-new-task, #fab-new-task');
    await page.evaluate(()=>{window.qaClicks=[];document.addEventListener('click',event=>window.qaClicks.push({target:event.target.outerHTML.slice(0,180),x:event.clientX,y:event.clientY}),true);window.qaToasts=[];const original=window.yuvomi.showToast;window.yuvomi.showToast=(...args)=>{window.qaToasts.push(args[0]);return original(...args);};});return page;
  }
  const api=(page,method,url,body)=>page.evaluate(async({method,url,body})=>(await import('/api.js')).api[method](url,body),{method,url,body});
  async function open(page,id){
    await page.evaluate(async id=>{const {closeModal}=await import('/components/modal.js');await closeModal({force:true});const {openTaskById}=await import('/pages/tasks.js');await openTaskById(id,{user:window.yuvomi.user});},id);
    await page.waitForSelector('#shared-modal-overlay .modal-panel');
    await page.waitForFunction(()=>!document.querySelector('#shared-modal-overlay .modal-panel')?.getAnimations({subtree:true}).some(animation=>animation.playState==='running'));
  }
  const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  try {
    const desktop=await client(1366),mobile=await client(390),observer=await client(1366);
    const task=(await api(desktop,'post','/tasks',{title:'Synthetic shared daily routine',assigned_to:[child,other],points:5,
      is_recurring:true,recurrence_rule:'FREQ=DAILY',start_date:'2026-11-01',start_time:'07:00',due_date:'2026-11-01',due_time:'08:00',
      expiration_policy:'expire_incomplete',subtasks:[{title:'Saved first step',points:2},{title:'Remaining step',points:3}]})).data;
    await open(observer,task.id);await open(mobile,task.id);
    console.log('Mobile geometry before click',await mobile.$eval('#task-detail-skip',el=>{const r=el.getBoundingClientRect();return {rect:{x:r.x,y:r.y,w:r.width,h:r.height},hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,180),style:window.getComputedStyle(el).pointerEvents};}));
    // A first-install service-worker update notice can temporarily cover the
    // existing footer. Let that real notice expire before testing a user tap.
    await mobile.waitForFunction(()=>{const el=document.getElementById('task-detail-skip');if(!el)return false;const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el;},{timeout:30000});
    await mobile.locator('#task-detail-skip').click();
    console.log('Mobile click probe',await mobile.evaluate(()=>({clicks:window.qaClicks,toasts:window.qaToasts,button:document.getElementById('task-detail-skip')?.outerHTML,confirm:!!document.getElementById('confirm-modal-ok'),visibility:document.visibilityState})));
    await mobile.waitForSelector('#confirm-modal-cancel',{visible:true});
    assert.match(await mobile.$eval('#confirm-modal-ok',el=>el.closest('.modal-panel').textContent),/2026-11-01/);
    assert.match(await mobile.$eval('#confirm-modal-ok',el=>el.closest('.modal-panel').textContent),/all current assignees/);
    await mobile.screenshot({path:path.join(output,'mobile-confirm.png'),fullPage:true});
    const before=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
    await mobile.locator('#confirm-modal-cancel').click();await mobile.waitForSelector('#task-detail-skip',{visible:true});
    assert.equal(row(task.id).status,'open');assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,before);
    await open(desktop,task.id);await desktop.focus('#task-detail-skip');await desktop.keyboard.press('Enter');
    await desktop.waitForSelector('#confirm-modal-ok',{visible:true});await desktop.focus('#confirm-modal-ok');await desktop.keyboard.press('Enter');
    await desktop.waitForFunction(()=>document.querySelector('#shared-modal-overlay .modal-panel')?.textContent.includes('Skipped'));
    assert.equal(row(task.id).status,'skipped');
    assert.equal(await desktop.$('[data-focus-key="reopen"]'),null);
    assert.equal(await desktop.evaluate(()=>document.getElementById('task-detail-skip')?.checkVisibility()||false),false);
    assert.ok(!(await desktop.$eval('#shared-modal-overlay .modal-panel',el=>el.textContent)).includes('Undo'));
    await observer.waitForFunction(()=>document.querySelector('#shared-modal-overlay .modal-panel')?.textContent.includes('Skipped'));
    await desktop.screenshot({path:path.join(output,'desktop-skipped.png'),fullPage:true});
    await open(mobile,task.id);await mobile.screenshot({path:path.join(output,'mobile-skipped.png'),fullPage:true});
    const next=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(task.id);
    assert.equal(next.length,1);assert.equal(next[0].start_date,'2026-11-02');assert.equal(next[0].status,'open');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
    const childPage=await client(390,'skipchild');await open(childPage,next[0].id);
    assert.equal(await childPage.$('#task-detail-skip'),null);
    assert.equal((await api(childPage,'get',`/tasks/${next[0].id}`)).data.permissions.skip_occurrence,false);
    assert.deepEqual(pageErrors,[]);
    writeFileSync(path.join(output,'results.json'),JSON.stringify({cancel:true,keyboard:true,mobile:true,skipped:true,liveClient:true,childDenied:true,successor:true,noPoints:true,pageErrors},null,2));
    await browser.close();process.exit(0);
  }catch(error){
    for(const [index,page] of (await browser.pages()).entries()){
      if(page.url().startsWith(origin)){await page.screenshot({path:path.join(output,`failure-${index}.png`),fullPage:true}).catch(()=>{});writeFileSync(path.join(output,`failure-${index}.html`),await page.content());}
      if(page.url().startsWith(origin))console.log('Failure page probe',index,await page.evaluate(()=>({clicks:window.qaClicks,toasts:window.qaToasts})));
    }
    console.error(error);console.error('Page errors:',pageErrors);await browser.close();process.exit(1);
  }
}
