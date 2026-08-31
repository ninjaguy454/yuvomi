import { createHash } from 'node:crypto';
import { expandRecurringEvents, loadEventExceptions } from './calendar-events.js';
import { syncAutoPortions } from './meal-dishes.js';

const ACTIVE_STATES = new Set(['open', 'needs_review', 'reopened']);
const RESOLUTIONS = new Set([
  'participating', 'not_participating', 'time_changed', 'backup_assigned',
  'personal_alternative', 'keep_preferred_time', 'keep_window', 'ignore',
]);

function instant(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function addMinutes(value, minutes) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString().replace('.000Z', 'Z');
}

function mealWindow(meal) {
  const startTime = meal.earliest_time || meal.scheduled_time || meal.preferred_time;
  const endTime = meal.latest_time || meal.scheduled_time || meal.preferred_time;
  if (!startTime || !endTime) return null;
  const start = `${meal.date}T${startTime}:00`;
  let end = `${meal.date}T${endTime}:00`;
  if (end <= start) end = addMinutes(start, Number(meal.expected_duration_minutes) || 60);
  else if (meal.scheduled_time && !meal.latest_time) end = addMinutes(start, Number(meal.expected_duration_minutes) || 60);
  return { start, end };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  const values = [aStart, aEnd, bStart, bEnd].map(instant);
  return values.every((value) => value != null) && values[0] < values[3] && values[2] < values[1];
}

function eventUsers(database, eventId) {
  const rows = database.prepare('SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id').all(eventId);
  const direct = database.prepare('SELECT assigned_to FROM calendar_events WHERE id = ?').get(eventId)?.assigned_to;
  return [...new Set([...rows.map((row) => Number(row.user_id)), direct ? Number(direct) : null].filter(Boolean))].sort((a, b) => a - b);
}

function materialFingerprint(event, users) {
  return createHash('sha256').update(JSON.stringify({
    event_id: Number(event.id),
    start: event.start_datetime,
    end: event.end_datetime || event.start_datetime,
    all_day: Number(event.all_day || 0),
    users,
  })).digest('hex');
}

function eventsForRange(database, from, to) {
  const rows = database.prepare(`
    SELECT * FROM calendar_events
     WHERE (
       (recurrence_rule IS NULL AND date(start_datetime) <= ? AND date(COALESCE(end_datetime, start_datetime)) >= ?)
       OR (recurrence_rule IS NOT NULL AND date(start_datetime) <= ?)
     )
  `).all(to, from, to);
  const recurringIds = rows.filter((row) => row.recurrence_rule).map((row) => row.id);
  const occurrences = expandRecurringEvents(rows, from, to, loadEventExceptions(database, recurringIds));
  const users = new Map(rows.map((row) => [Number(row.id), eventUsers(database, row.id)]));
  return occurrences.map((event) => ({ ...event, participant_ids: users.get(Number(event.id)) || [] }));
}

