import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import { addDeviceNotesSchema } from '../server/services/device-notes-schema.js';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET||='notes-schema-test';
const { ALL_MIGRATIONS }=await import('../server/db.js');
const { normalizeDevicePermissions,devicePreset }=await import('../server/services/devices.js');

test('all sixteen Notes capability combinations preserve independent grants and safe defaults',()=>{
  const actions=['view','create','edit','delete'];
  for(let mask=0;mask<16;mask++){
    const input=devicePreset();actions.forEach((key,i)=>input.capabilities[`device_notes.${key}`]=mask&(1<<i)?'allow':'none');
    const actual=normalizeDevicePermissions(input);
    assert.deepEqual(actual.capabilities,input.capabilities);
    assert.equal(actual.modules.notes,mask?'read':'none');
  }
  const legacy=devicePreset();for(const key of actions)delete legacy.capabilities[`device_notes.${key}`];
  assert.equal(normalizeDevicePermissions(legacy).modules.notes,'none');
});

for(const empty of [false,true])test(`Notes migration preserves rows/search/triggers and high-water mark (empty=${empty})`,()=>{
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS.filter(m=>m.version<10048)){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'); INSERT INTO notes(id,title,content,created_by) VALUES(1,'Original','Exact old text',1),(50,'Removed','Deleted highest ID',1); DELETE FROM notes WHERE id=50");
  if(empty)d.exec('DELETE FROM notes');
  const rows=d.prepare('SELECT * FROM notes').all();
  const search=d.prepare("SELECT * FROM search_index WHERE entity='note'").all();
  const artifacts=d.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='notes' AND type IN ('trigger','index') ORDER BY name").all();
  d.transaction(()=>addDeviceNotesSchema(d))();
  const columns=Object.keys(rows[0]||{id:0,title:0,content:0,color:0,pinned:0,created_by:0,created_at:0,updated_at:0});
  assert.deepEqual(d.prepare(`SELECT ${columns.join(',')} FROM notes`).all(),rows);
  assert.deepEqual(d.prepare("SELECT * FROM search_index WHERE entity='note'").all(),search);
  assert.deepEqual(d.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='notes' AND type IN ('trigger','index') ORDER BY name").all(),artifacts);
  assert.equal(d.prepare("SELECT seq FROM sqlite_sequence WHERE name='notes'").get().seq,50);
  addDeviceNotesSchema(d);
  assert.equal(Number(d.prepare("INSERT INTO notes(content,created_by) VALUES('After migration',1)").run().lastInsertRowid),51);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();
});
