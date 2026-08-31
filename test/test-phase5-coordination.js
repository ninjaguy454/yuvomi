import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'phase-five-coordination-secret-32chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: planningRouter } = await import('../server/routes/planning.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
for (const migration of ALL_MIGRATIONS) {
  apply(database, migration);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(migration.version, migration.description);
}
_setTestDatabase(database);
const admin = Number(database.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('p5coord','Alex','x','admin','parent')").run().lastInsertRowid);
const sam = Number(database.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('p5sam','Sam','x','member','parent')").run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin; req.authRole = 'admin'; req.session = { userId: admin, role: 'admin' }; next();
});
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/planning', planningRouter);
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => { server.close(); database.close(); });

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

test('Phase 5 coordination migration is additive and durable', () => {
  assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE version = 10010').get());
  for (const table of ['meal_calendar_conflicts', 'trip_plans', 'trip_participants', 'trip_stages', 'trip_tasks']) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
});

test('meal conflicts are per participant, preserve cosmetic resolutions, and reopen on material change', async () => {
  const meal = await call('POST', '/meals', {
    date: '2031-06-02', meal_type: 'dinner', title: 'Family dinner',
    earliest_time: '18:00', preferred_time: '18:30', latest_time: '20:00', expected_duration_minutes: 60,
    participants: [{ user_id: sam, role: 'participant', status: 'participating' }],
  });
  assert.equal(meal.status, 201, JSON.stringify(meal.body));
  const eventId = Number(database.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, assigned_to, created_by, external_source, visibility)
    VALUES ('Practice', '2031-06-02T18:15:00', '2031-06-02T19:15:00', 0, ?, ?, 'local', 'all')
  `).run(sam, admin).lastInsertRowid);

  const detected = await call('GET', '/meals/conflicts?week=2031-06-02');
  assert.equal(detected.status, 200, JSON.stringify(detected.body));
  assert.equal(detected.body.data.length, 1);
  assert.equal(detected.body.data[0].user_id, sam);
  assert.equal(detected.body.data[0].detection_state, 'open');

  const conflictId = detected.body.data[0].id;
  const resolved = await call('POST', `/meals/conflicts/${conflictId}/resolve`, { resolution: 'keep_window', payload: {} });
  assert.equal(resolved.body.data.detection_state, 'resolved');
  database.prepare("UPDATE calendar_events SET title = 'Renamed practice', description = 'Cosmetic only' WHERE id = ?").run(eventId);
  const cosmetic = await call('GET', '/meals/conflicts?week=2031-06-02');
  assert.equal(cosmetic.body.data.find((row) => row.id === conflictId).detection_state, 'resolved');

  database.prepare("UPDATE calendar_events SET start_datetime = '2031-06-02T18:45:00', end_datetime = '2031-06-02T19:45:00' WHERE id = ?").run(eventId);
  const material = await call('GET', '/meals/conflicts?week=2031-06-02');
  const reopened = material.body.data.find((row) => row.id === conflictId);
  assert.equal(reopened.detection_state, 'reopened');
  assert.equal(reopened.resolution, null);

  database.prepare("UPDATE meal_participants SET status = 'not_participating' WHERE meal_id = ? AND user_id = ? AND role = 'participant'").run(meal.body.data.id, sam);
  const noLongerParticipating = await call('GET', '/meals/conflicts?week=2031-06-02');
  assert.equal(noLongerParticipating.body.data.find((row) => row.id === conflictId).detection_state, 'superseded');
});

test('trip planning creates stages, traveler Away periods, linked Tasks, Calendar context and itinerary', async () => {
  const destination = await call('POST', '/planning/admin/places', { name: 'Beach Hotel', type: 'hotel', latitude: 36.85, longitude: -75.98 });
  const trip = await call('POST', '/planning/admin/trips', {
    name: 'Beach week', trip_type: 'vacation', status: 'planning',
    participant_ids: [admin, sam], destination_place_id: destination.body.data.id,
    starts_at: '2031-07-10T09:00', ends_at: '2031-07-14T18:00', create_away_periods: true,
    tasks: [{ phase: 'before_departure', title: 'Pack medications' }, { phase: 'during_trip', title: 'Review itinerary' }, { phase: 'post_trip', title: 'Start travel laundry' }],
  });
  assert.equal(trip.status, 201, JSON.stringify(trip.body));
  assert.equal(trip.body.data.participants.length, 2);
  assert.equal(trip.body.data.stages.length, 6);
  assert.equal(trip.body.data.tasks.length, 3);
  assert.ok(trip.body.data.tasks.every((task) => Number(task.assigned_to) === admin),
    'generic Trip Tasks keep the legacy first-traveler default');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n
      FROM task_assignments ta
      JOIN trip_tasks tt ON tt.task_id = ta.task_id
     WHERE tt.trip_id = ? AND ta.user_id = ?
  `).get(trip.body.data.id, admin).n, 3);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM availability_periods WHERE category = 'travel' AND state = 'away'").get().n, 2);
  const located = database.prepare('SELECT COUNT(*) AS n FROM task_locations tl JOIN trip_tasks tt ON tt.task_id = tl.task_id WHERE tt.trip_id = ?').get(trip.body.data.id).n;
  assert.ok(located >= 1);

  const context = await call('GET', '/planning/calendar-context?from=2031-07-09&to=2031-07-15');
  assert.equal(context.status, 200, JSON.stringify(context.body));
  assert.ok(context.body.data.some((entry) => entry.plan_kind === 'trip_stage' && entry.plan_id === trip.body.data.id));
  const itinerary = await call('GET', `/planning/trips/${trip.body.data.id}/itinerary`);
  assert.equal(itinerary.status, 200, JSON.stringify(itinerary.body));
  assert.ok(Object.keys(itinerary.body.data.days).length >= 2);

  const removed = await call('DELETE', `/planning/admin/trips/${trip.body.data.id}`);
  assert.equal(removed.status, 204);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM availability_periods WHERE note = 'Trip: Beach week'").get().n, 0);
});

test('one-use Google Task locations promote atomically to stable Yuvomi Places', async () => {
  const task = await call('POST', '/tasks', {
    title: 'Drop off parcel', location: { kind: 'google_place', external_provider: 'google', external_place_id: 'ChIJ-promotion', user_label: 'Parcel store' },
  });
  const promoted = await call('POST', `/tasks/${task.body.data.id}/location/promote`, { name: 'Our parcel store', type: 'custom' });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.data.location.kind, 'saved_place');
  const renamed = await call('PUT', `/planning/admin/places/${promoted.body.data.place_id}`, { name: 'Renamed parcel store' });
  assert.equal(renamed.status, 200);
  const detail = await call('GET', `/tasks/${task.body.data.id}`);
  assert.equal(detail.body.data.location.label, 'Renamed parcel store');
});
