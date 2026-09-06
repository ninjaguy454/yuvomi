import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'reader-mode-test-session-secret-32chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: readerRouter } = await import('../server/routes/reader.js');
function apply(database, migration) { if (typeof migration.up === 'function') migration.up(database); else database.exec(migration.up); if (migration.afterUp) migration.afterUp(database); }
const database = new Database(':memory:');
database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT '')");
for (const migration of ALL_MIGRATIONS) apply(database, migration);
_setTestDatabase(database);
const userId = Number(database.prepare("INSERT INTO users (username,display_name,password_hash,role,family_role) VALUES ('reader','Reader','x','member','parent')").run().lastInsertRowid);
database.prepare("INSERT INTO tasks (title,category,priority,status,created_by,is_recurring,assignment_mode,rotation_index,points,visibility,countdown,locked) VALUES ('Reader task','misc','none','open',?,0,'fixed',0,0,'all',0,0)").run(userId);
database.prepare("INSERT INTO meals (date,meal_type,title,scope,source,selection_status,created_by) VALUES ('2032-01-02','dinner','Reader meal','household','manual','selected',?)").run(userId);
database.prepare("INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,created_by,visibility) VALUES ('Reader event','2032-01-02T09:00:00','2032-01-02T10:00:00',0,?,'all')").run(userId);
const recipeId = Number(database.prepare("INSERT INTO recipes (title,notes,meal_types,created_by) VALUES ('Reader recipe','Mix and serve.','dinner',?)").run(userId).lastInsertRowid);
database.prepare("INSERT INTO recipe_ingredients (recipe_id,name,quantity,category) VALUES (?,'Beans','1 can','Other')").run(recipeId);

const sharedSession = { userId, role: 'member', csrfToken: 'a'.repeat(64) };
const app = express(); app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { req.session = sharedSession; next(); });
app.use('/reader', readerRouter);
const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => { server.close(); database.close(); });

test('Reader mode renders useful HTML without JavaScript', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=tasks`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Yuvomi Reader/);
  assert.match(html, /Reader task/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /reader\.css/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('Reader login, validation, verification and redirects never permit caching', async () => {
  const base = `http://127.0.0.1:${server.address().port}/reader`;
  delete sharedSession.userId;
  try {
    const login = await fetch(base);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /<h1>Sign in<\/h1>/);
    assert.equal(login.headers.get('cache-control'), 'private, no-store');

    const invalid = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'reader' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('cache-control'), 'private, no-store');

    sharedSession.readerPendingUserId = userId;
    sharedSession.readerPendingUntil = Date.now() + 60_000;
    const verification = await fetch(`${base}/two-factor`);
    assert.equal(verification.status, 200);
    assert.match(await verification.text(), /Verification code/);
    assert.equal(verification.headers.get('cache-control'), 'private, no-store');

    delete sharedSession.readerPendingUserId;
    const expired = await fetch(`${base}/two-factor`, { redirect: 'manual' });
    assert.equal(expired.status, 303);
    assert.equal(expired.headers.get('cache-control'), 'private, no-store');

    const denied = await fetch(`${base}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'Not authenticated' }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('cache-control'), 'private, no-store');
  } finally {
    sharedSession.userId = userId;
    delete sharedSession.readerPendingUserId;
    delete sharedSession.readerPendingUntil;
  }
});

test('Reader uses account colors and heading typography without scripts or dark e-paper inversion', async () => {
  const put = database.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)');
  put.run(`color_theme:user:${userId}`, 'warm');
  put.run(`heading_font:user:${userId}`, 'serif');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=tasks`);
    const html = await response.text();
    assert.match(html, /data-color-theme="warm"/);
    assert.match(html, /data-typography="serif"/);
    assert.match(html, /data-theme="light"/);
    assert.match(html, /\/styles\/tokens\.css/);
    assert.doesNotMatch(html, /<script/i);
    assert.match(response.headers.get('cache-control'), /no-store/);
  } finally {
    database.prepare("DELETE FROM sync_config WHERE key LIKE 'color_theme:user:%' OR key LIKE 'heading_font:user:%'").run();
  }
});

