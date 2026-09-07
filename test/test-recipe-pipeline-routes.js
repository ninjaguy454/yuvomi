import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'pipeline-route-test';
const dbmod = await import('../server/db.js');
const { default: recipesRouter } = await import('../server/routes/recipes.js');
const { validatePipeline } = await import('../public/utils/recipe-pipeline.js');
const db = dbmod.get();
const owner = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('pipeline-owner','Owner','x','member')").run().lastInsertRowid);
const other = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('pipeline-admin','Other','x','admin')").run().lastInsertRowid);
let actor = owner;
let sessionModuleAccess = null;
let authMethod = 'session';
let authScopes = null;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  req.authUserId = actor; req.session = { userId: actor };
  req.sessionModuleAccess = sessionModuleAccess; req.authMethod = authMethod; req.authScopes = authScopes;
  next();
});
app.use('/recipes', recipesRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/recipes`;
test.after(() => server.close());
test.afterEach(() => { actor = owner; sessionModuleAccess = null; authMethod = 'session'; authScopes = null; });

async function call(method, path = '', body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, ...(response.status === 204 ? null : await response.json()) };
}

async function recipe(overrides = {}) {
  const created = await call('POST', '', {
    title: 'Banana bread', notes: 'Mash bananas. Whisk flour. Combine. Preheat the oven. Bake for 55 minutes.',
    ingredients: [{ name: 'bananas', quantity: '2' }, { name: 'flour', quantity: '1⅓ cups' }],
    ...overrides,
  });
  assert.equal(created.status, 201);
  return created.data;
}

function graph() {
  return validatePipeline({
    schema_version: 1,
    resources: [
      { id: 'bananas', kind: 'ingredient', name: 'bananas', quantity: '2', source_index: 0 },
      { id: 'flour', kind: 'ingredient', name: 'flour', quantity: '1⅓ cups', source_index: 1 },
      { id: 'mashed', kind: 'component', name: 'Mashed bananas' },
      { id: 'dry', kind: 'component', name: 'Whisked flour' },
      { id: 'batter', kind: 'component', name: 'Batter' },
      { id: 'oven-hot', kind: 'readiness', name: 'Preheated oven' },
      { id: 'bread', kind: 'component', name: 'Baked bread' },
    ],
    operations: [
      { id: 'mash', label: 'Mash bananas', consumes: ['bananas'], produces: ['mashed'], equipment: ['bowl'], duration: { min_seconds: 180, max_seconds: 180 } },
      { id: 'whisk', label: 'Whisk flour', consumes: ['flour'], produces: ['dry'] },
      { id: 'combine', label: 'Fold together', consumes: ['mashed', 'dry'], produces: ['batter'] },
      { id: 'preheat', label: 'Preheat oven', produces: ['oven-hot'], equipment: ['oven'], temperature: { value: 350, unit: 'F' } },
      { id: 'bake', label: 'Bake bread', consumes: ['batter'], requires: ['oven-hot'], produces: ['bread'], duration: { min_seconds: 3300, max_seconds: 3600 } },
    ],
  });
}
const saveBody = (r, pipeline = graph()) => ({ pipeline, expected_revision: r.pipeline_revision, source_hash: r.pipeline_current_source_hash });
const row = id => db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
const ingredients = id => db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id').all(id);

test('native recipe loads without a pipeline and exposes effective editor access and source identity', async () => {
  const created = await recipe();
  assert.equal(created.pipeline, null);
  assert.equal(created.pipeline_revision, 0);
  assert.equal(created.pipeline_source_hash, null);
  assert.match(created.pipeline_current_source_hash, /^[a-f0-9]{64}$/);
  assert.equal(created.pipeline_review_needed, false);
  assert.equal(created.pipeline_invalid, false);
  assert.equal(created.pipeline_can_edit, true);
  assert.equal('execution_json' in created, false);
  assert.equal('execution_revision' in created, false);
  assert.equal('execution_source_hash' in created, false);
  const fetched = await call('GET', `/${created.id}`);
  assert.equal(fetched.data.pipeline_current_source_hash, created.pipeline_current_source_hash);
  actor = other;
  assert.equal((await call('GET')).data.find(item => item.id === created.id).pipeline_can_edit, false);
});

test('saved resource graph persists on GET/list without changing written content or ingredients', async () => {
  const created = await recipe();
  const before = row(created.id);
  const beforeIngredients = ingredients(created.id);
  const saved = await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.pipeline, graph());
  assert.equal(saved.data.pipeline_revision, 1);
  assert.equal(saved.data.pipeline_source_hash, created.pipeline_current_source_hash);
  assert.equal(saved.data.pipeline_review_needed, false);
  for (const key of ['title', 'notes', 'recipe_url', 'meal_types', 'created_by', 'provider_account_id']) assert.equal(row(created.id)[key], before[key]);
  assert.deepEqual(ingredients(created.id), beforeIngredients);
  assert.deepEqual(JSON.parse(row(created.id).execution_json), graph());
  assert.deepEqual((await call('GET', `/${created.id}`)).data.pipeline, graph());
  assert.deepEqual((await call('GET')).data.find(item => item.id === created.id).pipeline, graph());
});

test('administrator cannot edit another creator’s pipeline, but may duplicate the readable recipe', async () => {
  const created = await recipe();
  actor = other;
  assert.equal((await call('PUT', `/${created.id}/pipeline`, saveBody(created))).status, 403);
  assert.equal(row(created.id).execution_revision, 0);
  const duplicate = await call('POST', `/${created.id}/duplicate`, {});
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.data.created_by, other);
  assert.equal(duplicate.data.pipeline_can_edit, true);
});

test('read-only/denied Meals sessions and read-only/unrelated API scopes cannot edit or duplicate', async () => {
  const created = await recipe();
  for (const level of ['read', 'none']) {
    sessionModuleAccess = { meals: level };
    assert.equal((await call('GET', `/${created.id}`)).data.pipeline_can_edit, false);
    assert.equal((await call('PUT', `/${created.id}/pipeline`, saveBody(created))).status, 403);
    assert.equal((await call('POST', `/${created.id}/duplicate`, {})).status, 403);
  }
  sessionModuleAccess = null;
  authMethod = 'api_token';
  for (const scopes of [['meals:read'], ['tasks:write'], []]) {
    authScopes = scopes;
    assert.equal((await call('GET', `/${created.id}`)).data.pipeline_can_edit, false);
    assert.equal((await call('PUT', `/${created.id}/pipeline`, saveBody(created))).status, 403);
    assert.equal((await call('POST', `/${created.id}/duplicate`, {})).status, 403);
  }
  authScopes = ['meals:write'];
  assert.equal((await call('GET', `/${created.id}`)).data.pipeline_can_edit, true);
  assert.equal((await call('PUT', `/${created.id}/pipeline`, saveBody(created))).status, 200);
});

test('competing saves accept one revision and reject the stale writer without overwriting it', async () => {
  const created = await recipe();
  const [first, second] = await Promise.all([
    call('PUT', `/${created.id}/pipeline`, saveBody(created)),
    call('PUT', `/${created.id}/pipeline`, saveBody(created)),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(row(created.id).execution_revision, 1);
  assert.deepEqual((await call('GET', `/${created.id}`)).data.pipeline, graph());
});

test('recipe edits preserve authored graph, show review needed, and reject a stale source hash', async () => {
  const created = await recipe();
  const saved = await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  const changed = await call('PUT', `/${created.id}`, {
    title: created.title, notes: 'Mash bananas. Mix with flour. Bake for 65 minutes.',
    ingredients: [{ name: 'bananas', quantity: '3' }, { name: 'flour', quantity: '2 cups' }],
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data.pipeline, graph());
  assert.equal(changed.data.pipeline_revision, 1);
  assert.equal(changed.data.pipeline_review_needed, true);
  assert.equal(changed.data.pipeline_source_hash, created.pipeline_current_source_hash);
  assert.notEqual(changed.data.pipeline_current_source_hash, created.pipeline_current_source_hash);
  const conflict = await call('PUT', `/${created.id}/pipeline`, saveBody(saved.data));
  assert.equal(conflict.status, 409);
  assert.match(conflict.error, /ingredients or instructions changed/);
  assert.equal((await call('PUT', `/${created.id}/pipeline`, saveBody(changed.data))).status, 400, 'a current source hash alone cannot accept obsolete ingredient quantities');
  const relinked = graph();
  for (const resource of relinked.resources.filter(item => item.kind === 'ingredient')) {
    resource.name = changed.data.ingredients[resource.source_index].name;
    resource.quantity = changed.data.ingredients[resource.source_index].quantity;
  }
  const reviewed = await call('PUT', `/${created.id}/pipeline`, saveBody(changed.data, relinked));
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.pipeline_revision, 2);
  assert.equal(reviewed.data.pipeline_review_needed, false);
  assert.deepEqual(reviewed.data.pipeline.resources.map(resource => resource.id), saved.data.pipeline.resources.map(resource => resource.id));
});

test('renaming and replacing SQL ingredient IDs with unchanged contents keep resource references and source identity', async () => {
  const created = await recipe();
  await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  const edited = await call('PUT', `/${created.id}`, {
    title: 'Renamed banana bread', notes: created.notes, ingredients: created.ingredients,
  });
  assert.notEqual(edited.data.ingredients[0].id, created.ingredients[0].id);
  assert.equal(edited.data.pipeline_review_needed, false);
  assert.equal(edited.data.pipeline_current_source_hash, created.pipeline_current_source_hash);
  assert.deepEqual(edited.data.pipeline, graph());
});

test('first save requires explicit well-formed revision and source identity', async () => {
  const created = await recipe();
  for (const overrides of [
    { expected_revision: undefined }, { expected_revision: '0' }, { expected_revision: -1 },
    { source_hash: undefined }, { source_hash: 'invented' },
  ]) {
    assert.equal((await call('PUT', `/${created.id}/pipeline`, { ...saveBody(created), ...overrides })).status, 400);
  }
  assert.equal((await call('PUT', `/${created.id}/pipeline`, { ...saveBody(created), source_hash: '0'.repeat(64) })).status, 409);
  assert.equal(row(created.id).execution_revision, 0);
});

test('ingredient bindings reject missing, out-of-range, duplicate and mismatched snapshots without changing saved data', async () => {
  const created = await recipe();
  const saved = await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  const variants = [];
  let invalid = graph(); invalid.resources[0].source_index = null; variants.push(invalid);
  invalid = graph(); delete invalid.resources[0].source_index; variants.push(invalid);
  invalid = graph(); invalid.resources[0].source_index = created.ingredients.length; variants.push(invalid);
  invalid = graph(); invalid.resources[1].source_index = invalid.resources[0].source_index; variants.push(invalid);
  invalid = graph(); invalid.resources[0].name = 'Extra bananas'; variants.push(invalid);
  invalid = graph(); invalid.resources[0].quantity = '20'; variants.push(invalid);
  invalid = graph(); invalid.resources.push({ id: 'more-bananas', kind: 'ingredient', name: 'bananas', quantity: '2', source_index: null }); variants.push(invalid);
  for (const pipeline of variants) {
    const rejected = await call('PUT', `/${created.id}/pipeline`, saveBody(saved.data, pipeline));
    assert.equal(rejected.status, 400);
  }
  assert.equal(row(created.id).execution_revision, 1);
  assert.deepEqual((await call('GET', `/${created.id}`)).data.pipeline, graph());
});

test('binding matching uses the same whitespace normalization as the recipe source hash', async () => {
  const created = await recipe({ ingredients: [{ name: '  ripe   bananas  ', quantity: '  2   large  ' }, { name: 'flour', quantity: '1⅓ cups' }] });
  const pipeline = graph();
  pipeline.resources[0].name = 'ripe bananas';
  pipeline.resources[0].quantity = '2 large';
  const saved = await call('PUT', `/${created.id}/pipeline`, saveBody(created, pipeline));
  assert.equal(saved.status, 200);
  assert.equal(saved.data.pipeline_review_needed, false);
});

test('reordering or renaming ingredients requires explicit relinking while preserving operation and resource IDs', async () => {
  const created = await recipe();
  await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  const reordered = await call('PUT', `/${created.id}`, { title: created.title, notes: created.notes,
    ingredients: [{ name: 'bread flour', quantity: '1⅓ cups' }, { name: 'bananas', quantity: '2' }],
  });
  assert.equal(reordered.data.pipeline_review_needed, true);
  assert.equal((await call('PUT', `/${created.id}/pipeline`, saveBody(reordered.data))).status, 400);
  const relinked = graph();
  relinked.resources[0].source_index = 1;
  relinked.resources[1].source_index = 0;
  relinked.resources[1].name = 'bread flour';
  const saved = await call('PUT', `/${created.id}/pipeline`, saveBody(reordered.data, relinked));
  assert.equal(saved.status, 200);
  assert.equal(saved.data.pipeline_review_needed, false);
  assert.deepEqual(saved.data.pipeline.operations, graph().operations);
  assert.deepEqual(saved.data.pipeline.resources.map(resource => resource.id), graph().resources.map(resource => resource.id));
});

test('invalid resource flows cannot replace saved data', async () => {
  const created = await recipe();
  const saved = await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  const variants = [];
  let invalid = graph(); invalid.operations[0].consumes = ['bread']; variants.push(invalid); // cycle
  invalid = graph(); invalid.operations[0].consumes = ['missing']; variants.push(invalid);
  invalid = graph(); invalid.operations[1].produces = ['mashed']; variants.push(invalid); // two producers
  invalid = graph(); invalid.operations[1].consumes = ['bananas']; variants.push(invalid); // double consumption
  invalid = graph(); invalid.operations[0].duration.min_seconds = -3; variants.push(invalid);
  invalid = graph(); invalid.operations[1].id = 'mash'; variants.push(invalid);
  invalid = graph(); invalid.operations = []; variants.push(invalid);
  invalid = graph(); invalid.operations[0].depends_on = ['preheat']; variants.push(invalid); // no parallel graph representation
  for (const pipeline of variants) {
    const rejected = await call('PUT', `/${created.id}/pipeline`, saveBody(saved.data, pipeline));
    assert.equal(rejected.status, 400);
    assert.ok(rejected.error);
  }
  assert.deepEqual((await call('GET', `/${created.id}`)).data.pipeline, graph());
  assert.equal(row(created.id).execution_revision, 1);
});

test('new endpoints reject malformed and missing recipe IDs', async () => {
  for (const id of ['0', '-1', '1junk', '1.5']) {
    assert.equal((await call('GET', `/${id}`)).status, 400);
    assert.equal((await call('PUT', `/${id}/pipeline`, {})).status, 400);
    assert.equal((await call('POST', `/${id}/duplicate`, {})).status, 400);
  }
  assert.equal((await call('GET', '/9999999')).status, 404);
  assert.equal((await call('PUT', '/9999999/pipeline', {})).status, 404);
  assert.equal((await call('POST', '/9999999/duplicate', {})).status, 404);
});

test('duplicate atomically preserves written content, meal types and resource graph with a fresh local revision', async () => {
  const created = await recipe({ meal_types: ['breakfast', 'snack'], recipe_url: 'https://example.test/bread' });
  const saved = await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  const changedGraph = graph(); changedGraph.operations[0].label = 'Mash thoroughly';
  const updated = await call('PUT', `/${created.id}/pipeline`, saveBody(saved.data, changedGraph));
  actor = other;
  const copied = await call('POST', `/${created.id}/duplicate`, { title: 'My breakfast bread' });
  assert.equal(copied.status, 201);
  assert.notEqual(copied.data.id, created.id);
  assert.equal(copied.data.title, 'My breakfast bread');
  assert.equal(copied.data.created_by, other);
  assert.equal(copied.data.source, 'native');
  assert.equal(copied.data.provider_account_id, null);
  assert.equal(copied.data.notes, created.notes);
  assert.equal(copied.data.recipe_url, created.recipe_url);
  assert.deepEqual(copied.data.meal_types, ['breakfast', 'snack']);
  assert.deepEqual(copied.data.ingredients.map(({ name, quantity, category }) => ({ name, quantity, category })), created.ingredients.map(({ name, quantity, category }) => ({ name, quantity, category })));
  assert.deepEqual(copied.data.pipeline, updated.data.pipeline);
  assert.equal(copied.data.pipeline_revision, 1);
  assert.equal(updated.data.pipeline_revision, 2);
  assert.equal(copied.data.pipeline_source_hash, updated.data.pipeline_source_hash);
  assert.equal(copied.data.pipeline_review_needed, false);
  assert.equal(copied.data.pipeline_can_edit, true);
});

test('duplicate never marks an out-of-date graph fresh and preserves intentionally empty meal types', async () => {
  const created = await recipe({ meal_types: [] });
  await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  await call('PUT', `/${created.id}`, { title: created.title, notes: 'Different cooking instructions.',
    ingredients: [{ name: 'flour', quantity: '2 cups' }, { name: 'bananas', quantity: '3' }],
  });
  const copied = await call('POST', `/${created.id}/duplicate`, {});
  assert.equal(copied.status, 201);
  assert.deepEqual(copied.data.meal_types, []);
  assert.deepEqual(copied.data.pipeline, graph());
  assert.equal(copied.data.pipeline_source_hash, created.pipeline_current_source_hash);
  assert.equal(copied.data.pipeline_review_needed, true);
});

test('invalid stored execution data is isolated on reads and cannot create a partial duplicate', async () => {
  const created = await recipe();
  db.prepare('UPDATE recipes SET execution_json = ?, execution_revision = 1 WHERE id = ?').run('{invalid', created.id);
  const loaded = await call('GET', `/${created.id}`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.data.pipeline, null);
  assert.equal(loaded.data.pipeline_invalid, true);
  assert.equal((await call('GET')).status, 200);
  const beforeRecipes = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  const beforeIngredients = db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients').get().n;
  assert.equal((await call('POST', `/${created.id}/duplicate`, {})).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n, beforeRecipes);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients').get().n, beforeIngredients);
});

test('duplicate rolls back its recipe and graph when copying an ingredient fails', async () => {
  const created = await recipe();
  await call('PUT', `/${created.id}/pipeline`, saveBody(created));
  const beforeRecipes = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  const beforeIngredients = db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients').get().n;
  db.exec("CREATE TRIGGER fail_pipeline_duplicate BEFORE INSERT ON recipe_ingredients WHEN NEW.name = 'flour' BEGIN SELECT RAISE(ABORT, 'synthetic ingredient failure'); END");
  try {
    assert.equal((await call('POST', `/${created.id}/duplicate`, {})).status, 500);
  } finally { db.exec('DROP TRIGGER fail_pipeline_duplicate'); }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n, beforeRecipes);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipe_ingredients').get().n, beforeIngredients);
});

for (const provider of ['mealie', 'tandoor']) {
  test(`${provider}: mirrored recipe remains read-only; duplicating it creates an editable native recipe`, async () => {
    const accountId = db.prepare(`INSERT INTO recipe_provider_accounts (name, base_url, api_token, provider, created_by)
      VALUES (?, ?, 'test-token', ?, ?)`).run(`Pipeline ${provider}`, `https://${provider}.pipeline.example.test`, provider, owner).lastInsertRowid;
    const id = db.prepare(`INSERT INTO recipes (title, notes, meal_types, created_by, provider_account_id, provider_recipe_id)
      VALUES ('Mirrored bread', 'Mix and bake.', 'breakfast', ?, ?, 'bread')`).run(owner, accountId).lastInsertRowid;
    db.prepare("INSERT INTO recipe_ingredients (recipe_id, name, quantity) VALUES (?, 'flour', '2 cups')").run(id);
    const imported = (await call('GET', `/${id}`)).data;
    assert.equal(imported.pipeline_can_edit, false);
    assert.equal(imported.source, provider);
    assert.equal((await call('PUT', `/${id}/pipeline`, saveBody(imported))).status, 403);
    assert.equal((await call('PUT', `/${id}`, { title: 'Overwrite provider' })).status, 403);
    assert.equal((await call('DELETE', `/${id}`)).status, 403);
    actor = other;
    const copied = await call('POST', `/${id}/duplicate`, {});
    assert.equal(copied.status, 201);
    assert.equal(copied.data.source, 'native');
    assert.equal(copied.data.provider_account_id, null);
    assert.equal(copied.data.created_by, other);
    assert.equal(copied.data.pipeline_can_edit, true);
    assert.equal(copied.data.pipeline, null);
    assert.equal(copied.data.pipeline_revision, 0);
    assert.deepEqual(copied.data.meal_types, ['breakfast']);
    const copiedGraph = validatePipeline({ schema_version: 1,
      resources: [{ id: 'flour', kind: 'ingredient', name: 'flour', quantity: '2 cups', source_index: 0 }, { id: 'bread', kind: 'component', name: 'Bread' }],
      operations: [{ id: 'make', label: 'Make bread', consumes: ['flour'], produces: ['bread'] }],
    });
    assert.equal((await call('PUT', `/${copied.data.id}/pipeline`, saveBody(copied.data, copiedGraph))).status, 200);
    assert.equal(row(id).execution_json, null);
  });
}
