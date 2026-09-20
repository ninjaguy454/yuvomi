import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='device-migration-synthetic-only';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {initializeTaskSeries}=await import('../server/services/task-series.js');
const R=await import('../server/services/rotation.js');
const S=await import('../server/services/rotation-shared.js');
const {createDevice,deviceHash}=await import('../server/services/devices.js');
const digest=rows=>createHash('sha256').update(JSON.stringify(rows.map(row=>JSON.stringify(row)).sort())).digest('hex');

function seed(d){
 d.exec(`INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES
  (1,'parent','Parent','fixture-password-hash','admin','parent'),(2,'grace','Grace','fixture-child-hash','member','child'),
  (3,'eleanor','Eleanor','fixture-child-hash','member','child'),(4,'frankie','Frankie','fixture-child-hash','member','child');
  INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES
   ('role','child','module','budget','none'),('user','3','module','tasks','read');
  INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES
   ('role','child','tasks.create','none'),('user','2','tasks.claim','none');
  CREATE TABLE sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL);
  INSERT INTO sessions(sid,sess,expired_at) VALUES
   ('ordinary-parent-session','{"userId":1,"role":"admin","csrfToken":"synthetic-csrf"}',9999999999999),
   ('legacy-wall-session','{"userId":1,"role":"admin","wallMode":true,"csrfToken":"synthetic-wall-csrf"}',9999999999999),
   ('ordinary-child-session','{"userId":2,"role":"member"}',9999999999999);
  INSERT OR REPLACE INTO sync_config(key,value) VALUES
   ('household_timezone','America/New_York'),('wall_dashboard_v1','{"appearance":{"theme":"dark"},"privacy":{"showPoints":false}}'),
   ('dashboard_widgets:user:1','[{"id":"tasks","size":"large","visible":true}]'),('color_theme:user:1','warm');
  INSERT INTO activity_templates(id,name,title_template,created_by,assignment_policy,assignment_strategy,fixed_user_id,start_time,due_time,due_date_offset_days)
   VALUES(1,'Bedtime','Bedtime',1,'fixed','fixed',2,'20:00','21:00',0);
  INSERT INTO tasks(id,title,created_by,assigned_to,is_recurring,recurrence_rule,start_date,start_time,due_date,due_time,status,due_date_offset_days,points)
   VALUES(1,'Completed routine',1,2,1,'FREQ=DAILY','2026-09-17','20:00','2026-09-17','21:00','done',0,2),
   (2,'Progressed routine',1,2,1,'FREQ=DAILY','2026-09-19','20:00','2026-09-19','21:00','in_progress',0,2),
   (3,'Expired routine',1,2,1,'FREQ=DAILY','2026-09-18','20:00','2026-09-18','21:00','expired',0,2);
  INSERT INTO tasks(id,title,created_by,parent_task_id,status,is_optional,assigned_to) VALUES
   (4,'Completed supervised action',1,2,'done',0,2),(5,'Optional action',1,2,'open',1,2),
   (6,'Generated helper',1,NULL,'in_progress',0,1),(7,'Completed helper evidence',1,6,'done',0,1);
  INSERT INTO task_assignments(task_id,user_id) VALUES(1,2),(2,2),(3,2),(4,2),(5,2),(6,1),(7,1);
  INSERT INTO task_activity_bindings(task_id,activity_template_id) VALUES(1,1),(2,1),(3,1);
  INSERT INTO task_comments(task_id,user_id,comment) VALUES(1,1,'Completed evidence'),(2,1,'Preserve progress');
  INSERT INTO task_completions(task_id,series_id,user_id) VALUES(1,1,2);
  INSERT INTO reward_participants(user_id,enabled) VALUES(2,1),(3,1),(4,1);
  INSERT INTO reward_catalog(id,name,cost,created_by) VALUES(1,'Synthetic reward',2,1);
  INSERT INTO reward_ledger(user_id,delta,type,task_id,reason,created_by) VALUES(2,2,'earn',1,'Completed routine',1);
  INSERT INTO skills(id,name,created_by) VALUES(901,'Safety',1);
  INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(1,901,'normal','manual',1),(2,901,'supervised','manual',1);
  INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(4,901);
  INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(1,901);
  INSERT INTO places(id,name,type,created_by) VALUES(901,'Home','home',1);
  INSERT INTO availability_periods(user_id,source,state,place_id,starts_at,ends_at,note,created_by) VALUES
   (1,'manual','available',901,'2026-09-19T23:00:00Z','2026-09-20T02:00:00Z','Supervisor home',1);
  INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,place_id,created_by)
   VALUES(2,'Evening','[0,1,2,3,4,5,6]','20:00','22:00','available',901,1);
  INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(2,6);
  INSERT INTO task_responsibilities(task_id,user_id,role,status,source) VALUES(2,1,'supervisor','active','skill'),(4,2,'learner','fulfilled','skill');
  INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,required_skill_ids_json,state,execution_mode)
   VALUES(2,4,7,2,1,'[901]','assigned','supervised');
  INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json,created_at) VALUES
   (2,4,1,'supervision_completed','{"learner_user_id":2,"supervisor_user_id":1,"counterpart_task_id":7}','2026-09-19T23:30:00.123Z'),
   (1,1,2,'completed','{"points":2,"completion_id":1}','2026-09-18T00:00:00.234Z'),
   (3,3,NULL,'expired','{"automatic":true,"points":0}','2026-09-19T01:00:00.000Z');
  INSERT INTO family_documents(id,name,category,visibility,original_name,mime_type,file_size,content_data,created_by) VALUES
   (901,'Instructions','home','family','instructions.txt','text/plain',12,'SGVsbG8gZmFtaWx5',1),
   (902,'Private evidence','home','restricted','evidence.txt','text/plain',8,'VmVyaWZpZWQ=',1);
  INSERT INTO task_documents(task_id,document_id,created_by) VALUES(2,901,1),(4,902,1);
  INSERT INTO family_document_access(document_id,user_id) VALUES(902,1),(902,2);
  INSERT INTO workflow_templates(id,name,subject_required) VALUES(1,'Evening workflow',0);
  INSERT INTO workflow_template_steps(id,workflow_template_id,activity_template_id,step_key,sort_order) VALUES(1,1,1,'bedtime',0);
  INSERT INTO workflow_instances(id,workflow_template_id,subject_user_id,parent_task_id,created_by,input_json) VALUES(1,1,2,2,1,'{"person":2}');
  INSERT INTO workflow_instance_tasks(workflow_instance_id,workflow_step_id,task_id) VALUES(1,1,4);
  INSERT INTO household_variable_definitions(id,variable_key,label,type,kind,default_value_json) VALUES(3,'person','Person','household_member','value','2');
  INSERT INTO workflow_variable_definitions(id,workflow_template_id,variable_key,label,type,scope,reusable_definition_id) VALUES(7,1,'person','Person','household_member','reusable',3);
  INSERT INTO meal_plans(id,name,description,created_by) VALUES(901,'Existing dinners','Legacy compatibility',1);
  INSERT INTO meal_plan_revisions(id,meal_plan_id,revision,snapshot_json,created_by) VALUES(901,901,1,'{"name":"Existing dinners","rotation_group":"household"}',1);
  INSERT INTO meal_plan_rules(id,meal_plan_id,weekday,meal_type,label,policy,rotation_group,cook_strategy,cook_rotation_group,supervisor_strategy)
   VALUES(901,901,6,'dinner','Chooser','round_robin','household','round_robin','household','fixed');
  INSERT INTO meal_plan_rule_participants(meal_plan_rule_id,user_id) VALUES(901,1),(901,2);
  INSERT INTO meals(id,date,meal_type,title,created_by,source,meal_plan_id,meal_plan_revision_id,meal_plan_rule_id)
   VALUES(901,'2026-09-19','dinner','Dinner',1,'schedule',901,901,901);
  INSERT INTO assignment_rotation_state(rotation_key,cursor_user_id,occurrence_count) VALUES('legacy_meal',2,4);
  INSERT INTO meal_occurrence_assignments(id,occurrence_key,meal_plan_rule_id,meal_id,assigned_user_id,base_rotation_key,scoped_rotation_key,cursor_before_user_id,cursor_after_user_id,committed,committed_at)
   VALUES(901,'fixture_dinner_2026-09-19',901,901,2,'legacy_meal','legacy_meal',1,2,1,'2026-09-19T20:00:00Z');
  INSERT INTO meal_occurrence_role_assignments(occurrence_assignment_id,role,strategy,assigned_user_id,committed,committed_at)
   VALUES(901,'supervisor','fixed',1,1,'2026-09-19T20:00:00Z');`);
 initializeTaskSeries(d);
 const independent=R.saveRotationGroup(d,{name:'Independent Kids',member_ids:[2,3,4]},{actorId:1});
 const track=R.configureRotationTrack(d,{group_id:independent.id,consumer_type:'task',consumer_id:'1',purpose_key:'order',strategy:'rotating_order',advance_policy:'on_finalized'},{actorId:1});
 const historical=R.resolveRotation(d,track.id,'historical-owner',{actorId:1,context:{task_id:1}});
 R.finalizeRotation(d,historical.id,{actorId:1,expectedRevision:historical.revision});
 d.prepare('INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id) VALUES(1,?,?,?,1)').run('order',track.id,historical.id);
 const shared=S.saveRotationGroupUsage(d,{name:'Shared Kids',member_ids:[2,3,4],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:2,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'20:00',finalize_time:'22:00',finalize_day_offset:0,advance_on_skip:false,eligibility:{}}},{actorId:1,now:new Date('2026-09-19T19:00:00Z')});
 const active=S.resolveSharedRotation(d,shared.id,{dateKey:'2026-09-19',now:new Date('2026-09-20T01:00:00Z')});
 d.prepare('INSERT INTO task_rotation_periods(task_id,purpose_key,group_id,period_date,occurrence_id) VALUES(2,?,?,?,?)').run('shared',shared.id,'2026-09-19',active.id);
 d.prepare('INSERT INTO household_variable_definitions(variable_key,label,type,kind,default_value_json) VALUES(?,?,?,?,?)').run('order','Shared order','rotation_occurrence','value',String(active.id));
}
function snapshot(d){
 const names=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
 return {tables:Object.fromEntries(names.map(name=>[name,{columns:d.pragma(`table_info(${name})`).map(row=>row.name),rows:d.prepare(`SELECT * FROM \"${name}\"`).all()}])),
  artifacts:d.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all(),
  sequences:d.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()};
}
function preserved(d,before){
 const baseline=Math.max(...before.tables.schema_migrations.rows.map(row=>row.version));
 for(const [table,value] of Object.entries(before.tables)){
  const rows=d.prepare(`SELECT ${value.columns.map(column=>`\"${column}\"`).join(',')} FROM \"${table}\" ${table==='schema_migrations'?'WHERE version<='+baseline:''}`).all();
  assert.equal(digest(rows),digest(value.rows),`${table}: existing values and relationships preserved`);
 }
 for(const row of before.artifacts)assert.equal(d.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(row.name)?.sql,row.sql,row.name);
 for(const row of before.sequences)assert.equal(d.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(row.name)?.seq,row.seq,row.name);
 assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
}
for(const baseline of [10040,10041])test(`encrypted populated ${baseline} -> 10042 preserves sessions, devices, Wall, roles, capabilities, Tasks, supervision, rewards and both Rotation ownership models; no restart replay`,()=>{
 assert.equal(Math.max(...ALL_MIGRATIONS.map(m=>m.version)),10042,'only the expected additive migrations are in this candidate');
 const directory=mkdtempSync(join(tmpdir(),'vidamia-device-migration-')),file=join(directory,'database.db'),key=randomBytes(32).toString('hex');let d;
 const open=(options={})=>{const db=new Database(file,options);db.pragma("cipher='sqlcipher'");db.pragma(`key=\"x'${Buffer.from(key).toString('hex')}'\"`);return db;};
 try{
  d=open();d.pragma('foreign_keys=ON');d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT 'synthetic-preexisting')");
  for(const m of ALL_MIGRATIONS.filter(m=>m.version<=baseline)){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description)})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  seed(d);
  if(baseline===10041) {
   const device=createDevice(d,{name:'Existing Kitchen Wall',scope:{member_ids:[2,3,4]}},1);
   d.prepare(`INSERT INTO device_credentials(id,device_id,token_hash,context_key,temporary_sid,temporary_user_id,temporary_started_at,temporary_idle_at)
    VALUES(1,?,?,?,'existing-temporary-session',1,?,?)`).run(device.id,deviceHash('synthetic-existing-credential'),'synthetic-existing-context',Date.now(),Date.now());
   d.prepare('INSERT INTO sessions(sid,sess,expired_at) VALUES(?,?,?)').run('existing-temporary-session',JSON.stringify({userId:1,role:'admin',deviceCredentialId:1,deviceContext:'synthetic-existing-context'}),9999999999999);
   d.prepare('UPDATE task_completions SET source_device_id=?,source_device_name=? WHERE task_id=1').run(device.id,device.name);
   d.prepare('UPDATE tasks SET source_device_id=?,source_device_name=? WHERE id=2').run(device.id,device.name);
   for(const table of ['household_devices','device_credentials','device_audit_events'])assert.ok(d.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n>0,`${table}: populated 10041 fixture`);
  }
  for(const table of ['sessions','access_permissions','access_capabilities','task_completions','reward_ledger','reward_participants','task_supervision_actions','task_activity_events','task_documents','meal_occurrence_assignments','user_skill_proficiency','availability_periods','rotation_tracks','rotation_occurrences','rotation_group_periods','task_rotation_periods','task_recurrence_definitions'])assert.ok(d.prepare(`SELECT count(*) n FROM ${table}`).get().n>0,`${table} must be populated before migration`);
  const before=snapshot(d);assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();
  assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\u0000');
  const boot=()=>{
   const result=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.init();console.log('SCHEMA',db.currentVersion());db.get().close();"],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:60000,env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:key,LOG_LEVEL:'info',NODE_ENV:'test'}});
   assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout+result.stderr,/SCHEMA 10042/);
   return [...(result.stdout+result.stderr).matchAll(/Migration (\d+) applied:/g)].map(match=>Number(match[1]));
  };
  assert.deepEqual(boot(),baseline===10040?[10041,10042]:[10042]);d=open();preserved(d,before);
  assert.equal(d.pragma('table_info(tasks)').find(column=>column.name==='created_by').notnull,0,'device-created work does not require a fake human creator');
  for(const table of ['tasks','task_completions']){
   for(const column of ['source_device_id','source_device_name'])assert.ok(d.pragma(`table_info(${table})`).some(row=>row.name===column));
   assert.equal(d.prepare(`SELECT count(*) n FROM ${table} WHERE source_device_id IS NOT NULL OR source_device_name IS NOT NULL`).get().n,baseline===10041?1:0,`${table}: historical attribution is preserved`);
  }
  for(const table of ['household_devices','device_pairings','device_credentials'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,baseline===10041&&table!=='device_pairings'?1:0,`${table}: no browser or member automatically converted`);
  assert.equal(d.prepare('SELECT count(*) n FROM device_task_approvals').get().n,0,'migration never authenticates or approves an action');
  assert.equal(d.prepare('SELECT count(*) n FROM device_task_creation_receipts').get().n,0,'migration does not manufacture Task creation receipts');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,4,'no fake member created');
  const history=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();assert.equal(history.length,before.tables.schema_migrations.rows.length+(10042-baseline));
  d.close();assert.deepEqual(boot(),[]);d=open({readonly:true});preserved(d,before);assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),history);
 }finally{if(d?.open)d.close();rmSync(directory,{recursive:true,force:true});}
});
