import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { saveMealDecision } = await import('../server/services/meal-plans.js');
const { mealDishPortionSummary, scaleIngredientQuantity, recipeIngredientsForPortions } = await import('../server/services/meal-dishes.js');
const { createOrRefreshGroceryRun, finalizeGroceryRun, publishGroceryRun, assertLegacyMealImportAllowed, updatePurchase } =
  await import('../server/services/meal-grocery-runs.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');

function fixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  for (const migration of ALL_MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(database); else database.exec(migration.up);
    if (migration.afterUp) migration.afterUp(database);
  }
  const user = (name) => Number(database.prepare(`INSERT INTO users
    (username,display_name,password_hash,role,family_role) VALUES (?,?,'x','admin','other')`).run(name, name).lastInsertRowid);
  const alice = user('Alice'); const bob = user('Bob');
  const recipe = (title, quantity, yieldPortions = null, basis = null) => {
    const id = Number(database.prepare(`INSERT INTO recipes(title,created_by,yield_portions,
      serving_basis_amount,serving_basis_unit,serving_basis_label) VALUES (?,?,?,?,?,?)`)
      .run(title, alice, yieldPortions, basis?.amount ?? null, basis?.unit ?? null, basis?.label ?? null).lastInsertRowid);
    database.prepare('INSERT INTO recipe_ingredients(recipe_id,name,quantity,category) VALUES (?,?,?,?)')
      .run(id, title, quantity, 'Other');
    return id;
  };
  const meal = (recipeId, title = 'Household Meal') => Number(database.prepare(`INSERT INTO meals
    (date,meal_type,title,recipe_id,created_by) VALUES ('2048-01-01','dinner',?,?,?)`)
    .run(title, recipeId, alice).lastInsertRowid);
  const participant = (mealId, userId) => database.prepare(`INSERT INTO meal_participants
    (meal_id,user_id,role,status,source) VALUES (?,?,'participant','participating','manual')`).run(mealId, userId);
  const respond = (mealId, userId, amount, fields = {}) => saveMealDecision(database, mealId, {
    beneficiary_user_id: userId, participation: 'participating', choice_kind: 'household',
    confirmed: true, portion_amount: amount, ...fields,
  }, { actorId: alice, isAdmin: true });
  const listId = Number(database.prepare('INSERT INTO shopping_lists(name,created_by) VALUES (?,?)')
    .run('Groceries', alice).lastInsertRowid);
  const draft = (logicalKey = 'dish-proof') => createOrRefreshGroceryRun(database, {
    listId, from: '2048-01-01', to: '2048-01-01', userId: alice, logicalKey,
  }).run;
  return { database, alice, bob, recipe, meal, participant, respond, draft };
}

test('selected entree, sides and individual Backup use independently rounded dish quantities', () => {
  const f = fixture(); const d = f.database;
  try {
    const primary = f.recipe('Fish', '8 oz', 4, { amount: 2, unit: 'oz' });
    const backup = f.recipe('Tacos', '4 tacos', 2, { amount: 2, unit: 'count', label: 'taco' });
    const side = f.recipe('Corn', '12 cobs', 4, { amount: 3, unit: 'count', label: 'cob' });
    const secondSide = f.recipe('Soup', '6 fl oz', 2, { amount: 3, unit: 'fl_oz' });
    const meal = f.meal(primary, 'Fish');
    f.participant(meal, f.alice); f.participant(meal, f.bob);
    const menuIds = [[primary, 'Fish', 'entree', 0], [side, 'Corn', 'side', 0], [secondSide, 'Soup', 'side', 1]]
      .map(([recipeId, title, kind, position]) => Number(d.prepare(`INSERT INTO meal_menu_items
        (meal_id,recipe_id,title,item_type,position) VALUES (?,?,?,?,?)`).run(meal, recipeId, title, kind, position).lastInsertRowid));
    f.respond(meal, f.alice, 2.25, { menu_item_ids: menuIds });
    f.respond(meal, f.bob, 1.25, { choice_kind: 'backup', selected_recipe_id: backup, selected_meal_title: 'Tacos' });
    const summary = mealDishPortionSummary(d, meal);
    assert.equal(summary.planned, 3.5);
    assert.equal(summary.cook, 3);
    assert.deepEqual(summary.dishes.map((dish) => [dish.title, dish.planned_portions, dish.cook_portions]), [
      ['Fish', 2.25, 3], ['Corn', 2.25, 3], ['Soup', 2.25, 3], ['Tacos', 1.25, 2],
    ]);
    const run = f.draft();
    assert.deepEqual(Object.fromEntries(run.items.map((item) => [item.name, item.quantity])), {
      Corn: '9 cobs', Fish: '6 oz', Soup: '9 fl oz', Tacos: '4 tacos',
    });
    const cornSource = run.items.find((item) => item.name === 'Corn').sources[0];
    assert.equal(cornSource.source_kind, 'recipe_ingredient');
    assert.match(cornSource.source_key, /:menu:\d+:recipe-ingredient:/);
    assert.equal(cornSource.planned_portions_snapshot, 2.25);
    assert.equal(cornSource.cook_portions_snapshot, 3);
    assert.throws(() => assertLegacyMealImportAllowed(d, [meal]), { code: 'GROCERY_RECONCILIATION_REQUIRED' });
    assert.deepEqual(d.pragma('foreign_key_check'), []);
  } finally { d.close(); }
});

