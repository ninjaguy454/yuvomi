import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'phase-six-grocery-secret-32chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: pantryRouter } = await import('../server/routes/pantry.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
for (const migration of ALL_MIGRATIONS) {
  apply(database, migration);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(migration.version, migration.description);
}
_setTestDatabase(database);

const admin = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('phase6admin', 'Alex', 'x', 'admin', 'parent')
`).run().lastInsertRowid);
const listId = Number(database.prepare(`
  INSERT INTO shopping_lists (name, created_by) VALUES ('Weekly groceries', ?)
`).run(admin).lastInsertRowid);
const member = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('phase6member', 'Sam', 'x', 'member', 'child')
`).run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/shopping', shoppingRouter);
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/pantry', pantryRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/shopping`;
const apiBase = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => { server.close(); database.close(); });

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

async function callApi(method, path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

function seedRecipeMeal({ date, title, quantity, ingredient = 'Milk', category = 'Milchprodukte' }) {
  const recipeId = Number(database.prepare(`
    INSERT INTO recipes (title, created_by) VALUES (?, ?)
  `).run(`${title} recipe`, admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
    VALUES (?, ?, ?, ?)
  `).run(recipeId, ingredient, quantity, category);
  const mealId = Number(database.prepare(`
    INSERT INTO meals (date, meal_type, title, recipe_id, created_by)
    VALUES (?, 'dinner', ?, ?, ?)
  `).run(date, title, recipeId, admin).lastInsertRowid);
  return { recipeId, mealId };
}

test('Phase 6 migration is additive and keeps durable grocery lifecycle tables', () => {
  assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE version = 10013').get());
  for (const table of ['meal_grocery_runs', 'meal_grocery_items', 'meal_grocery_item_sources']) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
});

test('draft grocery runs aggregate quantities while retaining every Meal and Recipe source', async () => {
  seedRecipeMeal({ date: '2032-03-03', title: 'Pasta', quantity: '1 l' });
  seedRecipeMeal({ date: '2032-03-04', title: 'Soup', quantity: '500 ml' });
  // Same units aggregate; incompatible units remain separate and keep their own provenance.
  seedRecipeMeal({ date: '2032-03-05', title: 'Pudding', quantity: '1 l' });

  const created = await call('POST', `/${listId}/grocery-runs`, {
    from: '2032-03-03', to: '2032-03-09', logical_key: 'week-2032-03-03',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'draft');
  assert.equal(created.body.data.items.length, 2);
  const litres = created.body.data.items.find((item) => item.unit === 'l');
  assert.equal(litres.quantity, '2 l');
  assert.equal(litres.planned_quantity, 2);
  assert.equal(litres.sources.length, 2);
  assert.deepEqual(litres.sources.map((source) => source.meal_title_snapshot).sort(), ['Pasta', 'Pudding']);
  assert.ok(litres.sources.every((source) => source.recipe_id && source.recipe_ingredient_id));

  const retry = await call('POST', `/${listId}/grocery-runs`, {
    from: '2032-03-03', to: '2032-03-09', logical_key: 'week-2032-03-03',
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.id, created.body.data.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_grocery_runs WHERE logical_key = ?').get('week-2032-03-03').n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_grocery_items WHERE grocery_run_id = ?').get(created.body.data.id).n, 2);
});

test('grocery grouping settings shape generated drafts and survive draft refreshes', async () => {
  seedRecipeMeal({ date: '2034-06-05', title: 'Group soup', quantity: '1 l' });
  seedRecipeMeal({ date: '2034-06-06', title: 'Group pasta', quantity: '1 l' });
  seedRecipeMeal({
    date: '2034-06-07', title: 'Group bread', quantity: '500 g',
    ingredient: 'Flour', category: 'Backwaren',
  });

  try {
    const categorySettings = await callApi('PUT', '/meals/grocery-settings', {
      grouping_mode: 'category',
    });
    assert.equal(categorySettings.status, 200, JSON.stringify(categorySettings.body));
    const byCategory = await call('POST', `/${listId}/grocery-runs`, {
      from: '2034-06-05', to: '2034-06-11', logical_key: 'grouping-week-2034-06-05',
    });
    assert.equal(byCategory.status, 201, JSON.stringify(byCategory.body));
    assert.equal(byCategory.body.data.grouping_mode, 'category');
    assert.deepEqual(
      [...new Set(byCategory.body.data.items.map((item) => item.group_label))].sort(),
      ['Backwaren', 'Milchprodukte'],
    );
    assert.equal(byCategory.body.data.items.find((item) => item.name === 'Milk').quantity, '2 l');

    const mealSettings = await callApi('PUT', '/meals/grocery-settings', {
      grouping_mode: 'meal',
    });
    assert.equal(mealSettings.status, 200, JSON.stringify(mealSettings.body));
    const byMeal = await call('POST', `/${listId}/grocery-runs`, {
      from: '2034-06-05', to: '2034-06-11', logical_key: 'grouping-week-2034-06-05',
    });
    assert.equal(byMeal.status, 200, JSON.stringify(byMeal.body));
    assert.equal(byMeal.body.meta.refreshed, true);
    assert.equal(byMeal.body.data.id, byCategory.body.data.id);
    assert.equal(byMeal.body.data.grouping_mode, 'meal');
    assert.equal(byMeal.body.data.items.length, 3,
      'identical ingredients remain separate when the draft is grouped by Meal');
    assert.deepEqual(
      byMeal.body.data.items.map((item) => item.group_label).sort(),
      ['2034-06-05 · Group soup', '2034-06-06 · Group pasta', '2034-06-07 · Group bread'],
    );
  } finally {
    const restored = await callApi('PUT', '/meals/grocery-settings', {
      grouping_mode: 'ingredient',
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  }
});

test('fractional recipe quantities remain numeric and aggregate accurately', async () => {
  seedRecipeMeal({ date: '2033-01-03', title: 'Half cup sauce', quantity: '1/2 cup' });
  seedRecipeMeal({ date: '2033-01-04', title: 'Mixed cup sauce', quantity: '1 1/2 cup' });
  seedRecipeMeal({ date: '2033-01-05', title: 'Unicode cup sauce', quantity: '½ cup' });

  const created = await call('POST', `/${listId}/grocery-runs`, {
    from: '2033-01-03', to: '2033-01-09', logical_key: 'fraction-week-2033-01-03',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.items.length, 1);
  assert.equal(created.body.data.items[0].quantity, '2.5 cup');
  assert.equal(created.body.data.items[0].planned_quantity, 2.5);
  assert.equal(created.body.data.items[0].unit, 'cup');
  assert.equal(created.body.data.items[0].sources.length, 3);
});

test('finalized runs publish exactly once and plan changes create a safe delta revision', async () => {
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2032-03-03', to: '2032-03-09', logical_key: 'frozen-week-2032-03-03',
  });
  const runId = draft.body.data.id;
  assert.equal((await call('POST', `/grocery-runs/${runId}/add-to-shopping`)).status, 409);

  const finalized = await call('POST', `/grocery-runs/${runId}/finalize`);
  assert.equal(finalized.status, 200);
  assert.equal(finalized.body.data.status, 'finalized');
  const published = await call('POST', `/grocery-runs/${runId}/add-to-shopping`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.data.status, 'added_to_shopping');
  assert.equal(published.body.meta.added_ids.length, 2);

  const publishedAgain = await call('POST', `/grocery-runs/${runId}/add-to-shopping`);
  assert.deepEqual(publishedAgain.body.meta.added_ids, []);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM shopping_items WHERE id IN (
      SELECT shopping_item_id FROM meal_grocery_items WHERE grocery_run_id = ?
    )
  `).get(runId).n, 2);

  const first = published.body.data.items[0];
  database.prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(first.shopping_item_id);
  database.prepare("UPDATE recipe_ingredients SET quantity = '99 l' WHERE id = (SELECT MIN(id) FROM recipe_ingredients)").run();
  const attemptedRefresh = await call('POST', `/${listId}/grocery-runs`, {
    from: '2032-03-03', to: '2032-03-09', logical_key: 'frozen-week-2032-03-03',
  });
  assert.equal(attemptedRefresh.status, 201);
  assert.notEqual(attemptedRefresh.body.data.id, runId);
  assert.equal(attemptedRefresh.body.data.status, 'draft');
  assert.equal(attemptedRefresh.body.data.revision, 2);
  assert.ok(attemptedRefresh.body.data.items.some((item) => item.quantity === '98 l'));
  assert.equal(database.prepare('SELECT is_checked FROM shopping_items WHERE id = ?').get(first.shopping_item_id).is_checked, 1);
});

