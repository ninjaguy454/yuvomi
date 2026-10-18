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

test('encrypted 10063 upgrade preserves every old row, reference, trigger, index and sequence without replay',()=>{
  const directory=mkdtempSync(join(tmpdir(),'vidamia-close-upgrade-')),databasePath=join(directory,'synthetic.db'),key=randomBytes(32).toString('hex');
  const quote=value=>'"'+value.replaceAll('"','""')+'"';
  const canonical=rows=>rows.map(row=>JSON.stringify(row)).sort();
  const open=()=>{const d=new Database(databasePath);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);d.pragma('foreign_keys=ON');return d;};
  let d;
  try {
    d=open();d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT)');
    for(const migration of ALL_MIGRATIONS.filter(row=>row.version<=10063)){
      if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);d.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version,migration.description,'2026-10-18T00:00:00Z');})();
      if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'synthetic','Synthetic','x','admin');
      INSERT INTO tasks(id,title,created_by,status,points) VALUES(1,'Earned work',1,'done',2),(2,'Unfinished activity',1,'in_progress',5);
      INSERT INTO tasks(id,title,created_by,parent_task_id,status,points) VALUES(3,'Finished step',1,2,'done',2),(4,'Unchecked step',1,2,'open',3),(9000,'High water',1,NULL,'open',0);
      DELETE FROM tasks WHERE id=9000;
      INSERT INTO task_assignments(task_id,user_id) VALUES(2,1);
      INSERT INTO task_comments(task_id,user_id,comment) VALUES(2,1,'Preserved synthetic evidence');
      INSERT INTO task_completions(task_id,series_id,user_id) VALUES(1,1,1);
      INSERT INTO reward_ledger(user_id,delta,type,task_id,reason,created_by) VALUES(1,2,'earn',3,'Synthetic earned points',1);`);
    const tables=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' ORDER BY name").all().map(row=>row.name);
    const prior=Object.fromEntries(tables.map(name=>[name,{columns:d.pragma(`table_info(${quote(name)})`).map(row=>row.name),rows:d.prepare(`SELECT * FROM ${quote(name)}`).all()}]));
    const objects=d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY name").all();
    d.close();d=null;assert.notEqual(readFileSync(databasePath).subarray(0,16).toString(),'SQLite format 3\0');
    const boot=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js');db.get().close();"],{cwd:new URL('..',import.meta.url),windowsHide:true,encoding:'utf8',timeout:60000,env:{...process.env,DB_PATH:databasePath,DB_ENCRYPTION_KEY:key,LOG_LEVEL:'info',NODE_ENV:'test'}});assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
    assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(row=>Number(row[1])),[10064]);
    d=open();
    for(const [name,snapshot] of Object.entries(prior))assert.deepEqual(canonical(d.prepare(`SELECT ${snapshot.columns.map(quote).join(',')} FROM ${quote(name)}`).all()),canonical(snapshot.rows),name);
    for(const object of objects)assert.deepEqual(d.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?').get(object.name),object,object.name);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_incomplete_closures').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_close_receipts').get().n,0);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
    assert.equal(Number(d.prepare("INSERT INTO tasks(title,created_by) VALUES('After upgrade',1)").run().lastInsertRowid),9001);
    d.close();d=null;assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(row=>Number(row[1])),[]);
    d=open();assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=4').get().status,'open');
  } finally {d?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(directory.startsWith(join(tmpdir(),'vidamia-close-upgrade-')));rmSync(directory,{recursive:true,force:true});}
});