test('household responses without explicit menu selections inherit the published chooser dishes', () => {
  const f = fixture(); const d = f.database;
  try {
    const recipe = f.recipe('Main', '4 pieces', 4);
    const side = f.recipe('Side', '4 cups', 4);
    const meal = f.meal(recipe, 'Main');
    f.participant(meal, f.alice); f.participant(meal, f.bob);
    const mainId = Number(d.prepare(`INSERT INTO meal_menu_items(meal_id,recipe_id,title,item_type,position)
      VALUES (?,?,'Main','entree',0)`).run(meal, recipe).lastInsertRowid);
    const sideId = Number(d.prepare(`INSERT INTO meal_menu_items(meal_id,recipe_id,title,item_type,position)
      VALUES (?,?,'Side','side',0)`).run(meal, side).lastInsertRowid);
    f.respond(meal, f.alice, 1.25, { menu_item_ids: [mainId, sideId] });
    d.prepare(`UPDATE meal_menu_generations SET status='fulfilled', chooser_user_id=? WHERE meal_id=? AND generation=1`).run(f.alice, meal);
    f.respond(meal, f.bob, 0.5);
    assert.deepEqual(mealDishPortionSummary(d, meal).dishes.map((dish) => [dish.title, dish.planned_portions, dish.cook_portions]), [
      ['Main', 1.75, 2], ['Side', 1.75, 2],
    ]);
  } finally { d.close(); }
});

test('custom sides remain recipe-less and cannot duplicate the entree ingredients', () => {
  const f = fixture(); const d = f.database;
  try {
    const recipe = f.recipe('Main', '4 pieces', 4);
    const meal = f.meal(recipe, 'Main'); f.participant(meal, f.alice);
    const mainId = Number(d.prepare(`INSERT INTO meal_menu_items(meal_id,recipe_id,title,item_type,position)
      VALUES (?,?,'Main','entree',0)`).run(meal, recipe).lastInsertRowid);
    const sideId = Number(d.prepare(`INSERT INTO meal_menu_items(meal_id,title,item_type,position)
      VALUES (?,'Custom fruit','side',0)`).run(meal).lastInsertRowid);
    f.respond(meal, f.alice, 1.5, { menu_item_ids: [mainId, sideId] });
    const side = mealDishPortionSummary(d, meal).dishes.find((dish) => dish.menu_item_id === sideId);
    assert.equal(side.recipe_id, null);
    assert.equal(side.cook_portions, 2);
    assert.deepEqual(f.draft().items.map((item) => [item.name, item.quantity]), [['Main', '2 pieces']]);
  } finally { d.close(); }
});

