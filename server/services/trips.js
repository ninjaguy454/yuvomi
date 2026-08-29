import { expandRecurringEvents, loadEventExceptions } from './calendar-events.js';
import { setTaskLocation } from './task-locations.js';

const PHASES = ['before_departure', 'departure', 'during_trip', 'before_return', 'return_home', 'post_trip'];
const TYPES = new Set(['vacation', 'business', 'family', 'road_trip', 'other']);
const STATUSES = new Set(['planning', 'active', 'completed', 'cancelled']);

function text(value, field, { required = false, max = 1000 } = {}) {
  const clean = value == null ? '' : String(value).trim();
  if (required && !clean) throw new Error(`${field} is required.`);
  if (clean.length > max) throw new Error(`${field} is too long.`);
  return clean || null;
}

function timestamp(value, field) {
  const clean = text(value, field, { required: true, max: 40 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(clean) || Number.isNaN(new Date(clean).getTime())) throw new Error(`${field} is invalid.`);
  return clean;
}

function validPlace(database, value, field) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || !database.prepare('SELECT 1 FROM places WHERE id = ? AND active = 1').get(id)) throw new Error(`Choose an active ${field}.`);
  return id;
}

function memberIds(database, values) {
  const requested = [...new Set((Array.isArray(values) ? values : []).map(Number))];
  if (!requested.length) throw new Error('Choose at least one traveler.');
  const rows = database.prepare(`SELECT id FROM users WHERE id IN (${requested.map(() => '?').join(',')})`).all(...requested);
  if (rows.length !== requested.length) throw new Error('Choose valid household travelers.');
  return requested;
}

function shift(value, minutes) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString().slice(0, 16);
}

function defaultStages(input) {
  return [
    { phase: 'before_departure', title: 'Prepare for departure', starts_at: shift(input.startsAt, -1440), place_id: null },
    { phase: 'departure', title: 'Depart', starts_at: input.startsAt, place_id: null },
    { phase: 'during_trip', title: 'At destination', starts_at: shift(input.startsAt, 60), place_id: input.destinationPlaceId },
    { phase: 'before_return', title: 'Prepare to return', starts_at: shift(input.endsAt, -240), place_id: input.lodgingPlaceId || input.destinationPlaceId },
    { phase: 'return_home', title: 'Return home', starts_at: input.endsAt, place_id: null },
    { phase: 'post_trip', title: 'Post-trip reset', starts_at: shift(input.endsAt, 720), place_id: null },
  ];
}

function normalize(database, body, existing = null) {
  const startsAt = timestamp(body.starts_at ?? existing?.starts_at, 'Departure');
  const endsAt = timestamp(body.ends_at ?? existing?.ends_at, 'Return');
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new Error('Return must be after departure.');
  const tripType = body.trip_type ?? existing?.trip_type ?? 'vacation';
  const status = body.status ?? existing?.status ?? 'planning';
  if (!TYPES.has(tripType)) throw new Error('Trip type is invalid.');
  if (!STATUSES.has(status)) throw new Error('Trip status is invalid.');
  return {
    name: text(body.name ?? existing?.name, 'Trip name', { required: true, max: 120 }),
    destinationPlaceId: validPlace(database, body.destination_place_id ?? existing?.destination_place_id, 'destination Place'),
    lodgingPlaceId: validPlace(database, body.lodging_place_id ?? existing?.lodging_place_id, 'lodging Place'),
    startsAt, endsAt, tripType, status,
    createAwayPeriods: body.create_away_periods === undefined ? Boolean(existing?.create_away_periods ?? true) : body.create_away_periods === true,
    notes: text(body.notes ?? existing?.notes, 'Notes'),
    participantIds: memberIds(database, body.participant_ids ?? []),
    stages: Array.isArray(body.stages) ? body.stages : null,
    tasks: Array.isArray(body.tasks) ? body.tasks : [],
  };
}

function phaseDate(input, phase) {
  const byPhase = {
    before_departure: shift(input.startsAt, -1440), departure: input.startsAt,
    during_trip: shift(input.startsAt, 60), before_return: shift(input.endsAt, -240),
    return_home: input.endsAt, post_trip: shift(input.endsAt, 720),
  };
  return byPhase[phase].slice(0, 10);
}

