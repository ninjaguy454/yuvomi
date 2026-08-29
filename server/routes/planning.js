import express from 'express';
import * as db from '../db.js';
import { requireAdmin } from '../auth.js';
import { householdMembers } from '../services/activity-eligibility.js';
import { evaluatePresence, placeWithInheritedAddress } from '../services/presence.js';
import {
  googlePlacesStatus,
  PlaceProviderError,
  searchGooglePlaces,
} from '../services/google-places.js';
import { createLogger } from '../logger.js';

const router = express.Router();
const log = createLogger('Planning');
const PLACE_TYPES = new Set(['home', 'room', 'school', 'work', 'restaurant', 'store', 'hotel', 'destination', 'custom']);
const STATES = new Set(['available', 'away', 'busy', 'unknown', 'custom']);
const CATEGORIES = new Set(['general', 'school', 'work', 'custody', 'vacation', 'travel']);
const SOURCES = new Set(['manual', 'workflow', 'explicit']);
const POLICIES = new Set(['ignore', 'must_be_home', 'must_be_at_location', 'must_be_away', 'available_before_due']);

function currentUserId(req) {
  return Number(req.authUserId || req.session?.userId);
}

function string(value, { required = false, max = 500 } = {}) {
  const result = value == null ? '' : String(value).trim();
  if (required && !result) throw new Error('A required field is empty.');
  if (result.length > max) throw new Error(`Text is limited to ${max} characters.`);
  return result || null;
}

function integer(value, { required = false, min = 1 } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error('A required identifier is missing.');
    return null;
  }
  const result = Number(value);
  if (!Number.isInteger(result) || result < min) throw new Error('An identifier is invalid.');
  return result;
}

function boolean(value, fallback = true) {
  if (value === undefined) return fallback ? 1 : 0;
  return value === true || value === 1 || value === 'true' || value === '1' ? 1 : 0;
}

function enumValue(value, allowed, fallback, field) {
  const result = value ?? fallback;
  if (!allowed.has(result)) throw new Error(`${field} is invalid.`);
  return result;
}

