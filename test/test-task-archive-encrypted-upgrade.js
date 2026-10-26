import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3-multiple-ciphers';

// Synthetic rehearsal only. The key is deliberately local to this disposable
// fixture, and no production database or credential is opened.
const scratch=mkdtempSync(join(tmpdir(),'vidamia-archive-upgrade-'));
const key='Synthetic-archive-rehearsal-key-2026-only';
process.env.DB_PATH=join(scratch,'module-guard.db');
process.env.DB_ENCRYPTION_KEY=key;
process.env.SESSION_SECRET='synthetic-archive-rehearsal-session-only';
const migrationModule=await import('../server/db.js');
const {ALL_MIGRATIONS}=migrationModule;
// db.js initializes its configured connection at import time. Its disposable
// module guard is not part of this rehearsal and must not hold files open.
migrationModule.get().close();

function open(file,{readonly=false}={}){
  const d=new Database(file,{readonly,fileMustExist:readonly});
  d.pragma("cipher='sqlcipher'");
  d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);
  if(readonly)d.pragma('query_only=ON');
  else d.pragma('foreign_keys=ON');
  return d;
}

function migrate(d,migration){
  if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
  try{
    d.transaction(()=>{
      if(typeof migration.up==='function')migration.up(d);
      else d.exec(migration.up);
      migration.afterUp?.(d);
      d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)')
        .run(migration.version,migration.description);
    })();
  }finally{if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
}

const schema=d=>d.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
const upgradeWithApplication=file=>{
  const moduleUrl=new URL('../server/db.js',import.meta.url).href;
  const script=`import {get,currentVersion} from ${JSON.stringify(moduleUrl)};
    if(currentVersion()!==10080)throw Error('Unexpected migrated schema: '+currentVersion());
    get().close();`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:key},encoding:'utf8',timeout:30000,
  });
  assert.equal(result.status,0,`Application migration failed: ${result.stderr?.slice(-1000)}`);
};
const audit=d=>{
  assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
  return {
    task:d.prepare('SELECT id,title,status,archived_at FROM tasks WHERE title=?').get('Synthetic closed work'),
    completion:d.prepare('SELECT task_id,series_id,user_id,completed_at FROM task_completions').all(),
    reward:d.prepare('SELECT user_id,delta,type,task_id FROM reward_ledger').all(),
  };
};

test('encrypted schema 10067 backup upgrades on a copy and restores exactly',async()=>{
  const sourcePath=join(scratch,'source.db'),backupPath=join(scratch,'backup.db');
  const upgradedPath=join(scratch,'upgrade.db'),rolledBackPath=join(scratch,'rollback.db');
  let source,upgraded,rolledBack;
  try{
    source=open(sourcePath);
    source.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))");
    for(const migration of ALL_MIGRATIONS.filter(row=>row.version<=10067))migrate(source,migration);
    assert.equal(schema(source),10067);
    source.pragma('journal_mode=WAL');
    source.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'Synthetic owner','Synthetic owner','x','admin','parent')").run();
    const taskId=Number(source.prepare("INSERT INTO tasks(title,category,status,created_by,assigned_to,archived_at) VALUES('Synthetic closed work','misc','done',1,1,'2026-09-01T00:00:00Z')").run().lastInsertRowid);
    source.prepare("INSERT INTO task_completions(task_id,series_id,user_id,completed_at) VALUES(?,?,1,'2026-09-01T00:00:00Z')").run(taskId,taskId);
    source.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id,created_by) VALUES(1,3,'earn',?,1)").run(taskId);
    const original=audit(source);

    // The supported encrypted backup path uses VACUUM INTO. Keep the source
    // connection open to exercise its consistent online snapshot behavior.
    source.prepare('VACUUM INTO ?').run(backupPath);
    assert.notEqual(readFileSync(backupPath).subarray(0,16).toString(),'SQLite format 3\0');
    copyFileSync(backupPath,upgradedPath);
    upgradeWithApplication(upgradedPath);
    upgraded=open(upgradedPath,{readonly:true});
    assert.equal(schema(upgraded),10080);
    assert.deepEqual(audit(upgraded),original);
    assert.equal(upgraded.prepare('SELECT auto_archive_after FROM tasks WHERE id=?').get(taskId).auto_archive_after,null);
    upgraded.close();upgraded=null;
    upgradeWithApplication(upgradedPath); // restarting must not replay migrations
    upgraded=open(upgradedPath,{readonly:true});
    assert.equal(schema(upgraded),10080);
    assert.deepEqual(audit(upgraded),original);
    upgraded.close();upgraded=null;

    // A rollback restores the whole encrypted backup, including the old
    // schema and triggers. A binary-only rollback is deliberately not used.
    copyFileSync(backupPath,rolledBackPath);
    rolledBack=open(rolledBackPath,{readonly:true});
    assert.equal(schema(rolledBack),10067);
    assert.deepEqual(audit(rolledBack),original);
    assert.equal(rolledBack.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'task_list_%'").get().n,0);
  }finally{
    rolledBack?.close();upgraded?.close();source?.close();
    rmSync(scratch,{recursive:true,force:true});
  }
});
