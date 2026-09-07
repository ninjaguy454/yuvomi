import { cookPortionTarget, roundPortions } from '../../public/utils/meal-portions.js';
import { parseQuantity } from './shopping-import.js';

const MAX_DISH_TITLE = 300;

function domainError(message, status = 400, code = 'INVALID_MEAL_DISH') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanTitle(value) {
  const title = value == null ? '' : String(value).trim();
  if (title.length > MAX_DISH_TITLE) throw domainError('Dish title may be at most 300 characters long.');
  return title || null;
}

function integer(value, field) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw domainError(`${field} must be a whole number of at least 1.`);
  return number;
}

/**
 * One additive select-or-custom contract shared by dated Meals and menu items.
 * New clients send { dish: { recipe_id?, title? } }; flattened title/recipe_id
 * remains accepted so released clients and stored records stay compatible.
 */
export function normalizeDishSelection(database, raw = {}, current = null, { required = true } = {}) {
  const nested = raw?.dish && typeof raw.dish === 'object' && !Array.isArray(raw.dish)
    ? raw.dish
    : raw;
  const recipeTouched = Object.hasOwn(nested || {}, 'recipe_id') || Object.hasOwn(nested || {}, 'recipeId');
  const titleTouched = Object.hasOwn(nested || {}, 'title')
    || Object.hasOwn(nested || {}, 'custom_text')
    || Object.hasOwn(nested || {}, 'customText');
  const recipeId = recipeTouched
    ? integer(nested.recipe_id ?? nested.recipeId, 'Recipe')
    : (current?.recipe_id ?? null);
  const recipe = recipeId
    ? database.prepare('SELECT id, title FROM recipes WHERE id = ?').get(recipeId)
    : null;
  if (recipeId && !recipe) throw domainError('Recipe not found.', 404, 'RECIPE_NOT_FOUND');
  const suppliedTitle = titleTouched
    ? cleanTitle(nested.title ?? nested.custom_text ?? nested.customText)
    : cleanTitle(current?.title);
  const title = suppliedTitle || recipe?.title || null;
  if (required && !title) throw domainError('Choose a recipe or enter a custom dish name.', 400, 'MEAL_DISH_REQUIRED');
  return {
    recipe_id: recipeId,
    title,
    custom_text: suppliedTitle,
    source: recipeId ? 'recipe' : 'custom',
  };
}

export function presentDishSelection(row = {}) {
  return {
    recipe_id: row.recipe_id == null ? null : Number(row.recipe_id),
    title: row.title || null,
    custom_text: row.title || null,
    source: row.recipe_id ? 'recipe' : 'custom',
  };
}

export function finalizedDinerCount(database, mealId) {
  const row = database.prepare(`
    SELECT COUNT(DISTINCT user_id) AS count
      FROM meal_participants
     WHERE meal_id = ? AND role = 'participant'
       AND status = 'participating'
  `).get(Number(mealId));
  return Math.max(Number(row?.count) || 0, 1);
}

export function mealPortionSummary(database, mealId) {
  const { planned, cook } = mealDishPortionSummary(database, mealId);
  return { planned, cook };
}

/** Derive dish demand from the existing occurrence responses and menu selections.
 * This is a projection, not another stored allocation or grocery ledger. */
