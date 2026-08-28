import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'test-session-secret-at-least-32-characters-long';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
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

function addUser(username, displayName, role, familyRole, birthDate = null) {
  const id = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, '$2b$12$x', ?, ?)
  `).run(username, displayName, role, familyRole).lastInsertRowid);
  if (birthDate) {
    db.prepare(`INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES (?, ?, ?, ?)`)
      .run(displayName, birthDate, id, id);
  }
  return id;
}

const admin = addUser('admin', 'Admin', 'admin', 'parent', '1990-01-01');
const grace = addUser('grace', 'Grace', 'member', 'child', '2016-01-01');
const frank = addUser('frank', 'Frank', 'member', 'child', '2020-08-25');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/automation', automationRouter);
app.use('/api/v1/tasks', tasksRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => server.close());

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

test('admins can build skills, activities and a Quick Add workflow from the API', async () => {
  const makeBedSkill = await call('POST', '/automation/admin/skills', {
    name: 'Make a bed', minimum_age: 5, age_promotion: 'supervised', active: true,
  });
  assert.equal(makeBedSkill.status, 201, JSON.stringify(makeBedSkill.body));

  const laundrySkill = await call('POST', '/automation/admin/skills', {
    name: 'Use washer and dryer', minimum_age: 10, age_promotion: 'supervised', active: true,
  });
  assert.equal(laundrySkill.status, 201, JSON.stringify(laundrySkill.body));

  for (const [skillId, userId] of [
    [makeBedSkill.body.data.id, grace],
    [makeBedSkill.body.data.id, admin],
    [laundrySkill.body.data.id, grace],
    [laundrySkill.body.data.id, admin],
  ]) {
    const response = await call('PUT', `/automation/admin/skills/${skillId}/members/${userId}`, {
      proficiency: 'normal',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }

  const wash = await call('POST', '/automation/admin/activity-templates', {
    name: 'Wash & Dry Bedding',
    title_template: "Wash & Dry {subject}'s Bedding",
    category: 'misc',
    assignment_strategy: 'eligible_round_robin',
    subject_required: true,
    skill_ids: [laundrySkill.body.data.id],
  });
  assert.equal(wash.status, 201, JSON.stringify(wash.body));

  const makeBed = await call('POST', '/automation/admin/activity-templates', {
    name: 'Make Bed',
    title_template: "Make {subject}'s Bed",
    description: 'Help {subject} finish {activity}.',
    category: 'misc',
    assignment_strategy: 'subject_skill',
    subject_required: true,
    skill_ids: [makeBedSkill.body.data.id],
  });
  assert.equal(makeBed.status, 201, JSON.stringify(makeBed.body));

  const invalidForwardDependency = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Invalid Forward Dependency',
    category: 'misc',
    subject_required: true,
    quick_add_enabled: false,
    input_schema: [],
    steps: [
      { step_key: 'first', activity_template_id: wash.body.data.id, depends_on: ['later'] },
      { step_key: 'later', activity_template_id: makeBed.body.data.id, depends_on: [] },
    ],
  });
  assert.equal(invalidForwardDependency.status, 400, JSON.stringify(invalidForwardDependency.body));
  assert.match(invalidForwardDependency.body.error, /earlier step/i);

  const workflow = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Soiled Sheets',
    description: 'Clean and remake soiled bedding.',
    category: 'misc',
    subject_required: true,
    quick_add_enabled: true,
    input_schema: [],
    steps: [
      { step_key: 'wash', activity_template_id: wash.body.data.id, depends_on: [] },
      { step_key: 'make_bed', activity_template_id: makeBed.body.data.id, depends_on: ['wash'] },
    ],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));

  const quick = await call('GET', '/automation/quick-add');
  assert.equal(quick.status, 200);
  assert.ok(quick.body.data.some((row) => row.name === 'Soiled Sheets'));
  assert.ok(quick.body.activities.some((row) => row.name === 'Make Bed'));
  assert.equal(quick.body.activities.find((row) => row.name === 'Make Bed').title_template, "Make {subject}'s Bed");

  const preview = await call('POST', `/automation/quick-add/${workflow.body.data.id}/preview`, {
    subject_user_id: frank,
    inputs: {},
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.steps.length, 2);
  assert.equal(preview.body.data.steps[1].subject_proficiency, 'supervised');
  assert.equal(preview.body.data.steps[1].description, 'Help Frank finish Make Bed.');
  assert.ok(preview.body.data.steps[1].supervisor);

  const created = await call('POST', `/automation/quick-add/${workflow.body.data.id}/create`, {
    subject_user_id: frank,
    inputs: {},
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.tasks.length, 3);

  const washTask = created.body.data.tasks.find((row) => row.step_key === 'wash' && row.role === 'primary');
  const bedTask = created.body.data.tasks.find((row) => row.step_key === 'make_bed' && row.role === 'primary');
  const supervisorTask = created.body.data.tasks.find((row) => row.step_key === 'make_bed' && row.role === 'supervisor');
  assert.ok(washTask && bedTask && supervisorTask);

  // The workflow parent is an event container. It cannot be manually completed
  // while any generated activity remains unfinished.
  const blockedParent = await call('PATCH', `/tasks/${created.body.data.parent_task_id}/status`, { status: 'done' });
  assert.equal(blockedParent.status, 409, JSON.stringify(blockedParent.body));
  assert.deepEqual(
    new Set(blockedParent.body.dependencies.map((row) => row.id)),
    new Set(created.body.data.tasks.map((row) => row.task_id)),
  );

  // Dependency graph is enforced by the ordinary task status endpoint.
  const blocked = await call('PATCH', `/tasks/${bedTask.task_id}/status`, { status: 'done' });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.deepEqual(blocked.body.dependencies.map((row) => row.id), [washTask.task_id]);

  assert.equal((await call('PATCH', `/tasks/${washTask.task_id}/status`, { status: 'done' })).status, 200);
  assert.equal((await call('PATCH', `/tasks/${bedTask.task_id}/status`, { status: 'done' })).status, 200);
  assert.equal((await call('PATCH', `/tasks/${supervisorTask.task_id}/status`, { status: 'done' })).status, 200);

  const parent = db.prepare('SELECT status FROM tasks WHERE id = ?').get(created.body.data.parent_task_id);
  const instance = db.prepare('SELECT status FROM workflow_instances WHERE id = ?').get(created.body.data.id);
  assert.equal(parent.status, 'done');
  assert.equal(instance.status, 'done');
});


test('workflow branching validates question references and skips inactive branches safely', async () => {
  const activity = await call('POST', '/automation/admin/activity-templates', {
    name: 'Branch Test Activity', title_template: 'Branch Test Activity', category: 'misc',
    assignment_strategy: 'fixed', subject_required: false, fixed_user_id: admin, skill_ids: [],
  });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  const activityId = activity.body.data.id;

  const invalidQuestionReference = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Invalid condition reference', category: 'misc', subject_required: false, quick_add_enabled: false,
    input_schema: [{ key: 'mattress_soiled', label: 'Mattress soiled?', type: 'boolean' }],
    steps: [{ step_key: 'clean', activity_template_id: activityId,
      condition: { input: 'mattres_soiled', equals: true }, depends_on: [] }],
  });
  assert.equal(invalidQuestionReference.status, 400, JSON.stringify(invalidQuestionReference.body));
  assert.match(invalidQuestionReference.body.error, /unknown variable/i);

  const invalidSelectCondition = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Invalid select branch', category: 'misc', subject_required: false, quick_add_enabled: false,
    input_schema: [{ key: 'severity', label: 'Severity', type: 'select', options: ['light', 'heavy'] }],
    steps: [{ step_key: 'clean', activity_template_id: activityId,
      condition: { input: 'severity', equals: 'medium' }, depends_on: [] }],
  });
  assert.equal(invalidSelectCondition.status, 400, JSON.stringify(invalidSelectCondition.body));
  assert.match(invalidSelectCondition.body.error, /configured choices/i);

  const workflow = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Conditional dependency test', category: 'misc', subject_required: false, quick_add_enabled: true,
    input_schema: [{ key: 'mattress_soiled', label: 'Mattress soiled?', type: 'boolean' }],
    steps: [
      { step_key: 'start', activity_template_id: activityId, depends_on: [] },
      { step_key: 'clean', activity_template_id: activityId,
        condition: { input: 'mattress_soiled', equals: true }, depends_on: ['start'] },
      { step_key: 'finish', activity_template_id: activityId, depends_on: ['clean'] },
    ],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body.data.id;

  const falsePreview = await call('POST', `/automation/quick-add/${workflowId}/preview`, {
    inputs: { mattress_soiled: false },
  });
  assert.equal(falsePreview.status, 200, JSON.stringify(falsePreview.body));
  assert.deepEqual(falsePreview.body.data.steps.map((step) => step.step_key), ['start', 'finish']);
  assert.deepEqual(falsePreview.body.data.steps.find((step) => step.step_key === 'finish').depends_on, ['start']);

  const falseCreated = await call('POST', `/automation/quick-add/${workflowId}/create`, {
    inputs: { mattress_soiled: false },
  });
  assert.equal(falseCreated.status, 201, JSON.stringify(falseCreated.body));
  assert.deepEqual(falseCreated.body.data.tasks.map((task) => task.step_key), ['start', 'finish']);
  const falseStart = falseCreated.body.data.tasks.find((task) => task.step_key === 'start');
  const falseFinish = falseCreated.body.data.tasks.find((task) => task.step_key === 'finish');
  assert.deepEqual(
    db.prepare('SELECT depends_on_task_id FROM workflow_task_dependencies WHERE task_id = ?').all(falseFinish.task_id),
    [{ depends_on_task_id: falseStart.task_id }],
  );

  const truePreview = await call('POST', `/automation/quick-add/${workflowId}/preview`, {
    inputs: { mattress_soiled: true },
  });
  assert.equal(truePreview.status, 200, JSON.stringify(truePreview.body));
  assert.deepEqual(truePreview.body.data.steps.map((step) => step.step_key), ['start', 'clean', 'finish']);
  assert.deepEqual(truePreview.body.data.steps.find((step) => step.step_key === 'finish').depends_on, ['clean']);

  const unknownRuntimeInput = await call('POST', `/automation/quick-add/${workflowId}/preview`, {
    inputs: { mattress_soiled: false, mattres_soiled: true },
  });
  assert.equal(unknownRuntimeInput.status, 400, JSON.stringify(unknownRuntimeInput.body));
  assert.match(unknownRuntimeInput.body.error, /unknown workflow input/i);

  const allConditional = await call('POST', '/automation/admin/workflow-templates', {
    name: 'All conditional', category: 'misc', subject_required: false, quick_add_enabled: true,
    input_schema: [{ key: 'run_it', label: 'Run it?', type: 'boolean' }],
    steps: [{ step_key: 'only', activity_template_id: activityId,
      condition: { input: 'run_it', equals: true }, depends_on: [] }],
  });
  assert.equal(allConditional.status, 201, JSON.stringify(allConditional.body));
  const beforeInstances = db.prepare('SELECT COUNT(*) AS n FROM workflow_instances').get().n;
  const beforeTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

  const emptyPreview = await call('POST', `/automation/quick-add/${allConditional.body.data.id}/preview`, {
    inputs: { run_it: false },
  });
  assert.equal(emptyPreview.status, 400, JSON.stringify(emptyPreview.body));
  assert.match(emptyPreview.body.error, /no activities apply/i);

  const emptyCreate = await call('POST', `/automation/quick-add/${allConditional.body.data.id}/create`, {
    inputs: { run_it: false },
  });
  assert.equal(emptyCreate.status, 400, JSON.stringify(emptyCreate.body));
  assert.match(emptyCreate.body.error, /no activities apply/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workflow_instances').get().n, beforeInstances);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, beforeTasks);
});

test('typed variables use stable IDs for member subjects, conditions, and substitutions', async () => {
  const activity = await call('POST', '/automation/admin/activity-templates', {
    name: 'Typed Variable Activity',
    title_template: 'Prepare for {subject}',
    description: 'Default preparation for {{traveler}}',
    category: 'misc',
    assignment_strategy: 'fixed',
    subject_required: true,
    fixed_user_id: admin,
    skill_ids: [],
  });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));

  const inputSchema = [
    { id: 'traveler', label: 'Who is traveling?', type: 'household_member' },
    { id: 'include_packing', label: 'Include packing?', type: 'boolean' },
    { id: 'meal', label: 'Meal', type: 'choice', options: ['regular', 'vegetarian'] },
    { id: 'bags', label: 'Number of bags', type: 'number' },
    { id: 'depart_date', label: 'Departure date', type: 'date' },
    { id: 'depart_time', label: 'Departure time', type: 'time' },
    { id: 'note', label: 'Note', type: 'text' },
  ];
  const workflow = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Trip for {{traveler}}',
    description: '{{note}}',
    category: 'misc',
    subject_required: false,
    quick_add_enabled: true,
    input_schema: inputSchema,
    steps: [{
      step_key: 'pack',
      activity_template_id: activity.body.data.id,
      subject_variable_id: 'traveler',
      title_override: 'Pack {{bags}} bags for {subject}',
      description_override: '{{note}} on {{depart_date}} at {{depart_time}} ({{meal}})',
      condition: { variable_id: 'include_packing', equals: true },
      depends_on: [],
    }],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  assert.equal(workflow.body.data.input_schema[0].id, 'traveler');
  assert.equal(workflow.body.data.steps[0].subject_variable_id, 'traveler');
  assert.equal(workflow.body.data.steps[0].condition.variable_id, 'include_packing');

  const inputs = {
    traveler: frank,
    include_packing: true,
    meal: 'vegetarian',
    bags: 3,
    depart_date: '2026-09-01',
    depart_time: '08:30',
    note: 'Bring hats',
  };
  const preview = await call('POST', `/automation/quick-add/${workflow.body.data.id}/preview`, { inputs });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.workflow.name, 'Trip for Frank');
  assert.equal(preview.body.data.steps[0].subject.id, frank);
  assert.equal(preview.body.data.steps[0].title, 'Pack 3 bags for Frank');
  assert.equal(preview.body.data.steps[0].description, 'Bring hats on 2026-09-01 at 08:30 (vegetarian)');

  const created = await call('POST', `/automation/quick-add/${workflow.body.data.id}/create`, { inputs });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const primaryTask = db.prepare('SELECT title, description FROM tasks WHERE id = ?')
    .get(created.body.data.tasks[0].task_id);
  assert.deepEqual(primaryTask, {
    title: 'Pack 3 bags for Frank',
    description: 'Bring hats on 2026-09-01 at 08:30 (vegetarian)',
  });

  const invalidMember = await call('POST', `/automation/quick-add/${workflow.body.data.id}/preview`, {
    inputs: { ...inputs, traveler: 999999 },
  });
  assert.equal(invalidMember.status, 400, JSON.stringify(invalidMember.body));
  assert.match(invalidMember.body.error, /valid household member/i);

  const invalidDate = await call('POST', `/automation/quick-add/${workflow.body.data.id}/preview`, {
    inputs: { ...inputs, depart_date: '2026-02-31' },
  });
  assert.equal(invalidDate.status, 400, JSON.stringify(invalidDate.body));
  assert.match(invalidDate.body.error, /must be a date/i);

  const invalidTemplateReference = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Trip for {{missing_variable}}',
    category: 'misc',
    subject_required: false,
    quick_add_enabled: false,
    input_schema: inputSchema,
    steps: [{ step_key: 'pack', activity_template_id: activity.body.data.id, depends_on: [] }],
  });
  assert.equal(invalidTemplateReference.status, 400, JSON.stringify(invalidTemplateReference.body));
  assert.match(invalidTemplateReference.body.error, /unknown variable/i);

  const invalidSubjectType = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Invalid typed subject',
    category: 'misc',
    subject_required: false,
    quick_add_enabled: false,
    input_schema: inputSchema,
    steps: [{
      step_key: 'pack',
      activity_template_id: activity.body.data.id,
      subject_variable_id: 'bags',
      depends_on: [],
    }],
  });
  assert.equal(invalidSubjectType.status, 400, JSON.stringify(invalidSubjectType.body));
  assert.match(invalidSubjectType.body.error, /Household Member variable/i);
});

test('automation definitions delete only after their dependencies are removed', async () => {
  const skill = await call('POST', '/automation/admin/skills', {
    name: 'Deletion guard skill', minimum_age: 0, age_promotion: 'normal', active: true,
  });
  assert.equal(skill.status, 201, JSON.stringify(skill.body));

  const activity = await call('POST', '/automation/admin/activity-templates', {
    name: 'Deletion guard activity',
    title_template: 'Deletion guard activity',
    category: 'misc',
    assignment_strategy: 'fixed',
    subject_required: false,
    fixed_user_id: admin,
    skill_ids: [skill.body.data.id],
  });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));

  const blockedSkill = await call('DELETE', `/automation/admin/skills/${skill.body.data.id}`);
  assert.equal(blockedSkill.status, 409, JSON.stringify(blockedSkill.body));
  assert.match(blockedSkill.body.error, /required by an activity template/i);

  const workflow = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Deletion guard workflow',
    category: 'misc',
    subject_required: false,
    quick_add_enabled: true,
    input_schema: [],
    steps: [{
      step_key: 'only',
      activity_template_id: activity.body.data.id,
      depends_on: [],
    }],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));

  const blockedActivity = await call('DELETE', `/automation/admin/activity-templates/${activity.body.data.id}`);
  assert.equal(blockedActivity.status, 409, JSON.stringify(blockedActivity.body));
  assert.match(blockedActivity.body.error, /used by a workflow template/i);

  assert.equal((await call('DELETE', `/automation/admin/workflow-templates/${workflow.body.data.id}`)).status, 204);
  assert.equal((await call('DELETE', `/automation/admin/activity-templates/${activity.body.data.id}`)).status, 204);
  assert.equal((await call('DELETE', `/automation/admin/skills/${skill.body.data.id}`)).status, 204);

  assert.equal((await call('DELETE', `/automation/admin/skills/${skill.body.data.id}`)).status, 404);
  assert.equal((await call('DELETE', `/automation/admin/activity-templates/${activity.body.data.id}`)).status, 404);
  assert.equal((await call('DELETE', `/automation/admin/workflow-templates/${workflow.body.data.id}`)).status, 404);
});
