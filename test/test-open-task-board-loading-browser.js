// Real board/detail modules with synthetic API responses and sandboxed Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const task = { id: 7, title: 'Synthetic garden offer', description: 'Read the seed plan.', created_by: 1,
  revision: 4, visibility: 'all', status: 'open', priority: 'none', points: 5,
  assigned_to: null, assigned_users: [], tags: [], subtasks: [], is_offer: true,
  permissions: { view: true, accept: true, complete: false, edit: false, delete_archive: false } };
const identity = { user: { id: 1, role: 'admin' }, authContext: 'synthetic-loading', permissions: { admin: true } };
const app = express(); let server, browser, base;
const links = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m => m[0]).join('');
app.get('/board-loading-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head>${links}<link rel="stylesheet" href="/styles/tasks.css"></head><body><main id="main-content"><aside id="board"></aside></main></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/api/v1/auth/me', (_req, res) => res.json(identity));
app.get('/api/v1/tasks', (_req, res) => res.json({ data: [task] }));
app.get('/api/v1/tasks/7', (_req, res) => res.json({ data: task }));
app.get('/api/v1/tasks/meta/options', (_req, res) => res.json({ users: [{ id: 1, display_name: 'Alex' }], categories: [], tags: [] }));
app.use('/api/v1', (req, res) => req.method === 'GET' ? res.json({ data: [] }) : res.status(405).json({ error: 'Read-only fixture' }));

test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
  assert.ok(!browser.process().spawnargs.some(arg => /--no-sandbox|--disable-web-security/.test(arg)));
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });

async function fixture({ hold = false } = {}) {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  page.setDefaultTimeout(8000); await page.setViewport({ width: 1280, height: 900 });
  const seen = [], errors = [], gate = { hold, request: null, failRead: false };
  await page.setRequestInterception(true);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url()); seen.push({ path: url.pathname, method: request.method() });
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) return request.abort();
    if (url.pathname === '/components/task-detail.js' && gate.hold) { gate.request = request; return; }
    if (url.pathname === '/api/v1/tasks' && gate.removeOffer) return request.respond({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
    if (url.pathname === '/api/v1/tasks' && gate.changedOffer) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ ...task, revision: 5, permissions: { view: true, accept: false } }] }) });
    if (url.pathname === '/api/v1/tasks/7' && gate.failRead) return request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic retryable failure"}' });
    return request.continue();
  });
  await page.goto(base + '/board-loading-test');
  await page.evaluate(async identity => {
    localStorage.setItem('yuvomi-locale', 'en');
    window.toasts = []; window.yuvomi = { showToast: message => window.toasts.push(message) };
    window.EventSource = class { addEventListener() {} close() {} };
    await (await import('/i18n.js')).initI18n();
    (await import('/utils/device-context.js')).acceptAuthentication(identity);
    (await import('/permissions.js')).setPermissions(identity.permissions);
    window.mountPromise = import('/components/open-task-board.js').then(module => {
      window.stopBoard = module.mountOpenTaskBoard(document.querySelector('#board'), { user: identity.user });
    });
  }, identity);
  return { page, seen, errors, gate, async close() {
    if (gate.request && !gate.request.isInterceptResolutionHandled()) await gate.request.continue();
    await context.close();
  } };
}
const ready = page => page.waitForSelector('[data-open-task="7"]');
async function holdClick(f) {
  await ready(f.page); f.gate.hold = true;
  const imported = f.page.waitForRequest(request => new URL(request.url()).pathname === '/components/task-detail.js');
  const read = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tasks/7');
  await f.page.click('[data-open-task="7"]'); await imported; await read;
  assert.ok(f.gate.request && !f.gate.request.isInterceptResolutionHandled());
}

async function revalidate(page) {
  await page.evaluate(async () => {
    const { api } = await import('/api.js'), get = api.get;
    await new Promise(resolve => {
      api.get = async (...args) => {
        try { return await get(...args); }
        finally {
          if (args[0] === '/tasks?offers=1') {
            api.get = get;
            // Let the loader's promise continuation apply this response first.
            setTimeout(resolve, 0);
          }
        }
      };
      window.dispatchEvent(new Event('task-data-changed'));
    });
  });
}

