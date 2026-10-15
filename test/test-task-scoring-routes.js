import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {createDevice} from '../server/services/devices.js';
import {deviceTaskDetail,deviceTaskList} from '../server/services/device-tasks.js';

test('configured worth survives real device scheduling projection without including private child amounts',async t=>{
 const f=await scoringFixture(t),created=await f.create({scoring_mode:'subtasks',assigned_to:[2],points:999,subtasks:[{title:'Now',points:3},{title:'Later',points:5},{title:'Optional later',points:7,is_optional:true},{title:'Private',points:900}]});
 assert.equal(created.status,201);const root=created.data.id,[now,later,optional,hidden]=created.data.subtasks;
 f.d.prepare("UPDATE tasks SET start_date='2026-11-02' WHERE id IN (?,?)").run(later.id,optional.id);
 f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden.id);
 const principal={kind:'device',...createDevice(f.d,{name:'Synthetic configured worth display'},1)},snapshot=f.snapshot(),changes=f.changes();
 const list=deviceTaskList(f.d,principal).find(row=>row.id===root),detail=deviceTaskDetail(f.d,principal,root);
 assert.deepEqual(list.subtasks.map(row=>row.id),[now.id]);
 assert.equal(list.scoring.configured_total,15);assert.equal(detail.scoring.configured_total,15);
 const personal=await f.call('GET','/tasks/'+root,undefined,2);assert.equal(personal.status,200);assert.equal(personal.data.scoring.configured_total,15);
 const personalList=await f.call('GET','/tasks?status=open',undefined,2),listed=personalList.data.find(row=>row.id===root);
 assert.equal(listed.scoring.configured_total,15);assert.deepEqual(listed.subtasks.map(row=>row.id),[now.id]);
 assert.equal(JSON.stringify({list,detail,personal,listed}).includes('900'),false);
 assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
});

