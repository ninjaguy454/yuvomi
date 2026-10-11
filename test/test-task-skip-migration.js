import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
test('encrypted 10053 upgrade preserves Task rows, references, triggers, indexes, sequence and second startup',()=>{
  const directory=mkdtempSync(join(tmpdir(),'vidamia-skip-migration-')),databasePath=join(directory,'synthetic.db'),key=randomBytes(32).toString('hex');
  const open=()=>{const d=new Database(databasePath);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);d.pragma('foreign_keys=ON');return d;};
  let d;
  try {
    d=open();d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT)');
    for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10053)){
      if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);d.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version,m.description,'2026-10-10T12:00:00Z');})();
      if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
    }
    d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'synthetic','Synthetic','x','admin');
      INSERT INTO tasks(id,title,created_by,status,points) VALUES(1,'Preserved done',1,'done',2),(2,'Preserved root',1,'open',5);
      INSERT INTO tasks(id,title,created_by,parent_task_id) VALUES(3,'Preserved step',1,2),(10000,'Deleted high water',1,NULL);
      DELETE FROM tasks WHERE id=10000;
      INSERT INTO task_comments(task_id,user_id,comment) VALUES(1,1,'Synthetic history');
      INSERT INTO task_assignments(task_id,user_id) VALUES(2,1);
      INSERT INTO task_completions(task_id,series_id,user_id) VALUES(1,1,1);
      INSERT INTO reward_ledger(user_id,delta,type,task_id,reason,created_by) VALUES(1,2,'earn',1,'Synthetic award',1);`);
    const tables=['tasks','task_comments','task_assignments','task_completions','reward_ledger','task_change_clock'];
    const snapshots=Object.fromEntries(tables.map(t=>[t,d.prepare(`SELECT * FROM ${t}`).all()]));
    const schema=d.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
    d.close();d=null;
    assert.notEqual(readFileSync(databasePath).subarray(0,16).toString(),'SQLite format 3\0');
    const boot=()=>{const r=spawnSync(process.execPath,['--input-type=module','-e',"const db=await import('./server/db.js'); console.log('SCHEMA',db.currentVersion());db.get().close();"],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:60000,env:{...process.env,LOG_LEVEL:'info',DB_PATH:databasePath,DB_ENCRYPTION_KEY:key,NODE_ENV:'test'}});assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout+r.stderr;};
    const expectedUpgrade=ALL_MIGRATIONS.filter(m=>m.version>10053).map(m=>m.version);
    assert.equal(expectedUpgrade[0],10054,'Skip remains the first upgrade from 10053');
    assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1])),expectedUpgrade);
    d=open();
    for(const table of tables){const cols=Object.keys(snapshots[table][0]||{});assert.deepEqual(d.prepare(`SELECT ${cols.length?cols.join(','):'*'} FROM ${table}`).all(),snapshots[table],table);}
    for(const before of schema)assert.deepEqual(d.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(before.name),before,before.name);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
    assert.equal(Number(d.prepare("INSERT INTO tasks(title,created_by) VALUES('New synthetic row',1)").run().lastInsertRowid),10001);
    d.prepare("UPDATE tasks SET status='skipped',skipped_at='2026-10-10T12:00:00Z' WHERE id=2").run();
    assert.throws(()=>d.prepare("UPDATE tasks SET status='done' WHERE id=2").run(),/Skipped Tasks/);
    d.close();d=null;assert.deepEqual([...boot().matchAll(/Migration (\d+) applied:/g)].map(m=>Number(m[1])),[]);
    d=open();assert.equal(d.prepare('SELECT status,skipped_at FROM tasks WHERE id=2').get().status,'skipped');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  } finally {d?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});
