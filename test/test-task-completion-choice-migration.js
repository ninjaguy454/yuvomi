import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');

test('10079 converts legacy status without changing progress, history, credits, receipts or recurrence',async()=>{
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  try {
    for(const m of ALL_MIGRATIONS.filter(row=>row.version<10079)){
      if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
      if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'synthetic','Synthetic','x','admin');
      INSERT INTO reward_participants(user_id,enabled) VALUES(1,1);
      INSERT INTO tasks(id,title,created_by,assigned_to,status,points,scoring_mode,closed_incomplete_at) VALUES
        (1,'Legacy closure',1,1,'closed_incomplete',5,'whole_task','2026-10-01T12:00:00Z'),
        (4,'Existing completion',1,1,'done',2,'whole_task',NULL);
      INSERT INTO tasks(id,title,created_by,parent_task_id,status,points) VALUES(2,'Earned child',1,1,'done',2),(3,'Remaining child',1,1,'open',3);
      INSERT INTO task_incomplete_closures(task_id,first_closed_at,recurrence_closed_at,recurrence_handled) VALUES(1,'2026-10-01T12:00:00Z','2026-10-01T12:00:00Z',1);
      INSERT INTO task_close_receipts VALUES('user:1','legacy-operation','legacy-hash',1,'close','2026-10-01T12:00:00Z');
      INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(1,1,1,'closed_incomplete','{"points_awarded":0}');
      INSERT INTO reward_ledger(user_id,delta,type,task_id,created_by) VALUES(1,2,'earn',2,1);
      INSERT INTO task_completions(task_id,series_id,user_id) VALUES(4,4,1);`);
    const tables=['task_incomplete_closures','task_close_receipts','task_activity_events','reward_ledger','reward_task_awards','task_completions','task_scoring_settlements','task_scoring_completion_events','task_recurrence_occurrences'];
    const before=Object.fromEntries(tables.map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()]));
    const children=d.prepare('SELECT * FROM tasks WHERE parent_task_id=1').all();
    const migration=ALL_MIGRATIONS.find(row=>row.version===10079);assert.ok(migration);
    d.transaction(()=>migration.up(d))();
    const root=d.prepare('SELECT * FROM tasks WHERE id=1').get();
    assert.equal(root.status,'done');assert.equal(root.completion_kept_subtasks,1);assert.equal(root.closed_incomplete_at,'2026-10-01T12:00:00Z');
    for(const [i,child] of d.prepare('SELECT * FROM tasks WHERE parent_task_id=1 ORDER BY id').all().entries()){
      const {completion_kept_subtasks,...old}=child;assert.equal(completion_kept_subtasks,0);assert.deepEqual(old,children[i]);
    }
    for(const table of tables)assert.deepEqual(d.prepare(`SELECT * FROM ${table}`).all(),before[table],table);
    const {awardForCompletion}=await import('../server/services/rewards.js');
    assert.equal(awardForCompletion(d,1,1),false,'Legacy status conversion must not become an unclaimed root award');
    assert.deepEqual(d.prepare('SELECT * FROM reward_ledger').all(),before.reward_ledger);
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=4').get().status,'done');
    assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
  } finally {d.close();}
});

test('encrypted deployed 10070 database upgrades once and preserves legacy closure provenance on reboot',()=>{
  const directory=mkdtempSync(join(tmpdir(),'vidamia-completion-choice-')),path=join(directory,'synthetic.db'),key=randomBytes(32).toString('hex');
  const open=()=>{const d=new Database(path);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);d.pragma('foreign_keys=ON');return d;};
  let d;
  try {
    d=open();d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT)');
    for(const m of ALL_MIGRATIONS.filter(row=>row.version<=10070)){
      if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);d.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version,m.description,'2026-10-18T00:00:00Z');})();
      if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'synthetic','Synthetic','x','admin');
      INSERT INTO tasks(id,title,created_by,status,points,scoring_mode,closed_incomplete_at) VALUES(1,'Legacy encrypted closure',1,'closed_incomplete',5,'whole_task','2026-10-01T12:00:00Z');
      INSERT INTO tasks(id,title,created_by,status,parent_task_id) VALUES(2,'Saved encrypted progress',1,'open',1);
      INSERT INTO task_incomplete_closures(task_id,first_closed_at,recurrence_closed_at,recurrence_handled) VALUES(1,'2026-10-01T12:00:00Z','2026-10-01T12:00:00Z',1);
      INSERT INTO task_close_receipts VALUES('user:1','encrypted-operation','encrypted-hash',1,'close','2026-10-01T12:00:00Z');
      INSERT INTO task_comments(task_id,user_id,comment) VALUES(1,1,'Preserved synthetic discussion');`);
    const snapshot=()=>Object.fromEntries(['task_incomplete_closures','task_close_receipts','task_comments','task_completions','reward_ledger','task_activity_events'].map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()]));
    const before=snapshot();d.close();d=null;
    assert.notEqual(readFileSync(path).subarray(0,16).toString(),'SQLite format 3\0');
    const boot=()=>{
      const result=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.get().close();"],{cwd:new URL('..',import.meta.url),windowsHide:true,encoding:'utf8',timeout:60000,env:{...process.env,DB_PATH:path,DB_ENCRYPTION_KEY:key,LOG_LEVEL:'info',NODE_ENV:'test'}});
      assert.equal(result.status,0,result.stdout+result.stderr);
      return [...(result.stdout+result.stderr).matchAll(/Migration (\d+) applied:/g)].map(row=>Number(row[1]));
    };
    assert.deepEqual(boot(),[10071,10072,10073,10074,10075,10076,10077,10078,10079,10080]);d=open();assert.deepEqual(snapshot(),before);
    assert.equal(d.prepare('SELECT status,completion_kept_subtasks FROM tasks WHERE id=1').get().status,'done');
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=2').get().status,'open');
    assert.equal(d.prepare('SELECT legacy_incomplete,completion_recorded,recurrence_handled FROM task_completion_choices WHERE task_id=1').get().completion_recorded,0);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
    d.close();d=null;assert.deepEqual(boot(),[]);d=open();assert.deepEqual(snapshot(),before);
  } finally {d?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(directory.startsWith(join(tmpdir(),'vidamia-completion-choice-')));rmSync(directory,{recursive:true,force:true});}
});
