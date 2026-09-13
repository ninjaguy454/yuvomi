import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET ||= 'task-release-concurrency-test';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {reconcileTaskSupervision,inspectTaskSupervision}=await import('../server/services/task-supervision.js');
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {callTool}=await import('../server/mcp/tools.js');

let d,server,base,admin,learner,helpers,washer,dryer;
test.beforeEach(async()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){if(typeof migration.up==='function')migration.up(d);else d.exec(migration.up);migration.afterUp?.(d);}
  _setTestDatabase(d);
  const user=(name,role='admin')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'x',?)").run(name,name,role).lastInsertRowid);
  admin=user('Creator');learner=user('Learner','member');helpers=[user('Helper One'),user('Helper Two'),user('Helper Three')];
  const skill=name=>Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(name,admin).lastInsertRowid);
  washer=skill('Washing Machine');dryer=skill('Dryer');
  for(const id of [washer,dryer]){proficiency(admin,id,'excluded');proficiency(learner,id,'supervised');for(const helper of helpers)proficiency(helper,id,'normal');}
  const app=express();app.use(express.json());app.use((req,res,next)=>{
    req.authUserId=Number(req.get('X-Actor')||admin);req.authRole=d.prepare('SELECT role FROM users WHERE id=?').get(req.authUserId)?.role;
    req.session={userId:req.authUserId};next();
  });app.use('/api/v1/tasks',tasksRouter);app.use('/api/tasks',tasksRouter);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(()=>{server?.closeAllConnections();server?.close();_setTestDatabase(null);d?.close();});
