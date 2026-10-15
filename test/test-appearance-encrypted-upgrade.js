import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

// Synthetic databases only; prove the actual encrypted startup and restore path.
const directory=mkdtempSync(join(tmpdir(),'vidamia-appearance-upgrade-'));
const filename=join(directory,'appearance.db'),baselineBackup=join(directory,'baseline10058.db'),newBackup=join(directory,'candidate10059.db');
const key='synthetic-appearance-encryption-10059';
process.env.DB_PATH=':memory:';delete process.env.DB_ENCRYPTION_KEY;process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const candidateVersion=Math.max(...ALL_MIGRATIONS.map(migration=>migration.version));
function open(file){const d=new Database(file);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from(key,'utf8').toString('hex')}'"`);d.pragma('foreign_keys=ON');return d;}
function snapshot(d){
  const tables=d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(row=>!['task_assignee_policies','task_direct_assignees','task_scoring_completion_events'].includes(row.name));
  return Object.fromEntries(tables.map(({name})=>{
    const rows=d.prepare(`SELECT * FROM "${name}"`).all().filter(row=>name!=='schema_migrations'||row.version<=10058);
    const values=rows.map(row=>{
      const fields=Object.entries(row).filter(([field])=>!['card_color','card_color_choice','card_color_slot','max_assignees'].includes(field));
      return JSON.stringify(Object.fromEntries(fields.sort(([a],[b])=>a.localeCompare(b))));
    });
    return[name,values.sort()];
  }));
}
function encrypted(file){assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\0');}
function emptyCompletionAudit(d){assert.equal(d.prepare('SELECT count(*) n FROM task_scoring_completion_events').get().n,0);}

test('encrypted10058 upgrade, reopen and old/new backup restore conserve every existing table row and revision',async()=>{
  const seed=open(filename);
  seed.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')))");
  for(const migration of ALL_MIGRATIONS.filter(m=>m.version<=10058)){
    if(migration.foreignKeysOff)seed.pragma('foreign_keys=OFF');
    seed.transaction(()=>{typeof migration.up==='function'?migration.up(seed):seed.exec(migration.up);migration.afterUp?.(seed);seed.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);})();
    if(migration.foreignKeysOff)seed.pragma('foreign_keys=ON');
  }
  seed.exec(`INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'Synthetic parent','Synthetic parent','synthetic','admin','parent'),(2,'Synthetic child','Synthetic child','synthetic','member','child');
    INSERT INTO tasks(id,title,created_by,assigned_to) VALUES(1,'Legacy root',1,2);
    INSERT INTO tasks(id,title,created_by,assigned_to,parent_task_id) VALUES(2,'Legacy step',1,2,1);
    INSERT INTO task_assignments(task_id,user_id) VALUES(1,2);
    INSERT INTO notes(id,title,content,color,created_by,visibility) VALUES(1,'Legacy hex','Synthetic','#123456',1,'private');
    INSERT INTO sync_config(key,value) VALUES('task_card_color_default','{"version":1,"mode":"random"}');`);
  const before=snapshot(seed);assert.equal(seed.prepare('SELECT count(*) n FROM schema_migrations').get().n,228);
  seed.pragma('wal_checkpoint(TRUNCATE)');seed.close();copyFileSync(filename,baselineBackup);encrypted(filename);
  process.env.DB_PATH=filename;process.env.DB_ENCRYPTION_KEY=key;
  const db=await import('../server/db.js?synthetic-appearance-upgrade=1');let current=db.get();
  assert.equal(db.currentVersion(),candidateVersion);assert.equal(current.prepare('SELECT count(*) n FROM schema_migrations').get().n,ALL_MIGRATIONS.length);
  assert.deepEqual(snapshot(current),before,'upgrade neither recolors nor rewrites existing rows');
  // Later additive policy schema is checked separately, without masking any
  // historical row changes in this Appearance conservation projection.
  assert.equal(current.prepare('SELECT count(*) n FROM task_assignee_policies').get().n,0);
  assert.equal(current.prepare('SELECT count(*) n FROM task_direct_assignees').get().n,0);
  emptyCompletionAudit(current);
  assert.ok(current.prepare('SELECT max_assignees FROM task_categories').all().every(row=>row.max_assignees===null));
  assert.deepEqual(current.prepare('SELECT card_color,card_color_choice FROM tasks ORDER BY id').all(),[{card_color:null,card_color_choice:null},{card_color:null,card_color_choice:null}]);
  assert.deepEqual(current.prepare('SELECT color,card_color_slot FROM notes WHERE id=1').get(),{color:'#123456',card_color_slot:null});
  await db.backupToFile(newBackup);encrypted(newBackup);
  const reopened=open(filename);assert.deepEqual(snapshot(reopened),before);emptyCompletionAudit(reopened);assert.equal(reopened.pragma('integrity_check',{simple:true}),'ok');reopened.close();
  current.prepare("UPDATE tasks SET title='Transient synthetic edit',card_color='slot-01-v1' WHERE id=1").run();
  const restoredOld=await db.restoreFromFile(baselineBackup);assert.equal(restoredOld.schemaVersion,candidateVersion);current=db.get();
  assert.deepEqual(snapshot(current),before,'restoring10058 applies nullable schema only, even with Random household default');
  emptyCompletionAudit(current);
  assert.equal(current.prepare('SELECT card_color FROM tasks WHERE id=1').get().card_color,null);
  await db.restoreFromFile(newBackup);current=db.get();assert.deepEqual(snapshot(current),before);emptyCompletionAudit(current);assert.deepEqual(current.pragma('foreign_key_check'),[]);assert.equal(current.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(current.prepare('SELECT count(*) n FROM schema_migrations').get().n,ALL_MIGRATIONS.length);current.pragma('wal_checkpoint(TRUNCATE)');encrypted(filename);current.close();
});
