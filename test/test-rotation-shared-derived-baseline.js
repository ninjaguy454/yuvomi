import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const S=await import('../server/services/rotation-shared.js');
const R=await import('../server/services/rotation.js');
const {bindTaskRotations}=await import('../server/services/task-rotation.js');
const {initializeTaskRotationRendering,refreshRotationTaskRendering}=await import('../server/services/task-rotation-rendering.js');
const {ensureSeriesDefinition,recordOccurrenceDefinition}=await import('../server/services/task-series.js');
const {seriesOccurrencePreservationReason}=await import('../server/services/task-series-edit.js');

test('derived shared order changes preserve a pristine recurring baseline but never absorb existing human activity',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-19T23:00:00Z')});
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  try{
    for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d)})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
    _setTestDatabase(d);
    d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'admin','Parent','x','admin'),(2,'grace','Grace','x','member'),(3,'eleanor','Eleanor','x','member'),(4,'frankie','Frankie','x','member'); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')");
    const group=S.saveRotationGroupUsage(d,{name:'Bedtime group',member_ids:[2,3,4],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:2,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1}},{actorId:1});
    const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19'});
    const binding=JSON.stringify([{purpose_key:'order',label:'Shower Order',group_id:group.id,strategy:'rotating_order',advance_policy:'on_finalized'}]);
    d.prepare("INSERT INTO activity_templates(id,name,title_template,description,subject_required,assignment_strategy,assignment_policy,fixed_user_id,rotation_bindings_json) VALUES(1,'Bedtime','Bedtime {{order.position}}','Position {{order.position}}',0,'fixed','fixed',2,?)").run(binding);
    const task=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id),stored=id=>d.prepare('SELECT * FROM task_recurrence_occurrences WHERE task_id=?').get(id);
    const make=()=>{
      const id=Number(d.prepare("INSERT INTO tasks(title,description,created_by,assigned_to,start_date,start_time,due_date,due_time,is_recurring,recurrence_rule,rotation_bindings_json) VALUES('Bedtime 3','Position 3',1,2,'2026-09-20','18:30','2026-09-20','23:30',1,'FREQ=DAILY',?)").run(binding).lastInsertRowid);
      d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(id);
      d.prepare('INSERT INTO task_activity_bindings(task_id,activity_template_id,subject_user_id) VALUES(?,1,2)').run(id);
      bindTaskRotations(d,id,{actorId:1});initializeTaskRotationRendering(d,id);
      const series=ensureSeriesDefinition(d,id);recordOccurrenceDefinition(d,id,{definitionId:series.definition.id,baseline:true});
      assert.equal(seriesOccurrencePreservationReason(d,stored(id),task(id)),null);return id;
    };
    const pristine=make(),withNote=make();
    d.prepare("INSERT INTO task_comments(task_id,user_id,comment) VALUES(?,1,'Keep this evidence')").run(withNote);
    const meaningfulBaseline=stored(withNote).materialized_state_json;
    const apply=()=>{
      const changed=R.overrideRotation(d,occurrence.id,{member_ids:[4,2,3],expected_revision:occurrence.revision,actorId:1});
      refreshRotationTaskRendering(d,occurrence.id);
      S.notifySharedRotationReconciliation(d,{groupId:group.id,occurrence:changed,reason:'period_overridden'});
    };
    d.transaction(apply).immediate();
    assert.equal(task(pristine).title,'Bedtime 1');assert.equal(task(pristine).description,'Position 1');
    assert.equal(seriesOccurrencePreservationReason(d,stored(pristine),task(pristine)),null,'automatic provisional text must not make an untouched future occurrence an edit exception');
    assert.equal(stored(withNote).materialized_state_json,meaningfulBaseline);
    assert.ok(seriesOccurrencePreservationReason(d,stored(withNote),task(withNote)));
    const beforeActivation=stored(pristine).materialized_state_json;
    t.mock.timers.setTime(Date.parse('2026-09-20T23:00:00Z'));
    assert.equal(S.reconcileSharedRotationPeriods(d,{now:new Date()}).failed,0);
    assert.notEqual(stored(pristine).materialized_state_json,beforeActivation,'activation changes durable link revisions');
    assert.equal(seriesOccurrencePreservationReason(d,stored(pristine),task(pristine)),null,'automatic period activation must refresh only a previously pristine baseline');
    assert.equal(stored(withNote).materialized_state_json,meaningfulBaseline);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{_setTestDatabase(null);d.close();}
});
