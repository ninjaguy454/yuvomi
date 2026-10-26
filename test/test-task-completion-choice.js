import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

const routine={assigned_to:[2],points:5,scoring_mode:'subtasks',subtasks:[{title:'Earned step',points:2},{title:'Remaining step',points:3}]};
const recurring={is_recurring:true,recurrence_rule:'FREQ=DAILY;INTERVAL=7',start_date:'2026-10-30',due_date:'2026-10-30'};
const rows=(f,table)=>f.d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const finish=(f,id,complete_remaining)=>f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining});

test('compatibility reopen past deadline preserves progress without a self conflict',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,start_date:'2026-10-30',due_date:'2026-11-02',expiration_policy:'expire_incomplete'})).data;
  assert.equal((await finish(f,root.id,false)).status,200);
  f.d.prepare("UPDATE tasks SET due_date='2026-10-31' WHERE id=?").run(root.id);
  const before=root.subtasks.map(row=>f.row(row.id)),earned=rows(f,'reward_ledger');
  const body={operation_id:'compatibility-reopen-after-deadline',expected_revision:f.row(root.id).revision};
  const result=await f.call('POST',`/tasks/${root.id}/reopen-incomplete`,body);
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.row(root.id).status,'open');assert.equal(f.row(root.id).expiration_policy,'keep_overdue');
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),before);assert.deepEqual(rows(f,'reward_ledger'),earned);
  const changes=f.changes();assert.equal((await f.call('POST',`/tasks/${root.id}/reopen-incomplete`,body)).status,200);
  assert.equal(f.changes(),changes,'exact compatibility retry performs no write');
});

for(const mode of ['subtasks','whole_task'])for(const choice of [false,true])test(`${mode}: completion choice ${choice} records ordinary done and only earns completed work`,async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,scoring_mode:mode})).data;
  await f.finish(root.subtasks[0].id);
  const earned=rows(f,'reward_ledger'),children=root.subtasks.map(row=>f.row(row.id));
  const result=await finish(f,root.id,choice);
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.status,'done');
  assert.equal(f.row(root.subtasks[1].id).status,choice?'done':'open');
  if(!choice)assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),children);
  assert.deepEqual(rows(f,'reward_ledger').slice(0,earned.length),earned);
  assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),mode==='whole_task'?5:choice?5:2);
  assert.equal(rows(f,'task_completions').filter(row=>row.task_id===root.id).length,1);
  const listed=await f.call('GET','/tasks');assert.equal(listed.status,200);assert.ok(listed.data.some(row=>row.id===root.id),'Ordinary done remains available in the default human list');
  assert.equal(rows(f,'task_activity_events').filter(row=>row.action_task_id===root.id&&row.event_type==='completed').at(-1)?.details_json.includes(`"complete_remaining":${choice}`),true);
});

test('omitted completion choice confirms and invalid non-boolean choices do not mutate',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  const before=f.snapshot();
  const missing=await f.call('PATCH',`/tasks/${root.id}/status`,{status:'done'});
  assert.equal(missing.status,409);assert.equal(missing.confirmation_required,'complete_remaining');
  for(const value of ['false',0,null])assert.equal((await finish(f,root.id,value)).status,400);
  assert.equal(f.snapshot(),before);
});

for(const choice of [false,true])for(const relative of [false,true])test(`recurrence choice=${choice}, relative=${relative} advances once across replay and reopen`,async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring,recurrence_from_completion:relative})).data;
  const body={status:'done',complete_remaining:choice,...f.revisions(root.id)};
  const results=await Promise.all([f.call('PATCH',`/tasks/${root.id}/status`,body),f.call('PATCH',`/tasks/${root.id}/status`,body)]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
  const next=rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal(next.length,1);assert.equal(next[0].due_date,relative?'2026-11-08':'2026-11-06');
  const completion=rows(f,'task_completions'),ledger=rows(f,'reward_ledger');
  assert.equal((await finish(f,root.id,choice)).status,200);
  assert.deepEqual(rows(f,'task_completions'),completion);assert.deepEqual(rows(f,'reward_ledger'),ledger);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'in_progress'})).status,200);
  assert.ok(f.row(next[0].id),'Reopen preserves the existing successor');
  assert.equal((await finish(f,root.id,choice)).status,200);
  assert.deepEqual(rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id),next);
});

