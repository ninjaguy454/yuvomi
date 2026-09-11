/** Schedule API: patterns are computed into entries, never calendar events. */
import express from 'express';
import * as db from '../db.js';
import { bool, color, collectErrors, date, id, num, str, time } from '../middleware/validate.js';
import { createLogger } from '../logger.js';
import { scheduleData } from '../services/schedule.js';
import { daysBetweenDateKeys } from '../utils/timezone.js';

const router = express.Router();
const log = createLogger('Schedule');
const actorId = (req) => req.authUserId || req.session?.userId;
const isAdmin = (req) => req.authRole === 'admin' || req.session?.role === 'admin';
const fail = (res, code, error) => res.status(code).json({ error, code });
const userExists = (value) => !!db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(value);
const typeExists = (value) => !!db.get().prepare('SELECT 1 FROM schedule_shift_types WHERE id = ?').get(value);
const mineOrAdmin = (req, userId) => isAdmin(req) || actorId(req) === userId;

/**
 * Ein Schichttyp gehoert dem Haushalt, nicht einer Person: er taucht in den
 * Mustern aller Mitglieder auf. Anlegen darf ihn deshalb jeder - das nimmt
 * niemandem etwas weg -, aendern und loeschen nur, wer ihn angelegt hat, oder
 * ein Admin. Sonst benennt ein Mitglied die Fruehschicht der ganzen Familie um.
 *
 * `created_by` ist `ON DELETE SET NULL`: ein Typ, dessen Ersteller nicht mehr
 * da ist, wird verwaist und liegt damit bei den Admins - nicht bei allen.
 */
const ownTypeOrAdmin = (req, type) => isAdmin(req) || (type.created_by != null && type.created_by === actorId(req));

/**
 * Hat SQLite das Loeschen wegen einer bestehenden Referenz abgelehnt?
 *
 * Steht als benannte Funktion hier und nicht als Ausdruck im Handler, damit ein
 * Test sie direkt befragen kann: der Handler antwortete vorher auf JEDEN Fehler
 * mit "noch in Benutzung", und ein Test auf den Statuscode allein bleibt dabei
 * gruen - er misst das Ergebnis, nicht den Grund.
 *
 * Gemessen und nicht geraten: ein abgelehntes `ON DELETE RESTRICT` kommt als
 * `SQLITE_CONSTRAINT_TRIGGER` an, NICHT als `_FOREIGNKEY` - die Meldung lautet
 * "FOREIGN KEY constraint failed", der Code sagt etwas anderes. Deshalb das
 * Praefix ueber alle Constraint-Varianten; ein DELETE kann ohnehin keinen
 * UNIQUE- oder CHECK-Verstoss ausloesen.
 */
export function isStillReferenced(err) {
  return String(err?.code || '').startsWith('SQLITE_CONSTRAINT');
}
const typeColumns = 'id, name, short_code, start_time, end_time, color, created_by, created_at, updated_at, availability_state, place_id';

function shiftEffect(body, old = {}) {
  const state = body?.availability_state ?? old.availability_state ?? 'busy';
  if (!['busy', 'available', 'away', 'unknown', 'none'].includes(state)) return { error: 'Choose a valid Availability effect.' };
  const value = body?.place_id === undefined ? old.place_id : body.place_id;
  const place = value == null || value === '' ? null : id(value, 'place_id');
  if (place?.error) return { error: place.error };
  if (place) {
    const row = db.get().prepare('SELECT active FROM places WHERE id = ?').get(place.value);
    if (!row || (!row.active && Number(old.place_id) !== place.value)) return { error: 'Choose an active Place.' };
  }
  return { state, placeId: place?.value ?? null };
}

function validateDays(rows, length) {
  if (!Array.isArray(rows) || rows.length > 366) return { error: 'days must be an array of at most 366 days.' };
  const seen = new Set(); const days = [];
  for (const row of rows) {
    const position = num(row?.position, 'position', { required: true });
    const shiftType = row?.shift_type_id == null ? null : id(row.shift_type_id, 'shift_type_id');
    if (!row || !Object.hasOwn(row, 'shift_type_id') || position.error || !Number.isInteger(position.value)
      || position.value < 0 || position.value >= length || shiftType?.error || seen.has(position.value)) return { error: 'Invalid routine day. Omit unconfigured days; use a null shift only for an explicit day off.' };
    if (shiftType && !typeExists(shiftType.value)) return { error: 'shift_type_id does not exist.' };
    seen.add(position.value); days.push([position.value, shiftType?.value ?? null]);
  }
  return { days };
}

