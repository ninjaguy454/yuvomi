import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='rotation-migration-isolated';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {initializeTaskSeries}=await import('../server/services/task-series.js');
const hash=value=>createHash('sha256').update(JSON.stringify(value.map(row=>JSON.stringify(row)).sort())).digest('hex');
function populatedRelationships(d) {
  return {
    meals:d.prepare(`SELECT p.name,pr.revision,r.policy,r.rotation_group,m.date,m.title,a.occurrence_key,a.assigned_user_id,
      a.base_rotation_key,a.scoped_rotation_key,a.cursor_before_user_id,a.cursor_after_user_id,a.committed,
      roles.role,roles.strategy,roles.assigned_user_id role_assignee,roles.scoped_rotation_key role_rotation_key
      FROM meal_plans p JOIN meal_plan_revisions pr ON pr.meal_plan_id=p.id JOIN meal_plan_rules r ON r.meal_plan_id=p.id
      JOIN meals m ON m.meal_plan_rule_id=r.id JOIN meal_occurrence_assignments a ON a.meal_id=m.id
      JOIN meal_occurrence_role_assignments roles ON roles.occurrence_assignment_id=a.id ORDER BY roles.role`).all(),
    skills:d.prepare(`SELECT u.display_name,s.name,p.proficiency,p.source,p.updated_by,r.task_id FROM user_skill_proficiency p
      JOIN users u ON u.id=p.user_id JOIN skills s ON s.id=p.skill_id JOIN task_skill_requirements r ON r.skill_id=s.id ORDER BY p.user_id,r.task_id`).all(),
    availability:d.prepare(`SELECT u.display_name,p.name,ap.source,ap.state,ap.starts_at,ap.ends_at,ap.note FROM availability_periods ap
      JOIN users u ON u.id=ap.user_id JOIN places p ON p.id=ap.place_id ORDER BY ap.id`).all(),
    recurringPresence:d.prepare(`SELECT u.display_name,p.name,ar.weekdays_json,ar.start_time,ar.end_time,ar.state FROM availability_rules ar
      JOIN users u ON u.id=ar.user_id JOIN places p ON p.id=ar.place_id ORDER BY ar.id`).all(),
    supervision:d.prepare(`SELECT a.source_task_id,a.action_task_id,a.counterpart_task_id,a.learner_user_id,a.supervisor_user_id,
      a.required_skill_ids_json,a.state,a.execution_mode,l.status learner_status,h.status helper_status,e.event_type,e.details_json
      FROM task_supervision_actions a JOIN tasks l ON l.id=a.action_task_id JOIN tasks h ON h.id=a.counterpart_task_id
      JOIN task_activity_events e ON e.action_task_id=a.action_task_id WHERE e.event_type='supervision_completed' ORDER BY a.id`).all(),
    documents:d.prepare(`SELECT t.title,doc.name,doc.visibility,doc.mime_type,doc.content_data,doc.created_by,td.created_by linked_by
      FROM task_documents td JOIN tasks t ON t.id=td.task_id JOIN family_documents doc ON doc.id=td.document_id ORDER BY td.task_id,td.document_id`).all(),
    history:d.prepare(`SELECT t.title,e.action_task_id,u.display_name actor,e.event_type,e.details_json,e.created_at FROM task_activity_events e
      JOIN tasks t ON t.id=e.task_id LEFT JOIN users u ON u.id=e.actor_user_id ORDER BY e.id`).all(),
  };
}