test('Reader applies module permissions to navigation, Today, and direct views', async () => {
  const setAccess = database.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', ?, 'none')
  `);
  for (const module of ['tasks', 'calendar', 'meals']) setAccess.run(String(userId), module);
  try {
    const today = await fetch(`http://127.0.0.1:${server.address().port}/reader?date=2032-01-02`);
    const html = await today.text();
    assert.equal(today.status, 200);
    assert.doesNotMatch(html, /Reader task|Reader event|Reader meal|view=tasks|view=add-task|view=calendar|view=meals|view=recipes/);
    for (const view of ['tasks', 'add-task', 'calendar', 'event', 'meals', 'recipes', 'recipe']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=${view}&id=${recipeId}&date=2032-01-02`);
      assert.equal(response.status, 403, view);
      assert.doesNotMatch(await response.text(), /Reader task|Reader event|Reader meal|Reader recipe/);
    }
  } finally {
    database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
  }
});

test('Reader read-only Tasks remain readable but cannot be created', async () => {
  database.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'tasks', 'read')
  `).run(String(userId));
  try {
    const tasks = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=tasks`);
    const html = await tasks.text();
    assert.equal(tasks.status, 200);
    assert.match(html, /Reader task/);
    assert.doesNotMatch(html, /view=add-task/);
    const form = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=add-task`);
    assert.equal(form.status, 403);
    const created = await fetch(`http://127.0.0.1:${server.address().port}/reader/tasks`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: sharedSession.csrfToken, title: 'Disallowed Reader task' }),
    });
    assert.equal(created.status, 403);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title = 'Disallowed Reader task'").get().count, 0);
  } finally {
    database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
  }
});

test('Reader preserves the existing administrator permission bypass', async () => {
  database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
  database.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES ('user', ?, 'module', 'tasks', 'none')
  `).run(String(userId));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=tasks`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Reader task/);
    assert.match(html, /view=add-task/);
  } finally {
    database.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(userId);
    database.prepare("DELETE FROM access_permissions WHERE subject_type = 'user' AND subject_id = ?").run(String(userId));
  }
});

test('Reader preserves the Shared-expense guest boundary for reads and creation', async () => {
  database.prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(userId);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reader?date=2032-01-02`);
    assert.equal(response.status, 403);
    const html = await response.text();
    assert.match(html, /only access Shared expenses/);
    assert.doesNotMatch(html, /Reader task|Reader event|Reader meal|view=add-task/);
    const created = await fetch(`http://127.0.0.1:${server.address().port}/reader/tasks`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: sharedSession.csrfToken, title: 'Guest Reader task' }),
    });
    assert.equal(created.status, 403);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title = 'Guest Reader task'").get().count, 0);
  } finally {
    database.prepare('DELETE FROM split_expense_guest_users WHERE user_id = ?').run(userId);
  }
});

test('Reader validation preserves the chosen priority and self-assignment state', async () => {
  for (const assignToMe of [false, true]) {
    const body = new URLSearchParams({ csrf: sharedSession.csrfToken, title: 'Keep my choices', due_date: '2032-02-30', priority: 'high' });
    if (assignToMe) body.set('assign_to_me', 'on');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reader/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(html, /<option value="high" selected>/);
    const checkbox = html.match(/<input[^>]*name="assign_to_me"[^>]*>/)?.[0];
    assert.ok(checkbox);
    assert.equal(/\bchecked\b/.test(checkbox), assignToMe);
    assert.match(html, /value="Keep my choices"/);
  }
});

test('Reader Calendar is navigable and events open into a detail view', async () => {
  const calendar = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=calendar&date=2032-01-02`);
  const calendarHtml = await calendar.text();
  assert.match(calendarHtml, /Previous month/);
  assert.match(calendarHtml, /Reader event/);
  assert.match(calendarHtml, /view=event/);
  const event = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=event&id=1&date=2032-01-02`);
  assert.match(await event.text(), /Reader event/);
});

test('Reader mode browses recipe details without JavaScript', async () => {
  const list = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=recipes`);
  assert.match(await list.text(), /Reader recipe/);
  const detail = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=recipe&id=${recipeId}`);
  const html = await detail.text();
  assert.match(html, /Beans/);
  assert.match(html, /Mix and serve/);
});