test('root-only completion freezes unchecked children until ordinary reopen and retains earned credits',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  await f.finish(root.subtasks[0].id);await finish(f,root.id,false);
  const before=f.snapshot();
  for(const child of root.subtasks)for(const status of ['open','in_progress','done']){
    const result=await f.call('PATCH',`/tasks/${child.id}/status`,{status});
    assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.reason,'parent_completed');
  }
  assert.equal(f.snapshot(),before);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'in_progress'})).status,200);
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['done','open']);
  assert.equal((await f.finish(root.subtasks[1].id)).status,200);
  assert.equal(f.row(root.id).status,'done');assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),5);
});

test('compatibility close/reopen keeps receipts but uses normal completion semantics',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,scoring_mode:'whole_task',...recurring})).data;
  const body={operation_id:'compat-close',expected_revision:f.row(root.id).revision,expected_series_revision:undefined};
  const close=()=>f.call('POST',`/tasks/${root.id}/close-incomplete`,body);
  assert.equal((await close()).data.status,'done');
  const before=f.snapshot();assert.equal((await close()).replayed,true);assert.equal(f.snapshot(),before);
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['open','open']);
  assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),5);
  const reopened=await f.call('POST',`/tasks/${root.id}/reopen-incomplete`,{operation_id:'compat-reopen',expected_revision:f.row(root.id).revision,expected_series_revision:undefined});
  assert.equal(reopened.status,200,JSON.stringify(reopened));assert.equal(reopened.data.status,'open');
  assert.equal(rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id).length,1);
});

test('root-only completion suppresses delegated helper work without checking its physical projection',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic completion helper',0,'normal',1)").run().lastInsertRowid);
  for(const [user,proficiency] of [[1,'excluded'],[2,'excluded'],[3,'normal']])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,proficiency);
  const {setTaskSkills}=await import('../server/services/task-skills.js');
  const {reconcileTaskSupervision,inspectTaskSupervision}=await import('../server/services/task-supervision.js');
  setTaskSkills(f.d,root.subtasks[1].id,[skill]);const view=reconcileTaskSupervision(f.d,root.id);
  const helper=view.actions.find(row=>row.action_task_id===root.subtasks[1].id),physical=f.row(helper.counterpart_task_id);
  assert.equal((await finish(f,root.id,true)).reason,'waiting_for_helper');
  const result=await finish(f,root.id,false);assert.equal(result.status,200,JSON.stringify(result));
  assert.deepEqual(f.row(helper.counterpart_task_id),physical);
  assert.equal(inspectTaskSupervision(f.d,root.id).actions.find(row=>row.action_task_id===helper.action_task_id).state,'not_required');
  const projection=(await f.call('GET',`/tasks/${view.support_task_id}`)).data;
  assert.equal(projection.status,'done');assert.equal(projection.permissions.complete,false);
  const actionProjection=(await f.call('GET',`/tasks/${helper.counterpart_task_id}`)).data;
  assert.equal(actionProjection.status,'open');assert.equal(actionProjection.permissions.complete,false);
  assert.equal(projection.subtasks.find(row=>row.id===helper.counterpart_task_id)?.status,'open');
  assert.equal((await f.call('PATCH',`/tasks/${helper.counterpart_task_id}/status`,{status:'done'},3)).status,409);
  const {deviceTaskList,deviceTaskDetail}=await import('../server/services/device-tasks.js');
  const principal={kind:'device',id:1,scope:{},permissions:{modules:{tasks:'write'},capabilities:{'tasks.view_household':'allow','device_tasks.complete':'allow'}}};
  assert.ok(!deviceTaskList(f.d,principal).some(row=>row.id===view.support_task_id));
  const deviceProjection=deviceTaskDetail(f.d,principal,view.support_task_id);
  assert.equal(deviceProjection.status,'done');assert.equal(deviceProjection.permissions.complete,false);
  assert.equal(deviceProjection.permissions.reopen,false);
  assert.equal(deviceProjection.subtasks.find(row=>row.id===helper.counterpart_task_id)?.status,'open');
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'in_progress'})).status,200);
  assert.equal(inspectTaskSupervision(f.d,root.id).actions.find(row=>row.action_task_id===helper.action_task_id).state,'assigned');
  assert.ok(deviceTaskList(f.d,principal).some(row=>row.id===view.support_task_id));
  const {createDevice}=await import('../server/services/devices.js');
  const device={kind:'device',...createDevice(f.d,{name:'Completion helper fixture'},1)};
  device.permissions.capabilities['device_tasks.complete']='allow';
  assert.equal(deviceTaskDetail(f.d,device,root.id).permissions.complete,true,'Existing root completion authority exposes the checkbox choice');
  const savedChildren=root.subtasks.map(row=>f.row(row.id));
  const {deviceTaskStatus}=await import('../server/services/device-tasks.js');
  assert.equal(deviceTaskStatus(f.d,device,root.id,{status:'done',complete_remaining:false,expected_revision:f.row(root.id).revision}).status,'done');
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),savedChildren);
});

