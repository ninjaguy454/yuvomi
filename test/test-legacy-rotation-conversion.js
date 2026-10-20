import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='legacy-rotation-conversion-fixture';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {saveRotationGroup,listRotationGroups,normalizeRotationConfiguration}=await import('../server/services/rotation.js');
const {saveRotationGroupUsage}=await import('../server/services/rotation-shared.js');
const {normalizeGroupAssignment}=await import('../server/services/group-assignment.js');

function fixture(){
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS.filter(row=>row.version<=10065)){
    if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();
    if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');
  }
  d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES
    (1,'admin','Admin','x','admin'),(2,'alex','Alex','x','member'),(3,'bea','Bea','x','member'),(4,'cam','Cam','x','member'),
    (5,'guest','Guest','x','member');
    INSERT INTO split_expense_guest_users(user_id) VALUES(5);
    INSERT INTO tasks(id,title,created_by,assigned_to,is_recurring,recurrence_rule,assignment_mode,rotation_group,rotation_slot,rotation_index,rotation_cycle)
      VALUES (10,'Morning',1,3,1,'FREQ=DAILY','round_robin','Chores',0,1,5),
             (11,'Evening',1,4,1,'FREQ=DAILY','round_robin','Chores',1,1,5),
             (12,'Other',1,2,1,'FREQ=DAILY','round_robin','Mismatch',0,0,0),
             (13,'Other 2',1,2,1,'FREQ=DAILY','round_robin','Mismatch',1,0,0),
             (14,'Private household work',1,2,1,'FREQ=DAILY','round_robin','Private task title',0,0,0);
    INSERT INTO task_rotation_members(task_id,user_id,sort_order) VALUES
      (10,2,0),(10,3,1),(10,4,2),(11,2,0),(11,3,1),(11,4,2),
      (12,2,0),(12,3,1),(13,3,0),(13,2,1),(14,2,0),(14,5,1);
    INSERT INTO task_recurrence_series(series_id) VALUES(30),(31);
    INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id) VALUES
      (30,0,'{"task":{"rotation_group":"Chores","rotation_slot":0},"rotation_user_ids":[2,3,4]}',10),
      (31,0,'{"task":{"rotation_group":"Chores","rotation_slot":1},"rotation_user_ids":[2,3,4]}',11);
    INSERT INTO activity_templates(id,name,title_template,created_by,rotation_group)
      VALUES(40,'Dynamic','Dynamic',1,'template-cursor');`);
  d.transaction(()=>ALL_MIGRATIONS.find(row=>row.version===10066).up(d))();
  return d;
}

test('ordinary legacy cohorts map to Groups while slots, cursors and dynamic keys remain intact',()=>{
  const d=fixture();
  try{
    const before=d.prepare('SELECT id,assigned_to,rotation_index,rotation_cycle,rotation_slot,rotation_group FROM tasks ORDER BY id').all();
    const definitions=d.prepare('SELECT definition_json FROM task_recurrence_definitions ORDER BY id').all();
    const migrate=ALL_MIGRATIONS.find(row=>row.version===10067);assert.ok(migrate);
    d.transaction(()=>migrate.up(d))();
    const mapping=d.prepare('SELECT * FROM legacy_rotation_group_mappings').all();
    assert.equal(mapping.length,1);
    assert.equal(mapping[0].source_key,'Chores');
    assert.equal(d.prepare('SELECT name FROM rotation_groups WHERE id=?').get(mapping[0].group_id).name,'Imported Rotation');
    assert.equal(listRotationGroups(d).length,0,'ordinary Group pickers omit imported private cohorts');
    assert.equal(listRotationGroups(d,{includeLegacy:true}).length,1);
    assert.throws(()=>normalizeGroupAssignment(d,{group_id:mapping[0].group_id}),/reserved/);
    assert.throws(()=>normalizeRotationConfiguration(d,{group_id:mapping[0].group_id}),/reserved/);
    assert.deepEqual(JSON.parse(mapping[0].roster_json),[2,3,4]);
    assert.deepEqual(d.prepare('SELECT user_id FROM rotation_group_members WHERE group_id=? ORDER BY sort_order').all(mapping[0].group_id).map(row=>row.user_id),[2,3,4]);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_groups').get().n,1);
    const imported=d.prepare('SELECT revision,name FROM rotation_groups WHERE id=?').get(mapping[0].group_id);
    assert.throws(()=>saveRotationGroup(d,{member_ids:[3,2,4]},
      {id:mapping[0].group_id,actorId:1,expectedRevision:imported.revision}),
      error=>error.code==='legacy_cohort_order');
    assert.throws(()=>saveRotationGroupUsage(d,{active:0},
      {id:mapping[0].group_id,actorId:1,expectedRevision:imported.revision}),
      error=>error.code==='legacy_cohort_schedule');
    assert.equal(saveRotationGroup(d,{name:'Chores renamed'},
      {id:mapping[0].group_id,actorId:1,expectedRevision:imported.revision}).name,'Chores renamed');
    assert.deepEqual(d.prepare('SELECT id,assigned_to,rotation_index,rotation_cycle,rotation_slot,rotation_group FROM tasks ORDER BY id').all(),before);
    assert.deepEqual(d.prepare('SELECT definition_json FROM task_recurrence_definitions ORDER BY id').all(),definitions);
    assert.deepEqual(d.prepare("SELECT source_type,source_id FROM rotation_compatibility_review WHERE status='resolved' ORDER BY source_type,source_id").all(),
      [{source_type:'recurrence_definition',source_id:1},{source_type:'recurrence_definition',source_id:2},
       {source_type:'task',source_id:10},{source_type:'task',source_id:11}]);
    assert.equal(d.prepare("SELECT status FROM rotation_compatibility_review WHERE source_type='activity_template'").get().status,'requires_review');
    assert.equal(d.prepare("SELECT status FROM rotation_compatibility_review WHERE source_type='task' AND source_id=12").get().status,'requires_review');
    assert.equal(d.prepare("SELECT status FROM rotation_compatibility_review WHERE source_type='task' AND source_id=14").get().status,'requires_review');
    d.transaction(()=>migrate.up(d))();
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_groups').get().n,1);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();}
});

test('legacy Template and recurrence subtask keys without a proven roster remain for review',()=>{
  const d=fixture();
  try{
    const saved='{"task":{"rotation_group":null},"rotation_user_ids":[],"subtasks":[{"action_key":"wash","task":{"rotation_group":"unproven-action","rotation_slot":1},"assigned_user_ids":[2]}]}';
    const id=Number(d.prepare('INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id) VALUES(30,1,?,10)').run(saved).lastInsertRowid);
    d.transaction(()=>ALL_MIGRATIONS.find(row=>row.version===10066).up(d))();
    d.transaction(()=>ALL_MIGRATIONS.find(row=>row.version===10067).up(d))();
    assert.equal(d.prepare('SELECT definition_json FROM task_recurrence_definitions WHERE id=?').get(id).definition_json,saved);
    assert.deepEqual(d.prepare("SELECT source_type,status FROM rotation_compatibility_review WHERE source_type IN ('activity_template','recurrence_subtasks') ORDER BY source_type").all(),
      [{source_type:'activity_template',status:'requires_review'},{source_type:'recurrence_subtasks',status:'requires_review'}]);
    assert.equal(d.prepare('SELECT rotation_group FROM activity_templates WHERE id=40').get().rotation_group,'template-cursor');
  }finally{d.close();}
});

test('a recurrence action already governed by a saved Group resolves its inert legacy-key review',()=>{
  const d=fixture();
  try{
    const group=saveRotationGroup(d,{name:'Action Group',member_ids:[2,3]},{actorId:1});
    const config=JSON.stringify({group_id:group.id,start_mode:'first',direction:'first_to_last'});
    const saved=JSON.stringify({task:{rotation_group:null},rotation_user_ids:[],subtasks:[
      {action_key:'wash',task:{rotation_group:'old-label',rotation_slot:1,assignment_group_json:config},assigned_user_ids:[2]}]});
    const id=Number(d.prepare('INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id) VALUES(30,1,?,10)').run(saved).lastInsertRowid);
    d.transaction(()=>ALL_MIGRATIONS.find(row=>row.version===10066).up(d))();
    d.transaction(()=>ALL_MIGRATIONS.find(row=>row.version===10067).up(d))();
    assert.equal(d.prepare("SELECT status FROM rotation_compatibility_review WHERE source_type='recurrence_subtasks' AND source_id=?").get(id).status,'resolved');
    assert.equal(d.prepare('SELECT definition_json FROM task_recurrence_definitions WHERE id=?').get(id).definition_json,saved);
    assert.equal(d.prepare("SELECT status FROM rotation_compatibility_review WHERE source_type='activity_template'").get().status,'requires_review');
  }finally{d.close();}
});

test('a failed legacy conversion rolls back its Group and mapping',()=>{
  const d=fixture();
  try{
    const migrate=ALL_MIGRATIONS.find(row=>row.version===10067);assert.ok(migrate);
    d.exec(`CREATE TABLE legacy_rotation_group_mappings(source_key TEXT PRIMARY KEY COLLATE NOCASE,
      group_id INTEGER NOT NULL UNIQUE REFERENCES rotation_groups(id),roster_json TEXT NOT NULL,
      compatibility_mode TEXT NOT NULL DEFAULT 'synchronized_slots');
      CREATE TRIGGER reject_legacy_map BEFORE INSERT ON legacy_rotation_group_mappings
      BEGIN SELECT RAISE(ABORT,'synthetic migration interruption'); END;`);
    assert.throws(()=>d.transaction(()=>migrate.up(d))(),/synthetic migration interruption/);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_groups').get().n,0);
    assert.equal(d.prepare("SELECT count(*) n FROM rotation_compatibility_review WHERE status='resolved'").get().n,0);
    d.exec('DROP TRIGGER reject_legacy_map');
    d.transaction(()=>migrate.up(d))();
    assert.equal(d.prepare('SELECT count(*) n FROM legacy_rotation_group_mappings').get().n,1);
  }finally{d.close();}
});
