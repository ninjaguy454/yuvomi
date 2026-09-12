import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'availability-task-adversarial-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: taskRouter } = await import('../server/routes/tasks.js');
const { applyTaskActivityBinding, copyTaskActivityBinding } = await import('../server/services/task-activity-bindings.js');
const { claimTask, respondToTaskObligation } = await import('../server/services/assignment-responsibilities.js');
const { evaluateAvailability, activityPresenceWindow } = await import('../server/services/presence.js');
const { resolveActivityAssignment } = await import('../server/services/activity-eligibility.js');
const { sync: syncReminders } = await import('../server/services/caldav-reminders-sync.js');

let d, admin, worker, server, origin;
test.before(() => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = admin; req.authRole = 'admin'; req.session = { userId: admin, role: 'admin' }; next(); });
  app.use('/tasks', taskRouter);
  return new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys = ON');
  d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT,applied_at TEXT)');
  for (const migration of ALL_MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
    migration.afterUp?.(d);
    d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version, migration.description);
  }
  _setTestDatabase(d);
  const user = d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')");
  admin = Number(user.run('admin', 'Admin', 'admin').lastInsertRowid);
  worker = Number(user.run('worker', 'Worker', 'member').lastInsertRowid);
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });
test.after(() => new Promise((resolve) => server.close(resolve)));
function activity({ strategy = 'fixed', policy = 'available_before_due', window = 'due' } = {}) {
  return Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,presence_policy,presence_window,subject_required,created_by)
    VALUES('Test activity','Test activity','fixed',?,?,?,?,0,?)`).run(strategy, worker, policy, window, admin).lastInsertRowid);
}
function task({ due = '2026-09-11', time = '18:00', start = null, parent = null } = {}) {
  return Number(d.prepare("INSERT INTO tasks(title,created_by,due_date,due_time,start_date,parent_task_id) VALUES('Test task',?,?,?,?,?)").run(admin, due, time, start, parent).lastInsertRowid);
}
function shift(userId = worker, { start = '08:00', end = '16:00', anchor = '2026-09-11' } = {}) {
  const type = Number(d.prepare("INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state) VALUES('Busy work',?,?,'busy')").run(start, end).lastInsertRowid);
  const pattern = Number(d.prepare("INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES(?,'Daily work',?,1)").run(userId, anchor).lastInsertRowid);
  d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,0,?)').run(pattern, type);
  return pattern;
}
async function put(id, body) {
  const result = await fetch(`${origin}/tasks/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: result.status, body: await result.json() };
}

test('editing only the due time cannot move a bound assigned task into work hours', async () => {
  shift(); const id = task();
  assert.equal(evaluateAvailability(d, { userId: worker, policy: 'available_before_due', ...activityPresenceWindow(d, { task: d.prepare('SELECT * FROM tasks WHERE id=?').get(id), dateKey: '2026-09-11' }) }).eligible, true);
  applyTaskActivityBinding(d, id, { activityTemplateId: activity() });
  const obligation = d.prepare('SELECT id FROM planning_obligations WHERE task_id=?').get(id).id;
  const denied = await put(id, { due_time: '10:00' });
  assert.equal(denied.status, 400, JSON.stringify(denied.body));
  assert.match(denied.body.error, /availability/i);
  assert.equal(d.prepare('SELECT due_time FROM tasks WHERE id=?').get(id).due_time, '18:00');
  const allowed = await put(id, { due_time: '19:00' });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to, worker);
  assert.equal(d.prepare('SELECT id FROM planning_obligations WHERE task_id=?').get(id).id, obligation, 'moving a task must not advance rotation or regenerate obligations');
  assert.equal(d.prepare('SELECT due_at FROM planning_obligations WHERE id=?').get(obligation).due_at, '2026-09-11T19:00:00');
  assert.equal(d.prepare('SELECT response_deadline FROM planning_obligations WHERE id=?').get(obligation).response_deadline, '2026-09-11T19:00:00', 'a default response deadline follows the Task due time');
  d.prepare("UPDATE planning_obligations SET response_deadline='2026-09-11T17:00:00' WHERE id=?").run(obligation);
  assert.equal((await put(id, { due_time: '20:00' })).status, 200);
  assert.equal(d.prepare('SELECT response_deadline FROM planning_obligations WHERE id=?').get(obligation).response_deadline, '2026-09-11T17:00:00', 'a separately configured response deadline is preserved');
  d.prepare('UPDATE planning_obligations SET response_deadline=NULL WHERE id=?').run(obligation);
  assert.equal((await put(id, { due_time: '21:00' })).status, 200);
  assert.equal(d.prepare('SELECT response_deadline FROM planning_obligations WHERE id=?').get(obligation).response_deadline, null, 'an explicitly absent response deadline is preserved');
  d.prepare('UPDATE planning_obligations SET response_deadline=due_at WHERE id=?').run(obligation);
  assert.equal((await put(id, { due_date: null, due_time: null })).status, 200);
  assert.deepEqual(d.prepare('SELECT due_at,response_deadline FROM planning_obligations WHERE id=?').get(obligation), { due_at: null, response_deadline: null }, 'clearing the Task due date also clears a deadline tracking it');
});

