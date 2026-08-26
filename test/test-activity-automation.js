import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const {
  effectiveSkillProficiency,
  effectiveActivityProficiency,
  resolveActivityAssignment,
} = await import('../server/services/activity-eligibility.js');
const {
  previewWorkflow,
  instantiateWorkflow,
  unresolvedDependencies,
} = await import('../server/services/activity-workflows.js');

function buildTestDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const migration of MIGRATIONS) {
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

function addUser(username, displayName, familyRole = 'child', birthDate = null) {
  const id = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, '$2b$12$x', 'member', ?)
  `).run(username, displayName, familyRole).lastInsertRowid);
  if (birthDate) {
    db.prepare(`
      INSERT INTO birthdays (name, birth_date, created_by, family_user_id)
      VALUES (?, ?, ?, ?)
    `).run(displayName, birthDate, id, id);
  }
  return id;
}

const admin = Number(db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('admin', 'Admin', '$2b$12$x', 'admin', 'other')
`).run().lastInsertRowid);
const grace = addUser('grace', 'Grace', 'child', '2016-01-01');
const frank = addUser('frank', 'Frank', 'child', '2020-08-25');
const mom = addUser('mom', 'Mom', 'mom', '1990-01-01');

function addSkill(name, { minimumAge = 0, promotion = 'supervised', adultOnly = 0 } = {}) {
  return Number(db.prepare(`
    INSERT INTO skills (name, minimum_age, age_promotion, adult_only, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, minimumAge, promotion, adultOnly, admin).lastInsertRowid);
}

function setProficiency(userId, skillId, proficiency) {
  db.prepare(`
    INSERT INTO user_skill_proficiency (user_id, skill_id, proficiency, source, updated_by)
    VALUES (?, ?, ?, 'manual', ?)
    ON CONFLICT(user_id, skill_id)
    DO UPDATE SET proficiency = excluded.proficiency, source = 'manual', updated_by = excluded.updated_by
  `).run(userId, skillId, proficiency, admin);
}

function addActivity({
  name,
  title,
  strategy = 'subject_skill',
  subjectRequired = 1,
  skillIds = [],
  fixedUserId = null,
}) {
  const id = Number(db.prepare(`
    INSERT INTO activity_templates (
      name, title_template, category, assignment_strategy, subject_required,
      fixed_user_id, supervision_title_template, active, created_by
    ) VALUES (?, ?, 'misc', ?, ?, ?, 'Supervise {subject}: {activity}', 1, ?)
  `).run(name, title, strategy, subjectRequired, fixedUserId, admin).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO activity_template_skills (activity_template_id, skill_id, sort_order)
    VALUES (?, ?, ?)
  `);
  skillIds.forEach((skillId, index) => insert.run(id, skillId, index));
  return id;
}

function activity(id) {
  return db.prepare('SELECT * FROM activity_templates WHERE id = ?').get(id);
}

const makeBedSkill = addSkill('Make a bed', { minimumAge: 5, promotion: 'supervised' });
const laundrySkill = addSkill('Use washer and dryer', { minimumAge: 10, promotion: 'supervised' });
const adultSkill = addSkill('Adult-only test', { minimumAge: 0, promotion: 'normal', adultOnly: 1 });

setProficiency(grace, makeBedSkill, 'normal');
setProficiency(grace, laundrySkill, 'normal');
setProficiency(mom, makeBedSkill, 'normal');
setProficiency(mom, laundrySkill, 'normal');

const makeBedActivity = addActivity({
  name: 'Make Bed',
  title: 'Make {subject}\'s Bed',
  strategy: 'subject_skill',
  skillIds: [makeBedSkill],
});
const laundryActivity = addActivity({
  name: 'Wash & Dry Bedding',
  title: 'Wash & Dry {subject}\'s Bedding',
  strategy: 'eligible_round_robin',
  skillIds: [laundrySkill],
});

test('age establishes the automatic proficiency baseline and manual proficiency overrides it', () => {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(makeBedSkill);
  const frankRow = db.prepare(`SELECT u.*, b.birth_date FROM users u LEFT JOIN birthdays b ON b.family_user_id = u.id WHERE u.id = ?`).get(frank);

  const automatic = effectiveSkillProficiency(db, skill, frankRow, '2026-08-25');
  assert.equal(automatic.age, 6);
  assert.equal(automatic.proficiency, 'supervised');
  assert.equal(automatic.source, 'automatic');

  setProficiency(frank, makeBedSkill, 'normal');
  const overridden = effectiveSkillProficiency(db, skill, frankRow, '2026-08-25');
  assert.equal(overridden.proficiency, 'normal');
  assert.equal(overridden.source, 'manual');

  db.prepare('DELETE FROM user_skill_proficiency WHERE user_id = ? AND skill_id = ?').run(frank, makeBedSkill);
});

test('adult-only safety rule cannot be bypassed by a manual child proficiency', () => {
  setProficiency(frank, adultSkill, 'normal');
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(adultSkill);
  const frankRow = db.prepare(`SELECT u.*, b.birth_date FROM users u LEFT JOIN birthdays b ON b.family_user_id = u.id WHERE u.id = ?`).get(frank);
  const result = effectiveSkillProficiency(db, skill, frankRow, '2026-08-25');
  assert.equal(result.proficiency, 'excluded');
  assert.equal(result.reason, 'adult_only');
});

test('inactive skills remain enforced by activities that already require them', () => {
  db.prepare('UPDATE skills SET active = 0 WHERE id = ?').run(laundrySkill);
  const frankRow = db.prepare(`SELECT u.*, b.birth_date FROM users u LEFT JOIN birthdays b ON b.family_user_id = u.id WHERE u.id = ?`).get(frank);
  const result = effectiveActivityProficiency(db, laundryActivity, frankRow, '2026-08-25');
  assert.equal(result.proficiency, 'excluded');
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].skill.id, laundrySkill);
  db.prepare('UPDATE skills SET active = 1 WHERE id = ?').run(laundrySkill);
});

