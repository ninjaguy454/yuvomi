import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';
const { seriesDefinitionForGeneration, taskSeriesState } = await import('../server/services/task-series.js');

async function fixture(t, primary = 2, { qualification = false } = {}) {
  const f = await scoringFixture(t);
  f.d.exec("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'Fourth','Fourth','x','member','other'); INSERT INTO task_categories(key,name,max_assignees) VALUES('shared-edit','Shared edit',3)");
  const template = Number(f.d.prepare(`INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,allow_assignment_override,presence_policy,created_by,points,scoring_mode,recurrence_rule,due_date_offset_days)
    VALUES('Shared edit','Shared work','shared-edit','fixed','fixed',2,1,'ignore',1,0,'subtasks','FREQ=DAILY',0)`).run().lastInsertRowid);
  f.d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template,points) VALUES(?,'Shared step',2)").run(template);
  if (qualification) {
    const skill = Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Shared qualification',0,'normal',1)").run().lastInsertRowid);
    f.d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(template, skill);
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(4,?,'excluded','manual',1)").run(skill);
  }
  const launch = await f.call('POST', '/tasks/template-launch/create', { request_key: 'shared-edit', activity_template_id: template,
    recipient_user_ids: [2, 3], primary_user_id: primary, mode: 'shared', start_date: '2026-11-01', inputs: {} });
  assert.equal(launch.status, 201, JSON.stringify(launch));
  const root = launch.data.tasks[0];
  const bindingSnapshot = id => JSON.parse(f.d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id).definition_snapshot_json);
  const future = () => { const state = taskSeriesState(f.d, root.id); return seriesDefinitionForGeneration(f.d, state.series_id, state.occurrence.generation + 1).data; };
  const next = async () => {
    await f.finish(root.subtasks[0].id); await f.finish(root.id);
    const row = f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL ORDER BY id LIMIT 1').get(root.id);
    assert.ok(row, 'canonical recurrence generates its successor');
    return (await f.call('GET', '/tasks/' + row.id)).data;
  };
  return { ...f, root, bindingSnapshot, future, next };
}

test('ordinary shared-template title echo preserves the chosen primary and frozen roster', async t => {
  const f = await fixture(t, 3), response = await f.edit(f.root.id, { assigned_to: [2, 3], title: 'Updated title', edit_scope: 'occurrence' });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.assigned_to, 3);
  assert.deepEqual(response.data.direct_assignee_ids, [2, 3]);
  assert.deepEqual(f.bindingSnapshot(f.root.id).fixed_assignee_ids, [3, 2]);
});

for (const scope of ['occurrence', 'future', 'future_only']) test(`shared-template ${scope} removal changes the intended roster and recurrence scope`, async t => {
  const f = await fixture(t), response = await f.edit(f.root.id, scope === 'future_only'
    ? { edit_scope: scope, future_patch: { fields: { assigned_to: [2] } } }
    : { edit_scope: scope, assigned_to: [2] });
  assert.equal(response.status, 200, JSON.stringify(response));
  const read = (await f.call('GET', '/tasks/' + f.root.id)).data;
  assert.deepEqual(read.direct_assignee_ids, scope === 'future_only' ? [2, 3] : [2]);
  assert.deepEqual(f.bindingSnapshot(f.root.id).fixed_assignee_ids, scope === 'future_only' ? [2, 3] : [2]);
  assert.deepEqual(f.future().binding.snapshot.fixed_assignee_ids, scope === 'occurrence' ? [2, 3] : [2]);
  const next = await f.next();
  assert.deepEqual(next.direct_assignee_ids, scope === 'occurrence' ? [2, 3] : [2]);
});

test('shared-template roster additions retain the primary and removing it chooses the first selected member', async t => {
  const f = await fixture(t, 3);
  let response = await f.edit(f.root.id, { assigned_to: [2, 3, 4], edit_scope: 'future' });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.assigned_to, 3);
  assert.deepEqual(response.data.direct_assignee_ids, [2, 3, 4]);
  assert.deepEqual(f.bindingSnapshot(f.root.id).fixed_assignee_ids, [3, 2, 4]);
  response = await f.edit(f.root.id, { assigned_to: [4, 2], edit_scope: 'occurrence' });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.assigned_to, 4);
  assert.deepEqual(f.bindingSnapshot(f.root.id).fixed_assignee_ids, [4, 2]);
});