test('an explicit side-only response does not add an unselected primary recipe', () => {
  const f = fixture(); const d = f.database;
  try {
    const main = f.recipe('Unselected main', '4 pieces', 4);
    const side = f.recipe('Selected side', '4 cups', 4);
    const meal = f.meal(main, 'Unselected main'); f.participant(meal, f.alice);
    d.prepare(`INSERT INTO meal_menu_items(meal_id,recipe_id,title,item_type,position)
      VALUES (?,?,'Unselected main','entree',0)`).run(meal, main);
    const sideId = Number(d.prepare(`INSERT INTO meal_menu_items(meal_id,recipe_id,title,item_type,position)
      VALUES (?,?,'Selected side','side',0)`).run(meal, side).lastInsertRowid);
    f.respond(meal, f.alice, 1.5, { menu_item_ids: [sideId] });
    assert.deepEqual(mealDishPortionSummary(d, meal).dishes.map((dish) => dish.title), ['Selected side']);
    assert.deepEqual(f.draft().items.map((item) => [item.name, item.quantity]), [['Selected side', '2 cups']]);
  } finally { d.close(); }
});

test('Backup-only participation creates no parent recipe demand; child resizing preserves IDs and manual overrides', () => {
  const f = fixture(); const d = f.database;
  try {
    const main = f.recipe('Unused parent', '5 cups', 1);
    const backup = f.recipe('Backup', '4 pieces', 2);
    const meal = f.meal(main); f.participant(meal, f.alice);
    const fields = { choice_kind: 'backup', selected_recipe_id: backup, selected_meal_title: 'Backup' };
    f.respond(meal, f.alice, 1.5, fields);
    const child = d.prepare('SELECT id FROM meals WHERE parent_meal_id=?').get(meal).id;
    const before = d.prepare('SELECT id,quantity FROM meal_ingredients WHERE meal_id=?').get(child);
    assert.equal(before.quantity, '4 pieces');
    assert.equal(d.prepare('SELECT portions_mode FROM meals WHERE id=?').get(child).portions_mode, 'auto');
    assert.deepEqual(f.draft().items.map((item) => item.name), ['Backup']);
    f.respond(meal, f.alice, 2.5, fields);
    assert.deepEqual(d.prepare('SELECT id,quantity FROM meal_ingredients WHERE meal_id=?').get(child), { id: before.id, quantity: '6 pieces' });
    d.prepare("UPDATE meals SET portions_mode='fixed',portions=5 WHERE id=?").run(child);
    f.respond(meal, f.alice, 3.5, fields);
    assert.equal(mealDishPortionSummary(d, child).cook, 5);
    assert.equal(mealDishPortionSummary(d, meal).dishes[0].cook_portions, 5);
    assert.equal(d.prepare('SELECT quantity FROM meal_ingredients WHERE id=?').get(before.id).quantity, '10 pieces');
    d.prepare('UPDATE meals SET ingredients_manual_override=1 WHERE id=?').run(child);
    d.prepare("UPDATE meal_ingredients SET quantity='7 special pieces' WHERE id=?").run(before.id);
    f.respond(meal, f.alice, 3.5, fields);
    assert.equal(d.prepare('SELECT quantity FROM meal_ingredients WHERE id=?').get(before.id).quantity, '7 special pieces');
    f.respond(meal, f.alice, 3.5, { ...fields, participation: 'not_participating' });
    assert.equal(f.draft().items.length, 0);
    f.respond(meal, f.alice, 3.5, fields);
    assert.equal(f.draft().items[0].quantity, '7 special pieces');
    d.prepare("UPDATE meal_participants SET status='not_participating' WHERE meal_id=? AND user_id=? AND role='participant'")
      .run(meal, f.alice);
    assert.equal(f.draft().items.length, 0, 'changing the authoritative participation role also excludes the linked child');
  } finally { d.close(); }
});

