import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

const routine={assigned_to:[2],points:5,scoring_mode:'subtasks',subtasks:[{title:'Earned step',points:2},{title:'Unchecked step',points:3}]};
const recurring={is_recurring:true,recurrence_rule:'FREQ=DAILY;INTERVAL=7',start_date:'2026-10-30',due_date:'2026-10-30'};
const rows=(f,table)=>f.d.prepare(`SELECT * FROM ${table}`).all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const close=(f,id,body={},actor=1)=>f.call('POST',`/tasks/${id}/close-incomplete`,{operation_id:`close-${id}`,expected_series_revision:undefined,...body},actor);
const reopen=(f,id,body={},actor=1)=>f.call('POST',`/tasks/${id}/reopen-incomplete`,{operation_id:`reopen-${id}`,expected_series_revision:undefined,...body},actor);

// Fails if Close invokes completion/reset, awards points, or rewrites checklist evidence.
test('one-off closure keeps unchecked steps and all legitimately earned points',async t=>{
  const f=await scoringFixture(t),created=await f.create(routine);assert.equal(created.status,201);
  const root=created.data;assert.equal((await f.finish(root.subtasks[0].id)).status,200);
  const children=rows(f,'tasks').filter(row=>row.parent_task_id===root.id);
  const protectedTables=['reward_ledger','reward_task_awards','task_completions','task_scoring_settlements','task_scoring_completion_events'];
  const before=Object.fromEntries(protectedTables.map(table=>[table,rows(f,table)]));
  const result=await close(f,root.id);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.data.status,'closed_incomplete');assert.ok(result.data.closed_incomplete_at);
  assert.deepEqual(rows(f,'tasks').filter(row=>row.parent_task_id===root.id),children);
  for(const table of protectedTables)assert.deepEqual(rows(f,table),before[table],table);
  assert.equal(rows(f,'tasks').filter(row=>row.recurrence_origin_id===root.id).length,0);
  const {awardForCompletion}=await import('../server/services/rewards.js');
  assert.equal(awardForCompletion(f.d,root.id,2),false);assert.equal(awardForCompletion(f.d,root.subtasks[1].id,2),false);
  assert.deepEqual(rows(f,'reward_ledger'),before.reward_ledger);
});

// Fails if a close accidentally settles a whole-activity reward as successful.
test('whole-task scoring closure awards no parent points or completion record',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,scoring_mode:'whole_task'})).data;
  const result=await close(f,root.id);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(rows(f,'reward_ledger').length,0);assert.equal(rows(f,'task_completions').length,0);
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['open','open']);
});

for(const fromCompletion of [false,true])test(`recurring closure advances ${fromCompletion?'from the close date':'the calendar schedule'} once`,async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring,recurrence_from_completion:fromCompletion})).data;
  const body={operation_id:`stable-${root.id}`,expected_revision:f.row(root.id).revision};
  const result=await close(f,root.id,body);assert.equal(result.status,200,JSON.stringify(result));
  const next=rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal(next.length,1);assert.equal(next[0].due_date,fromCompletion?'2026-11-08':'2026-11-06');
  assert.deepEqual(rows(f,'tasks').filter(row=>row.parent_task_id===next[0].id).map(row=>row.status),['open','open']);
  const snapshot=f.snapshot(),replay=await close(f,root.id,body);assert.equal(replay.status,200);assert.equal(replay.replayed,true);assert.equal(f.snapshot(),snapshot);
  const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');
  reconcileTaskExpirations(f.d,{now:new Date('2026-11-01T12:00:00Z')});assert.equal(f.snapshot(),snapshot);
});

// Fails if child/helper/compatibility writers can complete work beneath a closed occurrence.
test('closed activity blocks checklist progress, generic completion and reset',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  assert.equal((await close(f,root.id)).status,200);
  const before=f.snapshot();
  for(const id of [root.id,...root.subtasks.map(row=>row.id)])for(const status of ['done','open','in_progress']){
    const result=await f.call('PATCH',`/tasks/${id}/status`,{status,complete_remaining:true,reset_progress:true});
    assert.equal(result.status,409,JSON.stringify(result));assert.equal(f.snapshot(),before);
  }
  const result=await f.edit(root.id,{status:'done',complete_remaining:true});assert.equal(result.status,409);assert.equal(f.snapshot(),before);
});

