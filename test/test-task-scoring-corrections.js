import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
const {taskSeriesState,seriesDefinitionForGeneration}=await import('../server/services/task-series.js');
const {proposedSeriesDefinition}=await import('../server/services/task-series-edit.js');
const {issueWallActor}=await import('../server/services/wall.js');
const {recordTaskScoringSettlement}=await import('../server/services/task-scoring.js');
const recurring={assigned_to:[2],start_date:'2026-11-01',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'};
const pending=(f,id)=>{const state=taskSeriesState(f.d,id);return seriesDefinitionForGeneration(f.d,state.series_id,state.occurrence.generation+1).data;};
async function purePreview(f,id,body,actor=1){
  const before=f.snapshot(),changes=f.changes(),input=structuredClone(body);
  const result=await f.preview(id,body,actor);
  assert.equal(f.snapshot(),before,'preview preserves every table, schema and sequence');
  assert.equal(f.changes(),changes,'preview performs zero writes, including rolled-back writes');
  assert.deepEqual(body,input,'request intent remains unchanged');
  return result;
}

for(const archived of [false,true])test(`Wall ${archived?'archived':'deleted'} history intersects host and selected actor capabilities`,async t=>{
  const f=await scoringFixture(t),r=await f.create({assigned_to:[2],scoring_mode:'subtasks',subtasks:[{title:'Other work',points:91},{title:'Remaining',points:4}]});
  const child=r.data.subtasks[0].id;
  await f.edit(child,{assigned_to:[3]});await f.finish(child);
  if(archived)f.d.prepare("UPDATE tasks SET archived_at='2026-11-01T12:00:00Z' WHERE id=?").run(child);
  else f.d.prepare('DELETE FROM tasks WHERE id=?').run(child);
  f.grant('view_household','none');f.grant('view_own','allow');
  const token=issueWallActor(f.d,{sessionId:'scoring-wall-fixture',hostId:1,user:f.d.prepare('SELECT * FROM users WHERE id=2').get()});
  const before=f.snapshot(),changes=f.changes();
  for(const [host,headers] of [[2,{}],[1,{'X-Wall-Actor':token}]]){
    const wall=await f.call('GET','/wall/tasks/'+r.data.id,undefined,host,headers);
    assert.equal(wall.status,200);assert.deepEqual(wall.data.scoring.earned,[]);
    assert.ok(!wall.data.scoring.settled_task_ids.includes(child));assert.equal(wall.data.scoring.mode_locked,true);
    assert.equal(wall.data.scoring.personal_total,host===2?null:4);
  }
  const permitted=await f.call('GET','/wall/tasks/'+r.data.id);
  assert.deepEqual(permitted.data.scoring.earned,[{user_id:3,points:91}]);
  assert.equal(f.snapshot(),before);assert.equal(f.changes(),changes);
});

test('historical compatible root reassignment replaces read joins and retains original creator',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,visibility:'assignees',points:5,scoring_mode:'whole_task'});
  await f.finish(r.data.id);
  const saved=await f.edit(r.data.id,{edit_scope:'future',assigned_to:[3],title:'Member three future'});
  assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(pending(f,r.data.id).authorization,{created_by:1,assigned_user_ids:[3]});
  assert.equal((await purePreview(f,r.data.id,{edit_scope:'future_only',include_edit_definition:true,future_patch:{}},2)).status,404);
  const successor=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(r.data.id);
  assert.equal(successor.assigned_to,3);
  assert.equal((await purePreview(f,successor.id,{edit_scope:'future_only',include_edit_definition:true,future_patch:{}},3)).status,200);
});

