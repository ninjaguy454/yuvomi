/** Production shell and APIs against disposable Notes/device records. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-granular-notes-'));
Object.assign(process.env,{DB_PATH:join(folder,'test.db'),SESSION_SECRET:'synthetic-granular-tests',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js');
const {beginPairing,approvePairing,claimPairing}=await import('../server/services/devices.js');
const {ensureNoteLayoutOwner}=await import('../server/services/note-layout-owner.js');
const db=get(),output=resolve(process.env.NOTES_GRANULAR_EVIDENCE||join(folder,'evidence'));
mkdirSync(output,{recursive:true});
const evidence={checks:[],errors:[]};let server,browser,origin;
test.before(async()=>{
  db.exec("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'Parent','Parent','no-login','admin','parent',1)");
  for(let id=1;id<=6;id++)db.prepare('INSERT INTO notes(id,title,content,created_by) VALUES(?,?,?,1)').run(id,`Note ${id}`,'- [ ] Checklist body');
  server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',data=>log=(log+data).slice(-5000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),60000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${log}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
});
test.after(async()=>{writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2));await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(r=>server.once('exit',r));}db.close();});
async function display(grants,width=1280){
  const capabilities=Object.fromEntries(['view','create','edit','delete','move','pin','group','ungroup'].map(a=>[`device_notes.${a}`,a==='view'||grants.includes(a)?'allow':'none']));
  const pair=beginPairing(db);approvePairing(db,pair.code,{name:`Synthetic ${grants}`,permissions:{capabilities}},1);
  const {token,device}=claimPairing(db,pair.secret),owner=`device:${device.id}`;ensureNoteLayoutOwner(db,owner);
  db.prepare('INSERT INTO note_board_groups(owner_key,id,x,y,width,height,position_locked,always_on_top) VALUES(?,1,0,0,4,6,0,0)').run(owner);
  for(const [index,id] of [1,2,3].entries())db.prepare('INSERT INTO note_board_group_members(owner_key,note_id,group_id,ordinal) VALUES(?,?,1,?)').run(owner,id,index);
  db.prepare('UPDATE note_board_owners SET next_group_id=2 WHERE owner_key=?').run(owner);
  db.prepare('INSERT INTO note_board_note_layouts(owner_key,note_id,x,y,width,height,position_locked) VALUES(?,4,6,0,4,6,1)').run(owner);
  const context=await browser.createBrowserContext();await context.setCookie({name:'vidamia.device',value:token,url:origin,httpOnly:true,sameSite:'Lax'});
  const page=await context.newPage();page.setDefaultTimeout(12000);await page.setViewport({width,height:960});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');Object.defineProperty(navigator,'onLine',{get:()=>true});});
  page.on('pageerror',e=>evidence.errors.push(e.message));
  page.on('response',r=>{if(r.url().endsWith('/notes/board'))page.lastBoardResponse=Date.now();});
  await page.setRequestInterception(true);page.on('request',r=>{const u=new URL(r.url());if((['http:','https:'].includes(u.protocol)&&u.origin!==origin)||u.pathname==='/sw.js')return r.abort();r.continue();});
  await page.goto(origin+'/notes');await page.waitForSelector('.notes-page,.dashboard');
  if(!await page.$('.notes-page'))await page.evaluate(()=>window.yuvomi.navigate('/notes'));
  await page.waitForSelector('[data-board-key="group:1"]');
  // Let the initial SSE-open refresh settle before editing a draft.
  await page.waitForFunction(()=>!!document.querySelector('#notes-grid')&&!document.querySelector('#notes-grid[aria-busy]'));
  while(Date.now()-(page.lastBoardResponse||0)<200)await new Promise(r=>setTimeout(r,25));
  return {page,context,owner};
}
async function press(page,selector){await page.waitForSelector(selector);await page.$eval(selector,e=>e.click());}
async function operation(page,selector){const response=page.waitForResponse(r=>r.url().endsWith('/notes/group-operations')&&r.request().method()==='POST');await press(page,selector);const result=await response;assert.equal(result.status(),200,await result.text());return (await result.json()).data;}
const card='[data-board-key="group:1"]';
test('Move-only layout editor survives an unchanged focus refresh without Edit',{timeout:45000},async()=>{
  const {page,context}=await display(['move']);try{
    await press(page,'[data-board-key="note:5"] [data-board-action="adjust"]');await page.waitForSelector('#note-layout-width');
    await page.$eval('#note-layout-width',e=>{e.value='7';});
    const refreshed=page.waitForResponse(r=>r.url().endsWith('/notes/board'));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await(await refreshed).text();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('#note-layout-width',e=>e.value),'7','authorized layout draft survives refresh');
  }finally{await context.close();}
});
for(const width of [390,1280])for(const action of ['move','pin','group','ungroup'])test(`${action}-only device has usable independent controls at ${width}px`,{timeout:45000},async()=>{
  const {page,context,owner}=await display([action],width);try{
    assert.equal(await page.$(`${card} [data-action="pin"]`),null,'Dashboard visibility requires Edit');
    assert.equal(!!await page.$(`${card} [data-board-action="lock"]`),action==='pin');
    assert.equal(!!await page.$(`${card} [data-board-action="adjust"]`),action==='move');
    assert.equal(!!await page.$('#notes-organize'),action==='move');
    assert.equal(!!await page.$(`${card} [data-group-action="remove"]`),action==='ungroup');
    assert.equal(!!await page.$(`${card} [data-group-action="order"]`),action==='move');
    assert.equal(await page.$(`${card} [data-group-action="move"]`),null,'Transfer needs both grants');
    if(action==='pin'){
      const result=await operation(page,`${card} [data-board-action="lock"]`);assert.equal(result.board.groups[0].layout.position_locked,true);
      await page.waitForSelector('[data-group-undo]');await operation(page,'[data-group-undo]');
      assert.equal(db.prepare('SELECT position_locked FROM note_board_groups WHERE owner_key=? AND id=1').get(owner).position_locked,0);
    }else if(action==='move'){
      await press(page,`${card} [data-board-action="adjust"]`);await page.$eval('#note-layout-width',e=>{e.value='5';});await operation(page,'#note-layout-save');
      assert.equal(db.prepare('SELECT width FROM note_board_groups WHERE owner_key=? AND id=1').get(owner).width,5);
      await press(page,`${card} [data-group-action="order"]`);await page.waitForSelector('[data-group-before]');await page.select('[data-group-before]','');await operation(page,'[data-group-confirm]');
      assert.deepEqual(db.prepare('SELECT note_id FROM note_board_group_members WHERE owner_key=? AND group_id=1 ORDER BY ordinal').all(owner).map(r=>r.note_id),[2,3,1]);
    }else if(action==='group'){
      const source='[data-board-key="note:5"]';await press(page,`${source} [data-group-action="add"]`);await page.waitForSelector('[data-group-destination]');await page.select('[data-group-destination]','1');
      const result=await operation(page,'[data-group-confirm]');assert.equal(result.undo_available,false);assert.ok(result.board.groups[0].member_ids.includes(5));
    }else{
      await press(page,`${card} [data-group-action="remove"]`);await page.waitForSelector('[data-group-confirm]');const result=await operation(page,'[data-group-confirm]');assert.equal(result.undo_available,false);assert.deepEqual(result.board.groups[0].member_ids,[2,3]);
    }
    assert.equal(db.prepare('SELECT count(*) n FROM notes WHERE content<>?').get('- [ ] Checklist body').n,0);
    await page.screenshot({path:join(output,`${action}-${width}.png`)});evidence.checks.push({action,width,passed:true});
  }catch(error){await page.screenshot({path:join(output,`failure-${action}-${width}.png`)});throw error;}finally{await context.close();}
});
