import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';

for (const mode of ['whole_task', 'subtasks']) test(`${mode}: People selections and a replaced child assignee survive Save/reopen and match completion awards`, async t => {
  const f = await scoringFixture(t);
  const created = await f.create({title:'Shared homework', assigned_to:[2,3], scoring_mode:mode, points:5,
    subtasks:[{title:'Read',points:2,assigned_user_ids:[2]},{title:'Write',points:3,assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id;
  const edit={assigned_to:[2,3],scoring_mode:mode,points:5,subtasks:created.data.subtasks.map((row,index)=>({id:row.id,title:row.title,points:index?3:2,skill_ids:[],is_optional:0,assigned_user_ids:index?[]:[3]}))};
  const unchanged=f.snapshot(),changes=f.changes(),preview=await f.preview(root,edit);
  assert.equal(preview.status,200,JSON.stringify(preview));
  assert.equal(f.snapshot(),unchanged);assert.equal(f.changes(),changes);
  const expected=mode==='whole_task'?[{user_id:2,points:5},{user_id:3,points:5}]:[{user_id:2,points:3},{user_id:3,points:5}];
  assert.deepEqual(preview.data.after,expected);
  assert.equal((await f.edit(root,edit)).status,200);
  const reopened=await f.call('GET','/tasks/'+root);
  assert.equal(reopened.status,200);
  assert.deepEqual(reopened.data.assigned_users.map(user=>user.id).sort(),[2,3]);
  assert.deepEqual(reopened.data.subtasks.map(row=>row.assigned_users.map(user=>user.id)),[[3],[]]);
  await f.finish(root);await f.finish(root);
  const awards=f.d.prepare("SELECT user_id,SUM(delta) points FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) GROUP BY user_id ORDER BY user_id").all(root,root);
  assert.deepEqual(awards,expected);
});

test('concrete subtask assignment rejects invalid household identities atomically', async t => {
  const f=await scoringFixture(t);
  for(const assigned_user_ids of [[999],[2,2],['2']]) {
    const before=f.snapshot();
    const result=await f.create({assigned_to:[2],subtasks:[{title:'Protected assignment',assigned_user_ids}]});
    assert.equal(result.status,400,JSON.stringify(result));assert.equal(f.snapshot(),before);
  }
});

test('assignment capability denial blocks subtask preview and Save', async t => {
  const f=await scoringFixture(t),created=await f.create({assigned_to:[2],scoring_mode:'subtasks',subtasks:[{title:'Read',points:2,assigned_user_ids:[2]},{title:'Remain',points:1}]});
  assert.equal(created.status,201,JSON.stringify(created));
  f.grant('change_assignment','none');
  const body={subtasks:created.data.subtasks.map(row=>({id:row.id,title:row.title,points:row.points,skill_ids:[],assigned_user_ids:[3]}))},before=f.snapshot();
  assert.equal((await f.preview(created.data.id,body,2)).status,403);
  assert.equal((await f.edit(created.data.id,body,2)).status,403);
  assert.equal(f.snapshot(),before);
});

test('assignment capability denial blocks creating assigned children under an unassigned root', async t => {
  const f=await scoringFixture(t);f.grant('change_assignment','none');
  const before=f.snapshot(),result=await f.call('POST','/tasks',{title:'Unassigned parent',assigned_to:[],subtasks:[{title:'Assigned child',assigned_user_ids:[3]}]},2);
  assert.equal(result.status,403,JSON.stringify(result));assert.equal(f.snapshot(),before);
});

test('changing a completed child responsibility cannot rewrite its settled recipient', async t => {
  const f=await scoringFixture(t),created=await f.create({assigned_to:[2],scoring_mode:'subtasks',subtasks:[{title:'Read',points:2,assigned_user_ids:[2]},{title:'Remain',points:1}]});
  assert.equal(created.status,201,JSON.stringify(created));
  await f.finish(created.data.subtasks[0].id);
  const body={subtasks:created.data.subtasks.map((row,index)=>({id:row.id,title:row.title,points:row.points,skill_ids:[],...(index?{}:{assigned_user_ids:[3]})}))},before=f.snapshot();
  const result=await f.edit(created.data.id,body);
  assert.equal(result.status,409,JSON.stringify(result));assert.equal(f.snapshot(),before);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn'").all(),[{user_id:2,delta:2}]);
});
