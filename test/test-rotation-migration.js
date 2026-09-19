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

test('encrypted production-shaped 10038 -> 10039 preserves all existing rows, indexes, triggers, foreign keys and restart history',()=>{
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
    // Existing independent series definitions are durable data, not reconstructed by 10039.
    initializeTaskSeries(d);
    const tables=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    const before=Object.fromEntries(tables.map(table=>[table,{columns:d.pragma(`table_info(${table})`).map(row=>row.name),rows:d.prepare(`SELECT * FROM "${table}"`).all()}]));
    const artifacts=d.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
    const history=before.schema_migrations.rows;assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();
    assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\u0000');
    const boot=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.init();console.log('SCHEMA',db.currentVersion());db.get().close();"],
      {cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:60000,env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:key,LOG_LEVEL:'info',NODE_ENV:'test'}});
      assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
    const initial=boot();assert.deepEqual([...initial.matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1])),[10039]);
    d=open();
    for(const [table,snapshot] of Object.entries(before)){
      const rows=d.prepare(`SELECT ${snapshot.columns.map(c=>`"${c}"`).join(',')} FROM "${table}" ${table==='schema_migrations'?'WHERE version<=10038':''}`).all();
      assert.equal(hash(rows),hash(snapshot.rows),`${table} contents must be preserved`);
    }
    for(const artifact of artifacts)assert.equal(d.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(artifact.name)?.sql,artifact.sql,artifact.name);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
    assert.equal(d.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('household_variable_definitions').seq,40);
    for(const table of ['tasks','activity_templates','workflow_templates'])assert.ok(d.prepare(`SELECT rotation_bindings_json FROM ${table}`).all().every(row=>row.rotation_bindings_json==='[]'));
    for(const table of ['rotation_groups','rotation_tracks','rotation_occurrences'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
    const afterHistory=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();assert.equal(afterHistory.length,history.length+1);d.close();
    assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1])),[]);
    d=open({readonly:true});assert.equal(d.prepare('SELECT max(version) v FROM schema_migrations').get().v,10039);assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),afterHistory);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();
  }finally{if(d?.open)d.close();rmSync(directory,{recursive:true,force:true});}
});
