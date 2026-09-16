import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {Worker} from 'node:worker_threads';
process.env.DB_PATH=':memory:';process.env.TZ='UTC';process.env.SESSION_SECRET='recurrence-frontier-test';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {reconcileTaskRecurrence}=await import('../server/routes/tasks.js');
const {backfillRecurrenceProvenance,registerRecurrenceOccurrence,registerRecurrenceAction,recurrenceFrontier,retireRecurrenceOccurrences,releaseCorrectedRetiredAwards}=await import('../server/services/task-recurrence-frontier.js');
const {awardForCompletion,getBalance,createPointAdjustment}=await import('../server/services/rewards.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision,inspectTaskSupervision}=await import('../server/services/task-supervision.js');
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {recordCompletion,seriesRootOf,seriesHistory}=await import('../server/services/task-completions.js');
let d,actor,directory,path;
test.beforeEach(t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-15T12:00:00Z')});
  directory=mkdtempSync(join(tmpdir(),'vidamia-frontier-'));path=join(directory,'fixture.db');
  d=new Database(path);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');d.pragma('busy_timeout=15000');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
  _setTestDatabase(d);
  actor=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('Grace','Grace','x','admin')").run().lastInsertRowid);
});
test.afterEach(()=>{_setTestDatabase(null);d?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});});
function chain({lastStatus='open'}={}) {
  let previous=null;
  for(const [id,date] of [[81,'2026-09-12'],[121,'2026-09-18'],[130,'2026-09-25'],[139,'2026-10-02']]) {
    d.prepare(`INSERT INTO tasks(id,title,created_by,assigned_to,status,points,start_date,due_date,is_recurring,recurrence_rule,recurrence_origin_id)
      VALUES(?,'Laundry',?,?,?,5,?,?,1,'FREQ=WEEKLY;BYDAY=FR',?)`).run(id,actor,actor,id===139?lastStatus:'done',date,date,previous);
    d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,actor);
    if(id!==139)d.prepare('INSERT INTO task_completions(task_id,series_id,user_id) VALUES(?,81,?)').run(id,actor);
    previous=id;
  }
  backfillRecurrenceProvenance(d);
}
function active(){return d.prepare("SELECT o.task_id,t.due_date,t.status,o.generation FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.series_id=81 AND o.state='materialized' ORDER BY generation").all();}
function remove(id){d.prepare('DELETE FROM tasks WHERE id=?').run(id);}