test('purchase synchronization records purchased and remaining quantities and advances the run', async () => {
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2032-03-03', to: '2032-03-09', logical_key: 'purchase-week-2032-03-03',
  });
  const runId = draft.body.data.id;
  await call('POST', `/grocery-runs/${runId}/finalize`);
  const published = await call('POST', `/grocery-runs/${runId}/add-to-shopping`);
  for (const item of published.body.data.items) {
    database.prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(item.shopping_item_id);
  }
  const synced = await call('POST', `/grocery-runs/${runId}/sync-purchases`);
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.data.status, 'purchased');
  assert.ok(synced.body.data.items.every((item) => item.purchase_status === 'purchased'));
  const numeric = synced.body.data.items.find((item) => item.planned_quantity != null);
  assert.equal(numeric.purchased_quantity, numeric.planned_quantity);
  assert.equal(numeric.remaining_quantity, 0);
});

test('meal execution creates role Tasks once, refreshes open work, and freezes started history', async () => {
  // This lifecycle fixture needs qualified assignees. Skill eligibility itself
  // is covered separately; an age-unknown child is intentionally not qualified.
  database.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
    SELECT ?,id,'normal','manual',? FROM skills WHERE system_key IN ('serving','cleanup')
    ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency='normal'`).run(member, admin);
  const recipeId = Number(database.prepare(`INSERT INTO recipes (title, created_by) VALUES ('Tacos', ?)`).run(admin).lastInsertRowid);
  database.prepare(`INSERT INTO recipe_ingredients (recipe_id, name, quantity, category) VALUES (?, 'Tortillas', '8 pcs', 'Sonstiges')`).run(recipeId);
  const mealId = Number(database.prepare(`
    INSERT INTO meals (
      date, meal_type, title, recipe_id, scheduled_time, expected_duration_minutes,
      selection_status, source, source_key, created_by
    ) VALUES ('2032-04-08', 'dinner', 'Taco night', ?, '18:00', 45, 'selected', 'manual', 'phase6-tacos', ?)
  `).run(recipeId, admin).lastInsertRowid);
  const participant = database.prepare(`
    INSERT INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, 'participating', 'manual')
  `);
  participant.run(mealId, admin, 'cook');
  participant.run(mealId, admin, 'supervisor');
  participant.run(mealId, member, 'participant');

  const settings = await callApi('PUT', '/meals/execution-settings', {
    enabled: true,
    default_shopping_list_id: listId,
    auto_create_grocery_draft: true,
    auto_finalize_grocery: false,
    generate_preparation: true,
    generate_cooking: true,
    generate_supervision: true,
    generate_serving: true,
    generate_cleanup: true,
    preparation_lead_minutes: 60,
    cooking_lead_minutes: 30,
    cleanup_delay_minutes: 45,
  });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));

  const created = await callApi('POST', `/meals/${mealId}/execution-tasks`, {});
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.tasks.length, 5);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_execution_tasks WHERE meal_id = ?').get(mealId).n, 5);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM task_responsibilities WHERE source = 'meal_execution'").get().n, 5);

  const retry = await callApi('POST', `/meals/${mealId}/execution-tasks`, {});
  assert.equal(retry.status, 200);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_execution_tasks WHERE meal_id = ?').get(mealId).n, 5);

  database.prepare("UPDATE meals SET title = 'Taco supper' WHERE id = ?").run(mealId);
  const refreshed = await callApi('POST', `/meals/${mealId}/execution-tasks`, {});
  assert.equal(refreshed.body.data.revision, 2);
  assert.ok(refreshed.body.data.tasks.every((task) => task.title_snapshot.includes('Taco supper')));

  const completedTask = refreshed.body.data.tasks[0];
  database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(completedTask.task_id);
  database.prepare("UPDATE meals SET title = 'Changed after work started' WHERE id = ?").run(mealId);
  const frozen = await callApi('POST', `/meals/${mealId}/execution-tasks`, {});
  assert.equal(frozen.body.data.revision, 2);
  assert.ok(frozen.body.data.frozen_at);
  assert.ok(frozen.body.data.tasks.every((task) => task.title_snapshot.includes('Taco supper')));
});

test('preparing a week is retry-safe and builds both execution Tasks and a grocery draft', async () => {
  const first = await callApi('POST', '/meals/execution/prepare', {
    from: '2032-04-07', to: '2032-04-13', logical_key: 'phase6-prepare-week',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.meals.length, 1);
  assert.equal(first.body.data.grocery_run.status, 'draft');
  const runId = first.body.data.grocery_run.id;
  const taskCount = database.prepare('SELECT COUNT(*) AS n FROM meal_execution_tasks').get().n;

  const retry = await callApi('POST', '/meals/execution/prepare', {
    from: '2032-04-07', to: '2032-04-13', logical_key: 'phase6-prepare-week',
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.grocery_run.id, runId);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_execution_tasks').get().n, taskCount);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM meal_grocery_runs WHERE logical_key = 'phase6-prepare-week'").get().n, 1);
});

test('purchased groceries reconcile into Pantry once and Pantry movements are idempotent', async () => {
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2032-04-07', to: '2032-04-13', logical_key: 'phase6-pantry-week',
  });
  const runId = draft.body.data.id;
  await call('POST', `/grocery-runs/${runId}/finalize`, {});
  const published = await call('POST', `/grocery-runs/${runId}/add-to-shopping`, {});
  for (const item of published.body.data.items) {
    const checked = await call('PATCH', `/items/${item.shopping_item_id}`, { is_checked: true });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
  }
  const run = await call('GET', `/grocery-runs/${runId}`);
  assert.equal(run.body.data.status, 'purchased');
  const locationId = database.prepare('SELECT id FROM pantry_locations ORDER BY sort_order, id LIMIT 1').get().id;
  const entries = run.body.data.items.map((item) => ({
    grocery_item_id: item.id,
    quantity: item.purchased_quantity || item.planned_quantity || 1,
    unit: item.unit || 'pcs',
    location_id: locationId,
  }));

  const reconciled = await callApi('POST', '/pantry/reconcile-grocery-run', { grocery_run_id: runId, items: entries });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.data.run.status, 'reconciled');
  const stockBeforeRetry = database.prepare('SELECT SUM(quantity) AS n FROM pantry_items').get().n;
  const retry = await callApi('POST', '/pantry/reconcile-grocery-run', { grocery_run_id: runId, items: entries });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.reconciled, 0);
  assert.equal(database.prepare('SELECT SUM(quantity) AS n FROM pantry_items').get().n, stockBeforeRetry);

  const pantryItem = database.prepare('SELECT * FROM pantry_items WHERE quantity > 0 ORDER BY id LIMIT 1').get();
  const consumed = await callApi('POST', `/pantry/${pantryItem.id}/consume`, { quantity: 1, logical_key: 'phase6-consume-once' });
  assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
  const consumeRetry = await callApi('POST', `/pantry/${pantryItem.id}/consume`, { quantity: 1, logical_key: 'phase6-consume-once' });
  assert.equal(consumeRetry.body.data.reused, true);
  assert.equal(consumeRetry.body.data.item.quantity, consumed.body.data.item.quantity);

  const leftover = await callApi('POST', '/pantry/leftovers', {
    name: 'Taco leftovers', quantity: 2, unit: 'pcs', location_id: locationId,
    logical_key: 'phase6-leftovers-once',
  });
  assert.equal(leftover.status, 201, JSON.stringify(leftover.body));
  const leftoverRetry = await callApi('POST', '/pantry/leftovers', {
    name: 'Taco leftovers', quantity: 2, unit: 'pcs', location_id: locationId,
    logical_key: 'phase6-leftovers-once',
  });
  assert.equal(leftoverRetry.body.data.reused, true);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM pantry_movements WHERE logical_key LIKE '%phase6-consume-once' OR logical_key LIKE '%phase6-leftovers-once'").get().n, 2);
});

test('legacy Pantry import rejects grocery outputs atomically and preserves canonical reconciliation', async () => {
  seedRecipeMeal({ date: '2040-09-10', title: 'Provenance guard', quantity: '1 l', ingredient: 'Provenance milk' });
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2040-09-10', to: '2040-09-10', logical_key: 'provenance-guard',
  });
  assert.equal(draft.status, 201);
  const runId = draft.body.data.id;
  await call('POST', `/grocery-runs/${runId}/finalize`);
  const published = await call('POST', `/grocery-runs/${runId}/add-to-shopping`);
  const grocery = published.body.data.items[0];
  const ordinaryId = Number(database.prepare(`
    INSERT INTO shopping_items (list_id, name, quantity, is_checked)
    VALUES (?, 'Ordinary guard item', '1', 1)
  `).run(listId).lastInsertRowid);
  database.prepare('UPDATE shopping_items SET is_checked = 1 WHERE id = ?').run(grocery.shopping_item_id);
  await call('POST', `/grocery-runs/${runId}/sync-purchases`);

  const ordinaryEntry = { shopping_item_id: ordinaryId, quantity: 1, unit: 'pcs' };
  const groceryEntry = { shopping_item_id: grocery.shopping_item_id, quantity: 1, unit: 'l' };
  const rejected = await callApi('POST', '/pantry/import-shopping', {
    list_id: listId, items: [ordinaryEntry, groceryEntry],
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'GROCERY_RECONCILIATION_REQUIRED');
  assert.match(rejected.body.error, /Refresh Shopping/);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM pantry_items WHERE name IN ('Ordinary guard item', 'Provenance milk')").get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM pantry_movements WHERE grocery_item_id = ?').get(grocery.id).n, 0);

  const ordinary = await callApi('POST', '/pantry/import-shopping', { list_id: listId, items: [ordinaryEntry] });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.data.added, 1);
  const canonical = await callApi('POST', '/pantry/reconcile-grocery-run', {
    grocery_run_id: runId, items: [{ grocery_item_id: grocery.id, quantity: 1, unit: 'l' }],
  });
  assert.equal(canonical.status, 200);
  assert.equal(database.prepare("SELECT quantity FROM pantry_items WHERE name = 'Provenance milk'").get().quantity, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM pantry_movements WHERE grocery_item_id = ?').get(grocery.id).n, 1);

  const retry = await callApi('POST', '/pantry/import-shopping', { list_id: listId, items: [groceryEntry] });
  assert.equal(retry.status, 409);
  assert.equal(database.prepare("SELECT quantity FROM pantry_items WHERE name = 'Provenance milk'").get().quantity, 1);
});

test('legacy Meal and week imports cannot recreate unlinked copies of published grocery demand', async () => {
  const { mealId } = seedRecipeMeal({ date: '2042-04-07', title: 'Alternate import meal', quantity: '1 pcs', ingredient: 'Alternate guard beans' });
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2042-04-07', to: '2042-04-07', logical_key: 'alternate-import-guard',
  });
  const runId = draft.body.data.id;
  await call('POST', `/grocery-runs/${runId}/finalize`);
  const published = await call('POST', `/grocery-runs/${runId}/add-to-shopping`);
  const grocery = published.body.data.items[0];
  const countBefore = database.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n;
  const firstNoticeCount = database.prepare('SELECT COUNT(*) AS n FROM notification_inbox WHERE source_key = ?').get(`grocery-run:${runId}:published`).n;
  assert.ok(firstNoticeCount > 0);
  await call('POST', `/grocery-runs/${runId}/add-to-shopping`);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM notification_inbox WHERE source_key = ?').get(`grocery-run:${runId}:published`).n, firstNoticeCount);
  const single = await callApi('POST', `/meals/${mealId}/to-shopping-list`, { listId });
  assert.equal(single.status, 409);
  assert.equal(single.body.code, 'GROCERY_RECONCILIATION_REQUIRED');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_ingredients WHERE meal_id = ?').get(mealId).n, 0, 'preflight runs before recipe materialization');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n, countBefore);

  // A Meal with published demand must use a grocery revision for later open
  // ingredients. A mixed legacy batch must not partially import ordinary work.
  database.prepare("INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES (?,'Updated grocery ingredient','1 pcs')").run(mealId);
  const ordinaryMeal = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,created_by)
    VALUES ('2042-04-08','lunch','Ordinary legacy meal',?)`).run(admin).lastInsertRowid);
  database.prepare("INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES (?,'Ordinary legacy ingredient','1 pcs')").run(ordinaryMeal);
  for (const path of ['/meals/week-to-shopping-list', `/shopping/${listId}/import-meal-plan`]) {
    const rejected = await callApi('POST', path, { listId, week: '2042-04-07', from: '2042-04-07', to: '2042-04-13' });
    assert.equal(rejected.status, 409, JSON.stringify(rejected));
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n, countBefore);
    assert.equal(database.prepare('SELECT on_shopping_list FROM meal_ingredients WHERE meal_id = ?').get(ordinaryMeal).on_shopping_list, 0);
  }
  const ordinary = await callApi('POST', `/meals/${ordinaryMeal}/to-shopping-list`, { listId });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.data.transferred, 1);

  await call('PATCH', `/items/${grocery.shopping_item_id}`, { is_checked: true });
  await call('POST', `/grocery-runs/${runId}/sync-purchases`);
  const canonical = await callApi('POST', '/pantry/reconcile-grocery-run', {
    grocery_run_id: runId, items: [{ grocery_item_id: grocery.id, quantity: 1, unit: 'pcs' }],
  });
  assert.equal(canonical.status, 200);
  assert.equal(database.prepare("SELECT quantity FROM pantry_items WHERE name = 'Alternate guard beans'").get().quantity, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM pantry_movements WHERE grocery_item_id = ?').get(grocery.id).n, 1);
});

