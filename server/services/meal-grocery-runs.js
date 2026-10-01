import {assertCycleMealWrite} from './meal-cycle-guards.js';
import { createHash } from 'node:crypto';
import { aggregateMealIngredients, parseQuantity, groceryCoverage } from './shopping-import.js';
import { scaleIngredientQuantity, mealDishPortionSummary } from './meal-dishes.js';
import { getGrocerySettings } from './meal-grocery-settings.js';
import { notifyGroceryPublished } from './notification-events.js';

const RUN_STATES = ['draft', 'finalized', 'added_to_shopping', 'purchased', 'reconciled'];

function validateGroceryScope(database, from, to, mealIds) {
  if (mealIds !== null && (!Array.isArray(mealIds) || mealIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
    throw serviceError('mealIds must be an explicit array of meal IDs.');
  }
  const ids = mealIds === null
    ? database.prepare('SELECT id FROM meals WHERE date BETWEEN ? AND ?').all(from,to).map(x=>x.id)
    : [...new Set(mealIds)].sort((a,b)=>a-b);
  for (const id of ids) {
    const meal = database.prepare('SELECT date FROM meals WHERE id=?').get(id);
    if (!meal || meal.date < from || meal.date > to) throw serviceError('Grocery scope contains an unavailable or out-of-period meal.');
    assertCycleMealWrite(database,id);
  }
  return mealIds === null ? null : ids;
}

// Once a Meal has source demand in a grocery run, even an unpublished draft,
// changes belong to that run. Refreshing a draft removes obsolete source rows.
// Legacy importers cannot safely manufacture new, unlinked copies of that
// demand (including Recipe ingredients not materialized as meal_ingredients).
export function assertLegacyMealImportAllowed(database, mealIds) {
  const ids = [...new Set(mealIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return;
  for (const id of ids) assertCycleMealWrite(database,id);
  const multipleDishes = ids.some((id) => {
    const summary = mealDishPortionSummary(database, id);
    return summary.dishes.length !== 1 || summary.dishes.some((dish) => !dish.primary || dish.meal_id !== id);
  });
  const conflict = database.prepare(`SELECT 1 FROM meal_grocery_item_sources s
    JOIN meal_grocery_items i ON i.id = s.grocery_item_id
    WHERE s.meal_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`).get(...ids);
  if (conflict || multipleDishes) throw serviceError(
    'These Meal choices need a grocery run. Open Shopping and create or refresh its Meal grocery draft, then finalize it to keep purchases and Pantry quantities together.',
    409, 'GROCERY_RECONCILIATION_REQUIRED',
  );
}

function serviceError(message, status = 400, code = 'INVALID_GROCERY_RUN') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function defaultLogicalKey(listId, from, to) {
  return `meal-plan:${listId}:${from}:${to}`;
}

function sourceKey(row) {
  if (row.source_kind === 'meal_ingredient') return `meal-ingredient:${row.meal_ingredient_id}`;
  if (row.menu_item_id) return `meal:${row.meal_id}:menu:${row.menu_item_id}:recipe-ingredient:${row.recipe_ingredient_id}`;
  return `meal:${row.meal_id}:recipe-ingredient:${row.recipe_ingredient_id}`;
}

function normalizedGroupingMode(value) {
  return ['ingredient', 'category', 'meal', 'recipe'].includes(String(value))
    ? String(value)
    : 'ingredient';
}

function groupingDescriptor(row, mode) {
  const category = String(row.category ?? row.category_snapshot ?? 'Sonstiges').trim() || 'Sonstiges';
  const mealId = Number(row.meal_id) || null;
  const mealDate = String(row.meal_date ?? row.meal_date_snapshot ?? '').trim();
  const mealTitle = String(row.meal_title ?? row.meal_title_snapshot ?? 'Meal').trim() || 'Meal';
  const recipeId = Number(row.recipe_id) || null;
  const recipeTitle = String(row.recipe_title ?? row.recipe_title_snapshot ?? '').trim();
  if (mode === 'category') {
    return { key: `category:${category.toLocaleLowerCase()}`, label: category };
  }
  if (mode === 'meal') {
    return {
      key: `meal:${mealId || `${mealDate}:${mealTitle.toLocaleLowerCase()}`}`,
      label: mealDate ? `${mealDate} · ${mealTitle}` : mealTitle,
    };
  }
  if (mode === 'recipe') {
    return recipeId ? {
      key: `recipe:${recipeId}`,
      label: recipeTitle || mealTitle,
    } : {
      key: `meal:${mealId || `${mealDate}:${mealTitle.toLocaleLowerCase()}`}`,
      label: mealTitle,
    };
  }
  return { key: 'ingredient', label: null };
}

function baseDemandKey(logicalKey) {
  const parts = String(logicalKey || '').split(':');
  return parts[0] === 'ingredient' && parts[1]
    ? `${parts[0]}:${parts[1]}`
    : String(logicalKey || '');
}

export function loadSourceIngredients(database, from, to, mealIds = null) {
  const baseRows = database.prepare(`
    SELECT
      'meal_ingredient' AS source_kind,
      m.id AS meal_id,
      mi.id AS meal_ingredient_id,
      m.recipe_id AS recipe_id,
      NULL AS recipe_ingredient_id,
      m.date AS meal_date,
      m.title AS meal_title,
      r.title AS recipe_title,
      m.planned_portions AS planned_portions,
      m.portions AS cook_portions,
      r.yield_portions AS recipe_yield_portions,
      mi.name,
      mi.quantity,
      mi.category
    FROM meals m
    JOIN meal_ingredients mi ON mi.meal_id = m.id
    LEFT JOIN recipes r ON r.id = m.recipe_id
    WHERE m.date BETWEEN ? AND ?
      AND m.scope != 'skipped'
      AND m.selection_status NOT IN ('declined', 'superseded')
      AND NOT EXISTS (
        SELECT 1 FROM planning_context_grocery_settings pcgs
         WHERE pcgs.planning_context_id = m.planning_context_id
           AND pcgs.track_groceries = 0
      )

    UNION ALL

    SELECT
      'recipe_ingredient' AS source_kind,
      m.id AS meal_id,
      NULL AS meal_ingredient_id,
      m.recipe_id AS recipe_id,
      ri.id AS recipe_ingredient_id,
      m.date AS meal_date,
      m.title AS meal_title,
      r.title AS recipe_title,
      m.planned_portions AS planned_portions,
      m.portions AS cook_portions,
      r.yield_portions AS recipe_yield_portions,
      ri.name,
      ri.quantity,
      ri.category
    FROM meals m
    JOIN recipes r ON r.id = m.recipe_id
    JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    WHERE m.date BETWEEN ? AND ?
      AND m.scope != 'skipped'
      AND m.selection_status NOT IN ('declined', 'superseded')
      AND NOT EXISTS (
        SELECT 1 FROM planning_context_grocery_settings pcgs
         WHERE pcgs.planning_context_id = m.planning_context_id
           AND pcgs.track_groceries = 0
      )
      AND m.ingredients_manual_override = 0
      AND NOT EXISTS (SELECT 1 FROM meal_ingredients mi WHERE mi.meal_id = m.id)

    ORDER BY meal_date ASC, meal_id ASC, source_kind ASC, meal_ingredient_id ASC, recipe_ingredient_id ASC
  `).all(from, to, from, to);
  const meals = database.prepare(`SELECT m.* FROM meals m WHERE m.date BETWEEN ? AND ?
    AND m.scope != 'skipped' AND m.selection_status NOT IN ('declined','superseded')
    AND NOT EXISTS (SELECT 1 FROM planning_context_grocery_settings pcgs
      WHERE pcgs.planning_context_id = m.planning_context_id AND pcgs.track_groceries = 0)
    ORDER BY m.date, m.id`).all(from, to);
  const rows = [];
  for (const meal of meals) {
    if (mealIds !== null && !mealIds.includes(meal.id)) continue;
    const dishes = mealDishPortionSummary(database, meal.id).dishes.filter((dish) => dish.meal_id === meal.id);
    for (const dish of dishes) {
      if(dish.cook_portions<=0)continue;
      const explicitAutomatic=dish.primary&&!meal.ingredients_manual_override&&dish.recipe_id&&database.prepare('SELECT yield_portions FROM recipes WHERE id=?').get(dish.recipe_id)?.yield_portions!=null;
      const ingredients = dish.primary&&!explicitAutomatic ? baseRows.filter((row) => row.meal_id === meal.id)
        : database.prepare(`SELECT 'recipe_ingredient' AS source_kind, ri.id AS recipe_ingredient_id,
            NULL AS meal_ingredient_id, r.id AS recipe_id, r.title AS recipe_title,
            r.yield_portions AS recipe_yield_portions, ri.name, ri.quantity, ri.category
          FROM recipes r JOIN recipe_ingredients ri ON ri.recipe_id = r.id
          WHERE r.id = ? ORDER BY ri.id`).all(dish.recipe_id);
      for (const ingredient of ingredients) {
        const row = { ...ingredient, meal_id: meal.id, meal_date: meal.date, meal_title: meal.title,
          menu_item_id: dish.primary ? null : dish.menu_item_id,
          planned_portions: dish.planned_portions, cook_portions: dish.cook_portions };
        // Explicit automatic yields follow the current recipe basis in pure demand.
        // Manual overrides and unspecified-yield materialized legacy batches stay intact.
        if (row.source_kind === 'recipe_ingredient' && row.recipe_yield_portions != null) {
          row.quantity = scaleIngredientQuantity(row.quantity, dish.cook_portions / Number(row.recipe_yield_portions),
            { precision: 6, roundUp: true });
        }
        rows.push({ ...row, category: String(row.category || 'Sonstiges').trim() || 'Sonstiges', source_key: sourceKey(row) });
      }
    }
  }
  return rows.sort((left, right) => left.meal_date.localeCompare(right.meal_date)
    || left.meal_id - right.meal_id || left.source_key.localeCompare(right.source_key));
}

function sourceFingerprint(sourceRows, groupingMode) {
  return hash(JSON.stringify({ grouping_mode: groupingMode,
    sources: sourceRows.map((row) => ({ source_key: row.source_key, meal_id: row.meal_id,
      meal_date: row.meal_date, meal_title: row.meal_title, recipe_id: row.recipe_id,
      recipe_title: row.recipe_title, name: row.name, quantity: row.quantity, category: row.category,
      planned_portions: row.planned_portions, cook_portions: row.cook_portions,
      recipe_yield_portions: row.recipe_yield_portions })) }));
}

function assertUnpublishedRunCurrent(database, run) {
  if (!['draft', 'finalized'].includes(run.status)) return;
  const current = sourceFingerprint(loadSourceIngredients(database, run.start_date, run.end_date, run.meal_ids_json == null ? null : JSON.parse(run.meal_ids_json)),
    normalizedGroupingMode(getGrocerySettings(database).grouping_mode));
  const baseKey = String(run.logical_key).replace(/:revision:\d+$/, '');
  const newer = database.prepare(`SELECT 1 FROM meal_grocery_runs WHERE id > ?
    AND (logical_key = ? OR instr(logical_key, ? || ':revision:') = 1) LIMIT 1`)
    .get(run.id, baseKey, baseKey);
  if (current !== run.source_fingerprint || newer) throw serviceError(
    'Meal choices or portions changed. Refresh the grocery draft and review the updated quantities before adding them to Shopping.',
    409, 'GROCERY_DRAFT_CHANGED');
}

function aggregateWithSources(rows, groupingMode = 'ingredient') {
  const mode = normalizedGroupingMode(groupingMode);
  const sourceGroups = new Map();
  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    const category = String(row.category || 'Sonstiges').trim() || 'Sonstiges';
    const quantity = String(row.quantity || '').trim();
    const parsed = parseQuantity(quantity);
    const demandSignature = parsed
      ? `${name.toLocaleLowerCase()}\u0000${category.toLocaleLowerCase()}\u0000parsed\u0000${parsed.unit}`
      : `${name.toLocaleLowerCase()}\u0000${category.toLocaleLowerCase()}\u0000raw\u0000${quantity.toLocaleLowerCase()}`;
    const group = groupingDescriptor(row, mode);
    const aggregationKey = `${demandSignature}\u0000group\u0000${group.key}`;
    if (!sourceGroups.has(aggregationKey)) sourceGroups.set(aggregationKey, []);
    sourceGroups.get(aggregationKey).push({ ...row, demand_signature: demandSignature, group });
  }

  const result = [];
  for (const sources of sourceGroups.values()) {
    const preciseQuantity = sources.some((source) => source.recipe_yield_portions != null);
    const aggregate = aggregateMealIngredients(sources.map((source) => ({
      id: source.meal_ingredient_id ?? source.recipe_ingredient_id,
      meal_id: source.meal_id,
      name: source.name,
      quantity: source.quantity,
      category: source.category,
    })), preciseQuantity ? { precision: 6, roundUp: true } : {})[0];
    const parsed = parseQuantity(aggregate.quantity);
    const demandKey = `ingredient:${hash(sources[0].demand_signature).slice(0, 24)}`;
    const group = sources[0].group;
    const scopedSuffix = mode === 'ingredient'
      ? ''
      : `:${mode}:${hash(group.key).slice(0, 12)}`;
    result.push({
      logical_key: `${demandKey}${scopedSuffix}`,
      demand_key: demandKey,
      name: aggregate.name,
      category: aggregate.category,
      quantity: aggregate.quantity,
      planned_quantity: parsed?.amount ?? null,
      precise_quantity: preciseQuantity,
      unit: parsed?.unit || null,
      group_key: group.key,
      group_label: group.label,
      sources: sources.map(({ demand_signature: _demandSignature, group: _group, ...source }) => source),
    });
  }
  return result.sort((left, right) => (
    String(left.group_label || '').localeCompare(String(right.group_label || ''), undefined, { sensitivity: 'base' })
    || String(left.category).localeCompare(String(right.category), undefined, { sensitivity: 'base' })
    || String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' })
  ));
}

function loadGroceryRun(database, runId) {
  const run = database.prepare(`
    SELECT gr.*, sl.name AS shopping_list_name
    FROM meal_grocery_runs gr
    LEFT JOIN shopping_lists sl ON sl.id = gr.shopping_list_id
    WHERE gr.id = ?
  `).get(runId);
  if (!run) return null;

  run.items = database.prepare(`
    SELECT * FROM meal_grocery_items WHERE grocery_run_id = ?
    ORDER BY category COLLATE NOCASE, name COLLATE NOCASE, id
  `).all(run.id);
  const sources = database.prepare(`
    SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id IN (
      SELECT id FROM meal_grocery_items WHERE grocery_run_id = ?
    ) ORDER BY meal_date_snapshot, meal_id, id
  `).all(run.id);
  const byItem = new Map();
  for (const source of sources) {
    if (!byItem.has(source.grocery_item_id)) byItem.set(source.grocery_item_id, []);
    byItem.get(source.grocery_item_id).push(source);
  }
  const inferredMode = run.items.map((item) => (
    String(item.logical_key).match(/^ingredient:[^:]+:(category|meal|recipe):/)?.[1]
  )).find(Boolean) || 'ingredient';
  run.grouping_mode = inferredMode;
  for (const item of run.items) {
    item.sources = byItem.get(item.id) || [];
    const group = groupingDescriptor(item.sources[0] || { category: item.category }, inferredMode);
    item.group_key = group.key;
    item.group_label = group.label;
  }
  run.items.sort((left, right) => (
    String(left.group_label || '').localeCompare(String(right.group_label || ''), undefined, { sensitivity: 'base' })
    || String(left.category).localeCompare(String(right.category), undefined, { sensitivity: 'base' })
    || String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' })
    || Number(left.id) - Number(right.id)
  ));
  return run;
}

function createOrRefreshGroceryRun(database, { listId, from, to, userId, logicalKey, mealIds = null, deferNotifications = false, attributionRunIds = null, excludedAttributionMealIds = [] }) {
  const list = database.prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId);
  if (!list) throw serviceError('Shopping list not found.', 404, 'SHOPPING_LIST_NOT_FOUND');

  const baseKey = String(logicalKey || defaultLogicalKey(listId, from, to)).trim();
  if (!baseKey || baseKey.length > 200) throw serviceError('logical_key must be between 1 and 200 characters.');
  const groupingMode = normalizedGroupingMode(getGrocerySettings(database).grouping_mode);
  mealIds = validateGroceryScope(database, from, to, mealIds);
  const sourceRows = loadSourceIngredients(database, from, to, mealIds);
  const scopeJson = mealIds === null ? null : JSON.stringify(mealIds);
  const aggregated = aggregateWithSources(sourceRows, groupingMode);
  const fingerprint = sourceFingerprint(sourceRows, groupingMode);

  const result = database.transaction(() => {
    const family = database.prepare(`
      SELECT * FROM meal_grocery_runs
      WHERE logical_key = ? OR instr(logical_key, ? || ':revision:') = 1
      ORDER BY revision DESC, id DESC
    `).all(baseKey, baseKey);
    let run = family[0] || null;
    for (const related of family) {
      if (related.shopping_list_id !== Number(listId) || related.start_date !== from || related.end_date !== to || (related.meal_ids_json ?? null) !== scopeJson) {
        throw serviceError('logical_key already belongs to a different grocery run.', 409, 'GROCERY_RUN_KEY_CONFLICT');
      }
    }
    if (run && run.source_fingerprint === fingerprint) {
      return { run: loadGroceryRun(database, run.id), reused: true, refreshed: false };
    }
    let key = run?.status === 'draft'
      ? run.logical_key
      : family.length
        ? `${baseKey}:revision:${Math.max(...family.map((row) => Number(row.revision) || 1)) + 1}`
        : baseKey;
    if (run?.status !== 'draft') run = null;
    const existed = Boolean(run);
    const attributionFamily = attributionRunIds === null ? family : [...family, ...attributionRunIds.filter(id=>!family.some(r=>r.id===id)).map(id=>database.prepare('SELECT * FROM meal_grocery_runs WHERE id=?').get(id))];
    const historical = attributionFamily.filter((row) => row.id !== run?.id && database.prepare(`
      SELECT 1 FROM meal_grocery_items WHERE grocery_run_id = ? AND published_at IS NOT NULL LIMIT 1
    `).get(row.id));
    let prepared = aggregated;
    if (historical.length) {
      const placeholders = historical.map(() => '?').join(',');
      const previous = database.prepare(`
        SELECT i.*, COALESCE(s.credited_quantity,i.planned_quantity) AS amended_quantity
        FROM meal_grocery_items i LEFT JOIN meal_grocery_output_state s ON s.grocery_item_id=i.id
        WHERE i.grocery_run_id IN (${placeholders}) AND COALESCE(s.active,1)=1
      `).all(...historical.map((row) => row.id));
      const previousByDemand = new Map();
      const previousRawByDemand = new Map();
      const uncertainDemand = new Set();
      for (const historicalRow of previous) {
        const reviewed=attributionRunIds===null?null:reviewedOutputCoverage(database,historicalRow);
        const coverage=reviewed?reviewed.coverage:groceryCoverage(historicalRow,historicalRow.amended_quantity),share=sourceOwnershipShare(database,historicalRow,excludedAttributionMealIds);
        const row={...historicalRow,planned_quantity:coverage==null||share==null?null:coverage*share};
        const demandKey = baseDemandKey(row.logical_key);
        if(reviewed&&(reviewed.uncertain||share==null)){
          const sources=database.prepare('SELECT meal_id FROM meal_grocery_item_sources WHERE grocery_item_id=?').all(row.id);
          if(!sources.length||!sources.every(s=>excludedAttributionMealIds.includes(s.meal_id)))uncertainDemand.add(demandKey);
          continue;
        }
        if(share===0)continue;
        if (row.planned_quantity == null) {
          previousRawByDemand.set(demandKey, (previousRawByDemand.get(demandKey) || 0) + 1);
        } else {
          previousByDemand.set(
            demandKey,
            (previousByDemand.get(demandKey) || 0) + (Number(row.planned_quantity) || 0),
          );
        }
      }
      prepared = aggregated.flatMap((item) => {
        const demandKey = item.demand_key || baseDemandKey(item.logical_key);
        // Review must resolve ambiguous manual/shared coverage before adding
        // more of that demand. Never silently certify historical attribution.
        if(uncertainDemand.has(demandKey))return [];
        if (item.planned_quantity == null) {
          const previousCount = previousRawByDemand.get(demandKey) || 0;
          if (previousCount <= 0) return [item];
          previousRawByDemand.set(demandKey, previousCount - 1);
          return [];
        }
        const previousQuantity = previousByDemand.get(demandKey) || 0;
        let remaining = Number(item.planned_quantity) - previousQuantity;
        previousByDemand.set(demandKey, Math.max(0, -remaining));
        if (remaining <= 0) return [];
        if (item.precise_quantity) {
          if (remaining <= Number.EPSILON * Math.max(1, Math.abs(Number(item.planned_quantity)), Math.abs(previousQuantity)) * 4) return [];
          const scaled = remaining * 1e6;
          remaining = Math.ceil(scaled - Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4) / 1e6;
          if (remaining <= 0) return [];
        }
        return [{
          ...item,
          planned_quantity: remaining,
          quantity: `${item.precise_quantity ? remaining : Number(remaining.toFixed(3))}${item.unit ? ` ${item.unit}` : ''}`,
        }];
      });
    }

    if (!run) {
      const revision = family.length ? Math.max(...family.map((row) => Number(row.revision) || 1)) + 1 : 1;
      const info = database.prepare(`
        INSERT INTO meal_grocery_runs (
          logical_key, shopping_list_id, start_date, end_date, source_fingerprint, revision, created_by, meal_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(key, listId, from, to, fingerprint, revision, userId || null, scopeJson);
      run = database.prepare('SELECT * FROM meal_grocery_runs WHERE id = ?').get(info.lastInsertRowid);
    } else {
      database.prepare(`
        UPDATE meal_grocery_runs
        SET source_fingerprint = ?, revision = revision + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?
      `).run(fingerprint, run.id);
      database.prepare('DELETE FROM meal_grocery_items WHERE grocery_run_id = ?').run(run.id);
    }

    const insertItem = database.prepare(`
      INSERT INTO meal_grocery_items (
        grocery_run_id, logical_key, name, quantity, category, planned_quantity, unit,
        remaining_quantity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSource = database.prepare(`
      INSERT INTO meal_grocery_item_sources (
        grocery_item_id, source_key, source_kind, meal_id, meal_ingredient_id,
        recipe_id, recipe_ingredient_id, meal_date_snapshot, meal_title_snapshot,
        recipe_title_snapshot, ingredient_name_snapshot, quantity_snapshot, category_snapshot,
        planned_portions_snapshot, cook_portions_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of prepared) {
      const itemInfo = insertItem.run(
        run.id, item.logical_key, item.name, item.quantity, item.category,
        item.planned_quantity, item.unit, item.planned_quantity,
      );
      for (const source of item.sources) {
        insertSource.run(
          itemInfo.lastInsertRowid, source.source_key, source.source_kind, source.meal_id,
          source.meal_ingredient_id, source.recipe_id, source.recipe_ingredient_id,
          source.meal_date, source.meal_title, source.recipe_title, source.name,
          source.quantity, source.category, source.planned_portions, source.cook_portions,
        );
      }
    }
    return { run: loadGroceryRun(database, run.id), reused: false, refreshed: existed };
  })();

  return result;
}

function finalizeGroceryRun(database, runId) {
  const run = loadGroceryRun(database, runId);
  if (!run) throw serviceError('Grocery run not found.', 404, 'GROCERY_RUN_NOT_FOUND');
  validateGroceryScope(database, run.start_date, run.end_date, run.meal_ids_json == null ? null : JSON.parse(run.meal_ids_json));
  if (run.status !== 'draft') return run;
  assertUnpublishedRunCurrent(database, run);
  database.prepare(`
    UPDATE meal_grocery_runs
    SET status = 'finalized', finalized_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ?
  `).run(runId);
  return loadGroceryRun(database, runId);
}

function publishGroceryRun(database, runId, {deferNotifications = false} = {}) {
  const initial = loadGroceryRun(database, runId);
  if (!initial) throw serviceError('Grocery run not found.', 404, 'GROCERY_RUN_NOT_FOUND');
  validateGroceryScope(database, initial.start_date, initial.end_date, initial.meal_ids_json == null ? null : JSON.parse(initial.meal_ids_json));
  if (initial.status === 'draft') {
    throw serviceError('Finalize the grocery run before adding it to Shopping.', 409, 'GROCERY_RUN_NOT_FINALIZED');
  }
  if (!initial.shopping_list_id) {
    throw serviceError('The grocery run no longer has a shopping list.', 409, 'SHOPPING_LIST_NOT_FOUND');
  }
  assertUnpublishedRunCurrent(database, initial);

  const addedIds = database.transaction(() => {
    const categories = database.prepare('SELECT name FROM shopping_categories').all().map((row) => row.name);
    const fallbackCategory = categories.at(-1) || 'Sonstiges';
    const insertShoppingItem = database.prepare(`
      INSERT INTO shopping_items (list_id, name, quantity, category, added_from_meal)
      VALUES (?, ?, ?, ?, ?)
    `);
    const linkOutput = database.prepare(`
      UPDATE meal_grocery_items
      SET shopping_item_id = ?, published_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `);
    const markIngredient = database.prepare('UPDATE meal_ingredients SET on_shopping_list = 1 WHERE id = ?');
    const ids = [];
    for (const item of initial.items) {
      // published_at deliberately survives deletion of a Shopping item. A retry
      // must not resurrect something the household intentionally removed.
      if (item.published_at) continue;
      const mealIds = [...new Set(item.sources.map((source) => source.meal_id).filter(Boolean))];
      const category = categories.includes(item.category) ? item.category : fallbackCategory;
      const info = insertShoppingItem.run(
        initial.shopping_list_id, item.name, item.quantity, category,
        mealIds.length === 1 ? mealIds[0] : null,
      );
      linkOutput.run(info.lastInsertRowid, item.id);
      database.prepare('INSERT INTO meal_grocery_output_state(grocery_item_id,credited_quantity,shopping_json) VALUES(?,?,?)').run(item.id,item.planned_quantity,JSON.stringify(database.prepare('SELECT * FROM shopping_items WHERE id=?').get(info.lastInsertRowid)));
      for (const source of item.sources) {
        if (source.meal_ingredient_id) markIngredient.run(source.meal_ingredient_id);
      }
      ids.push(Number(info.lastInsertRowid));
    }
    database.prepare(`
      UPDATE meal_grocery_runs
      SET status = CASE WHEN status = 'finalized' THEN 'added_to_shopping' ELSE status END,
          added_to_shopping_at = COALESCE(added_to_shopping_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(runId);
    if (!deferNotifications) notifyGroceryPublished(database, runId);
    return ids;
  })();
  return { run: loadGroceryRun(database, runId), added_ids: addedIds };
}

function updatePurchase(database, runId, itemId, { purchasedQuantity, remainingQuantity, purchaseStatus }) {
  const run = database.prepare('SELECT * FROM meal_grocery_runs WHERE id = ?').get(runId);
  if (!run) throw serviceError('Grocery run not found.', 404, 'GROCERY_RUN_NOT_FOUND');
  if (!['added_to_shopping', 'purchased'].includes(run.status)) {
    throw serviceError('Purchases can only be recorded after the run is added to Shopping.', 409, 'GROCERY_RUN_NOT_PUBLISHED');
  }
  const item = database.prepare('SELECT * FROM meal_grocery_items WHERE id = ? AND grocery_run_id = ?').get(itemId, runId);
  if (!item) throw serviceError('Grocery item not found.', 404, 'GROCERY_ITEM_NOT_FOUND');
  const purchased = purchasedQuantity == null ? item.purchased_quantity : Number(purchasedQuantity);
  const remaining = remainingQuantity == null ? item.remaining_quantity : Number(remainingQuantity);
  if (!Number.isFinite(purchased) || purchased < 0 || (remaining != null && (!Number.isFinite(remaining) || remaining < 0))) {
    throw serviceError('Purchased and remaining quantities must be non-negative numbers.');
  }
  const status = purchaseStatus || (purchased > 0 && remaining > 0 ? 'partial' : purchased > 0 ? 'purchased' : 'pending');
  if (!['pending', 'partial', 'purchased'].includes(status)) throw serviceError('Invalid purchase_status.');
  database.prepare(`
    UPDATE meal_grocery_items
    SET purchased_quantity = ?, remaining_quantity = ?, purchase_status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ?
  `).run(purchased, remaining, status, itemId);
  if (item.shopping_item_id && status === 'purchased') {
    database.prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(item.shopping_item_id);
  }
  refreshPurchasedRunState(database, runId);
  return loadGroceryRun(database, runId);
}

function refreshPurchasedRunState(database, runId) {
  const counts = database.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN purchase_status = 'purchased' THEN 1 ELSE 0 END) AS purchased
    FROM meal_grocery_items WHERE grocery_run_id = ?
  `).get(runId);
  if (counts.total > 0 && counts.total === counts.purchased) {
    database.prepare(`
      UPDATE meal_grocery_runs
      SET status = CASE WHEN status = 'added_to_shopping' THEN 'purchased' ELSE status END,
          purchased_at = COALESCE(purchased_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(runId);
  }
}

function syncPurchasesFromShopping(database, runId) {
  const run = loadGroceryRun(database, runId);
  if (!run) throw serviceError('Grocery run not found.', 404, 'GROCERY_RUN_NOT_FOUND');
  if (run.status === 'reconciled') return run;
  if (!['added_to_shopping', 'purchased'].includes(run.status)) {
    throw serviceError('The grocery run has not been added to Shopping.', 409, 'GROCERY_RUN_NOT_PUBLISHED');
  }
  database.transaction(() => {
    const update = database.prepare(`
      UPDATE meal_grocery_items
      SET purchase_status = 'purchased',
          purchased_quantity = COALESCE((SELECT credited_quantity FROM meal_grocery_output_state WHERE grocery_item_id=meal_grocery_items.id), planned_quantity, purchased_quantity),
          remaining_quantity = CASE WHEN planned_quantity IS NULL THEN remaining_quantity ELSE 0 END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `);
    for (const item of run.items) {
      if (!item.shopping_item_id) continue;
      const shopping = database.prepare('SELECT is_checked FROM shopping_items WHERE id = ?').get(item.shopping_item_id);
      if (shopping?.is_checked) update.run(item.id);
    }
    refreshPurchasedRunState(database, runId);
  })();
  return loadGroceryRun(database, runId);
}

function listGroceryRuns(database, { listId, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  if (listId) {
    return database.prepare(`
      SELECT * FROM meal_grocery_runs WHERE shopping_list_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(listId, safeLimit);
  }
  return database.prepare(`
    SELECT * FROM meal_grocery_runs ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(safeLimit);
}

/** Exact provenance lookup; history pagination must never decide Pantry ownership. */
export function groceryOutputsForShoppingItems(database, ids) {
  if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw serviceError('Invalid Shopping item identities.');
  if(!ids.length)return [];
  return database.prepare(`SELECT id AS grocery_item_id,grocery_run_id AS run_id,shopping_item_id FROM meal_grocery_items WHERE shopping_item_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids);
}

function sourceOwnershipShare(d,item,excluded=[]){
  const scope=d.prepare('SELECT meal_ids_json FROM meal_grocery_runs WHERE id=?').get(item.grocery_run_id)?.meal_ids_json;
  if(scope==null)return 1;
  const ids=new Set(JSON.parse(scope).filter(id=>!excluded.includes(id))),sources=d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=?').all(item.id);
  if(sources.every(s=>ids.has(s.meal_id)))return 1;
  if(sources.every(s=>!ids.has(s.meal_id)))return 0;
  const parsed=sources.map(s=>({...s,amount:parseQuantity(s.quantity_snapshot)}));
  if(parsed.some(s=>!s.amount||s.amount.unit!==(item.unit||'')||s.amount.amount<0))return null;
  const total=parsed.reduce((n,s)=>n+s.amount.amount,0),owned=parsed.filter(s=>ids.has(s.meal_id)).reduce((n,s)=>n+s.amount.amount,0);
  return total>0?owned/total:0;
}
function outputProtection(d,item) {
  const shopping=item.shopping_item_id?d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id):null;
  const state=d.prepare('SELECT * FROM meal_grocery_output_state WHERE grocery_item_id=?').get(item.id);
  if(!state)return {reason:'unverified_legacy_output',shopping,state};
  if(!shopping)return {reason:'removed_shopping_row',shopping,state};
  if(sourceOwnershipShare(d,item)!==1)return {reason:'mixed_ownership',shopping,state};
  if(item.purchase_status!=='pending'||item.purchased_quantity>0||shopping.is_checked||item.reconciled_at)return {reason:'purchased_or_reconciled',shopping,state};
  if(d.prepare('SELECT count(*) n FROM meal_grocery_items WHERE shopping_item_id=?').get(shopping.id).n!==1)return {reason:'mixed_ownership',shopping,state};
  if(JSON.stringify(shopping)!==state.shopping_json)return {reason:'manually_edited',shopping,state};
  return {reason:null,shopping,state};
}
function reviewedOutputCoverage(d,item){
  const protection=outputProtection(d,item),{shopping,state}=protection;
  const historical=state?.credited_quantity??item.planned_quantity;
  const coverage=groceryCoverage(item,historical);
  const result={...protection,coverage,uncertain:false,historical_quantity:historical,actual_quantity:shopping?.quantity??null};
  // An unchanged display or a real purchase cannot quantify an unknown owned
  // share. Preserve history and defer additions before either early return.
  if(sourceOwnershipShare(d,item)==null)return {...result,coverage:null,uncertain:true};
  // Receipts have explicit quantities independent of a Shopping display edit.
  if(item.purchase_status==='purchased'||item.purchase_status==='partial'||item.reconciled_at)return result;
  if(state&&shopping){
    const original=JSON.parse(state.shopping_json),identity=['name','category','list_id','added_from_meal'];
    const sameIdentity=original&&identity.every(key=>shopping[key]===original[key]);
    if(sameIdentity&&shopping.quantity===original.quantity)return result;
    const actual=parseQuantity(shopping.quantity);
    const soleSource=d.prepare('SELECT count(*) n FROM meal_grocery_item_sources WHERE grocery_item_id=?').get(item.id).n===1;
    const soleOutput=d.prepare('SELECT count(*) n FROM meal_grocery_items WHERE shopping_item_id=?').get(shopping.id).n===1;
    if(sameIdentity&&soleSource&&soleOutput&&sourceOwnershipShare(d,item)===1&&!shopping.is_checked&&coverage!=null&&actual&&actual.unit===(item.unit||'')&&actual.amount>=0){
      return {...result,coverage:Math.min(coverage,actual.amount)};
    }
  }
  // A removed Shopping row is protected intent, not permission to republish it.
  // Keep its coverage unknown so reviewed publication defers matching additions.
  return {...result,coverage:null,uncertain:true};
}
/** Internal reviewed-delta path. Historical item/source quantities remain immutable;
 * only separately recorded outstanding attribution and untouched Shopping change. */
export function reconcileReviewedGroceries(d,c,partitions,{actorId,revision,apply=false,preserveMealIds=[]}={}) {
  const preserved=[],reductions=[],grocery_runs=[];
  const modes=normalizedGroupingMode(getGrocerySettings(d).grouping_mode);
  const existing=d.prepare("SELECT * FROM meal_grocery_runs WHERE instr(logical_key,?)=1 ORDER BY id").all(`meal-cycle:${c.id}:`);
  const contexts=new Map(partitions.map(p=>[p.context_id||'home',p]));
  for(const run of existing) {
    const context=String(run.logical_key).match(/:context:([^:]+)/)?.[1]||'home';
    if(!contexts.has(context==='home'?'home':Number(context)))contexts.set(context==='home'?'home':Number(context),{context_id:context==='home'?null:Number(context),shopping_list_id:run.shopping_list_id,source_meal_ids:[],track_groceries:false});
  }
  for(const [context,p] of contexts) {
    const prefix=`meal-cycle:${c.id}:list:${p.shopping_list_id}:context:${context}`;
    const runs=existing.filter(r=>r.logical_key===prefix||r.logical_key.startsWith(`${prefix}:`));
    const desired=aggregateWithSources(p.track_groceries?loadSourceIngredients(d,c.period_start,c.period_end,p.source_meal_ids):[],modes);
    const wanted=new Map();for(const row of desired)wanted.set(row.demand_key,(wanted.get(row.demand_key)||0)+(row.planned_quantity??1));
    const items=runs.flatMap(r=>loadGroceryRun(d,r.id).items).filter(i=>i.published_at);
    const totals=new Map();
    const coverageByItem=new Map(items.map(item=>[item.id,reviewedOutputCoverage(d,item)]));
    for(const item of items) {const output=coverageByItem.get(item.id);if(output.state?.active===0||output.uncertain)continue;const key=baseDemandKey(item.logical_key);totals.set(key,(totals.get(key)||0)+(output.coverage??1)*sourceOwnershipShare(d,item,preserveMealIds));}
    for(const item of [...items].reverse()) {
      const protection=coverageByItem.get(item.id),state=protection.state;if(state?.active===0)continue;
      if(item.sources.some(s=>preserveMealIds.includes(s.meal_id))){preserved.push({grocery_item_id:item.id,shopping_item_id:item.shopping_item_id,reason:'begun_meal_history'});continue;}
      if(protection.reason){
        preserved.push({
          grocery_item_id:item.id,shopping_item_id:item.shopping_item_id,reason:protection.reason,
          meal_ids:[...new Set(item.sources.map(s=>s.meal_id))],shopping_link:`/shopping?list=${p.shopping_list_id}`,
          historical_quantity:protection.historical_quantity,actual_quantity:protection.actual_quantity,
          coverage_quantity:protection.coverage,coverage_status:protection.uncertain?'unverified':'verified',
          demand_quantity:wanted.get(baseDemandKey(item.logical_key))||0,unit:item.unit,
          additions_deferred:protection.uncertain,
        });continue;
      }
      const key=baseDemandKey(item.logical_key),excess=(totals.get(key)||0)-(wanted.get(key)||0);
      if(excess<=1e-9)continue;
      const credit=state.credited_quantity??item.planned_quantity??1,amount=Math.min(excess,credit),next=credit-amount;
      reductions.push({grocery_item_id:item.id,shopping_item_id:item.shopping_item_id,previous:credit,outstanding:next});totals.set(key,totals.get(key)-amount);
      if(apply) {
        if(next===0)d.prepare('DELETE FROM shopping_items WHERE id=?').run(item.shopping_item_id);
        else d.prepare('UPDATE shopping_items SET quantity=? WHERE id=?').run(`${Number(next.toFixed(6))}${item.unit?` ${item.unit}`:''}`,item.shopping_item_id);
        const shopping=next?d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id):null;
        d.prepare('UPDATE meal_grocery_output_state SET credited_quantity=?,active=?,shopping_json=? WHERE grocery_item_id=?').run(item.planned_quantity==null?null:next,next?1:0,JSON.stringify(shopping),item.id);
        d.prepare('UPDATE meal_grocery_items SET remaining_quantity=? WHERE id=?').run(item.planned_quantity==null?null:next,item.id);
      }
    }
    if(apply&&desired.length) {
      const run=createOrRefreshGroceryRun(d,{listId:p.shopping_list_id,from:c.period_start,to:c.period_end,userId:actorId,logicalKey:`${prefix}:adjustment:${revision}`,mealIds:p.source_meal_ids,attributionRunIds:runs.map(x=>x.id),excludedAttributionMealIds:preserveMealIds}).run;
      finalizeGroceryRun(d,run.id);publishGroceryRun(d,run.id);
      grocery_runs.push({run_id:run.id,shopping_list_id:p.shopping_list_id,context_id:p.context_id,meal_ids:p.source_meal_ids});
    }
  }
  return {preserved,reductions,grocery_runs};
}

export {
  RUN_STATES,
  createOrRefreshGroceryRun,
  finalizeGroceryRun,
  listGroceryRuns,
  loadGroceryRun,
  publishGroceryRun,
  syncPurchasesFromShopping,
  updatePurchase,
};
