import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'portion-route-secret-at-least-32-chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const { default: shoppingRouter } = await import('../server/routes/shopping.js');

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

function user(username, role = 'member') {
  return Number(database.prepare(`INSERT INTO users (username,display_name,password_hash,role,family_role)
    VALUES (?,?, 'x', ?, 'other')`).run(username, username, role).lastInsertRowid);
}

const admin = user('Portion Admin', 'admin');
const members = [user('A'), user('B'), user('C'), user('D')];
let actor = admin;
let role = 'admin';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor;
  req.authRole = role;
  req.session = { userId: actor, role };
  next();
});
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/recipes', recipesRouter);
app.use('/api/v1/shopping', shoppingRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
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

test('recipe serving basis is optional, validated and preserved by native duplication', async () => {
  const created = await call('POST', '/recipes', {
    title: 'Fish sticks', yield_portions: 4,
    serving_basis: { amount: 4, unit: 'count', label: 'fish stick' },
    ingredients: [{ name: 'Fish sticks', quantity: '8 pcs', category: 'Frozen' }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.yield_portions, 4);
  assert.equal(created.body.data.serving_basis_amount, 4);

  const copied = await call('POST', `/recipes/${created.body.data.id}/duplicate`, {});
  assert.equal(copied.status, 201, JSON.stringify(copied.body));
  assert.equal(copied.body.data.provider_account_id, null);
  assert.equal(copied.body.data.yield_portions, 4);
  assert.equal(copied.body.data.serving_basis_label, 'fish stick');

  const invalid = await call('POST', '/recipes', {
    title: 'Invalid count', yield_portions: 1,
    serving_basis: { amount: 2, unit: 'count', label: '' },
  });
  assert.equal(invalid.status, 400);

  const providerAccountId = Number(database.prepare(`INSERT INTO recipe_provider_accounts
    (name,base_url,api_token,provider,created_by) VALUES ('Portion Mealie','https://mealie.example.test','token','mealie',?)`)
    .run(admin).lastInsertRowid);
  const mirroredId = Number(database.prepare(`INSERT INTO recipes
    (title,created_by,provider_account_id,provider_recipe_id,yield_portions,
     serving_basis_amount,serving_basis_unit,serving_basis_label)
    VALUES ('Provider tacos',?,?, 'provider-tacos', 4, 2, 'count', 'taco')`)
    .run(admin, providerAccountId).lastInsertRowid);
  const providerCopy = await call('POST', `/recipes/${mirroredId}/duplicate`, {});
  assert.equal(providerCopy.status, 201, JSON.stringify(providerCopy.body));
  assert.equal(providerCopy.body.data.provider_account_id, null);
  assert.equal(providerCopy.body.data.yield_portions, 4);
  assert.equal(providerCopy.body.data.serving_basis_label, 'taco');
  const mirroredEdit = await call('PUT', `/recipes/${mirroredId}`, {
    title: 'Provider tacos', serving_basis: { amount: 3 },
  });
  assert.equal(mirroredEdit.status, 403);
  assert.equal(database.prepare('SELECT serving_basis_amount FROM recipes WHERE id=?').get(mirroredId).serving_basis_amount, 2);
});

test('partial serving edits retain omitted fields, malformed data is rejected, and explicit null removes optional values', async () => {
  const written = { title: 'Portion editing', notes: 'Bake until ready.',
    ingredients: [{ name: 'Fish sticks', quantity: '16 pcs', category: 'Frozen' }] };
  const created = await call('POST', '/recipes', { ...written, yield_portions: 4,
    serving_basis: { amount: 4, unit: 'count', label: 'fish stick' } });
  assert.equal(created.status, 201);
  const path = `/recipes/${created.body.data.id}`;
  const partialAmount = await call('PUT', path, { ...written, serving_basis: { amount: 6 } });
  assert.equal(partialAmount.status, 200);
  assert.equal(partialAmount.body.data.serving_basis_amount, 6);
  assert.equal(partialAmount.body.data.serving_basis_unit, 'count');
  assert.equal(partialAmount.body.data.serving_basis_label, 'fish stick');
  assert.equal(partialAmount.body.data.yield_portions, 4);
  const partialLabel = await call('PUT', path, { ...written, serving_basis_label: 'fish bite' });
  assert.equal(partialLabel.status, 200);
  assert.equal(partialLabel.body.data.serving_basis_amount, 6);
  assert.equal(partialLabel.body.data.serving_basis_unit, 'count');
  assert.equal(partialLabel.body.data.serving_basis_label, 'fish bite');

  for (const serving_basis of ['oops', 4, false, [], { amount: [] }, { amount: 1.125 },
    { unit: {} }, { label: [] }, { ammount: 4 }]) {
    const rejected = await call('PUT', path, { ...written, serving_basis });
    assert.equal(rejected.status, 400, JSON.stringify(serving_basis));
    const saved = (await call('GET', path)).body.data;
    assert.equal(saved.serving_basis_amount, 6);
    assert.equal(saved.serving_basis_unit, 'count');
    assert.equal(saved.serving_basis_label, 'fish bite');
  }
  const incomplete = await call('POST', '/recipes', { title: 'Missing serving amount', serving_basis_unit: 'oz' });
  assert.equal(incomplete.status, 400);
  const cleared = await call('PUT', path, { ...written, serving_basis: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.serving_basis_amount, null);
  assert.equal(cleared.body.data.serving_basis_unit, null);
  assert.equal(cleared.body.data.serving_basis_label, null);
  assert.equal(cleared.body.data.yield_portions, 4);

  const legacy = await call('PUT', path, { ...written, yield_portions: null });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.data.yield_portions, null);
  const unchanged = await call('PUT', path, written);
  assert.equal(unchanged.body.data.yield_portions, null);
  const copied = await call('POST', `${path}/duplicate`, {});
  assert.equal(copied.status, 201);
  assert.equal(copied.body.data.yield_portions, null);
  assert.equal(copied.body.data.serving_basis_amount, null);
});

test('serving-size edits and native duplication preserve the written-batch Cooking Map', async () => {
  const written = { title: 'Fish sticks with a Cooking Map', notes: 'Bake the fish sticks.',
    ingredients: [{ name: 'Fish sticks', quantity: '16 pcs', category: 'Frozen' }] };
  const created = await call('POST', '/recipes', { ...written, yield_portions: 4,
    serving_basis: { amount: 4, unit: 'count', label: 'fish stick' } });
  assert.equal(created.status, 201);
  const path = `/recipes/${created.body.data.id}`;
  const pipeline = {
    schema_version: 1,
    resources: [
      { id: 'fish-sticks', kind: 'ingredient', name: 'Fish sticks', quantity: '16 pcs', source_index: 0 },
      { id: 'cooked-fish-sticks', kind: 'component', name: 'Cooked fish sticks' },
    ],
    operations: [{ id: 'bake', label: 'Bake the fish sticks', consumes: ['fish-sticks'], produces: ['cooked-fish-sticks'], equipment: ['oven'] }],
  };
  const saved = await call('PUT', `${path}/pipeline`, { pipeline,
    expected_revision: created.body.data.pipeline_revision, source_hash: created.body.data.pipeline_current_source_hash });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const edited = await call('PUT', path, { ...written, serving_basis: { amount: 6 }, yield_portions: 3 });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.data.pipeline, saved.body.data.pipeline);
  assert.equal(edited.body.data.pipeline_revision, saved.body.data.pipeline_revision);
  assert.equal(edited.body.data.pipeline_current_source_hash, saved.body.data.pipeline_current_source_hash);
  assert.equal(edited.body.data.pipeline_review_needed, false);
  const copied = await call('POST', `${path}/duplicate`, {});
  assert.equal(copied.status, 201);
  assert.deepEqual(copied.body.data.pipeline, saved.body.data.pipeline);
  assert.equal(copied.body.data.yield_portions, 3);
  assert.equal(copied.body.data.serving_basis_amount, 6);
  assert.equal(copied.body.data.pipeline_review_needed, false);
});

test('participant portions persist, restore after opt-out, audit actors and reject stale saves', async () => {
  const recipeId = Number(database.prepare(`INSERT INTO recipes
    (title, created_by, yield_portions, serving_basis_amount, serving_basis_unit, serving_basis_label)
    VALUES ('Shared fish sticks', ?, 4, 4, 'count', 'fish stick')`).run(admin).lastInsertRowid);
  database.prepare(`INSERT INTO recipe_ingredients(recipe_id,name,quantity,category)
    VALUES (?, 'Fish sticks', '8 pcs', 'Frozen')`).run(recipeId);
  const mealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,recipe_id,created_by)
    VALUES ('2045-02-01','dinner','Shared fish sticks',?,?)`).run(recipeId, admin).lastInsertRowid);
  for (const member of members) database.prepare(`INSERT INTO meal_participants(meal_id,user_id,role,status,source)
    VALUES (?,?,'participant','needs_confirmation','manual')`).run(mealId, member);

  const amounts = [1, 0.75, 1.25, 0.5];
  for (let index = 0; index < members.length; index += 1) {
    const response = await call('POST', `/meals/${mealId}/decisions`, {
      beneficiary_user_id: members[index], participation: 'participating', choice_kind: 'household',
      confirmed: true, portion_amount: amounts[index], expected_revision: 0,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.portion_amount, amounts[index]);
    assert.equal(response.body.data.entered_by_user_id, admin);
  }

  let meal = database.prepare('SELECT planned_portions,portions FROM meals WHERE id=?').get(mealId);
  assert.deepEqual(meal, { planned_portions: 3.5, portions: 4 });
  assert.equal(database.prepare('SELECT quantity FROM meal_ingredients WHERE meal_id=?').get(mealId).quantity, '8 pcs');

  const leave = await call('POST', `/meals/${mealId}/decisions`, {
    beneficiary_user_id: members[1], participation: 'not_participating', choice_kind: 'household',
    confirmed: true, expected_revision: 1,
  });
  assert.equal(leave.status, 200, JSON.stringify(leave.body));
  assert.equal(leave.body.data.portion_amount, 0.75);
  const rejoin = await call('POST', `/meals/${mealId}/decisions`, {
    beneficiary_user_id: members[1], participation: 'participating', choice_kind: 'household',
    confirmed: true, expected_revision: 2,
  });
  assert.equal(rejoin.status, 200, JSON.stringify(rejoin.body));
  assert.equal(rejoin.body.data.portion_amount, 0.75);

  const stale = await call('POST', `/meals/${mealId}/decisions`, {
    beneficiary_user_id: members[1], participation: 'participating', choice_kind: 'household',
    confirmed: true, portion_amount: 9, expected_revision: 1,
  });
  assert.equal(stale.status, 409);
  assert.equal(database.prepare(`SELECT portion_amount FROM meal_person_decisions
    WHERE meal_id=? AND beneficiary_user_id=?`).get(mealId, members[1]).portion_amount, 0.75);

  for (const invalid of [0, -1, 1.125]) {
    const response = await call('POST', `/meals/${mealId}/decisions`, {
      beneficiary_user_id: members[0], participation: 'participating', choice_kind: 'household',
      confirmed: true, portion_amount: invalid,
    });
    assert.equal(response.status, 400, `invalid ${invalid}`);
  }

  actor = members[0]; role = 'member';
  const denied = await call('POST', `/meals/${mealId}/decisions`, {
    beneficiary_user_id: members[2], participation: 'participating', choice_kind: 'household',
    confirmed: true, portion_amount: 2,
  });
  assert.equal(denied.status, 403);
  actor = admin; role = 'admin';

  const listId = Number(database.prepare(`INSERT INTO shopping_lists(name,created_by)
    VALUES ('Portion groceries',?)`).run(admin).lastInsertRowid);
  const draft = await call('POST', `/shopping/${listId}/grocery-runs`, {
    from: '2045-02-01', to: '2045-02-01', logical_key: 'portion-grocery-proof',
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.data.items[0].quantity, '8 pcs');
  assert.equal(draft.body.data.items[0].sources[0].planned_portions_snapshot, 3.5);
  assert.equal(draft.body.data.items[0].sources[0].cook_portions_snapshot, 4);

  const changed = await call('POST', `/meals/${mealId}/decisions`, {
    beneficiary_user_id: members[3], participation: 'participating', choice_kind: 'household',
    confirmed: true, portion_amount: 1.5, expected_revision: 1,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  meal = database.prepare('SELECT planned_portions,portions FROM meals WHERE id=?').get(mealId);
  assert.deepEqual(meal, { planned_portions: 4.5, portions: 5 });
  assert.equal(database.prepare('SELECT quantity FROM meal_ingredients WHERE meal_id=?').get(mealId).quantity, '10 pcs');
  const refreshed = await call('POST', `/shopping/${listId}/grocery-runs`, {
    from: '2045-02-01', to: '2045-02-01', logical_key: 'portion-grocery-proof',
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.data.items[0].quantity, '10 pcs');
});

test('legacy recipe and recipe-less Meal keep safe defaults', async () => {
  const recipeId = Number(database.prepare(`INSERT INTO recipes(title,created_by) VALUES ('Legacy soup',?)`).run(admin).lastInsertRowid);
  const legacy = database.prepare(`SELECT yield_portions,serving_basis_amount FROM recipes WHERE id=?`).get(recipeId);
  assert.deepEqual(legacy, { yield_portions: null, serving_basis_amount: null });
  const mealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,created_by)
    VALUES ('2045-02-02','lunch','Custom lunch',?)`).run(admin).lastInsertRowid);
  database.prepare(`INSERT INTO meal_participants(meal_id,user_id,role,status,source)
    VALUES (?,?,'participant','needs_confirmation','manual')`).run(mealId, members[0]);
  const response = await call('POST', `/meals/${mealId}/decisions`, {
    beneficiary_user_id: members[0], participation: 'participating', choice_kind: 'household',
    confirmed: true, portion_amount: 1.5, expected_revision: 0,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(database.prepare('SELECT planned_portions,portions FROM meals WHERE id=?').get(mealId), {
    planned_portions: 1.5, portions: 2,
  });
});
