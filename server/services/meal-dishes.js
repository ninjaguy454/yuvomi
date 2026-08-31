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

function formatNumber(number, comma) {
  const rounded = Math.round(number * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return comma ? text.replace('.', ',') : text;
}

/** Scale the first numeric quantity token and retain its unit/custom suffix. */
export function scaleIngredientQuantity(quantity, portions) {
  if (!quantity || portions === 1) return quantity || null;
  const source = String(quantity);
  const mixed = source.match(/^(\d+)\s+(\d+)\/(\d+)(.*)$/);
  if (mixed && Number(mixed[3]) > 0) {
    return `${formatNumber((Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])) * portions, false)}${mixed[4]}`;
  }
  const fraction = source.match(/^(\d+)\/(\d+)(.*)$/);
  if (fraction && Number(fraction[2]) > 0) {
    return `${formatNumber((Number(fraction[1]) / Number(fraction[2])) * portions, false)}${fraction[3]}`;
  }
  const decimal = source.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
  if (!decimal) return source;
  const comma = decimal[1].includes(',');
  return `${formatNumber(Number(decimal[1].replace(',', '.')) * portions, comma)}${decimal[2]}`;
}

export function recipeIngredientsForPortions(database, recipeId, portions) {
  if (!recipeId) return [];
  return database.prepare(`
    SELECT name, quantity, category FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id
  `).all(Number(recipeId)).map((ingredient) => ({
    ...ingredient,
    quantity: scaleIngredientQuantity(ingredient.quantity, portions),
  }));
}

/** Keep an automatic Meal's effective portion snapshot and generated ingredients
 * synchronized with finalized participation decisions. Manual ingredient edits
 * and fixed portions are deliberately left untouched. */
export function syncAutoPortions(database, mealId) {
  const meal = database.prepare(`
    SELECT id, recipe_id, portions_mode, portions, ingredients_manual_override
      FROM meals WHERE id = ?
  `).get(Number(mealId));
  if (!meal || meal.portions_mode !== 'auto') return null;
  const portions = finalizedDinerCount(database, meal.id);
  if (Number(meal.portions) === portions) return { portions, changed: false };
  database.prepare('UPDATE meals SET portions = ? WHERE id = ?').run(portions, meal.id);
  if (meal.ingredients_manual_override || !meal.recipe_id) return { portions, changed: true };

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
  return { portions, changed: true };
}