test('future-only shared additions preserve the frozen primary rather than the editor household order', async t => {
  const f = await fixture(t, 3), response = await f.edit(f.root.id, { edit_scope: 'future_only', future_patch: { fields: { assigned_to: [2, 3, 4] } } });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.deepEqual(f.future().binding.snapshot.fixed_assignee_ids, [3, 2, 4]);
  const next = await f.next(); assert.equal(next.assigned_to, 3); assert.deepEqual(next.direct_assignee_ids, [2, 3, 4]);
});

test('generic scalar assignment syntax can reduce an existing shared occurrence to one recipient', async t => {
  const f = await fixture(t), response = await f.edit(f.root.id, { assigned_to: 2, edit_scope: 'occurrence' });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.deepEqual(response.data.direct_assignee_ids, [2]);
});

for (const scope of ['occurrence', 'future_only']) test(`shared-template ${scope} roster changes enforce current count and assignment permissions atomically`, async t => {
  const f = await fixture(t), body = scope === 'future_only'
    ? { edit_scope: scope, future_patch: { fields: { assigned_to: [2, 3, 4] } } } : { edit_scope: scope, assigned_to: [2, 3, 4] };
  f.d.exec("UPDATE task_categories SET max_assignees=2 WHERE key='shared-edit'");
  let before = f.snapshot(), response = await f.edit(f.root.id, body);
  assert.equal(response.status, 400, JSON.stringify(response)); assert.equal(f.snapshot(), before);
  f.d.exec("UPDATE task_categories SET max_assignees=3 WHERE key='shared-edit'");
  f.grant('reassign', 'none'); before = f.snapshot(); response = await f.edit(f.root.id, body, 2);
  assert.equal(response.status, 403, JSON.stringify(response)); assert.equal(f.snapshot(), before);
});

for (const scope of ['occurrence', 'future', 'future_only']) test(`shared-template ${scope} addition rechecks whole-Activity qualifications`, async t => {
  const f = await fixture(t, 2, { qualification: true });
  const before = f.snapshot(), response = await f.edit(f.root.id, scope === 'future_only'
    ? { edit_scope: scope, future_patch: { fields: { assigned_to: [2, 3, 4] } } }
    : { assigned_to: [2, 3, 4], edit_scope: scope });
  assert.equal(response.status, 400, JSON.stringify(response)); assert.equal(f.snapshot(), before);
});

test('a legacy scalar binding is never converted to a shared roster by generic editing', async t => {
  const f = await fixture(t), snapshot = f.bindingSnapshot(f.root.id); delete snapshot.fixed_assignee_ids;
  f.d.prepare('UPDATE task_activity_bindings SET definition_snapshot_json=? WHERE task_id=?').run(JSON.stringify(snapshot), f.root.id);
  const legacy = f.snapshot(), rejected = await f.edit(f.root.id, { assigned_to: [2, 4], edit_scope: 'occurrence' });
  assert.equal(rejected.status, 400, JSON.stringify(rejected)); assert.equal(f.snapshot(), legacy);
});

test('shared roster scoring preview uses the proposed recipients without mutating the saved roster', async t => {
  const f = await fixture(t), before = f.snapshot(), preview = await f.preview(f.root.id, { assigned_to: [2], edit_scope: 'occurrence' });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.deepEqual(preview.data.after, [{ user_id: 2, points: 2 }]);
  assert.equal(f.snapshot(), before);
});

async function assignChildHelper(f) {
  const response = await f.edit(f.root.subtasks[0].id, { assigned_to: [4] });
  assert.equal(response.status, 200, JSON.stringify(response));
  const root = (await f.call('GET', '/tasks/' + f.root.id)).data;
  assert.deepEqual(root.direct_assignee_ids, [2, 3]);
  assert.deepEqual(root.assigned_users.map(user => user.id).sort(), [2, 3, 4]);
}

