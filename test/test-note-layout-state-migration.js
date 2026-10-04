import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-note-state-migration';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const mirror=await import('../server/db-schema-test.js');
const migration=ALL_MIGRATIONS.find(m=>m.version===10051);
function encrypted(file){const d=new Database(file);d.pragma("cipher='sqlcipher'");d.pragma(`key="x'${Buffer.from('synthetic-state-migration-key','utf8').toString('hex')}'"`);return d;}
function apply(d,m){assert.ok(m,'append-only migration 10051 exists');if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');try{d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();}finally{if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}}
function legacy(d,versions=10049){d.pragma('foreign_keys=ON');for(const m of ALL_MIGRATIONS.filter(m=>m.version<=versions))apply(d,m);d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'migration-owner','Owner','x','member'); INSERT INTO notes(id,content,title,pinned,created_by,visibility) VALUES(1,'Exact text\n- [x] Keep','Saved',1,1,'private'); INSERT INTO note_layouts(note_id,x,y,width,height,revision) VALUES(1,8,73,4,20,9)");}

for(const version of [10049,...(ALL_MIGRATIONS.some(m=>m.version===10050)?[10050]:[])])test(`migration ${version}->10051 preserves exact rows, clocks, indexes, triggers and foreign keys`,()=>{
  const d=new Database(':memory:');try{
    legacy(d,version);d.exec('CREATE INDEX idx_note_layout_y_audit ON note_layouts(y); CREATE TRIGGER trg_layout_custom_audit AFTER UPDATE OF x ON note_layouts BEGIN SELECT 1; END;');
    const note=d.prepare('SELECT * FROM notes').get(),layout=d.prepare('SELECT * FROM note_layouts').get(),clock=d.prepare('SELECT * FROM note_change_clock').get(),triggers=d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='note_layouts' ORDER BY name").all();
    apply(d,migration);assert.deepEqual(d.prepare('SELECT * FROM notes').get(),note);assert.deepEqual(d.prepare('SELECT * FROM note_layouts').get(),{...layout,position_locked:0,always_on_top:0});assert.deepEqual(d.prepare('SELECT * FROM note_change_clock').get(),clock);
    assert.deepEqual(d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='note_layouts' ORDER BY name").all(),triggers);assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_note_layout_y_audit'").get());
    d.prepare('UPDATE note_layouts SET x=10000,y=10000,width=12,height=100,position_locked=1,always_on_top=1 WHERE note_id=1').run();assert.equal(d.prepare('SELECT version FROM note_change_clock').get().version,clock.version+1);assert.equal(d.prepare('SELECT revision FROM note_layouts').get().revision,9);
    for(const sql of ['x=10001','y=10001','width=13','height=101','position_locked=2','always_on_top=-1'])assert.throws(()=>d.exec(`UPDATE note_layouts SET ${sql} WHERE note_id=1`));
    assert.throws(()=>d.exec('INSERT INTO note_layouts(note_id,x,y,width,height) VALUES(999,0,0,4,6)'));assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
    const current=d.prepare('SELECT * FROM note_layouts').get(),currentClock=d.prepare('SELECT * FROM note_change_clock').get();apply(d,migration);assert.deepEqual(d.prepare('SELECT * FROM note_layouts').get(),current);assert.deepEqual(d.prepare('SELECT * FROM note_change_clock').get(),currentClock);
    d.exec('DELETE FROM notes WHERE id=1');assert.equal(d.prepare('SELECT COUNT(*) n FROM note_layouts').get().n,0);
  }finally{d.close();}
});
test('fresh Notes layout schema mirror matches migrated schema and bounds',()=>{
  assert.equal(typeof mirror.NOTE_LAYOUTS_SCHEMA_SQL,'string','latest Notes layout schema mirror exists');const migrated=new Database(':memory:'),fresh=new Database(':memory:');
  try{legacy(migrated);apply(migrated,migration);fresh.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY);');fresh.exec(mirror.NOTE_LAYOUTS_SCHEMA_SQL);
    assert.deepEqual(fresh.pragma('table_info(note_layouts)'),migrated.pragma('table_info(note_layouts)'));assert.deepEqual(fresh.pragma('foreign_key_list(note_layouts)'),migrated.pragma('foreign_key_list(note_layouts)'));
    fresh.exec('INSERT INTO notes(id) VALUES(1); INSERT INTO note_layouts(note_id,x,y,width,height) VALUES(1,10000,10000,12,100)');assert.equal(fresh.prepare('SELECT position_locked FROM note_layouts').get().position_locked,0);
    for(const sql of ['x=10001','y=10001','width=13','height=101','position_locked=2','always_on_top=2'])assert.throws(()=>fresh.exec(`UPDATE note_layouts SET ${sql} WHERE note_id=1`));
  }finally{fresh.close();migrated.close();}
});
test('transaction rollback restores legacy table after a failed layout rebuild',()=>{
  const d=new Database(':memory:');try{legacy(d);const before=d.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='note_layouts' ORDER BY name").all();
    assert.throws(()=>d.transaction(()=>{apply(d,migration);throw new Error('Synthetic migration rollback');})(),/Synthetic migration rollback/);
    assert.deepEqual(d.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='note_layouts' ORDER BY name").all(),before);assert.equal(d.prepare('SELECT revision FROM note_layouts').get().revision,9);
  }finally{d.close();}
});
test('actual migrator applies a missing individual version below the recorded maximum and retains encrypted flags',()=>{
  assert.ok(migration,'append-only migration 10051 exists');const folder=mkdtempSync(join(tmpdir(),'notes-state-upgrade-')),file=join(folder,'synthetic.db');let d;
  try{
    d=encrypted(file);legacy(d);apply(d,migration);d.exec('UPDATE note_layouts SET x=77,position_locked=1,always_on_top=1 WHERE note_id=1; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);');
    const missing=ALL_MIGRATIONS.some(m=>m.version===10050)?10050:10049;
    for(const m of ALL_MIGRATIONS.filter(m=>m.version!==missing))d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);
    const layout=d.prepare('SELECT * FROM note_layouts').get(),clock=d.prepare('SELECT * FROM note_change_clock').get(),note=d.prepare('SELECT * FROM notes').get();d.close();d=null;
    const launched=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../server/db.js',import.meta.url).href)});`],{env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:'synthetic-state-migration-key',LOG_LEVEL:'error'},encoding:'utf8'});
    assert.equal(launched.status,0,launched.stderr||launched.stdout);d=encrypted(file);assert.ok(d.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(missing));
    if(missing===10050)assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE name='task_acceptance_receipts'").get(),'P3 installs missing10050 after P2 has49+51');
    assert.deepEqual(d.prepare('SELECT * FROM note_layouts').get(),layout);assert.deepEqual(d.prepare('SELECT * FROM notes').get(),note);assert.deepEqual(d.prepare('SELECT * FROM note_change_clock').get(),clock);assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d?.close();rmSync(folder,{recursive:true,force:true});}
});
