/**
 * Modul: Essensplan (Meals)
 * Zweck: REST-API-Routen für Mahlzeiten, Zutaten und Einkaufslisten-Integration
 * Abhängigkeiten: express, server/db.js, server/auth.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { str, oneOf, date, num, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT, DATE_RE } from '../middleware/validate.js';
import { addDays, mealWeekday, datesForTemplateInRange } from '../services/meal-recurrence.js';
import { todayKey } from '../utils/timezone.js';
import { requireAdmin } from '../auth.js';
import { evaluatePresence } from '../services/presence.js';

const log = createLogger('Meals');

const router  = express.Router();

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = Monday, 6 = Sunday
const VALID_MEAL_SCOPES = ['household', 'personal', 'restaurant', 'takeout', 'skipped', 'travel'];
const VALID_SCHEDULE_POLICIES = ['fixed', 'round_robin', 'personal_choice'];
const VALID_PARTICIPANT_ROLES = ['chooser', 'cook', 'participant', 'supervisor'];
const VALID_PARTICIPANT_STATUSES = ['participating', 'not_participating', 'away', 'needs_confirmation'];

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

/**
 * Gibt den ISO-Datumstring (YYYY-MM-DD) für den Montag einer Woche zurück.
 * @param {string} dateStr - beliebiges Datum der Woche (YYYY-MM-DD)
 */
