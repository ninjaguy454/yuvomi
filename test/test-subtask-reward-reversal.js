import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import Database from 'better-sqlite3-multiple-ciphers';
import {fork} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';

const balance=(f,id=2)=>f.d.prepare('SELECT COALESCE(SUM(delta),0) n FROM reward_ledger WHERE user_id=?').get(id).n;
const ledger=(f,id)=>f.d.prepare('SELECT * FROM reward_ledger WHERE task_id=? ORDER BY id').all(id);
async function routine(f,extra={}){
  const result=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Awarded step',points:7},{title:'Remaining step',points:0}],...extra});
  assert.equal(result.status,201,JSON.stringify(result));return {root:result.data.id,child:result.data.subtasks[0].id,children:result.data.subtasks};
}
const reopen=(f,id,status='open',body={})=>f.call('PATCH',`/tasks/${id}/status`,{status,...body});

test('real status endpoint removes an incomplete subtask completion award',async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Awarded step',points:7},{title:'Remaining step',points:0}]});
  assert.equal(created.status,201);
  const child=created.data.subtasks[0].id;
  assert.equal((await f.finish(child)).status,200);
  assert.equal(balance(f),7);
  const original=f.d.prepare("SELECT * FROM reward_ledger WHERE type='earn' AND task_id=?").all(child);
  const reopened=await f.call('PATCH',`/tasks/${child}/status`,{status:'open'});
  assert.equal(reopened.status,200);
  assert.equal(f.row(child).status,'open');
  assert.equal(balance(f),0,'An incomplete step must have no active completion award');
  assert.deepEqual(f.d.prepare("SELECT * FROM reward_ledger WHERE type='earn' AND task_id=?").all(child),original,'Original earning history remains intact');
});

