const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TIMING_MODES = new Set(['weekly', 'per_meal']);
const GROUPING_MODES = new Set(['ingredient', 'category', 'meal', 'recipe']);
const LEGACY_AGGREGATION_MODES = new Set(['ingredient', 'meal', 'recipe']);

function settingsError(message, status = 400, code = 'INVALID_MEAL_GROCERY_SETTINGS') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === 1 || value === '1';
}

function integer(value, fallback, { min, max, field }) {
  const number = value == null || value === '' ? Number(fallback) : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw settingsError(`${field} is invalid.`);
  }
  return number;
}

function time(value, fallback, field) {
  const normalized = String(value == null || value === '' ? fallback : value);
  if (!TIME_RE.test(normalized)) throw settingsError(`${field} must use HH:MM.`);
  return normalized;
}

function shoppingLists(database) {
  return database.prepare(`
    SELECT id, name
      FROM shopping_lists
     ORDER BY name COLLATE NOCASE, id
  `).all();
}

function categoryGroupingAvailable(database) {
  return Boolean(database.prepare(`
    SELECT 1
      FROM shopping_categories
     WHERE trim(name) != ''
     LIMIT 1
  `).get());
}

function presentSettings(database, row) {
  if (!row) throw settingsError(
    'Meal grocery settings are unavailable.',
    500,
    'MEAL_GROCERY_SETTINGS_MISSING',
  );
  const lists = shoppingLists(database);
  const configuredListId = Number(row.default_shopping_list_id) || null;
  const configured = lists.find((list) => Number(list.id) === configuredListId) || null;
  const effective = configured || lists[0] || null;
  const groupingMode = GROUPING_MODES.has(String(row.grouping_mode))
    ? String(row.grouping_mode)
    : String(row.aggregation_mode || 'ingredient');
  return {
    ...row,
    configured_default_shopping_list_id: configuredListId,
    default_shopping_list_id: effective ? Number(effective.id) : null,
    default_shopping_list: effective,
    shopping_lists: lists,
    shopping_list_action: effective ? 'use_existing' : 'create',
    timing_mode: TIMING_MODES.has(String(row.timing_mode)) ? row.timing_mode : 'weekly',
    grouping_mode: groupingMode,
    grouping_options: {
      ingredient: true,
      category: categoryGroupingAvailable(database),
      meal: true,
      recipe: true,
    },
    weekly_timing: {
      weekday_numbering: 'monday_zero',
      target: 'following_week',
      automatic_execution: false,
      draft_weekday: Number(row.draft_weekday),
      draft_time: row.draft_time,
      finalization_weekday: Number(row.finalization_weekday),
      finalization_time: row.finalization_time,
    },
  };
}

export function getGrocerySettings(database) {
  return presentSettings(
    database,
    database.prepare('SELECT * FROM meal_grocery_settings WHERE id = 1').get(),
  );
}

export function getContextGrocerySettings(database, contextId) {
  const context = database.prepare(`
    SELECT id, name, context_type, starts_at, ends_at
      FROM planning_contexts WHERE id = ?
  `).get(Number(contextId));
  if (!context) throw settingsError('Planning context not found.', 404, 'PLANNING_CONTEXT_NOT_FOUND');
  const override = database.prepare(`
    SELECT * FROM planning_context_grocery_settings WHERE planning_context_id = ?
  `).get(context.id);
  return {
    context,
    track_groceries: override ? Boolean(override.track_groceries) : true,
    inherits_household_defaults: true,
    override: override || null,
  };
}