test('draft ownership prevents legacy import before publication and accounts for the purchase exactly once', async () => {
  const { mealId } = seedRecipeMeal({ date: '2043-04-09', title: 'Draft-owned meal', quantity: '1 l', ingredient: 'Draft-owned milk' });
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2043-04-09', to: '2043-04-09', logical_key: 'draft-legacy-publish-once',
  });
  assert.equal(draft.status, 201);
  const runId = draft.body.data.id;
  assert.equal(draft.body.data.items[0].published_at, null);
  for (const state of ['draft', 'finalized']) {
    if (state === 'finalized') assert.equal((await call('POST', `/grocery-runs/${runId}/finalize`)).status, 200);
    const legacy = await callApi('POST', `/meals/${mealId}/to-shopping-list`, { listId });
    assert.equal(legacy.status, 409, `${state}: ${JSON.stringify(legacy.body)}`);
    assert.equal(legacy.body.code, 'GROCERY_RECONCILIATION_REQUIRED');
    assert.match(legacy.body.error, /grocery run/i);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_ingredients WHERE meal_id = ?').get(mealId).n, 0,
      'reject before recipe ingredients are materialized');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE added_from_meal = ?').get(mealId).n, 0);
  }

  const published = await call('POST', `/grocery-runs/${runId}/add-to-shopping`);
  assert.equal(published.status, 200);
  const grocery = published.body.data.items[0];
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE added_from_meal = ?').get(mealId).n, 1);
  await call('PATCH', `/items/${grocery.shopping_item_id}`, { is_checked: true });
  await call('POST', `/grocery-runs/${runId}/sync-purchases`);
  const generic = await callApi('POST', '/pantry/import-shopping', {
    list_id: listId, items: [{ shopping_item_id: grocery.shopping_item_id, quantity: 1, unit: 'l' }],
  });
  assert.equal(generic.status, 409);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM pantry_items WHERE name = 'Draft-owned milk'").get().n, 0);
  const payload = { grocery_run_id: runId, items: [{ grocery_item_id: grocery.id, quantity: 1, unit: 'l' }] };
  assert.equal((await callApi('POST', '/pantry/reconcile-grocery-run', payload)).body.data.reconciled, 1);
  assert.equal((await callApi('POST', '/pantry/reconcile-grocery-run', payload)).body.data.reconciled, 0);
  assert.equal(database.prepare("SELECT quantity FROM pantry_items WHERE name = 'Draft-owned milk'").get().quantity, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM pantry_movements WHERE grocery_item_id = ?').get(grocery.id).n, 1);
});