test('compatible action proposal updates explicit read joins without overwriting creator or omitted evidence',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,scoring_mode:'subtasks',subtasks:[{title:'A',points:2},{title:'B',points:3}]});
  const before=structuredClone(taskSeriesState(f.d,r.data.id).definition.data),input=structuredClone(before);
  const editedSubtasks={next:before.subtasks.map((action,i)=>({id:action.source_task_id,title:action.task.title,points:action.task.points,isOptional:0,skillIds:[],...(i===0?{assignedUsers:[3]}:{})}))};
  const after=proposedSeriesDefinition(before,{fields:{},assigned:[2],rotation:[],skills:[],editedSubtasks,authorId:2,assignmentExplicit:false});
  assert.deepEqual(after.subtasks[0].authorization,{created_by:1,assigned_user_ids:[3]});
  assert.deepEqual(after.subtasks[1].authorization,before.subtasks[1].authorization);
  assert.deepEqual(before,input);
});

test('new historical private work keeps its actual author through reload and successor materialization',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,visibility:'private',points:0,scoring_mode:'subtasks'});
  await f.finish(r.data.id);
  const saved=await f.edit(r.data.id,{edit_scope:'future',subtasks:[{title:'New private work',points:2}]});
  assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(pending(f,r.data.id).subtasks[0].authorization.created_by,1);
  const p=await purePreview(f,r.data.id,{edit_scope:'future_only',include_edit_definition:true,future_patch:{}});
  assert.equal(p.data.edit_definition.actions[0].fields.title,'New private work');
  const successor=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(r.data.id);
  const child=f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL').get(successor.id);
  assert.equal(child.created_by,1);
  assert.equal((await f.call('GET','/tasks/'+child.id,undefined,2)).status,404);
});

for(const historical of [false,true])test(`compatible ${historical?'historical':'live'} promotion cannot delete hidden locked pending work`,async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task'});
  if(historical)await f.finish(r.data.id);
  const added=await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{actions:{add:[{client_key:'private',fields:{title:'PRIVATE PENDING',points:91,visibility:'private',locked:true,assigned_user_ids:[3]}}]}}});
  assert.equal(added.status,200);
  const before=f.snapshot(),body={edit_scope:'future',points:4};
  const preview=await purePreview(f,r.data.id,body,2);
  assert.ok([403,404,409].includes(preview.status));assert.ok(!JSON.stringify(preview).includes('PRIVATE PENDING'));
  const save=await f.edit(r.data.id,body,2);
  assert.ok([403,404,409].includes(save.status));assert.equal(f.snapshot(),before);
  assert.equal(pending(f,r.data.id).subtasks[0].task.points,91);
});

for(const fields of [
  {start_date:'2026-11-03',start_time:'08:00',due_date:'2026-11-02',due_time:'09:00',expiration_policy:'expire_incomplete'},
  {start_date:null,start_time:'08:00'},
  {due_date:null,expiration_policy:'expire_incomplete'}
])test('effective future action windows reject invalid patched and added terms atomically: '+JSON.stringify(fields),async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,scoring_mode:'subtasks',subtasks:[{title:'A',points:2}]});
  const key=pending(f,r.data.id).subtasks[0].action_key;
  for(const actions of [{update:[{action_key:key,fields}]},{add:[{client_key:'new',fields:{title:'New',...fields}}]}]){
    const before=f.snapshot(),body={edit_scope:'future_only',future_patch:{actions}};
    assert.equal((await purePreview(f,r.data.id,body)).status,400);
    assert.equal((await f.edit(r.data.id,body)).status,400);assert.equal(f.snapshot(),before);
  }
});