export function mealDishPortionSummary(database, mealId) {
  const meal = database.prepare('SELECT * FROM meals WHERE id = ?').get(Number(mealId));
  if (!meal) return { planned: 0, cook: 1, cook_total: 0, dishes: [] };
  const members = database.prepare(`
    SELECT mp.user_id, mp.status, d.id AS decision_id, d.choice_kind,
           d.selected_meal_id, COALESCE(d.portion_amount, 1) AS portion_amount
      FROM meal_participants mp LEFT JOIN meal_person_decisions d
        ON d.meal_id = mp.meal_id AND d.beneficiary_user_id = mp.user_id
     WHERE mp.meal_id = ? AND mp.role = 'participant'
  `).all(meal.id);
  const active = members.filter((row) => row.status === 'participating');
  // An individual Meal owns the response on its parent occurrence.
  const parentDecision = meal.parent_meal_id ? database.prepare(`
    SELECT d.beneficiary_user_id, d.portion_amount, d.participation, d.choice_kind,
      EXISTS(SELECT 1 FROM meal_participants mp WHERE mp.meal_id = d.meal_id
        AND mp.user_id = d.beneficiary_user_id AND mp.role = 'participant' AND mp.status = 'participating') AS opted_in
      FROM meal_person_decisions d
     WHERE d.meal_id = ? AND (d.selected_meal_id = ? OR EXISTS (
       SELECT 1 FROM meal_selection_response_items ri JOIN planning_obligations o ON o.id = ri.obligation_id
        WHERE ri.meal_id = ? AND o.entity_id = d.meal_id AND o.responsible_user_id = d.beneficiary_user_id
     )) ORDER BY d.id DESC LIMIT 1
  `).get(meal.parent_meal_id, meal.id, meal.id) : null;
  if (parentDecision) {
    if (!parentDecision.opted_in || parentDecision.participation !== 'participating'
        || !['backup', 'personal', 'restaurant', 'takeout'].includes(parentDecision.choice_kind)) {
      return { planned: 0, cook: 1, cook_total: 0, dishes: [] };
    }
    const planned = roundPortions(parentDecision.portion_amount);
    const cook = meal.portions_mode === 'fixed' ? Number(meal.portions) : cookPortionTarget(planned);
    return { planned, cook, cook_total: cook, dishes: [{
      key: `meal:${meal.id}`, meal_id: meal.id, menu_item_id: null,
      recipe_id: meal.recipe_id, title: meal.title, kind: 'individual', primary: true,
      planned_portions: planned, cook_portions: cook,
      beneficiary_user_ids: [Number(parentDecision.beneficiary_user_id)],
    }] };
  }
  const planned = roundPortions(active.reduce((sum, row) => sum + Number(row.portion_amount), 0));
  const published = database.prepare(`SELECT generation, chooser_user_id FROM meal_menu_generations
    WHERE meal_id = ? AND status = 'fulfilled' ORDER BY generation DESC LIMIT 1`).get(meal.id);
  const generation = Number(published?.generation || meal.current_menu_generation || 1);
  const menu = database.prepare(`SELECT * FROM meal_menu_items
    WHERE meal_id = ? AND menu_generation = ? AND item_type IN ('entree','side')
    ORDER BY position, id`).all(meal.id, generation);
  const selections = database.prepare(`SELECT s.menu_item_id, d.beneficiary_user_id
    FROM meal_person_menu_selections s JOIN meal_person_decisions d ON d.id = s.decision_id
    JOIN meal_menu_items mi ON mi.id = s.menu_item_id
    WHERE d.meal_id = ? AND s.selected = 1 AND mi.menu_generation = ?`).all(meal.id, generation);
  const chooserIds = selections.filter((row) => Number(row.beneficiary_user_id) === Number(published?.chooser_user_id))
    .map((row) => Number(row.menu_item_id));
  const primaryItem = menu.find((item) => item.item_type === 'entree'
    && Number(item.recipe_id || 0) === Number(meal.recipe_id || 0) && item.title === meal.title)
    || (meal.recipe_id ? menu.find((item) => item.item_type === 'entree' && Number(item.recipe_id) === Number(meal.recipe_id)) : null);
  const buckets = new Map();
  const add = (item, member) => {
    const primary = !item || item.id === primaryItem?.id;
    const key = primary ? `meal:${meal.id}` : `meal:${meal.id}:menu:${item.id}`;
    if (!buckets.has(key)) buckets.set(key, {
      key, meal_id: meal.id, menu_item_id: item?.id || null,
      recipe_id: item ? item.recipe_id : meal.recipe_id, title: item?.title || meal.title,
      kind: item?.item_type || 'entree', primary,
      planned_portions: 0, beneficiary_user_ids: [],
    });
    const dish = buckets.get(key);
    dish.planned_portions += Number(member.portion_amount);
    dish.beneficiary_user_ids.push(Number(member.user_id));
  };
  for (const member of active) {
    if (['backup', 'personal', 'restaurant', 'takeout'].includes(member.choice_kind)) continue;
    const explicitIds = selections.filter((row) => Number(row.beneficiary_user_id) === Number(member.user_id))
      .map((row) => Number(row.menu_item_id));
    const ids = explicitIds.length ? explicitIds : chooserIds;
    const chosen = menu.filter((item) => ids.includes(Number(item.id)));
    for (const item of chosen) add(item, member);
    if (!chosen.length) add(primaryItem, member);
  }
  // Legacy/manual planning can intentionally have no participation records.
  // A fixed primary amount remains an explicit cook instruction.
  if (!buckets.has(`meal:${meal.id}`) && (!members.length || meal.portions_mode === 'fixed' || meal.ingredients_manual_override)) {
    buckets.set(`meal:${meal.id}`, {
      key: `meal:${meal.id}`, meal_id: meal.id, menu_item_id: primaryItem?.id || null,
      recipe_id: meal.recipe_id, title: meal.title, kind: 'entree', primary: true,
      planned_portions: members.length ? 0 : Number(meal.planned_portions) || 0,
      beneficiary_user_ids: [], legacy_unselected: !members.length,
    });
  }
  const dishes = [...buckets.values()].map((dish) => ({
    ...dish, planned_portions: roundPortions(dish.planned_portions),
    cook_portions: dish.primary && (meal.portions_mode === 'fixed' || dish.legacy_unselected)
      ? Number(meal.portions) || 1 : cookPortionTarget(dish.planned_portions),
  }));
  for (const member of active.filter((row) => row.selected_meal_id)) {
    const children = database.prepare(`SELECT DISTINCT m.id, m.title, m.recipe_id, m.portions_mode, m.portions FROM meals m
      LEFT JOIN meal_selection_response_items ri ON ri.meal_id = m.id
      LEFT JOIN planning_obligations o ON o.id = ri.obligation_id
      WHERE m.parent_meal_id = ? AND m.selection_status NOT IN ('declined','superseded')
        AND (m.id = ? OR (o.entity_id = ? AND o.responsible_user_id = ?)) ORDER BY m.id`)
      .all(meal.id, member.selected_meal_id, meal.id, member.user_id);
    for (const child of children) dishes.push({ key: `meal:${child.id}`, meal_id: child.id, menu_item_id: null,
        recipe_id: child.recipe_id, title: child.title, kind: 'individual', primary: true,
        planned_portions: roundPortions(member.portion_amount),
        cook_portions: child.portions_mode === 'fixed' ? Number(child.portions) : cookPortionTarget(member.portion_amount),
        beneficiary_user_ids: [Number(member.user_id)] });
  }
  return { planned, cook: dishes.find((dish) => dish.meal_id === meal.id && dish.primary)?.cook_portions || 1,
    cook_total: dishes.reduce((sum, dish) => sum + dish.cook_portions, 0), dishes };
}

