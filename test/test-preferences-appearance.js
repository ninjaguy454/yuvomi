import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'appearance-preference-tests-secret';
const { get } = await import('../server/db.js');
const { default: router } = await import('../server/routes/preferences.js');
let userId = 1;
let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = userId; req.authRole = 'member'; next(); });
  app.use(router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => {
  userId = 1;
  get().prepare("DELETE FROM sync_config WHERE key LIKE 'color_theme:user:%' OR key LIKE 'heading_font:user:%'").run();
});
async function request(patch) {
  const response = await fetch(base, patch ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) } : {});
  return { status: response.status, body: await response.json() };
}
test('defaults preserve the existing palette and typography', async () => {
  const { body } = await request();
  assert.equal(body.data.color_theme, 'neutral');
  assert.equal(body.data.heading_font, 'default');
});
test('ordinary members save all choices independently per account', async () => {
  for (const color_theme of ['neutral', 'warm', 'cool']) {
    const result = await request({ color_theme, heading_font: 'serif' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.color_theme, color_theme);
    assert.equal(result.body.data.heading_font, 'serif');
  }
  userId = 2;
  assert.equal((await request()).body.data.color_theme, 'neutral');
  await request({ color_theme: 'warm' });
  userId = 1;
  assert.equal((await request()).body.data.color_theme, 'cool');
  assert.equal((await request()).body.data.heading_font, 'serif');
});
test('invalid pairs and rejected household edits do not partially save personal choices', async () => {
  assert.equal((await request({ color_theme: 'warm', heading_font: 'remote' })).status, 400);
  assert.equal((await request()).body.data.color_theme, 'neutral');
  assert.equal((await request({ color_theme: 'warm', timezone: 'Europe/London' })).status, 403);
  assert.equal((await request()).body.data.color_theme, 'neutral');
  for (const color_theme of [null, {}, 'Warm', '', 'dark']) assert.equal((await request({ color_theme })).status, 400);
});