test('latest deletion permits exactly one replacement on the same Friday',()=>{
  chain();remove(139);assert.equal(recurrenceFrontier(d,81).id,130);
  const result=reconcileTaskRecurrence(81);assert.equal(result.generated_task_ids.length,1);
  const next=d.prepare('SELECT * FROM tasks WHERE id=?').get(result.frontier_task_id);
  assert.equal(next.due_date,'2026-10-02');assert.equal(next.start_date,'2026-10-02');assert.equal(next.recurrence_origin_id,130);
  assert.equal(reconcileTaskRecurrence(81).generated_task_ids.length,0);
  assert.equal(active().filter(row=>row.due_date==='2026-10-02').length,1);
});
test('deleting older middle occurrence never fills its hole while later work survives',()=>{
  chain();remove(121);assert.equal(d.prepare('SELECT recurrence_origin_id FROM tasks WHERE id=130').get().recurrence_origin_id,null);
  assert.equal(recurrenceFrontier(d,81).id,139);assert.deepEqual(reconcileTaskRecurrence(81).generated_task_ids,[]);
  assert.equal(active().some(row=>row.due_date==='2026-09-18'),false);
  changeTaskStatus(d,81,'in_progress',{actorId:actor,authorize:false,requireRevision:false});
  changeTaskStatus(d,81,'done',{actorId:actor,authorize:false,requireRevision:false});
  assert.equal(active().some(row=>row.due_date==='2026-09-18'),false);
});
test('deleting backward to the legitimate occurrence restores Sep18 without shifting the Friday anchor',()=>{
  chain();for(const id of [139,130,121])remove(id);
  assert.equal(recurrenceFrontier(d,81).id,81);const result=reconcileTaskRecurrence(81);
  assert.equal(result.generated_task_ids.length,1);assert.equal(d.prepare('SELECT due_date FROM tasks WHERE id=?').get(result.frontier_task_id).due_date,'2026-09-18');
});
test('archived open or completed occurrences remain materialized and prevent older regeneration',()=>{
  chain();d.prepare("UPDATE tasks SET archived_at='2026-09-15T00:00:00Z' WHERE id=139").run();
  assert.equal(recurrenceFrontier(d,81).id,139);assert.deepEqual(reconcileTaskRecurrence(81).generated_task_ids,[]);
  d.prepare("UPDATE tasks SET status='done' WHERE id=139").run();
  const result=reconcileTaskRecurrence(81);assert.equal(d.prepare('SELECT due_date FROM tasks WHERE id=?').get(result.frontier_task_id).due_date,'2026-10-09');
});
test('deleting root preserves surviving identity and completion history; deleting last survivor does not invent a template',()=>{
  chain();remove(81);assert.equal(recurrenceFrontier(d,81).id,139);assert.equal(seriesRootOf(d,130),81);
  assert.deepEqual(seriesHistory(d,{me:actor,taskId:139}).map(row=>row.task_id).sort((a,b)=>a-b),[121,130]);
  for(const id of [121,130,139])remove(id);
  assert.deepEqual(reconcileTaskRecurrence(81),{frontier_task_id:null,generated_task_ids:[]});
});
test('explicit retirement preserves history/progress/ledger and creates one fresh Sep18 occurrence',()=>{
  chain();d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(actor);
  for(const id of [81,121,130])d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id,reason,created_by) VALUES(?,5,'earn',?,'Laundry',?)").run(actor,id,actor);
  d.prepare("INSERT INTO task_comments(task_id,user_id,comment) VALUES(121,?,'Preserve this discussion')").run(actor);
  const document=Number(d.prepare("INSERT INTO family_documents(name,original_name,mime_type,file_size,content_data,created_by) VALUES('Instructions','instructions.txt','text/plain',4,'a2VlcA==',?)").run(actor).lastInsertRowid);
  d.prepare('INSERT INTO task_documents(task_id,document_id,created_by) VALUES(121,?,?)').run(document,actor);
  const child=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,status,created_by) VALUES('Completed washer action',121,'done',?)").run(actor).lastInsertRowid);
  const helper=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,status,created_by) VALUES('Supervise Laundry',NULL,'done',?)").run(actor).lastInsertRowid);
  d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(121,?,'supervisor')").run(helper);
  d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(121,?,?, 'completed','{\"original\":true}')").run(child,actor);
  const ledger=d.prepare('SELECT * FROM reward_ledger').all(),completions=d.prepare('SELECT * FROM task_completions').all(),comments=d.prepare('SELECT * FROM task_comments').all(),documents=d.prepare('SELECT * FROM task_documents').all();
  assert.deepEqual(retireRecurrenceOccurrences(d,[121,130,139],{actorId:actor,reason:'Future occurrences completed before their start dates'}),[121,130,139]);
  assert.deepEqual(retireRecurrenceOccurrences(d,[121,130,139],{actorId:actor,reason:'Same repair retry'}),[]);
  assert.deepEqual(d.prepare('SELECT * FROM reward_ledger').all(),ledger);assert.deepEqual(d.prepare('SELECT * FROM task_completions').all(),completions);assert.deepEqual(d.prepare('SELECT * FROM task_comments').all(),comments);
  assert.deepEqual(d.prepare('SELECT * FROM task_documents').all(),documents);assert.ok(d.prepare('SELECT * FROM family_documents WHERE id=?').get(document));
  for(const id of [121,130,139,child,helper])assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(id).archived_at);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'done');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE event_type='recurrence_retired'").get().n,3);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE event_type='completed'").get().n,1);
  assert.match(d.prepare("SELECT details_json FROM task_activity_events WHERE event_type='recurrence_retired' LIMIT 1").get().details_json,/Occurrence retired: Future occurrences/);
  for(const id of [121,139,child,helper])assert.throws(()=>changeTaskStatus(d,id,'open',{actorId:actor,authorize:false,requireRevision:false,body:{reset_progress:true}}),/historical occurrence was retired/);
  const result=reconcileTaskRecurrence(81),next=d.prepare('SELECT * FROM tasks WHERE id=?').get(result.frontier_task_id);
  assert.equal(next.due_date,'2026-09-18');assert.equal(next.status,'open');assert.equal(next.assigned_to,actor);assert.equal(next.points,5);
  assert.equal(active().filter(row=>row.due_date==='2026-09-18').length,1);assert.equal(active().some(row=>row.due_date==='2026-09-25'),false);
  assert.throws(()=>changeTaskStatus(d,next.id,'done',{actorId:actor,authorize:false,requireRevision:false}),/starts on 2026-09-18/);
});
for(const viaChild of [false,true])test(`completion-relative same-date collision returns409 and rolls back ${viaChild?'final child and parent auto-completion':'parent completion'}, rewards and history`,()=>{
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(actor);
  const id=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,points,is_recurring,due_date,recurrence_rule,recurrence_from_completion) VALUES('Relative routine',?,?,5,1,'2026-09-22','FREQ=WEEKLY',1)").run(actor,actor).lastInsertRowid);
  const target=viaChild?Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by) VALUES('Final step',?,?)").run(id,actor).lastInsertRowid):id;
  registerRecurrenceOccurrence(d,id);
  const before=d.prepare('SELECT * FROM tasks ORDER BY id').all();
  const evidence=Object.fromEntries(['reward_ledger','reward_task_awards','task_completions','task_activity_events']
    .map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()]));
  assert.throws(()=>changeTaskStatus(d,target,'done',{actorId:actor,authorize:false,requireRevision:false}),error=>{
    assert.equal(error.status,409);assert.equal(error.details.reason,'recurrence_date_conflict');assert.match(error.message,/Complete this occurrence later/);return true;
  });
  assert.deepEqual(d.prepare('SELECT * FROM tasks ORDER BY id').all(),before);
  for(const [table,rows] of Object.entries(evidence))assert.deepEqual(d.prepare(`SELECT * FROM ${table}`).all(),rows,table);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_occurrences WHERE series_id=?').get(id).n,1);
  // Existing historical done rows reconcile as an explained no-op.
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);
  const result=reconcileTaskRecurrence(id);assert.deepEqual(result.generated_task_ids,[]);assert.equal(result.reason,'recurrence_date_conflict');
});
test('disabled latest routine is a materialized frontier and never revives from an older enabled occurrence',()=>{
  chain();d.prepare("UPDATE tasks SET is_recurring=0,status='done' WHERE id=139").run();
  assert.equal(recurrenceFrontier(d,81).id,139);assert.deepEqual(reconcileTaskRecurrence(81).generated_task_ids,[]);
});
test('database rejects a second materialized occurrence for the same proven series/date',()=>{
  chain();const duplicate=Number(d.prepare("INSERT INTO tasks(title,created_by,is_recurring,due_date) VALUES('Other title',?,1,'2026-09-18')").run(actor).lastInsertRowid);
  assert.throws(()=>registerRecurrenceOccurrence(d,duplicate,{predecessorId:81}),/UNIQUE/);
});
test('legacy duplicate keys and branching provenance are flagged rather than silently merged',()=>{
  chain();d.prepare('DELETE FROM task_recurrence_occurrences').run();
  d.prepare('UPDATE tasks SET recurrence_origin_id=81 WHERE id=130').run();
  assert.throws(()=>backfillRecurrenceProvenance(d),/ambiguous branches/);
  d.prepare('UPDATE tasks SET recurrence_origin_id=121,due_date=? WHERE id=130').run('2026-09-18');
  assert.throws(()=>d.transaction(()=>backfillRecurrenceProvenance(d))(),/ambiguous materialized occurrence/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_occurrences').get().n,0);
});
test('legacy frozen completion provenance bridges a previously deleted middle occurrence',()=>{
  chain();d.prepare('DELETE FROM task_recurrence_occurrences').run();remove(121);
  backfillRecurrenceProvenance(d);assert.equal(recurrenceFrontier(d,81).id,139);assert.equal(seriesRootOf(d,130),81);
  assert.deepEqual(reconcileTaskRecurrence(81).generated_task_ids,[]);
});
test('same titles without canonical linkage remain different series',()=>{
  chain();const independent=Number(d.prepare("INSERT INTO tasks(title,created_by,is_recurring,due_date,recurrence_rule) VALUES('Laundry',?,1,'2026-09-18','FREQ=WEEKLY;BYDAY=FR')").run(actor).lastInsertRowid);
  registerRecurrenceOccurrence(d,independent);assert.equal(recurrenceFrontier(d,independent).id,independent);assert.equal(recurrenceFrontier(d,81).id,139);
});
test('independent database connections serialize deletion and reconciliation without duplicate occurrence keys',async()=>{
  chain();
  const run=mode=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./task-recurrence-frontier-worker.mjs',import.meta.url),{workerData:{path,mode}});
    worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error(`Worker failed: ${code}`));});
  });
  await Promise.all(['reconcile','delete','reconcile','reconcile'].map(run));
  reconcileTaskRecurrence(81);
  assert.equal(active().filter(row=>row.due_date==='2026-10-02').length,1);
  assert.deepEqual(d.prepare("SELECT series_id,occurrence_key,COUNT(*) n FROM task_recurrence_occurrences WHERE state='materialized' GROUP BY series_id,occurrence_key HAVING n>1").all(),[]);
  assert.deepEqual(reconcileTaskRecurrence(81).generated_task_ids,[]);
});