test('creation selects exclusive public policy and rejects ambiguous omitted policy',async t=>{
 const f=await scoringFixture(t);for(const mode of ['whole_task','subtasks']){const r=await f.create({scoring_mode:mode,points:5,assigned_to:[2],subtasks:[{title:'Step',points:7}]});assert.equal(r.status,201);assert.equal(r.data.scoring_mode,mode);await f.finish(r.data.id);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND task_id IN (?,?)").all(r.data.id,r.data.subtasks[0].id),[{user_id:2,delta:mode==='whole_task'?5:7}]);}
 const before=f.snapshot();assert.equal((await f.create({points:5,subtasks:[{title:'Ambiguous',points:5}]})).status,400);assert.equal(f.snapshot(),before);
 for(const [body,mode] of [[{},'whole_task'],[{points:5},'whole_task'],[{subtasks:[{title:'Child',points:5}]},'subtasks']])assert.equal((await f.create(body)).data.scoring_mode,mode);
});
test('raw points and modes reject without partial task writes; numeric strings persist',async t=>{
 const f=await scoringFixture(t),r=await f.create({points:'10000'});assert.equal(r.status,201);assert.equal(r.data.points,10000);
 for(const value of [true,{},1.5,-1,10001,null,'']){const before=f.snapshot();assert.equal((await f.edit(r.data.id,{title:'Must remain',points:value})).status,400,JSON.stringify(value));assert.equal(f.snapshot(),before);}
 for(const scoring_mode of ['legacy','bogus',null,{}]){const before=f.snapshot();assert.equal((await f.create({scoring_mode})).status,400);assert.equal(f.snapshot(),before);}
});
test('mode requires root edit/points authority while direct leaf point editing remains supported',async t=>{
 const f=await scoringFixture(t),r=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Step',points:5}]});
 f.grant('change_points','none');assert.equal((await f.edit(r.data.id,{scoring_mode:'whole_task'},2)).status,403);
 f.grant('change_points','allow');const child=r.data.subtasks[0].id;assert.equal((await f.edit(child,{points:6})).status,200);assert.equal(f.row(child).points,6);assert.equal((await f.edit(child,{scoring_mode:'whole_task'})).status,400);assert.equal(f.row(r.data.id).scoring_mode,'subtasks');
 f.grant('edit_own','none');assert.equal((await f.edit(r.data.id,{scoring_mode:'whole_task'},2)).status,403);
});
test('partial earnings lock mode and amount, zero settles, reopened assignments preserve historical recipients',async t=>{
 const f=await scoringFixture(t),r=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Earn',points:4},{title:'Zero',points:0},{title:'Remain',points:8}]});const [a,z]=r.data.subtasks;
 await f.finish(a.id);await f.finish(z.id);const before=f.snapshot();assert.equal((await f.edit(r.data.id,{scoring_mode:'whole_task'})).status,409);assert.equal((await f.edit(a.id,{points:9})).status,409);assert.equal((await f.edit(z.id,{points:9})).status,409);assert.equal(f.snapshot(),before);
 await f.call('PATCH',`/tasks/${a.id}/status`,{status:'open'});assert.equal((await f.edit(a.id,{assigned_to:[3]})).status,200);await f.finish(a.id);assert.deepEqual(f.d.prepare('SELECT user_id,type,delta FROM reward_ledger ORDER BY id').all(),[{user_id:2,type:'earn',delta:4},{user_id:2,type:'adjust',delta:-4},{user_id:2,type:'adjust',delta:4}]);assert.equal(f.d.prepare('SELECT SUM(delta) balance FROM reward_ledger').get().balance,4);
 const loaded=(await f.call('GET','/tasks/'+r.data.id)).data;assert.equal(loaded.scoring.mode_locked,true);assert.equal(loaded.subtasks.find(s=>s.id===a.id).scoring.personal_total,0);assert.deepEqual(loaded.subtasks.find(s=>s.id===z.id).scoring.potential,[]);
});
test('preview uses canonical recipient rules and no writes; stale save and incidental completion reject atomically',async t=>{
 const f=await scoringFixture(t),r=await f.create({scoring_mode:'subtasks',assigned_to:[2,3],subtasks:[{title:'Done',points:4},{title:'Remain',points:6}]});await f.finish(r.data.subtasks[0].id);const before=f.snapshot(),revision=f.row(r.data.id).revision;
 const p=await f.preview(r.data.id,{subtasks:r.data.subtasks.map(s=>({id:s.id,title:s.title,points:s.points}))});assert.equal(p.status,200);assert.equal(p.data.valid,true);assert.deepEqual(p.data.earned,[{user_id:2,points:4},{user_id:3,points:4}]);assert.deepEqual(p.data.after,[{user_id:2,points:6},{user_id:3,points:6}]);assert.equal(f.snapshot(),before);
 await f.finish(r.data.subtasks[1].id);const settled=f.snapshot();assert.equal((await f.edit(r.data.id,{expected_revision:revision,points:1})).status,409);assert.equal(f.snapshot(),settled);
 const fresh=await f.create({points:2,assigned_to:[2]});const b=f.snapshot();assert.equal((await f.edit(fresh.data.id,{points:3,status:'done'})).status,409);assert.equal(f.snapshot(),b);
});
test('ambiguous unearned positive legacy gates progress even with no eligible recipients',async t=>{
 const f=await scoringFixture(t),r=await f.create({points:2,scoring_mode:'whole_task',subtasks:[{title:'Legacy child',points:3}]});f.d.prepare("UPDATE tasks SET scoring_mode='legacy',scoring_review_required=1 WHERE id=?").run(r.data.id);const before=f.snapshot();const done=await f.finish(r.data.subtasks[0].id);assert.equal(done.status,409);assert.equal(done.reason,'scoring_review_required');assert.equal(f.snapshot(),before);
 assert.equal((await f.edit(r.data.id,{scoring_mode:'subtasks'})).status,200);assert.equal((await f.finish(r.data.subtasks[0].id)).status,200);
});
test('hydration hides private earnings while retaining global lock and does not fail a visible leaf with hidden owner',async t=>{
 const f=await scoringFixture(t),r=await f.create({scoring_mode:'subtasks',subtasks:[{title:'Private earn',points:6},{title:'Visible',points:2}]});const hidden=r.data.subtasks[0].id;f.d.prepare("UPDATE tasks SET visibility='private',assigned_to=3 WHERE id=?").run(hidden);f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,3)').run(hidden);await f.finish(hidden);
 const visible=(await f.call('GET','/tasks/'+r.data.id,undefined,2)).data;assert.equal(visible.scoring.mode_locked,true);assert.deepEqual(visible.scoring.earned,[]);assert.ok(!JSON.stringify(visible.scoring).includes(String(hidden)+'\"'));assert.ok(!visible.scoring.settled_task_ids.includes(hidden));
 f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(r.data.id);const leaf=await f.call('GET','/tasks/'+r.data.subtasks[1].id,undefined,2);assert.equal(leaf.status,200);assert.equal(leaf.data.scoring,null);
});
test('shared device and Wall recompute public-only scoring, never host personal earnings or deleted private history',async t=>{
 const f=await scoringFixture(t),r=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Private',points:91},{title:'Public',points:4}]});const hidden=r.data.subtasks[0].id;f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden);await f.finish(hidden);f.d.prepare('DELETE FROM tasks WHERE id=?').run(hidden);
 const {createDevice}=await import('../server/services/devices.js'),{deviceTaskDetail}=await import('../server/services/device-tasks.js');const principal={kind:'device',...createDevice(f.d,{name:'Synthetic shared display'},1)},before=f.snapshot(),display=deviceTaskDetail(f.d,principal,r.data.id);assert.equal(display.scoring.mode_locked,true);assert.equal(display.scoring.personal_total,null);assert.deepEqual(display.scoring.earned,[]);assert.deepEqual(display.scoring.potential,[{user_id:2,points:4}]);assert.equal(display.points,0);
 const wall=await f.call('GET','/wall/tasks/'+r.data.id);assert.equal(wall.status,200);assert.equal(wall.data.scoring.personal_total,null);assert.deepEqual(wall.data.scoring.earned,[]);assert.ok(!wall.data.scoring.settled_task_ids.includes(hidden));assert.equal(f.snapshot(),before);
});
test('default point rebase excludes reopened settled terms and validates raw values',async t=>{
 const f=await scoringFixture(t),settled=await f.create({points:4,assigned_to:[2]}),fresh=await f.create({points:4});
 await f.finish(settled.data.id);await f.call('PATCH','/tasks/'+settled.data.id+'/status',{status:'open'});
 const before=f.snapshot();assert.equal((await f.call('POST','/tasks/points/rebase',{from:true,to:6})).status,400);assert.equal(f.snapshot(),before);
 assert.equal((await f.call('GET','/tasks/points/affected?points=4')).data.count,1);
 assert.equal((await f.call('POST','/tasks/points/rebase',{from:4,to:6})).data.updated,1);assert.equal(f.row(settled.data.id).points,4);assert.equal(f.row(fresh.data.id).points,6);
});
test('preview work units and frozen settlements retain central amounts with authorized labels',async t=>{
 const f=await scoringFixture(t),r=await f.create({scoring_mode:'subtasks',assigned_to:[2,3],subtasks:[{title:'Finished',points:4},{title:'Optional remaining',points:6,is_optional:true}]});
 await f.finish(r.data.subtasks[0].id);const before=f.snapshot(),p=await f.preview(r.data.id,{subtasks:r.data.subtasks.map(s=>({id:s.id,title:s.title,points:s.points,is_optional:s.is_optional}))});
 assert.equal(p.status,200);assert.ok(Array.isArray(p.data.before_units));assert.equal(p.data.before_units.length,1);
 assert.deepEqual(p.data.before_units[0],{ref:{kind:'task',task_id:r.data.subtasks[1].id},title:'Optional remaining',is_optional:true,points:6,recipients:[{user_id:2,points:6},{user_id:3,points:6}],outcome:'earned'});
 assert.equal(p.data.settlements.find(s=>s.task_id===r.data.subtasks[0].id).points,4);assert.ok(Number.isSafeInteger(p.data.settlements[0].settlement_id));assert.equal(f.snapshot(),before);
});
test('historical scoring honors view-own capability and leaf summaries stay narrow',async t=>{
 const f=await scoringFixture(t),r=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'Other member history',points:91},{title:'Own remaining',points:4}]});
 const removed=r.data.subtasks[0].id;f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,3)').run(removed);await f.finish(removed);f.d.prepare('DELETE FROM tasks WHERE id=?').run(removed);
 f.grant('view_household','none');f.grant('view_own','allow');const loaded=(await f.call('GET','/tasks/'+r.data.id,undefined,2)).data;
 assert.equal(loaded.scoring.mode_locked,true);assert.deepEqual(loaded.scoring.earned,[]);assert.ok(!loaded.scoring.settled_task_ids.includes(removed));
 const leaf=(await f.call('GET','/tasks/'+r.data.subtasks[1].id,undefined,2)).data;assert.deepEqual(leaf.scoring.earned,[]);assert.equal(leaf.scoring.settled_task_ids.length,0);
});

