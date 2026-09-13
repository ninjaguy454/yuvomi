import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Exercise the real detail/controller/API modules. Holding the HTTP response
// open proves that visual feedback is independent of backend acknowledgement.
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const copy = value => JSON.parse(JSON.stringify(value));
const app = express();
let fixture, server, browser, base;
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/optimistic-test', (_req, res) => res.send(`<!doctype html><html><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/layout.css">
  <link rel="stylesheet" href="/styles/typography.css"><link rel="stylesheet" href="/styles/detail-view.css">
  <link rel="stylesheet" href="/styles/tasks.css"></head><body></body></html>`));
app.use('/api/v1', (req, res) => {
  if (req.method === 'PATCH' && /\/tasks\/\d+\/status$/.test(req.path)) {
    const write = { path: req.path, body: req.body, res };
    fixture.writes.push(write);
    if (fixture.failure) return res.status(fixture.failure.status).set('X-CSRF-Token', 'fixture').json({ error: fixture.failure.error });
    fixture.dispatched.resolve(write);
    return;
  }
  if (req.path === '/auth/me') return res.json({ user: { id: 1 }, permissions: {}, csrfToken: 'fixture' });
  if (req.path === `/tasks/${fixture?.task.id}`) {
    fixture.reads++;
    if (fixture.readFailure) return res.status(503).json({ error: 'Temporary Task read failure.' });
    return res.json({ data: fixture.task });
  }
  return res.json({ data: [] });
});

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
  browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) || resolve());
});

function initialTask({ helper = false } = {}) {
  const id = helper ? 10 : 1;
  const task = { id, revision: 9, title: helper ? 'Supervise Laundry' : 'Laundry', status: 'open', assigned_to: 1,
    description: 'Follow the instructions.', points: helper ? 0 : 30, created_by: 1, documents: [],
    permissions: { complete: true, edit: false, comment: false }, is_supervision_projection: helper,
    subtasks: [
      { id: id + 1, revision: 3, parent_revision: 9, title: helper ? 'Load washer' : 'Gather laundry', status: 'open', points: helper ? 0 : 5, permissions: { complete: true } },
      { id: id + 2, revision: 4, parent_revision: 9, title: 'Fold laundry', status: 'open', points: 0, permissions: { complete: true } },
    ] };
  if (helper) for (const row of task.subtasks) {
    row.is_supervision_projection = true;
    row.supervision_action = { state: 'assigned', execution_mode: row.id === 11 ? 'delegated' : 'supervised', can_complete: true, learner_name: 'Frank' };
  }
  return task;
}

async function mounted(options = {}, viewport = { width: 1024, height: 800 }) {
  if (!options.reuse) fixture = { task: initialTask(options), writes: [], reads: 0, dispatched: deferred() };
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(`${base}/optimistic-test`);
  await page.evaluate(async task => {
    window.toasts = []; window.liveStreams = []; window.changedCalls = 0;
    window.yuvomi = { showToast: message => window.toasts.push(message) };
    window.EventSource = class {
      constructor() { this.listeners = new Map(); this.readyState = 1; window.liveStreams.push(this); }
      addEventListener(name, callback) { this.listeners.set(name, callback); }
      close() { this.readyState = 2; }
    };
    const { openTaskDetail } = await import('/components/task-detail.js');
    window.fixtureTask = task;
    openTaskDetail({ task, currentUserId: 1, users: [], isAdmin: true, onChanged: () => { window.changedCalls++; return new Promise(() => {}); } });
    document.addEventListener('click', event => {
      if (!event.target.closest('.detail-subtask__toggle')) return;
      window.tapAt = performance.now();
      requestAnimationFrame(() => { window.paintAt = performance.now(); });
    }, { capture: true });
  }, copy(fixture.task));
  await page.waitForSelector('.detail-subtask__toggle');
  return page;
}

const selector = id => `[data-subtask-id="${id}"] .detail-subtask__toggle`;
async function rowState(page, id) {
  return page.$eval(selector(id), row => ({ pressed: row.getAttribute('aria-pressed'), pending: row.getAttribute('aria-busy'), disabled: row.disabled }));
}
async function dispatchedWrite() {
  let timeout;
  try { return await Promise.race([fixture.dispatched.promise,
    new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('The expected Task mutation was not dispatched.')), 5_000); })]); }
  finally { clearTimeout(timeout); }
}
async function completePending(page, id) {
  await page.click(selector(id));
  const write = await dispatchedWrite();
  assert.deepEqual(await rowState(page, id), { pressed: 'true', pending: 'true', disabled: true });
  return write;
}
function acknowledge(write, { helper = false, legacy = false } = {}) {
  fixture.task = { ...fixture.task, revision: fixture.task.revision + 1, status: 'in_progress', subtasks: fixture.task.subtasks.map(row => ({
    ...row, status: row.id === Number(write.path.split('/')[2]) ? write.body.status : row.status,
    revision: row.id === Number(write.path.split('/')[2]) ? row.revision + 1 : row.revision, parent_revision: fixture.task.revision + 1,
  })) };
  const child = fixture.task.subtasks.find(row => row.id === Number(write.path.split('/')[2]));
  write.res.json({ data: { ...child, parent_task: helper ? { id: 1, revision: 20 } : fixture.task,
    ...(helper && !legacy ? { projection_parent_task: fixture.task } : {}) } });
}

test('checkbox/progress paint before response, duplicate taps are disabled, and an unrelated list load cannot delay acknowledgement', async () => {
  const page = await mounted();
  try {
    const write = await completePending(page, 2);
    await page.evaluate(() => { for (let tap = 0; tap < 5; tap++) document.querySelector('.detail-subtask__toggle').click(); });
    assert.equal(fixture.writes.length, 1);
    assert.deepEqual(write.body, { status: 'done', expected_revision: 3, expected_parent_revision: 9 });
    assert.match(await page.$eval('.task-detail-progress', node => node.innerText), /1 of 2 complete · 50%/);
    assert.equal(await page.evaluate(() => window.fixtureTask.status), 'open');
    assert.equal(await page.evaluate(() => window.fixtureTask.subtasks[0].status), 'open');
    await page.waitForFunction(() => window.paintAt >= window.tapAt);
    const latency = await page.evaluate(() => window.paintAt - window.tapAt);
    assert.ok(latency < 100, `first visual frame took ${latency.toFixed(1)} ms`);
    acknowledge(write);
    await page.waitForFunction(() => document.querySelector('.detail-subtask__toggle').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await rowState(page, 2), { pressed: 'true', pending: 'false', disabled: false });
    assert.equal(await page.evaluate(() => window.fixtureTask.status), 'in_progress');
    assert.equal(await page.evaluate(() => window.changedCalls), 1);
    assert.equal(fixture.reads, 0, 'hydrated source parent eliminates the mandatory detail GET');
  } finally { await page.close(); }
});

test('a late successful response cannot undo a newer live reset or reassignment while pending paint survives the live refresh', async () => {
  const page = await mounted();
  try {
    const write = await completePending(page, 2);
    const old = copy(fixture.task);
    fixture.task = { ...fixture.task, revision: 20, assigned_to: 7, status: 'open', subtasks: fixture.task.subtasks.map(row => ({ ...row, parent_revision: 20 })) };
    await page.evaluate(() => window.liveStreams[0].listeners.get('change')({ data: '{"version":20}' }));
    await page.waitForFunction(() => window.fixtureTask.revision === 20);
    assert.deepEqual(await rowState(page, 2), { pressed: 'true', pending: 'true', disabled: true });
    const stale = { ...old, revision: 10, status: 'in_progress', subtasks: old.subtasks.map(row => ({ ...row, status: row.id === 2 ? 'done' : 'open', parent_revision: 10 })) };
    write.res.json({ data: { ...stale.subtasks[0], parent_task: stale } });
    await page.waitForFunction(() => document.querySelector('.detail-subtask__toggle').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await rowState(page, 2), { pressed: 'false', pending: 'false', disabled: false });
    assert.deepEqual(await page.evaluate(() => [window.fixtureTask.revision, window.fixtureTask.assigned_to, window.fixtureTask.status]), [20, 7, 'open']);
  } finally { await page.close(); }
});

test('supervision rejection reverts pending completion and surfaces the actual explanation', async () => {
  const page = await mounted();
  try {
    const write = await completePending(page, 2);
    fixture.failure = { status: 403, error: 'Duane must supervise this action.' };
    write.res.status(403).set('X-CSRF-Token', 'fixture').json({ error: fixture.failure.error });
    await page.waitForFunction(() => window.toasts.length > 0);
    assert.deepEqual(await rowState(page, 2), { pressed: 'false', pending: 'false', disabled: false });
    assert.deepEqual(await page.evaluate(() => window.toasts), [fixture.failure.error]);
    assert.equal(await page.evaluate(() => window.changedCalls), 0);
    assert.equal(await page.evaluate(() => window.fixtureTask.subtasks[0].status), 'open');
  } finally { await page.close(); }
});

test('stale revision rejection refreshes current state without restoring the optimistic snapshot', async () => {
  const page = await mounted();
  try {
    const write = await completePending(page, 2);
    fixture.task = { ...fixture.task, revision: 15, assigned_to: 7, subtasks: fixture.task.subtasks.map(row => ({ ...row, parent_revision: 15 })) };
    write.res.status(409).json({ error: 'This Task was reset on another device.' });
    await page.waitForFunction(() => window.fixtureTask.revision === 15 && document.querySelector('.detail-subtask__toggle').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await rowState(page, 2), { pressed: 'false', pending: 'false', disabled: false });
    assert.equal(await page.evaluate(() => window.fixtureTask.assigned_to), 7);
    assert.deepEqual(await page.evaluate(() => window.toasts), ['This Task was reset on another device.']);
    assert.equal(fixture.reads, 1);
  } finally { await page.close(); }
});

test('mobile delegated helper completion acknowledges its own projection and preserves direct-responsibility wording', async () => {
  const page = await mounted({ helper: true }, { width: 390, height: 844 });
  try {
    assert.match(await page.$eval('[data-subtask-id="11"]', row => row.innerText), /Direct responsibility · You perform this for Frank/);
    const write = await completePending(page, 11);
    assert.match(await page.$eval('.task-detail-progress', node => node.innerText), /1 of 2 complete · 50%/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    acknowledge(write, { helper: true });
    await page.waitForFunction(() => document.querySelector('.detail-subtask__toggle').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await rowState(page, 11), { pressed: 'true', pending: 'false', disabled: false });
    assert.equal(await page.evaluate(() => window.fixtureTask.id), 10);
    assert.equal(fixture.reads, 0);
  } finally { await page.close(); }
});

test('reopening shows immediate pending progress reduction and restores keyboard focus after acknowledgement', async () => {
  const page = await mounted();
  try {
    const write = await completePending(page, 2);
    acknowledge(write);
    await page.waitForFunction(() => !document.querySelector('.detail-subtask__toggle').disabled);
    fixture.dispatched = deferred();
    await page.focus(selector(2));
    await page.keyboard.press('Space');
    const reopen = await dispatchedWrite();
    assert.deepEqual(await rowState(page, 2), { pressed: 'false', pending: 'true', disabled: true });
    assert.match(await page.$eval('.task-detail-progress', node => node.innerText), /0 of 2 complete · 0%/);
    assert.deepEqual(reopen.body, { status: 'in_progress', expected_revision: 4, expected_parent_revision: 10 });
    acknowledge(reopen);
    await page.waitForFunction(() => !document.querySelector('.detail-subtask__toggle').disabled);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey), 'subtask-2');
  } finally { await page.close(); }
});

test('another open client converges after completion and sends fresh revisions when reopening', async () => {
  const first = await mounted(), second = await mounted({ reuse: true });
  try {
    // Each page represents another device. Dispatch within that page so an
    // artificial browser-tab focus change cannot interrupt pointer delivery.
    await first.$eval(selector(2), node => node.click());
    const write = await dispatchedWrite();
    acknowledge(write);
    await first.waitForFunction(() => !document.querySelector('.detail-subtask__toggle').disabled, { polling: 50, timeout: 5_000 });
    await second.evaluate(() => window.liveStreams[0].listeners.get('change')({ data: '{"version":10}' }));
    await second.waitForFunction(() => window.fixtureTask.revision === 10, { polling: 50, timeout: 5_000 });
    assert.deepEqual(await rowState(second, 2), { pressed: 'true', pending: 'false', disabled: false });
    fixture.dispatched = deferred();
    await second.$eval(selector(2), node => node.click());
    const reopening = await dispatchedWrite();
    assert.deepEqual(reopening.body, { status: 'in_progress', expected_revision: 4, expected_parent_revision: 10 });
    acknowledge(reopening);
    await second.waitForFunction(() => !document.querySelector('.detail-subtask__toggle').disabled, { polling: 50, timeout: 5_000 });
    await first.evaluate(() => window.liveStreams[0].listeners.get('change')({ data: '{"version":11}' }));
    await first.waitForFunction(() => window.fixtureTask.revision === 11, { polling: 50, timeout: 5_000 });
    assert.deepEqual(await rowState(first, 2), { pressed: 'false', pending: 'false', disabled: false });
  } finally { await first.close(); await second.close(); }
});

test('compatible saved helper response remains completed when its detail read fails and resumes only after a fresh root', async () => {
  const page = await mounted({ helper: true });
  try {
    const write = await completePending(page, 11);
    fixture.readFailure = true;
    acknowledge(write, { helper: true, legacy: true });
    await page.waitForFunction(() => window.toasts.length > 0);
    assert.deepEqual(await rowState(page, 11), { pressed: 'true', pending: 'false', disabled: true });
    assert.equal(await page.evaluate(() => window.fixtureTask.subtasks[0].status), 'done');
    assert.equal(await page.evaluate(() => window.fixtureTask.revision), 9, 'parent status/revision wait for a complete server snapshot');
    assert.match(await page.evaluate(() => window.toasts[0]), /step was saved.*details could not be refreshed/);
    assert.match(await page.$eval('.task-detail-summary', node => node.innerText), /Step saved · refreshing Task details/);
    await page.$eval(selector(11), node => node.click());
    assert.equal(fixture.writes.length, 1, 'the saved step cannot be toggled using an obsolete parent revision');
    fixture.readFailure = false;
    await page.evaluate(() => window.liveStreams[0].listeners.get('change')({ data: '{"version":10}' }));
    await page.waitForFunction(() => window.fixtureTask.revision === 10 && !document.querySelector('.detail-subtask__toggle').disabled);
    assert.deepEqual(await rowState(page, 11), { pressed: 'true', pending: 'false', disabled: false });
  } finally { await page.close(); }
});