test('fixed assignment cannot bypass skill or adult-only eligibility', () => {
  const fixedAdultActivity = addActivity({
    name: 'Adult-only fixed work',
    title: 'Adult-only fixed work',
    strategy: 'fixed',
    subjectRequired: 0,
    skillIds: [adultSkill],
    fixedUserId: frank,
  });
  assert.throws(
    () => resolveActivityAssignment(db, activity(fixedAdultActivity), {
      commitRotation: false,
      dateKey: '2026-08-25',
    }),
    /not independently qualified/i,
  );
});

test('subject-skill assignment creates a supervisor only while the subject is supervised', () => {
  const template = activity(makeBedActivity);

  const supervised = resolveActivityAssignment(db, template, {
    subjectUserId: frank,
    commitRotation: false,
    dateKey: '2026-08-25',
  });
  assert.equal(supervised.primary.id, frank);
  assert.equal(supervised.subjectProficiency.proficiency, 'supervised');
  assert.ok([grace, mom].includes(supervised.supervisor.id));

  setProficiency(frank, makeBedSkill, 'normal');
  const normal = resolveActivityAssignment(db, template, {
    subjectUserId: frank,
    commitRotation: false,
    dateKey: '2026-08-25',
  });
  assert.equal(normal.primary.id, frank);
  assert.equal(normal.supervisor, null);
  assert.equal(effectiveActivityProficiency(db, makeBedActivity, normal.subject, '2026-08-25').proficiency, 'normal');

  db.prepare('DELETE FROM user_skill_proficiency WHERE user_id = ? AND skill_id = ?').run(frank, makeBedSkill);
});

test('eligible round robin is derived from Normal proficiency and preview does not consume a turn', () => {
  const template = activity(laundryActivity);

  const previewA = resolveActivityAssignment(db, template, { subjectUserId: frank, commitRotation: false });
  const previewB = resolveActivityAssignment(db, template, { subjectUserId: frank, commitRotation: false });
  assert.equal(previewA.primary.id, previewB.primary.id);

  const first = resolveActivityAssignment(db, template, { subjectUserId: frank, commitRotation: true });
  const second = resolveActivityAssignment(db, template, { subjectUserId: frank, commitRotation: true });
  assert.notEqual(first.primary.id, second.primary.id);
  assert.deepEqual(new Set([first.primary.id, second.primary.id]), new Set([grace, mom]));
});

