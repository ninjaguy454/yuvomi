import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET = 'laundry-eligibility-isolated-test';
const { get } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
const { householdMembers, effectiveActivityProficiency, effectiveSkillProficiency,
  resolveActivityAssignment } = await import('../server/services/activity-eligibility.js');
const { getActivityTemplate } = await import('../server/services/activity-workflows.js');
const { evaluatePresence } = await import('../server/services/presence.js');
const d = get();
const addMember = (name, role) => Number(d.prepare(`INSERT INTO users
  (username,display_name,password_hash,role,family_role) VALUES (?,?,'test',?,'parent')`)
  .run(name, name, role).lastInsertRowid);
const subjectId = addMember('Laundry worker', 'admin');
const learnerId = addMember('Laundry learner', 'member');
const homeId = Number(d.prepare("INSERT INTO places(name,type,active,created_by) VALUES ('Laundry Home','home',1,?)")
  .run(subjectId).lastInsertRowid);
const skillIds = ['Load washer', 'Transfer laundry', 'Fold clothes', 'Put clothes away', 'Make bed']
  .map(name => Number(d.prepare(`INSERT INTO skills(name,minimum_age,age_promotion,active,created_by)
    VALUES (?,0,'supervised',1,?)`).run(name, subjectId).lastInsertRowid));
