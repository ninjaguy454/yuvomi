import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='group-compatibility-migration-fixture';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');

test('legacy Rotation definitions are durably classified without rewriting assignments, cursors or history',()=>{
  const d=new Database(':memory:');
  try{
    d.pragma('foreign_keys=ON');
    for(const migration of ALL_MIGRATIONS.filter(item=>item.version<=10065)){
      if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();
      if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'child','Child','x','member');
      INSERT INTO tasks(id,title,created_by,assigned_to,assignment_mode,rotation_group,rotation_slot,rotation_index)
        VALUES(51,'First recurring chore',1,2,'round_robin','Legacy chores',1,3),
              (52,'Second recurring chore',1,2,'round_robin','Legacy chores',0,3);
      INSERT INTO activity_templates(id,name,title_template,created_by,rotation_group)
        VALUES(71,'Template','Template',1,'legacy-template-cursor');
      INSERT INTO assignment_rotation_state(rotation_key,cursor_user_id,occurrence_count)
        VALUES('legacy-template-cursor',2,8);
      INSERT INTO task_recurrence_series(series_id) VALUES(81),(82);
      INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id)
        VALUES(81,0,'{"task":{"rotation_group":"Legacy chores","rotation_slot":1}}',51),
              (82,0,'{"task":{"rotation_group":null},"subtasks":[{"action_key":"take-bins-out","task":{"rotation_group":"Legacy chores","rotation_slot":2}}]}',52);
      INSERT INTO rotation_groups(id,name) VALUES(91,'Existing shared Group');
      INSERT INTO rotation_group_schedules(id,group_id) VALUES(91,91);
      INSERT INTO rotation_group_schedule_versions(id,schedule_id,usage_mode,effective_date,timezone,config_json,members_json)
        VALUES(92,91,'shared','2026-11-01','UTC','{"eligibility":{"presence":"must_be_home"}}','[]');
      INSERT INTO meal_plans(id,name,created_by) VALUES(93,'Meal rotation',1);
      INSERT INTO meal_plan_rules(id,meal_plan_id,weekday,meal_type,label,rotation_group)
        VALUES(94,93,1,'dinner','Dinner','legacy-meal-cursor');
      INSERT INTO meal_schedule_slots(id,weekday,meal_type,policy,rotation_group)
        VALUES(95,2,'lunch','round_robin','legacy-lunch-cursor');`);
    const before={tasks:d.prepare('SELECT * FROM tasks ORDER BY id').all(),templates:d.prepare('SELECT * FROM activity_templates ORDER BY id').all(),
      cursors:d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all(),
      definitions:d.prepare('SELECT * FROM task_recurrence_definitions ORDER BY id').all()};
    const migration=ALL_MIGRATIONS.find(item=>item.version===10066);
    assert.ok(migration,'review migration must exist');
    d.transaction(()=>migration.up(d))();
    const rows=d.prepare('SELECT source_type,source_id,reason,source_value FROM rotation_compatibility_review ORDER BY source_type,source_id').all();
    assert.deepEqual(rows.map(({source_type,source_id,reason})=>({source_type,source_id,reason})),[
      {source_type:'activity_template',source_id:71,reason:'legacy_cursor_without_membership'},
      {source_type:'meal_rule',source_id:94,reason:'legacy_meal_cursor'},
      {source_type:'meal_schedule_slot',source_id:95,reason:'legacy_meal_cursor'},
      {source_type:'recurrence_definition',source_id:1,reason:'legacy_cohort_with_slot'},
      {source_type:'recurrence_subtasks',source_id:2,reason:'legacy_subtask_cohort'},
      {source_type:'shared_schedule_version',source_id:92,reason:'group_level_eligibility'},
      {source_type:'task',source_id:51,reason:'legacy_cohort_with_slot'},
      {source_type:'task',source_id:52,reason:'legacy_cohort_cursor'},
    ]);
    assert.equal(rows.find(row=>row.source_type==='task'&&row.source_id===51).source_value,'Legacy chores');
    assert.deepEqual(JSON.parse(rows.find(row=>row.source_type==='recurrence_subtasks').source_value),
      [{action_key:'take-bins-out',rotation_group:'Legacy chores',rotation_slot:2}]);
    d.transaction(()=>migration.up(d))();
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_compatibility_review').get().n,rows.length,'retry is idempotent');
    d.exec(`INSERT INTO tasks(id,title,created_by,assignment_mode,rotation_group) VALUES(53,'Recovery fixture',1,'round_robin','new legacy key');
      CREATE TRIGGER reject_compatibility_review BEFORE INSERT ON rotation_compatibility_review
      WHEN NEW.source_type='task' AND NEW.source_id=53 BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END;`);
    assert.throws(()=>d.transaction(()=>migration.up(d))(),/synthetic interruption/);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_compatibility_review').get().n,rows.length,'failed migration writes roll back');
    d.exec('DROP TRIGGER reject_compatibility_review');
    d.transaction(()=>migration.up(d))();
    assert.equal(d.prepare("SELECT status FROM rotation_compatibility_review WHERE source_type='task' AND source_id=53").get().status,'requires_review');
    assert.deepEqual({tasks:d.prepare('SELECT * FROM tasks WHERE id<>53 ORDER BY id').all(),templates:d.prepare('SELECT * FROM activity_templates ORDER BY id').all(),
      cursors:d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all(),
      definitions:d.prepare('SELECT * FROM task_recurrence_definitions ORDER BY id').all()},before);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();}
});