test('Reader mode can create a simple assigned Task with a server-rendered form', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/reader/tasks`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: sharedSession.csrfToken, title: 'Added on Kindle', due_date: '2032-01-03', due_time: '08:30', priority: 'medium', assign_to_me: 'on' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const task = database.prepare("SELECT * FROM tasks WHERE title = 'Added on Kindle'").get();
  assert.equal(task.assigned_to, userId);
  assert.equal(task.due_time, '08:30');
});

test('Reader Calendar hides private ICS subscriptions owned by another user', async () => {
  const ownerId = Number(database.prepare("INSERT INTO users (username,display_name,password_hash,role,family_role) VALUES ('reader-ics-owner','ICS Owner','x','member','parent')").run().lastInsertRowid);
  const privateSubId = Number(database.prepare("INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Reader private feed','https://reader.test/private.ics','#111111',0,?)").run(ownerId).lastInsertRowid);
  const sharedSubId = Number(database.prepare("INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Reader shared feed','https://reader.test/shared.ics','#222222',1,?)").run(ownerId).lastInsertRowid);
  const ownedSubId = Number(database.prepare("INSERT INTO ics_subscriptions (name,url,color,shared,created_by) VALUES ('Reader owned feed','https://reader.test/owned.ics','#333333',0,?)").run(userId).lastInsertRowid);
  const insertEvent = database.prepare("INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,created_by,visibility,external_source,subscription_id) VALUES (?,?,?,0,?,'all','ics',?)");
  const privateEventId = Number(insertEvent.run('Reader private ICS event', '2032-01-04T09:00:00', '2032-01-04T10:00:00', ownerId, privateSubId).lastInsertRowid);
  insertEvent.run('Reader shared ICS event', '2032-01-04T11:00:00', '2032-01-04T12:00:00', ownerId, sharedSubId);
  insertEvent.run('Reader owned ICS event', '2032-01-04T13:00:00', '2032-01-04T14:00:00', userId, ownedSubId);

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=calendar&date=2032-01-04`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /Reader private ICS event/);
    assert.match(html, /Reader shared ICS event/);
    assert.match(html, /Reader owned ICS event/);
    assert.match(html, /Reader event/, 'native local events remain visible');

    const detail = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=event&id=${privateEventId}&date=2032-01-04`);
    assert.match(await detail.text(), /Event not found for this date/);
  } finally {
    database.prepare('DELETE FROM calendar_events WHERE subscription_id IN (?, ?, ?)').run(privateSubId, sharedSubId, ownedSubId);
    database.prepare('DELETE FROM ics_subscriptions WHERE id IN (?, ?, ?)').run(privateSubId, sharedSubId, ownedSubId);
    database.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
  }
});

test('Reader rejects impossible Task dates without creating a row', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/reader/tasks`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: sharedSession.csrfToken, title: 'Impossible Reader date', due_date: '2032-02-30', due_time: '08:30', priority: 'medium' }),
  });
  const html = await response.text();
  assert.equal(response.status, 400);
  assert.match(html, /Check the title, date, and time/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title = 'Impossible Reader date'").get().count, 0);

  const calendar = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=calendar&date=2032-02-30`);
  assert.doesNotMatch(await calendar.text(), /2032-02-30/, 'an impossible navigation date falls back to the real household date');
});

test('Reader Calendar groups and formats zoned instants in the household timezone', async () => {
  const previousZone = database.prepare("SELECT value FROM sync_config WHERE key = 'household_timezone'").get()?.value ?? null;
  database.prepare("INSERT INTO sync_config (key,value) VALUES ('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const eventId = Number(database.prepare("INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,created_by,visibility) VALUES ('Reader zoned event','2032-01-03T01:30:00Z','2032-01-03T02:30:00Z',0,?,'all')").run(userId).lastInsertRowid);

  try {
    const calendar = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=calendar&date=2032-01-02`);
    const html = await calendar.text();
    assert.match(html, /Reader zoned event/);
    assert.match(html, /2032-01-02 20:30/);

    const detail = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=event&id=${eventId}&date=2032-01-02`);
    const detailHtml = await detail.text();
    assert.match(detailHtml, /2032-01-02 20:30/);
    assert.match(detailHtml, /2032-01-02 21:30/);

    const wrongDay = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=event&id=${eventId}&date=2032-01-03`);
    assert.match(await wrongDay.text(), /Event not found for this date/);
  } finally {
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
    if (previousZone === null) database.prepare("DELETE FROM sync_config WHERE key = 'household_timezone'").run();
    else database.prepare("UPDATE sync_config SET value = ? WHERE key = 'household_timezone'").run(previousZone);
  }
});

test('Reader month view includes a multi-day event on every overlapping day', async () => {
  const eventId = Number(database.prepare("INSERT INTO calendar_events (title,start_datetime,end_datetime,all_day,created_by,visibility) VALUES ('Reader multi-day event','2032-01-30T10:00:00','2032-02-02T10:00:00',0,?,'all')").run(userId).lastInsertRowid);

  try {
    const calendar = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=calendar&date=2032-02-01`);
    const html = await calendar.text();
    assert.ok((html.match(/Reader multi-day event/g) || []).length >= 3, 'event appears on February 1 and 2, plus the selected-day list');

    const detail = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=event&id=${eventId}&date=2032-02-01`);
    assert.match(await detail.text(), /Reader multi-day event/);

    const afterEnd = await fetch(`http://127.0.0.1:${server.address().port}/reader?view=event&id=${eventId}&date=2032-02-03`);
    assert.match(await afterEnd.text(), /Event not found for this date/);
  } finally {
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(eventId);
  }
});