test('unpublished materialized demand blocks every mixed legacy batch before any list or ingredient mutation', async () => {
  const mealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,created_by)
    VALUES ('2044-03-09','dinner','Owned materialized meal',?)`).run(admin).lastInsertRowid);
  database.prepare("INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES (?,'Owned draft flour','1.5 kg')").run(mealId);
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2044-03-09', to: '2044-03-09', logical_key: 'mixed-draft-ownership',
  });
  assert.equal(draft.status, 201);
  const ordinaryMeal = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,created_by)
    VALUES ('2044-03-09','lunch','Unowned materialized meal',?)`).run(admin).lastInsertRowid);
  database.prepare("INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES (?,'Unowned draft flour','2.5 kg')").run(ordinaryMeal);
  const otherList = Number(database.prepare("INSERT INTO shopping_lists(name,created_by) VALUES ('Alternate draft destination',?)").run(admin).lastInsertRowid);
  const before = database.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n;
  for (const target of [listId, otherList]) {
    const paths = [`/meals/${mealId}/to-shopping-list`, '/meals/week-to-shopping-list', `/shopping/${target}/import-meal-plan`];
    for (const path of paths) {
      const rejected = await callApi('POST', path, {
        listId: target, week: '2044-03-09', from: '2044-03-09', to: '2044-03-09',
      });
      assert.equal(rejected.status, 409, `${path}: ${JSON.stringify(rejected.body)}`);
      assert.equal(rejected.body.code, 'GROCERY_RECONCILIATION_REQUIRED');
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM shopping_items').get().n, before);
      assert.equal(database.prepare('SELECT SUM(on_shopping_list) AS n FROM meal_ingredients WHERE meal_id IN (?,?)').get(mealId, ordinaryMeal).n, 0);
    }
  }
  const ordinary = await callApi('POST', `/meals/${ordinaryMeal}/to-shopping-list`, { listId: otherList });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.data.transferred, 1);
  assert.equal(database.prepare('SELECT quantity FROM shopping_items WHERE added_from_meal = ?').get(ordinaryMeal).quantity, '2.5 kg');
});