for(const scope of ['occurrence','future'])for(const mode of ['whole_task','subtasks'])for(const policy of mode==='whole_task'?['fixed','subject_skill']:['fixed'])test(`${scope} ${mode} ${policy}: a color-only full editor retains the child's two-point award`,async t=>{
  const subject=policy==='subject_skill',f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Assigned bedtime','Assigned bedtime',?,?,?,?, 'ignore',1)").run(policy,policy,subject?null:2,subject?1:0).lastInsertRowid);
  const created=await f.create({title:'Synthetic bedtime',activity_template_id:template,...(subject?{activity_subject_user_id:2}:{}),points:mode==='whole_task'?2:0,scoring_mode:mode,
    due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Bedtime step',points:mode==='subtasks'?2:0}]});
  assert.equal(created.status,201,JSON.stringify(created));const id=created.data.id,task=created.data;
  const terms=()=>({mode:f.row(id).scoring_mode,points:f.row(id).points,assigned:f.row(id).assigned_to,
    joins:f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id),
    binding:f.d.prepare('SELECT activity_template_id,subject_user_id,assignment_override_user_id,definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id),
    children:f.d.prepare('SELECT id,points FROM tasks WHERE parent_task_id=? ORDER BY id').all(id)});
  const original=terms(),body={...Object.fromEntries(['title','description','category','priority','status','start_date','start_time','due_date','due_time','is_recurring','recurrence_rule','recurrence_from_completion','points','scoring_mode','visibility','countdown','locked','expiration_policy'].filter(key=>!subject||key!=='scoring_mode').map(key=>[key,task[key]])),
    edit_scope:scope,activity_template_id:template,activity_subject_user_id:subject?2:null,assignment_mode:'fixed',assigned_to:[],rotation_user_ids:[],rotation_bindings:[],skill_ids:[],tags:task.tags,
    subtasks:task.subtasks.map(child=>({id:child.id,title:child.title,points:child.points,skill_ids:child.skill_ids,is_optional:child.is_optional})),
    card_color_choice:{version:1,mode:'fixed',slot:'slot-07-v1'}};
  const snapshot=f.snapshot(),changes=f.changes(),preview=await f.preview(id,body);
  assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(preview.data.valid,true);assert.deepEqual(preview.data.before,[{user_id:2,points:2}]);assert.deepEqual(preview.data.after,[{user_id:2,points:2}]);assert.deepEqual(preview.data.warnings,[]);
  assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes,'preview is read-only');
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));assert.deepEqual(terms(),original,'color edit preserves assignment, mode, amounts and Activity snapshot');assert.equal(f.row(id).card_color,'slot-07-v1');
  // Existing occurrences and their successors use their frozen Activity policy.
  f.d.prepare('UPDATE activity_templates SET fixed_user_id=3,points=99 WHERE id=?').run(template);
  const awards=root=>f.d.prepare("SELECT user_id,SUM(delta) points FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) GROUP BY user_id ORDER BY user_id").all(root,root);
  assert.equal((await f.finish(id)).status,200);assert.deepEqual(awards(id),[{user_id:2,points:2}]);
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.ok(next);assert.equal(next.assigned_to,2);assert.equal(next.scoring_mode,mode);assert.equal(next.points,original.points);
  assert.equal((await f.finish(next.id)).status,200);assert.deepEqual(awards(next.id),[{user_id:2,points:2}]);
  await f.finish(id);await f.finish(next.id);assert.deepEqual(awards(id),[{user_id:2,points:2}]);assert.deepEqual(awards(next.id),[{user_id:2,points:2}]);
});

test('an intentional manual assignment removal still previews and saves no recipient',async t=>{
  const f=await scoringFixture(t),created=await f.create({assigned_to:[2],points:2,scoring_mode:'whole_task'}),id=created.data.id;
  const p=await f.preview(id,{assigned_to:[],card_color_choice:{version:1,mode:'fixed',slot:'slot-07-v1'}});assert.equal(p.status,200);assert.deepEqual(p.data.before,[{user_id:2,points:2}]);assert.deepEqual(p.data.after,[]);
  assert.equal((await f.edit(id,{assigned_to:[],card_color_choice:{version:1,mode:'fixed',slot:'slot-07-v1'}})).status,200);assert.equal(f.row(id).assigned_to,null);await f.finish(id);assert.deepEqual(f.d.prepare('SELECT * FROM reward_ledger WHERE task_id=?').all(id),[]);
});
