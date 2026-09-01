import { createHash } from 'node:crypto';
import { aggregateMealIngredients, parseQuantity } from './shopping-import.js';
import { getGrocerySettings } from './meal-grocery-settings.js';

const RUN_STATES = ['draft', 'finalized', 'added_to_shopping', 'purchased', 'reconciled'];

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

function loadSourceIngredients(database, from, to) {
  return database.prepare(`
    SELECT
      'meal_ingredient' AS source_kind,
      m.id AS meal_id,
      mi.id AS meal_ingredient_id,
      m.recipe_id AS recipe_id,
      NULL AS recipe_ingredient_id,
      m.date AS meal_date,
      m.title AS meal_title,
      r.title AS recipe_title,
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
      AND NOT EXISTS (SELECT 1 FROM meal_ingredients mi WHERE mi.meal_id = m.id)

    ORDER BY meal_date ASC, meal_id ASC, source_kind ASC, meal_ingredient_id ASC, recipe_ingredient_id ASC
  `).all(from, to, from, to).map((row) => ({
    ...row,
    category: String(row.category || 'Sonstiges').trim() || 'Sonstiges',
    source_key: sourceKey(row),
  }));
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
    const aggregate = aggregateMealIngredients(sources.map((source) => ({
      id: source.meal_ingredient_id ?? source.recipe_ingredient_id,
      meal_id: source.meal_id,
      name: source.name,
      quantity: source.quantity,
      category: source.category,
    })))[0];
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

function createOrRefreshGroceryRun(database, { listId, from, to, userId, logicalKey }) {
  const list = database.prepare('SELECT id FROM shopping_lists WHERE id = ?').get(listId);
  if (!list) throw serviceError('Shopping list not found.', 404, 'SHOPPING_LIST_NOT_FOUND');

  const baseKey = String(logicalKey || defaultLogicalKey(listId, from, to)).trim();
  if (!baseKey || baseKey.length > 200) throw serviceError('logical_key must be between 1 and 200 characters.');
  const groupingMode = normalizedGroupingMode(getGrocerySettings(database).grouping_mode);
  const sourceRows = loadSourceIngredients(database, from, to);
  const aggregated = aggregateWithSources(sourceRows, groupingMode);
  const fingerprint = hash(JSON.stringify({
    grouping_mode: groupingMode,
    sources: sourceRows.map((row) => ({
      source_key: row.source_key,
      meal_id: row.meal_id,
      meal_date: row.meal_date,
      meal_title: row.meal_title,
      recipe_id: row.recipe_id,
      recipe_title: row.recipe_title,
      name: row.name,
      quantity: row.quantity,
      category: row.category,
    })),
  }));

  const result = database.transaction(() => {
    const family = database.prepare(`
      SELECT * FROM meal_grocery_runs
      WHERE logical_key = ? OR instr(logical_key, ? || ':revision:') = 1
      ORDER BY revision DESC, id DESC
    `).all(baseKey, baseKey);
    let run = family[0] || null;
    for (const related of family) {
      if (related.shopping_list_id !== Number(listId) || related.start_date !== from || related.end_date !== to) {
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
    const historical = family.filter((row) => row.id !== run?.id && row.status !== 'draft');
    let prepared = aggregated;
    if (historical.length) {
      const placeholders = historical.map(() => '?').join(',');
      const previous = database.prepare(`
        SELECT logical_key, planned_quantity
        FROM meal_grocery_items
        WHERE grocery_run_id IN (${placeholders})
      `).all(...historical.map((row) => row.id));
      const previousByDemand = new Map();
      const previousRawByDemand = new Map();
      for (const row of previous) {
        const demandKey = baseDemandKey(row.logical_key);
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
        if (item.planned_quantity == null) {
          const previousCount = previousRawByDemand.get(demandKey) || 0;
          if (previousCount <= 0) return [item];
          previousRawByDemand.set(demandKey, previousCount - 1);
          return [];
        }
        const previousQuantity = previousByDemand.get(demandKey) || 0;
        const remaining = Number(item.planned_quantity) - previousQuantity;
        previousByDemand.set(demandKey, Math.max(0, -remaining));
        if (remaining <= 0) return [];
        return [{
          ...item,
          planned_quantity: remaining,
          quantity: `${Number(remaining.toFixed(3))}${item.unit ? ` ${item.unit}` : ''}`,
        }];
      });
    }

    if (!run) {
      const revision = family.length ? Math.max(...family.map((row) => Number(row.revision) || 1)) + 1 : 1;
      const info = database.prepare(`
        INSERT INTO meal_grocery_runs (
          logical_key, shopping_list_id, start_date, end_date, source_fingerprint, revision, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(key, listId, from, to, fingerprint, revision, userId || null);
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
        recipe_title_snapshot, ingredient_name_snapshot, quantity_snapshot, category_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          source.quantity, source.category,
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
  if (run.status !== 'draft') return run;
  database.prepare(`
    UPDATE meal_grocery_runs
    SET status = 'finalized', finalized_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ?
  `).run(runId);
  return loadGroceryRun(database, runId);
}

function publishGroceryRun(database, runId) {
  const initial = loadGroceryRun(database, runId);
  if (!initial) throw serviceError('Grocery run not found.', 404, 'GROCERY_RUN_NOT_FOUND');
  if (initial.status === 'draft') {
    throw serviceError('Finalize the grocery run before adding it to Shopping.', 409, 'GROCERY_RUN_NOT_FINALIZED');
  }
  if (!initial.shopping_list_id) {
    throw serviceError('The grocery run no longer has a shopping list.', 409, 'SHOPPING_LIST_NOT_FOUND');
  }

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
  if (!['added_to_shopping', 'purchased'].includes(run.status)) {
    throw serviceError('The grocery run has not been added to Shopping.', 409, 'GROCERY_RUN_NOT_PUBLISHED');
  }
  database.transaction(() => {
    const update = database.prepare(`
      UPDATE meal_grocery_items
      SET purchase_status = 'purchased',
          purchased_quantity = COALESCE(planned_quantity, purchased_quantity),
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
