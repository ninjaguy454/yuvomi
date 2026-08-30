/**
 * Test: Erinnerungen an geteilten Terminen (Discussion #921)
 *
 * Gemeldet war: eine Frau legt einen Termin an, weist ihn beiden zu und setzt
 * eine Erinnerung. Sie bekommt sie, ihr Mann bekommt nichts, und wenn er
 * denselben Termin oeffnet, steht das Feld LEER da. Der Termin wurde verpasst.
 *
 * Geprueft wird deshalb nicht nur, DASS verteilt wird, sondern vor allem, was
 * dabei NICHT passieren darf:
 *  - eine selbst gesetzte Erinnerung wird nie ueberschrieben
 *  - eine verworfene kommt nicht wieder
 *  - wer nicht mehr zugewiesen ist, behaelt keine geerbte Meldung
 *  - wer NICHT der Ersteller ist, verteilt beim Setzen gar nichts
 *
 * Ausfuehren: node --experimental-sqlite --test test/test-event-reminder-fanout.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { setEventAssignments } = await import('../server/routes/calendar/helpers.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const database = dbmod.get();

const mkUser = (name) => database
  .prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, 'x', 'member')")
  .run(name, name).lastInsertRowid;

const ANNA = mkUser('anna');   // legt Termine an
const BEN  = mkUser('ben');    // wird zugewiesen
const CLEO = mkUser('cleo');   // ebenfalls

let actingUser = ANNA;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actingUser;
  req.authRole   = 'member';
  req.session    = { userId: actingUser, role: 'member' };
  next();
});
app.use('/', remindersRouter);
const server  = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

/** Ein Termin von ANNA, zugewiesen an die genannten Personen. */
function newEvent(assignees = []) {
  const id = database.prepare(`
    INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by, visibility)
    VALUES ('Zahnarzt', '2026-09-01T10:00:00', '2026-09-01T11:00:00', ?, 'all')
  `).run(ANNA).lastInsertRowid;
  if (assignees.length) setEventAssignments(database, id, assignees);
  return id;
}

const remindersOf = (eventId, userId) => database.prepare(`
  SELECT remind_at, assigned_from, dismissed FROM reminders
  WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  ORDER BY remind_at ASC
`).all(eventId, userId);

const setReminders = (eventId, remindAts) =>
  call('PUT', `/?entity_type=event&entity_id=${eventId}`, { remind_ats: remindAts });

// --------------------------------------------------------------------------
// Der gemeldete Fall
// --------------------------------------------------------------------------

test('die Erinnerung der Erstellerin erreicht die Zugewiesenen', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  assert.equal(remindersOf(id, ANNA).length, 1, 'die Erstellerin behaelt ihre eigene');
  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1, 'der Zugewiesene bekommt eine - genau das fehlte');
  assert.equal(bens[0].remind_at, '2026-08-31T10:00:00');
  assert.equal(bens[0].assigned_from, ANNA, 'sie ist als geerbt gekennzeichnet');
});

test('der Zugewiesene SIEHT sie auch - das leere Feld war der halbe Schaden', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  actingUser = BEN;
  const r = await call('GET', `/all?entity_type=event&entity_id=${id}`);
  actingUser = ANNA;
  assert.equal(r.body.data.length, 1,
    'GET /all filtert auf created_by - ohne eigene Zeile blieb das Feld leer und las sich als "keine gesetzt"');
});

test('mehrere Zugewiesene bekommen alle Zeitpunkte', async () => {
  const id = newEvent([ANNA, BEN, CLEO]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00', '2026-09-01T09:00:00']);

  assert.equal(remindersOf(id, BEN).length, 2);
  assert.equal(remindersOf(id, CLEO).length, 2);
});

// --------------------------------------------------------------------------
// Was NICHT passieren darf
// --------------------------------------------------------------------------

test('eine selbst gesetzte Erinnerung wird nicht ueberschrieben', async () => {
  const id = newEvent([ANNA, BEN]);
  // Ben stellt sich seine eigene - er faehrt weiter und braucht mehr Vorlauf.
  actingUser = BEN;
  await setReminders(id, ['2026-08-30T06:00:00']);

  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1, 'seine bleibt die einzige');
  assert.equal(bens[0].remind_at, '2026-08-30T06:00:00', 'und behaelt seine Uhrzeit');
  assert.equal(bens[0].assigned_from, null, 'sie ist seine, nicht geerbt');
});