function replaceParticipants(database, tripId, input, actorId) {
  const previous = database.prepare('SELECT availability_period_id FROM trip_participants WHERE trip_id = ?').all(tripId);
  const removePeriod = database.prepare('DELETE FROM availability_periods WHERE id = ?');
  for (const row of previous) if (row.availability_period_id) removePeriod.run(row.availability_period_id);
  database.prepare('DELETE FROM trip_participants WHERE trip_id = ?').run(tripId);
  const addPeriod = database.prepare(`
    INSERT INTO availability_periods (user_id, source, category, state, place_id, starts_at, ends_at, note, active, created_by)
    VALUES (?, 'explicit', 'travel', 'away', ?, ?, ?, ?, 1, ?)
  `);
  const addParticipant = database.prepare('INSERT INTO trip_participants (trip_id, user_id, availability_period_id) VALUES (?, ?, ?)');
  for (const userId of input.participantIds) {
    let periodId = null;
    if (input.createAwayPeriods && input.status !== 'cancelled') {
      periodId = Number(addPeriod.run(userId, input.destinationPlaceId, input.startsAt, input.endsAt, `Trip: ${input.name}`, actorId).lastInsertRowid);
    }
    addParticipant.run(tripId, userId, periodId);
  }
}

function replaceStages(database, tripId, input) {
  database.prepare('DELETE FROM trip_stages WHERE trip_id = ?').run(tripId);
  const stages = input.stages?.length ? input.stages : defaultStages(input);
  const insert = database.prepare(`INSERT INTO trip_stages (trip_id, phase, title, starts_at, place_id, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  stages.forEach((stage, index) => {
    if (!PHASES.includes(stage.phase)) throw new Error('Trip phase is invalid.');
    const placeId = validPlace(database, stage.place_id, 'stage Place');
    insert.run(tripId, stage.phase, text(stage.title, 'Stage title', { required: true, max: 120 }), timestamp(stage.starts_at, 'Stage time'), placeId, text(stage.notes, 'Stage notes'), index);
  });
}

function createTasks(database, tripId, input, actorId) {
  const insertTask = database.prepare(`
    INSERT INTO tasks (title, description, category, priority, status, due_date, assigned_to, created_by,
      is_recurring, assignment_mode, rotation_index, points, visibility, countdown, locked)
    VALUES (?, ?, 'misc', ?, 'open', ?, ?, ?, 0, 'fixed', 0, 0, 'all', 0, 0)
  `);
  const assign = database.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  const link = database.prepare('INSERT INTO trip_tasks (trip_id, task_id, phase) VALUES (?, ?, ?)');
  for (const task of input.tasks) {
    if (!PHASES.includes(task.phase)) throw new Error('Task phase is invalid.');
    const title = text(task.title, 'Task title', { required: true, max: 200 });
    const assigned = Number(task.assigned_to) || input.participantIds[0] || null;
    const taskId = Number(insertTask.run(title, text(task.description, 'Task description'), task.priority || 'none', phaseDate(input, task.phase), assigned, actorId).lastInsertRowid);
    if (assigned) assign.run(taskId, assigned);
    const placeId = ['during_trip', 'before_return'].includes(task.phase)
      ? (input.lodgingPlaceId || input.destinationPlaceId)
      : (task.place_id ? validPlace(database, task.place_id, 'task Place') : null);
    if (placeId) setTaskLocation(database, taskId, { kind: 'saved_place', placeId }, actorId);
    link.run(tripId, taskId, task.phase);
  }
}

export function getTrip(database, id) {
  const trip = database.prepare(`
    SELECT tp.*, dp.name AS destination_name, lp.name AS lodging_name
      FROM trip_plans tp LEFT JOIN places dp ON dp.id = tp.destination_place_id
      LEFT JOIN places lp ON lp.id = tp.lodging_place_id WHERE tp.id = ?
  `).get(id);
  if (!trip) return null;
  const participants = database.prepare(`SELECT t.*, u.display_name, u.avatar_color FROM trip_participants t JOIN users u ON u.id = t.user_id WHERE t.trip_id = ? ORDER BY u.display_name`).all(id);
  const stages = database.prepare(`SELECT s.*, p.name AS place_name FROM trip_stages s LEFT JOIN places p ON p.id = s.place_id WHERE s.trip_id = ? ORDER BY s.starts_at, s.sort_order, s.id`).all(id);
  const tasks = database.prepare(`SELECT tt.phase, t.* FROM trip_tasks tt JOIN tasks t ON t.id = tt.task_id WHERE tt.trip_id = ? ORDER BY t.due_date, t.id`).all(id);
  return { ...trip, participant_ids: participants.map((row) => Number(row.user_id)), participants, stages, tasks };
}

export function listTrips(database, { from = null, to = null } = {}) {
  const rows = from && to
    ? database.prepare('SELECT id FROM trip_plans WHERE date(starts_at) <= ? AND date(ends_at) >= ? ORDER BY starts_at, id').all(to, from)
    : database.prepare('SELECT id FROM trip_plans ORDER BY starts_at DESC, id DESC').all();
  return rows.map((row) => getTrip(database, row.id));
}

export function saveTrip(database, body, actorId, id = null) {
  const existing = id ? database.prepare('SELECT * FROM trip_plans WHERE id = ?').get(id) : null;
  if (id && !existing) throw new Error('Trip not found.');
  const input = normalize(database, body, existing);
  let tripId = Number(id) || null;
  database.transaction(() => {
    if (existing) {
      database.prepare(`UPDATE trip_plans SET name = ?, destination_place_id = ?, lodging_place_id = ?, starts_at = ?, ends_at = ?, trip_type = ?, status = ?, create_away_periods = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(input.name, input.destinationPlaceId, input.lodgingPlaceId, input.startsAt, input.endsAt, input.tripType, input.status, input.createAwayPeriods ? 1 : 0, input.notes, tripId);
    } else {
      tripId = Number(database.prepare(`INSERT INTO trip_plans (name, destination_place_id, lodging_place_id, starts_at, ends_at, trip_type, status, create_away_periods, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.name, input.destinationPlaceId, input.lodgingPlaceId, input.startsAt, input.endsAt, input.tripType, input.status, input.createAwayPeriods ? 1 : 0, input.notes, actorId).lastInsertRowid);
    }
    replaceParticipants(database, tripId, input, actorId);
    replaceStages(database, tripId, input);
    createTasks(database, tripId, input, actorId);
  })();
  return getTrip(database, tripId);
}

export function deleteTrip(database, id) {
  const participants = database.prepare('SELECT availability_period_id FROM trip_participants WHERE trip_id = ?').all(id);
  return database.transaction(() => {
    const result = database.prepare('DELETE FROM trip_plans WHERE id = ?').run(id);
    for (const row of participants) if (row.availability_period_id) database.prepare('DELETE FROM availability_periods WHERE id = ?').run(row.availability_period_id);
    return result.changes;
  })();
}

export function tripItinerary(database, id) {
  const trip = getTrip(database, id);
  if (!trip) throw new Error('Trip not found.');
  const from = trip.starts_at.slice(0, 10);
  const to = trip.ends_at.slice(0, 10);
  const eventRows = database.prepare(`SELECT * FROM calendar_events WHERE (date(start_datetime) <= ? AND date(COALESCE(end_datetime, start_datetime)) >= ?) OR (recurrence_rule IS NOT NULL AND date(start_datetime) <= ?)`).all(to, from, to);
  const recurring = eventRows.filter((event) => event.recurrence_rule).map((event) => event.id);
  const events = expandRecurringEvents(eventRows, from, to, loadEventExceptions(database, recurring)).filter((event) => {
    const ids = database.prepare('SELECT user_id FROM event_assignments WHERE event_id = ?').all(event.id).map((row) => Number(row.user_id));
    if (event.assigned_to) ids.push(Number(event.assigned_to));
    return ids.some((userId) => trip.participant_ids.includes(userId));
  });
  const meals = database.prepare(`SELECT * FROM meals WHERE date BETWEEN ? AND ? AND superseded_by_id IS NULL ORDER BY date, COALESCE(scheduled_time, preferred_time), id`).all(from, to);
  const days = {};
  const add = (date, kind, value) => ((days[date] ||= { stages: [], tasks: [], meals: [], events: [] })[kind].push(value));
  trip.stages.forEach((stage) => add(stage.starts_at.slice(0, 10), 'stages', stage));
  trip.tasks.forEach((task) => add(task.due_date || from, 'tasks', task));
  meals.forEach((meal) => add(meal.date, 'meals', meal));
  events.forEach((event) => add(event.start_datetime.slice(0, 10), 'events', event));
  return { trip, days };
}

export const TRIP_PHASES = PHASES;