function optionalNumber(value, min, max, field) {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${field} is invalid.`);
  return result;
}

function validMember(database, userId) {
  return householdMembers(database).some((member) => Number(member.id) === Number(userId));
}

function validPlace(database, placeId, { includeInactive = true } = {}) {
  if (!placeId) return null;
  return database.prepare(`SELECT * FROM places WHERE id = ?${includeInactive ? '' : ' AND active = 1'}`).get(placeId) ?? null;
}

function createsPlaceCycle(database, id, parentId) {
  if (!id || !parentId) return false;
  const seen = new Set([Number(id)]);
  let current = validPlace(database, parentId);
  while (current) {
    if (seen.has(Number(current.id))) return true;
    seen.add(Number(current.id));
    current = current.parent_place_id ? validPlace(database, current.parent_place_id) : null;
  }
  return false;
}

function placeUsage(database, id) {
  const scalar = (sql) => database.prepare(sql).get(id)?.n ?? 0;
  return {
    children: scalar('SELECT COUNT(*) AS n FROM places WHERE parent_place_id = ?'),
    weekly_rules: scalar('SELECT COUNT(*) AS n FROM availability_rules WHERE place_id = ?'),
    dated_periods: scalar('SELECT COUNT(*) AS n FROM availability_periods WHERE place_id = ?'),
    activity_templates: scalar('SELECT COUNT(*) AS n FROM activity_templates WHERE place_id = ?'),
    workflow_steps: scalar('SELECT COUNT(*) AS n FROM workflow_template_steps WHERE place_id = ?'),
    task_contexts: scalar('SELECT COUNT(*) AS n FROM task_planning_context WHERE place_id = ?'),
    task_locations: scalar('SELECT COUNT(*) AS n FROM task_locations WHERE place_id = ?'),
    meal_slots: scalar('SELECT COUNT(*) AS n FROM meal_schedule_slots WHERE place_id = ?'),
    calendar_events: scalar('SELECT COUNT(*) AS n FROM calendar_events WHERE place_id = ?'),
    meals: scalar('SELECT COUNT(*) AS n FROM meals WHERE place_id = ?'),
  };
}

function listPlaces(database, { activeOnly = false } = {}) {
  return database.prepare(`
    SELECT * FROM places ${activeOnly ? 'WHERE active = 1' : ''}
     ORDER BY name COLLATE NOCASE, id
  `).all().map((place) => ({
    ...placeWithInheritedAddress(database, place),
    usage: placeUsage(database, place.id),
  }));
}

function normalizePlace(database, body, existing = null) {
  const parentPlaceId = integer(body.parent_place_id ?? existing?.parent_place_id);
  if (parentPlaceId && !validPlace(database, parentPlaceId)) throw new Error('Parent place does not exist.');
  if (existing && createsPlaceCycle(database, existing.id, parentPlaceId)) throw new Error('A place cannot be its own parent or descendant.');
  return {
    name: string(body.name ?? existing?.name, { required: true, max: 120 }),
    description: string(body.description ?? existing?.description, { max: 1000 }),
    type: enumValue(body.type, PLACE_TYPES, existing?.type ?? 'custom', 'Place type'),
    parentPlaceId,
    streetAddress: string(body.street_address ?? existing?.street_address, { max: 250 }),
    city: string(body.city ?? existing?.city, { max: 120 }),
    region: string(body.region ?? existing?.region, { max: 120 }),
    postalCode: string(body.postal_code ?? existing?.postal_code, { max: 40 }),
    country: string(body.country ?? existing?.country, { max: 120 }),
    latitude: optionalNumber(body.latitude ?? existing?.latitude, -90, 90, 'Latitude'),
    longitude: optionalNumber(body.longitude ?? existing?.longitude, -180, 180, 'Longitude'),
    active: boolean(body.active, existing ? Boolean(existing.active) : true),
  };
}

function normalizeTime(value, field) {
  const result = string(value, { required: true, max: 5 });
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new Error(`${field} must use HH:MM.`);
  return result;
}

function normalizeRule(database, body, existing = null) {
  const userId = integer(body.user_id ?? existing?.user_id, { required: true });
  if (!validMember(database, userId)) throw new Error('Household member does not exist.');
  const weekdays = body.weekdays ?? (existing ? JSON.parse(existing.weekdays_json) : []);
  if (!Array.isArray(weekdays)) throw new Error('Weekdays must be a list.');
  const normalizedWeekdays = [...new Set(weekdays.map(Number))].sort();
  if (!normalizedWeekdays.length || normalizedWeekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('Choose at least one valid weekday.');
  }
  const state = enumValue(body.state, STATES, existing?.state ?? 'available', 'Availability state');
  const customState = string(body.custom_state ?? existing?.custom_state, { max: 120 });
  if (state === 'custom' && !customState) throw new Error('Custom availability needs a label.');
  const placeId = integer(body.place_id ?? existing?.place_id);
  const place = placeId ? validPlace(database, placeId) : null;
  if (placeId && (!place || (!place.active && Number(existing?.place_id) !== Number(placeId)))) throw new Error('Choose an active place.');
  return {
    userId,
    name: string(body.name ?? existing?.name, { required: true, max: 120 }),
    weekdays: normalizedWeekdays,
    startTime: normalizeTime(body.start_time ?? existing?.start_time, 'Start time'),
    endTime: normalizeTime(body.end_time ?? existing?.end_time, 'End time'),
    state,
    customState: state === 'custom' ? customState : null,
    placeId,
    category: enumValue(body.category, CATEGORIES, existing?.category ?? 'general', 'Schedule category'),
    active: boolean(body.active, existing ? Boolean(existing.active) : true),
  };
}

function normalizeDateTime(value, field, { required = true } = {}) {
  const result = string(value, { required, max: 40 });
  if (!result) return null;
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime()) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(result)) {
    throw new Error(`${field} is invalid.`);
  }
  return result;
}

function normalizePeriod(database, body, existing = null) {
  const userId = integer(body.user_id ?? existing?.user_id, { required: true });
  if (!validMember(database, userId)) throw new Error('Household member does not exist.');
  const startsAt = normalizeDateTime(body.starts_at ?? existing?.starts_at, 'Start');
  const endsAt = normalizeDateTime(body.ends_at ?? existing?.ends_at, 'End', { required: false });
  if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new Error('End must be after start.');
  const state = enumValue(body.state, STATES, existing?.state ?? 'unknown', 'Availability state');
  const customState = string(body.custom_state ?? existing?.custom_state, { max: 120 });
  if (state === 'custom' && !customState) throw new Error('Custom availability needs a label.');
  const placeId = integer(body.place_id ?? existing?.place_id);
  const place = placeId ? validPlace(database, placeId) : null;
  if (placeId && (!place || (!place.active && Number(existing?.place_id) !== Number(placeId)))) throw new Error('Choose an active place.');
  return {
    userId,
    source: enumValue(body.source, SOURCES, existing?.source ?? 'explicit', 'Availability source'),
    category: enumValue(body.category, CATEGORIES, existing?.category ?? 'general', 'Schedule category'),
    state,
    customState: state === 'custom' ? customState : null,
    placeId,
    startsAt,
    endsAt,
    note: string(body.note ?? existing?.note, { max: 1000 }),
    active: boolean(body.active, existing ? Boolean(existing.active) : true),
  };
}

router.get('/places', (req, res) => {
  try { res.json({ data: listPlaces(db.get(), { activeOnly: req.query.active !== 'false' }) }); }
  catch (error) { log.error('GET /places', error); res.status(500).json({ error: 'Could not load places.', code: 500 }); }
});

router.get('/place-search/status', (_req, res) => {
  res.json({ data: googlePlacesStatus() });
});

router.post('/place-search', async (req, res) => {
  try {
    const database = db.get();
    const originId = integer(req.body.origin_place_id, { required: true });
    const origin = placeWithInheritedAddress(database, validPlace(database, originId, { includeInactive: false }));
    if (!origin) return res.status(400).json({ error: 'Choose an active saved Place as the search origin.', code: 400 });
    if (origin.latitude == null || origin.longitude == null) {
      return res.status(400).json({
        error: 'The selected search origin needs latitude and longitude in Yuvomi Places.',
        code: 400,
        reason: 'origin_coordinates_required',
      });
    }
    const results = await searchGooglePlaces(database, {
      userId: currentUserId(req),
      query: req.body.query,
      origin: { latitude: origin.latitude, longitude: origin.longitude },
    });
    res.json({ data: results, origin: { place_id: origin.id, label: origin.path_label } });
  } catch (error) {
    if (error instanceof PlaceProviderError) {
      return res.status(error.status).json({ error: error.message, code: error.status, reason: error.code });
    }
    log.error('POST /place-search', error);
    res.status(500).json({ error: 'Could not search Places.', code: 500 });
  }
});

router.get('/admin/context', requireAdmin, (_req, res) => {
  try {
    const database = db.get();
    res.json({
      places: listPlaces(database),
      members: householdMembers(database),
      rules: database.prepare(`
        SELECT ar.*, u.display_name, p.name AS place_name
          FROM availability_rules ar JOIN users u ON u.id = ar.user_id
          LEFT JOIN places p ON p.id = ar.place_id
         ORDER BY u.display_name COLLATE NOCASE, ar.name COLLATE NOCASE, ar.id
      `).all().map((row) => ({ ...row, weekdays: JSON.parse(row.weekdays_json), weekdays_json: undefined })),
      periods: database.prepare(`
        SELECT ap.*, u.display_name, p.name AS place_name
          FROM availability_periods ap JOIN users u ON u.id = ap.user_id
          LEFT JOIN places p ON p.id = ap.place_id
         ORDER BY ap.starts_at DESC, ap.id DESC
      `).all(),
    });
  } catch (error) { log.error('GET /admin/context', error); res.status(500).json({ error: 'Could not load availability.', code: 500 }); }
});

router.post('/admin/places', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const input = normalizePlace(database, req.body);
    const result = database.prepare(`
      INSERT INTO places (
        name, description, type, parent_place_id, street_address, city, region, postal_code, country,
        latitude, longitude, active, created_by, coordinate_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name, input.description, input.type, input.parentPlaceId, input.streetAddress, input.city,
      input.region, input.postalCode, input.country, input.latitude, input.longitude, input.active,
      currentUserId(req), input.latitude != null && input.longitude != null ? 'user' : null,
    );
    res.status(201).json({ data: placeWithInheritedAddress(database, validPlace(database, result.lastInsertRowid)) });
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

router.post('/admin/places/from-google', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const externalPlaceId = string(req.body.external_place_id, { required: true, max: 250 });
    const existing = database.prepare(`
      SELECT * FROM places WHERE external_provider = 'google' AND external_place_id = ?
    `).get(externalPlaceId);
    if (existing) {
      return res.status(409).json({
        error: 'That Google place is already saved in Yuvomi Places.',
        code: 409,
        data: placeWithInheritedAddress(database, existing),
      });
    }
    // Name and address remain explicitly user-maintained Yuvomi fields. We do
    // not silently turn the transient Google result payload into an address-book entry.
    const input = normalizePlace(database, req.body);
    const coordinateExpiry = input.latitude != null && input.longitude != null
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const result = database.prepare(`
      INSERT INTO places (
        name, description, type, parent_place_id, street_address, city, region, postal_code, country,
        latitude, longitude, active, created_by, external_provider, external_place_id,
        external_place_id_checked_at, coordinate_source, coordinates_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'google', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?)
    `).run(
      input.name, input.description, input.type, input.parentPlaceId, input.streetAddress, input.city,
      input.region, input.postalCode, input.country, input.latitude, input.longitude, input.active,
      currentUserId(req), externalPlaceId,
      input.latitude != null && input.longitude != null ? 'google' : null,
      coordinateExpiry,
    );
    res.status(201).json({ data: placeWithInheritedAddress(database, validPlace(database, result.lastInsertRowid)) });
  } catch (error) {
    res.status(400).json({ error: error.message, code: 400 });
  }
});

