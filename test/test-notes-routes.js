/**
 * Test: Notes-Routen (Härtung, Coverage-Track)
 * Zweck: End-to-End über den echten Notes-Router - härtet die bislang nur via
 *        db.prepare simulierte Route-Schicht ab (test-notes-contacts-budget.js baut
 *        die Handler nach, ruft sie nicht auf). Fokus: Validierung (400: Inhalt-
 *        Pflicht, HEX-Farbe), 404, CRUD, Pin-Toggle, Pinned-zuerst-Sortierung,
 *        Titel-Leerung. Notizen sind haushaltsweit → kein Auth-Gate-Teil.
 * Ausführen: node --experimental-sqlite --test test/test-notes-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const db = dbmod.get();

const U = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','Uli','x','member')`).run().lastInsertRowid;

let actor = { id: U, role: 'member' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/', notesRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

// --------------------------------------------------------------------------
// GET /
// --------------------------------------------------------------------------
test('GET /: anfangs leer', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

// --------------------------------------------------------------------------
// POST /
// --------------------------------------------------------------------------
test('POST /: fehlender Inhalt → 400', async () => {
  const r = await call('POST', '/', { title: 'X' });
  assert.equal(r.status, 400);
});

test('POST /: ungültige Farbe → 400', async () => {
  const r = await call('POST', '/', { content: 'Hallo', color: 'rot' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /HEX/);
});

test('POST /: legt Notiz an (Default-Farbe, created_by, creator_name-Join)', async () => {
  const r = await call('POST', '/', { content: 'Erste Notiz' });
  assert.equal(r.status, 201);
  const note = r.body.data;
  assert.equal(note.content, 'Erste Notiz');
  assert.equal(note.color, '#FFEB3B');
  assert.equal(note.pinned, 0);
  assert.equal(note.created_by, U);
  assert.equal(note.creator_name, 'Uli');
});

test('POST / mit pinned:true → pinned=1', async () => {
  const r = await call('POST', '/', { content: 'Wichtig', pinned: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.pinned, 1);
});

test('GET /: angepinnte Notizen zuerst', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 2);
  assert.equal(r.body.data[0].pinned, 1, 'pinned DESC → angepinnte oben');
});

// --------------------------------------------------------------------------
// PUT /:id
// --------------------------------------------------------------------------
test('PUT /:id: unbekannt → 404', async () => {
  const r = await call('PUT', '/999999', { content: 'X' });
  assert.equal(r.status, 404);
});

test('PUT /:id: ungültige Farbe → 400', async () => {
  const note = (await call('POST', '/', { content: 'Edit' })).body.data;
  const r = await call('PUT', `/${note.id}`, { color: 'blau' });
  assert.equal(r.status, 400);
});

test('PUT /:id: aktualisiert Inhalt/Titel/Farbe/pinned', async () => {
  const note = (await call('POST', '/', { content: 'Alt', title: 'T' })).body.data;
  const r = await call('PUT', `/${note.id}`, { content: 'Neu', title: 'T2', color: '#00FF00', pinned: true, expected_revision: note.revision });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.content, 'Neu');
  assert.equal(r.body.data.title, 'T2');
  assert.equal(r.body.data.color, '#00FF00');
  assert.equal(r.body.data.pinned, 1);
});

test('PUT /:id: leerer Titel → null', async () => {
  const note = (await call('POST', '/', { content: 'C', title: 'Hat Titel' })).body.data;
  const r = await call('PUT', `/${note.id}`, { title: '', expected_revision: note.revision });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.title, null);
});

// --------------------------------------------------------------------------
// PATCH /:id/pin
// --------------------------------------------------------------------------
test('PATCH /:id/pin: unbekannt → 404', async () => {
  const r = await call('PATCH', '/999999/pin');
  assert.equal(r.status, 404);
});

test('PATCH /:id/pin: toggelt 0 → 1 → 0', async () => {
  const note = (await call('POST', '/', { content: 'Toggle' })).body.data;
  const r1 = await call('PATCH', `/${note.id}/pin`);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.pinned, 1);
  const r2 = await call('PATCH', `/${note.id}/pin`);
  assert.equal(r2.body.data.pinned, 0);
  assert.equal(db.prepare('SELECT pinned FROM notes WHERE id = ?').get(note.id).pinned, 0);
});

// --------------------------------------------------------------------------
// DELETE /:id
// --------------------------------------------------------------------------
test('DELETE /:id: unbekannt → 404', async () => {
  const r = await call('DELETE', '/999999');
  assert.equal(r.status, 404);
});

test('DELETE /:id: löscht Notiz (204)', async () => {
  const note = (await call('POST', '/', { content: 'Weg' })).body.data;
  const r = await call('DELETE', `/${note.id}`);
  assert.equal(r.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notes WHERE id = ?').get(note.id).c, 0);
});

test.after(() => server.close());