function proficiency(user,id,value){d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source)
  VALUES(?,?,?,'manual') ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`).run(user,id,value);}
async function call(method,path,body,actor=admin,prefix='/api/v1/tasks'){
  const response=await fetch(base+prefix+path,{method,headers:{'Content-Type':'application/json','X-Actor':String(actor)},body:body===undefined?undefined:JSON.stringify(body)});
  return {http:response.status,...await response.json()};
}
const read=id=>call('GET','/'+id).then(result=>result.data);
const revisions=row=>({expected_revision:row.revision,...(row.parent_revision?{expected_parent_revision:row.parent_revision}:{})});
async function plain(extra={}){
  const result=await call('POST','',{title:'Release Task',description:'- [ ] Original step',assigned_to:[admin],...extra});
  assert.equal(result.http,201,JSON.stringify(result));return result.data;
}
function laundry({recurring=false}={}){
  const insert=d.prepare("INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,due_date,due_time,is_recurring,recurrence_rule) VALUES(?,?,?,?,'2099-01-03','12:00',?,?)");
  const root=Number(insert.run('Laundry',admin,learner,null,recurring?1:0,recurring?'FREQ=WEEKLY':null).lastInsertRowid);
  const wash=Number(insert.run('Load washer',admin,null,root,0,null).lastInsertRowid);
  const dry=Number(insert.run('Start dryer',admin,null,root,0,null).lastInsertRowid);
  setTaskSkills(d,wash,[washer]);setTaskSkills(d,dry,[dryer]);
  reconcileTaskSupervision(d,root,{supervisorUserId:helpers[0]});return {root,wash,dry};
}
function assertOne(root,expected){
  const view=inspectTaskSupervision(d,root);
  assert.equal(view.supervisor_user_id,expected);
  assert.deepEqual(d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").all(root).map(row=>row.user_id),expected==null?[]:[expected]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(root).n,1);
  assert.ok(new Set(d.prepare("SELECT a.supervisor_user_id FROM task_supervision_actions a JOIN tasks t ON t.id=a.action_task_id WHERE a.source_task_id=? AND a.state='assigned' AND t.status!='done' AND t.archived_at IS NULL").all(root).map(row=>row.supervisor_user_id)).size<=1);
  return view;
}

test('legacy writes cannot overwrite newer Task state through normal or compatibility routes',async()=>{
  const task=await plain();
  assert.equal((await call('PUT','/'+task.id,{title:'Newer title',...revisions(task)})).http,200);
  for(const prefix of ['/api/v1/tasks','/api/tasks'])for(const [method,path,body] of [
    ['PUT',`/${task.id}`,{title:'Stale title',assigned_to:[learner]}],
    ['PATCH',`/${task.id}/status`,{status:'done'}],
    ['PATCH',`/${task.id}/archive`,{archived:true}],
    ['PATCH',`/${task.id}/check`,{line:0,checked:true}],
    ['PUT',`/${task.id}/documents`,{document_ids:[]}],
    ['DELETE',`/${task.id}`,{}],
  ]){
    const result=await call(method,path,body,admin,prefix);assert.equal(result.http,428,JSON.stringify({method,path,result}));
    assert.equal(result.reason,'revision_required');assert.match(result.error,/refresh|update/i);
  }
  const current=await read(task.id);assert.equal(current.title,'Newer title');assert.equal(current.status,'open');
  assert.equal(current.archived_at,null);assert.equal(current.assigned_to,admin);assert.equal(current.description,'- [ ] Original step');
});

test('safe top-level creation and comment append remain compatible, existing comment replacement requires a snapshot',async()=>{
  const task=await plain();const comment=await call('POST',`/${task.id}/comments`,{comment:'Original discussion'});
  assert.equal(comment.http,201);assert.ok(comment.task_revision);
  const rendered=await call('GET',`/${task.id}/comments`);assert.equal(rendered.task_revision,comment.task_revision);
  assert.equal((await call('PATCH',`/${task.id}/comments/${comment.data.id}`,{comment:'Legacy overwrite'})).http,428);
  assert.equal((await call('DELETE',`/${task.id}/comments/${comment.data.id}`,{})).http,428);
  assert.equal((await call('PATCH',`/${task.id}/comments/${comment.data.id}`,{comment:'Current edit',expected_revision:rendered.task_revision})).http,200);
  assert.equal((await call('PATCH',`/${task.id}/comments/${comment.data.id}`,{comment:'Stale edit',expected_revision:rendered.task_revision})).http,409);
  assert.equal((await call('GET',`/${task.id}/comments`)).data[0].comment,'Current edit');
});

test('child creation and operations require the parent snapshot, preventing stale work after a parent reset',async()=>{
  const root=await plain({subtasks:[{title:'First',skill_ids:[]},{title:'Second',skill_ids:[]}]});
  assert.equal((await call('POST','',{title:'Legacy child',parent_task_id:root.id})).http,428);
  let child=root.subtasks[0];
  assert.equal((await call('PATCH',`/${child.id}/status`,{status:'done',expected_revision:child.revision})).http,428);
  assert.equal((await call('PATCH',`/${child.id}/status`,{status:'done',...revisions(child)})).http,200);
  const beforeReset=await read(root.id),stale=beforeReset.subtasks[1];
  assert.equal((await call('PATCH',`/${root.id}/status`,{status:'open',reset_progress:true,...revisions(beforeReset)})).http,200);
  const result=await call('PATCH',`/${stale.id}/status`,{status:'done',...revisions(stale)});
  assert.equal(result.http,409);assert.equal(result.reason,'stale_revision');assert.equal((await read(stale.id)).status,'open');
});

test('revision validation distinguishes missing, malformed and stale values without writes',async()=>{
  const row=await plain();for(const value of [null,0,-1,1.1,'1']){
    assert.equal((await call('PUT','/'+row.id,{title:'Invalid',expected_revision:value})).http,400);
  }
  assert.equal((await call('PUT','/'+row.id,{title:'Stale',expected_revision:row.revision+1})).http,409);
  assert.equal((await read(row.id)).title,row.title);
});

test('two clients changing the supervisor at one revision produce exactly one winner and one linked helper Task',async()=>{
  const x=laundry();
  for(let attempt=0;attempt<12;attempt++){
    const row=await read(x.root),current=row.supervision.supervisor_user_id;
    const alternatives=helpers.filter(id=>id!==current);
    const results=await Promise.all(alternatives.map(supervisor_user_id=>call('POST',`/${x.root}/supervisor`,{supervisor_user_id,...revisions(row)})));
    assert.deepEqual(results.map(result=>result.http).sort(),[200,409]);
    assert.equal(results.find(result=>result.http===409).reason,'stale_revision');
    assertOne(x.root,results.find(result=>result.http===200).data.supervision.supervisor_user_id);
  }
});

test('revision-less or stale action-scoped supervisor changes cannot overwrite the Task-wide assignment',async()=>{
  const x=laundry();const action=await read(x.wash);
  assert.equal((await call('POST',`/${x.root}/supervisor`,{supervisor_user_id:helpers[1]})).http,428);
  assert.equal((await call('POST',`/${x.wash}/supervisor`,{supervisor_user_id:helpers[1],...revisions(action)})).http,428);
  assert.equal((await call('POST',`/${x.wash}/supervisor`,{supervisor_user_id:helpers[1],...revisions(action),expected_source_revision:action.supervision.source_revision})).http,200);
  const stale=await call('POST',`/${x.wash}/supervisor`,{supervisor_user_id:helpers[2],...revisions(action),expected_source_revision:action.supervision.source_revision});
  assert.equal(stale.http,409);assertOne(x.root,helpers[1]);
});

test('supervisor invalidation arriving before completion blocks the old actor and permits only one replacement',async()=>{
  const x=laundry();const before=await read(x.wash);const historical=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
  // A proficiency update does not change the action revision; execution must
  // resolve current qualifications rather than trusting the rendered helper.
  proficiency(helpers[0],dryer,'excluded');
  const response=await call('PATCH',`/${x.wash}/status`,{status:'done',...revisions(before)},helpers[0]);
  assert.equal(response.http,409,JSON.stringify(response));assert.match(response.error,/supervisor|supervis/i);
  assert.equal((await read(x.wash)).status,'open');assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(x.wash).n,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,historical);
  const next=reconcileTaskSupervision(d,x.root);assert.ok([helpers[1],helpers[2]].includes(next.supervisor_user_id));assertOne(x.root,next.supervisor_user_id);
  const current=await read(x.wash);assert.equal((await call('PATCH',`/${x.wash}/status`,{status:'done',...revisions(current)},next.supervisor_user_id)).http,200);
});

test('completion serialized before invalidation preserves its historical actor and replaces only remaining supervision',async()=>{
  const x=laundry();const action=await read(x.wash);
  assert.equal((await call('PATCH',`/${x.wash}/status`,{status:'done',...revisions(action)},helpers[0])).http,200);
  proficiency(helpers[0],dryer,'excluded');const next=reconcileTaskSupervision(d,x.root);
  assertOne(x.root,next.supervisor_user_id);assert.notEqual(next.supervisor_user_id,helpers[0]);
  assert.equal(d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(x.wash).supervisor_user_id,helpers[0]);
  assert.equal((await read(x.wash)).status,'done');
});

test('Availability invalidation before supervised completion rechecks the whole scope and leaves one replacement or unresolved',async()=>{
  const x=laundry();
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','activity_template')").run(x.root);
  const shift=Number(d.prepare("INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state) VALUES('Work','00:00','23:59','busy')").run().lastInsertRowid);
  const unavailable=user=>{
    const pattern=Number(d.prepare("INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES(?,'Work every day','2099-01-03',1)").run(user).lastInsertRowid);
    d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,0,?)').run(pattern,shift);
  };
  reconcileTaskSupervision(d,x.root);const before=await read(x.wash);
  unavailable(helpers[0]);
  const response=await call('PATCH',`/${x.wash}/status`,{status:'done',...revisions(before)},helpers[0]);
  assert.equal(response.http,409,JSON.stringify(response));assert.equal((await read(x.wash)).status,'open');
  const replacement=reconcileTaskSupervision(d,x.root);assert.notEqual(replacement.supervisor_user_id,helpers[0]);assert.ok(replacement.supervisor_user_id);
  assertOne(x.root,replacement.supervisor_user_id);
  unavailable(helpers[1]);unavailable(helpers[2]);reconcileTaskSupervision(d,x.root);
  const unresolved=assertOne(x.root,null);assert.equal(unresolved.state,'needed');assert.match(unresolved.reason,/eligible time|available/i);
  assert.equal((await read(x.wash)).status,'open');assert.equal((await read(x.dry)).status,'open');
});

test('concurrent parent completion generates one occurrence with one fresh supervisor relationship',async()=>{
  const x=laundry({recurring:true});const source=await read(x.root);
  const body={status:'done',complete_remaining:true,...revisions(source)};
  const results=await Promise.all([call('PATCH',`/${x.root}/status`,body,helpers[0]),call('PATCH',`/${x.root}/status`,body,helpers[0])]);
  assert.deepEqual(results.map(row=>row.http).sort(),[200,409]);
  const next=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(x.root);
  assert.equal(next.length,1);assert.equal(next[0].status,'open');assert.equal(next[0].due_date,'2099-01-10');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(x.root).n,1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM tasks WHERE parent_task_id=? AND status!='open' AND id NOT IN(SELECT task_id FROM task_activity_support_tasks)").get(next[0].id).n,0);
  assertOne(next[0].id,helpers[0]);
  proficiency(helpers[0],dryer,'excluded');reconcileTaskSupervision(d,next[0].id);
  assert.notEqual(inspectTaskSupervision(d,next[0].id).supervisor_user_id,helpers[0]);
  assert.equal(d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(x.wash).supervisor_user_id,helpers[0]);
});

test('interactive lifecycle service cannot accept a legacy blind status write, trusted internal transaction is explicit',async()=>{
  const row=await plain();
  assert.throws(()=>changeTaskStatus(d,row.id,'done',{actorId:admin}),error=>error.status===428);
  changeTaskStatus(d,row.id,'in_progress',{actorId:admin,requireRevision:false});
  assert.equal((await read(row.id)).status,'in_progress');
});

test('MCP generic API bridge preserves revision payloads and rejects old or missing Task snapshots',async()=>{
  const task=await plain();const previous=process.env.MCP_INTERNAL_BASE_URL;process.env.MCP_INTERNAL_BASE_URL=base;
  const ctx={db:d,actor:{id:admin,role:'admin'}};
  const operation={method:'PATCH',path:'/api/v1/tasks/{id}/status',path_params:{id:task.id}};
  try {
    await assert.rejects(()=>callTool(ctx,'call_api_operation',{...operation,payload:{status:'done'}}),/Refresh this Task/);
    const saved=await callTool(ctx,'call_api_operation',{...operation,payload:{status:'in_progress',...revisions(task)}});
    assert.equal(saved.data.status,'in_progress');
    await assert.rejects(()=>callTool(ctx,'call_api_operation',{...operation,payload:{status:'done',...revisions(task)}}),/changed on another device/);
    assert.equal((await read(task.id)).status,'in_progress');
  } finally {if(previous===undefined)delete process.env.MCP_INTERNAL_BASE_URL;else process.env.MCP_INTERNAL_BASE_URL=previous;}
});