export function reconcileMealCalendarConflicts(database, { from, to } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    throw new Error('Conflict reconciliation requires a valid date range.');
  }
  const meals = database.prepare(`SELECT * FROM meals WHERE date BETWEEN ? AND ? AND superseded_by_id IS NULL`).all(from, to);
  const mealIds = meals.map((meal) => Number(meal.id));
  const participants = new Map();
  if (mealIds.length) {
    const rows = database.prepare(`
      SELECT meal_id, user_id FROM meal_participants
       WHERE meal_id IN (${mealIds.map(() => '?').join(',')})
         AND role = 'participant' AND status IN ('participating', 'needs_confirmation')
    `).all(...mealIds);
    for (const row of rows) (participants.get(Number(row.meal_id)) || participants.set(Number(row.meal_id), new Set()).get(Number(row.meal_id))).add(Number(row.user_id));
  }

  const events = eventsForRange(database, from, to);
  const seen = new Set();
  const selectExisting = database.prepare(`
    SELECT * FROM meal_calendar_conflicts WHERE meal_id = ? AND user_id = ? AND occurrence_key = ?
  `);
  const insert = database.prepare(`
    INSERT INTO meal_calendar_conflicts (
      meal_id, user_id, calendar_event_id, occurrence_key, occurrence_start,
      occurrence_end, material_fingerprint, detection_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
  `);
  const refresh = database.prepare(`
    UPDATE meal_calendar_conflicts SET calendar_event_id = ?, occurrence_start = ?, occurrence_end = ?,
      material_fingerprint = ?, detection_state = ?, resolution = ?, resolution_payload_json = ?,
      reviewed_at = ?, detected_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
  `);

  database.transaction(() => {
    for (const meal of meals) {
      const window = mealWindow(meal);
      if (!window) continue;
      const mealPeople = participants.get(Number(meal.id)) || new Set();
      if (!mealPeople.size) continue;
      for (const event of events) {
        const eventEnd = event.end_datetime || addMinutes(event.start_datetime, event.all_day ? 1440 : 60);
        if (!overlaps(window.start, window.end, event.start_datetime, eventEnd)) continue;
        const affected = event.participant_ids.filter((userId) => mealPeople.has(userId));
        if (!affected.length) continue;
        const occurrenceKey = `${event.id}:${event.recurrence_rule ? event.start_datetime.slice(0, 10) : 'single'}`;
        const fingerprint = materialFingerprint(event, event.participant_ids);
        for (const userId of affected) {
          const key = `${meal.id}:${userId}:${occurrenceKey}`;
          seen.add(key);
          const existing = selectExisting.get(meal.id, userId, occurrenceKey);
          if (!existing) {
            insert.run(meal.id, userId, event.id, occurrenceKey, event.start_datetime, eventEnd, fingerprint);
            continue;
          }
          if (existing.material_fingerprint === fingerprint && existing.detection_state !== 'superseded') continue;
          const nextState = existing.detection_state === 'superseded'
            ? 'reopened'
            : (existing.material_fingerprint === fingerprint ? existing.detection_state : 'reopened');
          refresh.run(event.id, event.start_datetime, eventEnd, fingerprint, nextState,
            nextState === 'reopened' ? null : existing.resolution,
            nextState === 'reopened' ? null : existing.resolution_payload_json,
            nextState === 'reopened' ? null : existing.reviewed_at,
            existing.id);
        }
      }
    }

    const existing = database.prepare(`
      SELECT c.* FROM meal_calendar_conflicts c JOIN meals m ON m.id = c.meal_id
       WHERE m.date BETWEEN ? AND ? AND c.detection_state != 'superseded'
    `).all(from, to);
    const supersede = database.prepare(`
      UPDATE meal_calendar_conflicts SET detection_state = 'superseded',
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `);
    for (const row of existing) {
      if (!seen.has(`${row.meal_id}:${row.user_id}:${row.occurrence_key}`)) supersede.run(row.id);
    }
  })();

  return listMealCalendarConflicts(database, { from, to });
}

export function listMealCalendarConflicts(database, { from, to, activeOnly = false } = {}) {
  const clauses = [];
  const params = [];
  if (from) { clauses.push('m.date >= ?'); params.push(from); }
  if (to) { clauses.push('m.date <= ?'); params.push(to); }
  if (activeOnly) clauses.push("c.detection_state IN ('open', 'needs_review', 'reopened')");
  return database.prepare(`
    SELECT c.*, m.date AS meal_date, m.title AS meal_title, m.meal_type,
           e.title AS calendar_title, u.display_name AS user_name
      FROM meal_calendar_conflicts c
      JOIN meals m ON m.id = c.meal_id
      JOIN users u ON u.id = c.user_id
      LEFT JOIN calendar_events e ON e.id = c.calendar_event_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY c.occurrence_start, c.id
  `).all(...params).map((row) => ({
    ...row,
    active: ACTIVE_STATES.has(row.detection_state),
    resolution_payload: row.resolution_payload_json ? JSON.parse(row.resolution_payload_json) : null,
    resolution_payload_json: undefined,
  }));
}