test('stale draft/finalized publication is blocked, refresh includes full unpublished demand and only published deltas', () => {
  const f = fixture(); const d = f.database;
  try {
    const recipe = f.recipe('Rice', '4 cups', 4);
    const meal = f.meal(recipe); f.participant(meal, f.alice);
    f.respond(meal, f.alice, 2.25);
    const initial = f.draft();
    f.respond(meal, f.alice, 3.25);
    assert.throws(() => finalizeGroceryRun(d, initial.id), { code: 'GROCERY_DRAFT_CHANGED' });
    const refreshed = f.draft();
    assert.equal(refreshed.items[0].quantity, '4 cups');
    finalizeGroceryRun(d, refreshed.id);
    f.respond(meal, f.alice, 4.25);
    assert.throws(() => publishGroceryRun(d, refreshed.id), { code: 'GROCERY_DRAFT_CHANGED' });
    const replacement = f.draft();
    assert.notEqual(replacement.id, refreshed.id);
    assert.equal(replacement.items[0].quantity, '5 cups');
    finalizeGroceryRun(d, replacement.id);
    publishGroceryRun(d, replacement.id);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n, 1);
    f.respond(meal, f.alice, 5.25);
    const delta = f.draft();
    assert.equal(delta.items[0].quantity, '1 cups');
    finalizeGroceryRun(d, delta.id); publishGroceryRun(d, delta.id);
    assert.deepEqual(d.prepare('SELECT quantity FROM shopping_items ORDER BY id').all().map((row) => row.quantity), ['5 cups', '1 cups']);
    assert.throws(() => publishGroceryRun(d, refreshed.id), { code: 'GROCERY_DRAFT_CHANGED' });
  } finally { d.close(); }
});

test('legacy extra personal snack choices share their owner response without a second portion record', () => {
  const f = fixture(); const d = f.database;
  try {
    const recipe = f.recipe('First snack', '4 pieces', 4);
    const extraRecipe = f.recipe('Extra snack', '4 cups', 4);
    const meal = f.meal(null, 'Snack time'); f.participant(meal, f.alice);
    const fields = { choice_kind: 'personal', selected_recipe_id: recipe, selected_meal_title: 'First snack' };
    f.respond(meal, f.alice, 1.5, fields);
    const extra = f.meal(extraRecipe, 'Extra snack');
    d.prepare("UPDATE meals SET parent_meal_id=?,scope='personal' WHERE id=?").run(meal, extra);
    f.participant(extra, f.alice);
    const obligation = Number(d.prepare(`INSERT INTO planning_obligations
      (entity_type,entity_id,logical_key,role,responsible_user_id,status)
      VALUES ('meal',?,'extra-snack-owner','chooser',?,'fulfilled')`).run(meal, f.alice).lastInsertRowid);
    d.prepare(`INSERT INTO meal_selection_response_items(obligation_id,position,meal_id,recipe_id,title)
      VALUES (?,1,?,?,'Extra snack')`).run(obligation, extra, extraRecipe);
    f.respond(meal, f.alice, 2.5, fields);
    assert.equal(mealDishPortionSummary(d, extra).planned, 2.5);
    assert.equal(mealDishPortionSummary(d, extra).cook, 3);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM meal_person_decisions WHERE meal_id=?').get(extra).n, 0);
    assert.deepEqual(f.draft().items.map((item) => [item.name, item.quantity]), [['Extra snack', '3 cups'], ['First snack', '3 pieces']]);
    f.respond(meal, f.alice, 2.5, { ...fields, participation: 'not_participating' });
    assert.equal(f.draft().items.length, 0);
  } finally { d.close(); }
});

test('unspecified legacy yields and explicit manual ingredient snapshots retain their quantities', () => {
  const f = fixture(); const d = f.database;
  try {
    const recipe = f.recipe('Legacy broth', '2 cups');
    const meal = f.meal(recipe);
    d.prepare('UPDATE meals SET portions=4 WHERE id=?').run(meal);
    assert.equal(f.draft().items[0].quantity, '2 cups');
    d.prepare("INSERT INTO meal_ingredients(meal_id,name,quantity,category) VALUES (?,'Legacy broth','3 custom cups','Other')").run(meal);
    d.prepare('UPDATE meals SET ingredients_manual_override=1 WHERE id=?').run(meal);
    f.participant(meal, f.alice); f.respond(meal, f.alice, 9.5);
    assert.equal(f.draft().items[0].quantity, '3 custom cups');
  } finally { d.close(); }
});