for (const scope of ['occurrence', 'future']) for (const limit of [3, 2]) test(`shared ${scope} visibility echo at current cap ${limit} never promotes a child helper`, async t => {
  const f = await fixture(t, 3); await assignChildHelper(f);
  f.d.prepare("UPDATE task_categories SET max_assignees=? WHERE key='shared-edit'").run(limit);
  const response = await f.edit(f.root.id, { assigned_to: [2, 3, 4], title: 'Echo title', edit_scope: scope });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.equal(response.data.assigned_to, 3);
  assert.equal(response.data.title, 'Echo title');
  assert.deepEqual(response.data.direct_assignee_ids, [2, 3]);
  assert.deepEqual(f.bindingSnapshot(f.root.id).fixed_assignee_ids, [3, 2]);
  assert.deepEqual(f.future().binding.snapshot.fixed_assignee_ids, [3, 2]);
  assert.deepEqual([...f.future().assignee_policy.direct_assignee_ids].sort(), [2, 3]);
});

for (const scope of ['occurrence', 'future', 'future_only']) test(`shared ${scope} explicit helper promotion enforces current limits and reassign authority`, async t => {
  const f = await fixture(t, 3); await assignChildHelper(f);
  // Full editors need the marker; sparse future fields already express direct
  // authoring intent and intentionally do not accept an extra direct marker.
  const body = scope === 'future_only' ? { edit_scope: scope, future_patch: { fields: { assigned_to: [2, 3, 4] } } }
    : { edit_scope: scope, assigned_to: [2, 3, 4], direct_assignee_ids: [2, 3, 4] };
  f.d.exec("UPDATE task_categories SET max_assignees=2 WHERE key='shared-edit'");
  let before = f.snapshot(), response = await f.edit(f.root.id, body);
  assert.equal(response.status, 400, JSON.stringify(response)); assert.equal(f.snapshot(), before);
  f.d.exec("UPDATE task_categories SET max_assignees=3 WHERE key='shared-edit'");
  f.grant('reassign', 'none'); before = f.snapshot(); response = await f.edit(f.root.id, body, 2);
  assert.equal(response.status, 403, JSON.stringify(response)); assert.equal(f.snapshot(), before);
  response = await f.edit(f.root.id, body);
  assert.equal(response.status, 200, JSON.stringify(response));
  if (scope !== 'future_only') assert.deepEqual(response.data.direct_assignee_ids, [2, 3, 4]);
  else assert.deepEqual(response.data.direct_assignee_ids, [2, 3]);
  assert.deepEqual((scope === 'occurrence' ? f.bindingSnapshot(f.root.id) : f.future().binding.snapshot).fixed_assignee_ids, [3, 2, 4]);
});

test('plain shared assignment subsets still remove and true additions beyond the visibility union still add', async t => {
  const f = await fixture(t, 3); await assignChildHelper(f);
  let response = await f.edit(f.root.id, { edit_scope: 'occurrence', assigned_to: [1, 2, 3] });
  assert.equal(response.status, 200, JSON.stringify(response));
  assert.deepEqual(response.data.direct_assignee_ids, [1, 2, 3]); assert.equal(response.data.assigned_to, 3);
  response = await f.edit(f.root.id, { edit_scope: 'occurrence', assigned_to: [3] });
  assert.equal(response.status, 200, JSON.stringify(response)); assert.deepEqual(response.data.direct_assignee_ids, [3]);
  assert.deepEqual(response.data.assigned_users.map(user => user.id).sort(), [3, 4]);
});

test('explicit helper promotion still requires whole-Activity qualification', async t => {
  const f = await fixture(t, 3, { qualification: true }); await assignChildHelper(f);
  const before = f.snapshot(), response = await f.edit(f.root.id, { edit_scope: 'occurrence',
    assigned_to: [2, 3, 4], direct_assignee_ids: [2, 3, 4] });
  assert.equal(response.status, 400, JSON.stringify(response)); assert.equal(f.snapshot(), before);
});