test('draft source ownership respects excluded trip demand and preserves real quantities and category groups', async () => {
  const context = Number(database.prepare(`INSERT INTO planning_contexts
    (context_key,name,context_type,starts_at,ends_at,created_by)
    VALUES ('grocery-excluded-trip','Excluded grocery trip','travel','2045-03-09T00:00:00','2045-03-10T00:00:00',?)`).run(admin).lastInsertRowid);
  database.prepare('INSERT INTO planning_context_grocery_settings(planning_context_id,track_groceries) VALUES (?,0)').run(context);
  const trackedContext = Number(database.prepare(`INSERT INTO planning_contexts
    (context_key,name,context_type,starts_at,ends_at,created_by)
    VALUES ('grocery-tracked-trip','Tracked grocery trip','travel','2045-03-09T00:00:00','2045-03-10T00:00:00',?)`).run(admin).lastInsertRowid);
  const home = seedRecipeMeal({ date: '2045-03-09', title: 'Tracked Home demand', quantity: '1.25 l', ingredient: 'Context guard milk' });
  const additional = seedRecipeMeal({ date: '2045-03-09', title: 'Tracked Trip demand', quantity: '2.75 l', ingredient: 'Context guard milk' });
  database.prepare('UPDATE meals SET planning_context_id = ? WHERE id = ?').run(trackedContext, additional.mealId);
  const trip = seedRecipeMeal({ date: '2045-03-09', title: 'Excluded Trip demand', quantity: '5 l', ingredient: 'Context guard milk' });
  database.prepare('UPDATE meals SET planning_context_id = ? WHERE id = ?').run(context, trip.mealId);
  seedRecipeMeal({ date: '2045-03-09', title: 'Separate category demand', quantity: '3 l', ingredient: 'Context guard milk', category: 'Sonstiges' });
  const draft = await call('POST', `/${listId}/grocery-runs`, {
    from: '2045-03-09', to: '2045-03-09', logical_key: 'context-draft-ownership',
  });
  assert.equal(draft.status, 201);
  const dairy = draft.body.data.items.find((item) => item.category === 'Milchprodukte');
  const other = draft.body.data.items.find((item) => item.category === 'Sonstiges');
  assert.equal(draft.body.data.items.length, 2, 'same ingredient in different categories remains separate');
  assert.equal(dairy.quantity, '4 l');
  assert.equal(dairy.planned_quantity, 4);
  assert.equal(other.quantity, '3 l');
  assert.deepEqual(dairy.sources.map((source) => source.meal_id).sort(), [home.mealId, additional.mealId].sort());
  assert.ok(draft.body.data.items.every((item) => item.sources.every((source) => source.meal_id !== trip.mealId)));
  assert.equal((await callApi('POST', `/meals/${home.mealId}/to-shopping-list`, { listId })).status, 409);
  assert.equal((await callApi('POST', `/meals/${additional.mealId}/to-shopping-list`, { listId })).status, 409);
  const legacy = await callApi('POST', `/meals/${trip.mealId}/to-shopping-list`, { listId });
  assert.equal(legacy.status, 200, 'the same ingredient name in an excluded context has no ledger ownership');
  const legacyId = legacy.body.data.added_ids[0];
  assert.equal(database.prepare('SELECT quantity FROM shopping_items WHERE id = ?').get(legacyId).quantity, '5 l');
  await call('PATCH', `/items/${legacyId}`, { is_checked: true });
  assert.equal((await callApi('POST', '/pantry/import-shopping', {
    list_id: listId, items: [{ shopping_item_id: legacyId, quantity: 5, unit: 'l' }],
  })).status, 200);
  await call('POST', `/grocery-runs/${draft.body.data.id}/finalize`);
  const published = await call('POST', `/grocery-runs/${draft.body.data.id}/add-to-shopping`);
  const publishedDairy = published.body.data.items.find((item) => item.id === dairy.id);
  assert.equal(publishedDairy.quantity, '4 l');
  await call('PATCH', `/items/${publishedDairy.shopping_item_id}`, { is_checked: true });
  await call('POST', `/grocery-runs/${draft.body.data.id}/sync-purchases`);
  assert.equal((await callApi('POST', '/pantry/reconcile-grocery-run', {
    grocery_run_id: draft.body.data.id, items: [{ grocery_item_id: dairy.id, quantity: 4, unit: 'l' }],
  })).body.data.reconciled, 1);
  assert.equal(database.prepare("SELECT quantity FROM pantry_items WHERE name = 'Context guard milk'").get().quantity, 9,
    'the distinct 5 l excluded Trip purchase and 4 l tracked Home/Trip purchase are both legitimate');
});

