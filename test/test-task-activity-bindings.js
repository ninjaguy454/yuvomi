import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

function buildTestDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const migration of ALL_MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const db = buildTestDb();
_setTestDatabase(db);

function addUser(username, displayName, familyRole = 'child', birthDate = null, role = 'member') {
  const id = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, '$2b$12$x', ?, ?)
  `).run(username, displayName, role, familyRole).lastInsertRowid);
  if (birthDate) {
    db.prepare(`
      INSERT INTO birthdays (name, birth_date, created_by, family_user_id)
      VALUES (?, ?, ?, ?)
    `).run(displayName, birthDate, id, id);
  }
  return id;
}

const admin = addUser('admin', 'Admin', 'other', null, 'admin');
const grace = addUser('grace', 'Grace', 'child', '2016-01-01');
const frank = addUser('frank', 'Frank', 'child', '2020-08-25');
const mom = addUser('mom', 'Mom', 'mom', '1990-01-01');

function addSkill(name, { minimumAge = 0, promotion = 'supervised' } = {}) {
  return Number(db.prepare(`
    INSERT INTO skills (name, minimum_age, age_promotion, created_by)
    VALUES (?, ?, ?, ?)
  `).run(name, minimumAge, promotion, admin).lastInsertRowid);
}

function setProficiency(userId, skillId, proficiency) {
  db.prepare(`
    INSERT INTO user_skill_proficiency (user_id, skill_id, proficiency, source, updated_by)
    VALUES (?, ?, ?, 'manual', ?)
    ON CONFLICT(user_id, skill_id)
    DO UPDATE SET proficiency = excluded.proficiency, source = 'manual', updated_by = excluded.updated_by
  `).run(userId, skillId, proficiency, admin);
}

function addActivity({ name, strategy = 'subject_skill', subjectRequired = 1, skillIds = [] }) {
  const id = Number(db.prepare(`
    INSERT INTO activity_templates (
      name, title_template, category, assignment_strategy, subject_required,
      supervision_title_template, active, created_by
    ) VALUES (?, ?, 'misc', ?, ?, 'Supervise {subject}: {activity}', 1, ?)
  `).run(name, `${name} {subject}`, strategy, subjectRequired, admin).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO activity_template_skills (activity_template_id, skill_id, sort_order)
    VALUES (?, ?, ?)
  `);
  skillIds.forEach((skillId, index) => insert.run(id, skillId, index));
  return id;
}

const makeBedSkill = addSkill('Make bed', { minimumAge: 5, promotion: 'supervised' });
const laundrySkill = addSkill('Laundry', { minimumAge: 10, promotion: 'supervised' });
setProficiency(grace, makeBedSkill, 'normal');
setProficiency(mom, makeBedSkill, 'normal');
setProficiency(grace, laundrySkill, 'normal');
setProficiency(mom, laundrySkill, 'normal');

