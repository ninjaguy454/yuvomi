import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'phase-five-test-session-secret-32-chars';
delete process.env.GOOGLE_PLACES_API_KEY;

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: planningRouter } = await import('../server/routes/planning.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const {
  _resetGooglePlacesLimitsForTests,
  GOOGLE_PLACES_FIELD_MASK,
  searchGooglePlaces,
} = await import('../server/services/google-places.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

function buildDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const migration of ALL_MIGRATIONS) {
    apply(database, migration);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const database = buildDb();
_setTestDatabase(database);
const admin = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('phase5admin', 'Phase 5 Admin', 'x', 'admin', 'parent')
`).run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/planning', planningRouter);
app.use('/api/v1/tasks', tasksRouter);

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

test('Phase 5 migration adds external Place identity without replacing Yuvomi identity', () => {
  assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE version = 10009').get());
  for (const table of ['task_locations', 'place_provider_usage']) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  const placeColumns = database.prepare('PRAGMA table_info(places)').all().map((row) => row.name);
  assert.ok(placeColumns.includes('external_provider'));
  assert.ok(placeColumns.includes('external_place_id'));
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_places_external_identity'").get());
});

test('Google Places degrades cleanly when it is not configured', async () => {
  const status = await call('GET', '/planning/place-search/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.data.configured, false);
  const origin = await call('POST', '/planning/admin/places', {
    name: 'Unconfigured search origin', type: 'home', latitude: 38.9, longitude: -77.04,
  });
  const unavailable = await call('POST', '/planning/place-search', {
    query: 'pharmacy', origin_place_id: origin.body.data.id,
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.reason, 'place_provider_not_configured');
});

test('Google Text Search uses a fixed minimal field mask, explicit origin, and ten-result cap', async () => {
  process.env.GOOGLE_PLACES_API_KEY = 'test-only-key';
  _resetGooglePlacesLimitsForTests();
  let request;
  const results = await searchGooglePlaces(database, {
    userId: admin,
    query: 'UPS Store',
    origin: { latitude: 38.9, longitude: -77.04 },
    now: new Date('2026-08-28T12:00:00Z'),
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return {
            places: Array.from({ length: 12 }, (_, index) => ({
              id: `google-place-${index}`,
              displayName: { text: `Result ${index}` },
              formattedAddress: `${index} Main Street`,
              location: { latitude: 38.9 + index / 1000, longitude: -77.04 },
              primaryType: 'store',
            })),
          };
        },
      };
    },
  });
  assert.equal(request.url, 'https://places.googleapis.com/v1/places:searchText');
  assert.equal(request.options.headers['X-Goog-FieldMask'], GOOGLE_PLACES_FIELD_MASK);
  assert.equal(request.body.pageSize, 10);
  assert.deepEqual(request.body.locationBias.circle.center, { latitude: 38.9, longitude: -77.04 });
  assert.equal(results.length, 10);
  assert.equal(results[0].external_place_id, 'google-place-0');
  assert.equal(database.prepare('SELECT SUM(request_count) AS n FROM place_provider_usage').get().n, 1);
});

test('Tasks support saved, one-use Google, and manual locations while Place rename stays stable', async () => {
  const home = await call('POST', '/planning/admin/places', {
    name: 'Home', type: 'home', street_address: '1 Household Way', latitude: 38.9, longitude: -77.04,
  });
  assert.equal(home.status, 201, JSON.stringify(home.body));

  const saved = await call('POST', '/tasks', {
    title: 'Drop off package',
    location: { kind: 'saved_place', place_id: home.body.data.id },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.data.location.label, 'Home');
  assert.equal(saved.body.data.location.place_id, home.body.data.id);

  const rename = await call('PUT', `/planning/admin/places/${home.body.data.id}`, { name: 'Our House' });
  assert.equal(rename.status, 200, JSON.stringify(rename.body));
  const detail = await call('GET', `/tasks/${saved.body.data.id}`);
  assert.equal(detail.body.data.location.label, 'Our House');
  assert.equal(detail.body.data.location.place_id, home.body.data.id);

  const google = await call('POST', '/tasks', {
    title: 'Visit the pharmacy',
    location: {
      kind: 'google_place', external_provider: 'google',
      external_place_id: 'ChIJ-one-use', user_label: 'Pickup pharmacy',
    },
  });
  assert.equal(google.status, 201, JSON.stringify(google.body));
  assert.equal(google.body.data.location.external_place_id, 'ChIJ-one-use');
  assert.match(google.body.data.location.navigation_url, /query_place_id=ChIJ-one-use/);
  assert.equal(database.prepare('SELECT manual_address FROM task_locations WHERE task_id = ?').get(google.body.data.id).manual_address, null);

  const manual = await call('PUT', `/tasks/${google.body.data.id}`, {
    location: { kind: 'manual', user_label: 'Side entrance', manual_address: '200 Market Street' },
  });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.data.location.kind, 'manual');
  assert.match(manual.body.data.location.navigation_url, /200%2C?\+?Market|200\+Market/);
});

test('an explicit admin save promotes a Google identity into reusable Yuvomi Places', async () => {
  const saved = await call('POST', '/planning/admin/places/from-google', {
    external_place_id: 'ChIJ-reusable',
    name: 'Package drop-off',
    type: 'store',
    street_address: 'User-confirmed address',
    latitude: 38.91,
    longitude: -77.05,
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.ok(saved.body.data.id, 'Yuvomi keeps its own immutable identity');
  assert.equal(saved.body.data.external_provider, 'google');
  assert.equal(saved.body.data.external_place_id, 'ChIJ-reusable');
  assert.equal(saved.body.data.coordinate_source, 'google');
  assert.ok(saved.body.data.coordinates_expires_at);

  const duplicate = await call('POST', '/planning/admin/places/from-google', {
    external_place_id: 'ChIJ-reusable', name: 'Duplicate', type: 'store',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.data.id, saved.body.data.id);
});