function replaceDays(database, patternId, days) {
  // A shorter cycle can leave legacy saved day-off rows beyond its new end.
  // Keep those inert rows even when the editor saves the header and days together.
  database.prepare(`DELETE FROM schedule_pattern_days WHERE pattern_id = ?
    AND (shift_type_id IS NOT NULL OR position < (SELECT cycle_length FROM schedule_patterns WHERE id = ?))`)
    .run(patternId, patternId);
  const add = database.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, ?, ?)');
  for (const day of days) add.run(patternId, ...day);
}

// Der Zeitraum von `/entries` muss eine Obergrenze haben: `dateKeysInRange()`
// baut EINEN String je Tag, und `resolveEntries()` laeuft ihn je Haushaltsmitglied
// durch. `from=1000-01-01&to=9999-12-31` sind rund 3,3 Millionen Tage - synchron,
// je Mitglied, bei jedem Aufruf. Ein angemeldetes Mitglied oder ein Token mit
// `schedule:read` koennte den Server damit anhalten.
//
// Zwei Jahre und ein Tag: die Statistik-Ansicht bietet hoechstens ein Jahr an,
// und ein Jahreswechsel-Zeitraum ueber zwei Kalenderjahre bleibt darin bequem.
// Wie MAX_ITER in calendar-events.js begrenzt das die ARBEIT und nicht die
// Gueltigkeit der Eingabe - deshalb 400 mit Begruendung statt stiller Kuerzung.
const MAX_RANGE_DAYS = 731;

router.get('/entries', (req, res) => {
  const from = date(req.query.from, 'from', true); const to = date(req.query.to, 'to', true);
  const requested = req.query.user_id == null ? null : id(req.query.user_id, 'user_id');
  const errors = collectErrors([from, to, requested].filter(Boolean));
  if (errors.length || (from.value && to.value && from.value > to.value)) return fail(res, 400, errors.join(' ') || 'from must be before to.');
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_RANGE_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_RANGE_DAYS} days.`);
  }
  if (requested && !userExists(requested.value)) return fail(res, 404, 'User not found.');
  try { res.json({ data: scheduleData(db.get(), { from: from.value, to: to.value, userId: requested?.value ?? null }) }); }
  catch (err) {
    log.error('Error resolving schedule entries:', err.message);
    return fail(res, 500, 'Schedule entries could not be resolved.');
  }
});

router.get('/shift-types', (_req, res) => res.json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types ORDER BY name COLLATE NOCASE`).all() }));
router.post('/shift-types', (req, res) => {
  const name = str(req.body?.name, 'name'); const shortCode = str(req.body?.short_code, 'short_code', { required: false, max: 12 });
  const start = time(req.body?.start_time, 'start_time'); const end = time(req.body?.end_time, 'end_time'); const shade = color(req.body?.color || '#6C3AED', 'color');
  const errors = collectErrors([name, shortCode, start, end, shade]);
  const effect = shiftEffect(req.body);
  if (effect.error) errors.push(effect.error);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
  const result = db.get().prepare('INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, created_by, availability_state, place_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name.value, shortCode.value, start.value, end.value, shade.value, actorId(req), effect.state, effect.placeId);
  res.status(201).json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(result.lastInsertRowid) });
});
router.delete('/shift-types/:id', (req, res) => {
  const shiftType = id(req.params.id, 'id');
  if (shiftType.error) return fail(res, 400, shiftType.error);
  const existing = db.get().prepare('SELECT id, created_by FROM schedule_shift_types WHERE id = ?').get(shiftType.value);
  if (!existing) return fail(res, 404, 'Shift type not found.');
  if (!ownTypeOrAdmin(req, existing)) return fail(res, 403, 'Forbidden.');
  try {
    db.get().prepare('DELETE FROM schedule_shift_types WHERE id = ?').run(existing.id);
    return res.status(204).end();
  } catch (err) {
    // Nur der Fremdschluessel wird als "in Benutzung" gedeutet. Vorher fing der
    // Zweig JEDEN Fehler und nannte denselben Grund - ein Schreibfehler im SQL
    // haette dem Aufrufer erzaehlt, der Typ sei noch im Einsatz.
    if (isStillReferenced(err)) return fail(res, 409, 'Shift type is in use.');
    log.error('Error deleting shift type:', err.message);
    return fail(res, 500, 'Internal error.');
  }
});