export function saveContextGrocerySettings(database, contextId, body, actorId) {
  const current = getContextGrocerySettings(database, contextId);
  const enabled = bool(body?.track_groceries, current.track_groceries) ? 1 : 0;
  database.prepare(`
    INSERT INTO planning_context_grocery_settings (
      planning_context_id, track_groceries, updated_by
    ) VALUES (?, ?, ?)
    ON CONFLICT(planning_context_id) DO UPDATE SET
      track_groceries = excluded.track_groceries,
      updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(Number(contextId), enabled, actorId || null);
  return getContextGrocerySettings(database, contextId);
}

function resolveShoppingList(database, body, current, actorId) {
  const newName = body?.new_shopping_list_name == null
    ? ''
    : String(body.new_shopping_list_name).trim();
  if (newName.length > 200) throw settingsError('Shopping list name may be at most 200 characters long.');
  if (newName) {
    const existing = database.prepare(`
      SELECT id FROM shopping_lists WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1
    `).get(newName);
    if (existing) return Number(existing.id);
    return Number(database.prepare(`
      INSERT INTO shopping_lists (name, created_by) VALUES (?, ?)
    `).run(newName, actorId || null).lastInsertRowid);
  }

  const hasExplicitId = Object.hasOwn(body || {}, 'default_shopping_list_id');
  if (hasExplicitId && body.default_shopping_list_id !== '' && body.default_shopping_list_id != null) {
    const listId = Number(body.default_shopping_list_id);
    if (!Number.isInteger(listId) || !database.prepare('SELECT 1 FROM shopping_lists WHERE id = ?').get(listId)) {
      throw settingsError('Default Shopping list not found.', 404, 'SHOPPING_LIST_NOT_FOUND');
    }
    return listId;
  }
  if (hasExplicitId) return Number(shoppingLists(database)[0]?.id) || null;

  const currentId = Number(current.configured_default_shopping_list_id) || null;
  if (currentId && database.prepare('SELECT 1 FROM shopping_lists WHERE id = ?').get(currentId)) return currentId;
  return Number(shoppingLists(database)[0]?.id) || null;
}

export function saveGrocerySettings(database, body, actorId) {
  const current = getGrocerySettings(database);
  const timingMode = String(body?.timing_mode ?? current.timing_mode);
  if (!TIMING_MODES.has(timingMode)) {
    throw settingsError('Choose weekly cutoffs or the legacy per-meal lead time.');
  }
  const draftWeekday = integer(body?.draft_weekday, current.draft_weekday, {
    min: 0, max: 6, field: 'Grocery draft weekday',
  });
  const draftTime = time(body?.draft_time, current.draft_time, 'Grocery draft time');
  const finalizationWeekday = integer(body?.finalization_weekday, current.finalization_weekday, {
    min: 0, max: 6, field: 'Grocery finalization weekday',
  });
  const finalizationTime = time(
    body?.finalization_time,
    current.finalization_time,
    'Grocery finalization time',
  );
  if (
    draftWeekday > finalizationWeekday
    || (draftWeekday === finalizationWeekday && draftTime > finalizationTime)
  ) {
    throw settingsError(
      'Grocery draft creation must occur before or at the weekly finalization cutoff.',
      409,
      'GROCERY_WEEKLY_TIMING_ORDER',
    );
  }

  const requestedGrouping = String(
    body?.grouping_mode ?? body?.aggregation_mode ?? current.grouping_mode,
  );
  if (!GROUPING_MODES.has(requestedGrouping)) {
    throw settingsError('Choose ingredient, ingredient category, Meal, or Recipe grouping.');
  }
  if (requestedGrouping === 'category' && !categoryGroupingAvailable(database)) {
    throw settingsError(
      'Ingredient category grouping is unavailable until a Shopping category exists.',
      409,
      'INGREDIENT_CATEGORY_GROUPING_UNAVAILABLE',
    );
  }
  const requestedAggregation = String(body?.aggregation_mode ?? current.aggregation_mode);
  const legacyAggregation = LEGACY_AGGREGATION_MODES.has(requestedAggregation)
    ? requestedAggregation
    : (LEGACY_AGGREGATION_MODES.has(requestedGrouping) ? requestedGrouping : current.aggregation_mode);
  const groceryLeadMinutes = integer(body?.grocery_lead_minutes, current.grocery_lead_minutes, {
    min: 0, max: 10080, field: 'Grocery lead time',
  });

  database.transaction(() => {
    const listId = resolveShoppingList(database, body, current, actorId);
    database.prepare(`
      UPDATE meal_grocery_settings
         SET enabled = ?, default_shopping_list_id = ?,
             auto_create_grocery_draft = ?, auto_finalize_grocery = ?,
             grocery_lead_minutes = ?, aggregation_mode = ?, grouping_mode = ?,
             timing_mode = ?, draft_weekday = ?, draft_time = ?,
             finalization_weekday = ?, finalization_time = ?,
             updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = 1
    `).run(
      bool(body?.enabled, Boolean(current.enabled)) ? 1 : 0,
      listId,
      bool(body?.auto_create_grocery_draft, Boolean(current.auto_create_grocery_draft)) ? 1 : 0,
      bool(body?.auto_finalize_grocery, Boolean(current.auto_finalize_grocery)) ? 1 : 0,
      groceryLeadMinutes,
      legacyAggregation,
      requestedGrouping,
      timingMode,
      draftWeekday,
      draftTime,
      finalizationWeekday,
      finalizationTime,
      actorId || null,
    );
    database.prepare(`
      UPDATE meal_execution_settings
         SET default_shopping_list_id = ?, auto_create_grocery_draft = ?,
             auto_finalize_grocery = ?, updated_by = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = 1
    `).run(
      listId,
      bool(body?.auto_create_grocery_draft, Boolean(current.auto_create_grocery_draft)) ? 1 : 0,
      bool(body?.auto_finalize_grocery, Boolean(current.auto_finalize_grocery)) ? 1 : 0,
      actorId || null,
    );
  })();
  return getGrocerySettings(database);
}

export function syncGrocerySettingsFromLegacy(database, legacy, actorId) {
  if (!legacy) return null;
  const current = getGrocerySettings(database);
  const listId = Number(legacy.default_shopping_list_id)
    || Number(current.default_shopping_list_id)
    || null;
  database.prepare(`
    UPDATE meal_grocery_settings
       SET default_shopping_list_id = ?,
           auto_create_grocery_draft = ?, auto_finalize_grocery = ?,
           updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = 1
  `).run(
    listId,
    legacy.auto_create_grocery_draft ? 1 : 0,
    legacy.auto_finalize_grocery ? 1 : 0,
    actorId || null,
  );
  return getGrocerySettings(database);
}

export { GROUPING_MODES, TIMING_MODES, settingsError };
