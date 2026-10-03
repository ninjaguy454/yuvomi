import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-acceptance-migration';
const {ALL_MIGRATIONS}=await import('../server/db.js');
test('acceptance receipt migration preserves populated encrypted Tasks, Notes audiences and geometry across reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vidamia-acceptance-migration-'));let d;
  const file=join(dir,'synthetic.db'),open=()=>{const conn=new Database(file);conn.pragma("key='synthetic-acceptance-migration-key'");conn.pragma('foreign_keys=ON');return conn;};
  try{
    d=open();
    for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10049)){
      if(m.version===10048)d.pragma('foreign_keys=OFF');
      d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
      if(m.version===10048)d.pragma('foreign_keys=ON');
    }
    d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'owner','Owner','x','member'),(2,'helper','Helper','x','member'); INSERT INTO tasks(id,title,created_by,assigned_to) VALUES(1,'Existing work',1,2); INSERT INTO task_assignments(task_id,user_id) VALUES(1,2); INSERT INTO notes(id,title,content,created_by,visibility) VALUES(1,'Private','Preserve secret',1,'private'),(2,'Shared','Preserve selected',1,'selected'); INSERT INTO note_access(note_id,user_id) VALUES(2,2); INSERT INTO note_layouts(note_id,x,y,width,height) VALUES(1,4,10,5,7)");
    const tables=['tasks','task_assignments','notes','note_access','note_layouts'],snapshot=()=>Object.fromEntries(tables.map(name=>[name,d.prepare(`SELECT * FROM ${name}`).all()])),before=snapshot();
    const migration=ALL_MIGRATIONS.find(m=>m.version===10050);assert.ok(migration);
    d.transaction(()=>migration.up(d))();assert.deepEqual(snapshot(),before);
    d.prepare('INSERT INTO task_acceptance_receipts(principal_key,operation_id,request_hash,task_id) VALUES(?,?,?,?)').run('member:1:test','operation-test','hash',1);
    assert.throws(()=>d.prepare('INSERT INTO task_acceptance_receipts(principal_key,operation_id,request_hash,task_id) VALUES(?,?,?,?)').run('member:1:test','operation-test','different',1),/UNIQUE/);
    assert.notEqual(readFileSync(file).subarray(0,16).toString(),'SQLite format 3\0');
    d.close();d=open();migration.up(d);assert.deepEqual(snapshot(),before);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts').get().n,1);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
    d.prepare('DELETE FROM tasks WHERE id=1').run();assert.equal(d.prepare('SELECT task_id FROM task_acceptance_receipts').get().task_id,null);
  }finally{d?.close();rmSync(dir,{recursive:true,force:true});}
});