for(const mode of ['parent','independent child','delegated child'])test(`delete and regenerate awarded occurrence cannot award ${mode} points again`,t=>{
  chain();t.mock.timers.setTime(Date.parse('2026-09-28T12:00:00Z'));
  d.prepare("UPDATE tasks SET start_date=date(due_date,'-7 days') WHERE parent_task_id IS NULL").run();
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(actor);
  let helper=null,originalAction=139;
  if(mode!=='parent') {
    const previous=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,points,status) VALUES('Wash',130,?,2,'done')").run(actor).lastInsertRowid);
    originalAction=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,assigned_to,points,recurrence_origin_id) VALUES('Wash',139,?,?,2,?)").run(actor,actor,previous).lastInsertRowid);
    registerRecurrenceAction(d,previous);registerRecurrenceAction(d,originalAction);
    if(mode==='delegated child') {
      helper=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('Helper','Helper','x','member')").run().lastInsertRowid);
      d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(helper);
      const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washer',0,'normal',?)").run(actor).lastInsertRowid);
      for(const [id,proficiency] of [[actor,'excluded'],[helper,'normal']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,?,'manual')").run(id,skill,proficiency);
      setTaskSkills(d,previous,[skill]);setTaskSkills(d,originalAction,[skill]);
      reconcileTaskSupervision(d,139,{supervisorUserId:helper});
    }
  }
  changeTaskStatus(d,originalAction,'done',{actorId:helper||actor,authorize:false,requireRevision:false});
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=139').get().status,'done');
  const firstBalance=getBalance(d,actor),helperBalance=helper?getBalance(d,helper):null;
  assert.equal(firstBalance,mode==='independent child'?7:5);if(helper)assert.equal(helperBalance,2);
  const receipt=d.prepare('SELECT * FROM reward_task_awards WHERE task_id=139').get();assert.ok(receipt.logical_key);
  const generated=recurrenceFrontier(d,81).id;assert.notEqual(generated,139);remove(generated);remove(139);
  assert.deepEqual(d.prepare('SELECT * FROM reward_task_awards WHERE task_id=139').get(),receipt,'award receipt survives physical deletion');
  const replacement=reconcileTaskRecurrence(81).frontier_task_id;
  const next=d.prepare('SELECT * FROM tasks WHERE id=?').get(replacement);assert.equal(next.due_date,'2026-10-02');assert.equal(next.start_date,'2026-09-25');
  const nextAction=mode==='parent'?replacement:Number(d.prepare('SELECT id FROM tasks WHERE parent_task_id=? AND title=?').get(replacement,'Wash').id);
  if(helper)assert.equal(inspectTaskSupervision(d,replacement).actions.find(row=>row.action_task_id===nextAction).supervisor_user_id,helper);
  changeTaskStatus(d,nextAction,'done',{actorId:helper||actor,authorize:false,requireRevision:false});
  assert.equal(getBalance(d,actor),firstBalance);if(helper)assert.equal(getBalance(d,helper),helperBalance);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn'").get().n,mode==='parent'?1:2);
  assert.equal(awardForCompletion(d,replacement,actor),false);
});