router.get('/patterns', (req, res) => {
  const requested = req.query.user_id == null ? null : id(req.query.user_id, 'user_id');
  if (requested?.error) return fail(res, 400, requested.error);
  if (requested && !userExists(requested.value)) return fail(res, 404, 'User not found.');
  const rows = requested ? db.get().prepare('SELECT * FROM schedule_patterns WHERE user_id = ? ORDER BY valid_from DESC, id DESC').all(requested.value) : db.get().prepare('SELECT * FROM schedule_patterns ORDER BY user_id, valid_from DESC, id DESC').all();
  res.json({ data: rows });
});
router.post('/patterns', (req, res) => {
  const user = id(req.body?.user_id ?? actorId(req), 'user_id'); const name = str(req.body?.name, 'name'); const anchor = date(req.body?.anchor_date, 'anchor_date', true);
  const length = num(req.body?.cycle_length, 'cycle_length', { required: true }); const from = date(req.body?.valid_from, 'valid_from'); const until = date(req.body?.valid_until, 'valid_until');
  const active = req.body?.is_active === undefined ? { value: true, error: null } : bool(req.body.is_active, 'is_active');
  const errors = collectErrors([user, name, anchor, length, from, until, active]); if (!Number.isInteger(length.value) || length.value < 1 || length.value > 366) errors.push('cycle_length must be between 1 and 366.'); if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  const dayInput = req.body?.days === undefined ? null : validateDays(req.body.days, length.value);
  if (dayInput?.error) errors.push(dayInput.error);
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.'); if (from.value && until.value && from.value > until.value) errors.push('valid_from must be before valid_until.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const patternId = db.get().transaction(() => {
    const result = db.get().prepare('INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length, valid_from, valid_until, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.value, name.value, anchor.value, length.value, from.value, until.value, Number(active.value));
    if (dayInput) replaceDays(db.get(), result.lastInsertRowid, dayInput.days);
    return result.lastInsertRowid;
  })();
  res.status(201).json({ data: db.get().prepare('SELECT * FROM schedule_patterns WHERE id = ?').get(patternId) });
});
router.put('/patterns/:id/days/:position', (req, res) => {
  const patternId = id(req.params.id, 'pattern_id'); const position = num(req.params.position, 'position', { required: true });
  const typeId = req.body?.shift_type_id == null ? null : id(req.body.shift_type_id, 'shift_type_id');
  const pattern = patternId.value && db.get().prepare('SELECT * FROM schedule_patterns WHERE id = ?').get(patternId.value);
  if (!pattern) return res.status(404).json({ error: 'Pattern not found.', code: 404 }); if (!mineOrAdmin(req, pattern.user_id)) return res.status(403).json({ error: 'Forbidden.', code: 403 });
  if (!req.body || !Object.hasOwn(req.body, 'shift_type_id')) return fail(res, 400, 'Provide shift_type_id explicitly; use null only for a day off this routine.');
  if (patternId.error || !Number.isInteger(position.value) || position.value < 0 || position.value >= pattern.cycle_length || typeId?.error) return res.status(400).json({ error: 'Invalid pattern day.', code: 400 });
  if (typeId && !typeExists(typeId.value)) return fail(res, 400, 'shift_type_id does not exist.');
  db.get().prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, ?, ?) ON CONFLICT(pattern_id, position) DO UPDATE SET shift_type_id = excluded.shift_type_id').run(pattern.id, position.value, typeId?.value ?? null);
  res.json({ data: db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id = ? AND position = ?').get(pattern.id, position.value) });
});
router.put('/overrides/:dateKey', (req, res) => {
  const key = date(req.params.dateKey, 'date_key', true); const user = id(req.body?.user_id ?? actorId(req), 'user_id'); const typeId = req.body?.shift_type_id == null ? null : id(req.body.shift_type_id, 'shift_type_id'); const note = str(req.body?.note, 'note', { required: false, max: 5000 });
  const errors = collectErrors([key, user, typeId, note].filter(Boolean));
  if (!req.body || !Object.hasOwn(req.body, 'shift_type_id')) errors.push('Provide shift_type_id explicitly; use null only for a day off this routine.');
  if (user.value && !userExists(user.value)) errors.push('user_id does not exist.'); if (typeId && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.'); if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.'); if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  db.get().prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id, note) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date_key) DO UPDATE SET shift_type_id = excluded.shift_type_id, note = excluded.note').run(user.value, key.value, typeId?.value ?? null, note.value);
  res.json({ data: db.get().prepare('SELECT * FROM schedule_overrides WHERE user_id = ? AND date_key = ?').get(user.value, key.value) });
});

