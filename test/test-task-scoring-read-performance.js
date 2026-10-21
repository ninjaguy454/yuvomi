import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {taskScoringSummary,taskScoringIdentity} from '../server/services/task-scoring.js';
import {withTaskReadSnapshot,withTaskReadProjection,taskReadStatement,taskReadFacts,taskReadRecord} from '../server/services/task-access.js';
import {taskCapabilities} from '../server/services/task-access.js';
import {taskWindowAncestors} from '../server/services/task-window.js';
import {taskOptionalContext} from '../server/services/task-optional.js';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';

// Removing request-local scoring preparation reuse must fail this real-route
// bound. It counts compilations, not wall time, so slower hosts are deterministic.
test('Task list preserves scoring and database state with bounded SQL preparation',async t=>{
 const f=await scoringFixture(t),roots=[];
 f.d.transaction(()=>{
  for(let i=0;i<10;i++){
   const id=Number(f.d.prepare("INSERT INTO tasks(title,created_by,assigned_to,scoring_mode,points) VALUES('Synthetic parent',1,2,'subtasks',0)").run().lastInsertRowid);roots.push(id);
   f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(id);
   for(let n=0;n<4;n++)f.d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,points) VALUES('Synthetic step',1,?,2)").run(id);
  }
 })();
 const before=f.snapshot(),changes=f.changes(),original=f.d.prepare.bind(f.d);let compilations=0;
 f.d.prepare=(...args)=>{compilations++;return original(...args);};
 let response;try{response=await f.call('GET','/tasks');}finally{f.d.prepare=original;}
 assert.equal(response.status,200);assert.equal(response.data.length,10);
 for(const task of response.data){
  assert.deepEqual(task.scoring.potential,[{user_id:2,points:8}]);assert.deepEqual(task.scoring.earned,[]);
  for(const child of task.subtasks)assert.deepEqual(child.scoring.potential,[{user_id:2,points:2}]);
 }
 assert.equal(f.snapshot(),before);assert.equal(f.changes(),changes);
 assert.ok(compilations<4500,`50 Tasks compiled ${compilations} statements; repeated scoring reads must reuse preparation`);
});

test('list hydration skips child projection only for roots with no children at all',async t=>{
 const f=await scoringFixture(t),roots=[];
 f.d.transaction(()=>{
  for(let i=0;i<20;i++)roots.push(Number(f.d.prepare("INSERT INTO tasks(title,created_by,assigned_to) VALUES('Leaf',1,2)").run().lastInsertRowid));
  const parent=roots[0];
  f.d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,archived_at) VALUES('Archived step',1,?,datetime('now'))").run(parent);
 })();
 const prepare=f.d.prepare.bind(f.d);let childLoads=0;
 f.d.prepare=sql=>{
  const statement=prepare(sql);
  if(sql.includes('WHERE t.parent_task_id = ?')&&sql.includes('assigned_avatar')){
   const all=statement.all.bind(statement);statement.all=(...args)=>{childLoads++;return all(...args);};
  }
  return statement;
 };
 let response;try{response=await f.call('GET','/tasks');}finally{f.d.prepare=prepare;}
 assert.equal(response.status,200);
 assert.equal(response.data.length,20);
 assert.equal(response.data.find(task=>task.id===roots[0])?.subtasks.length,1,'archived child still follows the existing detail projection');
 assert.equal(childLoads,1,'the other 19 roots have no child projection to load');
});