for(const state of ['done','expired','skipped','archived'])test(`historical ${state} compatible preview projects accepted future terms and immutable current history`,async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task'});
  if(state==='done')await f.finish(r.data.id);
  else if(state==='archived')f.d.prepare("UPDATE tasks SET archived_at='2026-11-01T12:00:00Z' WHERE id=?").run(r.data.id);
  else f.d.prepare('UPDATE tasks SET status=? WHERE id=?').run(state,r.data.id);
  const current=f.row(r.data.id),body={edit_scope:'future',points:7};
  const p=await purePreview(f,r.data.id,body);
  assert.equal(p.status,200,JSON.stringify(p));assert.equal(p.data.valid,true);assert.equal(p.data.scope,'future');assert.equal(p.data.current_preserved,true);
  assert.deepEqual(p.data.before,[{user_id:2,points:5}]);assert.deepEqual(p.data.after,[{user_id:2,points:7}]);
  assert.equal(p.data.after_units[0].ref.action_key,'root');assert.equal(p.data.after_units[0].points,7);
  assert.deepEqual(p.data.earned,state==='done'?[{user_id:2,points:5}]:[]);
  assert.equal((await f.edit(r.data.id,body)).status,200);assert.deepEqual(f.row(r.data.id),current);assert.equal(pending(f,r.data.id).task.points,7);
});

test('preview and save reject scoring plus real progress but retain unchanged scoring status compatibility',async t=>{
  const f=await scoringFixture(t),r=await f.create({assigned_to:[2],points:5,scoring_mode:'whole_task'});
  const before=f.snapshot(),body={points:7,status:'done'};
  const p=await purePreview(f,r.data.id,body);assert.equal(p.status,409);assert.equal(p.reason,'scoring_progress_separate');
  assert.equal((await f.edit(r.data.id,body)).reason,'scoring_progress_separate');assert.equal(f.snapshot(),before);
  const unchanged={points:'5',status:'done'};
  assert.equal((await purePreview(f,r.data.id,unchanged)).data.valid,true);
  assert.equal((await f.edit(r.data.id,unchanged)).status,200);
});

test('repeated current/future/invalid/stale/unauthorized previews preserve all tables/schema/sequences and total_changes',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task',subtasks:[{title:'A',points:2}]});
  for(const body of [{points:6},{edit_scope:'future_only',include_edit_definition:true,future_patch:{fields:{scoring_mode:'subtasks'}}}]){
    for(let i=0;i<2;i++)assert.equal((await purePreview(f,r.data.id,body)).status,200);
  }
  assert.equal((await purePreview(f,r.data.id,{points:true})).status,400);
  assert.equal((await purePreview(f,r.data.id,{expected_revision:f.row(r.data.id).revision+1,points:6})).status,409);
  f.grant('change_points','none');assert.equal((await purePreview(f,r.data.id,{points:6},2)).status,403);
});

test('current drafts have unique input identities and phase optional labels; frozen history stays labeled and nullable',async t=>{
  const f=await scoringFixture(t),r=await f.create({assigned_to:[2],scoring_mode:'subtasks',subtasks:[{title:'A',points:4},{title:'B',points:6}]});
  await f.finish(r.data.subtasks[0].id);
  const body={subtasks:[{id:r.data.subtasks[0].id,title:'A',points:4},{id:r.data.subtasks[1].id,title:'Renamed',points:6,is_optional:true},{client_key:'draft_x',title:'Draft',points:3}]};
  const p=await purePreview(f,r.data.id,body);assert.equal(p.status,200);
  assert.deepEqual(p.data.after_units.map(u=>[u.ref,u.title,u.is_optional]),[[{kind:'task',task_id:r.data.subtasks[1].id},'Renamed',true],[{kind:'draft',draft_key:'draft_x'},'Draft',false]]);
  assert.equal(p.data.settlements[0].title,'A');
  const sid=p.data.settlements[0].settlement_id;
  f.d.prepare('DELETE FROM tasks WHERE id=?').run(r.data.subtasks[0].id);
  const root=f.row(r.data.id);
  recordTaskScoringSettlement(f.d,{task:{...root,id:10000},root,mode:'subtasks',points:null,targets:[]},'synthetic-unknown-history',
    {outcome:'historical_claim',earnedOnce:true});
  const removed=await purePreview(f,r.data.id,{});
  assert.equal(removed.data.settlements[0].title,'Removed work');assert.equal(removed.data.settlements[0].points,4);assert.equal(removed.data.settlements[0].settlement_id,sid);
  const unknown=removed.data.settlements.find(s=>s.outcome==='historical_claim');assert.equal(unknown.points,null);assert.equal(unknown.title,'Removed work');
  assert.equal((await purePreview(f,r.data.id,{subtasks:[{title:'X',client_key:'same',points:1},{title:'Y',client_key:'same',points:1}]})).status,400);
});

