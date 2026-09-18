import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='series-generation-test';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {reconcileTaskRecurrence}=await import('../server/routes/tasks.js');
const {changeTaskStatus,expireTask}=await import('../server/services/task-lifecycle.js');
const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');
const {ensureSeriesDefinition,captureSeriesDefinition,appendSeriesDefinition,seriesDefinitionForGeneration,
  recordOccurrenceDefinition,taskSeriesState,definitionEqual}=await import('../server/services/task-series.js');
let d;
test.beforeEach(()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();
    if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'learner','Learner','x','member')");
  d.exec("INSERT INTO reward_participants(user_id,enabled) VALUES(2,1)");
  d.exec("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')");
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const children=id=>d.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY sort_order,id').all(id);
const next=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
function seed({start='2026-10-26',due='2026-10-30',offset=4,rule='FREQ=WEEKLY;BYDAY=MO',expiration='keep_overdue'}={}){
  const id=Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,start_date,start_time,due_date,due_time,due_date_offset_days,
    points,is_recurring,recurrence_rule,expiration_policy) VALUES('Series title',1,2,?,'07:00',?,'08:00',?,2,1,?,?)`).run(start,due,offset,rule,expiration).lastInsertRowid);
  for(const [title,optional,order] of [['Required',0,0],['Optional',1,1]])d.prepare(`INSERT INTO tasks(title,created_by,parent_task_id,
    start_date,start_time,due_date,due_time,is_optional,sort_order) VALUES(?,1,?,?,'07:00',?,'08:00',?,?)`).run(title,id,start,due,optional,order);
  const state=ensureSeriesDefinition(d,id);
  recordOccurrenceDefinition(d,id,{definitionId:state.definition.id,baseline:true});
  return id;
}
function finish(id,now='2026-10-30T11:30:00Z'){
  return changeTaskStatus(d,id,'done',{actorId:2,requireRevision:false,body:{complete_remaining:true},now:new Date(now)});
}

test('occurrence-only title, points, timing, recurrence and checklist edits never seed future definitions',()=>{
  const id=seed(),state=taskSeriesState(d,id),originalKeys=state.definition.data.subtasks.map(child=>child.action_key);
  d.prepare(`UPDATE tasks SET title='One occasion',points=7,start_date='2026-10-27',due_date='2026-10-31',
    recurrence_rule=NULL,is_recurring=0,recurrence_from_completion=1 WHERE id=?`).run(id);
  d.prepare('DELETE FROM tasks WHERE id=?').run(children(id)[0].id);
  d.prepare("UPDATE tasks SET title='One occasion optional',is_optional=0 WHERE parent_task_id=?").run(id);
  finish(id);
  const successor=next(id);
  assert.equal(successor.title,'Series title');assert.equal(successor.points,2);
  assert.equal(successor.start_date,'2026-11-02');assert.equal(successor.due_date,'2026-11-06');
  assert.equal(successor.recurrence_rule,'FREQ=WEEKLY;BYDAY=MO');assert.equal(successor.recurrence_from_completion,0);
  assert.deepEqual(children(successor.id).map(child=>[child.title,child.is_optional,child.status]),[['Required',0,'open'],['Optional',1,'open']]);
  assert.deepEqual(children(successor.id).map(child=>d.prepare('SELECT action_key FROM task_recurrence_actions WHERE task_id=?').get(child.id).action_key),originalKeys);
  assert.equal(taskSeriesState(d,successor.id).revision,1);
});

test('effective definitions supply later materialization while prior occurrence content and awards remain historical',()=>{
  const id=seed(),before=row(id),state=taskSeriesState(d,id);
  const definition=structuredClone(state.definition.data);
  definition.task.title='Future title';definition.task.points=5;definition.subtasks[0].task.title='Renamed';
  definition.subtasks[1].task.sort_order=-1;
  definition.subtasks.push({action_key:'action:new-series-action',source_task_id:null,
    task:{...definition.subtasks[1].task,title:'Added',is_optional:1,sort_order:2},assigned_user_ids:[],skill_ids:[],tags:[]});
  appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition,effectiveGeneration:1});
  assert.deepEqual(row(id),before);
  finish(id);
  const successor=next(id);
  assert.equal(successor.title,'Future title');assert.equal(successor.points,5);
  assert.equal(row(id).title,'Series title');assert.equal(row(id).points,2);
  assert.equal(d.prepare('SELECT SUM(delta) n FROM reward_ledger WHERE task_id=?').get(id).n,2);
  assert.deepEqual(children(successor.id).map(child=>child.title),['Optional','Renamed','Added']);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_recurrence_actions WHERE occurrence_task_id=? AND action_key='action:new-series-action'").get(successor.id).n,1);
});

test('later edits from an earlier effective generation supersede earlier future versions and enforce series revision conflicts',()=>{
  const id=seed(),state=taskSeriesState(d,id);
  const initialClock=d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version,initialTask=row(id);
  const future=structuredClone(state.definition.data);future.task.title='First planned change';
  appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition:future,effectiveGeneration:8});
  const replacement=structuredClone(state.definition.data);replacement.task.title='Latest change';
  appendSeriesDefinition(d,id,{expectedRevision:2,actorId:1,definition:replacement,effectiveGeneration:2});
  assert.equal(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version,initialClock+2);
  assert.deepEqual(row(id),initialTask,'future-only definition changes invalidate live clients without altering a historical Task revision');
  assert.equal(seriesDefinitionForGeneration(d,state.series_id,1).data.task.title,'Series title');
  assert.equal(seriesDefinitionForGeneration(d,state.series_id,8).data.task.title,'Latest change');
  assert.throws(()=>appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition:future}),error=>error.status===409);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n,3);
});

test('equivalent reusable definitions do not append revisions for copied source IDs or calendar translation',()=>{
  const id=seed(),state=taskSeriesState(d,id),same=structuredClone(state.definition.data);
  same.task.start_date='2026-11-02';same.task.due_date='2026-11-06';
  for(const child of same.subtasks){child.source_task_id+=100;child.task.start_date='2026-11-02';child.task.due_date='2026-11-06';}
  assert.equal(definitionEqual(state.definition.data,same),true);
  assert.equal(appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition:same}).changed,false);
  assert.equal(taskSeriesState(d,id).revision,1);
});

test('expired occurrence-only recurrence flags cannot strand a fixed series during background reconciliation',()=>{
  const id=seed({start:'2026-09-21',due:'2026-09-21',offset:0,rule:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',expiration:'expire_incomplete'});
  d.prepare('UPDATE tasks SET is_recurring=0,recurrence_rule=NULL,recurrence_from_completion=1 WHERE id=?').run(id);
  const outcome=reconcileTaskExpirations(d,{now:new Date('2026-09-21T12:00:00Z')});
  assert.equal(outcome.failed,0);assert.equal(row(id).status,'expired');
  assert.equal(next(id).start_date,'2026-09-22');assert.equal(next(id).due_date,'2026-09-22');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
});

test('authoritative completion-relative mode still pauses on expiration despite an occurrence-only fixed flag',()=>{
  const id=seed({start:'2026-09-21',due:'2026-09-21',offset:0,rule:'FREQ=DAILY',expiration:'expire_incomplete'});
  const state=taskSeriesState(d,id),definition=structuredClone(state.definition.data);definition.task.recurrence_from_completion=1;
  appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition});
  expireTask(d,id,{now:new Date('2026-09-21T12:00:00Z')});
  assert.equal(next(id),undefined);
  reconcileTaskExpirations(d,{now:new Date('2026-09-22T12:00:00Z')});
  assert.equal(next(id),undefined);
});

test('undo uses the generated tree baseline even when the predecessor contains occurrence-only exceptions',()=>{
  const id=seed();d.prepare("UPDATE tasks SET title='One-time title' WHERE id=?").run(id);
  d.prepare("UPDATE tasks SET title='One-time child title',is_optional=0 WHERE parent_task_id=?").run(id);
  finish(id);const successor=next(id);assert.ok(successor);
  changeTaskStatus(d,id,'open',{actorId:1,requireRevision:false,body:{reset_progress:true},now:new Date('2026-10-30T11:30:00Z')});
  assert.equal(row(successor.id),undefined);
  finish(id);assert.equal(next(id).title,'Series title');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(id).n,1);
});

test('definition edits ordered before or after materialization cannot duplicate a frontier or reuse stale content later',()=>{
  for(const editFirst of [true,false]) {
    const id=seed(),state=taskSeriesState(d,id),definition=structuredClone(state.definition.data);
    definition.task.title=editFirst?'Edited first':'Materialized first';
    if(editFirst)appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition,effectiveGeneration:1});
    finish(id);
    const successor=next(id);
    if(!editFirst)appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition,effectiveGeneration:1});
    reconcileTaskRecurrence(id);finish(id);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id).n,1);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='recurrence_generated'").get(successor.id).n,1);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(id).n,1);
    finish(successor.id,'2026-11-06T12:00:00Z');
    assert.equal(next(successor.id).title,definition.task.title);
    assert.equal(d.prepare(`SELECT COUNT(*) n FROM task_recurrence_occurrences
      WHERE series_id=? AND state='materialized'`).get(state.series_id).n,3);
  }
});

test('a transaction failure rolls back the series version and its live change-clock event together',()=>{
  const id=seed(),state=taskSeriesState(d,id),definition=structuredClone(state.definition.data);
  definition.task.title='Must roll back';
  const clock=d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  assert.throws(()=>d.transaction(()=>{
    appendSeriesDefinition(d,id,{expectedRevision:state.revision,actorId:1,definition});
    throw new Error('materialization failed');
  }).immediate(),/materialization failed/);
  assert.equal(taskSeriesState(d,id).revision,state.revision);
  assert.equal(taskSeriesState(d,id).definition.data.task.title,'Series title');
  assert.equal(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version,clock);
});

test('occurrence-only group, roster and schedule edits cannot strand or partially undo a durable rotation cohort',()=>{
  const ids=[seed(),seed()];
  for(const [slot,id] of ids.entries()) {
    d.prepare("UPDATE tasks SET assignment_mode='round_robin',rotation_group='Morning rotation',rotation_slot=? WHERE id=?").run(slot,id);
    d.prepare('UPDATE tasks SET is_optional=0 WHERE parent_task_id=?').run(id);
    for(const [order,userId] of [2,1].entries())d.prepare('INSERT INTO task_rotation_members(task_id,user_id,sort_order) VALUES(?,?,?)').run(id,userId,order);
    appendSeriesDefinition(d,id,{expectedRevision:1,actorId:1,definition:captureSeriesDefinition(d,id)});
  }
  d.prepare(`UPDATE tasks SET rotation_group=NULL,start_date='2026-10-27',due_date='2026-10-31',
    recurrence_rule='FREQ=DAILY',recurrence_from_completion=1 WHERE id=?`).run(ids[0]);
  d.prepare('DELETE FROM task_rotation_members WHERE task_id=?').run(ids[0]);
  finish(ids[0]);assert.equal(next(ids[0]),undefined);
  finish(ids[1]);
  const successors=ids.map(next);
  assert.deepEqual(successors.map(task=>task.start_date),['2026-11-02','2026-11-02']);
  assert.deepEqual(successors.map(task=>task.assigned_to),[1,2]);
  assert.deepEqual(successors.map(task=>task.rotation_group),['Morning rotation','Morning rotation']);
  changeTaskStatus(d,ids[0],'open',{actorId:1,requireRevision:false,body:{reset_progress:true}});
  assert.ok(successors.every(task=>!row(task.id)),'undo removes the untouched next cohort together');
  finish(ids[0]);
  assert.ok(ids.every(id=>next(id)));
  for(const id of ids)assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(id).n,1);
});
