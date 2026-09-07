import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mealPayloadFromRecipe } from '../public/utils/recipe-to-meal.js';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ??= 'meal-recipe-portions-route-test';
const { get } = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const database = get();
const actorId = Number(database.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
  VALUES ('recipe-portion-creator','Recipe creator','test','admin','other')`).run().lastInsertRowid);
const memberId = Number(database.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
  VALUES ('recipe-portion-diner','Diner','test','member','other')`).run().lastInsertRowid);
const listId = Number(database.prepare('INSERT INTO shopping_lists(name,created_by) VALUES (?,?)')
  .run('Recipe portion groceries', actorId).lastInsertRowid);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actorId;
  req.authRole = 'admin';
  req.session = { userId: actorId, role: 'admin' };
  next();
});
app.use('/', mealsRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); database.close(); });

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function recipe(yieldPortions = null) {
  const id = Number(database.prepare('INSERT INTO recipes(title,created_by,yield_portions) VALUES (?,?,?)')
    .run('Fish sticks', actorId, yieldPortions).lastInsertRowid);
  database.prepare(`INSERT INTO recipe_ingredients(recipe_id,name,quantity,category) VALUES (?,'Fish sticks','16 pcs','Frozen')`).run(id);
  return { id, title: 'Fish sticks', notes: null, recipe_url: null, yield_portions: yieldPortions,
    ingredients: [{ name: 'Fish sticks', quantity: '16 pcs', category: 'Frozen' }] };
}

function storedMeal(id) {
  return database.prepare('SELECT portions_mode,portions,planned_portions,ingredients_manual_override FROM meals WHERE id=?').get(id);
}
function quantities(id) {
  return database.prepare('SELECT quantity FROM meal_ingredients WHERE meal_id=? ORDER BY id').all(id).map((row) => row.quantity);
}

test('Recipe Book handoff sends explicit yields through server scaling and preserves legacy payloads', async () => {
  const explicit = mealPayloadFromRecipe(recipe(4), '2047-01-01', 'dinner');
  assert.equal(explicit.portions_mode, 'auto');
  assert.equal(explicit.ingredients_manual_override, false);
  assert.equal(Object.hasOwn(explicit, 'ingredients'), false);
  const created = await call('POST', '/', explicit);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(quantities(created.body.data.id), ['4 pcs']);
  assert.deepEqual(storedMeal(created.body.data.id), {
    portions_mode: 'auto', portions: 1, planned_portions: 0, ingredients_manual_override: 0,
  });

  const legacyRecipe = recipe();
  const legacy = mealPayloadFromRecipe(legacyRecipe, '2047-01-02', 'dinner');
  assert.deepEqual(legacy, { date: '2047-01-02', meal_type: 'dinner', title: legacyRecipe.title,
    notes: null, recipe_url: null, recipe_id: legacyRecipe.id, ingredients: legacyRecipe.ingredients });
  const savedLegacy = await call('POST', '/', legacy);
  assert.equal(savedLegacy.status, 201);
  assert.deepEqual(quantities(savedLegacy.body.data.id), ['16 pcs']);
});

test('apply-plan shares recipe scaling while preserving fixed/manual and nullable-yield snapshots', async () => {
  const explicit = mealPayloadFromRecipe(recipe(4), '2047-02-01', 'dinner');
  const legacy = mealPayloadFromRecipe(recipe(), '2047-02-02', 'dinner');
  const fixed = { ...explicit, date: '2047-02-03', portions_mode: 'fixed', portions: 9,
    ingredients_manual_override: true, ingredients: [{ name: 'Fish sticks', quantity: '99 pcs', category: 'Frozen' }] };
  const response = await call('POST', '/apply-plan', { assignments: [explicit, legacy, fixed] });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const [first, second, third] = response.body.data;
  assert.deepEqual(quantities(first.id), ['4 pcs']);
  assert.deepEqual(quantities(second.id), ['16 pcs']);
  assert.deepEqual(quantities(third.id), ['99 pcs']);
  assert.deepEqual(storedMeal(third.id), {
    portions_mode: 'fixed', portions: 9, planned_portions: 0, ingredients_manual_override: 1,
  });
  const before = database.prepare('SELECT COUNT(*) AS count FROM meals').get().count;
  const invalid = await call('POST', '/apply-plan', { assignments: [explicit, { ...fixed, portions: -1 }] });
  assert.equal(invalid.status, 400);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM meals').get().count, before, 'invalid batch creates no partial Meals');
});

test('legacy creation initializes the exact diner total without changing its saved ingredient or cook quantities', async () => {
  const payload = mealPayloadFromRecipe(recipe(), '2047-03-01', 'dinner');
  const response = await call('POST', '/', { ...payload, participants: [
    { user_id: actorId, role: 'participant', status: 'participating' },
    { user_id: actorId, role: 'cook', status: 'participating' },
    { user_id: memberId, role: 'participant', status: 'participating' },
  ] });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(storedMeal(response.body.data.id), {
    portions_mode: 'auto', portions: 1, planned_portions: 2, ingredients_manual_override: 0,
  });
  assert.deepEqual(quantities(response.body.data.id), ['16 pcs']);
});

test('switching a fixed Meal back to automatic uses requested portions and the recipe yield', async () => {
  const payload = mealPayloadFromRecipe(recipe(4), '2047-04-01', 'dinner');
  const response = await call('POST', '/', { ...payload, portions_mode: 'fixed', portions: 4,
    participants: [{ user_id: actorId, role: 'participant', status: 'participating' }] });
  assert.equal(response.status, 201);
  const mealId = response.body.data.id;
  database.prepare(`INSERT INTO meal_person_decisions(meal_id,beneficiary_user_id,participation,portion_amount,choice_kind,entered_by_user_id)
    VALUES (?,?,'participating',1.5,'household',?)`).run(mealId, actorId, actorId);
  const automatic = await call('PUT', `/${mealId}`, { portions_mode: 'auto', ingredients_manual_override: false });
  assert.equal(automatic.status, 200, JSON.stringify(automatic.body));
  assert.deepEqual(storedMeal(mealId), { portions_mode: 'auto', portions: 2, planned_portions: 1.5, ingredients_manual_override: 0 });
  assert.deepEqual(quantities(mealId), ['8 pcs']);
});

test('legacy Meal-to-Shopping fallback respects explicit recipe yield without rescaling unspecified legacy recipes', async () => {
  for (const [yieldPortions, expected] of [[4, '12 pcs'], [null, '16 pcs']]) {
    const source = recipe(yieldPortions);
    const mealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,recipe_id,created_by,portions_mode,portions)
      VALUES ('2047-05-01','dinner','Fish sticks',?,?,'fixed',3)`).run(source.id, actorId).lastInsertRowid);
    const response = await call('POST', `/${mealId}/to-shopping-list`, { listId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(quantities(mealId), [expected]);
    assert.equal(database.prepare('SELECT quantity FROM shopping_items WHERE added_from_meal=?').get(mealId).quantity, expected);
    const retry = await call('POST', `/${mealId}/to-shopping-list`, { listId });
    assert.equal(retry.body.data.transferred, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM shopping_items WHERE added_from_meal=?').get(mealId).count, 1);
  }
});