test('date edits honor a workflow step policy even when the Activity default ignores availability', async () => {
  const pattern = shift();
  d.prepare('UPDATE schedule_patterns SET valid_from=?,valid_until=? WHERE id=?').run('2026-09-12', '2026-09-12', pattern);
  const activityId = activity({ policy: 'ignore' });
  const parent = task(); const id = task({ time: '10:00', parent });
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(worker, id);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, worker);
  d.prepare('INSERT INTO task_activity_bindings(task_id,activity_template_id) VALUES(?,?)').run(id, activityId);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','workflow')").run(id);
  const result = await put(id, { due_date: '2026-09-12' });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(d.prepare('SELECT due_date FROM tasks WHERE id=?').get(id).due_date, '2026-09-11');
});

test('an open claimable task can recover from zero eligible members after routine deletion', () => {
  shift(admin); const pattern = shift(); const id = task({ time: '10:00' });
  applyTaskActivityBinding(d, id, { activityTemplateId: activity({ strategy: 'open_claimable' }) });
  assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state, 'unavailable');
  assert.throws(() => claimTask(d, id, worker), /availability|eligible/i);
  d.prepare('DELETE FROM schedule_patterns WHERE id=?').run(pattern);
  assert.equal(claimTask(d, id, worker).assigned_to.id, worker);
  assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state, 'assigned');
});

test('accepting a pending obligation rechecks the Task window after a new routine conflict', () => {
  const id = task({ time: '10:00' }); applyTaskActivityBinding(d, id, { activityTemplateId: activity() });
  const obligation = d.prepare("SELECT id FROM planning_obligations WHERE task_id=? AND role='primary'").get(id).id;
  const pattern = shift();
  assert.throws(() => respondToTaskObligation(d, obligation, 'accept', worker), /availability/i);
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(obligation).status, 'pending');
  d.prepare('DELETE FROM schedule_patterns WHERE id=?').run(pattern);
  assert.equal(respondToTaskObligation(d, obligation, 'accept', worker).status, 'accepted');
});

test('a declined performer cannot block editing or reclaiming an unassigned Task, and subtask visibility remains', async () => {
  const adminPattern = shift(admin);
  const childWorker = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('child-worker','Child worker','x','member','parent')").run().lastInsertRowid);
  shift(childWorker);
  const id = task({ time: '10:00' });
  applyTaskActivityBinding(d, id, { activityTemplateId: activity({ strategy: 'open_claimable' }) });
  claimTask(d, id, worker);
  const child = task({ parent: id });
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(childWorker, child);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(child, childWorker);
  d.prepare("INSERT INTO task_responsibilities(task_id,user_id,role,source,status) VALUES(?,?,'participant','subtasks','active')").run(id, childWorker);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, childWorker);
  const obligation = d.prepare("SELECT id FROM planning_obligations WHERE task_id=? AND status='accepted' ORDER BY id DESC").get(id).id;
  respondToTaskObligation(d, obligation, 'decline', worker);
  assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state, 'unavailable');
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to, null);
  shift(worker);
  const edited = await put(id, { due_time: '11:00' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(d.prepare("SELECT COUNT(*) AS count FROM task_responsibilities WHERE task_id=? AND user_id=? AND status='active' AND role IN ('primary','participant')").get(id, worker).count, 0);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map((row) => row.user_id), [childWorker]);
  d.prepare('DELETE FROM schedule_patterns WHERE id=?').run(adminPattern);
  assert.equal(claimTask(d, id, admin).assigned_to.id, admin);
  assert.equal(d.prepare("SELECT COUNT(*) AS count FROM task_responsibilities WHERE task_id=? AND user_id=? AND status='active' AND role IN ('primary','participant')").get(id, worker).count, 0);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map((row) => row.user_id), [admin, childWorker]);
  assert.equal(d.prepare("SELECT status FROM task_responsibilities WHERE task_id=? AND user_id=? AND source='subtasks'").get(id, childWorker).status, 'active');
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(child).assigned_to, childWorker);
});