test('encrypted production-shaped 10038 -> 10042 preserves all existing rows, indexes, triggers, foreign keys and restart history',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rotation-10039-')),file=join(directory,'database.db'),key=randomBytes(32).toString('hex');
  const open=(options={})=>{const d=new Database(file,options);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);return d;};
  let d;
  try{
    d=open();d.pragma('foreign_keys=ON');
    d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT '2026-09-19T00:00:00Z')");
    for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10038)){
      if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'child','Learner','x','member');
      INSERT INTO activity_templates(id,name,title_template,created_by,assignment_policy,assignment_strategy,fixed_user_id,start_time,due_time,due_date_offset_days)
        VALUES(1,'Morning','Morning',1,'fixed','fixed',2,'07:00','08:00',0);
      INSERT INTO tasks(id,title,created_by,assigned_to,is_recurring,recurrence_rule,start_date,start_time,due_date,due_time,status,due_date_offset_days)
        VALUES(1,'Historical complete',1,2,1,'FREQ=DAILY','2026-09-17','07:00','2026-09-17','08:00','done',0),
          (2,'Current partially complete',1,2,1,'FREQ=DAILY','2026-09-19','07:00','2026-09-19','08:00','in_progress',0),
          (3,'Missed occurrence',1,2,1,'FREQ=DAILY','2026-09-18','07:00','2026-09-18','08:00','expired',0);
      INSERT INTO tasks(id,title,created_by,parent_task_id,status,is_optional) VALUES(4,'Completed required action',1,2,'done',0),(5,'Optional action',1,2,'open',1);
      INSERT INTO task_activity_bindings(task_id,activity_template_id) VALUES(1,1),(2,1),(3,1);
      INSERT INTO task_comments(task_id,user_id,comment) VALUES(1,1,'Historical note'),(2,1,'Keep this work');
      INSERT INTO task_completions(task_id,series_id,user_id) VALUES(1,1,2);
      INSERT INTO reward_ledger(user_id,delta,type,task_id,reason,created_by) VALUES(2,2,'earn',1,'Morning',1);
      INSERT INTO workflow_templates(id,name,subject_required) VALUES(1,'Bedtime',0);
      INSERT INTO household_variable_definitions(id,variable_key,label,type,kind,default_value_json) VALUES(3,'person','Person','household_member','value','2'),(40,'deleted','Deleted','text','value','"old"');
      DELETE FROM household_variable_definitions WHERE id=40;
      INSERT INTO workflow_variable_definitions(id,workflow_template_id,variable_key,label,type,scope,reusable_definition_id) VALUES(7,1,'person','Person','household_member','reusable',3);
      INSERT INTO assignment_rotation_state(rotation_key,cursor_user_id,occurrence_count) VALUES('legacy_meal',2,4);
      CREATE INDEX idx_fixture_preserved_variable ON household_variable_definitions(label);
      CREATE TRIGGER trg_fixture_preserved_variable AFTER UPDATE OF label ON household_variable_definitions BEGIN SELECT 1; END;`);
    // Populated, connected pre-Rotation domains: these are synthetic household
    // records in an encrypted fixture, never a production data modification.
    d.exec(`INSERT INTO skills(id,name,created_by) VALUES(901,'Laundry safety',1);
      INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(1,901,'normal','manual',1),(2,901,'supervised','manual',1);
      INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(4,901);
      INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(1,901);
      INSERT INTO places(id,name,type,created_by) VALUES(901,'Fixture Home','home',1);
      INSERT INTO availability_periods(user_id,source,state,place_id,starts_at,ends_at,note,created_by)
        VALUES(1,'manual','available',901,'2026-09-19T11:00:00Z','2026-09-19T13:00:00Z','Supervising at home',1),
              (2,'explicit','available',901,'2026-09-19T11:00:00Z','2026-09-19T13:00:00Z','Learner is at home',1);
      INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,place_id,created_by)
        VALUES(2,'Weekday home window','[1,2,3,4,5]','07:00','08:00','available',901,1);
      INSERT INTO tasks(id,title,created_by,assigned_to,status,parent_task_id) VALUES(6,'Supervise current routine',1,1,'in_progress',NULL),(7,'Verified action helper',1,1,'done',6);
      INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(2,6);
      INSERT INTO task_responsibilities(task_id,user_id,role,status,source) VALUES(2,1,'supervisor','active','skill'),(4,2,'learner','fulfilled','skill');
      INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,required_skill_ids_json,state,execution_mode)
        VALUES(2,4,7,2,1,'[901]','assigned','supervised');
      INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json,created_at)
        VALUES(2,4,1,'supervision_completed','{"learner_user_id":2,"supervisor_user_id":1,"skill_ids":[901],"counterpart_task_id":7}','2026-09-19T11:30:00.123Z'),
              (1,1,2,'completed','{"points":2,"completion_id":1}','2026-09-17T11:45:00.234Z'),
              (3,3,NULL,'expired','{"automatic":true,"points":0}','2026-09-18T12:00:00.000Z');
      INSERT INTO family_documents(id,name,category,visibility,original_name,mime_type,file_size,content_data,created_by)
        VALUES(901,'Routine instructions','home','family','instructions.txt','text/plain',12,'SGVsbG8gZmFtaWx5',1),
              (902,'Completion evidence','home','restricted','evidence.txt','text/plain',8,'VmVyaWZpZWQ=',1);
      INSERT INTO task_documents(task_id,document_id,created_by) VALUES(2,901,1),(4,902,1);
      INSERT INTO family_document_access(document_id,user_id) VALUES(902,1),(902,2);
      INSERT INTO meal_plans(id,name,description,created_by) VALUES(901,'Fixture weekly dinners','Preserve legacy rotation',1);
      INSERT INTO meal_plan_revisions(id,meal_plan_id,revision,snapshot_json,created_by) VALUES(901,901,1,'{"name":"Fixture weekly dinners","rotation_group":"household"}',1);
      INSERT INTO meal_plan_rules(id,meal_plan_id,weekday,meal_type,label,policy,rotation_group,cook_strategy,cook_rotation_group,supervisor_strategy,supervisor_rotation_group)
        VALUES(901,901,6,'dinner','Dinner chooser','round_robin','household','round_robin','household','fixed',NULL);
      INSERT INTO meal_plan_rule_participants(meal_plan_rule_id,user_id) VALUES(901,1),(901,2);
      INSERT INTO meals(id,date,meal_type,title,created_by,source,meal_plan_id,meal_plan_revision_id,meal_plan_rule_id)
        VALUES(901,'2026-09-19','dinner','Fixture dinner',1,'schedule',901,901,901);
      INSERT INTO meal_occurrence_assignments(id,occurrence_key,meal_plan_rule_id,meal_id,assigned_user_id,base_rotation_key,scoped_rotation_key,cursor_before_user_id,cursor_after_user_id,committed,committed_at)
        VALUES(901,'fixture_dinner_2026-09-19',901,901,2,'legacy_meal','legacy_meal',1,2,1,'2026-09-19T12:00:00Z');
      INSERT INTO meal_occurrence_role_assignments(occurrence_assignment_id,role,strategy,assigned_user_id,base_rotation_key,scoped_rotation_key,cursor_before_user_id,cursor_after_user_id,committed,committed_at)
        VALUES(901,'cook','round_robin',1,'legacy_cook','legacy_cook',2,1,1,'2026-09-19T12:00:00Z'),
              (901,'supervisor','fixed',1,NULL,NULL,NULL,NULL,1,'2026-09-19T12:00:00Z');`);
    // Existing independent series definitions are durable data, not reconstructed by 10039.
    initializeTaskSeries(d);
    const relationships=populatedRelationships(d);
    for(const [domain,rows] of Object.entries(relationships))assert.ok(rows.length>0,`${domain} requires populated linked records`);
    assert.equal(relationships.meals.length,2);assert.equal(relationships.supervision[0].helper_status,'done');
    assert.ok(relationships.history.some(row=>row.event_type==='expired'&&row.actor===null));
    const tables=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    const before=Object.fromEntries(tables.map(table=>[table,{columns:d.pragma(`table_info(${table})`).map(row=>row.name),rows:d.prepare(`SELECT * FROM "${table}"`).all()}]));
    const artifacts=d.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
    const history=before.schema_migrations.rows;assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();
    assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\u0000');
    const boot=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.init();console.log('SCHEMA',db.currentVersion());db.get().close();"],
      {cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:60000,env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:key,LOG_LEVEL:'info',NODE_ENV:'test'}});
      assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
    const initial=boot();assert.deepEqual([...initial.matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1])),[10039,10040,10041,10042]);
    d=open();
    for(const [table,snapshot] of Object.entries(before)){
      const rows=d.prepare(`SELECT ${snapshot.columns.map(c=>`"${c}"`).join(',')} FROM "${table}" ${table==='schema_migrations'?'WHERE version<=10038':''}`).all();
      assert.equal(hash(rows),hash(snapshot.rows),`${table} contents must be preserved`);
    }
    for(const artifact of artifacts)assert.equal(d.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(artifact.name)?.sql,artifact.sql,artifact.name);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
    assert.deepEqual(populatedRelationships(d),relationships,'all populated domain joins and evidence survive the additive migration');
    assert.equal(d.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('household_variable_definitions').seq,40);
    for(const table of ['tasks','activity_templates','workflow_templates'])assert.ok(d.prepare(`SELECT rotation_bindings_json FROM ${table}`).all().every(row=>row.rotation_bindings_json==='[]'));
    for(const table of ['rotation_groups','rotation_tracks','rotation_occurrences'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
    const afterHistory=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();assert.equal(afterHistory.length,history.length+4);d.close();
    assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1])),[]);
    d=open({readonly:true});assert.equal(d.prepare('SELECT max(version) v FROM schema_migrations').get().v,10042);assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),afterHistory);
    assert.deepEqual(populatedRelationships(d),relationships,'fresh restart preserves the same connected household evidence');
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();
  }finally{if(d?.open)d.close();rmSync(directory,{recursive:true,force:true});}
});
