import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='reward-migration-test';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {awardForCompletion}=await import('../server/services/rewards.js');

test('production-shaped 10033 upgrade preserves every ledger row and backfills one receipt per distinct recurrence; restart does not replay',()=>{
  const directory=mkdtempSync(join(tmpdir(),'vidamia-rewards-upgrade-')),path=join(directory,'fixture.db');let d;
  try {
    d=new Database(path);d.pragma('foreign_keys=ON');
    d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    for(const migration of ALL_MIGRATIONS.filter(m=>m.version<=10033)) {
      typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);
      d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);
    }
    const a=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('Grace','Grace','x','member')").run().lastInsertRowid);
    d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(a);
    const add=d.prepare("INSERT INTO tasks(id,title,created_by,assigned_to,points,status,is_recurring,start_date,due_date,recurrence_origin_id) VALUES(?,'Laundry',?,?,5,'done',1,?,?,?)");
    let origin=null;
    for(const [id,date] of [[81,'2026-09-12'],[121,'2026-09-18'],[130,'2026-09-25']]) {
      add.run(id,a,a,date,date,origin);origin=id;
      d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,a);
      d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id,created_by,reason) VALUES(?,5,'earn',?,?,'Laundry')").run(a,id,a);
    }
    const before=d.prepare('SELECT * FROM reward_ledger ORDER BY id').all();
    const previousMigrations=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();d.close();d=null;
    const startup=()=>{
      const env={...process.env,DB_PATH:path,LOG_LEVEL:'info'};delete env.DB_ENCRYPTION_KEY;
      const result=spawnSync(process.execPath,['--input-type=module','-e','await import("./server/db.js");'],{
        cwd:fileURLToPath(new URL('..',import.meta.url)),env,encoding:'utf8',timeout:30000});
      assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;
    };
    const output=startup(),expected=ALL_MIGRATIONS.filter(m=>m.version>10033).map(m=>m.version);
    assert.deepEqual([...output.matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1])),expected);
    d=new Database(path);assert.deepEqual(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),before);
    assert.deepEqual(d.prepare('SELECT task_id FROM reward_task_awards ORDER BY task_id').all(),[{task_id:81},{task_id:121},{task_id:130}]);
    assert.deepEqual(d.prepare('SELECT * FROM schema_migrations WHERE version<=10033 ORDER BY version').all(),previousMigrations);
    assert.equal(awardForCompletion(d,81,a),false);assert.deepEqual(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),before);
    const migrated=d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();d.close();d=null;
    assert.doesNotMatch(startup(),/Migration \d+ applied:/);
    d=new Database(path);assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),migrated);
    assert.deepEqual(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),before);assert.deepEqual(d.pragma('foreign_key_check'),[]);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
  } finally {d?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});
