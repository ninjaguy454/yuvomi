import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {taskScoringSummary} from '../server/services/task-scoring.js';
import {withTaskReadSnapshot,withTaskReadProjection,taskReadStatement} from '../server/services/task-access.js';

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