for (const skillId of skillIds) {
  for (const [userId, value] of [[subjectId, 'normal'], [learnerId, 'supervised']]) {
    d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source)
      VALUES (?,?,?,'manual')`).run(userId, skillId, value);
  }
}
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = subjectId;
  req.authRole = 'admin';
  req.session = { userId: subjectId, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/automation', automationRouter);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  d.close();
});
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}
async function laundry(overrides = {}) {
  const response = await call('POST', '/automation/admin/activity-templates', {
    name: 'Laundry', title_template: "{subject}'s Laundry", assignment_strategy: 'subject_skill',
    subject_required: true, skill_ids: [], location_mode: 'fixed', place_id: homeId,
    presence_policy: 'must_be_at_location',
    checklist: skillIds.map((skillId, index) => ({ title_template: `Laundry step ${index + 1}`, skill_ids: [skillId] })),
    ...overrides,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}
const taskBody = (activity, extra = {}) => ({ title: 'Laundry occurrence', activity_template_id: activity.id,
  activity_subject_user_id: subjectId, location: null, ...extra });
const presenceMessage = 'Qualified household members were found, but none meets this activity’s location requirement.';

test('Laundry with no parent skills passes skill checks but missing planned presence prevents assignment', async () => {
  const activity = await laundry();
  const member = householdMembers(d).find(row => row.id === subjectId);
  assert.deepEqual(activity.skills, []);
  assert.equal(activity.checklist.length, 5);
  assert.equal(effectiveActivityProficiency(d, activity.id, member).proficiency, 'normal');
  for (const item of activity.checklist) {
    const skill = item.skills[0];
    assert.equal(effectiveSkillProficiency(d, skill, member).proficiency, 'normal');
    assert.equal(d.prepare('SELECT proficiency FROM user_skill_proficiency WHERE user_id=? AND skill_id=?')
      .get(subjectId, skill.id).proficiency, 'normal');
  }
  const presence = evaluatePresence(d, { userId: subjectId, targetPlaceId: homeId,
    startAt: '2026-09-10T00:00:00', endAt: '2026-09-10T23:59:00', policy: 'must_be_at_location' });
  assert.equal(presence.eligible, false);
  assert.deepEqual(presence.signals, []);
  assert.throws(() => resolveActivityAssignment(d, activity, { subjectUserId: subjectId, dateKey: '2026-09-10' }),
    { message: presenceMessage });
});

test('Task navigation No Location does not silently disable the Activity Template presence requirement', async () => {
  const activity = await laundry();
  const before = d.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const response = await call('POST', '/tasks', taskBody(activity));
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.error, presenceMessage);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, before);
  const stored = getActivityTemplate(d, activity.id);
  assert.equal(stored.presence_policy, 'must_be_at_location');
  assert.equal(stored.place_id, homeId);
});

test('saving No Location and Ignore location on Laundry allows Normal subject and copies each subtask skill ID', async () => {
  const activity = await laundry();
  const saved = await call('PUT', `/automation/admin/activity-templates/${activity.id}`, {
    location_mode: 'none', place_id: null, presence_policy: 'ignore',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.location_mode, 'none');
  assert.equal(saved.body.data.place_id, null);
  assert.equal(saved.body.data.presence_policy, 'ignore');
  const response = await call('POST', '/tasks', taskBody(activity));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.assigned_to, subjectId);
  assert.deepEqual(response.body.data.skill_ids, []);
  assert.deepEqual(response.body.data.subtasks.map(item => item.skill_ids), skillIds.map(id => [id]));
  assert.ok(response.body.data.subtasks.every(item => item.assigned_to === null));
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM task_activity_support_tasks WHERE source_task_id=?')
    .get(response.body.data.id).n, 0);
});

test('copied Laundry subtask allows manual Normal and still rejects a supervised independent assignee', async () => {
  const activity = await laundry({ location_mode: 'none', place_id: null, presence_policy: 'ignore' });
  const response = await call('POST', '/tasks', taskBody(activity));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  for (const child of response.body.data.subtasks) {
    const qualified = await call('PUT', `/tasks/${child.id}`, { assigned_to: [subjectId] });
    assert.equal(qualified.status, 200, JSON.stringify(qualified.body));
    assert.equal(qualified.body.data.assigned_to, subjectId);
    const rejected = await call('PUT', `/tasks/${child.id}`, { assigned_to: [learnerId] });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(child.id).assigned_to, subjectId);
    assert.deepEqual(d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id=? ORDER BY sort_order')
      .all(child.id).map(row => row.skill_id), child.skill_ids);
  }
});

test('parent skill and navigation location are independent; subtask skill requirements never become parent requirements', async () => {
  const activity = await laundry({ location_mode: 'none', place_id: null, presence_policy: 'ignore' });
  // A parent without requirements may coordinate work whose individual subtasks
  // still need separate qualified workers. It must not inherit all child skills.
  const parent = await call('POST', '/tasks', taskBody(activity, { activity_subject_user_id: learnerId }));
  assert.equal(parent.status, 201, JSON.stringify(parent.body));
  assert.equal(parent.body.data.assigned_to, learnerId);
  for (const location of [null, { kind: 'saved_place', place_id: homeId }]) {
    const qualified = await call('POST', '/tasks', {
      title: 'Explicitly skilled laundry', skill_ids: [skillIds[0]], assigned_to: [subjectId], location,
    });
    assert.equal(qualified.status, 201, JSON.stringify(qualified.body));
    const rejected = await call('POST', '/tasks', {
      title: 'Unqualified laundry', skill_ids: [skillIds[0]], assigned_to: [learnerId], location,
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  }
  const constrained = await laundry({ location_mode: 'none', place_id: null, presence_policy: 'ignore', skill_ids: [skillIds[0]],
    assignment_strategy: 'fixed', fixed_user_id: subjectId, subject_required: false });
  assert.equal((await call('POST', '/tasks', taskBody(constrained))).status, 201);
  const changed = await call('PUT', `/automation/admin/activity-templates/${constrained.id}`, { fixed_user_id: learnerId });
  assert.equal(changed.status, 200);
  assert.equal((await call('POST', '/tasks', taskBody(constrained))).status, 400);
});

test('renaming a Laundry skill keeps template and generated subtask references stable; invalid IDs are rejected', async () => {
  const activity = await laundry({ location_mode: 'none', place_id: null, presence_policy: 'ignore' });
  const renamed = await call('PUT', `/automation/admin/skills/${skillIds[0]}`, { name: 'Load washing machine' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.data.id, skillIds[0]);
  const response = await call('POST', '/tasks', taskBody(activity));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(response.body.data.subtasks[0].skill_ids, [skillIds[0]]);
  assert.equal(response.body.data.subtasks[0].skills[0].name, 'Load washing machine');
  const invalid = await call('PUT', `/automation/admin/activity-templates/${activity.id}`, {
    checklist: [{ title_template: 'Stale skill', skill_ids: [999999999] }],
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.deepEqual(getActivityTemplate(d, activity.id).checklist.map(item => item.skill_ids), skillIds.map(id => [id]));
});

test('absence of a skill-qualified helper retains its skill-specific error instead of blaming location', async () => {
  const activity = await laundry({ location_mode: 'none', place_id: null, presence_policy: 'ignore', skill_ids: [skillIds[0]] });
  d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id=?")
    .run(subjectId, skillIds[0]);
  try {
    const response = await call('POST', '/tasks', taskBody(activity, { activity_subject_user_id: learnerId }));
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error, 'No qualified household member is available to help with this activity.');
  } finally {
    d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=? AND skill_id=?")
      .run(subjectId, skillIds[0]);
  }
});

test('supervised subject reports unavailable qualified helper, then retains supervision when location is ignored', async () => {
  const activity = await laundry({ skill_ids: [skillIds[0]] });
  const options = { subjectUserId: learnerId, dateKey: '2026-09-10', commitRotation: false };
  assert.throws(() => resolveActivityAssignment(d, activity, options), { message: presenceMessage });
  const saved = await call('PUT', `/automation/admin/activity-templates/${activity.id}`, {
    location_mode: 'none', place_id: null, presence_policy: 'ignore',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const resolution = resolveActivityAssignment(d, getActivityTemplate(d, activity.id), options);
  assert.equal(resolution.primary.id, learnerId);
  assert.equal(resolution.supervisor.id, subjectId);
  assert.equal(resolution.subjectProficiency.proficiency, 'supervised');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM activity_rotation_state WHERE activity_template_id=?')
    .get(activity.id).n, 0, 'failed and successful previews must not advance the supervisor rotation');
});
