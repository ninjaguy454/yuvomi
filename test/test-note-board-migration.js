import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='notes-migration-synthetic';
const {ALL_MIGRATIONS}=await import('../server/db.js');
test('Phase2 additive migration preserves encrypted populated notes and is restart safe',()=>{
  const path=mkdtempSync(join(tmpdir(),'notes-canvas-migration-'));let d;
  try{
    const file=join(path,'synthetic.db');const open=()=>{const value=new Database(file);value.pragma("key='synthetic-notes-key'");value.pragma('foreign_keys=ON');return value;};d=open();
    for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10048)){if(m.version===10048)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.version===10048)d.pragma('foreign_keys=ON');}
    d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'owner','Owner','x','member'); INSERT INTO notes(title,content,created_by,pinned) VALUES('Legacy','Exact text\n- [x] Keep',1,1)");
    const before=d.prepare('SELECT * FROM notes').all();const additions=ALL_MIGRATIONS.filter(m=>m.version>10048);
    assert.equal(additions.length,1,'one additive Phase2 migration exists');
    for(const m of additions)d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
    const after=d.prepare('SELECT * FROM notes').all();for(const key of Object.keys(before[0]))assert.equal(after[0][key],before[0][key],key);
    assert.equal(after[0].visibility,'all');assert.equal(after[0].revision,1);assert.equal(d.prepare('SELECT COUNT(*) n FROM note_layouts').get().n,0);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');d.close();d=open();
    assert.deepEqual(d.prepare('SELECT * FROM notes').all(),after);
    for(const m of additions)typeof m.up==='function'?m.up(d):d.exec(m.up);
    assert.deepEqual(d.prepare('SELECT * FROM notes').all(),after);
  }finally{d?.close();rmSync(path,{recursive:true,force:true});}
});