const makeBedActivity = addActivity({
  name: 'Make Bed',
  strategy: 'subject_skill',
  subjectRequired: 1,
  skillIds: [makeBedSkill],
});
const laundryActivity = addActivity({
  name: 'Laundry Rotation',
  strategy: 'eligible_round_robin',
  subjectRequired: 0,
  skillIds: [laundrySkill],
});
db.prepare(`
  INSERT INTO activity_template_checklist_items (activity_template_id, title_template, sort_order)
  VALUES (?, 'Move laundry to the dryer', 0)
`).run(laundryActivity);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(() => server.close());

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function task(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function followupOf(id) {
  return db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? AND parent_task_id IS NULL ORDER BY id LIMIT 1').get(id);
}

function bindingOf(id) {
  return db.prepare('SELECT * FROM task_activity_bindings WHERE task_id = ?').get(id);
}

function supportOf(id) {
  return db.prepare(`
    SELECT t.*, s.role
      FROM task_activity_support_tasks s JOIN tasks t ON t.id = s.task_id
     WHERE s.source_task_id = ?
  `).get(id);
}

function assignments(id) {
  return db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
    .all(id).map((row) => row.user_id);
}

const today = new Date().toISOString().slice(0, 10);

test('scheduled task binding uses subject proficiency and creates explicit supervision work', async () => {
  const created = await call('POST', '', {
    title: 'Frank makes his bed',
    due_date: today,
    activity_template_id: makeBedActivity,
    activity_subject_user_id: frank,
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, mom],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const parent = task(created.body.data.id);
  assert.equal(parent.assigned_to, frank);
  assert.equal(parent.assignment_mode, 'fixed', 'Activity Template owns assignment instead of Task RR');
  assert.deepEqual(assignments(parent.id), [frank]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_rotation_members WHERE task_id = ?').get(parent.id).n, 0);

  const binding = bindingOf(parent.id);
  assert.equal(binding.activity_template_id, makeBedActivity);
  assert.equal(binding.subject_user_id, frank);
  assert.equal(created.body.data.activity_template_name, 'Make Bed');

  const support = supportOf(parent.id);
  assert.ok(support, 'supervised proficiency generates separate supervisor work');
  assert.equal(support.parent_task_id, parent.id);
  assert.ok([grace, mom].includes(support.assigned_to));
  assert.deepEqual(assignments(support.id), [support.assigned_to]);
});

test('recurring Activity Template task re-resolves eligible round robin each occurrence', async () => {
  const created = await call('POST', '', {
    title: 'Household laundry',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: laundryActivity,
    activity_subject_user_id: null,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = task(created.body.data.id);
  assert.ok([grace, mom].includes(first.assigned_to));
  assert.equal(first.assignment_mode, 'fixed');
  assert.deepEqual(
    db.prepare('SELECT title FROM tasks WHERE parent_task_id = ? ORDER BY id').all(first.id),
    [{ title: 'Move laundry to the dryer' }],
  );

  assert.equal((await call('PATCH', `/${first.id}/status`, { status: 'done' })).status, 200);
  const second = followupOf(first.id);
  assert.ok(second);
  assert.ok([grace, mom].includes(second.assigned_to));
  assert.notEqual(second.assigned_to, first.assigned_to, 'activity-level RR advances');
  assert.equal(bindingOf(second.id).activity_template_id, laundryActivity);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_rotation_members WHERE task_id = ?').get(second.id).n, 0);
  assert.deepEqual(
    db.prepare('SELECT title FROM tasks WHERE parent_task_id = ? ORDER BY id').all(second.id),
    [{ title: 'Move laundry to the dryer' }],
    'recurrence copies the Task-owned checklist once instead of rematerializing a duplicate',
  );

  // Eligibility is evaluated again for the next occurrence, not frozen as a
  // roster when the series was first created.
  setProficiency(first.assigned_to, laundrySkill, 'excluded');
  assert.equal((await call('PATCH', `/${second.id}/status`, { status: 'done' })).status, 200);
  const third = followupOf(second.id);
  assert.ok(third);
  assert.equal(third.assigned_to, second.assigned_to);
});

test('saving an unchanged binding does not consume a rotation turn and unbinding restores manual assignment', async () => {
  const skill = addSkill(`Rotation ${Date.now()}`, { minimumAge: 10, promotion: 'supervised' });
  setProficiency(grace, skill, 'normal');
  setProficiency(mom, skill, 'normal');
  const activity = addActivity({
    name: `Reusable rotation ${Date.now()}`,
    strategy: 'eligible_round_robin',
    subjectRequired: 0,
    skillIds: [skill],
  });

  const created = await call('POST', '', {
    title: 'Reusable scheduled chore',
    activity_template_id: activity,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  const before = task(id);
  const cursorBefore = db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity)?.last_user_id;
  assert.equal(cursorBefore, before.assigned_to);

  const saved = await call('PUT', `/${id}`, {
    title: 'Reusable scheduled chore renamed',
    activity_template_id: activity,
    activity_subject_user_id: null,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(task(id).assigned_to, before.assigned_to);
  const cursorAfter = db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity)?.last_user_id;
  assert.equal(cursorAfter, cursorBefore, 'ordinary edit must not advance Activity Template RR');

  const unbound = await call('PUT', `/${id}`, {
    activity_template_id: null,
    activity_subject_user_id: null,
    assignment_mode: 'fixed',
    assigned_to: [mom],
  });
  assert.equal(unbound.status, 200, JSON.stringify(unbound.body));
  assert.equal(bindingOf(id), undefined);
  assert.equal(task(id).assigned_to, mom);
  assert.deepEqual(assignments(id), [mom]);
});

test('recurrence undo treats regenerated supervision as part of the untouched next occurrence', async () => {
  const created = await call('POST', '', {
    title: 'Recurring supervised bed task',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: makeBedActivity,
    activity_subject_user_id: frank,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const source = task(created.body.data.id);
  assert.ok(supportOf(source.id));

  await call('PATCH', `/${source.id}/status`, { status: 'done' });
  const next = followupOf(source.id);
  assert.ok(next);
  const nextSupport = supportOf(next.id);
  assert.ok(nextSupport);
  assert.ok(nextSupport.recurrence_origin_id, 'generated support work links to prior occurrence support');

  const reopened = await call('PATCH', `/${source.id}/status`, { status: 'open' });
  assert.equal(reopened.status, 200);
  assert.equal(followupOf(source.id), undefined, 'untouched generated occurrence is discarded atomically');
});

test('legacy manual task round robin remains independent when no Activity Template is attached', async () => {
  const created = await call('POST', '', {
    title: 'Legacy manual rotation',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, mom],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = task(created.body.data.id);
  assert.equal(bindingOf(first.id), undefined);
  assert.equal(first.assignment_mode, 'round_robin');

  await call('PATCH', `/${first.id}/status`, { status: 'done' });
  const next = followupOf(first.id);
  assert.ok(next);
  assert.equal(next.assignment_mode, 'round_robin');
  assert.notEqual(next.assigned_to, first.assigned_to);
  assert.equal(bindingOf(next.id), undefined);
});

test('root-only recurrence keeps template subtasks, supervision and responsibilities on the next occurrence', async () => {
  db.prepare(`
    INSERT INTO activity_template_checklist_items (activity_template_id, title_template, sort_order)
    VALUES (?, 'Straighten the pillows', 0)
  `).run(makeBedActivity);

  const created = await call('POST', '', {
    title: 'Recurring supervised bed with checklist',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: makeBedActivity,
    activity_subject_user_id: frank,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const source = task(created.body.data.id);
  const sourceSupport = supportOf(source.id);
  const sourceChecklist = db.prepare(`
    SELECT t.* FROM tasks t
     WHERE t.parent_task_id = ?
       AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id)
  `).get(source.id);
  assert.ok(sourceSupport, 'supervision is first-class generated support work');
  assert.ok(sourceChecklist, 'the authored checklist is a real Task subtask');

  const responsibilityRoles = db.prepare(`
    SELECT role FROM task_responsibilities WHERE task_id = ? AND status = 'active' ORDER BY role
  `).all(source.id).map((row) => row.role);
  assert.ok(responsibilityRoles.includes('primary'));
  assert.ok(responsibilityRoles.includes('beneficiary'));
  assert.ok(responsibilityRoles.includes('supervisor'));

  assert.equal((await call('PATCH', `/${sourceChecklist.id}/status`, { status: 'done' })).status, 200);
  assert.equal((await call('PATCH', `/${source.id}/status`, { status: 'done' })).status, 200);

  const next = followupOf(source.id);
  assert.ok(next, 'the recurring root creates one top-level follow-up');
  assert.equal(bindingOf(next.id).activity_template_id, makeBedActivity);
  const nextSupport = supportOf(next.id);
  const nextChecklist = db.prepare(`
    SELECT t.* FROM tasks t
     WHERE t.parent_task_id = ?
       AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id)
  `).all(next.id);
  assert.equal(nextChecklist.length, 1, 'template checklist is copied once, not rematerialized twice');
  assert.equal(nextChecklist[0].title, 'Straighten the pillows');
  assert.equal(nextChecklist[0].status, 'open');
  assert.equal(nextChecklist[0].recurrence_origin_id, sourceChecklist.id);
  assert.ok(nextSupport, 'supervision is re-resolved for the new occurrence');
  assert.equal(nextSupport.status, 'open');
  assert.equal(nextSupport.recurrence_origin_id, sourceSupport.id);
  assert.ok(db.prepare(`
    SELECT 1 FROM task_responsibilities
     WHERE task_id = ? AND role = 'supervisor' AND status = 'active'
  `).get(next.id), 'the next occurrence records its supervision responsibility');

  // recurrence_origin_id also links copied subtasks. Reopening the old child
  // must not mistake its copied child for the root follow-up and delete it.
  assert.equal((await call('PATCH', `/${sourceChecklist.id}/status`, { status: 'open' })).status, 200);
  assert.ok(task(next.id), 'the top-level next occurrence remains');
  assert.ok(task(nextChecklist[0].id), 'its copied checklist remains');
  assert.ok(task(nextSupport.id), 'its generated supervision work remains');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE recurrence_origin_id = ? AND parent_task_id IS NULL')
      .get(source.id).n,
    1,
    'only the root is a recurrence follow-up',
  );
});

test('bound recurrence preserves assigned-subtask participation and private parent visibility', async () => {
  const skill = addSkill(`Assigned checklist ${Date.now()}`, { minimumAge: 10, promotion: 'normal' });
  setProficiency(admin, skill, 'excluded');
  setProficiency(frank, skill, 'excluded');
  setProficiency(grace, skill, 'normal');
  setProficiency(mom, skill, 'normal');
  const activity = addActivity({
    name: `Assigned checklist activity ${Date.now()}`,
    strategy: 'eligible_round_robin',
    subjectRequired: 0,
    skillIds: [skill],
  });
  const created = await call('POST', '', {
    title: 'Private recurring activity with delegated step',
    due_date: today,
    visibility: 'private',
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: activity,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const source = task(created.body.data.id);
  const subtaskCreated = await call('POST', '', {
    title: 'Delegated first-class subtask',
    parent_task_id: source.id,
    assigned_to: [frank],
    visibility: 'private',
  });
  assert.equal(subtaskCreated.status, 201, JSON.stringify(subtaskCreated.body));
  assert.ok(db.prepare(`
    SELECT 1 FROM task_responsibilities
     WHERE task_id = ? AND user_id = ? AND role = 'participant'
       AND source = 'subtasks' AND status = 'active'
  `).get(source.id, frank));

  assert.equal((await call('PATCH', `/${source.id}/status`, { status: 'done' })).status, 200);
  const next = followupOf(source.id);
  assert.ok(next);
  const copiedSubtask = db.prepare(`
    SELECT * FROM tasks
     WHERE parent_task_id = ? AND title = 'Delegated first-class subtask'
  `).get(next.id);
  assert.ok(copiedSubtask);
  assert.equal(copiedSubtask.assigned_to, frank);
  assert.equal(copiedSubtask.visibility, 'private');
  assert.ok(db.prepare(`
    SELECT 1 FROM task_responsibilities
     WHERE task_id = ? AND user_id = ? AND role = 'participant'
       AND source = 'subtasks' AND status = 'active'
  `).get(next.id, frank), 'Activity reassignment does not supersede Task-owned participation');
  assert.ok(assignments(next.id).includes(frank), 'the delegated member can still see the private parent');
  assert.ok(assignments(next.id).includes(next.assigned_to), 'the Activity-selected primary remains assigned');
});

test('recurrence treats an empty Task-owned checklist as authoritative after template edits', async () => {
  const emptyActivity = addActivity({
    name: `Initially empty checklist ${Date.now()}`,
    strategy: 'eligible_round_robin',
    subjectRequired: 0,
    skillIds: [laundrySkill],
  });
  const emptyCreated = await call('POST', '', {
    title: 'Recurring activity whose checklist starts empty',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: emptyActivity,
  });
  assert.equal(emptyCreated.status, 201, JSON.stringify(emptyCreated.body));
  const emptySource = task(emptyCreated.body.data.id);
  db.prepare(`
    INSERT INTO activity_template_checklist_items (activity_template_id, title_template, sort_order)
    VALUES (?, 'Added after the Task was authored', 0)
  `).run(emptyActivity);
  assert.equal((await call('PATCH', `/${emptySource.id}/status`, { status: 'done' })).status, 200);
  const emptyNext = followupOf(emptySource.id);
  assert.ok(emptyNext);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM tasks t
     WHERE t.parent_task_id = ?
       AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id)
  `).get(emptyNext.id).n, 0, 'a later template item is not injected into an existing series');

  const deletedActivity = addActivity({
    name: `Deleted checklist ${Date.now()}`,
    strategy: 'eligible_round_robin',
    subjectRequired: 0,
    skillIds: [laundrySkill],
  });
  db.prepare(`
    INSERT INTO activity_template_checklist_items (activity_template_id, title_template, sort_order)
    VALUES (?, 'Original Task-owned step', 0)
  `).run(deletedActivity);
  const deletedCreated = await call('POST', '', {
    title: 'Recurring activity whose checklist was deleted',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: deletedActivity,
  });
  assert.equal(deletedCreated.status, 201, JSON.stringify(deletedCreated.body));
  const deletedSource = task(deletedCreated.body.data.id);
  const deletedStep = db.prepare(`
    SELECT t.* FROM tasks t
     WHERE t.parent_task_id = ?
       AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id)
  `).get(deletedSource.id);
  assert.ok(deletedStep);
  assert.equal((await call('DELETE', `/${deletedStep.id}`)).status, 200);
  db.prepare(`
    UPDATE activity_template_checklist_items
       SET title_template = 'Current template replacement'
     WHERE activity_template_id = ?
  `).run(deletedActivity);
  assert.equal((await call('PATCH', `/${deletedSource.id}/status`, { status: 'done' })).status, 200);
  const deletedNext = followupOf(deletedSource.id);
  assert.ok(deletedNext);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM tasks t
     WHERE t.parent_task_id = ?
       AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id)
  `).get(deletedNext.id).n, 0, 'deleted Task-owned steps stay deleted across recurrence');
});

test('normal-to-supervised recurrence traces new support and preserves touched follow-ups', async () => {
  const skill = addSkill(`Changing supervision ${Date.now()}`, { minimumAge: 5, promotion: 'supervised' });
  setProficiency(grace, skill, 'normal');
  setProficiency(mom, skill, 'normal');
  const activity = addActivity({
    name: `Changing supervision activity ${Date.now()}`,
    strategy: 'subject_skill',
    subjectRequired: 1,
    skillIds: [skill],
  });

  async function createNext(label) {
    setProficiency(grace, skill, 'normal');
    const created = await call('POST', '', {
      title: label,
      due_date: today,
      is_recurring: 1,
      recurrence_rule: 'FREQ=DAILY',
      activity_template_id: activity,
      activity_subject_user_id: grace,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const source = task(created.body.data.id);
    assert.equal(supportOf(source.id), undefined, 'normal proficiency needs no support work');
    setProficiency(grace, skill, 'supervised');
    assert.equal((await call('PATCH', `/${source.id}/status`, { status: 'done' })).status, 200);
    const next = followupOf(source.id);
    const support = supportOf(next.id);
    assert.ok(support, 'the next occurrence reflects newly supervised proficiency');
    assert.equal(support.recurrence_origin_id, source.id, 'first support links to the previous root occurrence');
    return { source, next, support };
  }

  const untouched = await createNext('Untouched newly supervised recurrence');
  assert.equal((await call('PATCH', `/${untouched.source.id}/status`, { status: 'open' })).status, 200);
  assert.equal(followupOf(untouched.source.id), undefined, 'an untouched generated support row is safely reversible');

  const edited = await createNext('Edited newly supervised recurrence');
  const editedSupport = await call('PUT', `/${edited.support.id}`, {
    title: 'Household-edited supervision work',
  });
  assert.equal(editedSupport.status, 200, JSON.stringify(editedSupport.body));
  assert.equal((await call('PATCH', `/${edited.source.id}/status`, { status: 'open' })).status, 200);
  assert.ok(followupOf(edited.source.id), 'editing new support prevents destructive recurrence undo');

  const deleted = await createNext('Deleted newly supervised recurrence');
  assert.equal((await call('DELETE', `/${deleted.support.id}`)).status, 200);
  assert.equal((await call('PATCH', `/${deleted.source.id}/status`, { status: 'open' })).status, 200);
  assert.ok(followupOf(deleted.source.id), 'deleting new support prevents destructive recurrence undo');
});

test('Activity round-robin cursor rolls back on failed recurrence and retry advances it exactly once', async () => {
  const skill = addSkill(`Retry-safe rotation ${Date.now()}`, { minimumAge: 10, promotion: 'normal' });
  setProficiency(admin, skill, 'excluded');
  setProficiency(frank, skill, 'excluded');
  setProficiency(grace, skill, 'normal');
  setProficiency(mom, skill, 'normal');
  const activity = addActivity({
    name: `Retry-safe activity ${Date.now()}`,
    strategy: 'eligible_round_robin',
    subjectRequired: 0,
    skillIds: [skill],
  });
  db.prepare(`
    INSERT INTO activity_template_checklist_items (activity_template_id, title_template, sort_order)
    VALUES (?, 'Retry-safe generated step', 0)
  `).run(activity);

  const created = await call('POST', '', {
    title: 'Retry-safe recurring activity',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: activity,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const source = task(created.body.data.id);
  const cursorBefore = db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity).last_user_id;
  assert.equal(cursorBefore, source.assigned_to);

  // Fail after assignment resolution has advanced the Activity cursor but
  // before the copied binding can be stored. The outer status transaction must
  // roll the cursor, root, checklist, obligations and status back together.
  db.exec(`
    CREATE TRIGGER fail_retry_safe_followup_binding
    BEFORE INSERT ON task_activity_bindings
    WHEN NEW.task_id <> ${Number(source.id)}
    BEGIN
      SELECT RAISE(ABORT, 'forced follow-up binding failure');
    END
  `);
  const failed = await call('PATCH', `/${source.id}/status`, { status: 'done' });
  assert.equal(failed.status, 500);
  assert.equal(task(source.id).status, 'open', 'completion rolls back with the failed follow-up');
  assert.equal(followupOf(source.id), undefined, 'no partial root follow-up remains');
  assert.equal(db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity).last_user_id, cursorBefore, 'failed generation does not consume a rotation turn');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_activity_bindings WHERE activity_template_id = ?')
    .get(activity).n, 1, 'only the original binding remains');
  db.exec('DROP TRIGGER fail_retry_safe_followup_binding');

  const retried = await call('PATCH', `/${source.id}/status`, { status: 'done' });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const next = followupOf(source.id);
  assert.ok(next);
  assert.notEqual(next.assigned_to, source.assigned_to, 'the successful retry advances to the next eligible member');
  const cursorAfter = db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity).last_user_id;
  assert.equal(cursorAfter, next.assigned_to);
  assert.equal(bindingOf(next.id).activity_template_id, activity);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM tasks t
     WHERE t.parent_task_id = ?
       AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id)
  `).get(next.id).n, 1, 'retry creates the template subtask exactly once');

  const repeated = await call('PATCH', `/${source.id}/status`, { status: 'done' });
  assert.equal(repeated.status, 200);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE recurrence_origin_id = ? AND parent_task_id IS NULL')
      .get(source.id).n,
    1,
    'reconciliation/retry cannot duplicate the root output',
  );
  assert.equal(db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity).last_user_id, cursorAfter, 'idempotent retry does not consume another cursor turn');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