test('future unit metadata and totals filter each phase after visibility changes',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,scoring_mode:'subtasks',subtasks:[{title:'Visible before',points:7}]});
  const key=pending(f,r.data.id).subtasks[0].action_key;
  const p=await purePreview(f,r.data.id,{edit_scope:'future_only',future_patch:{actions:{update:[{action_key:key,fields:{visibility:'private',title:'Hidden after'}}]}}},2);
  assert.equal(p.status,200);assert.deepEqual(p.data.before,[{user_id:2,points:7}]);assert.deepEqual(p.data.after,[]);
  assert.equal(p.data.before_units[0].title,'Visible before');assert.deepEqual(p.data.after_units,[]);assert.ok(!JSON.stringify(p).includes('Hidden after'));
});

test('historical compatible before totals and labels use actual pending terms rather than current exception',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task'});
  await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{fields:{points:11,title:'Pending future'}}});await f.finish(r.data.id);
  const p=await purePreview(f,r.data.id,{edit_scope:'future',points:7});
  assert.equal(p.status,200);assert.deepEqual(p.data.before,[{user_id:2,points:11}]);assert.deepEqual(p.data.after,[{user_id:2,points:7}]);
  assert.equal(p.data.before_units[0].title,'Pending future');assert.equal(p.data.earned[0].points,5);
  assert.equal((await f.edit(r.data.id,{edit_scope:'future',points:7})).status,200);assert.equal(f.row(r.data.id).points,5);assert.equal(pending(f,r.data.id).task.points,7);
});

test('compatible no-op preview preserves unrelated hidden pending terms like save',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task'});
  await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{actions:{add:[{client_key:'private',fields:{title:'PRIVATE PENDING',visibility:'private',points:91}}]}}});
  await f.finish(r.data.id);
  const before=f.snapshot(),p=await purePreview(f,r.data.id,{edit_scope:'future'},2);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.before,p.data.after);assert.ok(!JSON.stringify(p).includes('PRIVATE PENDING'));
  const saved=await f.edit(r.data.id,{edit_scope:'future'},2);
  assert.equal(saved.status,200);assert.equal(saved.unchanged,true);assert.equal(f.snapshot(),before);
});

test('compatible future preview retains rotation-group validation used by save',async t=>{
  const f=await scoringFixture(t);
  const first=await f.create({...recurring,assignment_mode:'round_robin',rotation_user_ids:[2,3],rotation_group:'cycle',rotation_slot:0});
  assert.equal(first.status,201);
  const r=await f.create({...recurring,assignment_mode:'round_robin',rotation_user_ids:[2,3],rotation_group:'cycle',rotation_slot:1});
  assert.equal(r.status,201);
  const before=f.snapshot(),body={edit_scope:'future',rotation_slot:0};
  assert.equal((await purePreview(f,r.data.id,body)).status,400);
  assert.equal((await f.edit(r.data.id,body)).status,400);assert.equal(f.snapshot(),before);
});

test('resolved rotating recipient change plus progress rejects identically in preview and save',async t=>{
  const f=await scoringFixture(t),r=await f.create({...recurring,assigned_to:[2],points:5,scoring_mode:'whole_task'});
  const before=f.snapshot(),body={assignment_mode:'round_robin',rotation_user_ids:[3,2],status:'done'};
  const p=await purePreview(f,r.data.id,body);
  assert.equal(p.status,409);assert.equal(p.reason,'scoring_progress_separate');
  assert.equal((await f.edit(r.data.id,body)).reason,'scoring_progress_separate');assert.equal(f.snapshot(),before);
});
