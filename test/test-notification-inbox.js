import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.SESSION_SECRET ??= 'notification-inbox-test-secret-long-enough';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const inbox = await import('../server/services/notification-inbox.js');
const events = await import('../server/services/notification-events.js');
const { buildInboxRouter } = await import('../server/routes/notification-inbox.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { recordTaskAssignment, claimTask } = await import('../server/services/assignment-responsibilities.js');
const { savePlanningContext } = await import('../server/services/planning-contexts.js');
const { effectiveSkillProficiency } = await import('../server/services/activity-eligibility.js');
const { advanceMealChooserFallback } = await import('../server/services/meal-plans.js');

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT)');
for (const migration of ALL_MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(database); else database.exec(migration.up);
  if (migration.afterUp) migration.afterUp(database);
}
_setTestDatabase(database);
const user = database.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES (?,?,'x','member','parent')");
const alice = Number(user.run('inbox-alice', 'Alice').lastInsertRowid);
const bob = Number(user.run('inbox-bob', 'Bob').lastInsertRowid);
const guest = Number(user.run('inbox-guest', 'Guest').lastInsertRowid);
database.prepare('INSERT INTO split_expense_guest_users(user_id) VALUES (?)').run(guest);
const task = (title, visibility = 'all') => Number(database.prepare(`INSERT INTO tasks(title,created_by,visibility)
  VALUES (?,?,?)`).run(title, alice, visibility).lastInsertRowid);
