/**
 * Auth-router scope bypass regression (upstream c2f348e8), including the fork's
 * selectable token subjects, session fallback, and supported token headers.
 * Auth is mounted before the general API gates and needs its own scope guard.
 */
process.env.SESSION_SECRET ||= 'auth-router-scope-test-secret-32chars';
process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';

const dbmod = await import('../server/db.js');
const { router: authRouter, requireAuth } = await import('../server/auth.js');
const database = dbmod.get();
const insertUser = database.prepare(`
  INSERT INTO users(username, display_name, password_hash, role)
  VALUES (?, ?, 'x', ?)
`);
const adminId = Number(insertUser.run('scope-admin', 'Scope Admin', 'admin').lastInsertRowid);
const memberId = Number(insertUser.run('scope-member', 'Scope Member', 'member').lastInsertRowid);

function mintToken(value, scopes, { subject = adminId, expiresAt = null, revokedAt = null } = {}) {
  database.prepare(`
    INSERT INTO api_tokens(name, token_hash, token_prefix, created_by, subject_user_id, scopes, expires_at, revoked_at)
    VALUES (?, ?, 'yuvomi_test', ?, ?, ?, ?, ?)
  `).run(value, crypto.createHash('sha256').update(value).digest('hex'), adminId, subject,
    scopes === null ? null : JSON.stringify(scopes), expiresAt, revokedAt);
  return value;
}
const scopedToken = mintToken('yuvomi_scoped_notes_read_token', ['notes:read']);
const legacyToken = mintToken('yuvomi_legacy_unscoped_token', null);
const sessionCsrf = 'a'.repeat(64);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.session = req.headers['x-test-session'] === '1'
    ? { userId: adminId, role: 'admin', csrfToken: sessionCsrf }
    : {};
  next();
});
app.use('/api/v1/auth', authRouter);
app.get('/integration-context', requireAuth, (req, res) => res.json({
  id: req.authUserId, role: req.authRole, scopes: req.authScopes,
}));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.on('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function call(method, route, { token, header = 'authorization', session = false, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { [header]: header === 'authorization' ? `Bearer ${token}` : token } : {}),
      ...(session ? { 'x-test-session': '1', 'x-csrf-token': sessionCsrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('a scoped administrator token cannot mint unrestricted tokens or administrator accounts', async () => {
  const token = await call('POST', '/api/v1/auth/api-tokens', { token: scopedToken, body: { name: 'scope-pivot' } });
  assert.equal(token.status, 403);
  assert.match(token.body.error, /scope/);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE name = 'scope-pivot'").get().n, 0);

  const user = await call('POST', '/api/v1/auth/users', {
    token: scopedToken, body: { username: 'scope-escalation', display_name: 'Unauthorized', password: 'long-test-password', system_admin: true },
  });
  assert.equal(user.status, 403);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'scope-escalation'").get().n, 0);
});

test('every supported token header is scoped on both read and write auth routes', async () => {
  for (const header of ['authorization', 'x-api-key', 'api-key']) {
    for (const route of ['/api/v1/auth/me', '/api/v1/auth/api-tokens', '/api/v1/auth/users']) {
      assert.equal((await call('GET', route, { token: scopedToken, header })).status, 403, `${header} ${route}`);
    }
    assert.equal((await call('POST', '/api/v1/auth/api-tokens', { token: scopedToken, header, body: { name: 'blocked' } })).status, 403);
  }
});

test('an empty scope list is restricted and a denied request leaves last_used_at untouched', async () => {
  const empty = mintToken('yuvomi_empty_scope_token', []);
  for (const token of [empty, scopedToken]) {
    assert.equal((await call('GET', '/api/v1/auth/me', { token })).status, 403);
    assert.equal(database.prepare('SELECT last_used_at FROM api_tokens WHERE name = ?').get(token).last_used_at, null);
  }
});

test('unrestricted legacy tokens retain identity and account-management access', async () => {
  const me = await call('GET', '/api/v1/auth/me', { token: legacyToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, adminId);
  const created = await call('POST', '/api/v1/auth/api-tokens', { token: legacyToken, body: { name: 'legacy-created' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.scopes, null);
});

test('interactive sessions retain identity and management access but cannot override a presented scoped token', async () => {
  const me = await call('GET', '/api/v1/auth/me', { session: true });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, adminId);
  const created = await call('POST', '/api/v1/auth/api-tokens', { session: true, body: { name: 'session-created' } });
  assert.equal(created.status, 201);
  assert.equal((await call('GET', '/api/v1/auth/me', { session: true, token: scopedToken })).status, 403);
});

test('invalid, expired and revoked tokens retain ordinary authentication and session fallback behavior', async () => {
  const expired = mintToken('yuvomi_expired_scope_token', ['notes:read'], { expiresAt: '2000-01-01T00:00:00Z' });
  const revoked = mintToken('yuvomi_revoked_scope_token', ['notes:read'], { revokedAt: '2000-01-01T00:00:00Z' });
  for (const token of ['invalid-token', expired, revoked]) {
    assert.equal((await call('GET', '/api/v1/auth/me', { token })).status, 401);
    assert.equal((await call('GET', '/api/v1/auth/me', { token, session: true })).status, 200);
  }
});

test('unauthenticated public endpoints remain reachable without weakening protected routes', async () => {
  assert.equal((await call('GET', '/api/v1/auth/oidc/config')).status, 200);
  assert.equal((await call('GET', '/api/v1/auth/me')).status, 401);
});

test('the router guard preserves fork token subject identity and access outside account management', async () => {
  const memberScoped = mintToken('yuvomi_member_scoped_token', ['notes:read'], { subject: memberId });
  assert.equal((await call('GET', '/api/v1/auth/me', { token: memberScoped })).status, 403);
  const integration = await call('GET', '/integration-context', { token: memberScoped });
  assert.equal(integration.status, 200);
  assert.deepEqual(integration.body, { id: memberId, role: 'member', scopes: ['notes:read'] });
  const memberLegacy = mintToken('yuvomi_member_legacy_token', null, { subject: memberId });
  const me = await call('GET', '/api/v1/auth/me', { token: memberLegacy });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, memberId);
  assert.equal((await call('POST', '/api/v1/auth/api-tokens', { token: memberLegacy, body: { name: 'member-pivot' } })).status, 403);
});
