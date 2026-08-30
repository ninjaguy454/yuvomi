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