export function normalizePortions(raw, { currentMode = 'auto', currentCount = null, autoCount = 1 } = {}) {
  if (raw === undefined) {
    const mode = currentMode === 'fixed' || currentMode === 'explicit' ? 'fixed' : 'auto';
    return { mode, count: mode === 'fixed' ? Math.max(Number(currentCount) || 1, 1) : Math.max(autoCount, 1) };
  }
  if (raw === 'auto' || raw?.mode === 'auto') return { mode: 'auto', count: Math.max(autoCount, 1) };
  const candidate = typeof raw === 'object' && raw !== null
    ? (raw.count ?? raw.portion_count ?? raw.value)
    : raw;
  return { mode: 'fixed', count: integer(candidate, 'Portions') };
}

function formatNumber(number, comma, { precision = 2, roundUp = false } = {}) {
  const factor = 10 ** precision;
  const scaled = number * factor;
  const tolerance = Math.min(Math.abs(scaled) / 2, Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4);
  const rounded = (roundUp ? Math.ceil(scaled - tolerance) : Math.round(scaled)) / factor;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return comma ? text.replace('.', ',') : text;
}

/** Scale the first numeric quantity token and retain its unit/custom suffix. */
export function scaleIngredientQuantity(quantity, portions, options = {}) {
  if (!quantity || portions === 1) return quantity || null;
  const source = String(quantity);
  // Yield-based recipe quantities use the same fraction/unit parser as the
  // grocery ledger, including common imported Unicode fractions.
  if (options.roundUp) {
    const parsed = parseQuantity(source);
    if (parsed) return `${formatNumber(parsed.amount * portions, /\d,\d/.test(source), options)}${parsed.unit ? ` ${parsed.unit}` : ''}`;
  }
  const mixed = source.match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
  if (mixed && Number(mixed[3]) > 0) {
    return `${formatNumber((Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])) * portions, false, options)}${mixed[4]}`;
  }
  const fraction = source.match(/^(\d+)\/(\d+)(.*)$/);
  if (fraction && Number(fraction[2]) > 0) {
    return `${formatNumber((Number(fraction[1]) / Number(fraction[2])) * portions, false, options)}${fraction[3]}`;
  }
  const decimal = source.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
  if (!decimal) return source;
  const comma = decimal[1].includes(',');
  return `${formatNumber(Number(decimal[1].replace(',', '.')) * portions, comma, options)}${decimal[2]}`;
}