test('overnight eligibility checks the next Task occurrence instead of the original assignment date', () => {
  shift(worker, { start: '22:00', end: '06:00' });
  const source = task({ due: '2026-09-11', time: '18:00' });
  applyTaskActivityBinding(d, source, { activityTemplateId: activity() });
  const blocked = task({ due: '2026-09-12', time: '02:00' });
  assert.throws(() => copyTaskActivityBinding(d, source, blocked), /availability/i);
  const after = task({ due: '2026-09-12', time: '06:00' });
  assert.equal(copyTaskActivityBinding(d, source, after).resolution.primary.id, worker);
  assert.equal(d.prepare('SELECT COUNT(*) AS count FROM pragma_table_info(\'tasks\') WHERE name LIKE \'%duration%\'').get().count, 0, 'no synthetic Task duration column introduced');
});

test('manual tasks and Activity ignore policies remain editable during a work shift', async () => {
  shift(); const manual = task(); d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(worker, manual);
  assert.equal((await put(manual, { due_time: '10:00' })).status, 200);
  const ignored = task(); applyTaskActivityBinding(d, ignored, { activityTemplateId: activity({ policy: 'ignore' }) });
  assert.equal((await put(ignored, { due_time: '10:00' })).status, 200);
});

test('direct reassignment respects an occurrence policy even without an Activity binding', async () => {
  const id = task(); d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(worker, id);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, worker);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','activity_template')").run(id);
  shift(admin, { start: '17:00', end: '20:00' });
  const denied = await put(id, { assigned_to: [admin] });
  assert.equal(denied.status, 400, JSON.stringify(denied.body));
  assert.match(denied.body.error, /availability/i);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to, worker);
  const moved = await put(id, { assigned_to: [admin], due_time: '21:00' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to, admin);
});

test('supervised work requires a shared eligible interval, not disjoint free portions of one day', () => {
  const activityId = activity({ strategy: 'subject_skill', window: 'completion' });
  const skill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Supervised skill',0,'supervised',?)").run(admin).lastInsertRowid);
  d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(activityId, skill);
  const proficiency = d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)");
  proficiency.run(worker, skill, 'supervised', admin); proficiency.run(admin, skill, 'normal', admin);
  shift(worker, { start: '12:00', end: '00:00' });
  const supervisorPattern = shift(admin, { start: '00:00', end: '12:00' });
  const definition = d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activityId);
  const options = { subjectUserId: worker, dateKey: '2026-09-11', presence: {
    policy: 'available_before_due', startAt: '2026-09-11T00:00:00', endAt: '2026-09-12T00:00:00', windowMode: 'completion',
  } };
  assert.throws(() => resolveActivityAssignment(d, definition, options), /supervisor.*shares.*window/i);
  const supervisorType = d.prepare('SELECT shift_type_id FROM schedule_pattern_days WHERE pattern_id=?').get(supervisorPattern).shift_type_id;
  d.prepare("UPDATE schedule_shift_types SET end_time='11:00' WHERE id=?").run(supervisorType);
  const result = resolveActivityAssignment(d, definition, options);
  assert.equal(result.primary.id, worker); assert.equal(result.supervisor.id, admin);
  assert.throws(() => resolveActivityAssignment(d, definition, { ...options, presence: { ...options.presence, requiredDurationMinutes: 90 } }), /supervisor.*shares.*window/i);
});

test('generated supervisor Tasks retain their availability policy for subsequent date edits', async () => {
  const activityId = activity({ strategy: 'subject_skill' });
  const skill = Number(d.prepare("INSERT INTO skills(name,created_by) VALUES('Needs supervision',?)").run(admin).lastInsertRowid);
  d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(activityId, skill);
  const proficiency = d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)");
  proficiency.run(worker, skill, 'supervised', admin); proficiency.run(admin, skill, 'normal', admin);
  const source = task();
  const { support_task_id: support } = applyTaskActivityBinding(d, source, { activityTemplateId: activityId, subjectUserId: worker });
  assert.equal(d.prepare('SELECT presence_policy FROM task_planning_context WHERE task_id=?').get(support)?.presence_policy, 'available_before_due');
  shift(admin);
  const denied = await put(support, { due_time: '10:00' });
  assert.equal(denied.status, 400, JSON.stringify(denied.body));
  assert.equal(d.prepare('SELECT due_time FROM tasks WHERE id=?').get(support).due_time, '18:00');
});