test('retirement alone does not release awards; fully linked correction permits exactly one legitimate replacement award',t=>{
  chain();d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(actor);
  for(const id of [81,121,130])assert.equal(awardForCompletion(d,id,actor),true);
  const originals=d.prepare("SELECT * FROM reward_ledger WHERE type='earn'").all();assert.equal(getBalance(d,actor),15);
  retireRecurrenceOccurrences(d,[121,130,139],{actorId:actor,reason:'Confirmed mistaken future completion'});
  assert.throws(()=>releaseCorrectedRetiredAwards(d,[121,130,139],{actorId:actor,reason:'Correction'}),/fully offset/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards WHERE retired_at IS NOT NULL').get().n,0);
  for(const row of originals.filter(row=>row.task_id!==81))createPointAdjustment(d,{actorId:actor,userId:actor,delta:-row.delta,
    reason:'Confirmed future-occurrence correction',taskId:row.task_id,ledgerId:row.id,requestKey:`correct-${row.id}`});
  assert.deepEqual(releaseCorrectedRetiredAwards(d,[121,130,139],{actorId:actor,reason:'Confirmed linked corrections'}),[121,130]);
  assert.deepEqual(releaseCorrectedRetiredAwards(d,[121,130,139],{actorId:actor,reason:'Replay'}),[]);
  assert.deepEqual(d.prepare("SELECT * FROM reward_ledger WHERE type='earn'").all(),originals);
  assert.equal(getBalance(d,actor),5);const replacement=reconcileTaskRecurrence(81).frontier_task_id;
  t.mock.timers.setTime(Date.parse('2026-09-18T12:00:00Z'));
  changeTaskStatus(d,replacement,'done',{actorId:actor,authorize:false,requireRevision:false});
  assert.equal(getBalance(d,actor),10);assert.equal(awardForCompletion(d,replacement,actor),false);assert.equal(awardForCompletion(d,121,actor),false);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards WHERE retired_at IS NOT NULL').get().n,2);
});