// Fails if complete/edit privileges alone grant a child or restricted parent the manager action.
test('human parent/admin authority retains current task permissions and rechecks replay',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  f.d.prepare("UPDATE users SET family_role='child' WHERE id=2").run();
  let before=f.snapshot();assert.equal((await close(f,root.id,{},2)).status,403);assert.equal(f.snapshot(),before);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=2").run();f.grant('skip_occurrence','none');
  before=f.snapshot();assert.equal((await close(f,root.id,{},2)).status,403);assert.equal(f.snapshot(),before);
  f.grant('skip_occurrence','allow');const body={operation_id:`parent-${root.id}`,expected_revision:f.row(root.id).revision};
  assert.equal((await close(f,root.id,body,2)).status,200);
  f.grant('skip_occurrence','none');before=f.snapshot();const denied=await close(f,root.id,body,2);assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),before);
});

// Fails if stale, completed, archived or future actions partially close or consume recurrence.
test('invalid lifecycle states and stale requests have no effects',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  let before=f.snapshot();assert.equal((await close(f,root.id,{expected_revision:1_000_000})).status,409);assert.equal(f.snapshot(),before);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/archive`,{archived:true})).status,200);
  before=f.snapshot();assert.equal((await close(f,root.id)).status,409);assert.equal(f.snapshot(),before);
  const completed=(await f.create(routine)).data;await f.finish(completed.id);
  before=f.snapshot();assert.equal((await close(f,completed.id)).status,409);assert.equal(f.snapshot(),before);
  const future=(await f.create({...routine,...recurring,start_date:'2026-11-02',due_date:'2026-11-02'})).data;
  before=f.snapshot();assert.equal((await close(f,future.id)).status,409);assert.equal(f.snapshot(),before);
});

// Fails if an excused activity remains in countdowns/history as unfinished or completed work.
test('closure has a zero-new-points history event and disappears from active countdowns',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,countdown:true,due_date:'2026-11-03'})).data;
  const {getCountdowns}=await import('../server/services/countdowns.js');
  const {occurrenceHistory}=await import('../server/services/task-completions.js');
  assert.ok(getCountdowns(f.d,{userId:1,todayKey:'2026-11-01'}).items.some(row=>row.id===root.id));
  assert.equal((await close(f,root.id)).status,200);
  assert.ok(!getCountdowns(f.d,{userId:1,todayKey:'2026-11-01'}).items.some(row=>row.id===root.id));
  const history=occurrenceHistory(f.d,{me:1,taskId:root.id});
  assert.equal(history.length,1);assert.equal(history[0].event_type,'closed_incomplete');assert.equal(history[0].points,0);assert.ok(history[0].closed_incomplete_at);
});

// Fails if a helper can complete an unchanged projection after its original scope closes.
test('closure leaves delegated checkboxes untouched and makes helper work non-actionable',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic delegated',0,'normal',1)").run().lastInsertRowid);
  for(const [user,proficiency] of [[1,'excluded'],[2,'excluded'],[3,'normal']])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,proficiency);
  const {setTaskSkills}=await import('../server/services/task-skills.js');
  const {reconcileTaskSupervision,inspectTaskSupervision}=await import('../server/services/task-supervision.js');
  setTaskSkills(f.d,root.subtasks[1].id,[skill]);
  const view=reconcileTaskSupervision(f.d,root.id),helper=view.actions.find(row=>row.action_task_id===root.subtasks[1].id);
  assert.ok(helper.counterpart_task_id);assert.equal(helper.execution_mode,'delegated');
  const prior=f.row(helper.counterpart_task_id);
  assert.equal((await close(f,root.id)).status,200);
  assert.deepEqual(f.row(helper.counterpart_task_id),prior);
  assert.equal(inspectTaskSupervision(f.d,root.id).actions.find(row=>row.action_task_id===helper.action_task_id).state,'not_required');
  const projection=await f.call('GET',`/tasks/${view.support_task_id}`);
  assert.equal(projection.status,200);assert.equal(projection.data.status,'closed_incomplete',JSON.stringify({id:projection.data.id,parent_task_id:projection.data.parent_task_id,is_support_task:projection.data.is_support_task,is_supervision_projection:projection.data.is_supervision_projection,support_task_id:projection.data.supervision?.support_task_id}));assert.equal(projection.data.permissions.complete,false);
  assert.equal(projection.data.can_close_incomplete,false);assert.equal(projection.data.can_reopen_incomplete,false);
  const before=f.snapshot();const result=await f.call('PATCH',`/tasks/${helper.counterpart_task_id}/status`,{status:'done'},3);
  assert.equal(result.status,409);assert.equal(f.snapshot(),before);
});

test('coupled rotation closure remains excluded without consuming a turn',async t=>{
  const f=await scoringFixture(t),created=await f.create({...routine,...recurring,assignment_mode:'round_robin',rotation_user_ids:[2,3]});
  assert.equal(created.status,201,JSON.stringify(created));const root=created.data;
  const before=f.snapshot(),result=await close(f,root.id);assert.equal(result.status,409);assert.equal(result.reason,'close_incomplete_unsupported');assert.equal(f.snapshot(),before);
});

test('occurrence-only fixed assignment cannot close an authoritative round-robin series',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring,assignment_mode:'round_robin',rotation_user_ids:[2,3]})).data;
  assert.equal((await f.edit(root.id,{edit_scope:'occurrence',assignment_mode:'fixed',assigned_to:[2],rotation_user_ids:[]})).status,200);
  const before=f.snapshot(),result=await close(f,root.id);
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.reason,'close_incomplete_unsupported');assert.equal(f.snapshot(),before);
  assert.equal((await f.call('GET',`/tasks/${root.id}`)).data.can_close_incomplete,false);
});

for(const mode of ['round_robin','binding','template_cursor'])test(`future-only ${mode} remains outside Close without consuming recurrence`,async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring})).data;
  const {taskSeriesState,appendSeriesDefinition}=await import('../server/services/task-series.js');
  const state=taskSeriesState(f.d,root.id),definition=structuredClone(state.definition.data);
  if(mode==='round_robin'){definition.task.assignment_mode='round_robin';definition.rotation_user_ids=[2,3];}
  else if(mode==='binding')definition.task.rotation_bindings_json=JSON.stringify([{purpose_key:'synthetic',group_id:1}]);
  else definition.binding={snapshot:{assignment_strategy:'eligible_round_robin',allow_assignment_override:false},assignment_override_user_id:null};
  appendSeriesDefinition(f.d,root.id,{actorId:1,definition,effectiveGeneration:state.occurrence.generation+1,force:true});
  const before=f.snapshot(),result=await close(f,root.id);
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.reason,'close_incomplete_unsupported');assert.equal(f.snapshot(),before);
  assert.equal((await f.call('GET',`/tasks/${root.id}`)).data.can_close_incomplete,false);
});

test('legacy expired-child Reopen cannot change closed activity progress or policy',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data,child=root.subtasks[1].id;
  assert.equal((await f.edit(child,{expiration_policy:'expire_incomplete',due_date:'2026-11-01',due_time:'13:00'})).status,200);
  t.mock.timers.setTime(Date.parse('2026-11-02T12:00:00Z'));
  const {expireTask}=await import('../server/services/task-lifecycle.js');assert.equal(expireTask(f.d,child).expired,true);
  assert.equal((await close(f,root.id)).status,200);
  const before=f.snapshot(),result=await f.call('POST',`/tasks/${child}/reopen`,{expiration_policy:'keep_overdue'});
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.reason,'task_closed_incomplete');assert.equal(f.snapshot(),before);
  assert.equal((await reopen(f,root.id)).status,200);
  assert.equal((await f.call('POST',`/tasks/${child}/reopen`,{expiration_policy:'keep_overdue'})).status,200);
  assert.equal(f.row(child).status,'open');
});

test('devices omit closed helper work from active lists and truthfully project direct history',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic device helper',0,'normal',1)").run().lastInsertRowid);
  for(const [user,proficiency] of [[1,'excluded'],[2,'excluded'],[3,'normal']])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,proficiency);
  const {setTaskSkills}=await import('../server/services/task-skills.js');
  const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
  const {deviceTaskList,deviceTaskDetail}=await import('../server/services/device-tasks.js');
  setTaskSkills(f.d,root.subtasks[1].id,[skill]);const view=reconcileTaskSupervision(f.d,root.id),id=view.support_task_id;
  const principal={kind:'device',id:1,scope:{},permissions:{modules:{tasks:'write'},capabilities:{'tasks.view_household':'allow','device_tasks.complete':'allow'}}};
  assert.ok(deviceTaskList(f.d,principal).some(row=>row.id===id));const physical=f.row(id);
  assert.equal((await close(f,root.id)).status,200);
  const before=f.snapshot();
  for(const query of [null,{}, {status:'open'},{status:'in_progress'}])assert.ok(!deviceTaskList(f.d,principal,{query}).some(row=>row.id===id),JSON.stringify(query));
  const detail=deviceTaskDetail(f.d,principal,id);assert.equal(detail.status,'closed_incomplete');assert.equal(detail.closed_incomplete_at,f.row(root.id).closed_incomplete_at);
  assert.equal(detail.permissions.complete,false);assert.equal(detail.permissions.reopen,false);assert.equal(detail.permissions.reset,false);
  const history=deviceTaskList(f.d,principal,{query:{status:'closed_incomplete'}});assert.ok(history.some(row=>row.id===id&&row.status==='closed_incomplete'));
  assert.deepEqual(f.row(id),physical);assert.equal(f.snapshot(),before);
});

test('queued assignment and reminder deliveries become stale for closed roots and unchecked children',async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  const {isNotificationDeliveryCurrent}=await import('../server/services/notification-events.js');
  const notifications=[root.id,root.subtasks[1].id].map(id=>({entity_type:'task',entity_id:id,user_id:2,source_key:`synthetic-reminder-${id}`}));
  for(const notification of notifications)assert.equal(isNotificationDeliveryCurrent(f.d,notification),true);
  assert.equal((await close(f,root.id)).status,200);
  for(const notification of notifications)assert.equal(isNotificationDeliveryCurrent(f.d,notification),false);
});

test('concurrent completion and close produce one outcome and at most one successor',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring})).data;
  const revision=f.row(root.id).revision;
  const results=await Promise.all([close(f,root.id,{expected_revision:revision}),f.call('PATCH',`/tasks/${root.id}/status`,{status:'done',complete_remaining:true,expected_revision:revision})]);
  assert.equal(results.filter(row=>row.status===200).length,1,JSON.stringify(results));assert.equal(results.filter(row=>row.status===409).length,1);
  assert.equal(rows(f,'tasks').filter(row=>row.recurrence_origin_id===root.id&&row.parent_task_id===null).length,1);
  if(f.row(root.id).status==='closed_incomplete'){assert.equal(rows(f,'reward_ledger').length,0);assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['open','open']);}
});

test('explicit reopen resumes saved progress and normal newly earned points without a second successor',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring,recurrence_from_completion:true})).data;
  await f.finish(root.subtasks[0].id);const earnings=rows(f,'reward_ledger');
  assert.equal((await close(f,root.id)).status,200);
  const successor=rows(f,'tasks').find(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id),children=root.subtasks.map(row=>f.row(row.id));
  t.mock.timers.setTime(Date.parse('2026-11-03T12:00:00Z'));
  const body={operation_id:'reopen-progress',expected_revision:f.row(root.id).revision};
  const result=await reopen(f,root.id,body);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.status,'in_progress');assert.equal(result.data.closed_incomplete_at,null);
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),children);assert.deepEqual(rows(f,'reward_ledger'),earnings);assert.deepEqual(f.row(successor.id),successor);
  const before=f.snapshot();assert.equal((await reopen(f,root.id,body)).replayed,true);assert.equal(f.snapshot(),before);
  assert.equal((await f.finish(root.subtasks[1].id)).status,200);assert.equal(f.row(root.id).status,'done');
  assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),5);assert.deepEqual(f.row(successor.id),successor);
  assert.equal(rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id).length,1);
});

test('close/reopen/reset/recompletion retains the original successor and frozen credit rules',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring})).data;
  assert.equal((await close(f,root.id)).status,200);const successor=rows(f,'tasks').find(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal((await reopen(f,root.id)).status,200);assert.equal((await f.finish(root.id)).status,200);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'open',reset_progress:true})).status,200);
  assert.deepEqual(f.row(successor.id),successor);assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),0);
  assert.equal((await f.finish(root.id)).status,200);assert.deepEqual(f.row(successor.id),successor);
  assert.equal(rows(f,'reward_ledger').filter(row=>row.type==='earn').length,2);assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),5);
});

test('a deleted successor is not regenerated by reopening and completing its closed predecessor',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring})).data;
  assert.equal((await close(f,root.id)).status,200);const successor=rows(f,'tasks').find(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal((await f.call('DELETE',`/tasks/${successor.id}`,f.revisions(successor.id))).status,200);
  assert.equal((await reopen(f,root.id)).status,200);assert.equal((await f.finish(root.id)).status,200);
  assert.equal(rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id).length,0);
  assert.equal(f.d.prepare('SELECT recurrence_handled FROM task_incomplete_closures WHERE task_id=?').get(root.id).recurrence_handled,1);
});

test('reclosing uses the first closure anchor and leaves both progress and existing recurrence intact',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring,recurrence_from_completion:true})).data;
  assert.equal((await close(f,root.id)).status,200);const successor=rows(f,'tasks').find(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal((await reopen(f,root.id)).status,200);const first=f.d.prepare('SELECT * FROM task_incomplete_closures WHERE task_id=?').get(root.id);
  t.mock.timers.setTime(Date.parse('2026-11-04T12:00:00Z'));
  assert.equal((await close(f,root.id,{operation_id:'close-again'})).status,200);assert.deepEqual(f.row(successor.id),successor);
  assert.deepEqual(f.d.prepare('SELECT * FROM task_incomplete_closures WHERE task_id=?').get(root.id),first);
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['open','open']);assert.equal(rows(f,'reward_ledger').length,0);
});

test('reopen preserves an earlier legitimate whole-task award and never awards it twice',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,scoring_mode:'whole_task'})).data;
  await f.finish(root.id);assert.equal(rows(f,'reward_ledger').reduce((sum,row)=>sum+row.delta,0),5);
  assert.equal((await f.call('PATCH',`/tasks/${root.subtasks[0].id}/status`,{status:'open'})).status,200);
  const earned=rows(f,'reward_ledger');assert.equal((await close(f,root.id)).status,200);assert.equal((await reopen(f,root.id)).status,200);
  assert.deepEqual(rows(f,'reward_ledger'),earned);await f.finish(root.subtasks[0].id);assert.deepEqual(rows(f,'reward_ledger'),earned);
});

for(const action of ['complete','close'])test(`one-off reopening can adopt recurrence and ${action} without using its earlier non-recurring close date`,async t=>{
  const f=await scoringFixture(t),root=(await f.create(routine)).data;
  assert.equal((await close(f,root.id)).status,200);assert.equal((await reopen(f,root.id)).status,200);
  t.mock.timers.setTime(Date.parse('2026-11-03T12:00:00Z'));
  assert.equal((await f.edit(root.id,{is_recurring:true,recurrence_from_completion:true,recurrence_rule:'FREQ=DAILY;INTERVAL=7',start_date:'2026-11-03',due_date:'2026-11-03'})).status,200);
  assert.equal((await (action==='complete'?f.finish(root.id):close(f,root.id,{operation_id:'first-recurring-close'}))).status,200);
  const successors=rows(f,'tasks').filter(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal(successors.length,1);assert.equal(successors[0].due_date,'2026-11-10');
});

test('completion-relative close uses household-local date across the DST boundary',async t=>{
  const f=await scoringFixture(t);f.d.prepare("UPDATE sync_config SET value='America/New_York' WHERE key='household_timezone'").run();
  t.mock.timers.setTime(Date.parse('2026-11-01T00:30:00Z'));
  const root=(await f.create({...routine,...recurring,recurrence_from_completion:true})).data;
  assert.equal((await close(f,root.id)).status,200);
  const next=rows(f,'tasks').find(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id);
  assert.equal(next.due_date,'2026-11-07');
});

test('a recurrence date conflict rolls back the entire close without touching progress, points or receipts',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring,recurrence_rule:'FREQ=DAILY',recurrence_from_completion:true,due_date:'2026-11-02'})).data;
  const before=f.snapshot(),result=await close(f,root.id);assert.equal(result.status,409);assert.equal(result.reason,'recurrence_date_conflict');assert.equal(f.snapshot(),before);
});

test('reopening after the deadline keeps this occurrence overdue without altering its successor or saved progress',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...routine,...recurring,recurrence_rule:'FREQ=DAILY',recurrence_from_completion:true,due_date:'2026-11-01',due_time:'20:00',expiration_policy:'expire_incomplete'})).data;
  await f.finish(root.subtasks[0].id);assert.equal((await close(f,root.id)).status,200);
  const next=rows(f,'tasks').find(row=>row.parent_task_id===null&&row.recurrence_origin_id===root.id),children=root.subtasks.map(row=>f.row(row.id)),earned=rows(f,'reward_ledger');
  t.mock.timers.setTime(Date.parse('2026-11-02T12:00:00Z'));
  const result=await reopen(f,root.id);assert.equal(result.status,200);assert.equal(result.data.expiration_policy,'keep_overdue');assert.equal(result.data.status,'in_progress');
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),children);assert.deepEqual(rows(f,'reward_ledger'),earned);assert.deepEqual(f.row(next.id),next);
  const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');reconcileTaskExpirations(f.d,{now:new Date()});
  assert.equal(f.row(root.id).status,'in_progress');assert.deepEqual(f.row(next.id),next);
});