router.put('/admin/places/:id', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const existing = validPlace(database, integer(req.params.id, { required: true }));
    if (!existing) return res.status(404).json({ error: 'Place not found.', code: 404 });
    const input = normalizePlace(database, req.body, existing);
    const coordinatesTouched = Object.hasOwn(req.body, 'latitude') || Object.hasOwn(req.body, 'longitude');
    database.prepare(`
      UPDATE places SET name = ?, description = ?, type = ?, parent_place_id = ?, street_address = ?, city = ?, region = ?, postal_code = ?, country = ?, latitude = ?, longitude = ?, active = ?,
        coordinate_source = CASE WHEN ? THEN 'user' ELSE coordinate_source END,
        coordinates_expires_at = CASE WHEN ? THEN NULL ELSE coordinates_expires_at END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(
      input.name, input.description, input.type, input.parentPlaceId, input.streetAddress, input.city,
      input.region, input.postalCode, input.country, input.latitude, input.longitude, input.active,
      coordinatesTouched ? 1 : 0, coordinatesTouched ? 1 : 0, existing.id,
    );
    res.json({ data: placeWithInheritedAddress(database, validPlace(database, existing.id)) });
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

router.delete('/admin/places/:id', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const id = integer(req.params.id, { required: true });
    const place = validPlace(database, id);
    if (!place) return res.status(404).json({ error: 'Place not found.', code: 404 });
    const usage = placeUsage(database, id);
    const guarded = Object.entries(usage).filter(([key, count]) => !['calendar_events', 'meals'].includes(key) && count > 0);
    if (guarded.length) return res.status(409).json({ error: 'This place is still used by schedules, templates, tasks, or child places. Make it inactive instead.', code: 409, usage });
    database.prepare('DELETE FROM places WHERE id = ?').run(id);
    res.status(204).end();
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

router.post('/admin/rules', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const input = normalizeRule(database, req.body);
    const result = database.prepare(`
      INSERT INTO availability_rules (user_id, name, weekdays_json, start_time, end_time, state, custom_state, place_id, category, active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.userId, input.name, JSON.stringify(input.weekdays), input.startTime, input.endTime, input.state, input.customState, input.placeId, input.category, input.active, currentUserId(req));
    res.status(201).json({ data: database.prepare('SELECT * FROM availability_rules WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

router.put('/admin/rules/:id', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const existing = database.prepare('SELECT * FROM availability_rules WHERE id = ?').get(integer(req.params.id, { required: true }));
    if (!existing) return res.status(404).json({ error: 'Availability rule not found.', code: 404 });
    const input = normalizeRule(database, req.body, existing);
    database.prepare(`
      UPDATE availability_rules SET user_id = ?, name = ?, weekdays_json = ?, start_time = ?, end_time = ?, state = ?, custom_state = ?, place_id = ?, category = ?, active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(input.userId, input.name, JSON.stringify(input.weekdays), input.startTime, input.endTime, input.state, input.customState, input.placeId, input.category, input.active, existing.id);
    res.json({ data: database.prepare('SELECT * FROM availability_rules WHERE id = ?').get(existing.id) });
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

router.delete('/admin/rules/:id', requireAdmin, (req, res) => {
  const result = db.get().prepare('DELETE FROM availability_rules WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Availability rule not found.', code: 404 });
  res.status(204).end();
});

router.post('/admin/periods', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const input = normalizePeriod(database, req.body);
    const result = database.prepare(`
      INSERT INTO availability_periods (user_id, source, category, state, custom_state, place_id, starts_at, ends_at, note, active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.userId, input.source, input.category, input.state, input.customState, input.placeId, input.startsAt, input.endsAt, input.note, input.active, currentUserId(req));
    res.status(201).json({ data: database.prepare('SELECT * FROM availability_periods WHERE id = ?').get(result.lastInsertRowid) });
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

router.put('/admin/periods/:id', requireAdmin, (req, res) => {
  try {
    const database = db.get();
    const existing = database.prepare('SELECT * FROM availability_periods WHERE id = ?').get(integer(req.params.id, { required: true }));
    if (!existing) return res.status(404).json({ error: 'Availability period not found.', code: 404 });
    const input = normalizePeriod(database, req.body, existing);
    database.prepare(`
      UPDATE availability_periods SET user_id = ?, source = ?, category = ?, state = ?, custom_state = ?, place_id = ?, starts_at = ?, ends_at = ?, note = ?, active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
    `).run(input.userId, input.source, input.category, input.state, input.customState, input.placeId, input.startsAt, input.endsAt, input.note, input.active, existing.id);
    res.json({ data: database.prepare('SELECT * FROM availability_periods WHERE id = ?').get(existing.id) });
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

router.delete('/admin/periods/:id', requireAdmin, (req, res) => {
  const result = db.get().prepare('DELETE FROM availability_periods WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Availability period not found.', code: 404 });
  res.status(204).end();
});

router.get('/presence/:userId', (req, res) => {
  try {
    const database = db.get();
    const userId = integer(req.params.userId, { required: true });
    if (!validMember(database, userId)) return res.status(404).json({ error: 'Household member not found.', code: 404 });
    const policy = enumValue(req.query.policy, POLICIES, 'ignore', 'Presence policy');
    const startAt = string(req.query.start_at ?? new Date().toISOString(), { required: true, max: 40 });
    const endAt = string(req.query.end_at ?? startAt, { required: true, max: 40 });
    const targetPlaceId = integer(req.query.place_id);
    if (targetPlaceId && !validPlace(database, targetPlaceId)) throw new Error('Target place does not exist.');
    res.json({ data: evaluatePresence(database, { userId, startAt, endAt, targetPlaceId, policy }) });
  } catch (error) { res.status(400).json({ error: error.message, code: 400 }); }
});

export default router;
