import test from 'node:test';import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const lossless=(_key,value)=>typeof value==='bigint'?{$integer:value.toString()}:value;
const quote=value=>'"'+value.replaceAll('"','""')+'"';
function snapshot(d){return Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,{
  columns:d.pragma('table_info('+quote(name)+')'),rows:JSON.parse(JSON.stringify(d.prepare('SELECT * FROM '+quote(name)).safeIntegers(true).all(),lossless)).map(row=>JSON.stringify(row)).sort(),
}]));}
test('10062 encrypted upgrade only adds empty audit state and never repairs existing household awards',()=>{
  const migration=ALL_MIGRATIONS.find(row=>row.version===10062);assert.ok(migration,'The isolated completion-state migration is registered');
  assert.deepEqual(ALL_MIGRATIONS.filter(row=>row.version>10061&&row.version<=migration.version).map(row=>row.version),[10062]);
  const directory=mkdtempSync(join(tmpdir(),'vidamia-subtask-upgrade-')),file=join(directory,'synthetic.db'),key=Buffer.from('synthetic-subtask-upgrade-key').toString('hex');let d;
  const open=readonly=>{const value=new Database(file,{readonly,fileMustExist:readonly});value.pragma("cipher='sqlcipher'");value.pragma(`key="x'${key}'"`);value.pragma('foreign_keys=ON');return value;};
  try{
    d=open(false);d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))");
    for(const m of ALL_MIGRATIONS.filter(row=>row.version<=10061)){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
    d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'Synthetic admin','Synthetic admin','x','admin'),(2,'Synthetic child','Synthetic child','x','member'); INSERT INTO reward_participants(user_id,enabled) VALUES(2,1); INSERT INTO tasks(id,title,created_by,scoring_mode) VALUES(1,'Synthetic routine',1,'subtasks'); INSERT INTO tasks(id,title,created_by,parent_task_id,points,status) VALUES(2,'Existing incomplete awarded step',1,1,7,'open'); INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(2,7,'earn',2); INSERT INTO reward_task_awards(task_id,logical_key) VALUES(2,'[\"task\",2]'); INSERT INTO sync_config(key,value) VALUES('synthetic-blob',X'0080FF'),('synthetic-int64',9223372036854775806); UPDATE task_categories SET max_assignees=1 WHERE key=(SELECT key FROM task_categories LIMIT 1)");
    const before=snapshot(d),schema=d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),sequences=d.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
    d.transaction(()=>{migration.up(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);}).immediate();
    const after=snapshot(d);assert.deepEqual(Object.keys(after).sort(),[...Object.keys(before),'task_scoring_completion_events'].sort());
    for(const name of Object.keys(before))if(name!=='schema_migrations')assert.deepEqual(after[name],before[name],name+' rows and columns unchanged');
    assert.deepEqual(after.schema_migrations.rows.filter(row=>!row.includes('"version":{"$integer":"10062"}')),before.schema_migrations.rows);
    const oldObjects=d.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '%completion_events%' ORDER BY type,name").all();assert.deepEqual(oldObjects,schema);
    assert.deepEqual(d.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),sequences);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_completion_events').get().n,0);
    assert.equal(d.prepare('SELECT SUM(delta) n FROM reward_ledger WHERE user_id=2').get().n,7,'Old affected records are preserved for a separately authorized repair');
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();d=null;
    assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\0');d=open(true);assert.equal(d.prepare('SELECT MAX(version) n FROM schema_migrations').get().n,10062);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_completion_events').get().n,0);
  }finally{d?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});