test('scoring reads observe point and visibility changes across snapshots and owned writes',async t=>{
 const f=await scoringFixture(t),created=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Synthetic step',points:3}]}),root=created.data.id,child=created.data.subtasks[0].id;
 const read=()=>taskScoringSummary(f.d,root,{viewerId:2,authorizedTaskIds:[root,child]});
 const first=withTaskReadSnapshot(f.d,2,()=>read());assert.deepEqual(first.potential,[{user_id:2,points:3}]);
 f.d.prepare('UPDATE tasks SET points=7 WHERE id=?').run(child);
 assert.deepEqual(withTaskReadSnapshot(f.d,2,()=>read()).potential,[{user_id:2,points:7}]);
 withTaskReadSnapshot(f.d,2,()=>{
  assert.deepEqual(read().potential,[{user_id:2,points:7}]);
  f.d.prepare("UPDATE tasks SET visibility='private',created_by=3 WHERE id=?").run(child);
  assert.deepEqual(read().potential,[],'an unexpected owned write cannot retain private scoring');
 });
 assert.deepEqual(withTaskReadSnapshot(f.d,2,()=>read()).potential,[]);
 assert.throws(()=>f.d.transaction(()=>{
  f.d.prepare("UPDATE tasks SET visibility='all',points=11 WHERE id=?").run(child);
  assert.deepEqual(withTaskReadSnapshot(f.d,2,()=>read()).potential,[{user_id:2,points:11}]);
  throw Error('synthetic rollback');
 })(),/synthetic rollback/);
 assert.deepEqual(withTaskReadSnapshot(f.d,2,()=>read()).potential,[]);
 assert.equal(f.d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
});

test('compiled read handles are bounded to a scope and write statements are never retained',async t=>{
 const f=await scoringFixture(t),sql='SELECT display_name FROM users WHERE id=?';let handle;
 withTaskReadSnapshot(f.d,1,()=>{
  handle=taskReadStatement(f.d,sql);assert.equal(taskReadStatement(f.d,sql),handle);
  assert.equal(handle.get(1).display_name,'Synthetic 1');assert.equal(handle.get(2).display_name,'Synthetic 2');
  const write="UPDATE users SET display_name=? WHERE id=?";
  assert.notEqual(taskReadStatement(f.d,write),taskReadStatement(f.d,write),'mutation handles must not enter the read preparation cache');
  for(let n=0;n<70;n++)taskReadStatement(f.d,`SELECT ${n} AS synthetic`);
  const excess='SELECT 71 AS synthetic';assert.notEqual(taskReadStatement(f.d,excess),taskReadStatement(f.d,excess),'the scope retains at most64 handles');
 });
 assert.notEqual(taskReadStatement(f.d,sql),handle);
 withTaskReadSnapshot(f.d,1,()=>assert.notEqual(taskReadStatement(f.d,sql),handle));
 f.d.transaction(()=>withTaskReadProjection(f.d,1,()=>assert.notEqual(taskReadStatement(f.d,sql),taskReadStatement(f.d,sql),'caller-owned transactions never retain handles')))();
});

test('sibling scoring summaries scan one scope while preserving each authorized projection',async t=>{
 const f=await scoringFixture(t),created=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Synthetic A',points:3},{title:'Synthetic B',points:5}]}),root=created.data.id,[a,b]=created.data.subtasks.map(row=>row.id);
 const prepare=f.d.prepare.bind(f.d);let scans=0;
 f.d.prepare=sql=>{const statement=prepare(sql);if(sql.includes('WITH RECURSIVE scope(id)')){const all=statement.all.bind(statement);statement.all=(...args)=>{scans++;return all(...args);};}return statement;};
 try{withTaskReadSnapshot(f.d,2,()=>{
  const read=id=>taskScoringSummary(f.d,id,{viewerId:2,authorizedTaskIds:[id]});
  assert.deepEqual(taskScoringSummary(f.d,root,{viewerId:2,authorizedTaskIds:[root,a,b]}).potential,[{user_id:2,points:8}]);
  assert.deepEqual(read(a).potential,[{user_id:2,points:3}]);assert.deepEqual(read(b).potential,[{user_id:2,points:5}]);
 });}finally{f.d.prepare=prepare;}
 assert.equal(scans,1,'root and siblings must share internal scope facts, never personalized summaries');
});

test('ancestry and scoring identity reuse compilation while binding each Task freshly',async t=>{
 const f=await scoringFixture(t),created=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Synthetic step',points:3}]}),root=created.data.id,child=created.data.subtasks[0].id;
 const prepare=f.d.prepare.bind(f.d);let compilations=0;f.d.prepare=sql=>{compilations++;return prepare(sql);};
 try{withTaskReadSnapshot(f.d,2,()=>{for(let n=0;n<10;n++)for(const id of [root,child]){
  assert.deepEqual(taskWindowAncestors(f.d,id).map(row=>row.id).sort((a,b)=>a-b),id===root?[root]:[root,child]);
  assert.equal(taskScoringIdentity(f.d,id),JSON.stringify(['task',id]));
 }});}finally{f.d.prepare=prepare;}
 assert.ok(compilations<20,`20 identities/ancestries compiled ${compilations} statements`);
});

test('internal read facts are bounded, actor scoped, and invalid after rolled-back owned writes',async t=>{
 const f=await scoringFixture(t),namespace=Symbol('synthetic'),read=()=>f.d.prepare('SELECT display_name FROM users WHERE id=2').get().display_name;
 withTaskReadSnapshot(f.d,2,()=>{
  assert.equal(taskReadFacts(f.d,namespace,0,read),'Synthetic 2');
  withTaskReadProjection(f.d,3,()=>assert.equal(taskReadFacts(f.d,namespace,0,()=> 'other actor'),'other actor'));
  assert.equal(taskReadFacts(f.d,namespace,0,read),'Synthetic 2');
  f.d.exec('SAVEPOINT synthetic');f.d.prepare("UPDATE users SET display_name='Temporary' WHERE id=2").run();
  assert.equal(taskReadFacts(f.d,namespace,0,read),'Temporary');f.d.exec('ROLLBACK TO synthetic; RELEASE synthetic');
  assert.equal(taskReadFacts(f.d,namespace,0,read),'Synthetic 2');
 });
 withTaskReadSnapshot(f.d,2,()=>{
  for(let n=0;n<256;n++)taskReadFacts(f.d,namespace,n,()=>n);
  assert.equal(taskReadFacts(f.d,namespace,256,()=> 'first'),'first');
  assert.equal(taskReadFacts(f.d,namespace,256,()=> 'second'),'second','excess entries are never retained');
 });
 f.d.transaction(()=>withTaskReadProjection(f.d,2,()=>{
  assert.equal(taskReadFacts(f.d,namespace,0,()=> 'first'),'first');
  assert.equal(taskReadFacts(f.d,namespace,0,()=> 'second'),'second','caller transaction cannot retain facts');
 }))();
 assert.equal(taskReadFacts(f.d,namespace,0,()=> 'new request'),'new request');
});

test('permission projection compiles shared read queries once and binds every private Task separately',async t=>{
 const f=await scoringFixture(t),rows=[];
 for(let n=0;n<12;n++){
  const assigned=n%2?2:3,id=Number(f.d.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility) VALUES('Synthetic private scope',1,?,'assignees')").run(assigned).lastInsertRowid);
  f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,assigned);rows.push({id,assigned});
 }
 const prepare=f.d.prepare.bind(f.d);let targeted=0;
 f.d.prepare=sql=>{const text=sql.replace(/\s+/g,' ').trim();if(text==='SELECT * FROM tasks WHERE id = ?'||text==='SELECT user_id FROM task_assignments WHERE task_id = ?'||text.startsWith('SELECT t.* FROM task_supervision_actions a')||text.startsWith('SELECT sa.action_task_id, sa.counterpart_task_id, sa.source_task_id'))targeted++;return prepare(sql);};
 try{withTaskReadSnapshot(f.d,2,()=>{
  for(const row of rows){const c=taskCapabilities(f.d,2,{id:row.id});assert.equal(c.view,row.assigned===2);assert.equal(c.own,row.assigned===2);}
 });}finally{f.d.prepare=prepare;}
 assert.ok(targeted<8,`12 private Tasks compiled ${targeted} shared permission queries`);
 assert.equal(f.d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
});

test('repeated permission and reward identity reads fetch each canonical Task only once per snapshot',async t=>{
 const f=await scoringFixture(t),created=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Synthetic A',points:2},{title:'Synthetic B',points:3}]}),ids=[created.data.id,...created.data.subtasks.map(row=>row.id)];
 const prepare=f.d.prepare.bind(f.d);let reads=0;
 f.d.prepare=sql=>{const statement=prepare(sql);if(/^SELECT \* FROM tasks WHERE id\s*=\s*\?$/.test(sql)){const get=statement.get.bind(statement);statement.get=(...args)=>{reads++;return get(...args);};}return statement;};
 try{withTaskReadSnapshot(f.d,2,()=>{for(let n=0;n<10;n++)for(const id of ids){assert.equal(taskCapabilities(f.d,2,{id}).view,true);assert.equal(taskScoringIdentity(f.d,id),JSON.stringify(['task',id]));assert.equal(taskOptionalContext(f.d,id).closed_parent,null);}});}finally{f.d.prepare=prepare;}
 assert.ok(reads<10,`three canonical Tasks required ${reads} row reads during one immutable snapshot`);
});

test('canonical records return copies and remain fresh after writes, savepoint rollback and later requests',async t=>{
 const f=await scoringFixture(t),created=await f.create({points:3}),id=created.data.id;
 withTaskReadSnapshot(f.d,2,()=>{
  const row=taskReadRecord(f.d,id),original=row.title;row.title='Synthetic poisoned copy';row.points=999;
  assert.equal(taskReadRecord(f.d,id).title,original);assert.equal(taskReadRecord(f.d,id).points,3);
  f.d.exec('SAVEPOINT synthetic_record');f.d.prepare('UPDATE tasks SET points=7 WHERE id=?').run(id);
  assert.equal(taskReadRecord(f.d,id).points,7);f.d.exec('ROLLBACK TO synthetic_record; RELEASE synthetic_record');
  assert.equal(taskReadRecord(f.d,id).points,3);
 });
 f.d.transaction(()=>withTaskReadProjection(f.d,2,()=>{
  assert.equal(taskReadRecord(f.d,id).points,3);f.d.prepare('UPDATE tasks SET points=11 WHERE id=?').run(id);assert.equal(taskReadRecord(f.d,id).points,11);
 }))();
 assert.equal(withTaskReadSnapshot(f.d,2,()=>taskReadRecord(f.d,id)).points,11);
 assert.equal(f.d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
});

test('canonical record reuse is bounded and isolated between actor and request scopes',async t=>{
 const f=await scoringFixture(t),id=(await f.create({points:3})).data.id,prepare=f.d.prepare.bind(f.d);let reads=0;
 f.d.prepare=sql=>{const statement=prepare(sql);if(/^SELECT \* FROM tasks WHERE id\s*=\s*\?$/.test(sql)){const get=statement.get.bind(statement);statement.get=(...args)=>{reads++;return get(...args);};}return statement;};
 try{
  withTaskReadSnapshot(f.d,2,()=>{
   for(let n=0;n<2048;n++)assert.equal(taskReadRecord(f.d,-n-1),undefined);
   taskReadRecord(f.d,id);taskReadRecord(f.d,id);assert.equal(reads,2050,'excess records must be fetched, never retained');
  });
  withTaskReadSnapshot(f.d,2,()=>{
   taskReadRecord(f.d,id);const before=reads;
   withTaskReadProjection(f.d,3,()=>taskReadRecord(f.d,id));assert.equal(reads,before+1,'another actor has a separate scope');
   taskReadRecord(f.d,id);assert.equal(reads,before+1,'outer actor scope remains intact');
  });
  const before=reads;taskReadRecord(f.d,id);assert.equal(reads,before+1,'no record survives a request');
 }finally{f.d.prepare=prepare;}
});

test('non-scalar Task columns bypass record reuse so mutable blobs cannot poison later readers',async t=>{
 const f=await scoringFixture(t),id=(await f.create({points:3})).data.id;
 f.d.exec('ALTER TABLE tasks ADD COLUMN synthetic_blob BLOB');f.d.prepare('UPDATE tasks SET synthetic_blob=? WHERE id=?').run(Buffer.from([1,2]),id);
 withTaskReadSnapshot(f.d,2,()=>{const first=taskReadRecord(f.d,id);first.synthetic_blob.fill(9);assert.deepEqual(taskReadRecord(f.d,id).synthetic_blob,Buffer.from([1,2]));});
});

test('one list reuses its canonical start graph for every card offer explanation',async t=>{
 const f=await scoringFixture(t),prepare=f.d.prepare.bind(f.d);let graphs=0;
 for(let n=0;n<10;n++)f.d.prepare("INSERT INTO tasks(title,created_by,assigned_to) VALUES('Synthetic assigned card',1,2)").run();
 f.d.prepare=sql=>{if(sql.startsWith('WITH RECURSIVE edges(child_id,parent_id)'))graphs++;return prepare(sql);};
 let r;try{r=await f.call('GET','/tasks');}finally{f.d.prepare=prepare;}
 assert.equal(r.status,200);assert.equal(r.data.length,10);assert.ok(r.data.every(row=>row.offer_reason==='already_assigned'&&!row.is_offer));
 assert.equal(graphs,1,'card offer checks must reuse the same request-local start projection as the list');
});

test('plain projections observe another connection commit without retaining a canonical record',async t=>{
 const f=await scoringFixture(t),id=(await f.create({points:3})).data.id,directory=mkdtempSync(join(tmpdir(),'task-record-read-')),file=join(directory,'synthetic.db');
 writeFileSync(file,f.d.serialize());const reader=new Database(file),writer=new Database(file);
 try{withTaskReadProjection(reader,2,()=>{
  assert.equal(taskReadRecord(reader,id).points,3);const before=reader.prepare('SELECT total_changes() n').get().n;
  writer.prepare('UPDATE tasks SET points=9 WHERE id=?').run(id);assert.equal(reader.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(taskReadRecord(reader,id).points,9,'another connection does not advance this total_changes, so plain scopes must not retain rows');
 });}finally{reader.close();writer.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});

test('plain scoring projections observe another connection point and settlement commits',async t=>{
 const f=await scoringFixture(t),id=(await f.create({scoring_mode:'whole_task',assigned_to:[2],points:3})).data.id,directory=mkdtempSync(join(tmpdir(),'task-scoring-read-')),file=join(directory,'synthetic.db');
 writeFileSync(file,f.d.serialize());const reader=new Database(file),writer=new Database(file),summary=()=>taskScoringSummary(reader,id,{viewerId:2,authorizedTaskIds:[id]});
 try{withTaskReadProjection(reader,2,()=>{
  assert.deepEqual(summary().potential,[{user_id:2,points:3}]);writer.prepare('UPDATE tasks SET points=9 WHERE id=?').run(id);
  assert.equal(taskReadRecord(reader,id).points,9);assert.deepEqual(summary().potential,[{user_id:2,points:9}],'plain projections cannot reuse scoring rows after another connection commit');
  writer.prepare("INSERT INTO task_scoring_settlements(logical_key,claim_key,task_id,root_task_id,root_logical_key,mode,points,recipients_json,earned_once,outcome,settled_at,visibility_json) VALUES(?,?,?,?,?,'whole_task',9,?,1,'earned','2026-11-01T12:00:00Z',?)").run(JSON.stringify(['task',id]),'synthetic-commit',id,id,JSON.stringify(['task',id]),JSON.stringify([{user_id:2,points:9}]),JSON.stringify({visibility:'all',created_by:1,assigned:[2],public_ancestry:true}));
  assert.deepEqual(summary().potential,[]);assert.deepEqual(summary().earned,[{user_id:2,points:9}]);assert.equal(summary().mode_locked,true);
 });}finally{reader.close();writer.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});

test('plain permission projections observe another connection authority and visibility commits',async t=>{
 const f=await scoringFixture(t),ids=[];
 for(let n=0;n<2;n++)ids.push((await f.create({assigned_to:[2],points:3})).data.id);
 const directory=mkdtempSync(join(tmpdir(),'task-authority-read-')),file=join(directory,'synthetic.db');
 writeFileSync(file,f.d.serialize());const reader=new Database(file),writer=new Database(file);
 try{withTaskReadProjection(reader,2,()=>{
  assert.equal(taskCapabilities(reader,2,{id:ids[0]}).complete,true);
  writer.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','tasks.complete_own','none')").run();
  assert.equal(taskCapabilities(reader,2,{id:ids[0]}).complete,false,'cached capabilities cannot outlive another connection authority change');
  assert.equal(taskCapabilities(reader,2,{id:ids[1]}).complete,false,'uncached Tasks must re-read actor permissions too');
  assert.equal(taskCapabilities(reader,2,{id:ids[1]}).view,true);
  writer.prepare("UPDATE tasks SET visibility='private',title='PRIVATE synthetic revoked title' WHERE id=?").run(ids[1]);
  assert.equal(taskCapabilities(reader,2,{id:ids[1]}).view,false,'plain projections cannot retain visibility after another connection commit');
  assert.equal(reader.prepare('SELECT total_changes() n').get().n,0);
 });}finally{reader.close();writer.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});
