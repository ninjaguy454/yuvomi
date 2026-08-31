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
import {
  listMealCalendarConflicts,
  reconcileMealCalendarConflicts,
  resolveMealCalendarConflict,
} from '../services/meal-calendar-conflicts.js';
import {
  ensureMealExecution,
  getSettings as getMealExecutionSettings,
  loadExecution as loadMealExecution,
  prepareMealExecutionRange,
  refreshExecutionStatus,
  saveSettings as saveMealExecutionSettings,
} from '../services/meal-execution.js';
import {
  applyLegacyMealScheduleEdits,
  attachMealPlanToContext,
  buildMealStatus,
  buildMealWeekModel,
  createMealMenuItem,
  createMealPlan,
  deleteMealMenuItem,
  deleteMealPlan,
  detachMealPlanFromContext,
  ensureContextMealPlanAssociation,
  ensureContextMealPlanAssociationsForRange,
  getGrocerySettings,
  getMealPlan,
  getMealPlanDefaultSettings,
  listMealMenuItems,
  listMealPlans,
  materializeMealPlanOccurrences,
  replaceMealMenuItems,
  repairMealChooser,
  saveGrocerySettings,
  saveMealDecision,
  saveMealPlanDefaultSettings,
  syncGrocerySettingsFromLegacy,
  advanceMealChooserFallback,
  updateMealMenuItem,
  updateMealPlan,
} from '../services/meal-plans.js';
import {
  finalizedDinerCount,
  normalizeDishSelection,
  normalizePortions,
  presentDishSelection,
  recipeIngredientsForPortions,
  syncAutoPortions,
} from '../services/meal-dishes.js';

const log = createLogger('Meals');

const router  = express.Router();

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'custom'];
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = Monday, 6 = Sunday
const VALID_MEAL_SCOPES = ['household', 'personal', 'restaurant', 'takeout', 'skipped', 'travel'];
const NEW_MEAL_SCOPES = ['household', 'personal', 'restaurant', 'takeout', 'travel'];
const VALID_SCHEDULE_POLICIES = ['fixed', 'round_robin', 'personal_choice'];
const VALID_PARTICIPANT_ROLES = ['chooser', 'cook', 'participant', 'supervisor'];
const VALID_PARTICIPANT_STATUSES = ['participating', 'not_participating', 'away', 'needs_confirmation'];