test('ein persoenlicher POST ersetzt die geerbte Erinnerung vollstaendig', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, BEN).length, 1, 'Ben beginnt mit der geerbten Erinnerung');

  actingUser = BEN;
  const created = await call('POST', '/', {
    entity_type: 'event',
    entity_id: id,
    remind_at: '2026-08-30T06:00:00',
  });
  assert.equal(created.status, 201);

  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T08:00:00']);
  assert.deepEqual(remindersOf(id, BEN).map((row) => ({
    remind_at: row.remind_at,
    assigned_from: row.assigned_from,
  })), [{ remind_at: '2026-08-30T06:00:00', assigned_from: null }]);
});

test('fan-out heilt gemischte Alt-Daten zugunsten der persoenlichen Erinnerung', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES ('event', ?, '2026-08-30T06:00:00', ?, NULL)
  `).run(id, BEN);
  assert.equal(remindersOf(id, BEN).length, 2, 'die Sonde stellt den gemischten Alt-Zustand her');

  await setReminders(id, ['2026-08-31T08:00:00']);
  assert.deepEqual(remindersOf(id, BEN).map((row) => ({
    remind_at: row.remind_at,
    assigned_from: row.assigned_from,
  })), [{ remind_at: '2026-08-30T06:00:00', assigned_from: null }],
  'die persoenliche Entscheidung bleibt, die alte geerbte Zeile wird entfernt');
});

test('eine verworfene Erinnerung kommt nicht zurueck', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);

  // Ben hat sie gesehen und weggewischt.
  const bensId = database.prepare(
    "SELECT id FROM reminders WHERE entity_type='event' AND entity_id=? AND created_by=?"
  ).get(id, BEN).id;
  database.prepare('UPDATE reminders SET dismissed = 1 WHERE id = ?').run(bensId);

  // Anna speichert den Termin erneut mit derselben Erinnerung.
  await setReminders(id, ['2026-08-31T10:00:00']);

  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1, 'keine zweite Meldung fuer dasselbe');
  assert.equal(bens[0].dismissed, 1, 'die verworfene bleibt verworfen');
});

test('eine unveraenderte geerbte Uhrzeit behaelt Zustellstatus, wenn eine andere hinzukommt oder wegfaellt', async () => {
  const id = newEvent([ANNA, BEN]);
  const keptAt    = '2026-08-31T10:00:00';
  const removedAt = '2026-08-31T12:00:00';
  const addedAt   = '2026-08-31T14:00:00';
  actingUser = ANNA;
  assert.equal((await setReminders(id, [keptAt, removedAt])).status, 200);

  const before = database.prepare(`
    SELECT id, remind_at, assigned_from FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND remind_at = ?
  `).get(id, BEN, keptAt);
  database.prepare(`
    UPDATE reminders SET dismissed = 1, pushed_at = '2026-08-30T18:00:00Z'
    WHERE id = ?
  `).run(before.id);

  assert.equal((await setReminders(id, [keptAt, addedAt])).status, 200);
  const after = database.prepare(`
    SELECT id, remind_at, assigned_from, dismissed, pushed_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
    ORDER BY remind_at
  `).all(id, BEN);

  assert.deepEqual(after, [
    {
      id: before.id,
      remind_at: keptAt,
      assigned_from: ANNA,
      dismissed: 1,
      pushed_at: '2026-08-30T18:00:00Z',
    },
    {
      id: after[1].id,
      remind_at: addedAt,
      assigned_from: ANNA,
      dismissed: 0,
      pushed_at: null,
    },
  ], 'the unchanged row is retained; only the removed and added timestamps change');
});

test('fan-out failure rolls back the author and every assignee, then a retry converges', async () => {
  const id = newEvent([ANNA, BEN, CLEO]);
  const originalAt = '2026-08-31T10:00:00';
  const addedAt    = '2026-08-31T14:00:00';
  actingUser = ANNA;
  assert.equal((await setReminders(id, [originalAt])).status, 200);

  const rows = () => database.prepare(`
    SELECT id, remind_at, created_by, assigned_from, dismissed, pushed_at
    FROM reminders WHERE entity_type = 'event' AND entity_id = ?
    ORDER BY created_by, remind_at, id
  `).all(id);
  const before = rows();

  database.exec(`
    CREATE TRIGGER test_fail_event_reminder_fanout
    BEFORE INSERT ON reminders
    WHEN NEW.entity_type = 'event'
      AND NEW.entity_id = ${Number(id)}
      AND NEW.created_by = ${Number(CLEO)}
      AND NEW.assigned_from = ${Number(ANNA)}
      AND NEW.remind_at = '${addedAt}'
    BEGIN
      SELECT RAISE(ABORT, 'forced event reminder fan-out failure');
    END;
  `);

  try {
    const failed = await setReminders(id, [originalAt, addedAt]);
    assert.equal(failed.status, 500, 'the route reports a failed atomic write');
    assert.deepEqual(rows(), before,
      'the author replacement and any earlier assignee writes are rolled back together');
  } finally {
    database.exec('DROP TRIGGER IF EXISTS test_fail_event_reminder_fanout');
  }

  const retry = await setReminders(id, [originalAt, addedAt]);
  assert.equal(retry.status, 200);
  for (const userId of [ANNA, BEN, CLEO]) {
    assert.deepEqual(remindersOf(id, userId).map((row) => row.remind_at), [originalAt, addedAt],
      `retry converges the complete set for user ${userId}`);
  }
});

test('eine GEAENDERTE Uhrzeit erreicht ihn auch nach dem Verwerfen', async () => {
  // Die Gegenprobe zum Test darueber: verworfen heisst "diese Meldung habe ich
  // gesehen", nicht "fuer diesen Termin will ich nichts mehr wissen". Eine
  // andere Uhrzeit ist eine andere Auskunft.
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  database.prepare(`
    UPDATE reminders SET dismissed = 1
    WHERE entity_type='event' AND entity_id=? AND created_by=?
  `).run(id, BEN);

  await setReminders(id, ['2026-08-31T08:00:00']);

  const bens = remindersOf(id, BEN);
  assert.equal(bens.length, 1);
  assert.equal(bens[0].remind_at, '2026-08-31T08:00:00', 'die neue Zeit kommt an');
  assert.equal(bens[0].dismissed, 0, 'und zwar als frische, ungesehene Meldung');
});

test('wer NICHT der Ersteller ist, verteilt beim Setzen nichts', async () => {
  const id = newEvent([ANNA, BEN, CLEO]);
  // Ben setzt sich einen Merker. Das ist seine Sache und geht Cleo nichts an -
  // sonst bekaeme der halbe Haushalt eine Meldung, weil ein Einzelner sich
  // etwas notiert hat.
  actingUser = BEN;
  await setReminders(id, ['2026-08-31T10:00:00']);
  actingUser = ANNA;

  assert.equal(remindersOf(id, CLEO).length, 0);
  assert.equal(remindersOf(id, ANNA).length, 0);
});

test('loescht die Erstellerin ihre Erinnerung, verschwinden die geerbten mit', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, BEN).length, 1);

  await setReminders(id, []);
  assert.equal(remindersOf(id, BEN).length, 0,
    'eine Meldung stehen zu lassen, die die Erstellerin gerade abgeschafft hat, waere eine Zusage ohne Deckung');
});

test('eine selbst gesetzte ueberlebt das Loeschen durch die Erstellerin', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = BEN;
  await setReminders(id, ['2026-08-30T06:00:00']);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  await setReminders(id, []);

  assert.equal(remindersOf(id, BEN).length, 1, 'Bens eigene geht Anna nichts an');
});

// --------------------------------------------------------------------------
// Die andere Richtung: die Zuweisung aendert sich
// --------------------------------------------------------------------------

test('wer nachtraeglich zugewiesen wird, bekommt die Erinnerung mit', async () => {
  const id = newEvent([ANNA]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, BEN).length, 0, 'noch nicht zugewiesen, also nichts');

  setEventAssignments(database, id, [ANNA, BEN]);
  assert.equal(remindersOf(id, BEN).length, 1,
    'eine Zuweisung, die die Erinnerung nicht mitbringt, aeussert sich als verpasster Termin');
});

test('wer nicht mehr zugewiesen ist, behaelt keine geerbte Meldung', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, BEN).length, 1);

  setEventAssignments(database, id, [ANNA]);
  assert.equal(remindersOf(id, BEN).length, 0,
    'eine Erinnerung an einen Termin, mit dem man nichts mehr zu tun hat, ist eine Meldung ohne Anlass');
});

test('eine selbst gesetzte ueberlebt auch das Entfernen der Zuweisung', async () => {
  const id = newEvent([ANNA, BEN]);
  actingUser = BEN;
  await setReminders(id, ['2026-08-30T06:00:00']);
  actingUser = ANNA;

  setEventAssignments(database, id, [ANNA]);
  assert.equal(remindersOf(id, BEN).length, 1,
    'wer sich selbst eine gestellt hat, hat einen eigenen Grund - den kennt der Termin nicht');
});

test('ein Termin ohne weitere Zugewiesene aendert nichts', async () => {
  const id = newEvent([ANNA]);
  actingUser = ANNA;
  await setReminders(id, ['2026-08-31T10:00:00']);
  assert.equal(remindersOf(id, ANNA).length, 1);
  assert.equal(
    database.prepare("SELECT COUNT(*) n FROM reminders WHERE entity_type='event' AND entity_id=?").get(id).n,
    1, 'genau eine Zeile - kein Fanout ins Leere');
});

// --------------------------------------------------------------------------
// Die Herkunft anderer Module bleibt unberuehrt
// --------------------------------------------------------------------------

test('Aufgaben-Erinnerungen werden nicht verteilt', async () => {
  const taskId = database
    .prepare("INSERT INTO tasks (title, created_by, visibility) VALUES ('T', ?, 'all')")
    .run(ANNA).lastInsertRowid;
  actingUser = ANNA;
  await call('PUT', `/?entity_type=task&entity_id=${taskId}`, { remind_ats: ['2026-08-31T10:00:00'] });

  const all = database.prepare(
    "SELECT created_by FROM reminders WHERE entity_type='task' AND entity_id=?"
  ).all(taskId);
  assert.equal(all.length, 1, 'die Regel gilt Terminen - Aufgaben haben ihre eigene Zuweisungslogik');
  assert.equal(all[0].created_by, ANNA);
});

test('assigned_from steht auf NULL, wo niemand geerbt hat', () => {
  const rows = database.prepare(
    "SELECT assigned_from FROM reminders WHERE entity_type='task'"
  ).all();
  for (const r of rows) assert.equal(r.assigned_from, null);
});

test('fan-out leaves recurring external Event, Place and planning-conflict identity untouched', async () => {
  const placeId = Number(database.prepare(`
    INSERT INTO places (name, type, street_address, created_by)
    VALUES ('Shared dentist', 'custom', '1 Main Street', ?)
  `).run(ANNA).lastInsertRowid);
  const eventId = Number(database.prepare(`
    INSERT INTO calendar_events (
      title, start_datetime, end_datetime, created_by, visibility,
      external_source, external_calendar_id, recurrence_rule, place_id,
      target_google_calendar_id, external_object_url, user_modified,
      outbound_dirty, outbound_attempts, color_modified
    ) VALUES (
      'Recurring external appointment', '2032-03-01T10:00:00', '2032-03-01T11:00:00', ?, 'all',
      'google', 'google-event-stable-id', 'FREQ=DAILY', ?,
      'google-calendar-stable-id', 'https://calendar.example/event/stable', 1,
      1, 2, 1
    )
  `).run(ANNA, placeId).lastInsertRowid);
  const mealId = Number(database.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by, place_id)
    VALUES ('2032-03-01', 'lunch', 'Conflict sentinel meal', ?, ?)
  `).run(ANNA, placeId).lastInsertRowid);
  const conflictId = Number(database.prepare(`
    INSERT INTO meal_calendar_conflicts (
      meal_id, user_id, calendar_event_id, occurrence_key,
      occurrence_start, occurrence_end, material_fingerprint
    ) VALUES (?, ?, ?, '2032-03-01:ben', '2032-03-01T10:00:00', '2032-03-01T11:00:00', 'stable-fingerprint')
  `).run(mealId, BEN, eventId).lastInsertRowid);

  const eventIdentity = () => database.prepare(`
    SELECT external_source, external_calendar_id, recurrence_rule, place_id,
           target_google_calendar_id, external_object_url, user_modified,
           outbound_dirty, outbound_attempts, color_modified
      FROM calendar_events WHERE id = ?
  `).get(eventId);
  const expectedIdentity = eventIdentity();

  setEventAssignments(database, eventId, [ANNA, BEN]);
  actingUser = ANNA;
  await setReminders(eventId, ['2032-02-29T10:00:00']);
  assert.equal(remindersOf(eventId, BEN).length, 1);

  const expanded = expandRecurringEvents(
    [database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId)],
    '2032-03-01',
    '2032-03-03',
  );
  assert.equal(expanded.length, 3, 'the recurring external master still expands normally');
  assert.ok(expanded.every((row) => row.id === eventId), 'instances retain the canonical Event identity');
  assert.ok(expanded.every((row) => row.place_id === placeId), 'Place identity is retained on every projection');

  // Removing an assignee drops only the reminder inherited from this Event.
  // It must not rewrite the external sync state or detach planning references.
  setEventAssignments(database, eventId, [ANNA]);
  assert.equal(remindersOf(eventId, BEN).length, 0);
  assert.deepEqual(eventIdentity(), expectedIdentity);
  assert.deepEqual(
    database.prepare(`
      SELECT meal_id, user_id, calendar_event_id, occurrence_key, material_fingerprint
        FROM meal_calendar_conflicts WHERE id = ?
    `).get(conflictId),
    {
      meal_id: mealId,
      user_id: BEN,
      calendar_event_id: eventId,
      occurrence_key: '2032-03-01:ben',
      material_fingerprint: 'stable-fingerprint',
    },
    'Meal Plan conflict provenance remains linked to the same Event',
  );

  setEventAssignments(database, eventId, [ANNA, BEN]);
  assert.equal(remindersOf(eventId, BEN).length, 1, 'reassignment inherits the author reminder again');
  actingUser = BEN;
  await setReminders(eventId, ['2032-02-28T08:00:00']);
  actingUser = ANNA;
  await setReminders(eventId, ['2032-02-29T08:30:00']);
  assert.deepEqual(remindersOf(eventId, BEN).map((row) => ({
    remind_at: row.remind_at,
    assigned_from: row.assigned_from,
  })), [{ remind_at: '2032-02-28T08:00:00', assigned_from: null }],
  'a personal override remains personal even while the external recurring master changes its author reminder');
  assert.deepEqual(eventIdentity(), expectedIdentity);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});