test('done with retained unfinished children is eligible for archive after thirty days',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;await finish(f,root.id,false);
  const {reconcileTaskAutoArchive}=await import('../server/services/task-auto-archive.js');
  const completed=Date.parse(rows(f,'task_completions')[0].completed_at);
  assert.deepEqual(reconcileTaskAutoArchive(f.d,{now:new Date(completed+29*86400000)}).archivedIds,[]);
  assert.deepEqual(reconcileTaskAutoArchive(f.d,{now:new Date(completed+31*86400000)}).archivedIds,[root.id]);
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['open','open']);
});

test('retained helper projections and reminders stay out of active devices until parent reopen',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  const {deviceTaskList,deviceTaskDetail}=await import('../server/services/device-tasks.js');
  const {isNotificationDeliveryCurrent}=await import('../server/services/notification-events.js');
  const principal={kind:'device',id:1,scope:{},permissions:{modules:{tasks:'write'},capabilities:{'tasks.view_household':'allow','device_tasks.complete':'allow'}}};
  await finish(f,root.id,false);
  assert.ok(!deviceTaskList(f.d,principal).some(row=>row.id===root.id));
  assert.equal(deviceTaskDetail(f.d,principal,root.id).status,'done');
  for(const child of root.subtasks)assert.equal(deviceTaskDetail(f.d,principal,child.id).permissions.complete,false);
  for(const id of [root.id,...root.subtasks.map(row=>row.id)])assert.equal(isNotificationDeliveryCurrent(f.d,{entity_type:'task',entity_id:id,user_id:2,source_key:`synthetic-reminder-${id}`}),false);
});

test('ordinary done root with unfinished unfrozen linked work is excluded from automatic archive',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(root.id);
  f.d.prepare("INSERT INTO task_completions(task_id,series_id,user_id,completed_at) VALUES(?,?,1,'2026-10-01T12:00:00Z')").run(root.id,root.id);
  const {reconcileTaskAutoArchive}=await import('../server/services/task-auto-archive.js');
  assert.deepEqual(reconcileTaskAutoArchive(f.d,{now:new Date('2026-12-02T12:00:00Z')}).archivedIds,[]);
  assert.equal(f.row(root.id).archived_at,null);assert.equal(f.row(root.id).completion_kept_subtasks,0);
});

test('completion keeps existing authority checks and compatibility receipts reauthorize replay',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  f.grant('complete_own','none');const before=f.snapshot();
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'done',complete_remaining:false},2)).status,403);
  assert.equal(f.snapshot(),before);
  f.grant('complete_own','allow');f.d.prepare("UPDATE users SET family_role='parent' WHERE id=2").run();
  f.grant('skip_occurrence','allow');
  const body={operation_id:'replay-authority',...f.revisions(root.id),expected_series_revision:undefined};
  assert.equal((await f.call('POST',`/tasks/${root.id}/close-incomplete`,body,2)).status,200);
  f.grant('skip_occurrence','none');const closed=f.snapshot();
  assert.equal((await f.call('POST',`/tasks/${root.id}/close-incomplete`,body,2)).status,403);assert.equal(f.snapshot(),closed);
});

test('deleted recurrence successor is never recreated by reopen and root-only recompletion',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring})).data;
  assert.equal((await finish(f,root.id,false)).status,200);
  const next=rows(f,'tasks').find(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal((await f.call('DELETE',`/tasks/${next.id}`,{...f.revisions(next.id)})).status,200);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'in_progress'})).status,200);
  assert.equal((await finish(f,root.id,false)).status,200);
  assert.equal(rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id).length,0);
});

