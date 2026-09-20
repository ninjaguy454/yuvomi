import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET||='device-task-test';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js'); // Install the existing recurrence adapter.
const {default:searchRouter}=await import('../server/routes/search.js');
const {createDevice}=await import('../server/services/devices.js');
const {deviceTaskList,deviceTaskDetail,deviceTaskStatus,deviceTaskClaim}=await import('../server/services/device-tasks.js');
const {deviceTaskCreate,deviceTaskUpdate}=await import('../server/services/device-task-definitions.js');
const {assertTaskMutation}=await import('../server/services/task-access.js');
const {changeTaskStatus,taskActivity}=await import('../server/services/task-lifecycle.js');
const {occurrenceFeed}=await import('../server/services/task-completions.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
let d,admin,kids,principal;
test.beforeEach(()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);}
  _setTestDatabase(d);
  const user=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)")
    .run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  admin=user('Parent','admin');kids=['Grace','Eleanor','Frankie'].map(name=>user(name));
  for(const id of kids)d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  principal={kind:'device',...createDevice(d,{name:'Kitchen Wall'},admin)};
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});
function seed(name,assigned=kids[0],parent=null,points=0,extra={}) {
  const id=Number(d.prepare('INSERT INTO tasks(title,assigned_to,parent_task_id,points,created_by,visibility) VALUES(?,?,?,?,?,?)')
    .run(name,assigned,parent,points,admin,extra.visibility||'all').lastInsertRowid);
  if(assigned)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,assigned);
  if(extra.optional)d.prepare('UPDATE tasks SET is_optional=1 WHERE id=?').run(id);
  return id;
}
function revisions(id) {const row=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);return {expected_revision:row.revision,
  ...(row.parent_task_id?{expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(row.parent_task_id).revision}:{})};}
const status=(id,value='done',extra={})=>deviceTaskStatus(d,principal,id,{status:value,...revisions(id),...extra});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const count=(table,where='1')=>d.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get().n;