test('Soiled Sheets-style workflow expands activities, supervision, and dependencies', () => {
  // Keep Frank supervised for Make Bed, so the workflow should generate both
  // Frank's work and a separate supervision task.
  db.prepare('DELETE FROM user_skill_proficiency WHERE user_id = ? AND skill_id = ?').run(frank, makeBedSkill);

  const workflowId = Number(db.prepare(`
    INSERT INTO workflow_templates (
      name, description, category, quick_add_enabled, subject_required,
      input_schema_json, active, created_by
    ) VALUES ('Soiled Sheets', 'Reusable bedding cleanup workflow', 'misc', 1, 1, '[]', 1, ?)
  `).run(admin).lastInsertRowid);

  const washStep = Number(db.prepare(`
    INSERT INTO workflow_template_steps (
      workflow_template_id, activity_template_id, step_key, sort_order
    ) VALUES (?, ?, 'wash', 0)
  `).run(workflowId, laundryActivity).lastInsertRowid);
  const bedStep = Number(db.prepare(`
    INSERT INTO workflow_template_steps (
      workflow_template_id, activity_template_id, step_key, sort_order
    ) VALUES (?, ?, 'make_bed', 1)
  `).run(workflowId, makeBedActivity).lastInsertRowid);
  db.prepare(`
    INSERT INTO workflow_step_dependencies (step_id, depends_on_step_id)
    VALUES (?, ?)
  `).run(bedStep, washStep);

  const before = db.prepare("SELECT last_user_id FROM activity_rotation_state WHERE activity_template_id = ? AND purpose = 'primary'")
    .get(laundryActivity)?.last_user_id ?? null;
  const preview = previewWorkflow(db, workflowId, { subjectUserId: frank });
  assert.equal(preview.steps.length, 2);
  assert.equal(preview.steps[1].subject_proficiency, 'supervised');
  assert.ok(preview.steps[1].supervisor);
  const afterPreview = db.prepare("SELECT last_user_id FROM activity_rotation_state WHERE activity_template_id = ? AND purpose = 'primary'")
    .get(laundryActivity)?.last_user_id ?? null;
  assert.equal(afterPreview, before, 'preview must not advance round robin');

  const instance = instantiateWorkflow(db, workflowId, {
    subjectUserId: frank,
    inputs: {},
    createdBy: admin,
  });
  assert.ok(instance.parent_task_id);
  assert.equal(instance.tasks.length, 3, 'wash + make bed + supervise make bed');

  const wash = instance.tasks.find((row) => row.step_key === 'wash' && row.role === 'primary');
  const makeBed = instance.tasks.find((row) => row.step_key === 'make_bed' && row.role === 'primary');
  const supervise = instance.tasks.find((row) => row.step_key === 'make_bed' && row.role === 'supervisor');
  assert.ok(wash && makeBed && supervise);
  assert.equal(makeBed.assigned_to.id, frank);
  assert.ok([grace, mom].includes(supervise.assigned_to.id));

  const parentBlocked = unresolvedDependencies(db, instance.parent_task_id);
  assert.deepEqual(
    new Set(parentBlocked.map((row) => row.id)),
    new Set(instance.tasks.map((row) => row.task_id)),
    'workflow parent stays dependent on every generated activity',
  );

  const blockedPrimary = unresolvedDependencies(db, makeBed.task_id);
  const blockedSupervisor = unresolvedDependencies(db, supervise.task_id);
  assert.deepEqual(blockedPrimary.map((row) => row.id), [wash.task_id]);
  assert.deepEqual(blockedSupervisor.map((row) => row.id), [wash.task_id]);

  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(wash.task_id);
  assert.deepEqual(unresolvedDependencies(db, makeBed.task_id), []);
  assert.deepEqual(unresolvedDependencies(db, supervise.task_id), []);
});
