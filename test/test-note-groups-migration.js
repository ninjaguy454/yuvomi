import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addNoteGroupSchema} from '../server/services/note-group-schema.js';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-note-groups-migration';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const mirror=await import('../server/db-schema-test.js');
const migration=ALL_MIGRATIONS.find(m=>m.version===10052);
const apply=(d,m)=>d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
function legacy(d){
  d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10051))apply(d,m);
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'owner','Owner','x','member'); INSERT INTO notes(id,title,content,created_by,pinned,visibility) VALUES(1,'Unchanged','Exact text',1,1,'private'),(2,'Other','Other text',1,0,'all'); INSERT INTO note_layouts(note_id,x,y,width,height,revision,position_locked,always_on_top) VALUES(1,77,89,12,100,9,1,1)");
}
const snapshot=d=>({notes:d.prepare('SELECT * FROM notes ORDER BY id').all(),layouts:d.prepare('SELECT * FROM note_layouts ORDER BY note_id').all(),clock:d.prepare('SELECT * FROM note_change_clock').get()});

test('migration 10052 preserves encrypted existing rows and restarts idempotently',()=>{
  const folder=mkdtempSync(join(tmpdir(),'note-groups-migration-')),file=join(folder,'synthetic.db');let d;
  const open=()=>{const db=new Database(file);db.pragma("key='synthetic-group-key'");db.pragma('foreign_keys=ON');return db;};
  try{
    d=open();legacy(d);const beforeMigration=snapshot(d);assert.equal(migration?.up,addNoteGroupSchema);apply(d,migration);
    const afterMigration=snapshot(d);
    assert.deepEqual(afterMigration.notes,beforeMigration.notes);
    assert.deepEqual(afterMigration.layouts,beforeMigration.layouts);
    assert.deepEqual(afterMigration.clock,beforeMigration.clock);
    const applyMigrationTwice=()=>{addNoteGroupSchema(d);return {groupCount:d.prepare('SELECT COUNT(*) n FROM note_groups').get().n};};
    assert.equal(applyMigrationTwice().groupCount,0);
    d.close();d=open();assert.deepEqual(snapshot(d),beforeMigration);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
  }finally{d?.close();rmSync(folder,{recursive:true,force:true});}
});

test('membership constraints, independent bounds, structural receipts and invalidation triggers persist',()=>{
  const d=new Database(':memory:');try{
    legacy(d);apply(d,migration);const before=snapshot(d),clock=()=>d.prepare('SELECT version FROM note_change_clock').get().version;
    const insert=d.prepare('INSERT INTO note_groups(x,y,width,height,position_locked,always_on_top) VALUES(?,?,?,?,?,?)');
    const a=Number(insert.run(10000,10000,12,100,1,1).lastInsertRowid),b=Number(insert.run(4,8,3,4,0,0).lastInsertRowid);
    assert.equal(clock(),before.clock.version+2);
    const member=d.prepare('INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(?,?,?)');member.run(1,a,0);
    const insertMembershipOfSameNoteInTwoGroups=()=>member.run(1,b,0);
    assert.throws(()=>insertMembershipOfSameNoteInTwoGroups());
    assert.throws(()=>member.run(2,a,0));assert.throws(()=>member.run(999,a,1));assert.throws(()=>member.run(2,999,1));assert.throws(()=>member.run(2,a,-1));
    member.run(2,a,1);let previous=clock();d.prepare('UPDATE note_group_members SET ordinal=5 WHERE note_id=2').run();assert.equal(clock(),previous+1);
    previous=clock();d.prepare('UPDATE note_groups SET x=1,revision=revision+1 WHERE id=?').run(a);assert.equal(clock(),previous+1);
    for(const bad of ['x=-1','x=10001','y=10001','width=2','width=13','height=3','height=101','position_locked=2','always_on_top=-1'])assert.throws(()=>d.exec(`UPDATE note_groups SET ${bad} WHERE id=${a}`));
    const receipt=d.prepare('INSERT INTO note_group_receipts(principal_key,operation_id,request_hash,before_json,after_json) VALUES(?,?,?,?,?)');
    previous=clock();receipt.run('person:1','operation','hash','{}','{}');receipt.run('device:1','operation','hash','{}','{}');assert.throws(()=>receipt.run('person:1','operation','hash','{}','{}'));assert.equal(clock(),previous);
    assert.deepEqual(snapshot(d).notes,before.notes);assert.deepEqual(snapshot(d).layouts,before.layouts);
    previous=clock();d.prepare('DELETE FROM note_group_members WHERE note_id=2').run();assert.equal(clock(),previous+1);
    previous=clock();d.prepare('DELETE FROM note_groups WHERE id=?').run(a);assert.equal(clock(),previous+2);assert.equal(d.prepare('SELECT COUNT(*) n FROM note_group_members').get().n,0);
    member.run(2,b,0);d.prepare('DELETE FROM notes WHERE id=2').run();assert.equal(d.prepare('SELECT COUNT(*) n FROM note_group_members').get().n,0);
  }finally{d.close();}
});

test('fresh test schema matches all three migrated tables',()=>{
  const migrated=new Database(':memory:'),fresh=new Database(':memory:');try{
    legacy(migrated);apply(migrated,migration);assert.equal(typeof mirror.NOTE_GROUPS_SCHEMA_SQL,'string');
    fresh.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY);');fresh.exec(mirror.NOTE_GROUPS_SCHEMA_SQL);
    for(const table of ['note_groups','note_group_members','note_group_receipts']){
      assert.deepEqual(fresh.pragma(`table_info(${table})`),migrated.pragma(`table_info(${table})`));
      assert.deepEqual(fresh.pragma(`foreign_key_list(${table})`),migrated.pragma(`foreign_key_list(${table})`));
      assert.deepEqual(fresh.pragma(`index_list(${table})`),migrated.pragma(`index_list(${table})`));
    }
  }finally{migrated.close();fresh.close();}
});