function requestedMealRange(query, database) {
  const validDate = (value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return DATE_RE.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const requestedWeek = String(query.week || '');
  const fallback = validDate(requestedWeek) ? requestedWeek : todayKey(database);
  const from = query.start == null || query.start === '' ? weekStart(fallback) : String(query.start);
  if (!validDate(from)) throw new Error('Meal range dates must use a valid YYYY-MM-DD date.');
  const to = query.end == null || query.end === '' ? (query.start ? addDays(from, 6) : weekEnd(fallback)) : String(query.end);
  if (!validDate(from) || !validDate(to)) throw new Error('Meal range dates must use a valid YYYY-MM-DD date.');
  if (to < from) throw new Error('End date must not precede start date.');
  if (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`) > 62 * 86400000) {
    throw new Error('Meal views may cover at most 63 days at a time.');
  }
  return { from, to };
}

function requestedContextId(value) {
  if (value == null || value === '') return null;
  const contextId = Number(value);
  if (!Number.isInteger(contextId) || contextId <= 0) throw new Error('Choose a valid planning context.');
  return contextId;
}

function requestedContextFromQuery(query) {
  const value = [query.context_id, query.context, query.planning_context_id]
    .find((candidate) => candidate != null && candidate !== '');
  return requestedContextId(value);
}

function validateMealPlanningContext(database, value, dateKey) {
  const contextId = requestedContextId(value);
  if (contextId == null) return null;
  const context = database.prepare(`
    SELECT * FROM planning_contexts
     WHERE id = ? AND status NOT IN ('cancelled', 'completed')
       AND julianday(starts_at) < julianday(? || 'T00:00:00', '+1 day')
       AND julianday(ends_at) > julianday(? || 'T00:00:00')
  `).get(contextId, dateKey, dateKey);
  if (!context) throw new Error('Choose an active planning context that includes this meal date.');
  return context;
}

function mealDomainError(res, err, fallback = 'Could not complete the Meal Plan request.') {
  const status = Number(err.status || err.statusCode) || 400;
  res.status(status).json({ error: err.message || fallback, code: err.code || status });
}

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
           mrt.end_date AS recurrence_end_date,
           pc.name AS context_name, pc.context_type,
           place.name AS place_name
    FROM meals m
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN meal_recurrence_templates mrt ON mrt.id = m.recurrence_template_id
    LEFT JOIN planning_contexts pc ON pc.id = m.planning_context_id
    LEFT JOIN places place ON place.id = m.place_id
    WHERE m.id = ?
  `).get(id);
  if (!meal) return null;
  const ingredients = db.get().prepare('SELECT * FROM meal_ingredients WHERE meal_id = ? ORDER BY id ASC').all(id);
  const participants = loadMealParticipants([id])[id] || [];
  const menuItems = listMealMenuItems(db.get(), id);
  return {
    ...meal,
    portions: meal.portions_mode === 'fixed' ? Number(meal.portions) : null,
    effective_portions: Number(meal.portions) || 1,
    ingredients_manual_override: Boolean(meal.ingredients_manual_override),
    dish: presentDishSelection(meal),
    menu_items: menuItems,
    ingredients,
    participants,
  };
}

function preferredMealMenu(body, currentMeal = null) {
  if (!Array.isArray(body?.menu_items)) return null;
  const entrees = body.menu_items.filter((item) => String(item?.item_type || 'entree') === 'entree');
  if (entrees.length !== 1) {
    const error = new Error('Add/Edit Meal requires exactly one entree and may include up to three sides.');
    error.status = 400;
    error.code = 'MEAL_ENTREE_REQUIRED';
    throw error;
  }
  const dish = normalizeDishSelection(db.get(), entrees[0], currentMeal);
  return {
    dish,
    items: body.menu_items.map((item) => (
      item === entrees[0] ? { ...item, title: dish.title, recipe_id: dish.recipe_id } : item
    )),
  };
}

function applyMealPortions(mealId, body, currentMeal = null) {
  const database = db.get();
  const autoCount = finalizedDinerCount(database, mealId);
  const hasPortionWrite = Object.hasOwn(body || {}, 'portions_mode') || Object.hasOwn(body || {}, 'portions');
  let rawPortions;
  if (hasPortionWrite) {
    const mode = body.portions_mode || (body.portions == null ? 'auto' : 'fixed');
    rawPortions = mode === 'auto' ? { mode: 'auto' } : { mode: 'fixed', count: body.portions };
  }
  const normalized = normalizePortions(rawPortions, {
    currentMode: currentMeal?.portions_mode || 'auto',
    currentCount: currentMeal?.portions,
    autoCount,
  });
  const ingredientWrite = Array.isArray(body?.ingredients);
  const manualOverride = Object.hasOwn(body || {}, 'ingredients_manual_override')
    ? Boolean(body.ingredients_manual_override)
    : (ingredientWrite ? true : Boolean(currentMeal?.ingredients_manual_override));
  const dishChanged = currentMeal
    ? (Number(currentMeal.recipe_id || 0) !== Number(body.recipe_id || currentMeal.recipe_id || 0))
    : true;
  const shouldMaterialize = !manualOverride && (hasPortionWrite || dishChanged || !currentMeal);

  database.prepare(`
    UPDATE meals SET portions_mode = ?, portions = ?, ingredients_manual_override = ? WHERE id = ?
  `).run(normalized.mode, normalized.count, manualOverride ? 1 : 0, Number(mealId));

  if (ingredientWrite || shouldMaterialize) {
    database.prepare('DELETE FROM meal_ingredients WHERE meal_id = ?').run(Number(mealId));
    const meal = database.prepare('SELECT recipe_id FROM meals WHERE id = ?').get(Number(mealId));
    const ingredients = ingredientWrite
      ? sanitizedIngredients(body.ingredients)
      : recipeIngredientsForPortions(database, meal?.recipe_id, normalized.count);
    insertMealIngredients(mealId, ingredients);
  }
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

function minutesBefore(dateKey, time, minutes) {
  const value = new Date(`${dateKey}T${time || '23:59'}:00Z`);
  value.setUTCMinutes(value.getUTCMinutes() - Math.max(0, Number(minutes) || 0));
  return value.toISOString().slice(0, 19);
}

function selectionText(value, { required = false, max = MAX_TEXT, field = 'Text' } = {}) {
  const clean = value == null ? '' : String(value).trim();
  if (required && !clean) throw new Error(`${field} is required.`);
  if (clean.length > max) throw new Error(`${field} may be at most ${max} characters long.`);
  return clean || null;
}

function selectMealRotation(d, slot, eligible, { commit = false } = {}) {
  if (!eligible.length) return null;
  const key = `meal:${slot.rotation_group || `slot:${slot.id}`}:chooser`;
  const state = d.prepare('SELECT cursor_user_id FROM assignment_rotation_state WHERE rotation_key = ?').get(key);
  const previous = eligible.indexOf(Number(state?.cursor_user_id));
  const selected = eligible[(previous + 1 + eligible.length) % eligible.length];
  if (commit) {
    d.prepare(`
      INSERT INTO assignment_rotation_state (rotation_key, cursor_user_id, occurrence_count, updated_at)
      VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(rotation_key) DO UPDATE SET cursor_user_id = excluded.cursor_user_id,
        occurrence_count = assignment_rotation_state.occurrence_count + 1,
        updated_at = excluded.updated_at
    `).run(key, selected);
  }
  return selected;
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
    execution_settings: getMealExecutionSettings(d),
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
      , place_id, selection_status
    ) VALUES (?, ?, ?, 'household', ?, ?, ?, ?, ?, 'schedule', ?, ?, ?, ?, ?, ?, 'awaiting_choice')
  `);
  const insertParticipant = d.prepare(`
    INSERT OR IGNORE INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, ?, 'schedule')
  `);
  const insertObligation = d.prepare(`
    INSERT OR IGNORE INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id, responsible_group,
      due_at, response_deadline, reminder_at, fallback_source, metadata_json
    ) VALUES ('meal', ?, ?, 'chooser', ?, ?, ?, ?, ?, ?, ?)
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
          slot.cook_user_id ? Number(slot.cook_user_id) : null,
          slot.supervisor_user_id ? Number(slot.supervisor_user_id) : null,
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
        if (slot.policy === 'round_robin') chooserId = selectMealRotation(d, slot, eligibleParticipants);
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
        if (slot.policy === 'round_robin' && chooserId) selectMealRotation(d, slot, eligibleParticipants, { commit: true });
        for (const userId of participants) {
          const signal = availability.get(userId);
          insertParticipant.run(mealId, userId, 'participant', signal?.eligible ? 'participating' : 'away');
        }
        if (slot.policy === 'personal_choice') {
          for (const userId of eligibleParticipants) insertParticipant.run(mealId, userId, 'chooser', 'participating');
        } else if (chooserId) insertParticipant.run(mealId, chooserId, 'chooser', 'participating');
        if (slot.cook_user_id) insertParticipant.run(mealId, slot.cook_user_id, 'cook', availability.get(Number(slot.cook_user_id))?.eligible ? 'participating' : 'away');
        if (slot.supervisor_user_id) insertParticipant.run(mealId, slot.supervisor_user_id, 'supervisor', availability.get(Number(slot.supervisor_user_id))?.eligible ? 'participating' : 'away');
        const deadline = minutesBefore(dateKey, preferred || '23:59', slot.selection_deadline_minutes);
        const reminderAt = minutesBefore(deadline.slice(0, 10), deadline.slice(11, 16), slot.reminder_minutes);
        if (slot.policy === 'personal_choice') {
          for (const userId of eligibleParticipants) {
            insertObligation.run(
              mealId, `${sourceKey}:chooser:user:${userId}`, userId, null, deadline, deadline,
              reminderAt, slot.fallback_user_id ? `user:${slot.fallback_user_id}` : null,
              JSON.stringify({ policy: slot.policy, schedule_slot_id: slot.id, participant_user_id: userId, snack_choice_limit: slot.snack_choice_limit }),
            );
          }
          if (!eligibleParticipants.length) {
            insertObligation.run(
              mealId, `${sourceKey}:chooser:unavailable`, null, 'unavailable', deadline, deadline,
              reminderAt, slot.fallback_user_id ? `user:${slot.fallback_user_id}` : null,
              JSON.stringify({ policy: slot.policy, schedule_slot_id: slot.id, zero_eligible: true }),
            );
          }
        } else {
          insertObligation.run(
            mealId, `${sourceKey}:chooser:attempt:1`, chooserId, chooserId ? null : 'unavailable', deadline, deadline,
            reminderAt,
            slot.fallback_user_id ? `user:${slot.fallback_user_id}` : null,
            JSON.stringify({ policy: slot.policy, schedule_slot_id: slot.id, base_chooser_user_id: chooserId, zero_eligible: !chooserId }),
          );
        }
        created += 1;
      }
    }
  })();
  return created;
}

function mealSelectionRequests(userId, { household = false } = {}) {
  const d = db.get();
  const expired = d.prepare(`
    SELECT id FROM planning_obligations
     WHERE entity_type = 'meal' AND role = 'chooser' AND status IN ('pending', 'accepted')
       AND response_deadline IS NOT NULL
       AND response_deadline <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     ORDER BY id
  `).all();
  for (const row of expired) {
    try { respondToMealSelection(row.id, { action: 'timeout' }, null, { timeout: true }); } catch { /* surface unresolved requests below */ }
  }
  const filter = household ? '' : 'AND o.responsible_user_id = ?';
  return d.prepare(`
    SELECT o.*, m.date, m.meal_type, m.title AS meal_title, m.scope AS meal_scope,
           m.selection_status, m.schedule_slot_id, u.display_name AS responsible_name,
           COALESCE(s.policy, json_extract(o.metadata_json, '$.policy')) AS policy,
           COALESCE(s.snack_choice_limit, json_extract(o.metadata_json, '$.snack_choice_limit'), 3) AS snack_choice_limit,
           CASE WHEN o.reminder_at IS NOT NULL AND o.reminder_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now') THEN 1 ELSE 0 END AS reminder_due
      FROM planning_obligations o
      JOIN meals m ON m.id = o.entity_id AND o.entity_type = 'meal'
      LEFT JOIN meal_schedule_slots s ON s.id = m.schedule_slot_id
      LEFT JOIN users u ON u.id = o.responsible_user_id
     WHERE o.role = 'chooser' AND o.status IN ('pending', 'accepted') ${filter}
     ORDER BY COALESCE(o.response_deadline, o.due_at, m.date), o.id
  `).all(...(household ? [] : [userId]));
}

function addObligationEvent(d, obligationId, event, actorId, details = null) {
  d.prepare(`INSERT INTO planning_obligation_events (obligation_id, event, actor_user_id, details_json) VALUES (?, ?, ?, ?)`)
    .run(obligationId, event, actorId || null, details ? JSON.stringify(details) : null);
}

