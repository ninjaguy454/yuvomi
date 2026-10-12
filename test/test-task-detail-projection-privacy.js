import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

const {_setTestDatabase}=await import('../server/db.js');

for(const responseKind of ['detail','status response'])test(responseKind+' cannot disclose newly private child text after another connection commits',async t=>{
 const f=await scoringFixture(t),created=await f.create({assigned_to:[2],subtasks:[{title:'Synthetic public child',points:0}]}),root=created.data.id,child=created.data.subtasks[0].id;
 const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic privacy skill',0,'normal',1)").run().lastInsertRowid);
 f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(?,?)').run(child,skill);
 for(const [id,proficiency] of [[1,'excluded'],[2,'supervised'],[3,'normal']])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,?,'manual')").run(id,skill,proficiency);
 const directory=mkdtempSync(join(tmpdir(),'task-detail-privacy-')),file=join(directory,'synthetic.db');
 writeFileSync(file,f.d.serialize());const reader=new Database(file);reader.pragma('journal_mode=WAL');
 const writer=new Database(file);writer.pragma('journal_mode=WAL');const prepare=reader.prepare.bind(reader);
 const privateText='PRIVATE synthetic text committed after revocation';let revoked=false,hydrating=false;
 _setTestDatabase(reader);
 // Commit after child capabilities were read, before fresh supervision rows.
 // A second connection leaves reader total_changes unchanged and cannot be
 // modeled faithfully by an UPDATE on the reader itself.
 reader.prepare=(sql,...args)=>{
  if(sql.startsWith('SELECT t.*,u.display_name AS assigned_name'))hydrating=true;
  if(hydrating&&!revoked&&sql.trim()==='SELECT * FROM task_supervision_actions WHERE source_task_id = ?'){
   writer.prepare("UPDATE tasks SET visibility='private',title=? WHERE id=?").run(privateText,child);revoked=true;
  }
  return prepare(sql,...args);
 };
 try{
  const before=prepare('SELECT total_changes() n').get().n,response=responseKind==='detail'
   ?await f.call('GET','/tasks/'+root,undefined,2)
   :await f.call('PATCH','/tasks/'+root+'/status',{status:'in_progress'},2);
  assert.equal(response.status,200);assert.equal(revoked,true,'the external commit must happen during response construction');
  if(responseKind==='detail')assert.equal(prepare('SELECT total_changes() n').get().n,before);
  assert.equal(JSON.stringify(response.data).includes(privateText),false,'fresh private supervision text must not bypass current visibility through cached capabilities');
  assert.equal((await f.call('GET','/tasks/'+child,undefined,2)).status,404);
  assert.equal(prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);assert.deepEqual(reader.pragma('foreign_key_check'),[]);
 }finally{
  reader.prepare=prepare;_setTestDatabase(f.d);reader.close();writer.close();
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});
 }
});

test('status response denies a newly private root after its progress mutation commits',async t=>{
 const f=await scoringFixture(t),id=(await f.create({assigned_to:[2],points:0})).data.id;
 const directory=mkdtempSync(join(tmpdir(),'task-status-privacy-')),file=join(directory,'synthetic.db');
 writeFileSync(file,f.d.serialize());const reader=new Database(file);reader.pragma('journal_mode=WAL');
 const writer=new Database(file);writer.pragma('journal_mode=WAL');const prepare=reader.prepare.bind(reader);
 const privateText='PRIVATE synthetic root text after committed progress';let revoked=false;
 _setTestDatabase(reader);
 reader.prepare=(sql,...args)=>{
  // The response's new read scope starts after changeTaskStatus committed.
  // Its total_changes query precedes the first snapshot-pinning table read.
  if(!revoked&&sql==='SELECT total_changes() AS count'){
   writer.prepare("UPDATE tasks SET visibility='private',title=? WHERE id=?").run(privateText,id);revoked=true;
  }
  return prepare(sql,...args);
 };
 try{
  const response=await f.call('PATCH','/tasks/'+id+'/status',{status:'in_progress'},2);
  assert.equal(revoked,true);assert.equal(response.status,404);
  assert.equal(JSON.stringify(response).includes(privateText),false);
  const current=prepare('SELECT status,revision FROM tasks WHERE id=?').get(id);
  assert.equal(current.status,'in_progress');assert.ok(current.revision>f.row(id).revision,'the authorized mutation committed before response visibility changed');
  assert.equal((await f.call('GET','/tasks/'+id,undefined,2)).status,404);
  assert.equal(prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);assert.deepEqual(reader.pragma('foreign_key_check'),[]);
 }finally{
  reader.prepare=prepare;_setTestDatabase(f.d);reader.close();writer.close();
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});
 }
});