test('CalDAV date edits reject bound Task conflicts visibly while preserving local and remote items', async () => {
  shift();
  const bound = task(); applyTaskActivityBinding(d, bound, { activityTemplateId: activity() });
  const manual = task({ parent: bound }); d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(worker, manual);
  const account = Number(d.prepare("INSERT INTO caldav_accounts(name,caldav_url,username,password) VALUES('Test','https://dav.example/','test','test')").run().lastInsertRowid);
  const list = 'https://dav.example/reminders/';
  d.prepare("INSERT INTO caldav_reminder_selection(account_id,list_url,list_name,target_module,enabled) VALUES(?,?,'Test','tasks',1)").run(account, list);
  const imported = d.prepare("UPDATE tasks SET external_uid=?,external_source='caldav',external_account_id=?,external_object_url=? WHERE id=?");
  imported.run('bound@test', account, `${list}bound.ics`, bound);
  imported.run('manual@test', account, `${list}manual.ics`, manual);
  const obligation = d.prepare('SELECT id,due_at FROM planning_obligations WHERE task_id=?').get(bound);
  let remoteDue = '20260911T140000Z'; // 10:00 in the household, during work.
  let writes = 0;
  const client = {
    fetchCalendars: async () => [{ url: list, components: ['VTODO'] }],
    fetchCalendarObjects: async () => ['bound', 'manual'].map((kind) => ({
      url: `${list}${kind}.ics`, etag: 'version-remote',
      data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', `UID:${kind}@test`,
        `SUMMARY:Remote ${kind}`, 'STATUS:NEEDS-ACTION', `DUE:${remoteDue}`,
        ...(kind === 'manual' ? ['RELATED-TO;RELTYPE=PARENT:bound@test'] : []),
        'END:VTODO', 'END:VCALENDAR'].join('\r\n'),
    })),
    updateCalendarObject: async () => { writes++; },
    deleteCalendarObject: async () => { writes++; },
    createCalendarObject: async () => { writes++; },
  };
  const rejected = await syncReminders({ createClient: async () => client });
  assert.equal(rejected.success, false);
  assert.equal(rejected.conflicts.length, 1);
  assert.equal(rejected.conflicts[0].external_uid, 'bound@test');
  assert.match(rejected.error, /preserved.*sync again/i);
  assert.match(rejected.conflicts[0].reason, /availability/i);
  assert.equal(rejected.syncedItems, 1, 'the ordinary reminder continues syncing');
  assert.equal(d.prepare('SELECT due_time FROM tasks WHERE id=?').get(manual).due_time, '10:00');
  assert.equal(d.prepare('SELECT due_time FROM tasks WHERE id=?').get(bound).due_time, '18:00');
  assert.equal(d.prepare('SELECT title FROM tasks WHERE id=?').get(bound).title, 'Test task');
  assert.equal(d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(manual).parent_task_id, bound, 'a rejected parent must not detach children');
  assert.equal(d.prepare('SELECT due_at FROM planning_obligations WHERE id=?').get(obligation.id).due_at, obligation.due_at);
  assert.equal(d.prepare('SELECT last_sync FROM caldav_accounts WHERE id=?').get(account).last_sync, null);
  assert.equal(writes, 0, 'the rejected remote change is never overwritten or deleted');

  remoteDue = '20260911T230000Z'; // Corrected to 19:00 in the household.
  const retried = await syncReminders({ createClient: async () => client });
  assert.equal(retried.success, true); assert.equal(retried.syncedItems, 2);
  assert.equal(d.prepare('SELECT due_time FROM tasks WHERE id=?').get(bound).due_time, '19:00');
  assert.equal(d.prepare('SELECT due_at FROM planning_obligations WHERE id=?').get(obligation.id).due_at, '2026-09-11T19:00:00');
  assert.equal(d.prepare('SELECT response_deadline FROM planning_obligations WHERE id=?').get(obligation.id).response_deadline, '2026-09-11T19:00:00');
  assert.equal(d.prepare('SELECT id FROM planning_obligations WHERE task_id=?').get(bound).id, obligation.id);
  assert.ok(d.prepare('SELECT last_sync FROM caldav_accounts WHERE id=?').get(account).last_sync);
  assert.equal(writes, 0);

  d.prepare("UPDATE planning_obligations SET response_deadline='2026-09-11T17:00:00' WHERE id=?").run(obligation.id);
  remoteDue = '20260912T000000Z'; // 20:00 on September 11 in the household.
  assert.equal((await syncReminders({ createClient: async () => client })).success, true);
  assert.deepEqual(d.prepare('SELECT due_at,response_deadline FROM planning_obligations WHERE id=?').get(obligation.id), {
    due_at: '2026-09-11T20:00:00', response_deadline: '2026-09-11T17:00:00',
  }, 'CalDAV rescheduling preserves a custom response deadline');
  assert.equal(writes, 0);
});
