import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET ||= 'task-lifecycle-refinement-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default:tasksRouter } = await import('../server/routes/tasks.js');

const d=new Database(':memory:');
d.pragma('foreign_keys=ON');
for(const migration of ALL_MIGRATIONS) {
  if(typeof migration.up==='function')migration.up(d);else d.exec(migration.up);
  migration.afterUp?.(d);
}
_setTestDatabase(d);
const admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('task-admin','Parent','x','admin')").run().lastInsertRowid);
const app=express();app.use(express.json());
app.use((req,res,next)=>{req.authUserId=admin;req.authRole='admin';req.session={userId:admin};next();});
app.use('/tasks',tasksRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/tasks`;
test.after(()=>{server.closeAllConnections();server.close();d.close();});
async function call(method,path='',body) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,...await response.json()};
}
async function fixture(extra={}) {
  const response=await call('POST','',{title:'Routine',assigned_to:[admin],subtasks:[{title:'First',skill_ids:[]},{title:'Second',skill_ids:[]}],...extra});
  assert.equal(response.status,201,JSON.stringify(response));return response.data;
}
const read=id=>call('GET','/'+id).then(result=>result.data);
const transition=(task,status,extra={})=>call('PATCH',`/${task.id}/status`,
  {status,expected_revision:task.revision,...(task.parent_revision?{expected_parent_revision:task.parent_revision}:{}),...extra});

function nestedWorkflowFixture() {
  const insert=d.prepare("INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,points) VALUES (?,?,?,?,?)");
  const group=Number(insert.run('Workflow group',admin,admin,null,5).lastInsertRowid);
  const activity=Number(insert.run('Workflow Activity',admin,admin,group,0).lastInsertRowid);
  const leaf=Number(insert.run('Activity action',admin,admin,activity,0).lastInsertRowid);
  const instance=Number(d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES (?,?)').run(group,admin).lastInsertRowid);
  d.prepare("INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id,role) VALUES (?,?,'primary')").run(instance,activity);
  d.prepare('INSERT INTO workflow_task_dependencies(task_id,depends_on_task_id) VALUES (?,?)').run(group,activity);
  d.prepare('INSERT INTO workflow_task_dependencies(task_id,depends_on_task_id) VALUES (?,?)').run(activity,leaf);
  return {group,activity,leaf,instance};
}

test('nested Workflow ancestors complete and reopen through canonical history exactly once',async()=>{
  const x=nestedWorkflowFixture();
  let result=await transition(await read(x.leaf),'done');assert.equal(result.status,200,JSON.stringify(result));
  assert.equal((await read(x.activity)).status,'done');assert.equal((await read(x.group)).status,'done');
  assert.equal(d.prepare('SELECT status FROM workflow_instances WHERE id=?').get(x.instance).status,'done');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(x.group).n,1);
  for(const id of [x.activity,x.group])assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(id).n,1);
  result=await transition(await read(x.leaf),'in_progress');assert.equal(result.status,200,JSON.stringify(result));
  assert.equal((await read(x.activity)).status,'in_progress');assert.equal((await read(x.group)).status,'in_progress');
  assert.equal(d.prepare('SELECT status FROM workflow_instances WHERE id=?').get(x.instance).status,'open');
  for(const id of [x.activity,x.group]){
    assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='reopened'").get(id).n,1);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(id).n,0);
  }
});

test('confirmed Workflow reset clears Activity grandchildren as one atomic tree',async()=>{
  const x=nestedWorkflowFixture();assert.equal((await transition(await read(x.leaf),'done')).status,200);
  const response=await transition(await read(x.group),'open',{reset_progress:true});
  assert.equal(response.status,200,JSON.stringify(response));
  for(const id of [x.group,x.activity,x.leaf])assert.equal((await read(id)).status,'open');
});

test('confirmed ordinary parent completion includes all actionable descendants',async()=>{
  const insert=d.prepare('INSERT INTO tasks(title,created_by,assigned_to,parent_task_id) VALUES (?,?,?,?)');
  const root=Number(insert.run('Nested ordinary Task',admin,admin,null).lastInsertRowid);
  const child=Number(insert.run('Nested ordinary child',admin,admin,root).lastInsertRowid);
  const leaf=Number(insert.run('Nested ordinary leaf',admin,admin,child).lastInsertRowid);
  const response=await transition(await read(root),'done',{complete_remaining:true});
  assert.equal(response.status,200,JSON.stringify(response));
  for(const id of [root,child,leaf])assert.equal((await read(id)).status,'done');
});

test('reopening prior occurrence preserves edited and discussed next occurrences',async()=>{
  for(const mutation of ['edit','comment']) {
    let source=await fixture({is_recurring:true,recurrence_rule:'FREQ=WEEKLY',due_date:'2026-09-14'});
    source=(await transition(source,'done',{complete_remaining:true})).data;
    const next=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(source.id);
    assert.ok(next);
    if(mutation==='edit')assert.equal((await call('PUT',`/${next.id}`,{title:'Next occurrence changed',expected_revision:next.revision})).status,200);
    else assert.equal((await call('POST',`/${next.id}/comments`,{comment:'Please keep this discussion.'})).status,201);
    assert.equal((await transition(await read(source.id),'in_progress')).status,200);
    assert.ok(d.prepare('SELECT 1 FROM tasks WHERE id=?').get(next.id),mutation);
  }
});

test('first child starts parent, final child completes it and reports derived progress',async()=>{
  let task=await fixture();
  let result=await transition(task.subtasks[0],'done');assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.data.parent_task.status,'in_progress');assert.equal(result.data.parent_task.subtask_done,1);
  task=await read(task.id);
  result=await transition(task.subtasks[1],'done');assert.equal(result.status,200);
  assert.equal(result.data.parent_task.status,'done');assert.equal(result.data.parent_task.subtask_done,2);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(task.id).n,1);
});

test('parent completion requires confirmation and rejected request changes neither revisions nor children',async()=>{
  const task=await fixture(),before=await read(task.id);
  const denied=await transition(task,'done');
  assert.equal(denied.status,409);assert.equal(denied.confirmation_required,'complete_remaining');
  assert.deepEqual(await read(task.id),before);
  const done=await transition(task,'done',{complete_remaining:true});
  assert.equal(done.status,200);assert.equal(done.data.status,'done');assert.ok(done.data.subtasks.every(child=>child.status==='done'));
});

test('reset requires confirmation, clears all children and appends history without erasing completion event',async()=>{
  let task=await fixture();
  task=(await transition(task,'done',{complete_remaining:true})).data;
  const cancel=await transition(task,'open');assert.equal(cancel.status,409);assert.equal(cancel.confirmation_required,'reset_progress');
  assert.equal((await read(task.id)).status,'done');
  const reset=await transition(task,'open',{reset_progress:true});
  assert.equal(reset.status,200);assert.equal(reset.data.status,'open');assert.ok(reset.data.subtasks.every(child=>child.status==='open'));
  const events=(await call('GET',`/${task.id}/activity`)).data;
  assert.ok(events.some(event=>event.event_type==='completed'&&event.action_task_id===task.id));
  assert.ok(events.some(event=>event.event_type==='reset'&&event.action_task_id===task.id));
});

test('In Progress with no completed children resets without unnecessary confirmation',async()=>{
  let task=await fixture();task=(await transition(task,'in_progress')).data;
  const reset=await transition(task,'open');assert.equal(reset.status,200);
});

test('reopening Completed to In Progress retains child progress and completion audit',async()=>{
  let task=await fixture();task=(await transition(task,'done',{complete_remaining:true})).data;
  const reopen=await transition(task,'in_progress');assert.equal(reopen.status,200);
  assert.equal(reopen.data.status,'in_progress');assert.equal(reopen.data.subtask_done,2);
});

test('two device status writes: stale request cannot overwrite first transition',async()=>{
  const task=await fixture();
  assert.equal((await transition(task,'in_progress')).status,200);
  const stale=await transition(task,'done',{complete_remaining:true});
  assert.equal(stale.status,409);assert.equal(stale.reason,'stale_revision');
  assert.equal((await read(task.id)).status,'in_progress');
});

test('parent edit while child completes rejects stale edit and preserves both definition and progress',async()=>{
  const task=await fixture();
  assert.equal((await transition(task.subtasks[0],'done')).status,200);
  const edit=await call('PUT','/'+task.id,{title:'Stale replacement',expected_revision:task.revision,
    subtasks:task.subtasks.map(child=>({id:child.id,title:child.title,skill_ids:[]}))});
  assert.equal(edit.status,409);assert.equal(edit.reason,'stale_revision');
  const after=await read(task.id);assert.equal(after.title,'Routine');assert.equal(after.subtask_done,1);
});

test('reset while stale child completion in flight cannot resurrect previous progress',async()=>{
  let task=await fixture();await transition(task.subtasks[0],'done');
  task=await read(task.id);const staleChild=task.subtasks[1];
  assert.equal((await transition(task,'open',{reset_progress:true})).status,200);
  const stale=await transition(staleChild,'done');assert.equal(stale.status,409);
  assert.equal((await read(task.id)).subtask_done,0);
});

test('atomic Edit retains child IDs and status, adds/reorders definitions',async()=>{
  let task=await fixture();await transition(task.subtasks[0],'done');task=await read(task.id);
  const result=await call('PUT','/'+task.id,{expected_revision:task.revision,subtasks:[
    {id:task.subtasks[1].id,title:'Second revised',skill_ids:[]},
    {id:task.subtasks[0].id,title:'First retained',skill_ids:[]},
    {title:'New step',skill_ids:[]},
  ]});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.subtasks.length,3);
  assert.equal(result.data.subtasks[0].id,task.subtasks[1].id);
  assert.equal(result.data.subtasks[1].status,'done');assert.equal(result.data.subtasks[2].status,'open');
});

test('ordinary Task without subtasks completes normally',async()=>{
  let task=await fixture({subtasks:[]});const result=await transition(task,'done');
  assert.equal(result.status,200);assert.equal(result.data.status,'done');assert.equal(result.data.subtask_total,0);
});

test('concurrent final child completion generates exactly one fresh anchored occurrence',async()=>{
  const task=await fixture({start_date:'2099-01-03',due_date:'2099-01-03',is_recurring:1,recurrence_rule:'FREQ=WEEKLY'});
  await transition(task.subtasks[0],'done');const fresh=await read(task.id);
  const result=await transition(fresh.subtasks[1],'done');assert.equal(result.status,200);
  const duplicate=await transition(fresh.subtasks[1],'done');assert.equal(duplicate.status,409);
  const next=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(task.id);
  assert.equal(next.length,1);assert.equal(next[0].due_date,'2099-01-10');
  const children=d.prepare('SELECT * FROM tasks WHERE parent_task_id=?').all(next[0].id);
  assert.equal(children.length,2);assert.ok(children.every(child=>child.status==='open'));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_comments WHERE task_id=?').get(next[0].id).n,0);
});

test('shared change stream invalidates for a direct compatibility insert without leaking Task payload',async()=>{
  const controller=new AbortController();
  const response=await fetch(base+'/changes',{signal:controller.signal});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  const initial=decoder.decode((await reader.read()).value);
  const first=JSON.parse(initial.match(/data: (.+)/)[1]).version;
  d.prepare("INSERT INTO tasks(title,created_by) VALUES('Private stream content',?)").run(admin);
  const changed=decoder.decode((await reader.read()).value);
  assert.ok(JSON.parse(changed.match(/data: (.+)/)[1]).version>first);
  assert.doesNotMatch(changed,/Private stream content|task_id/);
  controller.abort();await reader.cancel().catch(()=>{});
});
