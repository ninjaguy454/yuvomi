import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

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
 await f.call('PATCH',`/tasks/${a.id}/status`,{status:'open'});assert.equal((await f.edit(a.id,{assigned_to:[3]})).status,200);await f.finish(a.id);assert.deepEqual(f.d.prepare('SELECT user_id,delta FROM reward_ledger').all(),[{user_id:2,delta:4}]);
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