router.put('/shift-types/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(key.value);
  if (!old) return fail(res, 404, 'Shift type not found.');
  if (!ownTypeOrAdmin(req, old)) return fail(res, 403, 'Forbidden.');
  const name = req.body?.name === undefined ? { value: old.name } : str(req.body.name, 'name');
  const shortCode = req.body?.short_code === undefined ? { value: old.short_code } : str(req.body.short_code, 'short_code', { required: false, max: 12 });
  const start = req.body?.start_time === undefined ? { value: old.start_time } : time(req.body.start_time, 'start_time');
  const end = req.body?.end_time === undefined ? { value: old.end_time } : time(req.body.end_time, 'end_time');
  // `color()` antwortet auf jeden falsy Wert mit {value: null, error: null}, und
  // die Spalte ist NOT NULL - ein `{"color": ""}` schriebe also NULL und flöge als
  // roher 500er zurueck. Der Ruecksetzer ist die bestehende Farbe und nicht der
  // Palettenerste: die Anfrage sagt "nicht anfassen", nicht "auf Anfang".
  const shade = req.body?.color === undefined || !req.body.color
    ? { value: old.color, error: null }
    : color(req.body.color, 'color');
  const errors = collectErrors([name, shortCode, start, end, shade]);
  const effect = shiftEffect(req.body, old);
  if (effect.error) errors.push(effect.error);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().prepare('UPDATE schedule_shift_types SET name=?, short_code=?, start_time=?, end_time=?, color=?, availability_state=?, place_id=? WHERE id=?').run(name.value, shortCode.value, start.value, end.value, shade.value, effect.state, effect.placeId, key.value);
  return res.json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(key.value) });
});
router.put('/patterns/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  const name = req.body?.name === undefined ? { value: old.name } : str(req.body.name, 'name');
  const anchor = req.body?.anchor_date === undefined ? { value: old.anchor_date } : date(req.body.anchor_date, 'anchor_date', true);
  const length = req.body?.cycle_length === undefined ? { value: old.cycle_length } : num(req.body.cycle_length, 'cycle_length', { required: true });
  const from = req.body?.valid_from === undefined ? { value: old.valid_from } : date(req.body.valid_from, 'valid_from');
  const until = req.body?.valid_until === undefined ? { value: old.valid_until } : date(req.body.valid_until, 'valid_until');
  const active = req.body?.is_active === undefined ? { value: Boolean(old.is_active) } : bool(req.body.is_active, 'is_active');
  const errors = collectErrors([name, anchor, length, from, until, active]);
  if (!Number.isInteger(length.value) || length.value < 1 || length.value > 366) errors.push('cycle_length must be between 1 and 366.');
  if (from.value && until.value && from.value > until.value) errors.push('valid_from must be before valid_until.');
  const dayInput = req.body?.days === undefined ? null : validateDays(req.body.days, length.value);
  if (dayInput?.error) errors.push(dayInput.error);
  // Historical saved Free days outside a shortened cycle remain inert and preserved.
  if (!dayInput && db.get().prepare('SELECT 1 FROM schedule_pattern_days WHERE pattern_id=? AND position>=? AND shift_type_id IS NOT NULL').get(old.id, length.value)) errors.push('Shortening this routine would remove assigned shifts. Save the revised days together with the routine.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().transaction(() => {
    db.get().prepare('UPDATE schedule_patterns SET name=?,anchor_date=?,cycle_length=?,valid_from=?,valid_until=?,is_active=? WHERE id=?').run(name.value, anchor.value, length.value, from.value, until.value, Number(active.value), old.id);
    if (dayInput) replaceDays(db.get(), old.id, dayInput.days);
  })();
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(old.id) });
});
router.delete('/patterns/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  db.get().prepare('DELETE FROM schedule_patterns WHERE id=?').run(old.id); return res.status(204).end();
});
router.get('/patterns/:id/days', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  if (!db.get().prepare('SELECT 1 FROM schedule_patterns WHERE id=?').get(key.value)) return fail(res, 404, 'Pattern not found.');
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position').all(key.value) });
});
router.put('/patterns/:id/days', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  const input = validateDays(req.body?.days, old.cycle_length);
  if (input.error) return fail(res, 400, input.error);
  db.get().transaction(() => replaceDays(db.get(), old.id, input.days))();
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position').all(old.id) });
});
router.get('/overrides', (req, res) => {
  const user = req.query.user_id == null ? null : id(req.query.user_id, 'user_id'); const from = date(req.query.from, 'from'); const to = date(req.query.to, 'to');
  const errors = collectErrors([user, from, to].filter(Boolean)); if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (errors.length) return fail(res, 400, errors.join(' ')); if (user && !userExists(user.value)) return fail(res, 404, 'User not found.');
  const where = []; const args = []; if (user) { where.push('user_id=?'); args.push(user.value); } if (from.value) { where.push('date_key>=?'); args.push(from.value); } if (to.value) { where.push('date_key<=?'); args.push(to.value); }
  return res.json({ data: db.get().prepare(`SELECT * FROM schedule_overrides${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY user_id,date_key`).all(...args) });
});
router.delete('/overrides/:dateKey', (req, res) => {
  const key = date(req.params.dateKey, 'date_key', true); const user = id(req.query.user_id ?? actorId(req), 'user_id'); const errors = collectErrors([key, user]);
  if (!mineOrAdmin(req, user.value)) return fail(res, 403, 'Forbidden.'); if (errors.length) return fail(res, 400, errors.join(' '));
  const result = db.get().prepare('DELETE FROM schedule_overrides WHERE user_id=? AND date_key=?').run(user.value, key.value);
  return result.changes ? res.status(204).end() : fail(res, 404, 'Override not found.');
});

export default router;