function respondToMealSelection(obligationId, body, actorId, { timeout = false } = {}) {
  const d = db.get();
  return d.transaction(() => {
    const obligation = d.prepare(`
      SELECT o.*, m.date, m.meal_type, m.scope AS meal_scope, m.schedule_slot_id,
             COALESCE(m.selection_policy_override, json_extract(o.metadata_json, '$.policy'), r.policy, s.policy) AS policy,
             COALESCE(json_extract(o.metadata_json, '$.chooser_backup_strategy'), r.chooser_backup_strategy,
               CASE WHEN s.fallback_user_id IS NULL THEN 'next_eligible' ELSE 'fixed' END) AS chooser_backup_strategy,
             COALESCE(json_extract(o.metadata_json, '$.fallback_user_id'), r.fallback_user_id,
               s.fallback_user_id) AS fallback_user_id,
             COALESCE(s.snack_choice_limit, json_extract(o.metadata_json, '$.snack_choice_limit'), 3) AS snack_choice_limit
        FROM planning_obligations o
        JOIN meals m ON m.id = o.entity_id
        LEFT JOIN meal_plan_rules r ON r.id = m.meal_plan_rule_id
        LEFT JOIN meal_schedule_slots s ON s.id = m.schedule_slot_id
       WHERE o.id = ? AND o.entity_type = 'meal' AND o.role = 'chooser'
    `).get(obligationId);
    if (!obligation) throw new Error('Meal-selection request not found.');
    if (!['pending', 'accepted'].includes(obligation.status)) throw new Error('This meal-selection request is already closed.');
    if (!timeout && Number(obligation.responsible_user_id) !== Number(actorId)) {
      throw new Error('This meal-selection request belongs to another household member.');
    }
    const action = timeout ? 'timeout' : String(body.action || 'choose');
    const metadata = (() => { try { return JSON.parse(obligation.metadata_json || '{}'); } catch { return {}; } })();
    const selectionPolicy = obligation.policy || metadata.policy || null;
    if (action === 'choose') {
      const personal = selectionPolicy === 'personal_choice' || metadata.participant_user_id;
      const rawChoices = Array.isArray(body.choices) && body.choices.length
        ? body.choices
        : [{ title: body.title, recipe_id: body.recipe_id, notes: body.notes }];
      const limit = personal && obligation.meal_type === 'snack' ? Number(obligation.snack_choice_limit || 3) : 1;
      if (rawChoices.length > limit) throw new Error(`Choose no more than ${limit} option${limit === 1 ? '' : 's'} for this meal.`);
      const choices = rawChoices.map((choice) => {
        const recipeId = choice.recipe_id ? Number(choice.recipe_id) : null;
        if (recipeId && !d.prepare('SELECT 1 FROM recipes WHERE id = ?').get(recipeId)) throw new Error('Recipe not found.');
        return {
          title: selectionText(choice.title, { required: true, max: MAX_TITLE, field: 'Meal title' }),
          recipeId,
          notes: selectionText(choice.notes),
        };
      });
      let targetMealId = Number(obligation.entity_id);
      const targetMealIds = [];
      if (personal) {
        // Legacy selection requests and the redesigned My Choices card now
        // converge on the same audited decision transaction. The first choice
        // is the canonical personal Meal; additional snack choices remain
        // compatible response items without creating a second primary Meal.
        const primary = saveMealDecision(d, obligation.entity_id, {
          beneficiary_user_id: Number(obligation.responsible_user_id),
          participation: 'participating',
          choice_kind: 'personal',
          selected_meal_title: choices[0].title,
          selected_recipe_id: choices[0].recipeId,
          notes: choices[0].notes,
          confirmed: true,
        }, {
          actorId,
          isAdmin: false,
          deviceKey: body.device_key || null,
        });
        targetMealId = Number(primary.selected_meal_id);
        targetMealIds.push(targetMealId);
        d.prepare(`
          INSERT INTO meal_selection_response_items
            (obligation_id, position, meal_id, recipe_id, title, notes)
          VALUES (?, 0, ?, ?, ?, ?)
        `).run(obligation.id, targetMealId, choices[0].recipeId, choices[0].title, choices[0].notes);

        choices.slice(1).forEach((choice, offset) => {
          const index = offset + 1;
          const sourceKey = `meal-choice:${obligation.id}:${index}`;
          const result = d.prepare(`
            INSERT OR IGNORE INTO meals (
              date, meal_type, title, notes, recipe_id, scope, source, source_key,
              parent_meal_id, selection_status, created_by
            ) VALUES (?, ?, ?, ?, ?, 'personal', 'schedule', ?, ?, 'selected', ?)
          `).run(obligation.date, obligation.meal_type, choice.title, choice.notes, choice.recipeId,
            sourceKey, obligation.entity_id, actorId);
          const mealId = result.changes && result.lastInsertRowid
            ? Number(result.lastInsertRowid)
            : Number(d.prepare('SELECT id FROM meals WHERE source_key = ?').get(sourceKey).id);
          targetMealIds.push(mealId);
          d.prepare(`
            INSERT OR IGNORE INTO meal_participants (meal_id, user_id, role, status, source)
            VALUES (?, ?, 'participant', 'participating', 'schedule')
          `).run(mealId, obligation.responsible_user_id);
          d.prepare(`INSERT INTO meal_selection_response_items (obligation_id, position, meal_id, recipe_id, title, notes) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(obligation.id, index, mealId, choice.recipeId, choice.title, choice.notes);
        });
      } else {
        d.prepare(`UPDATE meals SET title = ?, notes = COALESCE(?, notes), recipe_id = ?, selection_status = 'selected' WHERE id = ?`)
          .run(choices[0].title, choices[0].notes, choices[0].recipeId, obligation.entity_id);
        targetMealIds.push(targetMealId);
      }
      d.prepare(`
        INSERT INTO meal_selection_responses (obligation_id, meal_id, recipe_id, title, notes, scope, responded_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        ON CONFLICT(obligation_id) DO UPDATE SET meal_id = excluded.meal_id, recipe_id = excluded.recipe_id,
          title = excluded.title, notes = excluded.notes, scope = excluded.scope,
          responded_by = excluded.responded_by, updated_at = excluded.updated_at
      `).run(obligation.id, targetMealId, choices[0].recipeId, choices[0].title, choices[0].notes, personal ? 'personal' : 'household', actorId);
      if (!personal) {
        d.prepare(`UPDATE planning_obligations SET status = 'fulfilled', responded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(obligation.id);
        addObligationEvent(d, obligation.id, 'meal_selected', actorId, { meal_ids: targetMealIds, personal: false });
      }
      return { obligation_id: obligation.id, meal_id: targetMealId, meal_ids: targetMealIds, status: 'fulfilled', personal };
    }

    if (!['decline', 'timeout'].includes(action)) throw new Error('Choose a meal or decline the request.');
    const status = action === 'timeout' ? 'timed_out' : 'declined';
    d.prepare(`UPDATE planning_obligations SET status = ?, responded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), response_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
      .run(status, selectionText(body.note, { max: 500 }), obligation.id);
    addObligationEvent(d, obligation.id, status, actorId);
    if (selectionPolicy === 'personal_choice' || metadata.participant_user_id) {
      if (!timeout) {
        saveMealDecision(d, obligation.entity_id, {
          beneficiary_user_id: Number(obligation.responsible_user_id),
          participation: 'not_participating',
          choice_kind: 'household',
          notes: body.note || null,
          confirmed: true,
        }, { actorId, isAdmin: false, deviceKey: body.device_key || null });
        // Declining responsibility is still distinct from resolving a choice.
        // Preserve the explicit decline status after the decision audit runs.
        d.prepare(`UPDATE planning_obligations SET status = ?, responded_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
          .run(status, obligation.id);
      } else {
        d.prepare(`UPDATE meal_participants SET status = 'not_participating', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE meal_id = ? AND user_id = ? AND role = 'participant'`)
          .run(obligation.entity_id, obligation.responsible_user_id);
        syncAutoPortions(d, obligation.entity_id);
      }
      return { obligation_id: obligation.id, status, fallback: null };
    }
    const advanced = advanceMealChooserFallback(d, obligation.entity_id, {
      sourceObligationId: obligation.id,
      actorId,
      reason: status === 'timed_out' ? 'chooser_timed_out' : 'chooser_declined',
    });
    return {
      ...advanced,
      obligation_id: obligation.id,
      status,
      chooser_status: advanced.status,
      // Keep the released response shape while returning richer repair state.
      fallback: advanced.fallback || null,
    };
  })();
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

function createMealRecord({
  date, meal_type, custom_label = null, title, notes, recipe_url, recipe_id, ingredients = [],
  planning_context_id = null,
}, actorId) {
  const cleanIngredients = sanitizedIngredients(ingredients);
  const result = db.get().prepare(`
    INSERT INTO meals (
      date, meal_type, custom_label, title, notes, recipe_url, recipe_id, created_by,
      planning_context_id, source, provenance_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
  `).run(
    date, meal_type, meal_type === 'custom' ? custom_label : null,
    title, notes, recipe_url, recipe_id, actorId,
    planning_context_id,
    JSON.stringify({ source: 'manual', created_from: 'recipe_assignment', planning_context_id }),
  );
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
        date, meal_type, custom_label, title, notes, recipe_url, recipe_id, recurrence_template_id,
        created_by, source, source_key, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurrence', ?, ?)
    `);

    for (const template of templates) {
      if (!VALID_WEEKDAYS.includes(template.weekday)) continue;
      const ingredients = templateIngredients.all(template.id);
      for (const date of datesForTemplateInRange(template, from, to)) {
        if (hasException.get(template.id, date) || hasMeal.get(template.id, date)) continue;
        const result = insertMeal.run(
          date,
          template.meal_type,
          template.meal_type === 'custom' ? template.custom_label : null,
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

// --------------------------------------------------------
// Named Meal Plans and weekly decision read models
// --------------------------------------------------------

router.get('/plans', (req, res) => {
  try {
    res.json({ data: listMealPlans(db.get(), { includeDeleted: req.query.include_deleted === '1' }) });
  } catch (err) {
    log.error('GET /plans', err);
    mealDomainError(res, err);
  }
});

router.get('/plans/:id', (req, res) => {
  try {
    const data = getMealPlan(db.get(), Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'Meal Plan not found.', code: 'MEAL_PLAN_NOT_FOUND' });
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.post('/plans', requireAdmin, (req, res) => {
  try {
    const data = createMealPlan(db.get(), req.body || {}, req.authUserId || req.session.userId);
    res.status(201).json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.put('/plans/:id', requireAdmin, (req, res) => {
  try {
    const data = updateMealPlan(
      db.get(), Number(req.params.id), req.body || {}, req.authUserId || req.session.userId,
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.delete('/plans/:id', requireAdmin, (req, res) => {
  try {
    const data = deleteMealPlan(db.get(), Number(req.params.id), req.authUserId || req.session.userId);
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.put('/plans/:id/contexts/:contextId', requireAdmin, (req, res) => {
  try {
    const data = attachMealPlanToContext(
      db.get(), Number(req.params.id), Number(req.params.contextId), req.body || {},
      req.authUserId || req.session.userId,
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.delete('/plans/:id/contexts/:contextId', requireAdmin, (req, res) => {
  try {
    const data = detachMealPlanFromContext(
      db.get(), Number(req.params.id), Number(req.params.contextId),
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.get('/week-model', (req, res) => {
  try {
    const d = db.get();
    const { from, to } = requestedMealRange(req.query, d);
    const contextId = requestedContextFromQuery(req.query);
    const actorId = req.authUserId || req.session.userId;
    const contextPlan = contextId
      ? ensureContextMealPlanAssociation(d, contextId, actorId)
      : null;
    const contextPlans = contextId
      ? [{ context_id: contextId, ...contextPlan }]
      : ensureContextMealPlanAssociationsForRange(d, { from, to, actorId });
    materializeRecurringMeals(from, to);
    materializeMealPlanOccurrences(d, { from, to, contextId, actorId });
    // The named-plan materializer adopts migration-backed legacy slots first.
    // This fallback then handles only slots added after migration 10015.
    if (!contextId) materializeMealSchedule(from, to, actorId);
    const data = buildMealWeekModel(d, {
      from,
      to,
      contextId,
      memberId: req.query.member_id || actorId,
      actorId,
      isAdmin: req.authRole === 'admin',
    });
    data.context_plan = contextPlan;
    data.context_plans = contextPlans;
    res.json({ data, weekStart: from, weekEnd: to });
  } catch (err) {
    log.error('GET /week-model', err);
    mealDomainError(res, err, 'Could not load My Choices.');
  }
});

router.get('/status', (req, res) => {
  try {
    const d = db.get();
    const { from, to } = requestedMealRange(req.query, d);
    const contextId = requestedContextFromQuery(req.query);
    const actorId = req.authUserId || req.session.userId;
    const contextPlan = contextId
      ? ensureContextMealPlanAssociation(d, contextId, actorId)
      : null;
    const contextPlans = contextId
      ? [{ context_id: contextId, ...contextPlan }]
      : ensureContextMealPlanAssociationsForRange(d, { from, to, actorId });
    materializeRecurringMeals(from, to);
    materializeMealPlanOccurrences(d, { from, to, contextId, actorId });
    if (!contextId) materializeMealSchedule(from, to, actorId);
    const data = buildMealStatus(d, { from, to, contextId });
    data.context_plan = contextPlan;
    data.context_plans = contextPlans;
    res.json({ data, weekStart: from, weekEnd: to });
  } catch (err) {
    log.error('GET /status', err);
    mealDomainError(res, err, 'Could not load Meal Status.');
  }
});

router.get('/plan-defaults', (_req, res) => {
  try {
    res.json({ data: getMealPlanDefaultSettings(db.get()) });
  } catch (err) {
    mealDomainError(res, err, 'Could not load Meal Plan Default Settings.');
  }
});

router.put('/plan-defaults', requireAdmin, (req, res) => {
  try {
    const data = saveMealPlanDefaultSettings(
      db.get(), req.body || {}, req.authUserId || req.session.userId,
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err, 'Could not save Meal Plan Default Settings.');
  }
});

router.get('/grocery-settings', (_req, res) => {
  try {
    res.json({ data: getGrocerySettings(db.get()) });
  } catch (err) {
    mealDomainError(res, err, 'Could not load grocery settings.');
  }
});

router.put('/grocery-settings', requireAdmin, (req, res) => {
  try {
    const data = saveGrocerySettings(
      db.get(), req.body || {}, req.authUserId || req.session.userId,
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err, 'Could not save grocery settings.');
  }
});

router.post('/:id/chooser/repair', requireAdmin, (req, res) => {
  try {
    const data = repairMealChooser(db.get(), Number(req.params.id), {
      actorId: req.authUserId || req.session.userId,
    });
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err, 'Could not repair the Meal chooser.');
  }
});

router.post('/:id/decisions', (req, res) => {
  try {
    const data = saveMealDecision(db.get(), Number(req.params.id), req.body || {}, {
      actorId: req.authUserId || req.session.userId,
      isAdmin: req.authRole === 'admin',
      deviceKey: req.body?.device_key || req.get('x-device-key') || null,
    });
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err, 'Could not save the meal decision.');
  }
});

router.get('/:id/menu-items', (req, res) => {
  try {
    res.json({ data: listMealMenuItems(db.get(), Number(req.params.id)) });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.post('/:id/menu-items', (req, res) => {
  try {
    const data = createMealMenuItem(
      db.get(), Number(req.params.id), req.body || {}, req.authUserId || req.session.userId,
      {
        isAdmin: req.authRole === 'admin',
        beneficiaryId: req.body?.beneficiary_user_id,
        deviceKey: req.body?.device_key || req.get('x-device-key') || null,
      },
    );
    res.status(201).json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.put('/:id/menu-items', (req, res) => {
  try {
    const data = replaceMealMenuItems(
      db.get(), Number(req.params.id), req.body || {}, req.authUserId || req.session.userId,
      {
        isAdmin: req.authRole === 'admin',
        beneficiaryId: req.body?.beneficiary_user_id,
        deviceKey: req.body?.device_key || req.get('x-device-key') || null,
      },
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.put('/:id/menu-items/:itemId', (req, res) => {
  try {
    const data = updateMealMenuItem(
      db.get(), Number(req.params.id), Number(req.params.itemId), req.body || {},
      req.authUserId || req.session.userId, {
        isAdmin: req.authRole === 'admin',
        beneficiaryId: req.body?.beneficiary_user_id,
        deviceKey: req.body?.device_key || req.get('x-device-key') || null,
      },
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
  }
});

router.delete('/:id/menu-items/:itemId', (req, res) => {
  try {
    const data = deleteMealMenuItem(
      db.get(), Number(req.params.id), Number(req.params.itemId),
      req.authUserId || req.session.userId, {
        isAdmin: req.authRole === 'admin',
        beneficiaryId: req.body?.beneficiary_user_id ?? req.query?.beneficiary_user_id,
        deviceKey: req.body?.device_key || req.get('x-device-key') || null,
      },
    );
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err);
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
      for (const userId of [slot.fixed_user_id, slot.fallback_user_id, slot.cook_user_id, slot.supervisor_user_id].filter(Boolean).map(Number)) {
        if (!validUsers.has(userId)) throw new Error('Choose a valid household member.');
      }
      for (const userId of (slot.participant_ids || []).map(Number)) {
        if (!validUsers.has(userId)) throw new Error('Choose valid meal participants.');
      }
      const selectionDeadline = Number(slot.selection_deadline_minutes ?? 1440);
      const reminderMinutes = Number(slot.reminder_minutes ?? 120);
      const snackLimit = Number(slot.snack_choice_limit ?? 3);
      if (!Number.isInteger(selectionDeadline) || selectionDeadline < 0 || selectionDeadline > 10080) throw new Error('Selection deadline must be between 0 and 10080 minutes.');
      if (!Number.isInteger(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 10080) throw new Error('Reminder lead time must be between 0 and 10080 minutes.');
      if (!Number.isInteger(snackLimit) || snackLimit < 1 || snackLimit > 20) throw new Error('Snack choice limit must be between 1 and 20.');
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
          , selection_deadline_minutes, reminder_minutes, snack_choice_limit,
          cook_user_id, supervisor_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(weekday, meal_type) DO UPDATE SET
          policy = excluded.policy, fixed_user_id = excluded.fixed_user_id,
          fallback_user_id = excluded.fallback_user_id, rotation_group = excluded.rotation_group,
          presence_required = excluded.presence_required, earliest_time = excluded.earliest_time,
          preferred_time = excluded.preferred_time, latest_time = excluded.latest_time,
          expected_duration_minutes = excluded.expected_duration_minutes, active = excluded.active,
          place_id = excluded.place_id,
          selection_deadline_minutes = excluded.selection_deadline_minutes,
          reminder_minutes = excluded.reminder_minutes,
          snack_choice_limit = excluded.snack_choice_limit,
          cook_user_id = excluded.cook_user_id,
          supervisor_user_id = excluded.supervisor_user_id,
          revision = meal_schedule_slots.revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `);
      const findSlot = d.prepare('SELECT id FROM meal_schedule_slots WHERE weekday = ? AND meal_type = ?');
      const clearParticipants = d.prepare('DELETE FROM meal_schedule_slot_participants WHERE schedule_slot_id = ?');
      const addParticipant = d.prepare('INSERT OR IGNORE INTO meal_schedule_slot_participants (schedule_slot_id, user_id) VALUES (?, ?)');
      const changedSlotIds = [];
      for (const slot of slots) {
        saveSlot.run(
          Number(slot.weekday), slot.meal_type, slot.policy || 'fixed',
          Number(slot.fixed_user_id) || null, Number(slot.fallback_user_id) || null,
          String(slot.rotation_group || '').trim() || null, slot.presence_required ? 1 : 0,
          slot.earliest_time || null, slot.preferred_time || null, slot.latest_time || null,
          Number(slot.expected_duration_minutes) || null, slot.active ? 1 : 0, actorId,
          Number(slot.place_id) || null,
          Number(slot.selection_deadline_minutes ?? 1440),
          Number(slot.reminder_minutes ?? 120),
          Number(slot.snack_choice_limit ?? 3),
          Number(slot.cook_user_id) || null,
          Number(slot.supervisor_user_id) || null,
        );
        const scheduleSlotId = findSlot.get(Number(slot.weekday), slot.meal_type).id;
        changedSlotIds.push(Number(scheduleSlotId));
        clearParticipants.run(scheduleSlotId);
        for (const userId of [...new Set((slot.participant_ids || []).map(Number))]) addParticipant.run(scheduleSlotId, userId);
      }
      applyLegacyMealScheduleEdits(d, { actorId, slotIds: changedSlotIds });

      // Reconcile only untouched generated placeholders. Meals that the household
      // has named or otherwise customized are dated overrides and remain intact.
      const stale = d.prepare(`
        SELECT m.id FROM meals m
         WHERE m.source = 'schedule' AND m.date >= ? AND m.title = 'Choose ' || m.meal_type
           AND m.schedule_slot_id IS NOT NULL AND m.meal_plan_id IS NULL
           AND m.planning_context_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM meal_occurrence_assignments oa WHERE oa.meal_id = m.id
           )
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

router.get('/execution-settings', (_req, res) => {
  try {
    res.json({ data: getMealExecutionSettings(db.get()) });
  } catch (err) {
    log.error('GET /execution-settings', err);
    res.status(500).json({ error: 'Could not load meal execution settings.', code: 500 });
  }
});

router.put('/execution-settings', requireAdmin, (req, res) => {
  try {
    const actorId = req.authUserId || req.session.userId;
    const data = saveMealExecutionSettings(
      db.get(), req.body || {}, actorId,
    );
    syncGrocerySettingsFromLegacy(db.get(), data, actorId);
    res.json({ data });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code || 400 });
  }
});

router.post('/execution/prepare', (req, res) => {
  try {
    const vFrom = date(req.body?.from, 'From date', true);
    const vTo = date(req.body?.to, 'To date', true);
    const errors = collectErrors([vFrom, vTo]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    if (vFrom.value > vTo.value) return res.status(400).json({ error: 'From date must be before end date.', code: 400 });
    const data = prepareMealExecutionRange(db.get(), {
      from: vFrom.value,
      to: vTo.value,
      actorId: req.authUserId || req.session.userId,
      listId: req.body?.shopping_list_id,
      logicalKey: req.body?.logical_key,
    });
    res.json({ data });
  } catch (err) {
    log.error('POST /execution/prepare', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not prepare meal execution.', code: err.code || 500 });
  }
});

router.get('/:id/execution', (req, res) => {
  try {
    const data = refreshExecutionStatus(db.get(), Number(req.params.id));
    if (!data) return res.status(404).json({ error: 'Meal execution not found.', code: 'MEAL_EXECUTION_NOT_FOUND' });
    res.json({ data });
  } catch (err) {
    log.error('GET /:id/execution', err);
    res.status(500).json({ error: 'Could not load meal execution.', code: 500 });
  }
});

router.post('/:id/execution-tasks', (req, res) => {
  try {
    const data = ensureMealExecution(
      db.get(), Number(req.params.id), req.authUserId || req.session.userId,
    );
    res.json({ data });
  } catch (err) {
    log.error('POST /:id/execution-tasks', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not create meal execution Tasks.', code: err.code || 500 });
  }
});

router.post('/planning/materialize', (req, res) => {
  try {
    const refDate = req.body.week && DATE_RE.test(req.body.week) ? req.body.week : todayKey(db.get());
    const from = weekStart(refDate);
    const to = weekEnd(refDate);
    const actorId = req.authUserId || req.session.userId;
    const planned = materializeMealPlanOccurrences(db.get(), { from, to, actorId });
    const created = planned.created + materializeMealSchedule(from, to, actorId);
    const settings = getMealExecutionSettings(db.get());
    const execution = settings?.enabled
      ? prepareMealExecutionRange(db.get(), { from, to, actorId })
      : null;
    res.json({ data: { created, weekStart: from, weekEnd: to, execution } });
  } catch (err) {
    log.error('POST /planning/materialize', err);
    res.status(500).json({ error: 'Could not prepare the meal plan.', code: 500 });
  }
});

router.get('/selection-requests', (req, res) => {
  try {
    res.json({ data: mealSelectionRequests(req.authUserId || req.session.userId) });
  } catch (err) {
    log.error('GET /selection-requests', err);
    res.status(500).json({ error: 'Could not load meal-selection requests.', code: 500 });
  }
});

router.get('/selection-requests-household', requireAdmin, (req, res) => {
  try {
    res.json({ data: mealSelectionRequests(req.authUserId || req.session.userId, { household: true }) });
  } catch (err) {
    res.status(500).json({ error: 'Could not load household meal-selection requests.', code: 500 });
  }
});

router.post('/selection-requests/:id/respond', (req, res) => {
  try {
    const actorId = req.authUserId || req.session.userId;
    const data = respondToMealSelection(
      Number(req.params.id), req.body || {}, req.authUserId || req.session.userId,
    );
    const selectedMealIds = data.meal_ids || (data.meal_id ? [data.meal_id] : []);
    const selectedMeals = selectedMealIds.length
      ? db.get().prepare(`SELECT id, date FROM meals WHERE id IN (${selectedMealIds.map(() => '?').join(',')}) AND selection_status = 'selected'`).all(...selectedMealIds)
      : [];
    if (selectedMeals.length && getMealExecutionSettings(db.get())?.enabled) {
      const from = weekStart(selectedMeals[0].date);
      data.execution = prepareMealExecutionRange(db.get(), {
        from, to: weekEnd(from), actorId,
      });
    }
    res.json({ data });
  } catch (err) {
    mealDomainError(res, err, 'Could not respond to the Meal choice request.');
  }
});

router.post('/selection-requests/process-timeouts', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const due = d.prepare(`
      SELECT id FROM planning_obligations
       WHERE entity_type = 'meal' AND role = 'chooser' AND status IN ('pending', 'accepted')
         AND response_deadline IS NOT NULL
         AND response_deadline <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       ORDER BY id
    `).all();
    const results = due.map((row) => respondToMealSelection(
      row.id, { action: 'timeout' }, req.authUserId || req.session.userId, { timeout: true },
    ));
    res.json({ data: { processed: results.length, results } });
  } catch (err) {
    mealDomainError(res, err, 'Could not process overdue Meal choice requests.');
  }
});

router.post('/planning/reconcile', requireAdmin, (req, res) => {
  try {
    const dateKey = String(req.body.date || '');
    if (!DATE_RE.test(dateKey)) throw new Error('Choose a valid date.');
    const mealType = req.body.meal_type ? String(req.body.meal_type) : null;
    if (mealType && !VALID_MEAL_TYPES.includes(mealType)) throw new Error('Choose a valid meal type.');
    const d = db.get();
    const rows = d.prepare(`
      SELECT m.id FROM meals m
       WHERE m.source = 'schedule' AND m.date = ?
         AND (? IS NULL OR m.meal_type = ?)
         AND m.title = 'Choose ' || m.meal_type
         AND m.selection_status = 'awaiting_choice'
         AND m.schedule_slot_id IS NOT NULL AND m.meal_plan_id IS NULL
         AND m.planning_context_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM meal_occurrence_assignments oa WHERE oa.meal_id = m.id
         )
    `).all(dateKey, mealType, mealType);
    d.transaction(() => {
      for (const row of rows) {
        d.prepare("DELETE FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ?").run(row.id);
        d.prepare('DELETE FROM meals WHERE id = ?').run(row.id);
      }
    })();
    const created = materializeMealSchedule(dateKey, dateKey, req.authUserId || req.session.userId);
    res.json({ data: { removed: rows.length, created, date: dateKey, meal_type: mealType } });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.get('/conflicts', (req, res) => {
  try {
    const refDate = req.query.week && DATE_RE.test(req.query.week) ? req.query.week : todayKey(db.get());
    const from = weekStart(refDate);
    const to = weekEnd(refDate);
    const data = req.query.refresh === 'false'
      ? listMealCalendarConflicts(db.get(), { from, to })
      : reconcileMealCalendarConflicts(db.get(), { from, to });
    res.json({ data, weekStart: from, weekEnd: to });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.post('/conflicts/:id/resolve', (req, res) => {
  try {
    const data = resolveMealCalendarConflict(
      db.get(), Number(req.params.id), String(req.body.resolution || ''),
      req.body.payload || {}, req.authUserId || req.session.userId,
    );
    res.json({ data });
  } catch (err) {
    const missing = /not found/i.test(err.message);
    res.status(missing ? 404 : 400).json({ error: err.message, code: missing ? 404 : 400 });
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
    materializeMealPlanOccurrences(db.get(), {
      from, to, actorId: req.authUserId || req.session.userId,
    });
    materializeMealSchedule(from, to, req.authUserId || req.session.userId);
    const conflicts = reconcileMealCalendarConflicts(db.get(), { from, to });

    // recurrence_end_date kommt aus der Vorlage mit: die Oberfläche zeigt im
    // Bearbeiten-Dialog, bis wann die Serie läuft, und muss dafür nicht pro Karte
    // nachfragen. NULL heißt unbegrenzt.
    const meals = db.get().prepare(`
      SELECT m.*, u.display_name AS creator_name, u.avatar_color AS creator_color,
             mrt.end_date AS recurrence_end_date,
             pc.name AS context_name, pc.context_type,
             place.name AS place_name
      FROM meals m
      LEFT JOIN users u ON u.id = m.created_by
      LEFT JOIN meal_recurrence_templates mrt ON mrt.id = m.recurrence_template_id
      LEFT JOIN planning_contexts pc ON pc.id = m.planning_context_id
      LEFT JOIN places place ON place.id = m.place_id
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
    const executionMap = {};
    if (mealIds.length) {
      const rows = db.get().prepare(`
        SELECT mes.meal_id, mes.status, mes.revision,
          COUNT(met.id) AS task_total,
          SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS task_done
        FROM meal_execution_snapshots mes
        LEFT JOIN meal_execution_tasks met ON met.meal_snapshot_id = mes.id
        LEFT JOIN tasks t ON t.id = met.task_id
        WHERE mes.meal_id IN (${mealIds.map(() => '?').join(',')})
        GROUP BY mes.id
      `).all(...mealIds);
      for (const row of rows) executionMap[row.meal_id] = row;
    }
    const conflictsByMeal = conflicts.reduce((map, conflict) => {
      (map[conflict.meal_id] ||= []).push(conflict);
      return map;
    }, {});
    const result = meals.map((m) => ({
      ...m,
      portions: m.portions_mode === 'fixed' ? Number(m.portions) : null,
      effective_portions: Number(m.portions) || 1,
      ingredients_manual_override: Boolean(m.ingredients_manual_override),
      dish: presentDishSelection(m),
      menu_items: listMealMenuItems(db.get(), m.id),
      ingredients: ingredientMap[m.id] || [],
      recipe_ingredient_count: recipeCountMap[m.id] ?? 0,
      participants: participantMap[m.id] || [],
      calendar_conflicts: conflictsByMeal[m.id] || [],
      execution: executionMap[m.id] || null,
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
    const preferredMenu = preferredMealMenu(req.body);
    if (preferredMenu && (req.body.repeat_weekly === true || req.body.scope === 'skipped')) {
      return res.status(400).json({
        error: 'New Meals use Meal Plans for recurrence and participant decisions for non-participation.',
        code: 'LEGACY_MEAL_WRITE_NOT_ALLOWED',
      });
    }
    const vDate       = date(req.body.date, 'Datum', true);
    const vType       = oneOf(req.body.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ');
    const vCustomLabel = str(req.body.custom_label, 'Custom meal label', { max: MAX_TITLE, required: false });
    const vTitle      = str(preferredMenu?.dish.title ?? req.body.title, 'Titel', { max: MAX_TITLE });
    const vNotes      = str(req.body.notes, 'Notizen', { max: MAX_TEXT, required: false });
    const vRecipeUrl  = str(req.body.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
    const vRecipeId   = num(preferredMenu?.dish.recipe_id ?? req.body.recipe_id, 'Rezept-ID', { required: false });
    const vScope      = oneOf(req.body.scope || 'household', preferredMenu ? NEW_MEAL_SCOPES : VALID_MEAL_SCOPES, 'Meal scope');
    let planningContextId = null;
    try { planningContextId = requestedContextId(req.body.planning_context_id); }
    catch (error) { return res.status(400).json({ error: error.message, code: 400 }); }
    const duration = req.body.expected_duration_minutes == null || req.body.expected_duration_minutes === ''
      ? null : Number(req.body.expected_duration_minutes);
    const repeatWeekly = req.body.repeat_weekly === true;
    // Leeres/fehlendes repeat_until heißt „ohne Ende" - die Serie bleibt dann
    // unbegrenzt, wie vor #619, aber jetzt als bewusste Wahl statt als einziger Zustand.
    const vRepeatUntil = repeatWeekly
      ? date(req.body.repeat_until, 'Wiederholungs-Ende')
      : { value: null, error: null };
    const errors = collectErrors([vDate, vType, vCustomLabel, vTitle, vNotes, vRecipeUrl, vRecipeId, vScope, vRepeatUntil]);
    if (!req.body.meal_type) errors.push('Mahlzeit-Typ ist erforderlich.');
    if (vType.value === 'custom' && !vCustomLabel.value) errors.push('Custom meal label is required.');
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
    if (repeatWeekly && planningContextId) {
      errors.push('A context-specific Meal is dated once. Use a Meal Plan for recurring travel meals.');
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
    try { validateMealPlanningContext(db.get(), planningContextId, vDate.value); }
    catch (error) { return res.status(400).json({ error: error.message, code: 400 }); }

    let cleanParticipants;
    try { cleanParticipants = normalizeMealParticipants(participants); }
    catch (error) { return res.status(400).json({ error: error.message, code: 400 }); }

    const meal = db.transaction(() => {
      const cleanIngredients = sanitizedIngredients(ingredients);
      let recurrenceTemplateId = null;

      if (repeatWeekly) {
        const template = db.get().prepare(`
          INSERT INTO meal_recurrence_templates
            (start_date, end_date, weekday, meal_type, custom_label, title, notes, recipe_url, recipe_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          vDate.value,
          vRepeatUntil.value,
          mealWeekday(vDate.value),
          vType.value,
          vType.value === 'custom' ? vCustomLabel.value : null,
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
          date, meal_type, custom_label, title, notes, recipe_url, recipe_id, recurrence_template_id, created_by,
          scope, scheduled_time, earliest_time, preferred_time, latest_time,
          expected_duration_minutes, source, provenance_json
          , place_id, planning_context_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        vDate.value, vType.value, vType.value === 'custom' ? vCustomLabel.value : null,
        vTitle.value, vNotes.value, vRecipeUrl.value, vRecipeId.value,
        recurrenceTemplateId, req.authUserId || req.session.userId, vScope.value,
        req.body.scheduled_time || null, req.body.earliest_time || null,
        req.body.preferred_time || null, req.body.latest_time || null, duration,
        recurrenceTemplateId ? 'recurrence' : 'manual',
        JSON.stringify({
          source: recurrenceTemplateId ? 'recurrence' : 'manual',
          created_from: 'meal_editor',
          planning_context_id: planningContextId,
        }),
        placeId, planningContextId,
      );

      const mealId = result.lastInsertRowid;

      replaceMealParticipants(mealId, cleanParticipants);

      const actorId = req.authUserId || req.session.userId;
      if (preferredMenu) {
        replaceMealMenuItems(db.get(), mealId, preferredMenu.items, actorId, {
          isAdmin: req.authRole === 'admin',
          deviceKey: req.body?.device_key || req.get('x-device-key') || null,
        });
      }
      if (preferredMenu || Object.hasOwn(req.body, 'portions_mode') || Object.hasOwn(req.body, 'portions')) {
        applyMealPortions(mealId, {
          ...req.body,
          recipe_id: vRecipeId.value,
          ingredients: Array.isArray(req.body.ingredients) ? cleanIngredients : undefined,
        });
      } else {
        insertMealIngredients(mealId, cleanIngredients);
      }

      return loadMealWithIngredients(mealId);
    });

    res.status(201).json({ data: meal });
  } catch (err) {
    mealDomainError(res, err, 'Could not create the Meal.');
  }
});

router.post('/apply-plan', (req, res) => {
  try {
    const assignments = Array.isArray(req.body.assignments) ? req.body.assignments : [];
    const replaceExisting = req.body.replace_existing === true;
    let defaultContextId = null;
    try { defaultContextId = requestedContextId(req.body.planning_context_id); }
    catch (error) { return res.status(400).json({ error: error.message, code: 400 }); }
    if (!assignments.length) {
      return res.status(400).json({ error: 'Mindestens eine Mahlzeit ist erforderlich.', code: 400 });
    }

    const prepared = [];
    const recipeIds = new Set();
    for (const assignment of assignments) {
      const vDate = date(assignment.date, 'Datum', true);
      const vType = oneOf(assignment.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ');
      const vCustomLabel = str(assignment.custom_label, 'Custom meal label', { max: MAX_TITLE, required: false });
      const vTitle = str(assignment.title, 'Titel', { max: MAX_TITLE });
      const vNotes = str(assignment.notes, 'Notizen', { max: MAX_TEXT, required: false });
      const vRecipeUrl = str(assignment.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false });
      const vRecipeId = num(assignment.recipe_id, 'Rezept-ID', { required: false });
      let planningContextId = defaultContextId;
      try {
        if (Object.prototype.hasOwnProperty.call(assignment, 'planning_context_id')) {
          planningContextId = requestedContextId(assignment.planning_context_id);
        }
      } catch (error) {
        return res.status(400).json({ error: error.message, code: 400 });
      }
      const errors = collectErrors([vDate, vType, vCustomLabel, vTitle, vNotes, vRecipeUrl, vRecipeId]);
      if (!assignment.meal_type) errors.push('Mahlzeit-Typ ist erforderlich.');
      if (vType.value === 'custom' && !vCustomLabel.value) errors.push('Custom meal label is required.');
      if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
      try { validateMealPlanningContext(db.get(), planningContextId, vDate.value); }
      catch (error) { return res.status(400).json({ error: error.message, code: 400 }); }
      if (vRecipeId.value !== null) recipeIds.add(vRecipeId.value);
      prepared.push({
        date: vDate.value,
        meal_type: vType.value,
        custom_label: vType.value === 'custom' ? vCustomLabel.value : null,
        title: vTitle.value,
        notes: vNotes.value,
        recipe_url: vRecipeUrl.value,
        recipe_id: vRecipeId.value,
        ingredients: assignment.ingredients || [],
        planning_context_id: planningContextId,
      });
    }

    for (const recipeId of recipeIds) {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId);
      if (!recipeExists) return res.status(400).json({ error: 'Rezept nicht gefunden.', code: 400 });
    }

    const created = db.transaction(() => {
      const actorId = req.authUserId || req.session.userId;
      if (replaceExisting) {
        const slots = [...new Set(prepared.map((assignment) => (
          `${assignment.date}\u0000${assignment.meal_type}\u0000${assignment.planning_context_id ?? 'home'}`
        )))];
        const selectHomeMeals = db.get().prepare(`
          SELECT * FROM meals
           WHERE date = ? AND meal_type = ? AND planning_context_id IS NULL
             AND parent_meal_id IS NULL AND meal_plan_id IS NULL
           ORDER BY id ASC
        `);
        const selectContextMeals = db.get().prepare(`
          SELECT * FROM meals
           WHERE date = ? AND meal_type = ? AND planning_context_id = ?
             AND parent_meal_id IS NULL AND meal_plan_id IS NULL
           ORDER BY id ASC
        `);
        for (const slot of slots) {
          const [slotDate, slotType, rawContext] = slot.split('\u0000');
          const contextId = rawContext === 'home' ? null : Number(rawContext);
          const existingMeals = contextId == null
            ? selectHomeMeals.all(slotDate, slotType)
            : selectContextMeals.all(slotDate, slotType, contextId);
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
    const preferredMenu = preferredMealMenu(req.body, meal);
    if (preferredMenu && (req.query.scope === 'series' || req.body.scope === 'skipped')) {
      return res.status(400).json({
        error: 'The Add/Edit Meal contract edits one dated Meal and does not write the legacy skipped scope.',
        code: 'LEGACY_MEAL_WRITE_NOT_ALLOWED',
      });
    }
    const writeBody = preferredMenu ? {
      ...req.body,
      title: preferredMenu.dish.title,
      recipe_id: preferredMenu.dish.recipe_id,
    } : req.body;

    const checks = [];
    if (writeBody.date       !== undefined) checks.push(date(writeBody.date, 'Datum'));
    if (writeBody.meal_type  !== undefined) checks.push(oneOf(writeBody.meal_type, VALID_MEAL_TYPES, 'Mahlzeit-Typ'));
    if (writeBody.custom_label !== undefined) checks.push(str(writeBody.custom_label, 'Custom meal label', { max: MAX_TITLE, required: false }));
    if (writeBody.title      !== undefined) checks.push(str(writeBody.title, 'Titel', { max: MAX_TITLE, required: false }));
    if (writeBody.notes      !== undefined) checks.push(str(writeBody.notes, 'Notizen', { max: MAX_TEXT, required: false }));
    if (writeBody.recipe_url !== undefined) checks.push(str(writeBody.recipe_url, 'Rezept-URL', { max: MAX_TEXT, required: false }));
    if (writeBody.recipe_id  !== undefined) checks.push(num(writeBody.recipe_id, 'Rezept-ID', { required: false }));
    if (writeBody.scope !== undefined) checks.push(oneOf(writeBody.scope, preferredMenu ? NEW_MEAL_SCOPES : VALID_MEAL_SCOPES, 'Meal scope'));
    const errors = collectErrors(checks);
    const nextMealType = req.body.meal_type ?? meal.meal_type;
    const nextCustomLabel = req.body.custom_label === undefined
      ? meal.custom_label
      : (String(req.body.custom_label || '').trim() || null);
    if (nextMealType === 'custom' && !nextCustomLabel) errors.push('Custom meal label is required.');
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

    if (writeBody.recipe_id !== undefined && writeBody.recipe_id !== null && writeBody.recipe_id !== '') {
      const recipeExists = db.get().prepare('SELECT id FROM recipes WHERE id = ?').get(writeBody.recipe_id);
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
      const nCustomLabel = req.body.custom_label !== undefined
        ? (String(req.body.custom_label || '').trim() || null)
        : tpl.custom_label;
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
          SET meal_type = ?, custom_label = ?, title = ?, notes = ?, recipe_url = ?, recipe_id = ?, end_date = ?
          WHERE id = ?
        `).run(nMealType, nMealType === 'custom' ? nCustomLabel : null,
          nTitle, nNotes, nRecipeUrl, nRecipeId, nEndDate, templateId);

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
          SET meal_type = ?, custom_label = ?, title = ?, notes = ?, recipe_url = ?, recipe_id = ?
          WHERE recurrence_template_id = ?
        `).run(nMealType, nMealType === 'custom' ? nCustomLabel : null,
          nTitle, nNotes, nRecipeUrl, nRecipeId, templateId);

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

    db.transaction(() => {
      db.get().prepare(`
        UPDATE meals
      SET date       = COALESCE(?, date),
          meal_type  = COALESCE(?, meal_type),
          custom_label = ?,
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
      writeBody.date      ?? null,
      writeBody.meal_type ?? null,
      nextMealType === 'custom' ? nextCustomLabel : null,
      writeBody.title?.trim() ?? null,
      writeBody.notes       !== undefined ? (writeBody.notes || null)       : meal.notes,
      writeBody.recipe_url  !== undefined ? (writeBody.recipe_url || null)  : meal.recipe_url,
      writeBody.recipe_id   !== undefined ? (writeBody.recipe_id || null)   : meal.recipe_id,
      writeBody.scope !== undefined ? writeBody.scope : meal.scope,
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

      const actorId = req.authUserId || req.session.userId;
      if (preferredMenu) {
        replaceMealMenuItems(db.get(), id, preferredMenu.items, actorId, {
          isAdmin: req.authRole === 'admin',
          deviceKey: req.body?.device_key || req.get('x-device-key') || null,
        });
      }
      applyMealPortions(id, writeBody, meal);
    });

    res.json({ data: loadMealWithIngredients(id) });
  } catch (err) {
    mealDomainError(res, err, 'Could not update the Meal.');
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
    db.get().prepare('UPDATE meals SET ingredients_manual_override = 1 WHERE id = ?').run(mealId);

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
    if (name !== undefined || quantity !== undefined || category !== undefined) {
      db.get().prepare('UPDATE meals SET ingredients_manual_override = 1 WHERE id = ?').run(ing.meal_id);
    }

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
    const ingredient = db.get().prepare('SELECT meal_id FROM meal_ingredients WHERE id = ?').get(ingId);
    const result = db.get().prepare('DELETE FROM meal_ingredients WHERE id = ?').run(ingId);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Zutat nicht gefunden', code: 404 });
    db.get().prepare('UPDATE meals SET ingredients_manual_override = 1 WHERE id = ?').run(ingredient.meal_id);
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
