import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,unlinkSync,rmdirSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-owner-extras-'));
process.env.DB_PATH=join(folder,'browser.db');delete process.env.DB_ENCRYPTION_KEY;
Object.assign(process.env,{SESSION_SECRET:'isolated-group-owner-extras-browser',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const {saveRotationGroup}=await import('../server/services/rotation.js');
const d=get(),password='Synthetic-Owner-Extras-2026!';let server,browser,origin,group,admin,extra,other,output='';
test.before(async()=>{
 const hash=await hashPassword(password);
 for(const [name,role] of [['Owner parent','admin'],['Owner extra','member'],['Owner other','member']]){
  const id=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,'other',1)").run(name,name,hash,role).lastInsertRowid);
  if(role==='admin')admin=id;else if(!extra)extra=id;else other=id;
 }
 group=saveRotationGroup(d,{name:'Browser Owners',member_ids:[admin,other]},{actorId:admin});
 server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
 server.stdout.on('data',v=>output=(output+v).slice(-8000));server.stderr.on('data',v=>output=(output+v).slice(-8000));
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(output)),45000);server.once('message',msg=>{clearTimeout(timer);resolve(msg.origin);});server.once('exit',code=>reject(new Error(code+output)));});
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-sandbox','--disable-dev-shm-usage','--mute-audio']});
});
test.after(async()=>{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(r=>server.once('exit',r));}d.close();for(const suffix of ['','-wal','-shm'])try{unlinkSync(join(folder,'browser.db'+suffix));}catch{}try{rmdirSync(folder);}catch{}});
const set=(p,selector,value)=>p.$eval(selector,(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},value);
const api=(p,method,path,body)=>p.evaluate(async({method,path,body})=>(await import('/api.js')).api[method](path,body),{method,path,body});
async function openEditor(p,id){await p.evaluate(async id=>{await(await import('/components/modal.js')).closeModal({force:true});await(await import('/pages/tasks.js')).openTaskById(id,{user:window.yuvomi.user});},id);await p.waitForSelector('#detail-view-edit');await p.click('#detail-view-edit');await p.waitForSelector('#task-form');}
async function close(p){await p.evaluate(async()=>{await(await import('/components/modal.js')).closeModal({force:true});});await p.waitForFunction(()=>!document.querySelector('#task-form'));}
for(const width of [330,390,1366])test(`real app ${width}px: Group extras keyboard selection, save, reopen and Template draft return`,{timeout:120000},async()=>{
 const context=await browser.createBrowserContext(),p=await context.newPage();p.setDefaultTimeout(15000);await p.setViewport({width,height:960});await p.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);const errors=[];p.on('pageerror',e=>errors.push(e.message));
 try{
  await p.goto(origin+'/login');assert.equal(await p.evaluate(async password=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Owner parent',password})})).status,password),200);
  await p.evaluate(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-tasks-view','list');});await p.goto(origin+'/tasks?view=list');await p.waitForSelector('#btn-new-task');await p.waitForFunction(()=>document.querySelector('#task-list')&&!document.querySelector('#task-list .widget-skeleton'));await p.evaluate(()=>{window.extraToasts=[];const original=window.yuvomi.showToast;window.yuvomi.showToast=(...args)=>{window.extraToasts.push(args);return original(...args);};});
  await p.focus(width<600?'#fab-new-task':'#btn-new-task');await p.keyboard.press('Enter');await p.waitForSelector('#task-form');await set(p,'#task-title','Extras '+width);await p.click(`[data-task-group-choice="${group.id}"]`);
  await p.waitForSelector('#task-group-additional',{visible:true});assert.equal(await p.$eval('#task-fixed-assignment',e=>e.hidden),true);
  const selector=`[data-ms-input="task_additional"][value="${extra}"]`;await p.focus(selector);await p.keyboard.press('Space');assert.equal(await p.$eval(selector,e=>e.checked),true);
  assert.equal(await p.$eval('[data-task-assignment-group]',e=>Number(e.value)),group.id);
  assert.equal(await p.$eval('.modal-panel',e=>e.scrollWidth<=e.clientWidth+1),true);
  await p.focus('[data-save-as-template]');await p.keyboard.press('Enter');await p.waitForSelector('#automation-group-additional',{visible:true});
  assert.equal(await p.$eval(`[data-ms-input="template_additional"][value="${extra}"]`,e=>e.checked),true);
  await p.evaluate(async()=>{await(await import('/components/modal.js')).closeModal({force:true});});await p.waitForFunction(()=>document.querySelector('#task-form')&&!document.querySelector('#task-form').closest('.modal-overlay')?.inert&&!document.querySelector('#automation-group-additional'));
  assert.equal(await p.$eval(selector,e=>e.checked),true);assert.equal(await p.$eval('[data-task-assignment-group]',e=>Number(e.value)),group.id);
  await p.focus('[data-save-as-template]');await p.keyboard.press('Enter');await p.waitForSelector('#automation-group-additional',{visible:true});
  await p.focus(`[data-ms-input="template_additional"][value="${extra}"]`);await p.keyboard.press('Space');await p.focus(`[data-ms-input="template_additional"][value="${other}"]`);await p.keyboard.press('Space');
  await p.$eval('#automation-activity-form',e=>e.closest('.modal-panel').querySelector('button[type=submit]').focus());await p.keyboard.press('Enter');
  await p.waitForFunction(()=>document.querySelector('#task-form')&&!document.querySelector('#task-form').closest('.modal-overlay')?.inert&&!document.querySelector('#automation-group-additional'));
  assert.equal(await p.$eval(selector,e=>e.checked),true);assert.deepEqual(JSON.parse(d.prepare('SELECT additional_assignee_ids_json FROM activity_templates WHERE name=?').get('Extras '+width).additional_assignee_ids_json),[other]);

  await p.$eval('#task-group-additional',e=>e.scrollIntoView({block:'center'}));
  const shots=process.env.GROUP_EXTRAS_BROWSER_OUTPUT;if(shots){mkdirSync(shots,{recursive:true});await p.screenshot({path:join(shots,`group-extras-${width}.png`),fullPage:true});}
  await p.focus('#task-submit-btn');await p.keyboard.press('Enter');await p.waitForFunction(()=>!document.querySelector('#task-form'));
  const row=d.prepare('SELECT * FROM tasks WHERE title=?').get('Extras '+width);assert.ok(row,output);assert.equal(row.assigned_to,admin);assert.deepEqual(JSON.parse(row.additional_assignee_ids_json),[extra]);
  await openEditor(p,row.id);assert.equal(await p.$eval(selector,e=>e.checked),true);assert.equal(await p.$eval('[data-task-assignment-group]',e=>Number(e.value)),group.id);
  await close(p);
  const template=(await api(p,'post','/automation/admin/activity-templates',{name:'Extras template '+width,title_template:'Template '+width,assignment_strategy:'group_rotation',assignment_group:{group_id:group.id},additional_assignee_ids:[extra],subject_required:false,scoring_mode:'whole_task'})).data;
  assert.deepEqual(template.additional_assignee_ids,[extra]);const launched=(await api(p,'post','/tasks',{title:'Launched '+width,activity_template_id:template.id,assigned_to:[],points:0})).data;assert.deepEqual(launched.direct_assignee_ids,[admin,extra].sort((a,b)=>a-b));assert.equal(launched.assigned_to,admin);
  // A saved ordered list survives a full editor save whose avatar display uses another order.
  const ordered=(await api(p,'post','/tasks',{title:'Ordered '+width,assignment_group:{group_id:group.id},additional_assignee_ids:[other,extra],points:0})).data;
  await openEditor(p,ordered.id);await set(p,'#task-title','Ordered changed '+width);await p.focus('#task-submit-btn');await p.keyboard.press('Enter');await p.waitForFunction(()=>!document.querySelector('#task-form'));
  assert.deepEqual(JSON.parse(d.prepare('SELECT additional_assignee_ids_json FROM tasks WHERE id=?').get(ordered.id).additional_assignee_ids_json),[other,extra]);
  assert.deepEqual(errors,[]);
 }catch(error){console.error(JSON.stringify({width,errors,state:await p.evaluate(()=>({toasts:window.extraToasts,title:document.querySelector('#task-title')?.value,id:document.querySelector('#task-id')?.value,invalid:[...document.querySelectorAll(':invalid')].map(e=>({id:e.id,message:e.validationMessage})),body:document.body.innerText.slice(-2500)}))}));throw error;}finally{await context.close();}
});