test('three children complete separate routines without human impersonation, awards and Activity once',()=>{
  const roots=kids.map((kid,index)=>seed(`Routine ${index}`,kid,null,2));
  const steps=roots.map(root=>seed('Brush teeth',null,root));
  assert.equal(count('users'),4,'pairing creates no member');
  for(const id of steps){const result=status(id);assert.equal(result.status,'done');assert.equal(result.parent_task.status,'done');}
  assert.equal(count('reward_ledger'),3);assert.equal(count('reward_task_awards'),3);
  assert.deepEqual(d.prepare('SELECT user_id,delta,created_by FROM reward_ledger ORDER BY user_id').all(),kids.map(id=>({user_id:id,delta:2,created_by:null})));
  for(const [index,id] of roots.entries()) {
    const history=taskActivity(d,id).filter(event=>event.event_type==='completed');
    assert.equal(history.length,2);assert.ok(history.every(event=>event.actor_user_id===null && event.details.source_device.name==='Kitchen Wall'));
    assert.ok(history.some(event=>event.details.assigned_members.some(member=>member.id===kids[index])));
    status(steps[index]); // A canonical duplicate is a no-op.
  }
  assert.equal(count('reward_ledger'),3);assert.equal(count('task_activity_events',"event_type='completed'"),6);
  const feed=occurrenceFeed(d,{me:admin}).entries;
  assert.equal(feed.length,3);assert.ok(feed.every(entry=>entry.user_id===null&&entry.source_device_name==='Kitchen Wall'));
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('creation and structural edits fail closed; stale revisions reject, reopen and reset are independent opt-ins',()=>{
  const id=seed('Permitted',kids[0],null,2),before=revisions(id);
  for(const body of [{points:100},{title:'rewarded'},{activity_template_id:1},{assigned_to:kids}])assert.throws(()=>assertTaskMutation(d,principal,null,body,{operation:'create'}),/cannot create/);
  assert.throws(()=>status(id,'done',{points:100}),/existing progress only/);
  status(id);
  assert.throws(()=>deviceTaskStatus(d,principal,id,{status:'done',...before}),/changed|revision/i);
  assert.throws(()=>status(id,'in_progress'),/does not permit/);
  principal.permissions.capabilities['device_tasks.reopen']='allow';status(id,'in_progress');
  assert.throws(()=>status(id,'open',{reset_progress:true}),/does not permit/);
  principal.permissions.capabilities['device_tasks.reset']='allow';status(id,'open',{reset_progress:true});status(id);
  assert.equal(count('reward_ledger'),1);assert.equal(row(id).points,2);
});

test('reopen-only checkbox undoes one completed leaf while parent resets remain separately authorized and confirmed',()=>{
  const parent=seed('Routine',kids[0],null,2),first=seed('First step',null,parent),second=seed('Second step',null,parent);
  status(first);status(second);assert.equal(row(parent).status,'done');
  principal.permissions.capabilities['device_tasks.reopen']='allow';
  assert.equal(deviceTaskDetail(d,principal,first).permissions.reopen,true);
  const reopened=status(first,'open');
  assert.equal(reopened.status,'open');assert.equal(reopened.parent_task.status,'in_progress');
  assert.equal(row(second).status,'done');assert.equal(count('reward_ledger'),1);
  status(first);assert.equal(row(parent).status,'done');assert.equal(count('reward_ledger'),1);
  assert.throws(()=>status(first,'open',{reset_progress:true}),/does not permit/);
  assert.throws(()=>status(parent,'open',{reset_progress:true}),/does not permit/);
  principal.permissions.capabilities['device_tasks.reset']='allow';
  assert.throws(()=>status(parent,'open'),error=>error.details?.confirmation_required==='reset_progress');
  assert.equal(row(first).status,'done');assert.equal(row(second).status,'done');
  status(parent,'open',{reset_progress:true});
  assert.equal(row(parent).status,'open');assert.equal(row(first).status,'open');assert.equal(row(second).status,'open');
  assert.equal(count('reward_ledger'),1);
});

test('full device snapshots exclude private Tasks, hidden ancestry, unsupported metadata and member-filtered work',()=>{
  const publicId=seed('Public');const privateId=seed('SECRET title',kids[0],null,0,{visibility:'private'});
  const hiddenChild=seed('SECRET nested title',kids[0],privateId);seed('Other member',kids[1]);
  d.prepare("UPDATE tasks SET description='SECRET description' WHERE id=?").run(privateId);
  principal.scope.member_ids=[kids[0]];
  const data=deviceTaskList(d,principal);assert.equal(data.length,1);assert.equal(data[0].id,publicId);
  assert.ok(!JSON.stringify(data).includes('SECRET'));
  assert.ok(!('created_by' in data[0]));assert.ok(!('rotation_bindings_json' in data[0]));
  for(const id of [privateId,hiddenChild])assert.throws(()=>deviceTaskDetail(d,principal,id),/not available/);
  assert.throws(()=>status(privateId),/not available/);
});

test('supervised, helper-owned and bulk descendant completion cannot borrow device or pairing-admin authority',()=>{
  const root=seed('Laundry',kids[1],null,2),independent=seed('Gather laundry',null,root),protectedId=seed('Use washer',null,root);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washer',0,'normal',?)").run(admin).lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'supervised','manual',?)").run(kids[1],skill,admin);
  setTaskSkills(d,protectedId,[skill]);
  const view=reconcileTaskSupervision(d,root);const mapping=view.actions.find(action=>action.action_task_id===protectedId);
  assert.equal(mapping.supervisor_user_id,admin);
  const helperScope={...principal,scope:{...principal.scope,member_ids:[admin]}};
  assert.throws(()=>deviceTaskDetail(d,helperScope,mapping.counterpart_task_id),/not available/,'helper membership does not expose an out-of-scope learner action');
  status(independent);assert.equal(row(root).status,'in_progress');
  for(const id of [protectedId,mapping.counterpart_task_id,view.support_task_id,root])assert.throws(()=>status(id,'done',{complete_remaining:true}),/qualified|supervised|helper/);
  assert.equal(row(protectedId).status,'open');assert.equal(count('reward_ledger'),0);
  changeTaskStatus(d,protectedId,'done',{actorId:admin,body:revisions(protectedId)});
  assert.equal(row(root).status,'done');assert.equal(count('reward_ledger'),1);
  assert.equal(d.prepare('SELECT user_id FROM reward_ledger').get().user_id,kids[1]);
});

test('private descendants block bulk completion atomically; optional and start/expiration semantics remain canonical',()=>{
  const root=seed('Morning',kids[0],null,2),normal=seed('Required',null,root),hidden=seed('SECRET step',null,root,0,{visibility:'private'});
  assert.throws(()=>status(root,'done',{complete_remaining:true}),/not available/);assert.equal(row(normal).status,'open');
  d.prepare("UPDATE tasks SET visibility='all',is_optional=1 WHERE id=?").run(hidden);
  status(normal);assert.equal(row(root).status,'done');assert.equal(row(hidden).status,'open');
  assert.throws(()=>status(hidden),/Reopen|completed parent/i);
  const future=seed('Future');d.prepare("UPDATE tasks SET is_recurring=1,start_date='2099-01-01',recurrence_rule='FREQ=DAILY' WHERE id=?").run(future);
  assert.throws(()=>status(future),/cannot be completed yet/);
  const expired=seed('Expired');d.prepare("UPDATE tasks SET status='expired',expired_at='2026-01-01T08:00:00Z' WHERE id=?").run(expired);
  assert.throws(()=>status(expired),/expired|Reopen/i);assert.equal(count('reward_ledger'),1);
});

test('claim requires a per-action allowed recipient, records device source and preserves canonical eligibility',()=>{
  const id=seed('Open chore',null);
  d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state,source) VALUES(?,'open_claimable','open','planning_context')").run(id);
  d.prepare('INSERT INTO task_claim_eligibility(task_id,user_id) VALUES(?,?)').run(id,kids[0]);
  assert.throws(()=>deviceTaskClaim(d,principal,id,{...revisions(id),user_id:kids[0]}),/does not permit/);
  principal.permissions.capabilities['device_tasks.claim']='allow';
  principal.scope.member_ids=[kids[0]];
  assert.throws(()=>deviceTaskClaim(d,principal,id,revisions(id)),/Choose the member/);
  assert.throws(()=>deviceTaskClaim(d,principal,id,{...revisions(id),user_id:kids[1]}),/cannot claim/);
  const result=deviceTaskClaim(d,principal,id,{...revisions(id),user_id:kids[0]});assert.equal(result.assigned_to,kids[0]);
  const event=taskActivity(d,id).find(event=>event.event_type==='claimed');assert.equal(event.actor_user_id,null);assert.equal(event.details.assigned_user_id,kids[0]);assert.equal(event.details.source_device.name,'Kitchen Wall');
});

test('canonical recurrence can generate follow-up work without granting device Task creation',()=>{
  const id=seed('Daily routine',kids[0],null,2);
  d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=DAILY',start_date='2026-09-01',due_date='2026-09-01' WHERE id=?").run(id);
  status(id);assert.ok(d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=?').get(id));
  assert.throws(()=>assertTaskMutation(d,principal,null,{title:'New'},{operation:'create'}),/cannot create/);
  assert.equal(count('reward_ledger'),1);
});

test('opt-in device creation uses canonical validation, null human creator and explicit device provenance',()=>{
  const body={title:'Device authored chore',assigned_to:[kids[0]],points:0};
  assert.throws(()=>deviceTaskCreate(d,principal,body),/cannot create/);
  principal.permissions.capabilities['tasks.create']='allow';
  assert.throws(()=>deviceTaskCreate(d,principal,body),/Task setting/);
  principal.permissions.capabilities['tasks.change_assignment']='allow';
  const made=deviceTaskCreate(d,principal,body);assert.equal(made.title,body.title);assert.equal(made.points,0);
  const stored=row(made.id);assert.equal(stored.created_by,null);assert.equal(stored.source_device_id,principal.id);assert.equal(stored.source_device_name,'Kitchen Wall');
  const history=taskActivity(d,made.id).find(event=>event.event_type==='created');assert.equal(history.actor_user_id,null);assert.equal(history.details.source_device.id,principal.id);
  assert.equal(count('users'),4);assert.equal(count('reward_ledger'),0);
});

test('resolved default points and indirect creation paths cannot bypass device point permission',()=>{
  for(const key of ['tasks.create','tasks.change_assignment'])principal.permissions.capabilities[key]='allow';
  d.prepare("INSERT INTO sync_config(key,value) VALUES('tasks_default_points','5') ON CONFLICT(key) DO UPDATE SET value='5'").run();
  assert.throws(()=>deviceTaskCreate(d,principal,{title:'Implicit reward',assigned_to:[kids[0]]}),/Task setting/);
  // Explicit nonzero points are always protected, including when other creation is allowed.
  assert.throws(()=>deviceTaskCreate(d,principal,{title:'Rewarded',assigned_to:kids,points:5}),/Task setting/);
  const template=Number(d.prepare("INSERT INTO activity_templates(name,title_template,created_by) VALUES('Reward template','Reward template',?)").run(admin).lastInsertRowid);
  for(const extra of [{activity_template_id:template},{activity_binding:{activity_template_id:template}},{subtasks:[{title:'Extra',points:5}]},
    {status:'done'},{rotation_bindings:[{purpose_key:'unauthorized',group_id:1}]},{created_by:admin},{source_device_id:principal.id},{sync_target:{}}])
    assert.throws(()=>deviceTaskCreate(d,principal,{title:'Indirect',assigned_to:[kids[0]],points:0,...extra}),/plain Task/);
  assert.equal(count('tasks'),0);
});

test('device-authored recurring Tasks remain visible to personal readers and complete with canonical successor and points',async()=>{
  for(const key of ['tasks.create','tasks.change_assignment','tasks.change_dates','tasks.change_points'])principal.permissions.capabilities[key]='allow';
  const task=deviceTaskCreate(d,principal,{title:'Device recurrence visibility',assigned_to:[kids[0]],points:2,
    is_recurring:true,recurrence_rule:'FREQ=DAILY',start_date:'2026-09-01',due_date:'2026-09-01'});
  assert.equal(row(task.id).created_by,null);
  const app=express();app.use((req,res,next)=>{req.authUserId=admin;req.authRole='admin';req.session={userId:admin,role:'admin'};next();});
  app.use('/tasks',tasksRouter);app.use('/search',searchRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const path of [`/tasks/${task.id}`,'/tasks','/search?q=Device%20recurrence']) {
      const res=await fetch(base+path);assert.equal(res.status,200,path);const content=await res.text();assert.ok(content.includes(task.title),path);
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  status(task.id);const next=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=?').get(task.id);assert.ok(next);assert.equal(next.created_by,null);assert.equal(next.points,2);
  assert.equal(next.source_device_id,principal.id);assert.equal(next.source_device_name,'Kitchen Wall');
  assert.equal(count('reward_ledger'),1);assert.equal(d.prepare('SELECT user_id,created_by FROM reward_ledger').get().user_id,kids[0]);
  assert.equal(taskActivity(d,next.id).find(event=>event.event_type==='recurrence_generated').actor_user_id,null);
});

test('opt-in text, date, assignee and point changes enforce separate capabilities, revisions and shared scope',()=>{
  const id=seed('Original',kids[0],null,2);
  assert.throws(()=>deviceTaskUpdate(d,principal,id,{title:'Changed',...revisions(id)}),/does not permit/);
  principal.permissions.capabilities['tasks.edit_others']='allow';
  const edited=deviceTaskUpdate(d,principal,id,{title:'Changed',...revisions(id)});assert.equal(edited.title,'Changed');
  for(const change of [{points:3},{assigned_to:[kids[1]]},{due_date:'2026-12-01'}])
    assert.throws(()=>deviceTaskUpdate(d,principal,id,{...change,...revisions(id)}),/Task setting/);
  for(const key of ['tasks.change_dates','tasks.change_points','tasks.change_assignment','tasks.reassign'])principal.permissions.capabilities[key]='allow';
  const result=deviceTaskUpdate(d,principal,id,{assigned_to:[kids[1]],points:3,start_date:'2026-12-01',start_time:'07:00',due_date:'2026-12-01',due_time:'08:00',...revisions(id)});
  assert.equal(result.assigned_to,kids[1]);assert.equal(result.points,3);assert.equal(result.start_time,'07:00');assert.equal(count('reward_ledger'),0);
  const event=taskActivity(d,id).find(event=>event.event_type==='edited');assert.equal(event.actor_user_id,null);assert.equal(event.details.source_device.name,'Kitchen Wall');
  principal.scope.member_ids=[kids[1]];
  assert.throws(()=>deviceTaskUpdate(d,principal,id,{assigned_to:[kids[2]],...revisions(id)}),/permitted on this display/);assert.equal(row(id).assigned_to,kids[1]);
  assert.throws(()=>deviceTaskUpdate(d,principal,id,{due_time:'06:00',...revisions(id)}),/Due|due/);assert.equal(row(id).due_time,'08:00');
  const stale=revisions(id);deviceTaskUpdate(d,principal,id,{description:'Text',...stale});
  assert.throws(()=>deviceTaskUpdate(d,principal,id,{description:'Stale',...stale}),/changed|revision/i);assert.equal(row(id).description,'Text');
  const child=seed('Editable child',null,id);
  assert.throws(()=>deviceTaskUpdate(d,principal,child,{title:'New child',expected_revision:row(child).revision}),error=>error.status===428&&error.details?.reason==='revision_required');
});
