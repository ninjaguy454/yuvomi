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

function seedRecipeMeal({ date, title, quantity }) {
  const recipeId = Number(database.prepare(`
    INSERT INTO recipes (title, created_by) VALUES (?, ?)
  `).run(`${title} recipe`, admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, name, quantity, category)
    VALUES (?, 'Milk', ?, 'Milchprodukte')
  `).run(recipeId, quantity);
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