test('an unchanged refresh preserves the focused pending offer and completes its single inspection', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await holdClick(f);
    await f.page.evaluate(() => { window.pendingOffer = document.querySelector('[data-open-task="7"]'); });
    await revalidate(f.page);
    assert.equal(await f.page.evaluate(() => pendingOffer === document.querySelector('[data-open-task="7"]')), true, 'an identical projection must retain the pending control');
    assert.equal(await f.page.$eval('[data-open-task="7"]', button => button.disabled), true);
    await f.page.click('[data-open-task="7"]');
    await f.gate.request.continue(); await f.page.waitForSelector('.detail-view__pane');
    assert.equal(f.seen.filter(r => r.path === '/api/v1/tasks/7').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('changed authority on a retained offer ID cancels its pending inspection', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await holdClick(f); f.gate.changedOffer = true; await revalidate(f.page);
    await f.gate.request.continue();
    await f.page.evaluate(async () => { await import('/components/task-detail.js'); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await f.page.$('.detail-view__pane'), null);
    assert.deepEqual(await f.page.evaluate(() => window.toasts), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the board renders without requesting the task-detail graph', { timeout: 15000 }, async () => {
  const f = await fixture({ hold: true });
  try {
    const rendered = await f.page.waitForSelector('[data-open-task="7"]', { timeout: 1800 }).then(() => true, () => false);
    assert.equal(rendered, true, 'task-detail module loading must not block the board');
    assert.equal(f.seen.some(r => r.path === '/components/task-detail.js' || r.path === '/components/task-acceptance.js'), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('inspection loads on demand with its GET in parallel and rejects duplicate native clicks', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await holdClick(f);
    assert.equal(await f.page.$('.detail-view__pane'), null);
    assert.equal(await f.page.$eval('[data-open-task="7"]', button => button.disabled), true);
    await f.page.click('[data-open-task="7"]');
    await f.gate.request.continue(); await f.page.waitForSelector('.detail-view__pane');
    assert.match(await f.page.$eval('.modal-panel', el => el.textContent), /Synthetic garden offer/);
    assert.equal(f.seen.filter(r => r.path === '/api/v1/tasks/7').length, 1);
    assert.equal(await f.page.$('.modal-panel select,.modal-panel textarea,#detail-view-edit'), null);
    assert.equal(f.seen.some(r => !['GET', 'HEAD'].includes(r.method)), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const boundary of ['dispose', 'disconnect', 'auth-change', 'permissions', 'auth:context-ending', 'auth:expired']) test(`late detail import cannot open after ${boundary}`, { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await holdClick(f);
    await f.page.evaluate(async boundary => {
      if (boundary === 'dispose') window.stopBoard();
      if (boundary === 'disconnect') document.querySelector('#board').remove();
      if (boundary === 'auth-change') (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'new-synthetic-session', user: { id: 2 } });
      if (boundary === 'permissions') (await import('/permissions.js')).setPermissions({ modules: { tasks: 'none' } });
      if (boundary.startsWith('auth:')) window.dispatchEvent(new Event(boundary));
    }, boundary);
    await f.gate.request.continue();
    // Await the same native module promise, then the click continuation's turn.
    await f.page.evaluate(async () => { await import('/components/task-detail.js'); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await f.page.$('.detail-view__pane'), null);
    assert.deepEqual(await f.page.evaluate(() => window.toasts), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a failed detail read restores the control and a later click can retry', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await ready(f.page); f.gate.failRead = true;
    await f.page.click('[data-open-task="7"]');
    await f.page.waitForFunction(() => window.toasts.length > 0);
    assert.equal(await f.page.$('.detail-view__pane'), null);
    await f.page.waitForFunction(() => !document.querySelector('[data-open-task="7"]').disabled);
    f.gate.failRead = false;
    await f.page.click('[data-open-task="7"]'); await f.page.waitForSelector('.detail-view__pane');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a pending detail import cannot reopen an offer removed by an authoritative refresh', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await holdClick(f);
    f.gate.removeOffer = true;
    await f.page.evaluate(() => window.dispatchEvent(new Event('task-data-changed')));
    await f.page.waitForFunction(() => !document.querySelector('[data-open-task="7"]'));
    await f.gate.request.continue();
    await f.page.evaluate(async () => { await import('/components/task-detail.js'); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await f.page.$('.detail-view__pane'), null, 'the removed offer must not reopen from an earlier detail response');
    assert.deepEqual(await f.page.evaluate(() => window.toasts), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
