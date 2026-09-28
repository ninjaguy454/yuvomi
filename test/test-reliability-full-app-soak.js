/** Opt-in, real-backend browser soak. No production URL or credential is used.
 * RUN_RELIABILITY_SOAK=1 RELIABILITY_SOAK_SECONDS=600 node --test <this file>
 * Shorter runs are explicitly reported as harness smoke, never a ten-minute soak.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync,cpSync,symlinkSync,realpathSync,existsSync,readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer';

test('concurrent personal and paired-device recovery soak',{skip:process.env.RUN_RELIABILITY_SOAK!=='1',timeout:1_200_000},async()=>{
  const duration=Math.max(30,Math.min(900,Number(process.env.RELIABILITY_SOAK_SECONDS)||600));
  const folder=mkdtempSync(join(tmpdir(),'vidamia-reliability-soak-'));
  // Express sendFile rejects dot-directory ancestors on Windows. Preserve the
  // exact runtime bytes in a disposable non-dot fixture directory, as /app does
  // in the production image; do not weaken the application's dotfile policy.
  const runtime=join(folder,'runtime');mkdirSync(runtime);
  const source=resolve(process.env.RELIABILITY_SOURCE_DIR||'.');
  for(const name of ['server','public','modules','package.json'])if(existsSync(join(source,name)))cpSync(join(source,name),join(runtime,name),{recursive:true});
  mkdirSync(join(runtime,'test/helpers'),{recursive:true});
  cpSync(resolve('test/helpers/task-card-full-app-server.mjs'),join(runtime,'test/helpers/task-card-full-app-server.mjs'));
  symlinkSync(realpathSync(resolve('node_modules')),join(runtime,'node_modules'),'junction');
  process.env.DB_PATH=join(folder,'test.db');delete process.env.DB_ENCRYPTION_KEY;
  Object.assign(process.env,{SESSION_SECRET:'isolated-reliability-browser-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
  const {get}=await import('../server/db.js'),{hashPassword}=await import('../server/utils/password.js');
  const d=get(),password='Isolated-Reliability-Parent-2026!',roots=[],kids=[];
  const admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('Soak parent','Soak parent',?,'admin','parent',1)").run(await hashPassword(password)).lastInsertRowid);
  const steps=12,report={duration_seconds:duration,kind:duration>=600?'ten-minute-or-longer soak':'short harness smoke',source,failures:[],clients:[],faults:[],cycles:0,concurrent_waves:0};
  const sourceFiles=[];function fingerprint(path,prefix){for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(path,item.name),key=prefix+'/'+item.name;if(item.isDirectory())fingerprint(file,key);else if(item.isFile())sourceFiles.push({path:key,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')});}}for(const name of ['server','public'])fingerprint(join(runtime,name),name);report.runtime_files=sourceFiles;
  for(const name of ['Grace','Eleanor','Frankie']){
    const id=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,'no-login','member','child',1)").run(name,name).lastInsertRowid);kids.push(id);
    d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
    const root=Number(d.prepare("INSERT INTO tasks(title,assigned_to,points,created_by,visibility) VALUES(?,?,2,?,'all')").run(name+' routine',id,admin).lastInsertRowid);
    d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(root,id);
    const children=[];for(let n=0;n<steps;n++)children.push(Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility,is_optional) VALUES(?,?,?,'all',?)").run('Step '+(n+1),root,admin,n===2?1:0).lastInsertRowid));
    roots.push({root,children});
  }
  const {todayKey}=await import('../server/utils/timezone.js');
  const today=todayKey(d);
  d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=DAILY',start_date=?,due_date=? WHERE id=?").run(today,today,roots[0].root);
  const expiredId=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by,visibility,expiration_policy,due_date,points) VALUES('Synthetic expired routine',?,?,'all','expire_incomplete','2020-01-01',2)").run(kids[0],admin).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(expiredId,kids[0]);
  const supervisedRoot=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by,visibility) VALUES('Synthetic supervised routine',?,?,'all')").run(kids[1],admin).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(supervisedRoot,kids[1]);
  const supervisedAction=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility) VALUES('Synthetic supervised step',?,?,'all')").run(supervisedRoot,admin).lastInsertRowid);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic supervision skill',0,'normal',?)").run(admin).lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'supervised','manual',?)").run(kids[1],skill,admin);
  const {setTaskSkills}=await import('../server/services/task-skills.js'),{reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
  setTaskSkills(d,supervisedAction,[skill]);const supervision=reconcileTaskSupervision(d,supervisedRoot);const helper=supervision.actions.find(action=>action.action_task_id===supervisedAction).counterpart_task_id;
  const {saveRotationGroupUsage}=await import('../server/services/rotation-shared.js'),{utcToWall,householdTimeZone}=await import('../server/utils/timezone.js');
  const cutoff=utcToWall(new Date(Date.now()+120000).toISOString(),householdTimeZone(d));
  const rotation=saveRotationGroupUsage(d,{name:'Synthetic shared shower order',member_ids:kids,usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:kids[0],effective_date:today,weekdays:[0,1,2,3,4,5,6],active_time:'00:00',finalize_time:cutoff.time.slice(0,5),finalize_day_offset:cutoff.date===today?0:1,advance_on_skip:false}},{actorId:admin});
  let server,browser,origin,output='';const pages=[],sessions=[];
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(value,label)=>{if(!value)report.failures.push(label);};
  const step=id=>'[data-action="toggle-subtask"][data-id="'+id+'"]';
  const status=id=>d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;
  const samples=[];
  try{
    server=fork(join(runtime,'test/helpers/task-card-full-app-server.mjs'),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
    server.stdout.on('data',data=>output=(output+data).slice(-4000));server.stderr.on('data',data=>output=(output+data).slice(-4000));
    origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Isolated server startup failed: '+output)),60000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(new Error('Isolated server exited '+code));});});
    browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
    async function client(name){
      const context=await browser.createBrowserContext(),page=await context.newPage(),metric={name,requests:0,statuses:{},failed_requests:0,task_reads:0,auth_reads:0,sse_connections:0,task_ack_ms:[],task_list_ms:[],frame_feedback_ms:[],page_errors:[]};
      const starts=new WeakMap();report.clients.push(metric);pages.push(page);
      page.on('request',request=>{if(!request.url().includes('/api/'))return;starts.set(request,performance.now());metric.requests++;const path=new URL(request.url()).pathname;if(path==='/api/v1/tasks'&&request.method()==='GET')metric.task_reads++;if(path==='/api/v1/auth/me')metric.auth_reads++;if(path==='/api/v1/tasks/changes')metric.sse_connections++;});
      page.on('response',response=>{const request=response.request(),started=starts.get(request);if(started==null)return;metric.statuses[response.status()]=(metric.statuses[response.status()]||0)+1;const path=new URL(response.url()).pathname;if(path==='/api/v1/tasks'&&response.status()===200)metric.task_list_ms.push(performance.now()-started);if(/^\/api\/v1\/tasks\/\d+\/status$/.test(path)&&response.status()===200)metric.task_ack_ms.push(performance.now()-started);});
      page.on('requestfailed',request=>{if(starts.has(request))metric.failed_requests++;});
      page.on('pageerror',error=>metric.page_errors.push(error.message));
      page.setDefaultTimeout(20000);await page.setViewport({width:name==='paired'?1366:1280,height:900});
      const cdp=await page.createCDPSession();sessions.push(cdp);await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
      await page.goto(origin+'/login');await page.evaluate(()=>localStorage.setItem('yuvomi-lang','en'));await page.reload();await wait(1000);return{page,metric,cdp};
    }
    async function login(page){await page.waitForSelector('#username');await page.type('#username','Soak parent');await page.type('#password',password);await page.click('[type=submit]');await page.waitForSelector('.dashboard');}
    const one=await client('personal-list'),two=await client('personal-kanban'),wall=await client('paired');
    await login(one.page);await login(two.page);
    await wall.page.goto(origin+'/device/pair');await wall.page.waitForSelector('[data-pair-start]');await wall.page.click('[data-pair-start]');await wall.page.waitForSelector('[data-pair-code]');const code=await wall.page.$eval('[data-pair-code]',node=>node.textContent);
    await one.page.goto(origin+'/settings/admin/devices');await one.page.waitForSelector('[data-device-approve]');await one.page.click('[data-device-approve]');await one.page.waitForSelector('[data-device-approve-form]');await one.page.type('[name=code]',code);await one.page.type('[name=name]','Synthetic Kitchen Wall');await one.page.click('[data-device-approve-form] [type=submit]');
    await wall.page.waitForSelector('[data-pair-claim]');await wall.page.click('[data-pair-claim]');await wall.page.waitForSelector('[data-device-login]');await wall.page.waitForSelector('.dashboard');
    await wall.page.waitForSelector('.widget--rotations');check((await wall.page.$eval('.widget--rotations',node=>node.textContent)).includes('Synthetic shared shower order'),'paired dashboard displays permitted shared Rotation');
    async function board(item,view){
      await item.page.goto(origin+(item===wall?'/device':'/tasks?view='+view));await item.page.waitForSelector('.app-shell');
      if(item===wall){for(let attempt=0;attempt<30;attempt++){await item.page.evaluate(path=>window.yuvomi.navigate(path),'/tasks?view='+view);if(new URL(item.page.url()).pathname==='/tasks')break;await wait(50);}}
      await item.page.waitForSelector('article[data-task-id="'+roots[0].root+'"]');for(const row of roots){const selector='[data-action="toggle-subtasks"][data-id="'+row.root+'"]';if(await item.page.$eval(selector,node=>node.getAttribute('aria-expanded')!=='true'))await item.page.$eval(selector,node=>node.click());}
    }
    await board(one,'list');await board(two,'kanban');await board(wall,'list');
    report.paired_principal=await wall.page.evaluate(async()=>{const {auth}=await import('/api.js');return (await auth.me()).principal.kind;});
    check(report.paired_principal==='device','paired display must not impersonate a member');
    report.protected_actions=[];
    for(const id of [supervisedAction,helper,supervisedRoot]){
      const current=d.prepare('SELECT revision,parent_task_id FROM tasks WHERE id=?').get(id),body={status:'done',complete_remaining:true,expected_revision:current.revision,...(current.parent_task_id?{expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(current.parent_task_id).revision}:{})};
      const outcome=await wall.page.evaluate(async({id,body})=>{const{api}=await import('/api.js');try{await api.patch('/tasks/'+id+'/status',body);return 200;}catch(error){return error.status;}},{id,body});
      report.protected_actions.push({id,status:outcome});check(outcome===403,'device rejects supervised/helper/bulk action '+id);
    }
    check(status(expiredId)==='expired','background expiration ran');check(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(expiredId).n===0,'expiration awards zero');
    const started=Date.now();
    // Actual concurrent browser requests: each wave starts one independent write
    // in all three live clients before awaiting any of their acknowledgements.
    async function wave(index){
      const items=[wall,one,two];
      await Promise.all(items.map(async(item,n)=>{
        const selector=step(roots[n].children[index]);
        await item.page.waitForSelector(selector);
        const feedback=await item.page.$eval(selector,button=>new Promise(resolve=>{const at=performance.now();button.click();button.click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({ms:performance.now()-at,pressed:button.getAttribute('aria-pressed'),busy:button.getAttribute('aria-busy')})));}));
        item.metric.frame_feedback_ms.push(feedback.ms);check(feedback.pressed==='true','provisional checkbox '+n+'/'+index);
      }));
      report.concurrent_waves++;
      await Promise.all(items.map((item,n)=>item.page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-busy')==='false',{},step(roots[n].children[index]))));
      for(const root of roots)check(status(root.children[index])==='done','committed checkbox '+root.root+'/'+index);
    }
    async function faultRead(statusCode){
      let injected=0;await wall.page.setRequestInterception(true);
      const handler=request=>{const path=new URL(request.url()).pathname;if(request.method()==='GET'&&['/api/v1/tasks','/api/v1/automation/obligations','/api/v1/auth/me'].includes(path)){injected++;request.respond({status:statusCode,headers:statusCode===429?{'Retry-After':'3'}:{},contentType:'text/html',body:'<html>Temporary test upstream failure</html>'}).catch(()=>{});}else request.continue().catch(()=>{});};
      wall.page.on('request',handler);await wall.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await wait(1800);
      check(await wall.page.$('article[data-task-id="'+roots[0].root+'"]')!==null,'board retained through '+statusCode);
      check(!new URL(wall.page.url()).pathname.startsWith('/login'),'proxy failure is not authentication expiry '+statusCode);
      wall.page.off('request',handler);await wall.page.setRequestInterception(false);await wall.page.evaluate(()=>window.dispatchEvent(new Event('online')));await wait(4500);
      report.faults.push({kind:'HTTP '+statusCode,injected_requests:injected});
    }
    await wave(0);await faultRead(502);await wave(1);await faultRead(429);await wave(2);
    // Browser-local offline conditions interrupt this client's current SSE and
    // requests, without disrupting either other client or production networking.
    await wall.page.setOfflineMode(true);await wait(2500);check(await wall.page.$('article[data-task-id="'+roots[0].root+'"]')!==null,'board retained offline');await wall.page.setOfflineMode(false);await wall.page.evaluate(()=>window.dispatchEvent(new Event('online')));await wait(4500);report.faults.push({kind:'offline/SSE interruption',duration_ms:2500});
    // Abort only the RESPONSE, after the real backend has committed the write.
    const uncertainId=roots[0].children[3];let interrupted=0;
    await wall.cdp.send('Fetch.enable',{patterns:[{urlPattern:'*/api/v1/tasks/'+uncertainId+'/status',requestStage:'Response'}]});
    const interruption=async event=>{interrupted++;await wall.cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'ConnectionClosed'});};wall.cdp.on('Fetch.requestPaused',interruption);
    await wall.page.$eval(step(uncertainId),node=>node.click());await wait(4500);await wall.cdp.send('Fetch.disable');wall.cdp.off('Fetch.requestPaused',interruption);
    check(interrupted===1,'interrupted response must not retransmit mutation');check(status(uncertainId)==='done','uncertain response actually committed');
    await wall.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await wall.page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('aria-pressed')==='true',{},step(uncertainId));
    report.faults.push({kind:'post-commit interrupted response',interrupted_responses:interrupted});
    // Complete the corresponding personal actions concurrently before continuing.
    await Promise.all([one,two].map((item,n)=>item.page.$eval(step(roots[n+1].children[3]),node=>node.click())));
    for(let index=4;index<steps;index++){
      const target=started+duration*1000*(index-3)/(steps-3);while(Date.now()<target){await wait(Math.min(10000,target-Date.now()));samples.push({elapsed_ms:Date.now()-started,memory:process.memoryUsage().rss});}
      await wave(index);report.cycles++;
      if(index===6){await wall.page.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('focus'));});report.faults.push({kind:'sleep/resume lifecycle events'});}
      console.log('RELIABILITY_SOAK_PROGRESS',JSON.stringify({elapsed_seconds:Math.round((Date.now()-started)/1000),wave:index}));
    }
    // Keep a real unsaved editor draft while another authenticated client
    // completes the protected action with its legitimate human authority.
    await one.page.click('#btn-new-task');await one.page.waitForSelector('#task-title');await one.page.type('#task-title','Unsaved reliability draft');
    const protectedCurrent=d.prepare('SELECT revision FROM tasks WHERE id=?').get(supervisedAction),protectedParent=d.prepare('SELECT revision FROM tasks WHERE id=?').get(supervisedRoot);
    const approved=await two.page.evaluate(async body=>{const{api}=await import('/api.js');return api.patch('/tasks/'+body.id+'/status',{status:'done',expected_revision:body.revision,expected_parent_revision:body.parent});},{id:supervisedAction,revision:protectedCurrent.revision,parent:protectedParent.revision});check(approved.data?.status==='done','authenticated qualified parent completes supervised action');
    await wait(2500);check(await one.page.$eval('#task-title',node=>node.value)==='Unsaved reliability draft','live update preserves unsaved draft');report.unsaved_draft_preserved=true;
    while(Date.now()-started<duration*1000){await wait(Math.min(10000,duration*1000-(Date.now()-started)));samples.push({elapsed_ms:Date.now()-started,memory:process.memoryUsage().rss});}
    await wait(3000);
    report.elapsed_seconds=(Date.now()-started)/1000;
    report.results=roots.map(row=>({task:row.root,status:status(row.root),done:d.prepare("SELECT COUNT(*) n FROM tasks WHERE parent_task_id=? AND status='done'").get(row.root).n,awards:d.prepare('SELECT COUNT(*) n FROM reward_task_awards WHERE task_id=?').get(row.root).n,points:d.prepare('SELECT COALESCE(SUM(delta),0) n FROM reward_ledger WHERE task_id=?').get(row.root).n}));
    for(const result of report.results){check(result.status==='done','parent completed '+result.task);check(result.awards===1&&result.points===2,'points once '+result.task);check(result.done===steps,'all required/optional steps complete '+result.task);}
    report.duplicate_completed_activity=d.prepare("SELECT COUNT(*) n FROM(SELECT action_task_id,COUNT(*) c FROM task_activity_events WHERE event_type='completed' GROUP BY action_task_id HAVING c>1)").get().n;check(report.duplicate_completed_activity===0,'Activity completion once');
    report.recurrence_successors=d.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(roots[0].root).n;check(report.recurrence_successors===1,'one recurring successor');
    report.expiration_events=d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'").get(expiredId).n;check(report.expiration_events===1,'one expiration event');
    report.rotation_periods=d.prepare('SELECT o.status,o.advanced FROM rotation_group_periods p JOIN rotation_occurrences o ON o.id=p.occurrence_id WHERE p.schedule_id=(SELECT id FROM rotation_group_schedules WHERE group_id=?)').all(rotation.id);
    if(duration>=600)check(report.rotation_periods.length===1&&report.rotation_periods[0].status==='finalized'&&report.rotation_periods[0].advanced===1,'shared scheduled boundary finalized and advanced once');
    const personalCookie=(await one.page.cookies()).find(cookie=>cookie.name==='connect.sid'||cookie.name==='yuvomi.sid');
    check(Boolean(personalCookie),'normal personal session cookie found');
    if(personalCookie){const sid=decodeURIComponent(personalCookie.value).replace(/^s:/,'').split('.')[0];d.prepare('DELETE FROM sessions WHERE sid=?').run(sid);await one.page.evaluate(async()=>{const{api}=await import('/api.js');try{await api.get('/auth/me');}catch{}});await one.page.waitForSelector('#username');report.genuine_session_expiry='login displayed; prior Task content removed';check(await one.page.$('article[data-task-id]')===null,'expired personal content cleared');}
    report.integrity=d.pragma('integrity_check',{simple:true});report.foreign_keys=d.pragma('foreign_key_check').length;
    check(report.integrity==='ok'&&report.foreign_keys===0,'database integrity');
    report.unexpected_rate_limits=report.clients.reduce((total,metric)=>total+(metric.statuses[429]||0),0)-report.faults.filter(fault=>fault.kind==='HTTP 429').reduce((total,fault)=>total+fault.injected_requests,0);
    check(report.unexpected_rate_limits===0,'no unplanned global rate-limit responses');
    for(const metric of report.clients)check(metric.page_errors.length===0,'uncaught browser error '+metric.name);
    report.memory_samples=samples;
  }catch(error){report.failures.push(error.stack);report.server_output=output;report.browser_failure_context=await Promise.all(pages.map(async page=>({url:page.url(),body:await page.$eval('body',node=>node.innerText.slice(0,1500)).catch(()=>''),scripts:await page.evaluate(()=>[...document.scripts].map(script=>script.src)).catch(()=>[])})));}
  finally{
    await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}
    d.close();for(const suffix of ['','-wal','-shm'])try{unlinkSync(join(folder,'test.db'+suffix));}catch{}try{rmdirSync(folder);}catch{}
    const directory=resolve('.qa/reliability-20260928');mkdirSync(directory,{recursive:true});
    const label=process.env.RELIABILITY_SOAK_LABEL||'candidate';writeFileSync(join(directory,'soak-'+label+'.json'),JSON.stringify(report,null,2));
    console.log('RELIABILITY_SOAK_RESULT',JSON.stringify({duration:report.elapsed_seconds,kind:report.kind,concurrent_waves:report.concurrent_waves,failures:report.failures,clients:report.clients.map(({name,requests,statuses,failed_requests,task_reads,auth_reads,sse_connections})=>({name,requests,statuses,failed_requests,task_reads,auth_reads,sse_connections}))}));
  }
  assert.deepEqual(report.failures,[]);
});