export function recipeIngredientsForPortions(database, recipeId, portions) {
  if (!recipeId) return [];
  const recipe = database.prepare('SELECT yield_portions FROM recipes WHERE id = ?').get(Number(recipeId));
  const yieldPortions = Math.max(Number(recipe?.yield_portions) || 1, 0.01);
  const scale = Number(portions) / yieldPortions;
  return database.prepare(`
    SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id
  `).all(Number(recipeId)).map((ingredient) => ({
    ...ingredient,
    quantity: scaleIngredientQuantity(ingredient.quantity, scale,
      recipe?.yield_portions == null ? {} : { precision: 6, roundUp: true }),
  }));
}

/** Keep an automatic Meal's effective portion snapshot and generated ingredients
 * synchronized with finalized participation decisions. Manual ingredient edits
 * and fixed portions are deliberately left untouched. */
export function syncAutoPortions(database, mealId) {
  const meal = database.prepare(`
    SELECT id, recipe_id, portions_mode, portions, planned_portions, ingredients_manual_override
      FROM meals WHERE id = ?
  `).get(Number(mealId));
  if (!meal) return null;
  const summary = mealPortionSummary(database, meal.id);
  const portions = meal.portions_mode === 'auto' ? summary.cook : Number(meal.portions);
  const cookChanged = meal.portions_mode === 'auto' && Number(meal.portions) !== portions;
  const plannedChanged = Number(meal.planned_portions) !== summary.planned;
  if (!cookChanged && !plannedChanged) {
    return { planned_portions: summary.planned, portions, changed: false };
  }
  database.prepare(`UPDATE meals SET planned_portions = ?, portions = ? WHERE id = ?`)
    .run(summary.planned, portions, meal.id);
  if (!cookChanged || meal.ingredients_manual_override || !meal.recipe_id) {
    return { planned_portions: summary.planned, portions, changed: true };
  }

  syncRecipeMealIngredients(database, meal.id, portions);
  return { planned_portions: summary.planned, portions, changed: true };
}

/** Resize only generated ingredients, preserving stable rows wherever possible. */
export function syncRecipeMealIngredients(database, mealId, portions) {
  const meal = database.prepare('SELECT * FROM meals WHERE id = ?').get(Number(mealId));
  if (!meal || meal.ingredients_manual_override) return;
  const desired = recipeIngredientsForPortions(database, meal.recipe_id, portions);
  const existing = database.prepare(`
    SELECT * FROM meal_ingredients WHERE meal_id = ? ORDER BY id
  `).all(meal.id);
  const sameShape = existing.length === desired.length
    && existing.every((ingredient, index) => ingredient.name === desired[index].name);
  if (sameShape) {
    const update = database.prepare(`
      UPDATE meal_ingredients SET quantity = ?, category = ? WHERE id = ?
    `);
    desired.forEach((ingredient, index) => {
      update.run(ingredient.quantity, ingredient.category || 'Sonstiges', existing[index].id);
    });
  } else {
    database.prepare('DELETE FROM meal_ingredients WHERE meal_id = ?').run(meal.id);
    const insert = database.prepare(`
      INSERT INTO meal_ingredients (meal_id, name, quantity, category) VALUES (?, ?, ?, ?)
    `);
    for (const ingredient of desired) {
      insert.run(meal.id, ingredient.name, ingredient.quantity, ingredient.category || 'Sonstiges');
    }
  }
}