export function resolveMealCalendarConflict(database, conflictId, resolution, payload = {}, actorId = null) {
  if (!RESOLUTIONS.has(resolution)) throw new Error('Choose a valid conflict resolution.');
  const conflict = database.prepare(`
    SELECT c.*, m.* FROM meal_calendar_conflicts c JOIN meals m ON m.id = c.meal_id WHERE c.id = ?
  `).get(conflictId);
  if (!conflict) throw new Error('Meal conflict not found.');

  database.transaction(() => {
    if (resolution === 'not_participating') {
      database.prepare(`UPDATE meal_participants SET status = 'not_participating', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE meal_id = ? AND user_id = ? AND role = 'participant'`).run(conflict.meal_id, conflict.user_id);
    } else if (resolution === 'participating') {
      database.prepare(`UPDATE meal_participants SET status = 'participating', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE meal_id = ? AND user_id = ? AND role = 'participant'`).run(conflict.meal_id, conflict.user_id);
    } else if (resolution === 'time_changed') {
      const time = String(payload.scheduled_time || '');
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a valid meal time.');
      if ((conflict.earliest_time && time < conflict.earliest_time) || (conflict.latest_time && time > conflict.latest_time)) {
        throw new Error('The new meal time must stay inside its acceptable window.');
      }
      database.prepare(`UPDATE meals SET scheduled_time = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(time, conflict.meal_id);
    } else if (resolution === 'backup_assigned') {
      const backupId = Number(payload.user_id);
      if (!Number.isInteger(backupId) || !database.prepare('SELECT 1 FROM users WHERE id = ?').get(backupId)) throw new Error('Choose a valid backup person.');
      database.prepare(`INSERT INTO meal_participants (meal_id, user_id, role, status, source) VALUES (?, ?, 'participant', 'participating', 'manual') ON CONFLICT(meal_id, user_id, role) DO UPDATE SET status = 'participating', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`).run(conflict.meal_id, backupId);
    } else if (resolution === 'personal_alternative') {
      const title = String(payload.title || '').trim();
      if (!title) throw new Error('Give the personal alternative a title.');
      const created = database.prepare(`
        INSERT INTO meals (date, meal_type, title, notes, scope, parent_meal_id, scheduled_time,
          earliest_time, preferred_time, latest_time, expected_duration_minutes, source,
          provenance_json, created_by, selection_status, place_id)
        VALUES (?, ?, ?, ?, 'personal', ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 'selected', ?)
      `).run(conflict.date, conflict.meal_type, title, payload.notes || null, conflict.meal_id,
        conflict.scheduled_time, conflict.earliest_time, conflict.preferred_time, conflict.latest_time,
        conflict.expected_duration_minutes, JSON.stringify({ source: 'calendar_conflict', conflict_id: conflictId }),
        actorId, conflict.place_id);
      database.prepare(`INSERT INTO meal_participants (meal_id, user_id, role, status, source) VALUES (?, ?, 'participant', 'participating', 'manual')`).run(created.lastInsertRowid, conflict.user_id);
      payload.personal_meal_id = Number(created.lastInsertRowid);
    }
    if (['participating', 'not_participating', 'backup_assigned'].includes(resolution)) {
      syncAutoPortions(database, conflict.meal_id);
    }
    const state = resolution === 'ignore' ? 'ignored' : 'resolved';
    database.prepare(`
      UPDATE meal_calendar_conflicts SET detection_state = ?, resolution = ?, resolution_payload_json = ?,
        reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_by = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(state, resolution, JSON.stringify(payload || {}), actorId, conflictId);
  })();
  return listMealCalendarConflicts(database).find((row) => Number(row.id) === Number(conflictId));
}