test('reopening after archive restore preserves frozen children until explicit ordinary reopen',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;await f.finish(root.subtasks[0].id);
  await finish(f,root.id,false);const children=root.subtasks.map(row=>f.row(row.id)),earned=rows(f,'reward_ledger');
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/archive`,{archived:true})).status,200);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'in_progress'})).status,409);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/archive`,{archived:false})).status,200);
  assert.equal((await f.call('PATCH',`/tasks/${root.subtasks[1].id}/status`,{status:'done'})).reason,'parent_completed');
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'in_progress'})).status,200);
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),children);assert.deepEqual(rows(f,'reward_ledger'),earned);
});

test('same-status completion still requires restoring an archived original activity',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  assert.equal((await finish(f,root.id,false)).status,200);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/archive`,{archived:true})).status,200);
  const before=f.snapshot(),result=await finish(f,root.id,false);
  assert.equal(result.status,409,JSON.stringify(result));assert.match(result.error,/Restore the original/);assert.equal(f.snapshot(),before);
});

for(const terminal of ['expired','skipped'])test(`complete remaining preserves ${terminal} child history while completing active eligible children once`,async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring})).data;
  const historical=root.subtasks[0].id;
  f.d.prepare(`UPDATE tasks SET status=?,${terminal==='expired'?'expired_at':'skipped_at'}='2026-10-31T12:00:00Z' WHERE id=?`).run(terminal,historical);
  const child=f.row(historical);
  assert.equal((await finish(f,root.id,true)).status,200);
  assert.equal(f.row(root.id).status,'done');assert.deepEqual(f.row(historical),child);assert.equal(f.row(root.subtasks[1].id).status,'done');
  const completions=rows(f,'task_completions'),ledger=rows(f,'reward_ledger');
  assert.equal(ledger.reduce((sum,row)=>sum+row.delta,0),3);assert.equal(completions.filter(row=>row.task_id===root.id).length,1);
  assert.equal(rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id).length,1);
  assert.equal((await finish(f,root.id,true)).status,200);assert.deepEqual(rows(f,'reward_ledger'),ledger);assert.deepEqual(rows(f,'task_completions'),completions);
});

test('reopening retained progress after deadline keeps overdue without changing saved children or earnings',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,expiration_policy:'expire_incomplete',due_date:'2026-11-01',due_time:'13:00'})).data;
  await f.finish(root.subtasks[0].id);assert.equal((await finish(f,root.id,false)).status,200);
  const children=root.subtasks.map(row=>f.row(row.id)),earned=rows(f,'reward_ledger');
  t.mock.timers.setTime(Date.parse('2026-11-02T12:00:00Z'));
  const reopened=await f.call('PATCH',`/tasks/${root.id}/status`,{status:'in_progress'});
  assert.equal(reopened.status,200,JSON.stringify(reopened));assert.equal(reopened.data.expiration_policy,'keep_overdue');
  const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');reconcileTaskExpirations(f.d,{now:new Date()});
  assert.equal(f.row(root.id).status,'in_progress');assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),children);assert.deepEqual(rows(f,'reward_ledger'),earned);
});

for(const terminal of ['expired','skipped'])for(const privateHistory of [false,true])test(`device completion preserves ${privateHistory?'private':'visible'} ${terminal} history and completes only active work`,async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data,old=root.subtasks[0].id;
  f.d.prepare(`UPDATE tasks SET status=?,${terminal==='expired'?'expired_at':'skipped_at'}='2026-10-31T12:00:00Z' WHERE id=?`).run(terminal,old);
  if(privateHistory){
    f.d.prepare("UPDATE tasks SET visibility='assignees',assigned_to=3 WHERE id=?").run(old);
    f.d.prepare('DELETE FROM task_assignments WHERE task_id=?').run(old);
    f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,3)').run(old);
  }
  const {createDevice}=await import('../server/services/devices.js');
  const historical=f.row(old),principal={kind:'device',...createDevice(f.d,{name:'Terminal history fixture',scope:{member_ids:[2]}},1)};
  principal.permissions.capabilities['device_tasks.complete']='allow';
  const {deviceTaskDetail,deviceTaskStatus}=await import('../server/services/device-tasks.js');
  assert.equal(deviceTaskDetail(f.d,principal,root.id).permissions.complete,true);
  const result=deviceTaskStatus(f.d,principal,root.id,{status:'done',complete_remaining:true,expected_revision:f.row(root.id).revision});
  assert.equal(result.status,'done');assert.deepEqual(f.row(old),historical);assert.equal(f.row(root.subtasks[1].id).status,'done');
  assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),3);
});