test('refreshing a draft releases a Meal only after its source demand is removed', async () => {
  const { mealId } = seedRecipeMeal({ date: '2046-03-09', title: 'Moved draft meal', quantity: '2 pcs', ingredient: 'Moved draft apples' });
  const body = { from: '2046-03-09', to: '2046-03-09', logical_key: 'refresh-releases-legacy' };
  const draft = await call('POST', `/${listId}/grocery-runs`, body);
  assert.equal(draft.status, 201);
  assert.equal((await callApi('POST', `/meals/${mealId}/to-shopping-list`, { listId })).status, 409);
  database.prepare("UPDATE meals SET date = '2046-03-10' WHERE id = ?").run(mealId);
  assert.equal((await callApi('POST', `/meals/${mealId}/to-shopping-list`, { listId })).status, 409,
    'changing dates alone does not abandon already reserved demand');
  const refreshed = await call('POST', `/${listId}/grocery-runs`, body);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.id, draft.body.data.id);
  assert.equal(refreshed.body.data.items.length, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM meal_grocery_item_sources WHERE meal_id = ?').get(mealId).n, 0);
  const legacy = await callApi('POST', `/meals/${mealId}/to-shopping-list`, { listId });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.data.transferred, 1);
  assert.equal(database.prepare('SELECT quantity FROM shopping_items WHERE added_from_meal = ?').get(mealId).quantity, '2 pcs');
});
