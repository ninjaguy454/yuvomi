import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='rotation-shared-migration-isolated';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {initializeTaskSeries}=await import('../server/services/task-series.js');
const digest=rows=>createHash('sha256').update(JSON.stringify(rows.map(row=>JSON.stringify(row)).sort())).digest('hex');

function seedHousehold(d) {
  // Connected synthetic household data, including every preservation domain
  // touched by Rotation consumers. This fixture never opens production data.
  d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES
    (1,'parent','Parent','x','admin'),(2,'grace','Grace','x','member'),
    (3,'eleanor','Eleanor','x','member'),(4,'frankie','Frankie','x','member');
    INSERT INTO activity_templates(id,name,title_template,created_by,assignment_policy,assignment_strategy,fixed_user_id,start_time,due_time,due_date_offset_days)
      VALUES(1,'Bedtime','Bedtime',1,'fixed','fixed',2,'19:00','20:00',0);
    INSERT INTO tasks(id,title,created_by,assigned_to,is_recurring,recurrence_rule,start_date,start_time,due_date,due_time,status,due_date_offset_days)
      VALUES(1,'Historical complete',1,2,1,'FREQ=DAILY','2026-09-17','19:00','2026-09-17','20:00','done',0),
        (2,'Partially complete routine',1,2,1,'FREQ=DAILY','2026-09-19','19:00','2026-09-19','20:00','in_progress',0),
        (3,'Expired routine',1,2,1,'FREQ=DAILY','2026-09-18','19:00','2026-09-18','20:00','expired',0);
    INSERT INTO tasks(id,title,created_by,parent_task_id,status,is_optional,assigned_to) VALUES
      (4,'Verified required action',1,2,'done',0,2),(5,'Optional action',1,2,'open',1,2),
      (6,'Supervise current routine',1,NULL,'in_progress',0,1),(7,'Verified helper action',1,6,'done',0,1);
    INSERT INTO task_assignments(task_id,user_id) VALUES(1,2),(2,2),(3,2),(4,2),(5,2),(6,1),(7,1);
    INSERT INTO task_activity_bindings(task_id,activity_template_id) VALUES(1,1),(2,1),(3,1);
    INSERT INTO task_comments(task_id,user_id,comment) VALUES(1,1,'Keep completed evidence'),(2,1,'Keep unfinished work');
    INSERT INTO task_completions(task_id,series_id,user_id) VALUES(1,1,2);
    INSERT INTO reward_ledger(user_id,delta,type,task_id,reason,created_by) VALUES(2,2,'earn',1,'Bedtime',1);
    INSERT INTO workflow_templates(id,name,subject_required) VALUES(1,'Evening workflow',0);
    INSERT INTO workflow_template_steps(id,workflow_template_id,activity_template_id,step_key,sort_order) VALUES(1,1,1,'bedtime',0);
    INSERT INTO workflow_instances(id,workflow_template_id,subject_user_id,parent_task_id,created_by,input_json) VALUES(1,1,2,2,1,'{"person":2}');
    INSERT INTO workflow_instance_tasks(workflow_instance_id,workflow_step_id,task_id) VALUES(1,1,4);
    INSERT INTO household_variable_definitions(id,variable_key,label,type,kind,default_value_json) VALUES
      (3,'person','Person','household_member','value','2'),(40,'deleted','Deleted','text','value','"old"');
    DELETE FROM household_variable_definitions WHERE id=40;
    INSERT INTO workflow_variable_definitions(id,workflow_template_id,variable_key,label,type,scope,reusable_definition_id) VALUES(7,1,'person','Person','household_member','reusable',3);
    INSERT INTO assignment_rotation_state(rotation_key,cursor_user_id,occurrence_count) VALUES('legacy_meal',2,4);
    INSERT INTO skills(id,name,created_by) VALUES(901,'Household safety',1);
    INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(1,901,'normal','manual',1),(2,901,'supervised','manual',1);
    INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(4,901);
    INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(1,901);
    INSERT INTO places(id,name,type,created_by) VALUES(901,'Fixture Home','home',1);
    INSERT INTO availability_periods(user_id,source,state,place_id,starts_at,ends_at,note,created_by) VALUES
      (1,'manual','available',901,'2026-09-19T23:00:00Z','2026-09-20T00:00:00Z','Supervisor at home',1),
      (2,'explicit','available',901,'2026-09-19T23:00:00Z','2026-09-20T00:00:00Z','Learner at home',1);
    INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,place_id,created_by)
      VALUES(2,'Weekday presence','[1,2,3,4,5]','19:00','20:00','available',901,1);
    INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(2,6);
    INSERT INTO task_responsibilities(task_id,user_id,role,status,source) VALUES(2,1,'supervisor','active','skill'),(4,2,'learner','fulfilled','skill');
    INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,required_skill_ids_json,state,execution_mode)
      VALUES(2,4,7,2,1,'[901]','assigned','supervised');
    INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json,created_at) VALUES
      (2,4,1,'supervision_completed','{"learner_user_id":2,"supervisor_user_id":1,"skill_ids":[901],"counterpart_task_id":7}','2026-09-19T23:30:00.123Z'),
      (1,1,2,'completed','{"points":2,"completion_id":1}','2026-09-17T23:45:00.234Z'),
      (3,3,NULL,'expired','{"automatic":true,"points":0}','2026-09-19T00:00:00.000Z');
    INSERT INTO family_documents(id,name,category,visibility,original_name,mime_type,file_size,content_data,created_by) VALUES
      (901,'Routine instructions','home','family','instructions.txt','text/plain',12,'SGVsbG8gZmFtaWx5',1),
      (902,'Completion evidence','home','restricted','evidence.txt','text/plain',8,'VmVyaWZpZWQ=',1);
    INSERT INTO task_documents(task_id,document_id,created_by) VALUES(2,901,1),(4,902,1);
    INSERT INTO family_document_access(document_id,user_id) VALUES(902,1),(902,2);
    INSERT INTO meal_plans(id,name,description,created_by) VALUES(901,'Fixture dinners','Keep legacy aliases',1);
    INSERT INTO meal_plan_revisions(id,meal_plan_id,revision,snapshot_json,created_by) VALUES(901,901,1,'{"name":"Fixture dinners","rotation_group":"household"}',1);
    INSERT INTO meal_plan_rules(id,meal_plan_id,weekday,meal_type,label,policy,rotation_group,cook_strategy,cook_rotation_group,supervisor_strategy)
      VALUES(901,901,6,'dinner','Dinner chooser','round_robin','household','round_robin','household','fixed');
    INSERT INTO meal_plan_rule_participants(meal_plan_rule_id,user_id) VALUES(901,1),(901,2);
    INSERT INTO meals(id,date,meal_type,title,created_by,source,meal_plan_id,meal_plan_revision_id,meal_plan_rule_id)
      VALUES(901,'2026-09-19','dinner','Fixture dinner',1,'schedule',901,901,901);
    INSERT INTO meal_occurrence_assignments(id,occurrence_key,meal_plan_rule_id,meal_id,assigned_user_id,base_rotation_key,scoped_rotation_key,cursor_before_user_id,cursor_after_user_id,committed,committed_at)
      VALUES(901,'fixture_dinner_2026-09-19',901,901,2,'legacy_meal','legacy_meal',1,2,1,'2026-09-19T20:00:00Z');
    INSERT INTO meal_occurrence_role_assignments(occurrence_assignment_id,role,strategy,assigned_user_id,base_rotation_key,scoped_rotation_key,cursor_before_user_id,cursor_after_user_id,committed,committed_at) VALUES
      (901,'cook','round_robin',1,'legacy_cook','legacy_cook',2,1,1,'2026-09-19T20:00:00Z'),
      (901,'supervisor','fixed',1,NULL,NULL,NULL,NULL,1,'2026-09-19T20:00:00Z');
    CREATE INDEX idx_shared_fixture_variable ON household_variable_definitions(label);
    CREATE TRIGGER trg_shared_fixture_variable AFTER UPDATE OF label ON household_variable_definitions BEGIN SELECT 1; END;`);
  initializeTaskSeries(d);
}

function seedExistingRotations(d) {
  // Seed the old persisted contract directly, so this rehearsal does not depend
  // on a newer Rotation service accepting a pre-10040 database.
  const members=[{id:2,membership_id:901,display_name:'Grace'},{id:3,membership_id:902,display_name:'Eleanor'},{id:4,membership_id:903,display_name:'Frankie'}];
  const config={group_id:901,strategy:'rotating_order',advance_policy:'on_finalized',advance_on_skip:false,override_affects_next:true,eligibility_behavior:'skip_unavailable',eligibility:{}};
  d.exec(`INSERT INTO rotation_groups(id,name,description,created_by,revision) VALUES(901,'Kids','Existing reusable Group',1,3);
    INSERT INTO rotation_group_members(id,group_id,user_id,sort_order) VALUES(901,901,2,0),(902,901,3,1),(903,901,4,2);
    INSERT INTO rotation_tracks(id,consumer_type,consumer_id,purpose_key,label,group_id,strategy,advance_policy,next_membership_id,group_revision,advance_count,revision,created_by) VALUES
      (901,'activity_series','1','shower','Shower Order',901,'rotating_order','on_finalized',902,3,1,4,1),
      (902,'meal_plan','901','chooser','Meal Chooser',901,'round_robin','on_finalized',902,3,1,3,1),
      (903,'workflow','1','shower','Workflow Shower Order',901,'rotating_order','on_completed',901,3,0,2,1);`);
  const insert=d.prepare(`INSERT INTO rotation_occurrences(id,track_id,occurrence_key,group_id,group_revision,track_config_revision,strategy,config_json,context_json,
    members_json,eligible_json,skipped_json,original_order_json,order_json,next_membership_id,status,revision,advanced,advance_reason,override_actor_id,overridden_at,finalized_at)
    VALUES(?,?,?,901,3,1,?,?,?,?,?,'[]',?,?,902,?,?,?,?,?,?,?)`);
  const json=JSON.stringify(members);
  insert.run(901,901,'series:1:occurrence:1','rotating_order',JSON.stringify(config),'{"task_id":1}',json,json,json,JSON.stringify([members[2],members[0],members[1]]),'completed',3,1,'completed',1,'2026-09-17T23:10:00Z','2026-09-18T00:00:00Z');
  insert.run(902,902,'meal:901','round_robin',JSON.stringify({...config,strategy:'round_robin'}),'{"meal_id":901}',json,json,JSON.stringify([members[0]]),JSON.stringify([members[0]]),'finalized',2,1,'finalized',null,null,'2026-09-19T20:00:00Z');
  insert.run(903,903,'workflow:1','rotating_order',JSON.stringify({...config,advance_policy:'on_completed'}),'{"workflow_instance_id":1}',json,json,json,json,'resolved',1,0,null,null,null,null);
  d.exec(`INSERT INTO rotation_events(group_id,track_id,occurrence_id,actor_user_id,event_type,details_json,created_at) VALUES
    (901,901,901,1,'overridden','{"original_order":[2,3,4],"effective_order":[4,2,3]}','2026-09-17T23:10:00Z'),
    (901,901,901,1,'finalized','{"advanced":true}','2026-09-18T00:00:00Z'),
    (901,902,902,1,'finalized','{"advanced":true}','2026-09-19T20:00:00Z');
    INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id) VALUES(1,'shower',901,901,1),(2,'shower',903,903,2),(4,'shower',903,903,2);
    INSERT INTO rotation_workflow_requests(workflow_template_id,actor_user_id,request_key,input_hash,workflow_instance_id,response_json)
      VALUES(1,1,'preserved-request','existing-hash',1,'{"id":1,"occurrence_id":903}');
    UPDATE meal_plan_rules SET chooser_rotation_group_id=901 WHERE id=901;
    UPDATE meal_occurrence_assignments SET rotation_occurrence_id=902 WHERE id=901;
    INSERT INTO household_variable_definitions(id,variable_key,label,type,kind,default_value_json) VALUES
      (41,'kids','Kids','rotation_group','value','901'),(42,'night','Night','rotation_occurrence','value','901');`);
  const binding=JSON.stringify([{purpose_key:'shower',label:'Shower Order',...config}]);
  for(const table of ['tasks','activity_templates','workflow_templates'])d.prepare(`UPDATE ${table} SET rotation_bindings_json=? WHERE id=1`).run(binding);
}

function snapshot(d) {
  const names=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  return {
    tables:Object.fromEntries(names.map(name=>[name,{columns:d.pragma(`table_info(${name})`).map(row=>row.name),rows:d.prepare(`SELECT * FROM "${name}"`).all()}])),
    artifacts:d.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all(),
    sequences:d.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all(),
  };
}
function assertPreserved(d,before,baseVersion) {
  for(const [name,value] of Object.entries(before.tables)) {
    const columns=value.columns.map(column=>`"${column}"`).join(',');
    const rows=d.prepare(`SELECT ${columns} FROM "${name}" ${name==='schema_migrations'?`WHERE version<=${baseVersion}`:''}`).all();
    assert.equal(digest(rows),digest(value.rows),`${name}: original persisted rows and columns must survive`);
  }
  for(const {name,sql} of before.artifacts)assert.equal(d.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql,sql,`${name}: original index/trigger must survive`);
  for(const {name,seq} of before.sequences)assert.equal(d.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(name)?.seq,seq,`${name}: consumed identities must survive`);
  assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
}

for(const baseVersion of [10038,10039])test(`encrypted populated ${baseVersion} -> 10042 preserves household and Rotation evidence; restart does not replay`,()=>{
  assert.ok(ALL_MIGRATIONS.some(m=>m.version===10040),'shared Rotation migration 10040 must be present');
  const directory=mkdtempSync(join(tmpdir(),`rotation-shared-${baseVersion}-`)),file=join(directory,'database.db'),key=randomBytes(32).toString('hex');
  const open=(options={})=>{const d=new Database(file,options);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);return d;};
  let d;
  try {
    d=open();d.pragma('foreign_keys=ON');
    d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT '2026-09-19T00:00:00Z')");
    for(const migration of ALL_MIGRATIONS.filter(m=>m.version<=baseVersion)) {
      if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);})();
      if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    seedHousehold(d);if(baseVersion===10039)seedExistingRotations(d);
    for(const table of ['task_recurrence_series','task_assignments','workflow_instances','workflow_instance_tasks','meal_plans','meal_occurrence_assignments','task_supervision_actions','task_documents','task_activity_events','availability_periods','availability_rules','user_skill_proficiency','reward_ledger']) {
      assert.ok(d.prepare(`SELECT count(*) n FROM ${table}`).get().n>0,`${table} must be populated before upgrade`);
    }
    assert.deepEqual(d.pragma('foreign_key_check'),[]);
    const before=snapshot(d);d.close();
    assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\u0000','fixture must be encrypted');
    const boot=()=>{
      const result=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.init();console.log('SCHEMA',db.currentVersion());db.get().close();"],
        {cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:60000,env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:key,LOG_LEVEL:'info',NODE_ENV:'test'}});
      assert.equal(result.status,0,result.stdout+result.stderr);
      assert.match(result.stdout+result.stderr,/SCHEMA 10042/);
      return [...(result.stdout+result.stderr).matchAll(/Migration (\d+) applied:/g)].map(match=>Number(match[1]));
    };
    assert.deepEqual(boot(),baseVersion===10038?[10039,10040,10041,10042]:[10040,10041,10042]);
    d=open();assertPreserved(d,before,baseVersion);
    for(const table of ['rotation_group_schedules','rotation_group_schedule_versions','rotation_group_periods','task_rotation_periods','rotation_group_independent_seeds','rotation_occurrence_supersessions']) {
      assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,`${table}: upgrading must not infer shared ownership from old records`);
    }
    const afterHistory=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.equal(afterHistory.length,before.tables.schema_migrations.rows.length+(baseVersion===10038?4:3));
    if(baseVersion===10039) {
      assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,3);
      assert.equal(d.prepare('SELECT response_json FROM rotation_workflow_requests').get().response_json,'{"id":1,"occurrence_id":903}');
      assert.equal(d.prepare('SELECT rotation_occurrence_id FROM meal_occurrence_assignments WHERE id=901').get().rotation_occurrence_id,902);
    }
    d.close();assert.deepEqual(boot(),[]);
    d=open({readonly:true});assertPreserved(d,before,baseVersion);
    assert.equal(d.prepare('SELECT max(version) v FROM schema_migrations').get().v,10042);
    assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),afterHistory);
  } finally {if(d?.open)d.close();rmSync(directory,{recursive:true,force:true});}
});
