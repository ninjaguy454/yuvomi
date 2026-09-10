import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'member-name-tests-secret-32-characters';
const db = await import('../server/db.js');
const { router, requireAuth } = await import('../server/auth.js');
const { default: familyRouter } = await import('../server/routes/family.js');
const { householdMembers } = await import('../server/services/activity-eligibility.js');
const d = db.get();
let sequence = 0;
function user(role = 'member') {
  return Number(d.prepare(`INSERT INTO users(username, display_name, password_hash, role)
    VALUES (?, 'A display name is not a first name', 'x', ?)`).run(`member-name-${++sequence}`, role).lastInsertRowid);
}
const admin = user('admin');
const csrf = 'a'.repeat(64);
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const id = Number(req.headers['x-test-user']);
  const row = d.prepare('SELECT role FROM users WHERE id=?').get(id);
  req.session = row ? { userId: id, role: row.role, csrfToken: csrf } : {};
  next();
});
app.use('/auth', router);
app.use('/family', requireAuth, familyRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); d.close(); });
async function call(method, path, body, actor = admin, token = csrf) {
  const result = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-test-user': String(actor), 'x-csrf-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: result.status, body: await result.json() };
}
const names = (row) => ({ first_name: row.first_name, last_name: row.last_name, nickname: row.nickname });

test('legacy names remain unknown rather than parsed from display or Address Book', async () => {
  const id = user();
  d.prepare("INSERT INTO contacts(name, first_name, last_name, nickname, family_user_id) VALUES ('Contact name', 'Contact', 'Name', 'Contact nick', ?)").run(id);
  const result = await call('GET', '/auth/me', undefined, id);
  assert.equal(result.status, 200);
  assert.deepEqual(names(result.body.user), { first_name: null, last_name: null, nickname: null });
  assert.equal(result.body.user.display_name, 'A display name is not a first name');
});

test('admin creation accepts explicit Unicode names and optional nickname independently', async () => {
  const result = await call('POST', '/auth/users', {
    username: 'explicit-create', display_name: 'Household display', password: 'long-test-password',
    first_name: '  María José  ', last_name: '  van der Berg  ', nickname: '  MJ  ',
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.deepEqual(names(result.body.user), { first_name: 'María José', last_name: 'van der Berg', nickname: 'MJ' });
  assert.equal(result.body.user.display_name, 'Household display');
});

test('self-profile update persists names across profile, member list and workflow projection', async () => {
  const id = user();
  const fields = { first_name: '李', last_name: '王', nickname: '小王' };
  const updated = await call('PATCH', '/auth/me/profile', fields, id);
  assert.equal(updated.status, 200);
  assert.deepEqual(names(updated.body.user), fields);
  assert.deepEqual(names((await call('GET', '/auth/me', undefined, id)).body.user), fields);
  assert.deepEqual(names((await call('GET', '/auth/users')).body.data.find(row => row.id === id)), fields);
  assert.deepEqual(names((await call('GET', '/family/members')).body.data.find(row => row.id === id)), fields);
  assert.deepEqual(names(householdMembers(d).find(row => row.id === id)), fields);
});

test('independent partial saves preserve other fields and display-name changes preserve member metadata', async () => {
  const id = user();
  await call('PATCH', `/auth/users/${id}`, { first_name: 'Anna', last_name: 'de Vries', nickname: 'An' });
  await call('PATCH', '/auth/me/profile', { nickname: 'Annie' }, id);
  const result = await call('PATCH', `/auth/users/${id}`, { display_name: 'Mama', first_name: 'Anne' });
  assert.equal(result.status, 200);
  assert.deepEqual(names(result.body.user), { first_name: 'Anne', last_name: 'de Vries', nickname: 'Annie' });
  assert.equal(result.body.user.display_name, 'Mama');
});

test('null and whitespace clear only the supplied optional member names', async () => {
  const id = user();
  await call('PATCH', `/auth/users/${id}`, { first_name: 'First', last_name: 'Last', nickname: 'Nick' });
  const result = await call('PATCH', '/auth/me/profile', { first_name: null, nickname: '  ' }, id);
  assert.equal(result.status, 200);
  assert.deepEqual(names(result.body.user), { first_name: null, last_name: 'Last', nickname: null });
});

test('name validation rejects non-text and overlong values before any profile mutation', async () => {
  const id = user();
  for (const field of ['first_name', 'last_name', 'nickname']) {
    for (const invalid of [42, false, ['name'], { name: 'name' }, 'x'.repeat(129)]) {
      const result = await call('PATCH', '/auth/me/profile', { [field]: invalid, display_name: 'Must not save' }, id);
      assert.equal(result.status, 400, `${field}: ${JSON.stringify(invalid)}`);
    }
  }
  const row = d.prepare('SELECT * FROM users WHERE id=?').get(id);
  assert.equal(row.display_name, 'A display name is not a first name');
  assert.deepEqual(names(row), { first_name: null, last_name: null, nickname: null });
  assert.equal((await call('PATCH', '/auth/me/profile', { nickname: 'x'.repeat(128) }, id)).status, 200);
});

test('members cannot modify other accounts and missing session/CSRF cannot write names', async () => {
  const id = user(), other = user();
  assert.equal((await call('PATCH', `/auth/users/${other}`, { nickname: 'Unauthorized' }, id)).status, 403);
  assert.equal((await call('PATCH', '/auth/me/profile', { nickname: 'Unauthorized' }, id, '')).status, 403);
  assert.equal((await call('PATCH', '/auth/me/profile', { nickname: 'Unauthorized' }, 0)).status, 401);
  assert.deepEqual(names(d.prepare('SELECT * FROM users WHERE id=?').get(other)), { first_name: null, last_name: null, nickname: null });
});

test('explicit member names do not overwrite Contact structured names or nickname', async () => {
  const id = user();
  d.prepare(`INSERT INTO contacts(name, first_name, last_name, nickname, family_user_id)
    VALUES ('A display name is not a first name', 'Address', 'Book', 'Address nick', ?)`).run(id);
  assert.equal((await call('PATCH', '/auth/me/profile', { first_name: 'Profile', last_name: 'Name', nickname: 'Profile nick' }, id)).status, 200);
  assert.deepEqual(names(d.prepare('SELECT * FROM contacts WHERE family_user_id=?').get(id)),
    { first_name: 'Address', last_name: 'Book', nickname: 'Address nick' });
});
