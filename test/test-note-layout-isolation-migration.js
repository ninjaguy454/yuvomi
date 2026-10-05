import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-owner-migration';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const migration=ALL_MIGRATIONS.find(m=>m.version===10053);
const mirror=await import('../server/db-schema-test.js');
const tables=['note_board_owners','note_board_note_layouts','note_board_groups','note_board_group_members','note_board_group_receipts'];
const apply=(d,m)=>d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
const seed=d=>({notes:d.prepare('SELECT * FROM notes ORDER BY id').all(),layouts:d.prepare('SELECT * FROM note_layouts ORDER BY note_id').all(),groups:d.prepare('SELECT * FROM note_groups ORDER BY id').all(),members:d.prepare('SELECT * FROM note_group_members ORDER BY note_id').all(),receipts:d.prepare('SELECT * FROM note_group_receipts ORDER BY principal_key,operation_id').all()});
const clock=d=>d.prepare('SELECT version FROM note_change_clock').get().version;
function legacy(d){
  d.pragma('foreign_keys=ON');for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10052))apply(d,m);
  d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'owner','Owner','x','member');
    INSERT INTO notes(id,title,content,created_by,pinned,visibility) VALUES(1,'Exact','Untouched',1,1,'private'),(2,'Shared','Shared',1,0,'all'),(3,'Other','Other',1,0,'all');
    INSERT INTO note_layouts(note_id,x,y,width,height,revision,position_locked,always_on_top) VALUES(1,1.23456789012345,0.3333333333333333,12,100,9,1,1),(2,9999.999999,0.000001,3,4,6,0,1);
    INSERT INTO note_groups(id,revision,x,y,width,height,position_locked,always_on_top) VALUES(7,15,12.125,19.875,5,8,1,1),(50,1,0,0,4,6,0,0);
    DELETE FROM note_groups WHERE id=50;
    INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(1,7,4),(2,7,1);
    INSERT INTO note_group_receipts(principal_key,operation_id,request_hash,before_json,after_json,created_at) VALUES('person:1','old-op','old-hash','{}','{}','2026-01-01T00:00:00Z');`);
}
async function owner(){assert.ok(migration,'append-only migration 10053 must exist');return import('../server/services/note-layout-owner.js');}
function fresh(){const d=new Database(':memory:');legacy(d);assert.ok(migration,'append-only migration 10053 must exist');apply(d,migration);return d;}

test('migration 10053 is appended with five owner tables and a matching latest-only mirror',()=>{
  assert.ok(migration,'append-only migration 10053 must exist');assert.equal(ALL_MIGRATIONS.at(-1).version,10053);
  const d=fresh(),f=new Database(':memory:');try{
    assert.equal(typeof mirror.NOTE_LAYOUT_OWNER_SCHEMA_SQL,'string');f.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY);');f.exec(mirror.NOTE_LAYOUT_OWNER_SCHEMA_SQL);
    for(const table of tables)for(const pragma of ['table_info','foreign_key_list','index_list'])assert.deepEqual(f.pragma(`${pragma}(${table})`),d.pragma(`${pragma}(${table})`),`${table} ${pragma}`);
  }finally{d.close();f.close();}
});

test('encrypted migration and restart preserve every legacy row, fraction, revision, receipt and clock',async()=>{
  await owner();const folder=mkdtempSync(join(tmpdir(),'note-owner-encrypted-')),file=join(folder,'synthetic.db');let d;
  const open=()=>{const db=new Database(file);db.pragma("cipher='sqlcipher'");db.pragma("key='synthetic-owner-key'");db.pragma('foreign_keys=ON');return db;};
  try{
    d=open();legacy(d);const before=seed(d),version=clock(d);apply(d,migration);assert.deepEqual(seed(d),before);assert.equal(clock(d),version);
    for(const table of tables)assert.equal(d.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
    d.close();d=open();apply(d,migration);assert.deepEqual(seed(d),before);assert.equal(clock(d),version);assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
    d.close();d=null;assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\0');
  }finally{d?.close();rmSync(folder,{recursive:true,force:true});}
});

test('owner identity uses effective server principal and stable household device id with device precedence',async()=>{
  const {noteLayoutOwnerKey:key}=await owner();assert.equal(key(12),'human:12');assert.equal(key({authUserId:12,id:99,session:{userId:33}}),'human:12');
  assert.equal(key({kind:'device',id:8,credential:{id:300}}),'device:8');
  assert.equal(key({authUserId:12,devicePrincipal:{kind:'device',id:8,contextKey:'changed',revision:99}}),'device:8');
  assert.equal(key({authUserId:12,owner_key:'device:8',layout_owner:'device:9'}),'human:12');for(const p of [null,0,-1,NaN,{}, {kind:'device',id:0}, {authUserId:12,devicePrincipal:{kind:'device'}}])assert.throws(()=>key(p));
});

test('all owner read helpers fall back without writes, then read only that initialized owner',async()=>{
  const o=await owner(),d=fresh();try{
    const before=seed(d),version=clock(d),total=d.prepare('SELECT total_changes() n').get().n;
    assert.equal(o.hasNoteLayoutOwner(d,'human:1'),false);assert.deepEqual(o.noteLayoutSource(d,'human:1'),{layouts:'note_layouts',groups:'note_groups',members:'note_group_members',ownerKey:null});
    assert.deepEqual(o.readNoteOwnerLayout(d,'human:1',1),before.layouts[0]);assert.deepEqual(o.readNoteOwnerGroup(d,'human:1',7),before.groups[0]);
    assert.deepEqual(o.readNoteOwnerGroupMembers(d,'human:1',7),[2,1]);assert.deepEqual(o.readNoteOwnerMembership(d,'human:1',1),before.members[0]);assert.deepEqual(o.listNoteOwnerGroups(d,'human:1'),before.groups);
    assert.equal(d.prepare('SELECT total_changes() n').get().n,total);assert.equal(clock(d),version);
    d.transaction(()=>o.ensureNoteLayoutOwner(d,'human:1')).immediate();assert.equal(o.hasNoteLayoutOwner(d,'human:1'),true);
    assert.deepEqual(o.noteLayoutSource(d,'human:1'),{layouts:'note_board_note_layouts',groups:'note_board_groups',members:'note_board_group_members',ownerKey:'human:1'});
    d.prepare("UPDATE note_board_note_layouts SET x=2.75 WHERE owner_key='human:1' AND note_id=1").run();
    assert.equal(o.readNoteOwnerLayout(d,'human:1',1).x,2.75);assert.equal(o.readNoteOwnerLayout(d,'device:8',1).x,before.layouts[0].x);assert.deepEqual(seed(d),before);
  }finally{d.close();}
});

test('atomic idempotent seed initialization preserves exact shapes, IDs, ordering and revisions without invalidation',async()=>{
  const o=await owner(),d=fresh();try{
    const before=seed(d),version=clock(d);o.ensureNoteLayoutOwner(d,'human:1');o.ensureNoteLayoutOwner(d,'device:8');
    for(const key of ['human:1','device:8']){
      assert.deepEqual(o.readNoteOwnerLayout(d,key,1),before.layouts[0]);assert.deepEqual(o.readNoteOwnerGroup(d,key,7),before.groups[0]);assert.deepEqual(o.readNoteOwnerGroupMembers(d,key,7),[2,1]);
      assert.equal(d.prepare('SELECT next_group_id FROM note_board_owners WHERE owner_key=?').get(key).next_group_id,51);
    }
    assert.equal(clock(d),version);const total=d.prepare('SELECT total_changes() n').get().n;o.ensureNoteLayoutOwner(d,'human:1');assert.equal(d.prepare('SELECT total_changes() n').get().n,total);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM note_board_group_receipts').get().n,0);assert.deepEqual(seed(d),before);
  }finally{d.close();}
});

test('initialization and counter allocation roll back with the authorized transaction and restart never reseeds',async()=>{
  const o=await owner(),folder=mkdtempSync(join(tmpdir(),'note-owner-restart-')),file=join(folder,'synthetic.db');let d=new Database(file);
  try{
    legacy(d);apply(d,migration);const before=seed(d),version=clock(d);
    assert.throws(()=>d.transaction(()=>{o.ensureNoteLayoutOwner(d,'human:1');assert.equal(o.nextNoteGroupId(d,'human:1'),51);throw new Error('authorized write failed');}).immediate(),/authorized write failed/);
    for(const table of tables)assert.equal(d.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);assert.deepEqual(seed(d),before);assert.equal(clock(d),version);
    d.exec("CREATE TRIGGER reject_owner_seed BEFORE INSERT ON note_board_group_members WHEN NEW.note_id=2 BEGIN SELECT RAISE(ABORT,'seed failed'); END;");
    assert.throws(()=>o.ensureNoteLayoutOwner(d,'human:1'),/seed failed/);for(const table of tables)assert.equal(d.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);d.exec('DROP TRIGGER reject_owner_seed');
    assert.equal(o.nextNoteGroupId(d,'human:1'),51);d.prepare("UPDATE note_board_note_layouts SET x=3.125 WHERE owner_key='human:1' AND note_id=1").run();d.close();d=new Database(file);d.pragma('foreign_keys=ON');apply(d,migration);o.ensureNoteLayoutOwner(d,'human:1');
    assert.equal(o.readNoteOwnerLayout(d,'human:1',1).x,3.125);assert.equal(o.nextNoteGroupId(d,'human:1'),52);assert.deepEqual(seed(d),before);assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();rmSync(folder,{recursive:true,force:true});}
});

test('group counters do not reuse deleted IDs and remain independent; composite constraints prohibit cross-owner members',async()=>{
  const o=await owner(),d=fresh();try{
    o.ensureNoteLayoutOwner(d,'human:1');o.ensureNoteLayoutOwner(d,'device:8');const id=o.nextNoteGroupId(d,'human:1');
    const insert=d.prepare('INSERT INTO note_board_groups(owner_key,id,x,y,width,height) VALUES(?,?,0,0,4,6)');insert.run('human:1',id);d.prepare('DELETE FROM note_board_groups WHERE owner_key=? AND id=?').run('human:1',id);
    assert.equal(o.nextNoteGroupId(d,'human:1'),52);assert.equal(o.nextNoteGroupId(d,'device:8'),51);insert.run('human:1',100);
    const member=d.prepare('INSERT INTO note_board_group_members(owner_key,note_id,group_id,ordinal) VALUES(?,?,?,?)');
    assert.throws(()=>member.run('device:8',3,100,0),/FOREIGN KEY/);assert.throws(()=>member.run('human:1',1,100,0),/UNIQUE/);assert.throws(()=>member.run('human:1',3,7,1),/UNIQUE/);assert.throws(()=>member.run('human:1',999,100,0),/FOREIGN KEY/);member.run('human:1',3,100,0);
    assert.throws(()=>insert.run('human:1',7),/UNIQUE/);assert.throws(()=>insert.run('human:999',4),/FOREIGN KEY/);
    for(const bad of ['x=-1','x=10001','y=10001','width=2','height=101','position_locked=2','always_on_top=-1'])assert.throws(()=>d.exec(`UPDATE note_board_groups SET ${bad} WHERE owner_key='human:1' AND id=100`));
    const receipt=d.prepare('INSERT INTO note_board_group_receipts(owner_key,principal_key,operation_id,request_hash,before_json,after_json) VALUES(?,?,?,?,?,?)');receipt.run('human:1','person:1','op','hash','{}','{}');receipt.run('device:8','person:1','op','hash','{}','{}');assert.throws(()=>receipt.run('human:1','person:1','op','hash','{}','{}'),/UNIQUE/);
    d.prepare('DELETE FROM notes WHERE id=3').run();assert.equal(o.readNoteOwnerMembership(d,'human:1',3),undefined);assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();}
});

test('owner arrangement clocks change for real writes only; sequence, receipts, seeding and no-op updates stay quiet',async()=>{
  const o=await owner(),d=fresh();try{
    const initial=clock(d);o.ensureNoteLayoutOwner(d,'human:1');o.nextNoteGroupId(d,'human:1');assert.equal(clock(d),initial);
    d.exec("UPDATE note_board_note_layouts SET x=x,revision=revision+1 WHERE owner_key='human:1'; UPDATE note_board_groups SET x=x,revision=revision+1 WHERE owner_key='human:1'; UPDATE note_board_group_members SET ordinal=ordinal WHERE owner_key='human:1';");assert.equal(clock(d),initial);
    d.exec("UPDATE note_board_note_layouts SET x=x+0.125,revision=revision+1 WHERE owner_key='human:1' AND note_id=1;");assert.equal(clock(d),initial+1);
    d.exec("UPDATE note_board_groups SET x=x+0.125,revision=revision+1 WHERE owner_key='human:1' AND id=7;");assert.equal(clock(d),initial+2);
    d.exec("UPDATE note_board_group_members SET ordinal=5 WHERE owner_key='human:1' AND note_id=1;");assert.equal(clock(d),initial+3);
    d.exec("INSERT INTO note_board_group_receipts(owner_key,principal_key,operation_id,request_hash,before_json,after_json) VALUES('human:1','person:1','op','hash','{}','{}');");assert.equal(clock(d),initial+3);
  }finally{d.close();}
});

test('failed migration transaction rolls back new schema without touching legacy objects or rows',async()=>{
  await owner();const d=new Database(':memory:');try{
    legacy(d);const before=seed(d),version=clock(d),objects=d.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    assert.throws(()=>d.transaction(()=>{apply(d,migration);throw new Error('migration failed');}).immediate(),/migration failed/);
    assert.deepEqual(d.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),objects);assert.deepEqual(seed(d),before);assert.equal(clock(d),version);
    apply(d,migration);assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();}
});

test('actual encrypted startup adds missing owner migration and a missing version record never reseeds initialized owners',async()=>{
  const o=await owner(),folder=mkdtempSync(join(tmpdir(),'note-owner-startup-')),file=join(folder,'synthetic.db');let d;
  const open=()=>{const db=new Database(file);db.pragma("cipher='sqlcipher'");db.pragma(`key="x'${Buffer.from('synthetic-owner-startup-key','utf8').toString('hex')}'"`);db.pragma('foreign_keys=ON');return db;};
  const startup=()=>{
    const launched=spawnSync(process.execPath,['--input-type=module','-e',`const {get,currentVersion}=await import(${JSON.stringify(new URL('../server/db.js',import.meta.url).href)});if(currentVersion()!==10053)throw new Error('owner migration not recorded');get().close();`],{env:{...process.env,DB_PATH:file,DB_ENCRYPTION_KEY:'synthetic-owner-startup-key',LOG_LEVEL:'error'},encoding:'utf8',timeout:30000});
    assert.equal(launched.status,0,launched.stderr||launched.stdout||String(launched.error));
  };
  try{
    d=open();legacy(d);d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);');
    for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10052))d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);
    const before=seed(d),version=clock(d);d.close();d=null;startup();d=open();assert.deepEqual(seed(d),before);assert.equal(clock(d),version);
    assert.ok(d.prepare('SELECT 1 FROM schema_migrations WHERE version=10053').get());assert.equal(d.prepare('SELECT COUNT(*) n FROM note_board_owners').get().n,0);
    o.ensureNoteLayoutOwner(d,'human:1');assert.equal(o.nextNoteGroupId(d,'human:1'),51);d.exec("UPDATE note_board_note_layouts SET x=2.375,revision=revision+1 WHERE owner_key='human:1' AND note_id=1; DELETE FROM schema_migrations WHERE version=10053;");
    const owned=Object.fromEntries(tables.map(table=>[table,d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),changedClock=clock(d);d.close();d=null;startup();d=open();
    for(const table of tables)assert.deepEqual(d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),owned[table]);assert.deepEqual(seed(d),before);assert.equal(clock(d),changedClock);assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
  }finally{d?.close();rmSync(folder,{recursive:true,force:true});}
});