test('explicit yields preserve small positive quantities through sources, published deltas and Pantry reconciliation', async () => {
  const f = fixture(); const d = f.database;
  _setTestDatabase(d);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = f.alice; req.session = { userId: f.alice, role: 'admin' }; next(); });
  app.use('/pantry', pantryRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(scaleIngredientQuantity('0.01 kg', 0.25), '0 kg', 'legacy formatting is unchanged');
    assert.equal(scaleIngredientQuantity('0.01 kg', 0.25, { precision: 6, roundUp: true }), '0.0025 kg');
    const recipe = f.recipe('Small quantity', '0.01 kg', 4);
    const meal = f.meal(recipe); f.participant(meal, f.alice);
    // Exercise both generated Meal ingredients and canonical source aggregation.
    f.respond(meal, f.alice, 4); f.respond(meal, f.alice, 1);
    assert.equal(d.prepare('SELECT quantity FROM meal_ingredients WHERE meal_id=?').get(meal).quantity, '0.0025 kg');
    const run = f.draft(); const item = run.items[0];
    assert.equal(item.planned_quantity, 0.0025);
    assert.equal(item.quantity, '0.0025 kg');
    assert.equal(item.sources[0].quantity_snapshot, '0.0025 kg');
    finalizeGroceryRun(d, run.id); publishGroceryRun(d, run.id);
    assert.equal(d.prepare('SELECT quantity FROM shopping_items').get().quantity, '0.0025 kg');
    updatePurchase(d, run.id, item.id, { purchasedQuantity: 0.0025, remainingQuantity: 0, purchaseStatus: 'purchased' });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/pantry/reconcile-grocery-run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grocery_run_id: run.id, items: [{ grocery_item_id: item.id, unit: 'kg' }] }),
    });
    assert.equal(response.status, 200, await response.text());
    const stored = d.prepare('SELECT quantity,unit FROM pantry_items').get();
    assert.equal(stored.unit, 'kg'); assert.equal(stored.quantity, 0.0025);
    assert.equal(d.prepare('SELECT quantity FROM pantry_movements WHERE grocery_item_id=?').get(item.id).quantity, 0.0025);
    f.respond(meal, f.alice, 1.01);
    const delta = f.draft();
    assert.equal(delta.items[0].planned_quantity, 0.0025);
    assert.equal(delta.items[0].quantity, '0.0025 kg');
    finalizeGroceryRun(d, delta.id); publishGroceryRun(d, delta.id);
    assert.deepEqual(d.prepare('SELECT quantity FROM shopping_items ORDER BY id').all().map((row) => row.quantity), ['0.0025 kg', '0.0025 kg']);
    updatePurchase(d, delta.id, delta.items[0].id, { purchasedQuantity: 0.0025, remainingQuantity: 0, purchaseStatus: 'purchased' });
    const mergedPayload = { grocery_run_id: delta.id, items: [{ grocery_item_id: delta.items[0].id, unit: 'kg' }] };
    const reconcileAgain = async () => {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/pantry/reconcile-grocery-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mergedPayload),
      });
      assert.equal(result.status, 200, await result.text());
    };
    await reconcileAgain();
    assert.equal(d.prepare('SELECT quantity FROM pantry_items').get().quantity, 0.005);
    assert.deepEqual(d.prepare('SELECT quantity,quantity_before,quantity_after FROM pantry_movements WHERE grocery_item_id=?')
      .get(delta.items[0].id), { quantity: 0.0025, quantity_before: 0.0025, quantity_after: 0.005 });
    await reconcileAgain();
    assert.equal(d.prepare('SELECT quantity FROM pantry_items').get().quantity, 0.005);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM pantry_movements').get().n, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve)); d.close();
  }
});

test('explicit yields scale imported Unicode fractions and invalidate unchanged raw-text drafts when yield is defined', () => {
  const f = fixture(); const d = f.database;
  try {
    const unicode = f.recipe('Unicode amount', '½ cup', 4);
    assert.equal(recipeIngredientsForPortions(d, unicode, 8)[0].quantity, '1 cup');
    assert.equal(scaleIngredientQuantity('½ cup', 2), '½ cup', 'the legacy path retains its released behavior');
    const small = f.recipe('Small legacy quantity', '0.0025 kg');
    f.meal(small);
    const before = f.draft();
    assert.equal(before.items[0].quantity, '0 kg');
    d.prepare('UPDATE recipes SET yield_portions=1 WHERE id=?').run(small);
    assert.throws(() => finalizeGroceryRun(d, before.id), { code: 'GROCERY_DRAFT_CHANGED' });
    const after = f.draft();
    assert.equal(after.items[0].quantity, '0.0025 kg');
    assert.notEqual(after.source_fingerprint, before.source_fingerprint);
  } finally { d.close(); }
});
