import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='series-migration-test';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');

for(const baseVersion of [10036,10037])test(`encrypted ${baseVersion} migrates independent series definitions once without changing Tasks, templates, history or awards`,()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'task-series-10038-'));
  const databasePath=path.join(directory,'database.db'),key=randomBytes(32).toString('hex');
  const open=(options={})=>{const d=new Database(databasePath,options);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);return d;};
  try {
    const d=open();d.pragma('foreign_keys=ON');
    d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT '2026-09-18T00:00:00Z')");
    for(const m of ALL_MIGRATIONS.filter(row=>row.version<=baseVersion)){
      if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);})();
      if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'child','Learner','x','member')");
    d.exec("INSERT INTO activity_templates(id,name,title_template,created_by,assignment_policy,assignment_strategy,fixed_user_id,start_time,due_time) VALUES(1,'Morning','Morning',1,'fixed','fixed',2,'07:00','08:00')");
    if(baseVersion>=10037)d.exec('UPDATE activity_templates SET due_date_offset_days=0');
    const task=d.prepare(`INSERT INTO tasks(id,title,created_by,assigned_to,is_recurring,recurrence_rule,start_date,start_time,due_date,due_time,status,recurrence_origin_id)
      VALUES(?,?,1,2,1,'FREQ=DAILY',?,'07:00',?,'08:00',?,?)`);
    task.run(1,'Grace original','2026-09-17','2026-09-17','done',null);
    task.run(2,'Grace current','2026-09-18','2026-09-18','open',1);
    task.run(3,'Eleanor current','2026-09-18','2026-09-18','open',null);
    task.run(4,'Frankie current','2026-09-18','2026-09-18','open',null);
    if(baseVersion>=10037)d.exec('UPDATE tasks SET due_date_offset_days=0');
    for(const id of [1,2,3,4])d.prepare('INSERT INTO task_activity_bindings(task_id,activity_template_id) VALUES(?,1)').run(id);
    d.exec("INSERT INTO tasks(id,title,created_by,parent_task_id,status) VALUES(5,'Preserved completed step',1,1,'done'),(6,'Current step',1,2,'open')");
    d.exec("INSERT INTO task_comments(task_id,user_id,comment) VALUES(1,1,'Historical note')");
    d.exec("INSERT INTO task_completions(task_id,series_id,user_id) VALUES(1,1,2)");
    d.exec("INSERT INTO reward_ledger(user_id,delta,type,task_id,reason,created_by) VALUES(2,2,'earn',1,'Morning',1)");
    const snapshots=Object.fromEntries(['tasks','activity_templates','task_comments','task_completions','task_activity_events','reward_ledger','schema_migrations']
      .map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()]));
    d.close();
    assert.notEqual(readFileSync(databasePath).subarray(0,16).toString(),'SQLite format 3\u0000');
    const boot=()=>{
      const child=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.init();console.log('SCHEMA',db.currentVersion());db.get().close();"],
        {cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:60000,env:{...process.env,LOG_LEVEL:'info',DB_PATH:databasePath,DB_ENCRYPTION_KEY:key,NODE_ENV:'test'}});
      assert.equal(child.status,0,child.stdout+child.stderr);return child.stdout+child.stderr;
    };
    assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(row=>Number(row[1])),baseVersion===10036?[10037,10038]:[10038]);
    const migrated=open({readonly:true});
    for(const table of ['tasks','activity_templates','task_comments','task_completions','task_activity_events','reward_ledger']) {
      const columns=Object.keys(snapshots[table][0]||{});
      assert.deepEqual(migrated.prepare(`SELECT ${columns.length?columns.join(','):'*'} FROM ${table}`).all(),snapshots[table],table);
    }
    assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=?').all(baseVersion),snapshots.schema_migrations);
    assert.equal(migrated.prepare('SELECT due_date_offset_days FROM activity_templates WHERE id=1').get().due_date_offset_days,0);
    assert.equal(migrated.prepare('SELECT due_date_offset_days FROM tasks WHERE id=1').get().due_date_offset_days,baseVersion===10036?null:0);
    assert.equal(migrated.prepare('SELECT COUNT(*) n FROM task_recurrence_series').get().n,3);
    const definitions=migrated.prepare('SELECT definition_json FROM task_recurrence_definitions ORDER BY series_id').all().map(row=>JSON.parse(row.definition_json));
    assert.deepEqual(definitions.map(value=>value.task.title),['Grace current','Eleanor current','Frankie current']);
    assert.ok(definitions.every(value=>value.binding.snapshot.fixed_user_id===2));
    assert.equal(migrated.prepare('SELECT COUNT(*) n FROM task_recurrence_occurrences WHERE materialized_revision IS NOT NULL').get().n,0,'legacy futures have no invented untouched baseline');
    assert.equal(migrated.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(migrated.pragma('foreign_key_check'),[]);
    const history=migrated.prepare('SELECT * FROM schema_migrations').all(),versions=migrated.prepare('SELECT * FROM task_recurrence_definitions').all();migrated.close();
    assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(row=>Number(row[1])),[]);
    const restarted=open({readonly:true});assert.deepEqual(restarted.prepare('SELECT * FROM schema_migrations').all(),history);
    assert.deepEqual(restarted.prepare('SELECT * FROM task_recurrence_definitions').all(),versions);restarted.close();
  } finally {rmSync(directory,{recursive:true,force:true});}
});
