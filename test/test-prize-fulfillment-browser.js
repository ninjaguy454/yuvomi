import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-prize-browser-')),output=process.env.PRIZE_BROWSER_EVIDENCE||join(folder,'evidence');
mkdirSync(output,{recursive:true});
process.env.DB_PATH=join(folder,'synthetic.db');delete process.env.DB_ENCRYPTION_KEY;
Object.assign(process.env,{SESSION_SECRET:'synthetic-prize-browser',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js');
const {createDevice}=await import('../server/services/devices.js');
const d=get(),password='Synthetic-Prize-Only-2026!',evidence={scope:'Disposable synthetic household, real app/auth, loopback browser, no live data',steps:[],errors:[]};
let browser,server,origin,device,log='';
test.before(async()=>{
  const hash=await hashPassword(password,4),insert=d.prepare(`INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version)
    VALUES(?,?,?,?,?,?,1)`);
  insert.run(1,'Prize Dad','Synthetic Dad',hash,'admin','dad');insert.run(2,'Prize Mom','Synthetic Mom',hash,'member','mom');
  insert.run(3,'Prize Child','Synthetic Child',hash,'member','child');
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(3,1)').run();
  d.prepare("INSERT INTO reward_ledger(user_id,delta,type) VALUES(3,100,'bonus')").run();
  d.prepare("INSERT INTO reward_catalog(id,name,cost) VALUES(1,'Synthetic movie',10)").run();
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('rewards_require_approval','0')").run();
  device=createDevice(d,{name:'Synthetic wall'},1);
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
  server.stdout.on('data',data=>{log+=data;});server.stderr.on('data',data=>{log+=data;});
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Synthetic app startup timed out: '+log)),30000);
    server.on('message',value=>{if(value.origin){clearTimeout(timer);resolve(value.origin);}});server.once('exit',code=>reject(new Error('Synthetic app exited: '+code+' '+log)));});
  const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',chrome='C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  // Disposable synthetic fixture; requests below are restricted to loopback.
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?(existsSync(chrome)?chrome:existsSync(edge)?edge:undefined):undefined),args:['--disable-background-networking','--disable-dev-shm-usage']});
});
async function pageFor(context,username,width){const page=await context.newPage();await page.setViewport({width,height:844,isMobile:width<500,hasTouch:width<500});
  page.setDefaultTimeout(15000);await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>localStorage.setItem('yuvomi-lang','en'));
  await page.setRequestInterception(true);page.on('request',request=>{if(request.isInterceptResolutionHandled())return;
    const url=new URL(request.url());if(url.pathname==='/sw.js'||!['127.0.0.1','localhost'].includes(url.hostname))request.abort();else request.continue();});
  page.on('pageerror',error=>evidence.errors.push(error.message));
  await page.goto(origin+'/login');
  assert.equal(await page.evaluate(async ({username,password})=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})).status,{username,password}),200);
  return page;
}
test('authenticated parent sees prize record Undo and pending delivery on the real Rewards page',{timeout:90000},async()=>{
  const context=await browser.createBrowserContext(),dadContext=await browser.createBrowserContext();let page;
  try{
    page=await pageFor(context,'Prize Mom',1280);
    const dad=await pageFor(dadContext,'Prize Dad',1280);
    const purchase=await dad.evaluate(async()=>{const {api}=await import('/api.js');return(await api.post('/rewards/redemptions',{user_id:3,catalog_id:1,request_id:crypto.randomUUID()})).data;});
    assert.equal(purchase.status,'pending');
    await page.goto(origin+'/rewards');await page.waitForSelector('.rw-standings');
    assert.ok(await page.$('[data-rw-undo="'+purchase.id+'"]'),'An authenticated parent needs Undo on the redemption record');
    await page.screenshot({path:join(output,'parent-pending-1280.png')});evidence.steps.push({width:1280,parentUndoVisible:true,pendingWithApprovalOff:true});
    // Drop the HTTP response only after SQLite committed the refund.
    const cdp=await page.createCDPSession();let dropped=false;
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/v1/rewards/redemptions/*/undo',requestStage:'Response'}]});
    cdp.on('Fetch.requestPaused',async event=>{if(!dropped){dropped=true;await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'Aborted'});}else await cdp.send('Fetch.continueRequest',{requestId:event.requestId});});
    await page.click('[data-rw-undo="'+purchase.id+'"]');await page.waitForSelector('[data-rw-undo-form]');
    assert.match(await page.$eval('[data-rw-undo-form]',el=>el.textContent),/return 10 points/);
    await page.click('[data-rw-undo-submit]');await page.waitForFunction(()=>!document.querySelector('[data-rw-undo-error]')?.hidden);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(purchase.id).n,1);
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('vidamia-reward-requests:2:undo')));assert.equal(saved.length,1);
    await cdp.send('Fetch.disable');await cdp.detach();
    await page.reload();await page.waitForSelector('[data-rw-history]');await page.click('[data-rw-history] > summary');
    await page.waitForSelector('[data-rw-undo="'+purchase.id+'"]');
    const replay=page.waitForResponse(r=>r.url().endsWith(`/redemptions/${purchase.id}/undo`));
    await page.click('[data-rw-undo="'+purchase.id+'"]');assert.equal((await replay).headers()['idempotent-replayed'],'true');
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('vidamia-reward-requests:2:undo')).length===0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemption_undos WHERE redemption_id=?').get(purchase.id).n,1);
    await page.waitForSelector('[data-redemption="'+purchase.id+'"]');
    const undoHistory=await page.$eval('[data-redemption="'+purchase.id+'"]',el=>el.textContent);
    assert.match(undoHistory,/Synthetic Mom returned 10 points on/);
    assert.doesNotMatch(undoHistory,/\{(?:actor|points|date)\}/);
    await page.screenshot({path:join(output,'parent-undone-1280.png')});evidence.steps.push({unknownResponseReload:true,sameKeyReplay:true,refunds:1});
    // A delivered record retains its original Task completion after explicit Undo.
    const delivered=await dad.evaluate(async()=>{const {api}=await import('/api.js');return(await api.post('/rewards/redemptions',{user_id:3,catalog_id:1,request_id:crypto.randomUUID()})).data;});
    const task=d.prepare('SELECT task_id FROM reward_fulfillment_task_links WHERE redemption_id=?').get(delivered.id).task_id;
    await page.goto(origin+'/tasks');
    const taskButton='[data-task-id="'+task+'"] [data-action="toggle-status"]';
    await page.waitForSelector(taskButton);assert.equal(await page.$eval(taskButton,el=>el.disabled),false);
    const completed=page.waitForResponse(r=>r.url().includes(`/tasks/${task}`)&&r.request().method()==='PATCH');
    await page.click(taskButton);assert.equal((await completed).status(),200);
    assert.equal(d.prepare('SELECT status,decided_by FROM reward_redemptions WHERE id=?').get(delivered.id).status,'fulfilled');
    assert.equal(d.prepare('SELECT decided_by FROM reward_redemptions WHERE id=?').get(delivered.id).decided_by,2);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(task).n,0);
    await page.screenshot({path:join(output,'parent-task-delivered-1280.png')});
    evidence.steps.push({parentTaskUICompletion:true,redemptionFulfilledTogether:true,noPointsAwarded:true});
    const completion=d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(task);
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.goto(origin+'/rewards');await page.waitForSelector('[data-rw-history]');await page.click('[data-rw-history] > summary');
    await page.click('[data-rw-undo="'+delivered.id+'"]');await page.waitForSelector('[data-rw-delivered-confirm]');
    assert.match(await page.$eval('[data-rw-undo-form]',el=>el.textContent),/cannot take back a prize already given/);
    assert.match(await page.$eval('[data-rw-undo-form]',el=>el.textContent),/return 10 points/);
    await page.click('[data-rw-undo-submit]');assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(delivered.id).status,'fulfilled');
    await page.click('[data-rw-delivered-confirm]');const refund=page.waitForResponse(r=>r.url().endsWith(`/redemptions/${delivered.id}/undo`));await page.click('[data-rw-undo-submit]');assert.equal((await refund).status(),200);
    await page.waitForSelector('[data-rw-undo-form]',{hidden:true});await page.waitForFunction(()=>document.querySelector('[data-rw-history]')?.isConnected);
    assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(task),completion);
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(task).status,'done');
    await page.waitForSelector('[data-redemption="'+delivered.id+'"]');
    const deliveredHistory=await page.$eval('[data-redemption="'+delivered.id+'"]',el=>el.textContent);
    assert.match(deliveredHistory,/Delivery was recorded on \d/);
    assert.doesNotMatch(deliveredHistory,/\{(?:actor|points|date)\}/);
    await page.screenshot({path:join(output,'parent-undone-390.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    evidence.steps.push({width:390,strongDeliveredConfirmation:true,completionHistoryPreserved:true,noHorizontalOverflow:true});
    await dad.goto(origin+'/settings/admin/devices');await dad.waitForSelector('[data-device-edit]');await dad.click('[data-device-edit]');await dad.waitForSelector('[name="reward:redeem"]');
    assert.equal(await dad.$eval('[name="reward:redeem"]',el=>el.checked),false);
    await dad.click('[data-device-save]');await dad.waitForSelector('[data-device-config]',{hidden:true});
    assert.equal(JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json).capabilities['device_rewards.redeem'],'none');
    evidence.steps.push({deviceDefaultOff:true,unrelatedSavePreservesOff:true});
    const last=await dad.evaluate(async()=>{const {api}=await import('/api.js');const row=(await api.post('/rewards/redemptions',{user_id:3,catalog_id:1,request_id:crypto.randomUUID()})).data;
      await api.delete('/auth/users/3');return row;});
    assert.equal(d.prepare('SELECT COUNT(*) n FROM users WHERE id=3').get().n,0);
    const cancelledTask=d.prepare('SELECT t.* FROM reward_fulfillment_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.redemption_id=?').get(last.id);
    assert.ok(cancelledTask.archived_at);assert.equal(cancelledTask.status,'open');
    assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(task),completion);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemption_undos WHERE redemption_id=?').get(delivered.id).n,1);
    evidence.steps.push({authenticatedMemberDeletion:true,unfinishedDeliveryCancelled:true,immutableHistoryRetained:true});
    assert.deepEqual(evidence.errors,[]);
  }catch(error){evidence.failure=error.stack;if(page)await page.screenshot({path:join(output,'failure.png')});throw error;}finally{await context.close();await dadContext.close();}
});
test.after(async()=>{
  await browser?.close();if(server&&!server.killed&&server.exitCode===null){await new Promise(resolve=>{server.once('exit',resolve);server.kill();});}
  writeFileSync(join(output,'result.json'),JSON.stringify(evidence,null,2));d.close();
  if(!process.env.PRIZE_BROWSER_EVIDENCE){assert.equal(dirname(resolve(folder)),resolve(tmpdir()));rmSync(folder,{recursive:true,force:true});}
});