function weekStart(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();          // 0 = So, 1 = Mo, …
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Gibt den ISO-Datumstring für den Sonntag einer Woche zurück.
 */
function weekEnd(dateStr) {
  const start = weekStart(dateStr);
  const d     = new Date(start + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function insertMealIngredients(mealId, ingredients) {
  const insertIng = db.get().prepare(`
    INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, ?, ?, ?)
  `);

  for (const ing of ingredients) {
    insertIng.run(mealId, ing.name, ing.quantity, ing.category || 'Sonstiges');
  }
}

function sanitizedIngredients(ingredients) {
  return ingredients
    .map((ing) => ({
      name: String(ing.name || '').trim().slice(0, MAX_TITLE),
      quantity: String(ing.quantity || '').trim().slice(0, MAX_SHORT) || null,
      category: String(ing.category || '').trim().slice(0, MAX_SHORT) || 'Sonstiges',
    }))
    .filter((ing) => ing.name);
}

function loadMealWithIngredients(id) {
  const meal = db.get().prepare(`
    SELECT m.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
           mrt.end_date AS recurrence_end_date
    FROM meals m
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN meal_recurrence_templates mrt ON mrt.id = m.recurrence_template_id
    WHERE m.id = ?
  `).get(id);
  if (!meal) return null;
  const ingredients = db.get().prepare('SELECT * FROM meal_ingredients WHERE meal_id = ? ORDER BY id ASC').all(id);
  const participants = loadMealParticipants([id])[id] || [];
  return { ...meal, ingredients, participants };
}

function householdPlanningMembers() {
  return db.get().prepare(`
    SELECT u.id, u.display_name, u.avatar_color
      FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM split_expense_guest_users g WHERE g.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
     ORDER BY u.display_name COLLATE NOCASE, u.id
  `).all();
}

function loadMealParticipants(mealIds) {
  if (!mealIds.length) return {};
  const rows = db.get().prepare(`
    SELECT mp.*, u.display_name, u.avatar_color
      FROM meal_participants mp
      JOIN users u ON u.id = mp.user_id
     WHERE mp.meal_id IN (${mealIds.map(() => '?').join(',')})
     ORDER BY mp.meal_id, mp.role, u.display_name COLLATE NOCASE
  `).all(...mealIds);
  return rows.reduce((map, row) => {
    (map[row.meal_id] ||= []).push(row);
    return map;
  }, {});
}

function normalizeMealParticipants(raw) {
  if (!Array.isArray(raw)) return [];
  const validUsers = new Set(householdPlanningMembers().map((member) => Number(member.id)));
  const unique = new Map();
  for (const item of raw) {
    const userId = Number(item?.user_id);
    const role = String(item?.role || 'participant');
    const status = String(item?.status || 'participating');
    if (!validUsers.has(userId)) throw new Error('Choose a valid household member.');
    if (!VALID_PARTICIPANT_ROLES.includes(role)) throw new Error('Choose a valid meal role.');
    if (!VALID_PARTICIPANT_STATUSES.includes(status)) throw new Error('Choose a valid participation status.');
    unique.set(`${userId}:${role}`, { user_id: userId, role, status });
  }
  return [...unique.values()];
}

function replaceMealParticipants(mealId, participants, source = 'manual') {
  const clean = normalizeMealParticipants(participants);
  db.get().prepare('DELETE FROM meal_participants WHERE meal_id = ?').run(mealId);
  const insert = db.get().prepare(`
    INSERT INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const participant of clean) {
    insert.run(mealId, participant.user_id, participant.role, participant.status, source);
  }
}

function validTime(value) {
  return value == null || value === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value));
}

function orderedTimeWindow(earliest, preferred, latest) {
  const values = [earliest, preferred, latest].filter(Boolean);
  return values.every((value, index) => index === 0 || values[index - 1] <= value);
}

function loadMealPlanning() {
  const d = db.get();
  const timings = d.prepare('SELECT * FROM meal_timing_defaults ORDER BY CASE meal_type WHEN \'breakfast\' THEN 0 WHEN \'lunch\' THEN 1 WHEN \'dinner\' THEN 2 ELSE 3 END').all();
  const slots = d.prepare('SELECT * FROM meal_schedule_slots ORDER BY weekday, CASE meal_type WHEN \'breakfast\' THEN 0 WHEN \'lunch\' THEN 1 WHEN \'dinner\' THEN 2 ELSE 3 END').all();
  const participants = d.prepare('SELECT schedule_slot_id, user_id FROM meal_schedule_slot_participants ORDER BY schedule_slot_id, user_id').all();
  const bySlot = participants.reduce((map, row) => {
    (map[row.schedule_slot_id] ||= []).push(row.user_id);
    return map;
  }, {});
  return {
    timing_defaults: timings,
    slots: slots.map((slot) => ({ ...slot, participant_ids: bySlot[slot.id] || [] })),
    members: householdPlanningMembers(),
    places: d.prepare('SELECT * FROM places ORDER BY active DESC, name COLLATE NOCASE, id').all(),
  };
}

function materializeMealSchedule(from, to, actorId = null) {
  const d = db.get();
  const slots = d.prepare('SELECT * FROM meal_schedule_slots WHERE active = 1 ORDER BY weekday, meal_type, id').all();
  if (!slots.length) return 0;
  const defaults = Object.fromEntries(d.prepare('SELECT * FROM meal_timing_defaults').all().map((row) => [row.meal_type, row]));
  const participantRows = d.prepare('SELECT user_id FROM meal_schedule_slot_participants WHERE schedule_slot_id = ? ORDER BY user_id');
  const hasException = d.prepare('SELECT 1 FROM meal_schedule_exceptions WHERE schedule_slot_id = ? AND date = ? AND action = \'skip\'');
  const hasMeal = d.prepare('SELECT 1 FROM meals WHERE date = ? AND meal_type = ? AND superseded_by_id IS NULL');
  const insertMeal = d.prepare(`
    INSERT OR IGNORE INTO meals (
      date, meal_type, title, scope, scheduled_time, earliest_time, preferred_time, latest_time,
      expected_duration_minutes, source, source_key, schedule_slot_id, schedule_revision,
      provenance_json, created_by
      , place_id
    ) VALUES (?, ?, ?, 'household', ?, ?, ?, ?, ?, 'schedule', ?, ?, ?, ?, ?, ?)
  `);
  const insertParticipant = d.prepare(`
    INSERT OR IGNORE INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, ?, 'schedule')
  `);
  const insertObligation = d.prepare(`
    INSERT OR IGNORE INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id, responsible_group, due_at, fallback_source
    ) VALUES ('meal', ?, ?, 'chooser', ?, ?, ?, ?)
  `);
  let created = 0;
  d.transaction(() => {
    for (const slot of slots) {
      const participants = participantRows.all(slot.id).map((row) => Number(row.user_id));
      for (let dateKey = from; dateKey <= to; dateKey = addDays(dateKey, 1)) {
        if (mealWeekday(dateKey) !== slot.weekday || hasException.get(slot.id, dateKey) || hasMeal.get(dateKey, slot.meal_type)) continue;
        const timing = defaults[slot.meal_type] || {};
        const preferred = slot.preferred_time || timing.preferred_time || null;
        const earliest = slot.earliest_time || timing.earliest_time || preferred || '00:00';
        const latest = slot.latest_time || timing.latest_time || preferred || '23:59';
        const presenceCandidates = [...new Set([
          ...participants,
          slot.fixed_user_id ? Number(slot.fixed_user_id) : null,
          slot.fallback_user_id ? Number(slot.fallback_user_id) : null,
        ].filter(Boolean))];
        const availability = new Map(presenceCandidates.map((userId) => {
          if (!slot.presence_required) return [userId, { eligible: true, effective: null }];
          try {
            return [userId, evaluatePresence(d, {
              userId,
              startAt: `${dateKey}T${earliest}:00`,
              endAt: `${dateKey}T${latest}:00`,
              targetPlaceId: slot.place_id || null,
              policy: 'available_before_due',
            })];
          } catch { return [userId, { eligible: false, effective: null }]; }
        }));
        const eligibleParticipants = participants.filter((userId) => availability.get(userId)?.eligible);
        let chooserId = slot.fixed_user_id || null;
        if (slot.presence_required && chooserId && !availability.get(Number(chooserId))?.eligible) {
          chooserId = slot.fallback_user_id && availability.get(Number(slot.fallback_user_id))?.eligible
            ? Number(slot.fallback_user_id) : null;
        }
        if (slot.policy === 'round_robin' && eligibleParticipants.length) {
          const previous = d.prepare('SELECT COUNT(*) AS n FROM meals WHERE schedule_slot_id = ? AND date < ?').get(slot.id, dateKey).n;
          chooserId = eligibleParticipants[previous % eligibleParticipants.length];
        }
        const sourceKey = `meal-schedule:${slot.id}:${dateKey}`;
        const result = insertMeal.run(
          dateKey, slot.meal_type, `Choose ${slot.meal_type}`,
          preferred, slot.earliest_time || timing.earliest_time || null, preferred,
          slot.latest_time || timing.latest_time || null,
          slot.expected_duration_minutes || timing.expected_duration_minutes || null,
          sourceKey, slot.id, slot.revision,
          JSON.stringify({ source: 'schedule', slot_id: slot.id, revision: slot.revision, policy: slot.policy }),
          actorId || slot.created_by,
          slot.place_id || null,
        );
        if (!result.changes) continue;
        const mealId = Number(result.lastInsertRowid);
        for (const userId of participants) {
          const signal = availability.get(userId);
          insertParticipant.run(mealId, userId, 'participant', signal?.eligible ? 'participating' : 'away');
        }
        if (slot.policy === 'personal_choice') {
          for (const userId of eligibleParticipants) insertParticipant.run(mealId, userId, 'chooser', 'participating');
        } else if (chooserId) insertParticipant.run(mealId, chooserId, 'chooser', 'participating');
        if (chooserId || slot.policy === 'personal_choice') {
          insertObligation.run(
            mealId, `${sourceKey}:chooser`, chooserId,
            slot.policy === 'personal_choice' ? (slot.rotation_group || 'meal-participants') : null,
            preferred ? `${dateKey}T${preferred}:00` : `${dateKey}T23:59:00`,
            slot.fallback_user_id ? `user:${slot.fallback_user_id}` : null,
          );
        }
        created += 1;
      }
    }
  })();
  return created;
}

function deleteMealOccurrence(meal, actorId) {
  if (!meal) return;
  if (meal.recurrence_template_id) {
    db.get().prepare(`
      INSERT OR IGNORE INTO meal_recurrence_exceptions (template_id, date, created_by)
      VALUES (?, ?, ?)
    `).run(meal.recurrence_template_id, meal.date, actorId);
  }
  if (meal.schedule_slot_id) {
    db.get().prepare(`
      INSERT INTO meal_schedule_exceptions (schedule_slot_id, date, action, created_by)
      VALUES (?, ?, 'skip', ?)
      ON CONFLICT(schedule_slot_id, date) DO UPDATE SET action = 'skip', created_by = excluded.created_by
    `).run(meal.schedule_slot_id, meal.date, actorId);
  }
  db.get().prepare("DELETE FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ?")
    .run(meal.id);
  db.get().prepare('DELETE FROM meals WHERE id = ?').run(meal.id);
}

function createMealRecord({ date, meal_type, title, notes, recipe_url, recipe_id, ingredients = [] }, actorId) {
  const cleanIngredients = sanitizedIngredients(ingredients);
  const result = db.get().prepare(`
    INSERT INTO meals (date, meal_type, title, notes, recipe_url, recipe_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(date, meal_type, title, notes, recipe_url, recipe_id, actorId);
  insertMealIngredients(result.lastInsertRowid, cleanIngredients);
  return loadMealWithIngredients(result.lastInsertRowid);
}

function materializeRecurringMeals(from, to) {
  const templates = db.get().prepare(`
    SELECT *
    FROM meal_recurrence_templates
    WHERE start_date <= ?
      AND (end_date IS NULL OR end_date >= ?)
    ORDER BY id ASC
  `).all(to, from);

  if (!templates.length) return;

  const createMeals = db.get().transaction(() => {
    const hasException = db.get().prepare(`
      SELECT 1
      FROM meal_recurrence_exceptions
      WHERE template_id = ? AND date = ?
    `);
    const hasMeal = db.get().prepare(`
      SELECT 1
      FROM meals
      WHERE recurrence_template_id = ? AND date = ?
    `);
    const templateIngredients = db.get().prepare(`
      SELECT name, quantity, category
      FROM meal_recurrence_ingredients
      WHERE template_id = ?
      ORDER BY id ASC
    `);
    const insertMeal = db.get().prepare(`
      INSERT INTO meals (
        date, meal_type, title, notes, recipe_url, recipe_id, recurrence_template_id,
        created_by, source, source_key, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recurrence', ?, ?)
    `);

    for (const template of templates) {
      if (!VALID_WEEKDAYS.includes(template.weekday)) continue;
      const ingredients = templateIngredients.all(template.id);
      for (const date of datesForTemplateInRange(template, from, to)) {
        if (hasException.get(template.id, date) || hasMeal.get(template.id, date)) continue;
        const result = insertMeal.run(
          date,
          template.meal_type,
          template.title,
          template.notes,
          template.recipe_url,
          template.recipe_id,
          template.id,
          template.created_by,
          `legacy-recurrence:${template.id}:${date}`,
          JSON.stringify({ source: 'recurrence', template_id: template.id }),
        );
        insertMealIngredients(result.lastInsertRowid, ingredients);
      }
    }
  });

  createMeals();
}

// --------------------------------------------------------
// Routen - Mahlzeiten-Vorschläge (vor dynamischen Routen!)
// --------------------------------------------------------

/**
 * GET /api/v1/meals/suggestions
 * Autocomplete für Mahlzeit-Titel aus der Historie.
 * Query: ?q=<string>
 * Response: { data: [{ title, meal_type }] }
 */
router.get('/suggestions', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ data: [] });

    const rows = db.get().prepare(`
      SELECT DISTINCT title, meal_type
      FROM meals
      WHERE title LIKE ? COLLATE NOCASE
      ORDER BY title ASC
      LIMIT 10
    `).all(`${q}%`);

    res.json({ data: rows });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.get('/planning', (req, res) => {
  try {
    res.json({ data: loadMealPlanning() });
  } catch (err) {
    log.error('GET /planning', err);
    res.status(500).json({ error: 'Could not load meal planning settings.', code: 500 });
  }
});

router.put('/planning', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const actorId = req.authUserId || req.session.userId;
    const timingDefaults = Array.isArray(req.body.timing_defaults) ? req.body.timing_defaults : [];
    const slots = Array.isArray(req.body.slots) ? req.body.slots : [];
    const validUsers = new Set(householdPlanningMembers().map((member) => Number(member.id)));

    for (const timing of timingDefaults) {
      if (!VALID_MEAL_TYPES.includes(timing.meal_type)) throw new Error('Choose a valid meal type.');
      if (![timing.earliest_time, timing.preferred_time, timing.latest_time].every(validTime)) throw new Error('Meal times must use HH:MM.');
      if (!orderedTimeWindow(timing.earliest_time, timing.preferred_time, timing.latest_time)) throw new Error('Meal timing must run from earliest to preferred to latest.');
      const duration = Number(timing.expected_duration_minutes || 30);
      if (!Number.isInteger(duration) || duration < 1 || duration > 720) throw new Error('Meal duration must be between 1 and 720 minutes.');
    }
    for (const slot of slots) {
      const weekday = Number(slot.weekday);
      if (!VALID_WEEKDAYS.includes(weekday) || !VALID_MEAL_TYPES.includes(slot.meal_type)) throw new Error('Choose a valid weekday and meal type.');
      if (!VALID_SCHEDULE_POLICIES.includes(slot.policy || 'fixed')) throw new Error('Choose a valid schedule policy.');
      if (![slot.earliest_time, slot.preferred_time, slot.latest_time].every(validTime)) throw new Error('Meal times must use HH:MM.');
      if (!orderedTimeWindow(slot.earliest_time, slot.preferred_time, slot.latest_time)) throw new Error('Meal timing must run from earliest to preferred to latest.');
      for (const userId of [slot.fixed_user_id, slot.fallback_user_id].filter(Boolean).map(Number)) {
        if (!validUsers.has(userId)) throw new Error('Choose a valid household member.');
      }
      for (const userId of (slot.participant_ids || []).map(Number)) {
        if (!validUsers.has(userId)) throw new Error('Choose valid meal participants.');
      }
      if (slot.place_id) {
        const placeId = Number(slot.place_id);
        const place = d.prepare('SELECT active FROM places WHERE id = ?').get(placeId);
        const existingSlot = d.prepare('SELECT place_id FROM meal_schedule_slots WHERE weekday = ? AND meal_type = ?')
          .get(weekday, slot.meal_type);
        if (!place || (!place.active && Number(existingSlot?.place_id) !== placeId)) {
          throw new Error('Choose an active Place for the meal slot.');
        }
      }
    }

    d.transaction(() => {
      const saveTiming = d.prepare(`
        INSERT INTO meal_timing_defaults (meal_type, earliest_time, preferred_time, latest_time, expected_duration_minutes, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(meal_type) DO UPDATE SET
          earliest_time = excluded.earliest_time, preferred_time = excluded.preferred_time,
          latest_time = excluded.latest_time, expected_duration_minutes = excluded.expected_duration_minutes,
          updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `);
      for (const timing of timingDefaults) {
        saveTiming.run(
          timing.meal_type, timing.earliest_time || null, timing.preferred_time || null,
          timing.latest_time || null, Number(timing.expected_duration_minutes || 30), actorId,
        );
      }

      const saveSlot = d.prepare(`
        INSERT INTO meal_schedule_slots (
          weekday, meal_type, policy, fixed_user_id, fallback_user_id, rotation_group,
          presence_required, earliest_time, preferred_time, latest_time,
          expected_duration_minutes, active, created_by, place_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(weekday, meal_type) DO UPDATE SET
          policy = excluded.policy, fixed_user_id = excluded.fixed_user_id,
          fallback_user_id = excluded.fallback_user_id, rotation_group = excluded.rotation_group,
          presence_required = excluded.presence_required, earliest_time = excluded.earliest_time,
          preferred_time = excluded.preferred_time, latest_time = excluded.latest_time,
          expected_duration_minutes = excluded.expected_duration_minutes, active = excluded.active,
          place_id = excluded.place_id,
          revision = meal_schedule_slots.revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `);
      const findSlot = d.prepare('SELECT id FROM meal_schedule_slots WHERE weekday = ? AND meal_type = ?');
      const clearParticipants = d.prepare('DELETE FROM meal_schedule_slot_participants WHERE schedule_slot_id = ?');
      const addParticipant = d.prepare('INSERT OR IGNORE INTO meal_schedule_slot_participants (schedule_slot_id, user_id) VALUES (?, ?)');
      for (const slot of slots) {
        saveSlot.run(
          Number(slot.weekday), slot.meal_type, slot.policy || 'fixed',
          Number(slot.fixed_user_id) || null, Number(slot.fallback_user_id) || null,
          String(slot.rotation_group || '').trim() || null, slot.presence_required ? 1 : 0,
          slot.earliest_time || null, slot.preferred_time || null, slot.latest_time || null,
          Number(slot.expected_duration_minutes) || null, slot.active ? 1 : 0, actorId,
          Number(slot.place_id) || null,
        );
        const scheduleSlotId = findSlot.get(Number(slot.weekday), slot.meal_type).id;
        clearParticipants.run(scheduleSlotId);
        for (const userId of [...new Set((slot.participant_ids || []).map(Number))]) addParticipant.run(scheduleSlotId, userId);
      }

      // Reconcile only untouched generated placeholders. Meals that the household
      // has named or otherwise customized are dated overrides and remain intact.
      const stale = d.prepare(`
        SELECT id FROM meals
         WHERE source = 'schedule' AND date >= ? AND title = 'Choose ' || meal_type
      `).all(todayKey(d));
      const deleteObligations = d.prepare("DELETE FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ?");
      const deleteMeal = d.prepare('DELETE FROM meals WHERE id = ?');
      for (const row of stale) {
        deleteObligations.run(row.id);
        deleteMeal.run(row.id);
      }
    })();

    res.json({ data: loadMealPlanning() });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.post('/planning/materialize', (req, res) => {
  try {
    const refDate = req.body.week && DATE_RE.test(req.body.week) ? req.body.week : todayKey(db.get());
    const from = weekStart(refDate);
    const to = weekEnd(refDate);
    const created = materializeMealSchedule(from, to, req.authUserId || req.session.userId);
    res.json({ data: { created, weekStart: from, weekEnd: to } });
  } catch (err) {
    log.error('POST /planning/materialize', err);
    res.status(500).json({ error: 'Could not prepare the meal plan.', code: 500 });
  }
});

// --------------------------------------------------------
// Routen - Wochenübersicht
// --------------------------------------------------------

/**
 * GET /api/v1/meals
 * Alle Mahlzeiten einer Woche inkl. Zutaten.
 * Query: ?week=YYYY-MM-DD  (beliebiges Datum der gewünschten Woche; default: aktuelle Woche)
 * Response: { data: Meal[], weekStart: string, weekEnd: string }
 *
 * Meal: { id, date, meal_type, title, notes, created_by, ingredients: Ingredient[] }
 * Ingredient: { id, meal_id, name, quantity, on_shopping_list }
 */
router.get('/', (req, res) => {
  try {
    const refDate = req.query.week && DATE_RE.test(req.query.week)
      ? req.query.week
      : todayKey(db.get());

    const from = weekStart(refDate);
    const to   = weekEnd(refDate);

    materializeRecurringMeals(from, to);
    materializeMealSchedule(from, to, req.authUserId || req.session.userId);

    // recurrence_end_date kommt aus der Vorlage mit: die Oberfläche zeigt im
    // Bearbeiten-Dialog, bis wann die Serie läuft, und muss dafür nicht pro Karte
    // nachfragen. NULL heißt unbegrenzt.
    const meals = db.get().prepare(`
      SELECT m.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
             mrt.end_date AS recurrence_end_date
      FROM meals m
      LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN meal_recurrence_templates mrt ON mrt.id = m.recurrence_template_id
      WHERE m.date BETWEEN ? AND ?
      ORDER BY m.date ASC,
        CASE m.meal_type
          WHEN 'breakfast' THEN 0
          WHEN 'lunch'     THEN 1
          WHEN 'dinner'    THEN 2
          WHEN 'snack'     THEN 3
          ELSE 4
        END ASC
    `).all(from, to);

    // Zutaten für alle Mahlzeiten in einer Abfrage holen
    const mealIds = meals.map((m) => m.id);
    let ingredientMap = {};

    if (mealIds.length > 0) {
      const placeholders = mealIds.map(() => '?').join(',');
      const ingredients  = db.get().prepare(`
        SELECT * FROM meal_ingredients
        WHERE meal_id IN (${placeholders})
        ORDER BY id ASC
      `).all(...mealIds);

      for (const ing of ingredients) {
        if (!ingredientMap[ing.meal_id]) ingredientMap[ing.meal_id] = [];
        ingredientMap[ing.meal_id].push(ing);
      }
    }

    // Aus einem Rezept geplante Mahlzeiten tragen nur dessen recipe_id, keine
    // eigenen meal_ingredients - die entstehen erst beim ersten Transfer
    // (siehe POST /:id/to-shopping-list). Ohne diesen Zähler bliebe der
    // Einkaufslisten-Button auf genau solchen Karten unsichtbar, obwohl die
    // Zutaten bekannt sind. Bewusst nur die ZAHL, keine virtuellen Zutaten:
    // Einträge ohne echte id würden das Zutaten-Formular brechen.
    const recipeCountMap = {};
    const fromRecipe = meals.filter((m) => m.recipe_id && !(ingredientMap[m.id]?.length));
    if (fromRecipe.length > 0) {
      const recipeIds = [...new Set(fromRecipe.map((m) => m.recipe_id))];
      const counts = db.get().prepare(`
        SELECT recipe_id, COUNT(*) AS c FROM recipe_ingredients
        WHERE recipe_id IN (${recipeIds.map(() => '?').join(',')})
        GROUP BY recipe_id
      `).all(...recipeIds);
      const byRecipe = Object.fromEntries(counts.map((r) => [r.recipe_id, r.c]));
      for (const m of fromRecipe) recipeCountMap[m.id] = byRecipe[m.recipe_id] ?? 0;
    }

    const participantMap = loadMealParticipants(mealIds);
    const result = meals.map((m) => ({
      ...m,
      ingredients: ingredientMap[m.id] || [],
      recipe_ingredient_count: recipeCountMap[m.id] ?? 0,
      participants: participantMap[m.id] || [],
    }));

    res.json({ data: result, weekStart: from, weekEnd: to });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// CRUD - Mahlzeiten
// --------------------------------------------------------

/**
 * POST /api/v1/meals
 * Neue Mahlzeit anlegen.
 * Body: { date, meal_type, title, notes?, ingredients?: [{ name, quantity? }] }
 * Response: { data: Meal }
 */
router.post('/', (req, res) => {
  try {
    const { ingredients = [], participants = [] } = req.body;
    const vDate       = date(req.body.date, 'Datum', true);
    const vType       = oneOf(req.body.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ');
    const vTitle      = str(req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes      = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl  = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const vRecipeId   = num(req.body.recipe_id, 'Rezept-ID', { required: false });
    const vScope      = oneOf(req.body.scope || 'household', VALID_MEAL_SCOPES, 'Meal scope');
    const duration = req.body.expected_duration_minutes == null || req.body.expected_duration_minutes === ''
      ? null : Number(req.body.expected_duration_minutes);
    const repeatWeekly = req.body.repeat_weekly === true;
    // Leeres/fehlendes repeat_until heißt „ohne Ende" - die Serie bleibt dann
    // unbegrenzt, wie vor #619, aber jetzt als bewusste Wahl statt als einziger Zustand.
    const vRepeatUntil = repeatWeekly
      ? date(req.body.repeat_until, 'Wiederholungs-Ende')
      : { value: null, error: null };
    const errors = collectErrors([vDate, vType, vTitle, vNotes, vRecipeUrl, vRecipeId, vScope, vRepeatUntil]);
    if (!req.body.meal_type) errors.push('Mahlzeit-Typ ist erforderlich.');
    if (![req.body.scheduled_time, req.body.earliest_time, req.body.preferred_time, req.body.latest_time].every(validTime)) {
      errors.push('Meal times must use HH:MM.');
    }
    if (!orderedTimeWindow(req.body.earliest_time, req.body.preferred_time, req.body.latest_time)) {
      errors.push('Meal timing must run from earliest to preferred to latest.');
    }
    if (duration != null && (!Number.isInteger(duration) || duration < 1 || duration > 720)) {
      errors.push('Meal duration must be between 1 and 720 minutes.');
    }
    if (vRepeatUntil.value && vDate.value && vRepeatUntil.value < vDate.value) {
      errors.push('Wiederholungs-Ende darf nicht vor dem Datum liegen.');
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    if (vRecipeId.value !== null) {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(vRecipeId.value);
      if (!recipeExists) return res.status(400).json({ error: 'Rezept nicht gefunden.', code: 400 });
    }
    const placeId = req.body.place_id == null || req.body.place_id === '' ? null : Number(req.body.place_id);
    if (placeId != null && (!Number.isInteger(placeId) || !db.get().prepare('SELECT 1 FROM places WHERE id = ? AND active = 1').get(placeId))) {
      return res.status(400).json({ error: 'Choose an active Place.', code: 400 });
    }

    let cleanParticipants;
    try { cleanParticipants = normalizeMealParticipants(participants); }
    catch (error) { return res.status(400).json({ error: error.message, code: 400 }); }

    const meal = db.transaction(() => {
      const cleanIngredients = sanitizedIngredients(ingredients);
      let recurrenceTemplateId = null;

      if (repeatWeekly) {
        const template = db.get().prepare(`
          INSERT INTO meal_recurrence_templates
            (start_date, end_date, weekday, meal_type, title, notes, recipe_url, recipe_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          vDate.value,
          vRepeatUntil.value,
          mealWeekday(vDate.value),
          vType.value,
          vTitle.value,
          vNotes.value,
          vRecipeUrl.value,
          vRecipeId.value,
          req.authUserId || req.session.userId
        );
        recurrenceTemplateId = template.lastInsertRowid;

        const insertTemplateIng = db.get().prepare(`
          INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
          VALUES (?, ?, ?, ?)
        `);
        for (const ing of cleanIngredients) {
          insertTemplateIng.run(recurrenceTemplateId, ing.name, ing.quantity, ing.category);
        }
      }

      const result = db.get().prepare(`
        INSERT INTO meals (
          date, meal_type, title, notes, recipe_url, recipe_id, recurrence_template_id, created_by,
          scope, scheduled_time, earliest_time, preferred_time, latest_time,
          expected_duration_minutes, source, provenance_json
          , place_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vDate.value, vType.value, vTitle.value, vNotes.value, vRecipeUrl.value, vRecipeId.value,
        recurrenceTemplateId, req.authUserId || req.session.userId, vScope.value,
        req.body.scheduled_time || null, req.body.earliest_time || null,
        req.body.preferred_time || null, req.body.latest_time || null, duration,
        recurrenceTemplateId ? 'recurrence' : 'manual',
        JSON.stringify({ source: recurrenceTemplateId ? 'recurrence' : 'manual', created_from: 'meal_editor' }),
        placeId,
      );

      const mealId = result.lastInsertRowid;

      insertMealIngredients(mealId, cleanIngredients);
      replaceMealParticipants(mealId, cleanParticipants);

      return loadMealWithIngredients(mealId);
    });

    res.status(201).json({ data: meal });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

router.post('/apply-plan', (req, res) => {
  try {
    const assignments = Array.isArray(req.body.assignments) ? req.body.assignments : [];
    const replaceExisting = req.body.replace_existing === true;
    if (!assignments.length) {
      return res.status(400).json({ error: 'Mindestens eine Mahlzeit ist erforderlich.', code: 400 });
    }

    const prepared = [];
    const recipeIds = new Set();
    for (const assignment of assignments) {
      const vDate = date(assignment.date, 'Datum', true);
      const vType = oneOf(assignment.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ');
      const vTitle = str(assignment.title, 'Titel', { max: MAX_TITLE });
      const vNotes = str(assignment.notes, 'Notizen', { max: MAX_TEXT, required: false });
      const vRecipeUrl = str(assignment.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
      const vRecipeId = num(assignment.recipe_id, 'Rezept-ID', { required: false });
      const errors = collectErrors([vDate, vType, vTitle, vNotes, vRecipeUrl, vRecipeId]);
      if (!assignment.meal_type) errors.push('Mahlzeit-Typ ist erforderlich.');
      if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
      if (vRecipeId.value !== null) recipeIds.add(vRecipeId.value);
      prepared.push({
        date: vDate.value,
        meal_type: vType.value,
        title: vTitle.value,
        notes: vNotes.value,
        recipe_url: vRecipeUrl.value,
        recipe_id: vRecipeId.value,
        ingredients: assignment.ingredients || [],
      });
    }

    for (const recipeId of recipeIds) {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId);
      if (!recipeExists) return res.status(400).json({ error: 'Rezept nicht gefunden.', code: 400 });
    }

    const created = db.transaction(() => {
      const actorId = req.authUserId || req.session.userId;
      if (replaceExisting) {
        const slots = [...new Set(prepared.map((assignment) => `${assignment.date}\u0000${assignment.meal_type}`))];
        const selectMeals = db.get().prepare('SELECT * FROM meals WHERE date = ? AND meal_type = ? ORDER BY id ASC');
        for (const slot of slots) {
          const [slotDate, slotType] = slot.split('\u0000');
          const existingMeals = selectMeals.all(slotDate, slotType);
          for (const meal of existingMeals) deleteMealOccurrence(meal, actorId);
        }
      }

      return prepared.map((assignment) => createMealRecord(assignment, actorId));
    });

    res.status(201).json({ data: created });
  } catch (err) {
    log.error('POST /apply-plan', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PUT /api/v1/meals/:id
 * Mahlzeit bearbeiten (Titel, Notizen, Datum, Typ).
 * Body: { date?, meal_type?, title?, notes? }
 * Response: { data: Meal }
 */
router.put('/:id', (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const meal = db.get().prepare('SELECT * FROM meals WHERE id = ?').get(id);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    const checks = [];
    if (req.body.date       !== undefined) checks.push(date(req.body.date, 'Datum'));
    if (req.body.meal_type  !== undefined) checks.push(oneOf(req.body.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ'));
    if (req.body.title      !== undefined) checks.push(str(req.body.title, 'Titel', { max: MAX_TITLE, required: false }));
    if (req.body.notes      !== undefined) checks.push(str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false }));
    if (req.body.recipe_url !== undefined) checks.push(str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false }));
    if (req.body.recipe_id  !== undefined) checks.push(num(req.body.recipe_id, 'Rezept-ID', { required: false }));
    if (req.body.scope !== undefined) checks.push(oneOf(req.body.scope, VALID_MEAL_SCOPES, 'Meal scope'));
    const errors = collectErrors(checks);
    if (![req.body.scheduled_time, req.body.earliest_time, req.body.preferred_time, req.body.latest_time].every(validTime)) {
      errors.push('Meal times must use HH:MM.');
    }
    if (!orderedTimeWindow(
      req.body.earliest_time === undefined ? meal.earliest_time : req.body.earliest_time,
      req.body.preferred_time === undefined ? meal.preferred_time : req.body.preferred_time,
      req.body.latest_time === undefined ? meal.latest_time : req.body.latest_time,
    )) errors.push('Meal timing must run from earliest to preferred to latest.');
    const duration = req.body.expected_duration_minutes === undefined
      ? meal.expected_duration_minutes
      : (req.body.expected_duration_minutes === null || req.body.expected_duration_minutes === '' ? null : Number(req.body.expected_duration_minutes));
    if (duration != null && (!Number.isInteger(duration) || duration < 1 || duration > 720)) {
      errors.push('Meal duration must be between 1 and 720 minutes.');
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    let cleanParticipants = null;
    if (req.body.participants !== undefined) {
      try { cleanParticipants = normalizeMealParticipants(req.body.participants); }
      catch (error) { return res.status(400).json({ error: error.message, code: 400 }); }
    }

    if (req.body.recipe_id !== undefined && req.body.recipe_id !== null && req.body.recipe_id !== '') {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(req.body.recipe_id);
      if (!recipeExists) return res.status(400).json({ error: 'Rezept nicht gefunden.', code: 400 });
    }
    const placeId = req.body.place_id === undefined ? meal.place_id : (req.body.place_id == null || req.body.place_id === '' ? null : Number(req.body.place_id));
    if (placeId != null && (!Number.isInteger(placeId) || !db.get().prepare('SELECT 1 FROM places WHERE id = ?').get(placeId))) {
      return res.status(400).json({ error: 'Choose a valid Place.', code: 400 });
    }

    // scope=series schreibt die inhaltlichen Felder (nicht das Datum) auf das Template
    // und auf alle bereits materialisierten Instanzen zurück; Zutaten werden – falls
    // mitgeschickt – überall vollständig ersetzt.
    if (req.query.scope === 'series' && meal.recurrence_template_id) {
      const templateId = meal.recurrence_template_id;
      const tpl = db.get().prepare('SELECT * FROM meal_recurrence_templates WHERE id = ?').get(templateId);

      const nMealType  = req.body.meal_type  !== undefined ? req.body.meal_type                 : tpl.meal_type;
      const nTitle     = req.body.title      !== undefined ? (req.body.title?.trim() || tpl.title) : tpl.title;
      const nNotes     = req.body.notes      !== undefined ? (req.body.notes      || null)       : tpl.notes;
      const nRecipeUrl = req.body.recipe_url !== undefined ? (req.body.recipe_url || null)       : tpl.recipe_url;
      const nRecipeId  = req.body.recipe_id  !== undefined ? (req.body.recipe_id  || null)       : tpl.recipe_id;

      // repeat_until: leerer String heißt ausdrücklich „ohne Ende", ein fehlendes
      // Feld lässt die bestehende Grenze stehen.
      let nEndDate = tpl.end_date;
      if (req.body.repeat_until !== undefined) {
        const vRepeatUntil = date(req.body.repeat_until, 'Wiederholungs-Ende');
        if (vRepeatUntil.error) return res.status(400).json({ error: vRepeatUntil.error, code: 400 });
        if (vRepeatUntil.value && vRepeatUntil.value < tpl.start_date) {
          return res.status(400).json({ error: 'Wiederholungs-Ende darf nicht vor dem Serienbeginn liegen.', code: 400 });
        }
        nEndDate = vRepeatUntil.value;
      }

      db.transaction(() => {
        db.get().prepare(`
          UPDATE meal_recurrence_templates
          SET meal_type = ?, title = ?, notes = ?, recipe_url = ?, recipe_id = ?, end_date = ?
          WHERE id = ?
        `).run(nMealType, nTitle, nNotes, nRecipeUrl, nRecipeId, nEndDate, templateId);

        // Ein neu gesetztes (oder vorgezogenes) Ende muss die bereits
        // materialisierten Instanzen dahinter mitnehmen - sonst bliebe die Serie
        // sichtbar über ihr eigenes Ende hinaus bestehen.
        if (nEndDate) {
          db.get().prepare('DELETE FROM meals WHERE recurrence_template_id = ? AND date > ?')
            .run(templateId, nEndDate);
          db.get().prepare('DELETE FROM meal_recurrence_exceptions WHERE template_id = ? AND date > ?')
            .run(templateId, nEndDate);
        }

        db.get().prepare(`
          UPDATE meals
          SET meal_type = ?, title = ?, notes = ?, recipe_url = ?, recipe_id = ?
          WHERE recurrence_template_id = ?
        `).run(nMealType, nTitle, nNotes, nRecipeUrl, nRecipeId, templateId);

        if (Array.isArray(req.body.ingredients)) {
          const cleanIngredients = sanitizedIngredients(req.body.ingredients);

          db.get().prepare('DELETE FROM meal_recurrence_ingredients WHERE template_id = ?').run(templateId);
          const insertTemplateIng = db.get().prepare(`
            INSERT INTO meal_recurrence_ingredients (template_id, name, quantity, category)
            VALUES (?, ?, ?, ?)
          `);
          for (const ing of cleanIngredients) {
            insertTemplateIng.run(templateId, ing.name, ing.quantity, ing.category);
          }

          const instances = db.get().prepare('SELECT id FROM meals WHERE recurrence_template_id = ?').all(templateId);
          const deleteIng  = db.get().prepare('DELETE FROM meal_ingredients WHERE meal_id = ?');
          for (const inst of instances) {
            deleteIng.run(inst.id);
            insertMealIngredients(inst.id, cleanIngredients);
          }
        }
      });

      return res.json({ data: loadMealWithIngredients(id) });
    }

    if (meal.recurrence_template_id && req.body.date !== undefined && req.body.date !== meal.date) {
      db.get().prepare(`
        INSERT OR IGNORE INTO meal_recurrence_exceptions (template_id, date, created_by)
        VALUES (?, ?, ?)
      `).run(meal.recurrence_template_id, meal.date, req.authUserId || req.session.userId);
    }

    db.get().prepare(`
      UPDATE meals
      SET date       = COALESCE(?, date),
          meal_type  = COALESCE(?, meal_type),
          title      = COALESCE(?, title),
          notes      = ?,
          recipe_url = ?,
          recipe_id  = ?,
          scope = ?,
          scheduled_time = ?,
          earliest_time = ?,
          preferred_time = ?,
          latest_time = ?,
          expected_duration_minutes = ?,
          place_id = ?,
          provenance_json = ?
      WHERE id = ?
    `).run(
      req.body.date      ?? null,
      req.body.meal_type ?? null,
      req.body.title?.trim() ?? null,
      req.body.notes       !== undefined ? (req.body.notes || null)       : meal.notes,
      req.body.recipe_url  !== undefined ? (req.body.recipe_url || null)  : meal.recipe_url,
      req.body.recipe_id   !== undefined ? (req.body.recipe_id || null)   : meal.recipe_id,
      req.body.scope !== undefined ? req.body.scope : meal.scope,
      req.body.scheduled_time !== undefined ? (req.body.scheduled_time || null) : meal.scheduled_time,
      req.body.earliest_time !== undefined ? (req.body.earliest_time || null) : meal.earliest_time,
      req.body.preferred_time !== undefined ? (req.body.preferred_time || null) : meal.preferred_time,
      req.body.latest_time !== undefined ? (req.body.latest_time || null) : meal.latest_time,
      duration,
      placeId,
      JSON.stringify({
        ...(meal.provenance_json ? (() => { try { return JSON.parse(meal.provenance_json); } catch { return {}; } })() : {}),
        last_edited_from: 'meal_editor',
      }),
      id
    );

    if (cleanParticipants) replaceMealParticipants(id, cleanParticipants);

    res.json({ data: loadMealWithIngredients(id) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/meals/:id
 * Mahlzeit löschen (Zutaten werden per CASCADE mitgelöscht).
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const meal   = db.get().prepare('SELECT * FROM meals WHERE id = ?').get(id);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    // scope=series entfernt die gesamte Serie: alle materialisierten Instanzen plus
    // das Template (CASCADE räumt Template-Zutaten und Ausnahmen ab). Da
    // meals.recurrence_template_id ON DELETE SET NULL ist, müssen die Instanzen vor
    // dem Template explizit gelöscht werden, sonst blieben sie als Einzel-Mahlzeiten zurück.
    if (req.query.scope === 'series' && meal.recurrence_template_id) {
      const templateId = meal.recurrence_template_id;
      db.transaction(() => {
        db.get().prepare('DELETE FROM meals WHERE recurrence_template_id = ?').run(templateId);
        db.get().prepare('DELETE FROM meal_recurrence_templates WHERE id = ?').run(templateId);
      });
      return res.status(204).end();
    }

    // scope=future beendet die Serie an dieser Stelle: das Template bekommt ein
    // Ende vor diesem Termin, alle Instanzen ab hier verschwinden. Das ist der
    // Ausweg für eine Serie, deren erster Termin längst gelöscht wurde - ohne ihn
    // blieb nur das Löschen jedes einzelnen Vorkommens, während die Woche danach
    // schon wieder ein neues erzeugte (#619).
    if (req.query.scope === 'future' && meal.recurrence_template_id) {
      const templateId = meal.recurrence_template_id;
      const tpl = db.get().prepare('SELECT start_date FROM meal_recurrence_templates WHERE id = ?').get(templateId);
      const newEnd = addDays(meal.date, -1);

      db.transaction(() => {
        db.get().prepare('DELETE FROM meals WHERE recurrence_template_id = ? AND date >= ?')
          .run(templateId, meal.date);

        // Endet die Serie vor ihrem eigenen Beginn, bleibt kein Termin übrig -
        // dann ist die Vorlage selbst überflüssig (CASCADE räumt Zutaten und
        // Ausnahmen ab).
        if (!tpl || newEnd < tpl.start_date) {
          db.get().prepare('DELETE FROM meal_recurrence_templates WHERE id = ?').run(templateId);
        } else {
          db.get().prepare('UPDATE meal_recurrence_templates SET end_date = ? WHERE id = ?')
            .run(newEnd, templateId);
          db.get().prepare('DELETE FROM meal_recurrence_exceptions WHERE template_id = ? AND date >= ?')
            .run(templateId, meal.date);
        }
      });
      return res.status(204).end();
    }

    deleteMealOccurrence(meal, req.authUserId || req.session.userId);
    const result = { changes: 1 };
    if (result.changes === 0)
      return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// CRUD - Zutaten
// --------------------------------------------------------

/**
 * POST /api/v1/meals/:id/ingredients
 * Zutat zur Mahlzeit hinzufügen.
 * Body: { name, quantity? }
 * Response: { data: Ingredient }
 */
router.post('/:id/ingredients', (req, res) => {
  try {
    const mealId = parseInt(req.params.id, 10);
    const meal   = db.get().prepare('SELECT id FROM meals WHERE id = ?').get(mealId);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    const { name, quantity = null, category = 'Sonstiges' } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: 'Name ist erforderlich', code: 400 });

    const result = db.get().prepare(`
      INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, ?, ?, ?)
    `).run(mealId, name.trim(), quantity?.trim() || null, String(category || '').trim() || 'Sonstiges');

    const ing = db.get().prepare(
      'SELECT * FROM meal_ingredients WHERE id = ?'
    ).get(result.lastInsertRowid);

    res.status(201).json({ data: ing });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * PATCH /api/v1/meals/ingredients/:ingId
 * Zutat bearbeiten (Name, Menge, on_shopping_list-Flag).
 * Body: { name?, quantity?, on_shopping_list? }
 * Response: { data: Ingredient }
 */
router.patch('/ingredients/:ingId', (req, res) => {
  try {
    const ingId = parseInt(req.params.ingId, 10);
    const ing   = db.get().prepare('SELECT * FROM meal_ingredients WHERE id = ?').get(ingId);
    if (!ing) return res.status(404).json({ error: 'Zutat nicht gefunden', code: 404 });

    const { name, quantity, on_shopping_list, category } = req.body;

    db.get().prepare(`
      UPDATE meal_ingredients
      SET name             = COALESCE(?, name),
          quantity         = ?,
          category         = COALESCE(?, category),
          on_shopping_list = COALESCE(?, on_shopping_list)
      WHERE id = ?
    `).run(
      name?.trim() ?? null,
      quantity !== undefined ? (quantity?.trim() || null) : ing.quantity,
      category !== undefined ? (String(category || '').trim() || 'Sonstiges') : null,
      on_shopping_list !== undefined ? (on_shopping_list ? 1 : 0) : null,
      ingId
    );

    const updated = db.get().prepare(
      'SELECT * FROM meal_ingredients WHERE id = ?'
    ).get(ingId);

    res.json({ data: updated });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * DELETE /api/v1/meals/ingredients/:ingId
 * Zutat löschen.
 * Response: 204 No Content
 */
router.delete('/ingredients/:ingId', (req, res) => {
  try {
    const ingId  = parseInt(req.params.ingId, 10);
    const result = db.get().prepare('DELETE FROM meal_ingredients WHERE id = ?').run(ingId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Zutat nicht gefunden', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

// --------------------------------------------------------
// Integration: Zutaten → Einkaufsliste (Phase 2, Schritt 12)
// --------------------------------------------------------

/**
 * POST /api/v1/meals/:id/to-shopping-list
 * Alle noch nicht übertragenen Zutaten einer Mahlzeit auf eine Einkaufsliste übernehmen.
 * Body: { listId: number, category?: string }
 * Response: { data: { transferred: number, added_ids: number[] } }
 *
 * `added_ids` trägt das Undo im Client (Audit 2026-07-30, P1-B). Zurückgenommen
 * wird über `POST /shopping/items/undo-transfer` und nicht durch einfaches
 * Löschen der Artikel: dieser Pfad setzt zusätzlich `on_shopping_list` auf den
 * Zutaten. Wer nur die Einkaufsartikel entfernt, lässt die Mahlzeit für immer als
 * „schon übertragen" zurück - die Zutaten wären dann weder auf der Liste noch
 * erneut übertragbar.
 */
router.post('/:id/to-shopping-list', (req, res) => {
  try {
    const mealId = parseInt(req.params.id, 10);
    const meal   = db.get().prepare('SELECT id, recipe_id FROM meals WHERE id = ?').get(mealId);
    if (!meal) return res.status(404).json({ error: 'Mahlzeit nicht gefunden', code: 404 });

    const { listId } = req.body;
    if (!listId)
      return res.status(400).json({ error: 'listId ist erforderlich', code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId);
    if (!list) return res.status(404).json({ error: 'Einkaufsliste nicht gefunden', code: 404 });

    // Eine aus einem Rezept geplante Mahlzeit hat keine eigenen Zutaten - sie
    // kennt nur die recipe_id. Beim ersten Transfer werden die Rezeptzutaten
    // hier zu echten meal_ingredients materialisiert. Erst danach greift das
    // on_shopping_list-Flag, das die Mahlzeit (anders als das wiederverwendbare
    // Rezept) vor doppeltem Übertragen schützt. Bedingung ist bewusst „gar
    // keine Zutaten" und nicht „keine offenen": nach einem vollständigen
    // Transfer darf nicht erneut materialisiert werden.
    const existingCount = db.get()
      .prepare('SELECT COUNT(*) AS c FROM meal_ingredients WHERE meal_id = ?').get(mealId).c;
    if (existingCount === 0 && meal.recipe_id) {
      const recipeIngredients = db.get().prepare(
        'SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC',
      ).all(meal.recipe_id);
      if (recipeIngredients.length > 0) {
        const copyIng = db.get().prepare(
          'INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, ?, ?, ?)',
        );
        db.transaction(() => {
          for (const ing of recipeIngredients) {
            copyIng.run(mealId, ing.name, ing.quantity, ing.category || 'Sonstiges');
          }
        });
      }
    }

    const ingredients = db.get().prepare(`
      SELECT * FROM meal_ingredients
      WHERE meal_id = ? AND on_shopping_list = 0
    `).all(mealId);

    if (ingredients.length === 0)
      return res.json({ data: { transferred: 0, added_ids: [] } });

    const addedIds = db.transaction(() => {
      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
        VALUES (?, ?, ?, ?, ?)
      `);
      const markDone = db.get().prepare(`
        UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?
      `);

      const ids = [];
      for (const ing of ingredients) {
        const info = insertItem.run(listId, ing.name, ing.quantity, ing.category || 'Sonstiges', mealId);
        markDone.run(ing.id);
        ids.push(Number(info.lastInsertRowid));
      }
      return ids;
    });

    res.json({ data: { transferred: addedIds.length, added_ids: addedIds } });
  } catch (err) {
    log.error('POST /:id/to-shopping-list', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

/**
 * POST /api/v1/meals/week-to-shopping-list
 * Alle noch nicht übertragenen Zutaten einer ganzen Woche auf eine Einkaufsliste übernehmen.
 * Body: { listId, week: YYYY-MM-DD, category? }
 * Response: { data: { transferred: number, added_ids: number[] } }
 *
 * `added_ids` wie beim Einzel-Transfer. Diese Route hat derzeit keinen Aufrufer in
 * der Oberfläche; die IDs stehen trotzdem in der Antwort, damit ein künftiger
 * Aufrufer nicht als einziger Erzeuger-Pfad ohne Rücknahme dasteht.
 */
router.post('/week-to-shopping-list', (req, res) => {
  try {
    const { listId, week } = req.body;

    if (!listId)
      return res.status(400).json({ error: 'listId ist erforderlich', code: 400 });
    if (!week || !DATE_RE.test(week))
      return res.status(400).json({ error: 'Gültiges Datum (YYYY-MM-DD) erforderlich', code: 400 });

    const list = db.get().prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId);
    if (!list) return res.status(404).json({ error: 'Einkaufsliste nicht gefunden', code: 404 });

    const from = weekStart(week);
    const to   = weekEnd(week);

    const ingredients = db.get().prepare(`
      SELECT mi.* FROM meal_ingredients mi
      JOIN meals m ON m.id = mi.meal_id
      WHERE m.date BETWEEN ? AND ?
        AND mi.on_shopping_list = 0
    `).all(from, to);

    if (ingredients.length === 0)
      return res.json({ data: { transferred: 0, added_ids: [] } });

    const addedIds = db.transaction(() => {
      const insertItem = db.get().prepare(`
        INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
        VALUES (?, ?, ?, ?, ?)
      `);
      const markDone = db.get().prepare(`
        UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?
      `);

      const ids = [];
      for (const ing of ingredients) {
        const info = insertItem.run(listId, ing.name, ing.quantity, ing.category || 'Sonstiges', ing.meal_id);
        markDone.run(ing.id);
        ids.push(Number(info.lastInsertRowid));
      }
      return ids;
    });

    res.json({ data: { transferred: addedIds.length, added_ids: addedIds } });
  } catch (err) {
    log.error('POST /week-to-shopping-list', err);
    res.status(500).json({ error: 'Interner Fehler', code: 500 });
  }
});

export default router;
