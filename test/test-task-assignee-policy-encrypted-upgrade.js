import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3-multiple-ciphers';import {mkdtempSync,readFileSync,copyFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
process.env.DB_PATH=':memory:';delete process.env.DB_ENCRYPTION_KEY;process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {ensureSeriesDefinition}=await import('../server/services/task-series.js');
const folder=mkdtempSync(join(tmpdir(),'vidamia-count-upgrade-')),file=join(folder,'synthetic.db'),oldBackup=join(folder,'old.db'),newBackup=join(folder,'new.db'),key='synthetic-count-policy-upgrade-only';
function open(file){const d=new Database(file);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);d.pragma('foreign_keys=ON');return d;}
const encrypted=file=>assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\0');
test('encrypted10060 upgrade/reopen and supported old/new restore preserve all legacy columns, definitions and awards',async()=>{
 const seed=open(file);seed.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')))");
 for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10060)){if(m.foreignKeysOff)seed.pragma('foreign_keys=OFF');seed.transaction(()=>{typeof m.up==='function'?m.up(seed):seed.exec(m.up);m.afterUp?.(seed);seed.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);})();if(m.foreignKeysOff)seed.pragma('foreign_keys=ON');}
 seed.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'Synthetic owner','Synthetic owner','x','admin'),(2,'Synthetic A','Synthetic A','x','member'),(3,'Synthetic B','Synthetic B','x','member');
 INSERT INTO tasks(id,title,category,assigned_to,created_by,is_recurring,recurrence_rule,due_date,scoring_mode) VALUES(1,'Legacy recurring','school',2,1,1,'FREQ=DAILY','2026-11-01','whole_task');
 INSERT INTO tasks(id,title,category,assigned_to,created_by,parent_task_id) VALUES(2,'Legacy child','school',3,1,1);
 INSERT INTO tasks(id,title,category,assigned_to,created_by,status,points,scoring_mode) VALUES(3,'Completed legacy','school',2,1,'done',4,'whole_task');
 INSERT INTO task_assignments(task_id,user_id) VALUES(1,2),(1,3),(2,3),(3,2);
 INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(2,4,'earn',3);INSERT INTO reward_task_awards(task_id) VALUES(3);
 INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,participant_count) VALUES('Legacy template','Legacy template','school','eligible_round_robin','rotating_multi',2);`);
 ensureSeriesDefinition(seed,1);
 const tables=seed.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name),columns=new Map(tables.map(name=>[name,seed.prepare('PRAGMA table_info("'+name+'")').all().map(row=>row.name)]));
 const snapshot=d=>Object.fromEntries(tables.map(name=>[name,d.prepare('SELECT '+columns.get(name).map(key=>'"'+key+'"').join(',')+' FROM "'+name+'"').all().filter(row=>name!=='schema_migrations'||row.version<=10060).map(row=>JSON.stringify(row)).sort()]));
 const before=snapshot(seed);assert.equal(seed.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,10060);seed.pragma('wal_checkpoint(TRUNCATE)');seed.close();copyFileSync(file,oldBackup);encrypted(file);
 process.env.DB_PATH=file;process.env.DB_ENCRYPTION_KEY=key;const db=await import('../server/db.js?synthetic-count-upgrade=1');let current=db.get();
 const verify=()=>{assert.deepEqual(snapshot(current),before);assert.equal(db.currentVersion(),10061);assert.equal(current.prepare('SELECT count(*) n FROM task_assignee_policies').get().n,0);assert.equal(current.prepare('SELECT count(*) n FROM task_direct_assignees').get().n,0);assert.ok(current.prepare('SELECT max_assignees FROM task_categories').all().every(row=>row.max_assignees===null));assert.deepEqual(current.pragma('foreign_key_check'),[]);assert.equal(current.pragma('integrity_check',{simple:true}),'ok');};
 verify();await db.backupToFile(newBackup);encrypted(newBackup);const reopened=open(file);assert.deepEqual(snapshot(reopened),before);reopened.close();
 current.prepare("UPDATE tasks SET title='Transient synthetic' WHERE id=1").run();await db.restoreFromFile(oldBackup);current=db.get();verify();await db.restoreFromFile(newBackup);current=db.get();verify();current.pragma('wal_checkpoint(TRUNCATE)');current.close();encrypted(file);
});