for(const status of ['open','in_progress'])test(`${status}: repeated transitions restore one frozen award without stacking`,async t=>{
  const f=await scoringFixture(t),{child}=await routine(f);await f.finish(child);
  const original=ledger(f,child),settlements=JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_settlements').all());
  for(let cycle=0;cycle<3;cycle++){
    assert.equal((await reopen(f,child,status)).status,200);assert.equal(balance(f),0);
    const count=ledger(f,child).length;assert.equal((await reopen(f,child,status)).status,200);assert.equal(ledger(f,child).length,count);
    assert.equal((await f.finish(child)).status,200);assert.equal(balance(f),7);
    const doneCount=ledger(f,child).length;assert.equal((await f.finish(child)).status,200);assert.equal(ledger(f,child).length,doneCount);
  }
  assert.deepEqual(ledger(f,child).filter(row=>row.type==='earn'),original);
  assert.deepEqual(ledger(f,child).map(row=>row.delta),[7,-7,7,-7,7,-7,7]);
  assert.equal(JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_settlements').all()),settlements);
  const events=f.d.prepare('SELECT * FROM task_scoring_completion_events ORDER BY sequence').all();
  assert.deepEqual(events.map(row=>row.active),[0,1,0,1,0,1]);
  for(const event of events)for(const link of JSON.parse(event.entries_json)){
    assert.equal(f.d.prepare('SELECT delta FROM reward_ledger WHERE id=?').get(link.ledger_id).delta,link.delta);
    assert.equal(link.earn_ledger_id,original[0].id);
  }
  assert.throws(()=>f.d.prepare('DELETE FROM task_scoring_completion_events').run(),/immutable/);
  assert.throws(()=>f.d.prepare('UPDATE task_scoring_completion_events SET active=0').run(),/immutable/);
});

test('reassignment, unenrollment and point drift cannot redirect a restored award',async t=>{
  const f=await scoringFixture(t),{child}=await routine(f);await f.finish(child);
  assert.equal((await reopen(f,child)).status,200);assert.equal(balance(f),0);
  assert.equal((await f.edit(child,{assigned_to:[3]})).status,200);
  f.d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=2').run();
  f.d.prepare('UPDATE tasks SET points=99 WHERE id=?').run(child);
  assert.equal((await f.finish(child)).status,200);assert.equal(balance(f,2),7);assert.equal(balance(f,3),0);
  assert.deepEqual(ledger(f,child).map(({user_id,delta})=>({user_id,delta})),[{user_id:2,delta:7},{user_id:2,delta:-7},{user_id:2,delta:7}]);
});

test('multiple recipients reverse and restore independently of manual linked corrections',async t=>{
  const f=await scoringFixture(t),{child}=await routine(f,{assigned_to:[2,3]});await f.finish(child);
  const {createPointAdjustment}=await import('../server/services/rewards.js');
  const original=ledger(f,child);for(const [i,row] of original.entries())createPointAdjustment(f.d,{actorId:1,userId:row.user_id,delta:i?-7:-2,reason:'Synthetic independent correction',taskId:child,ledgerId:row.id,requestKey:'subtask-manual-'+i});
  const adjustments=JSON.stringify(f.d.prepare('SELECT * FROM reward_adjustment_requests').all());
  const manual=ledger(f,child).filter(row=>row.type==='adjust');
  assert.equal((await reopen(f,child)).status,200);assert.equal(balance(f,2),-2);assert.equal(balance(f,3),-7);
  assert.equal((await f.finish(child)).status,200);assert.equal(balance(f,2),5);assert.equal(balance(f,3),0);
  assert.equal(JSON.stringify(f.d.prepare('SELECT * FROM reward_adjustment_requests').all()),adjustments);
  assert.deepEqual(ledger(f,child).filter(row=>manual.some(item=>item.id===row.id)),manual);
});

test('parent bulk completion and reset compensate all payable children but retain parent policy',async t=>{
  const f=await scoringFixture(t),{root,children}=await routine(f,{subtasks:[{title:'A',points:3},{title:'B',points:5}]});
  assert.equal((await f.finish(root)).status,200);assert.equal(balance(f),8);assert.equal(f.row(root).status,'done');
  assert.equal((await reopen(f,root,'open',{reset_progress:true})).status,200);assert.equal(balance(f),0);
  assert.ok(children.every(child=>f.row(child.id).status==='open'));
  assert.equal((await f.finish(root)).status,200);assert.equal(balance(f),8);
  assert.equal((await reopen(f,children[0].id)).status,200);assert.equal(f.row(root).status,'in_progress');assert.equal(balance(f),5);
});

test('whole-task parent awards retain their existing lifetime policy and suppressed children append nothing',async t=>{
  const f=await scoringFixture(t),{root,child}=await routine(f,{scoring_mode:'whole_task',points:11});
  await f.finish(root);assert.equal(balance(f),11);assert.equal((await reopen(f,child)).status,200);
  assert.equal(f.row(root).status,'in_progress');assert.equal(balance(f),11);assert.equal(ledger(f,child).length,0);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_scoring_completion_events').get().n,0);
});

test('zero and no-recipient settlements do not turn into new awards on later cycles',async t=>{
  const f=await scoringFixture(t);for(const body of [{assigned_to:[2],subtasks:[{title:'Zero',points:0},{title:'Remain'}]},{assigned_to:[],subtasks:[{title:'No recipient',points:7},{title:'Remain'}]}]){
    const {child}=await routine(f,body);await f.finish(child);assert.equal((await reopen(f,child)).status,200);
    assert.equal((await f.edit(child,{assigned_to:[2]})).status,200);await f.finish(child);assert.equal(ledger(f,child).length,0);
  }
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_scoring_completion_events').get().n,0);
});

test('stale and simultaneous HTTP requests cannot apply a second compensation',async t=>{
  const f=await scoringFixture(t),{child}=await routine(f);await f.finish(child);
  const body={...f.revisions(child),status:'open'};
  const results=await Promise.all([f.call('PATCH',`/tasks/${child}/status`,body),f.call('PATCH',`/tasks/${child}/status`,body)]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);assert.equal(balance(f),0);assert.equal(ledger(f,child).length,2);
  assert.equal((await f.call('PATCH',`/tasks/${child}/status`,body)).status,409);assert.equal(ledger(f,child).length,2);
  await f.finish(child);assert.equal(balance(f),7);assert.equal(ledger(f,child).length,3);
});

test('unauthorized requests and rolled-back multi-recipient writes change neither progress nor rewards',async t=>{
  const f=await scoringFixture(t),{child}=await routine(f,{assigned_to:[2,3]});await f.finish(child);
  f.grant('complete_own','none');f.grant('complete_others','none');const before=f.snapshot();assert.equal((await f.call('PATCH',`/tasks/${child}/status`,{status:'open'},2)).status,403);assert.equal(f.snapshot(),before);
  f.d.exec(`CREATE TRIGGER synthetic_compensation_failure BEFORE INSERT ON reward_ledger WHEN NEW.type='adjust' AND NEW.user_id=3 BEGIN SELECT RAISE(ABORT,'synthetic compensation failure'); END`);
  const guarded=f.snapshot();assert.equal((await reopen(f,child)).status,500);assert.equal(f.snapshot(),guarded);assert.equal(f.row(child).status,'done');
  f.d.exec('DROP TRIGGER synthetic_compensation_failure');assert.equal((await reopen(f,child)).status,200);assert.equal(balance(f,2),0);assert.equal(balance(f,3),0);
});

test('device status uses original recipients and nullable actor without granting device points',async t=>{
  const f=await scoringFixture(t),{root,child}=await routine(f,{assigned_to:[2,3]});
  const {createDevice}=await import('../server/services/devices.js'),{deviceTaskStatus}=await import('../server/services/device-tasks.js');
  const principal={kind:'device',...createDevice(f.d,{name:'Synthetic reversal display'},1)};
  principal.permissions.capabilities['device_tasks.reopen']='allow';
  principal.permissions.capabilities['device_tasks.reset']='allow';
  deviceTaskStatus(f.d,principal,child,{...f.revisions(child),status:'done'});
  const before=f.revisions(child);deviceTaskStatus(f.d,principal,child,{...before,status:'open'});
  assert.equal(balance(f,2),0);assert.equal(balance(f,3),0);
  assert.throws(()=>deviceTaskStatus(f.d,principal,child,{...before,status:'open'}),error=>error.status===409);
  deviceTaskStatus(f.d,principal,child,{...f.revisions(child),status:'done'});
  assert.equal(balance(f,2),7);assert.equal(balance(f,3),7);
  assert.ok(ledger(f,child).every(row=>row.created_by===null));
  assert.ok(f.d.prepare('SELECT * FROM task_scoring_completion_events').all().every(row=>row.actor_user_id===null));
  assert.equal(f.row(root).status,'in_progress');
});

test('deleted recipient and deleted/recreated task identities cannot mint restored points',async t=>{
  const f=await scoringFixture(t),{root,child}=await routine(f,{assigned_to:[2,3]});await f.finish(child);await reopen(f,child);assert.equal(balance(f,2),0);
  f.d.prepare('DELETE FROM users WHERE id=3').run();await f.finish(child);assert.equal(balance(f,2),7);await reopen(f,child);assert.equal(balance(f,2),0);
  const history=JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_completion_events').all());
  f.d.prepare('DELETE FROM tasks WHERE id=?').run(child);
  f.d.prepare("INSERT INTO tasks(id,title,parent_task_id,created_by,points,scoring_mode) VALUES(?,'Replacement, not original',?,1,99,'subtasks')").run(child,root);
  f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(child);
  await f.finish(child);assert.equal(balance(f,2),0);
  assert.equal(JSON.stringify(f.d.prepare('SELECT * FROM task_scoring_completion_events').all()),history);
});

test('legacy payable children reverse while immutable historical scoring remains gross history',async t=>{
  const f=await scoringFixture(t),{root,child}=await routine(f);
  f.d.prepare("UPDATE tasks SET scoring_mode='legacy',scoring_review_required=0 WHERE id=?").run(root);
  f.d.prepare('INSERT OR IGNORE INTO task_assignments(task_id,user_id) VALUES(?,2)').run(child);
  await f.finish(child);const history=(await f.call('GET',`/tasks/${root}`)).data.scoring;
  assert.deepEqual(history.earned,[{user_id:2,points:7}]);await reopen(f,child);assert.equal(balance(f),0);
  const after=(await f.call('GET',`/tasks/${root}`)).data.scoring;
  assert.deepEqual(after.earned,history.earned);assert.deepEqual(after.settlements,history.settlements);assert.equal(after.mode_locked,true);
});

test('independent payable Activity beneath a Workflow reverses without paying its suppressed checklist',async t=>{
  const f=await scoringFixture(t),created=await f.create({points:0,scoring_mode:'whole_task'});assert.equal(created.status,201);const container=created.data.id;
  const add=(parent,points)=>Number(f.d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,points,scoring_mode,assigned_to) VALUES('Synthetic activity',?,1,?,'whole_task',2)").run(parent,points).lastInsertRowid);
  const activity=add(container,7),check=add(activity,3);f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(activity);
  const instance=Number(f.d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES(?,1)').run(container).lastInsertRowid);
  f.d.prepare('INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id) VALUES(?,?)').run(instance,activity);
  assert.equal((await f.finish(activity)).status,200);assert.equal(balance(f),7);assert.equal(ledger(f,check).length,0);
  assert.equal((await reopen(f,activity,'open',{reset_progress:true})).status,200);assert.equal(balance(f),0);
  await f.finish(activity);assert.equal(balance(f),7);
});

test('recurring instances have separate awards and redoing an earlier step cannot stack them',async t=>{
  const f=await scoringFixture(t),{root,child}=await routine(f,{is_recurring:1,start_date:'2026-11-01',due_date:'2026-11-01',recurrence_rule:'FREQ=DAILY'});
  assert.equal((await f.finish(root)).status,200);assert.equal(balance(f),7);
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root);assert.ok(next);
  t.mock.timers.tick(24*60*60*1000);
  assert.equal((await f.finish(next.id)).status,200);assert.equal(balance(f),14);
  assert.equal((await reopen(f,child)).status,200);assert.equal(balance(f),7);assert.equal(f.row(next.id).status,'done');
  await f.finish(child);assert.equal(balance(f),14);assert.equal(f.d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn'").get().n,2);
});

test('explicitly retired and fully corrected recurrence awards cannot be restored by a stale caller',async t=>{
  const f=await scoringFixture(t),{root,child}=await routine(f,{is_recurring:1,start_date:'2026-11-01',due_date:'2026-11-01',recurrence_rule:'FREQ=DAILY'});await f.finish(root);
  const {retireRecurrenceOccurrences,releaseCorrectedRetiredAwards}=await import('../server/services/task-recurrence-frontier.js');
  const {createPointAdjustment,awardForCompletion,syncTaskRewards}=await import('../server/services/rewards.js');
  const earn=ledger(f,child)[0];retireRecurrenceOccurrences(f.d,[root],{actorId:1,reason:'Synthetic explicit correction'});
  createPointAdjustment(f.d,{actorId:1,userId:2,delta:-7,reason:'Synthetic full correction',taskId:child,ledgerId:earn.id,requestKey:'subtask-retired-correction'});
  releaseCorrectedRetiredAwards(f.d,[root],{actorId:1,reason:'Synthetic full correction'});const snapshot=f.snapshot();
  assert.equal(awardForCompletion(f.d,child,2),false);syncTaskRewards(f.d,child,'done','open',2);syncTaskRewards(f.d,child,'open','done',2);
  assert.equal(f.snapshot(),snapshot);assert.equal(balance(f),0);
});

test('missing original earning evidence and stale direct callers never manufacture a replacement award',async t=>{
  const f=await scoringFixture(t),{child}=await routine(f);await f.finish(child);
  const {awardForCompletion,syncTaskRewards}=await import('../server/services/rewards.js');
  await reopen(f,child);assert.equal(balance(f),0);const before=f.snapshot();
  assert.equal(awardForCompletion(f.d,child,2),false);syncTaskRewards(f.d,child,'open','done',2);assert.equal(f.snapshot(),before);
  await f.finish(child);assert.equal(balance(f),7);
  f.d.prepare("DELETE FROM reward_ledger WHERE task_id=? AND type='earn'").run(child);
  await reopen(f,child);const noEvidence=JSON.stringify({ledger:ledger(f,child),events:f.d.prepare('SELECT * FROM task_scoring_completion_events').all()});await f.finish(child);assert.equal(balance(f),0);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_scoring_completion_events').get().n,2);
  assert.equal(f.d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn' AND task_id=?").get(child).n,0);
  assert.equal(JSON.stringify({ledger:ledger(f,child),events:f.d.prepare('SELECT * FROM task_scoring_completion_events').all()}),noEvidence);
});

test('two real SQLite processes serialize concurrent uncheck and recompletion requests',async t=>{
  const f=await scoringFixture(t),{child}=await routine(f);await f.finish(child);
  const directory=mkdtempSync(join(tmpdir(),'vidamia-subtask-race-')),file=join(directory,'synthetic.db'),workers=[];let d;
  t.after(async()=>{await Promise.all(workers.map(worker=>new Promise(resolveExit=>{if(worker.exitCode!==null||worker.signalCode!==null)return resolveExit();worker.once('exit',resolveExit);worker.kill();})));d?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});});
  await f.d.backup(file);d=new Database(file);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');d.pragma('busy_timeout=10000');
  for(let i=0;i<2;i++){
    const worker=fork(new URL('./helpers/subtask-reward-race-worker.mjs',import.meta.url),[],{env:{...process.env,SUBTASK_REWARD_FIXTURE:file},stdio:['ignore','ignore','ignore','ipc']});workers.push(worker);
    await new Promise((resolveReady,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic worker startup timeout')),15000);worker.once('error',reject);worker.once('exit',code=>reject(Error('Synthetic worker exited '+code)));worker.once('message',message=>{clearTimeout(timer);message.ready?resolveReady():reject(Error('Synthetic worker startup failed'));});});
  }
  const run=(worker,message)=>new Promise((resolveReply,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic transition timeout')),15000);worker.once('message',value=>{clearTimeout(timer);resolveReply(value);});worker.send(message);});
  const current=()=>{const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(child),parent=d.prepare('SELECT revision FROM tasks WHERE id=?').get(task.parent_task_id);return {expected_revision:task.revision,expected_parent_revision:parent.revision};};
  for(const [status,expected] of [['open',0],['done',7],['open',0],['done',7]]){
    const message={id:child,status,body:{...current(),status}},results=await Promise.all(workers.map(worker=>run(worker,message)));
    assert.deepEqual(results.map(row=>row.status).sort(),[200,409],JSON.stringify(results));
    assert.equal(d.prepare('SELECT SUM(delta) n FROM reward_ledger WHERE user_id=2').get().n,expected);
  }
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn'").get().n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_completion_events').get().n,4);
  assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
});