const notice = (userId, taskId, sourceKey = `test:${taskId}:${userId}`) => inbox.enqueueNotification(database, {
  userId, sourceKey, category: 'tasks', entityType: 'task', entityId: taskId, title: 'Assigned', body: 'Task details',
});
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = Number(req.headers['x-user'] || alice);
  req.authUserId = id; req.authRole = 'member';
  req.authMethod = req.headers['x-api-token'] ? 'api_token' : 'session';
  req.session = req.headers['x-no-session'] ? {} : { userId: id };
  next();
});
app.use('/notifications', buildInboxRouter({ database }));
app.use('/tasks', tasksRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.on('listening', resolve));
test.after(() => { server.close(); database.close(); });
async function request(path, { userId = alice, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-user': String(userId), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
test.beforeEach(() => {
  database.exec('DELETE FROM notification_inbox; DELETE FROM notification_preferences; DELETE FROM access_permissions;');
});

test('inbox source keys preserve read and dismiss state across devices', async () => {
  const id = task('Shared history');
  const first = notice(alice, id);
  assert.equal(notice(alice, id).id, first.id);
  assert.equal((await request('/notifications/inbox')).body.data.unreadCount, 1);
  const read = await request(`/notifications/inbox/${first.id}/read`, { method: 'PATCH' });
  assert.equal(read.status, 200);
  assert.equal(read.body.data.unreadCount, 0);
  const anotherDevice = await request(`/notifications/inbox/${first.id}`);
  assert.ok(anotherDevice.body.data.read_at);
  assert.equal(anotherDevice.headers.get('cache-control'), 'private, no-store');
  await request(`/notifications/inbox/${first.id}`, { method: 'DELETE' });
  assert.equal(notice(alice, id).id, first.id);
  assert.equal((await request('/notifications/inbox')).body.data.items.length, 0);
  assert.equal((await request(`/notifications/inbox/${first.id}`)).status, 404);
});

test('another member cannot read, mark or dismiss personal receipts', async () => {
  const row = notice(alice, task('Owned receipt'));
  for (const [method, suffix] of [['GET', ''], ['PATCH', '/read'], ['DELETE', '']]) {
    assert.equal((await request(`/notifications/inbox/${row.id}${suffix}`, { method, userId: bob })).status, 404);
  }
  assert.equal(database.prepare('SELECT read_at FROM notification_inbox WHERE id = ?').get(row.id).read_at, null);
  assert.equal((await request('/notifications/inbox', { userId: guest })).status, 403);
  assert.equal((await request('/notifications/inbox', { headers: { 'x-no-session': 'yes' } })).status, 401);
});

test('API token authentication cannot borrow a concurrent browser session for inbox or preferences', async () => {
  const row = notice(alice, task('Session-owned notification'));
  for (const [method, path, body] of [
    ['GET', '/inbox'], ['GET', `/inbox/${row.id}`], ['PATCH', `/inbox/${row.id}/read`],
    ['DELETE', `/inbox/${row.id}`], ['POST', '/inbox/read-all'],
    ['GET', '/preferences'], ['PATCH', '/preferences', { tasks: false }],
  ]) {
    assert.equal((await request(`/notifications${path}`, { method, body, headers: { 'x-api-token': 'yes' } })).status, 401);
  }
  assert.equal(inbox.listNotificationInbox(database, alice).unreadCount, 1);
  assert.equal(inbox.getNotificationPreferences(database, alice).tasks, true);
});

test('current module and item privacy protect insertion, list, unread count and outbound access', async () => {
  const id = task('Private owner', 'private');
  assert.equal(notice(bob, id), null);
  const row = notice(alice, id);
  database.prepare("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES ('user',?,'module','tasks','none')").run(String(alice));
  assert.equal(inbox.canReceiveNotification(database, row), false);
  assert.deepEqual((await request('/notifications/inbox')).body.data, { items: [], unreadCount: 0 });
  assert.equal((await request(`/notifications/inbox/${row.id}/read`, { method: 'PATCH' })).status, 404);
  await request('/notifications/inbox/read-all', { method: 'POST' });
  assert.equal(database.prepare('SELECT read_at FROM notification_inbox WHERE id = ?').get(row.id).read_at, null);
  database.exec('DELETE FROM access_permissions');
  database.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  assert.equal(inbox.canReceiveNotification(database, row), false);
  assert.equal((await request('/notifications/inbox')).body.data.unreadCount, 0);
});

test('lost assignee access and private ICS subscriptions cannot expose saved titles', () => {
  const id = task('Assignees only', 'assignees');
  database.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES (?,?)').run(id, bob);
  const row = notice(bob, id);
  database.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(id);
  assert.equal(inbox.canReceiveNotification(database, row), false);
  const subscription = Number(database.prepare(`INSERT INTO ics_subscriptions(name,url,created_by,shared)
    VALUES ('Personal','https://example.test/personal.ics',?,0)`).run(alice).lastInsertRowid);
  const event = Number(database.prepare(`INSERT INTO calendar_events(title,start_datetime,created_by,visibility,external_source,subscription_id)
    VALUES ('Personal calendar','2032-01-01T09:00',?,'all','ics',?)`).run(alice, subscription).lastInsertRowid);
  const candidate = { userId: bob, sourceKey: 'ics-private', category: 'calendar', entityType: 'event', entityId: event, title: 'Calendar event' };
  assert.equal(inbox.enqueueNotification(database, candidate), null);
  assert.ok(inbox.enqueueNotification(database, { ...candidate, userId: alice }));
});

test('subtask deep links use a parent only when the recipient can see it', () => {
  const parentId = task('Private parent', 'private');
  const childId = task('Visible child');
  database.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?').run(parentId, childId);
  assert.equal(notice(bob, childId).url, `/tasks?open=${childId}`);
  assert.equal(notice(alice, childId).url, `/tasks?open=${parentId}&section=subtasks`);
});

test('category preferences are sparse, reversible, personal, and reject an invalid batch atomically', async () => {
  const saved = await request('/notifications/preferences', { method: 'PATCH', body: { tasks: false } });
  assert.equal(saved.body.data.tasks, false);
  assert.equal(saved.body.data.meals, true);
  assert.equal((await request('/notifications/preferences', { userId: bob })).body.data.tasks, true);
  assert.equal(notice(alice, task('Muted')), null);
  assert.equal((await request('/notifications/preferences', { method: 'PATCH', body: { tasks: true, meals: 'false' } })).status, 400);
  assert.equal(inbox.getNotificationPreferences(database, alice).tasks, false);
  await request('/notifications/preferences', { method: 'PATCH', body: { tasks: true } });
  assert.ok(notice(alice, task('Unmuted')));
});

test('read-all is per user, leaves domain obligations alone, and history details are individually reachable', async () => {
  const id = task('History');
  const first = notice(alice, id, 'old');
  for (let index = 0; index < 55; index += 1) notice(alice, id, `history:${index}`);
  notice(bob, id);
  assert.equal((await request('/notifications/inbox')).body.data.items.length, 50);
  assert.equal((await request(`/notifications/inbox/${first.id}`)).status, 200);
  const result = await request('/notifications/inbox/read-all', { method: 'POST' });
  assert.equal(result.body.data.unreadCount, 0);
  assert.equal((await request('/notifications/inbox', { userId: bob })).body.data.unreadCount, 1);
  assert.equal(database.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'open');
});

test('ordinary task creation and effective reassignment notify once; identical saves do not', async () => {
  const created = await request('/tasks', { method: 'POST', body: { title: 'Actual assignment', assigned_to: [bob] } });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(inbox.listNotificationInbox(database, bob).unreadCount, 1);
  const revision=()=>({expected_revision:database.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision});
  assert.equal((await request(`/tasks/${id}`, { method: 'PUT', body: { title: 'Same assignment', assigned_to: [bob], ...revision() } })).status, 200);
  assert.equal(inbox.listNotificationInbox(database, bob).unreadCount, 1);
  assert.equal((await request(`/tasks/${id}`, { method: 'PUT', body: { assigned_to: [alice], ...revision() } })).status,200);
  assert.equal(inbox.listNotificationInbox(database, alice).unreadCount, 1);
  assert.equal((await request(`/tasks/${id}`, { method: 'PUT', body: { assigned_to: [bob], ...revision() } })).status,200);
  assert.equal(inbox.listNotificationInbox(database, bob).unreadCount, 2);
  const receipts = database.prepare('SELECT * FROM notification_inbox WHERE user_id = ? ORDER BY id').all(bob);
  assert.equal(events.isNotificationDeliveryCurrent(database, receipts[0]), false,
    'a rapid reassignment back retains history without sending the outdated assignment too');
  assert.equal(events.isNotificationDeliveryCurrent(database, receipts[1]), true);
  inbox.markNotificationRead(database, bob, receipts[1].id, { dismiss: true });
  assert.equal(events.isNotificationDeliveryCurrent(database, receipts[0]), false,
    'dismissing the latest assignment must not resurrect its superseded delivery');
});

test('comment mentions persist once and use the same inbox delivery path as assignments', async () => {
  const id = task('Mention target');
  const created = await request(`/tasks/${id}/comments`, { method: 'POST', body: { comment: '@Bob please review.' } });
  assert.equal(created.status, 201);
  let rows = inbox.listNotificationInbox(database, bob).items;
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Alice: @Bob/);
  assert.equal((await request(`/tasks/${id}/comments/${created.body.data.id}`, { method: 'PATCH', body: { comment: '@Bob please review this.',expected_revision:database.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision } })).status,200);
  rows = inbox.listNotificationInbox(database, bob).items;
  assert.equal(rows.length, 1);
  assert.equal(database.prepare('SELECT delivery_scope FROM notification_inbox WHERE id = ?').get(rows[0].id).delivery_scope, 'user');
});

test('managed primary and participant roles collapse, open claims notify eligible people and claim outcome once', () => {
  const id = task('Managed task');
  const activity = { id: 123, allow_assignment_override: 1 };
  const member = { id: bob };
  recordTaskAssignment(database, id, activity, { primary: member, participants: [member], eligible: [member], strategy: 'fixed' });
  assert.equal(inbox.listNotificationInbox(database, bob).unreadCount, 1);
  events.notifyTaskObligations(database, id);
  assert.equal(inbox.listNotificationInbox(database, bob).unreadCount, 1);
  const receipt = database.prepare('SELECT * FROM notification_inbox WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(bob);
  assert.equal(events.isNotificationDeliveryCurrent(database, receipt), true);
  database.prepare("UPDATE planning_obligations SET status = 'accepted' WHERE task_id = ?").run(id);
  assert.equal(events.isNotificationDeliveryCurrent(database, receipt), false);
  assert.equal(inbox.listNotificationInbox(database, bob).unreadCount, 1, 'answering a request preserves its history');
  database.prepare('DELETE FROM notification_inbox WHERE id = ?').run(receipt.id);
  events.notifyTaskObligations(database, id);
  assert.equal(inbox.listNotificationInbox(database, bob).unreadCount, 0, 'accepted assignments cannot become new response requests');
  const claimId = task('Claimable task');
  recordTaskAssignment(database, claimId, activity, { primary: null, participants: [], eligible: [member], strategy: 'open_claimable' }, { source: 'meal_execution' });
  database.prepare("INSERT INTO task_claim_eligibility(task_id,user_id,source) VALUES (?,?,'meal_execution')").run(claimId, bob);
  claimTask(database, claimId, bob);
  assert.equal(inbox.listNotificationInbox(database, alice).items.filter((row) => row.title === 'Task claimed').length, 1);
  assert.throws(() => claimTask(database, claimId, bob), /already been claimed/);
});

test('meal choice requests use obligation identity without changing the request', () => {
  const mealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,created_by) VALUES ('2032-01-01','dinner','Dinner',?)`).run(alice).lastInsertRowid);
  database.prepare(`INSERT INTO planning_obligations(entity_type,entity_id,logical_key,role,responsible_user_id)
    VALUES ('meal',?,'inbox-meal-request','chooser',?)`).run(mealId, bob);
  events.notifyMealRequests(database, mealId);
  events.notifyMealRequests(database, mealId);
  const rows = inbox.listNotificationInbox(database, bob).items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'meals');
  assert.match(rows[0].url, new RegExp(`/meals\\?open=${mealId}&date=2032-01-01&context=home`));
  inbox.markAllNotificationsRead(database, bob);
  assert.equal(database.prepare("SELECT status FROM planning_obligations WHERE logical_key='inbox-meal-request'").get().status, 'pending');
});

test('planning context no-op saves do not duplicate notifications and only members receive them', () => {
  const body = { context_key: 'inbox-trip', name: 'Travel plans', context_type: 'custom', starts_at: '2032-01-01', ends_at: '2032-01-03', member_ids: [bob] };
  const context = savePlanningContext(database, body, alice);
  assert.equal(inbox.listNotificationInbox(database, bob).items.length, 1);
  savePlanningContext(database, body, alice, context.id);
  assert.equal(inbox.listNotificationInbox(database, bob).items.length, 1);
  assert.equal(inbox.listNotificationInbox(database, alice).items.length, 0);
  savePlanningContext(database, { ...body, name: 'Changed travel plans' }, alice, context.id);
  assert.equal(inbox.listNotificationInbox(database, bob).items.length, 2);
});

test('terminal personal-choice fallback notifies each newly responsible diner once', () => {
  const mealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,created_by)
    VALUES ('2032-01-02','dinner','Fallback dinner',?)`).run(alice).lastInsertRowid);
  for (const id of [alice, bob]) database.prepare(`INSERT INTO meal_participants(meal_id,user_id,role,status)
    VALUES (?,?,'participant','participating')`).run(mealId, id);
  const obligationId = Number(database.prepare(`INSERT INTO planning_obligations
    (entity_type,entity_id,logical_key,role,responsible_user_id,status,metadata_json)
    VALUES ('meal',?,'personal-fallback','chooser',?,'declined',?)`)
    .run(mealId, alice, JSON.stringify({ policy: 'fixed', chooser_terminal_strategy: 'personal_choice' })).lastInsertRowid);
  const result = advanceMealChooserFallback(database, mealId, { sourceObligationId: obligationId, actorId: alice, reason: 'declined' });
  assert.equal(result.policy, 'personal_choice');
  assert.equal(result.replacement_obligation_ids.length, 2);
  for (const id of [alice, bob]) {
    const receipts = inbox.listNotificationInbox(database, id).items;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].title, 'Meal choice requested');
  }
  assert.equal(advanceMealChooserFallback(database, mealId).changed, false);
  assert.equal(inbox.listNotificationInbox(database, bob).items.length, 1);
});

test('transaction rollback leaves neither a task nor an orphaned inbox receipt', () => {
  assert.throws(() => database.transaction(() => {
    const id = task('Rolled back task');
    notice(alice, id);
    throw new Error('rollback');
  })(), /rollback/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title='Rolled back task'").get().count, 0);
  assert.equal(inbox.listNotificationInbox(database, alice).items.length, 0);
});

test('built-in meal skills keep age-unknown children excluded until explicitly qualified', () => {
  const child = { id: bob, family_role: 'child', birth_date: null };
  for (const key of ['meal_choosing', 'serving', 'cleanup']) {
    const skill = database.prepare('SELECT * FROM skills WHERE system_key = ?').get(key);
    const automatic = effectiveSkillProficiency(database, skill, child, '2032-01-01');
    assert.equal(automatic.proficiency, 'excluded');
    assert.equal(automatic.reason, 'age_unknown');
    database.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
      VALUES (?,?,'normal','manual',?)`).run(bob, skill.id, alice);
    assert.equal(effectiveSkillProficiency(database, skill, child, '2032-01-01').proficiency, 'normal');
    database.prepare('DELETE FROM user_skill_proficiency WHERE user_id = ? AND skill_id = ?').run(bob, skill.id);
  }
});
