/** Real-cookie identity regressions; only an encrypted, disposable household is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';

const folder = mkdtempSync(join(tmpdir(), 'notes-isolation-context-'));
process.env.DB_PATH = join(folder, 'synthetic.db');
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SESSION_SECRET = 'synthetic-layout-isolation-session';
process.env.SESSION_SECURE = 'false';
process.env.LOG_LEVEL = 'error';
process.env.AUTH_ALLOW_PASSWORD_LOGIN = 'true';
process.env.RATE_LIMIT_MAX_ATTEMPTS = '200';
process.env.BACKUP_ENABLED = 'false';

const { get } = await import('../server/db.js');
const { sessionMiddleware, router: authRouter, requireAuth } = await import('../server/auth.js');
const { deviceRouter, devicesRouter } = await import('../server/routes/devices.js');
const { deviceBoundary, deviceHash, DEVICE_COOKIE } = await import('../server/services/devices.js');
const { deviceAppMiddleware } = await import('../server/services/device-app.js');
const { hashPassword } = await import('../server/utils/password.js');
const { csrfMiddleware } = await import('../server/middleware/csrf.js');
const { default: notesRouter } = await import('../server/routes/notes.js');
const { default: wallRouter } = await import('../server/routes/wall.js');
const { default: idempotency } = await import('../server/middleware/idempotency.js');
const { createNoteGroupDraft, freezeNoteGroupCommand } = await import('../public/utils/note-group-draft.js');
const d = get(), password = 'SyntheticLayoutIsolationOnly2026!', hash = await hashPassword(password, 4);
for (const [id, name, role] of [[1, 'owner', 'admin'], [2, 'recipient', 'member'], [3, 'outsider', 'admin']]) {
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,?,?)').run(id, name, name, hash, role);
}

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json(), sessionMiddleware);
app.use((req, res, next) => deviceBoundary(d, req, res, next));
app.use('/api/v1/device', deviceRouter);
app.use('/api/v1/devices', devicesRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1', requireAuth, csrfMiddleware);
// Delay an authenticated request before its real adapter, retaining the installed
// database write lease. No principal, authorization result or service is mocked.
let held;
app.use('/api/v1/notes', async (req, _res, next) => {
  if (req.get('x-test-hold') === 'yes') { const gate = held; gate.entered(); await gate.wait; }
  next();
});
app.use('/api/v1', deviceAppMiddleware, idempotency);
app.use('/api/v1/notes', notesRouter);
app.use('/api/v1/wall', wallRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  d.close();
  rmSync(folder, { recursive: true, force: true });
});

let nextIp = 20, sequence = 0;
class Client {
  constructor(copy) {
    this.cookies = new Map(copy?.cookies); this.context = copy?.context; this.csrf = copy?.csrf;
    this.ip = copy?.ip || `192.0.2.${nextIp++}`;
  }
  async call(method, path, body, extra = {}) {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': this.ip,
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(this.context ? { 'x-auth-context': this.context } : {}),
      ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...extra };
    const response = await fetch(base + path, { method, headers, signal: AbortSignal.timeout(10000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of response.headers.getSetCookie()) {
      const part = cookie.split(';')[0], index = part.indexOf('=');
      this.cookies.set(part.slice(0, index), part.slice(index + 1));
    }
    const raw = await response.text(); let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    this.context = response.headers.get('x-auth-context') || value?.authContext || this.context;
    this.csrf = response.headers.get('x-csrf-token') || value?.csrfToken || this.cookies.get('csrf-token') || this.csrf;
    return { status: response.status, body: value, headers: response.headers };
  }
}
async function ok(client, method, path, body, status = 200, headers = {}) {
  const response = await client.call(method, path, body, headers);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
  return response;
}
async function login(username = 'owner') {
  const client = new Client();
  await ok(client, 'POST', '/api/v1/auth/login', { username, password });
  return client;
}
const admin = await login(), member = await login('recipient'), outsider = await login('outsider');
const board = async client => (await ok(client, 'GET', '/api/v1/notes/board')).body.data;
const note = (snapshot, id) => { const value = snapshot.notes.find(value => value.id === id); assert.ok(value, `missing note ${id}`); return value; };
const containing = (snapshot, id) => snapshot.groups.find(group => group.member_ids.includes(id));
const projection = (snapshot, ids) => ({
  notes: snapshot.notes.filter(n => ids.includes(n.id)).map(n => ({ id: n.id, layout: n.layout, arrange: n.permissions.arrange })).sort((a, b) => a.id - b.id),
  groups: snapshot.groups.filter(g => g.member_ids.some(id => ids.includes(id))).sort((a, b) => a.id - b.id),
});
async function createNotes(count = 2, audience = {}) {
  const result = [];
  for (let i = 0; i < count; i++) result.push((await ok(admin, 'POST', '/api/v1/notes', {
    title: `Isolation note ${++sequence}`, content: `Synthetic body ${sequence}`, ...audience,
  }, 201)).body.data.id);
  return result;
}
async function layout(client, id, changes) {
  const current = note(await board(client), id);
  return (await ok(client, 'PATCH', `/api/v1/notes/${id}/layout`, { expected_layout_revision: current.layout.revision, ...changes })).body.data;
}
async function command(client, kind, fields, operation = `context-operation-${++sequence}`) {
  return freezeNoteGroupCommand(createNoteGroupDraft(await board(client), operation), kind, fields);
}
async function execute(client, body) { return (await ok(client, 'POST', '/api/v1/notes/group-operations', body)).body.data; }
async function createGroup(client, [target, source]) {
  await layout(client, target, { position_locked: true });
  const body = await command(client, 'create', { source_note_id: source, target_note_id: target });
  const result = await execute(client, body);
  return { body, result, group: containing(result.board, target) };
}
const credential = display => d.prepare('SELECT * FROM device_credentials WHERE token_hash=?').get(deviceHash(display.cookies.get(DEVICE_COOKIE)));
async function permissions(display, id, grants) {
  await ok(admin, 'PATCH', `/api/v1/devices/${id}`, {
    revision: d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision,
    permissions: { capabilities: Object.fromEntries(Object.entries(grants).map(([key, value]) => [`device_notes.${key}`, value])) },
  });
  await ok(display, 'GET', '/api/v1/device/context');
}
async function pair(grants = { view: 'allow', edit: 'allow', create: 'none', delete: 'none' }) {
  const display = new Client(), code = await ok(display, 'POST', '/api/v1/device/pair', {});
  const approved = await ok(admin, 'POST', '/api/v1/devices/pairing-approve', { code: code.body.code, name: `Synthetic display ${nextIp}` }, 201);
  const id = approved.body.data.id;
  await ok(display, 'POST', '/api/v1/device/pair/claim', { confirm_transition: true });
  await ok(display, 'POST', '/api/v1/device/launch', {});
  await permissions(display, id, grants);
  return { display, id };
}
async function temporary(display) {
  await ok(display, 'POST', '/api/v1/device/temporary/begin', {});
  await ok(display, 'POST', '/api/v1/auth/login', { username: 'owner', password });
}
async function expire(display, reason = 'idle') {
  const row = credential(display);
  if (reason === 'idle') d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now() - 301000, row.id);
  else d.prepare('UPDATE device_credentials SET temporary_started_at=?,temporary_idle_at=? WHERE id=?').run(Date.now() - 901000, Date.now(), row.id);
}
async function delayRequest(client, method, path, body, invalidate) {
  let entered, release;
  const started = new Promise(resolve => entered = resolve), wait = new Promise(resolve => release = resolve);
  held = { entered, wait };
  const pending = new Client(client).call(method, path, body, { 'x-test-hold': 'yes' });
  try {
    await Promise.race([started, pending.then(response => { throw new Error(`request did not reach hold: ${JSON.stringify(response)}`); })]);
    await invalidate(); release(); return await pending;
  } finally { release(); held = null; }
}

test('two users and two paired displays independently save geometry, flags and revisions', async () => {
  const [id] = await createNotes(1), a = await pair(), b = await pair();
  const clients = [admin, member, a.display, b.display], initial = await Promise.all(clients.map(board));
  const sharedBefore = d.prepare('SELECT * FROM notes WHERE id=?').get(id);
  for (let index = 0; index < clients.length; index++) {
    const change = { expected_layout_revision: note(initial[index], id).layout.revision,
      layout: { x: index + 0.125, y: 30 + index * 11.25, width: 4 + index, height: 6 + index },
      position_locked: index % 2 === 0, always_on_top: index % 2 === 1 };
    await ok(clients[index], 'PATCH', `/api/v1/notes/${id}/layout`, change);
    for (let untouched = index + 1; untouched < clients.length; untouched++) {
      assert.deepEqual(note(await board(clients[untouched]), id).layout, note(initial[untouched], id).layout, 'another principal must retain its own unchanged layout');
    }
  }
  for (let index = 0; index < clients.length; index++) {
    const saved = note(await board(clients[index]), id).layout;
    assert.equal(saved.x, index + 0.125); assert.equal(saved.y, 30 + index * 11.25);
    assert.equal(saved.width, 4 + index); assert.equal(saved.height, 6 + index);
    assert.equal(saved.position_locked, index % 2 === 0); assert.equal(saved.always_on_top, index % 2 === 1);
  }
  const sameUser = await login();
  assert.deepEqual(note(await board(sameUser), id).layout, note(await board(admin), id).layout);
  assert.equal((await sameUser.call('PATCH', `/api/v1/notes/${id}/layout`, { expected_layout_revision: 0, always_on_top: true })).status, 409);
  assert.deepEqual(d.prepare('SELECT * FROM notes WHERE id=?').get(id), sharedBefore);
});

test('grouping and reordering the same notes leaves every other user and display structure unchanged', async () => {
  const ids = await createNotes(3), a = await pair(), b = await pair(), clients = [admin, member, a.display, b.display];
  const initial = await Promise.all(clients.map(board));
  const human = await createGroup(admin, ids);
  assert.deepEqual(human.group.member_ids, ids.slice(0, 2));
  for (let i = 1; i < clients.length; i++) assert.deepEqual(projection(await board(clients[i]), ids), projection(initial[i], ids));
  const recipient = await createGroup(member, [ids[1], ids[2]]);
  const displayA = await createGroup(a.display, [ids[0], ids[2]]);
  const displayB = await createGroup(b.display, [ids[2], ids[1]]);
  const snapshots = await Promise.all(clients.map(board));
  const reordered = await execute(a.display, await command(a.display, 'reorder', { group_id: displayA.group.id, selected_ids: [ids[2]], before_note_id: ids[0] }));
  assert.deepEqual(containing(reordered.board, ids[0]).member_ids, [ids[2], ids[0]]);
  for (const index of [0, 1, 3]) assert.deepEqual(projection(await board(clients[index]), ids), projection(snapshots[index], ids));
  assert.deepEqual(containing(await board(member), ids[1]).member_ids, recipient.group.member_ids);
  assert.deepEqual(containing(await board(b.display), ids[1]).member_ids, displayB.group.member_ids);
});

test('temporary paired login shares the human board and returning restores the display board', async () => {
  const ids = await createNotes(3), { display } = await pair();
  await createGroup(admin, [ids[0], ids[1]]); await createGroup(display, [ids[0], ids[2]]);
  const displayBefore = projection(await board(display), ids);
  await temporary(display);
  assert.deepEqual(projection(await board(display), ids), projection(await board(admin), ids));
  const group = containing(await board(display), ids[0]);
  await execute(display, await command(display, 'reorder', { group_id: group.id, selected_ids: [ids[1]], before_note_id: ids[0] }));
  const personal = projection(await board(admin), ids); assert.deepEqual(projection(await board(display), ids), personal);
  const stale = new Client(display);
  await ok(display, 'POST', '/api/v1/device/return', {});
  assert.deepEqual(projection(await board(display), ids), displayBefore);
  assert.equal((await stale.call('GET', '/api/v1/notes/board')).status, 409);
  assert.deepEqual(projection(await board(admin), ids), personal);
});

test('idle and absolute temporary expiry restore the same device layout without changing the personal layout', async () => {
  for (const reason of ['idle', 'absolute']) {
    const [id] = await createNotes(1), { display } = await pair();
    await layout(admin, id, { layout: { x: 0.25, y: 80, width: 5, height: 7 } });
    await layout(display, id, { layout: { x: 3.75, y: 90, width: 6, height: 8 } });
    const deviceBefore = note(await board(display), id).layout, personalBefore = note(await board(admin), id).layout;
    assert.equal(deviceBefore.x, 3.75); assert.equal(personalBefore.x, 0.25);
    await temporary(display); assert.deepEqual(note(await board(display), id).layout, personalBefore);
    const staleBody = { expected_layout_revision: personalBefore.revision, always_on_top: true };
    await expire(display, reason);
    assert.equal((await display.call('PATCH', `/api/v1/notes/${id}/layout`, staleBody)).status, 409);
    await ok(display, 'GET', '/api/v1/device/context');
    assert.deepEqual(note(await board(display), id).layout, deviceBefore);
    assert.deepEqual(note(await board(admin), id).layout, personalBefore);
  }
});

test('credential replacement and permission context rotation retain the household device board', async () => {
  const ids = await createNotes(), { display, id } = await pair();
  const made = await createGroup(display, ids), before = projection(await board(display), ids), previous = credential(display);
  await permissions(display, id, { view: 'allow', edit: 'allow', create: 'allow' });
  assert.notEqual(credential(display).context_key, previous.context_key);
  assert.deepEqual(projection(await board(display), ids), before);
  const token = randomBytes(32).toString('hex'), context = randomBytes(32).toString('hex');
  d.prepare('UPDATE device_credentials SET revoked_at=? WHERE id=?').run(new Date().toISOString(), previous.id);
  d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(id, deviceHash(token), context);
  const replacement = new Client(); replacement.cookies.set(DEVICE_COOKIE, token);
  await ok(replacement, 'POST', '/api/v1/device/launch', {});
  assert.notEqual(credential(replacement).id, previous.id);
  assert.deepEqual(projection(await board(replacement), ids), before);
  const oldUndo = await command(replacement, 'undo', { undo_operation_id: made.body.operation_id });
  assert.equal((await replacement.call('POST', '/api/v1/notes/group-operations', oldUndo)).status, 404);
  assert.deepEqual(projection(await board(replacement), ids), before);
});

for (const invalidation of ['return', 'expiry', 'revoke']) for (const kind of ['layout', 'group']) {
  test(`held temporary ${kind} writes fail after ${invalidation}`, async () => {
    const ids = await createNotes(), { display, id } = await pair();
    await layout(display, ids[0], { layout: { x: 2.5, y: 120, width: 5, height: 8 } });
    const deviceBefore = projection(await board(display), ids);
    await temporary(display);
    let method, path, body;
    if (kind === 'group') {
      const made = await createGroup(display, ids);
      method = 'POST'; path = '/api/v1/notes/group-operations';
      body = await command(display, 'reorder', { group_id: made.group.id, selected_ids: [ids[1]], before_note_id: ids[0] });
    } else {
      method = 'PATCH'; path = `/api/v1/notes/${ids[0]}/layout`;
      body = { expected_layout_revision: note(await board(display), ids[0]).layout.revision, always_on_top: true };
    }
    const humanBefore = projection(await board(admin), ids);
    const response = await delayRequest(display, method, path, body, async () => {
      if (invalidation === 'return') await ok(display, 'POST', '/api/v1/device/return', {});
      if (invalidation === 'expiry') await expire(display);
      if (invalidation === 'revoke') await ok(admin, 'POST', `/api/v1/devices/${id}/revoke`, { revision: d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision });
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.deepEqual(projection(await board(admin), ids), humanBefore);
    if (invalidation !== 'revoke') {
      await ok(display, 'GET', '/api/v1/device/context');
      assert.deepEqual(projection(await board(display), ids), deviceBefore);
    }
  });
}

for (const invalidation of ['permission', 'revoke', 'temporary']) {
  test(`held anonymous device group writes fail after ${invalidation}`, async () => {
    const ids = await createNotes(), { display, id } = await pair(), made = await createGroup(display, ids);
    const before = projection(await board(display), ids);
    const body = await command(display, 'reorder', { group_id: made.group.id, selected_ids: [ids[1]], before_note_id: ids[0] });
    const response = await delayRequest(display, 'POST', '/api/v1/notes/group-operations', body, async () => {
      if (invalidation === 'permission') await permissions(display, id, { view: 'allow', edit: 'none' });
      if (invalidation === 'revoke') await ok(admin, 'POST', `/api/v1/devices/${id}/revoke`, { revision: d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision });
      if (invalidation === 'temporary') await temporary(display);
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    if (invalidation === 'permission') await permissions(display, id, { view: 'allow', edit: 'allow' });
    if (invalidation === 'temporary') await ok(display, 'POST', '/api/v1/device/return', {});
    if (invalidation !== 'revoke') assert.deepEqual(projection(await board(display), ids), before);
  });
}

test('temporary receipts cannot be retried or undone after return or on a fresh temporary sign-in', async () => {
  const ids = await createNotes(), { display } = await pair();
  const displayBefore = projection(await board(display), ids);
  await temporary(display); const made = await createGroup(display, ids), old = new Client(display);
  const undo = await command(display, 'undo', { undo_operation_id: made.body.operation_id });
  await ok(display, 'POST', '/api/v1/device/return', {});
  for (const body of [made.body, undo]) assert.equal((await old.call('POST', '/api/v1/notes/group-operations', body)).status, 409);
  assert.equal((await display.call('POST', '/api/v1/notes/group-operations', undo)).status, 404);
  assert.deepEqual(projection(await board(display), ids), displayBefore);
  await temporary(display);
  const before = projection(await board(display), ids);
  assert.equal((await display.call('POST', '/api/v1/notes/group-operations', made.body)).status, 409);
  assert.equal((await display.call('POST', '/api/v1/notes/group-operations', undo)).status, 404);
  assert.deepEqual(projection(await board(admin), ids), before);
});

test('forged query, header and body selectors cannot select another layout owner', async () => {
  const ids = await createNotes(), { display, id } = await pair();
  await layout(admin, ids[0], { layout: { x: 0.5, y: 150, width: 5, height: 7 } });
  await layout(display, ids[0], { layout: { x: 4.5, y: 180, width: 6, height: 8 } });
  const humanBefore = projection(await board(admin), ids), deviceBefore = projection(await board(display), ids);
  const query = `?owner_key=human%3A1&layout_owner=human%3A1&scope=human%3A1&user_id=1&device_id=${id}`;
  const headers = { 'X-Note-Layout-Owner': 'human:1', 'X-Layout-Owner': 'human:1', 'X-Owner-Key': 'human:1' };
  const forgedRead = await ok(display, 'GET', '/api/v1/notes/board' + query, undefined, 200, headers);
  assert.deepEqual(projection(forgedRead.body.data, ids), deviceBefore);
  for (const field of ['owner_key', 'layout_owner', 'scope', 'user_id', 'device_id']) {
    const response = await display.call('PATCH', `/api/v1/notes/${ids[0]}/layout`, {
      expected_layout_revision: note(await board(display), ids[0]).layout.revision, always_on_top: true, [field]: field.endsWith('_id') ? 1 : 'human:1',
    });
    assert.equal(response.status, 400, field);
  }
  await ok(display, 'PATCH', `/api/v1/notes/${ids[0]}/layout` + query, {
    expected_layout_revision: note(await board(display), ids[0]).layout.revision, always_on_top: true,
  }, 200, headers);
  assert.equal(note(await board(display), ids[0]).layout.always_on_top, true);
  assert.deepEqual(projection(await board(admin), ids), humanBefore);
  await layout(display, ids[0], { position_locked: true });
  const create = await command(display, 'create', { source_note_id: ids[1], target_note_id: ids[0] });
  for (const field of ['owner_key', 'layout_owner', 'scope']) assert.equal((await display.call('POST', '/api/v1/notes/group-operations', { ...create, [field]: 'human:1' })).status, 400);
  await ok(display, 'POST', '/api/v1/notes/group-operations' + query, create, 200, headers);
  assert.deepEqual(projection(await board(admin), ids), humanBefore);
});

test('foreign group and receipt identifiers do not disclose or mutate another owner', async () => {
  const ids = await createNotes(), stranger = await login('outsider'), made = await createGroup(admin, ids);
  const humanBefore = projection(await board(admin), ids), otherBefore = projection(await board(stranger), ids);
  const errors = [];
  for (const groupId of [made.group.id, 999999]) {
    const response = await stranger.call('POST', '/api/v1/notes/group-operations', {
      operation_id: `foreign-group-${++sequence}`, kind: 'reorder', expected: { groups: [], notes: [] },
      group_id: groupId, selected_ids: [ids[1]], before_note_id: null,
    });
    assert.equal(response.status, 404); errors.push(response.body);
  }
  assert.deepEqual(errors[0], errors[1]);
  const undo = await command(stranger, 'undo', { undo_operation_id: made.body.operation_id });
  assert.equal((await stranger.call('POST', '/api/v1/notes/group-operations', undo)).status, 404);
  assert.deepEqual(projection(await board(admin), ids), humanBefore);
  assert.deepEqual(projection(await board(stranger), ids), otherBefore);
});

test('personal isolation preserves Private and Selected audiences and device granular grants', async () => {
  const [publicId] = await createNotes(1), [privateId] = await createNotes(1, { visibility: 'private' });
  const [selectedId] = await createNotes(1, { visibility: 'selected', access_user_ids: [2] });
  const { display, id } = await pair(), ids = [publicId, privateId, selectedId];
  const visible = async client => (await board(client)).notes.filter(n => ids.includes(n.id)).map(n => n.id).sort((a, b) => a - b);
  assert.deepEqual(await visible(admin), ids); assert.deepEqual(await visible(member), [publicId, selectedId]);
  assert.deepEqual(await visible(outsider), [publicId]); assert.deepEqual(await visible(display), [publicId]);
  for (const hidden of [privateId, selectedId]) {
    assert.equal((await display.call('GET', `/api/v1/notes/${hidden}`)).status, 404);
    assert.equal((await display.call('PATCH', `/api/v1/notes/${hidden}/layout`, { expected_layout_revision: 0, position_locked: true })).status, 404);
  }
  const sharedBefore = d.prepare('SELECT * FROM notes WHERE id=?').get(publicId);
  await layout(display, publicId, { always_on_top: true });
  assert.equal((await display.call('POST', '/api/v1/notes', { content: 'create not granted' })).status, 403);
  assert.equal((await display.call('DELETE', `/api/v1/notes/${publicId}`)).status, 403);
  for (const grants of [{ view: 'allow', edit: 'none', create: 'none' }, { view: 'none', edit: 'allow', create: 'none' }, { view: 'none', edit: 'none', create: 'allow' }]) {
    await permissions(display, id, grants);
    assert.equal((await display.call('PATCH', `/api/v1/notes/${publicId}/layout`, { expected_layout_revision: 0, position_locked: true })).status, 403);
    assert.equal((await display.call('POST', '/api/v1/notes/group-operations', { operation_id: `grant-denied-${++sequence}`, kind: 'undo', expected: { groups: [], notes: [] }, undo_operation_id: 'unavailable' })).status, 403);
    if (grants.view === 'none') assert.equal((await display.call('GET', '/api/v1/notes/board')).status, 403);
  }
  const created = await ok(display, 'POST', '/api/v1/notes', { content: 'Create-only display note' }, 201);
  assert.equal(created.body.data, null);
  assert.equal((await display.call('POST', '/api/v1/notes', { content: 'Forbidden private note', visibility: 'private' })).status, 403);
  assert.deepEqual(d.prepare('SELECT * FROM notes WHERE id=?').get(publicId), sharedBefore);
});

test('visibility revocation reauthorizes receipt retries and undo before exposing a board', async () => {
  const ids = await createNotes(), made = await createGroup(member, ids);
  const undo = await command(member, 'undo', { undo_operation_id: made.body.operation_id });
  const source = (await ok(admin, 'GET', `/api/v1/notes/${ids[1]}`)).body.data;
  await ok(admin, 'PUT', `/api/v1/notes/${ids[1]}`, { expected_revision: source.revision, visibility: 'private' });
  for (const body of [made.body, undo]) {
    const response = await member.call('POST', '/api/v1/notes/group-operations', body);
    assert.equal(response.status, 404); assert.ok(!JSON.stringify(response.body).includes(source.title));
  }
  assert.ok(!(await board(member)).notes.some(n => n.id === ids[1]));
  assert.ok(!(await board(member)).groups.some(g => g.member_ids.includes(ids[0])));
  assert.equal((await ok(admin, 'GET', `/api/v1/notes/${ids[1]}`)).body.data.visibility, 'private');
});

test('independent Notes layouts add no paired Calendar writes or legacy Wall Notes routes', async () => {
  const { display } = await pair(), legacy = await login();
  const before = d.prepare('SELECT COUNT(*) AS count FROM calendar_events').get().count;
  for (const [method, path] of [['POST', '/api/v1/calendar'], ['PUT', '/api/v1/calendar/1'], ['DELETE', '/api/v1/calendar/1']]) {
    assert.equal((await display.call(method, path, { title: 'Forbidden calendar mutation' })).status, 403);
  }
  await ok(legacy, 'POST', '/api/v1/wall/enter', {});
  for (const [method, path, body] of [['GET', '/api/v1/notes/board'], ['PATCH', '/api/v1/notes/1/layout', { expected_layout_revision: 0, always_on_top: true }], ['POST', '/api/v1/notes/group-operations', {}], ['POST', '/api/v1/calendar', {}]]) {
    assert.equal((await legacy.call(method, path, body)).status, 423);
  }
  const config = (await ok(legacy, 'GET', '/api/v1/wall/config')).body.data;
  assert.deepEqual(config.supportedActions, ['task_complete', 'task_claim', 'reward_redeem']);
  assert.equal(d.prepare('SELECT COUNT(*) AS count FROM calendar_events').get().count, before);
});

test('the synthetic authentication database remains encrypted and relationally valid', () => {
  d.pragma('wal_checkpoint(TRUNCATE)');
  assert.notEqual(readFileSync(process.env.DB_PATH).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  assert.deepEqual(d.pragma('foreign_key_check'), []);
  assert.equal(d.pragma('integrity_check', { simple: true }), 'ok');
});
