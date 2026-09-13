import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Real Tasks rendering, event handlers, API client and styles. Only the HTTP
// data source and EventSource transport are fixtures; no production records.
const app = express();
const copy = value => structuredClone(value);
let server, browser, base, fixture;
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/view-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/layout.css">
  <link rel="stylesheet" href="/styles/typography.css"><link rel="stylesheet" href="/styles/list-row.css">
  <link rel="stylesheet" href="/styles/tasks.css"><link rel="stylesheet" href="/styles/detail-view.css">
  <style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}
    .app-content{height:100vh;flex:none}#main-content{padding:16px}
    *,*::before,*::after{animation:none!important;scroll-behavior:auto!important;transition:none!important}
  </style></head><body><div class="app-content"><main id="main-content"></main></div></body></html>`));

function visibleRows(query) {
  const statuses = query.getAll('status');
  const assigned = query.getAll('assigned_to');
  return fixture.tasks.filter(row => (query.get('archived') === '1' || !row.archived_at)
    && (!statuses.length || statuses.includes(row.status))
    && (!assigned.length || assigned.includes(String(row.assigned_to))));
}
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ user: { id: 1, role: 'admin' }, permissions: { admin: true }, csrfToken: 'fixture' });
  if (req.path === '/tasks/meta/options') return res.json({ users: [{ id: 1, display_name: 'Creator' }, { id: 2, display_name: 'Eleanor' }],
    categories: fixture.categories, tags: [], default_points: 0 });
  if (req.path === '/preferences') return res.json({ data: { tasks_subtasks_expanded: true } });
  if (req.path === '/automation/activity-options') return res.json({ data: { activities: [], skills: [] } });
  if (req.path === '/tasks/completions') {
    const query = new URL(req.originalUrl, base).searchParams;
    const before = Number(query.get('before_id') || Infinity);
    const remaining = fixture.history.filter(row => row.id < before);
    const rows = remaining.slice(0, 50);
    const result = { data: rows, has_more: remaining.length > rows.length,
      next_cursor: rows.length ? { before_id: rows.at(-1).id, before_at: rows.at(-1).completed_at } : null };
    if (fixture.holdHistory) { fixture.holdHistory = false; fixture.heldHistory.push({ res, result }); return; }
    return res.json(result);
  }
  if (req.path === '/tasks' && req.method === 'GET') {
    fixture.reads++;
    const rows = copy(visibleRows(new URL(req.originalUrl, base).searchParams));
    if (fixture.holdNext) { fixture.holdNext = false; fixture.held.push({ res, rows }); return; }
    return res.json({ data: rows });
  }
  const status = req.path.match(/^\/tasks\/(\d+)\/status$/);
  if (status && req.method === 'PATCH') {
    const id = Number(status[1]);
    const parent = fixture.tasks.find(row => row.id === id || row.subtasks.some(child => child.id === id));
    const task = parent?.id === id ? parent : parent?.subtasks.find(row => row.id === id);
    if (!task) return res.status(404).json({ error: 'Task unavailable' });
    fixture.writes.push({ id, body: copy(req.body) });
    if (fixture.rejectStatus) return res.status(409).json({ error: 'This Task changed on another device. Refresh and try again.' });
    task.status = req.body.status;
    task.revision++;
    if (parent !== task) {
      parent.revision++;
      parent.status = parent.subtasks.every(child => child.status === 'done') ? 'done'
        : parent.subtasks.some(child => child.status === 'done') ? 'in_progress' : 'open';
      parent.subtasks.forEach(child => { child.parent_revision = parent.revision; });
    }
    return res.json({ data: { ...task, ...(task !== parent ? { parent_task: parent } : {}) } });
  }
  const detail = req.path.match(/^\/tasks\/(\d+)$/);
  if (detail) {
    const row = fixture.tasks.find(task => task.id === Number(detail[1]));
    return row ? res.json({ data: row }) : res.status(404).json({ error: 'Task unavailable' });
  }
  return res.json({ data: [] });
});

function taskRow(id, patch = {}) {
  return { id, revision: 1, title: `Task ${String(id).padStart(3, '0')}`, category: `group-${Math.floor((id - 1) / 10)}`,
    description: `Instructions for Task ${id}.`, assigned_to: 2, assigned_name: 'Eleanor',
    assigned_users: [{ id: 2, display_name: 'Eleanor' }], created_by: 1, visibility: 'all',
    status: 'open', priority: 'none', points: 0, tags: [], documents: [],
    permissions: { view: true, complete: true, edit: true, delete_archive: true, comment: true },
    subtasks: [1, 2].map(step => ({ id: id * 100 + step, parent_task_id: id, parent_revision: 1, revision: 1,
      title: `Step ${step}`, status: 'open', points: 0, permissions: { view: true, complete: true } })), ...patch };
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
  browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });

async function mounted(mode = 'list', viewport = { width: 1100, height: 800 }) {
  fixture = { tasks: Array.from({ length: 60 }, (_, index) => taskRow(index + 1)), reads: 0, writes: [], held: [], holdNext: false,
    categories: Array.from({ length: 6 }, (_, index) => ({ key: `group-${index}`, name: `Group ${index + 1}`, sort_order: index })),
    holdHistory: false, heldHistory: [], history: Array.from({ length: 80 }, (_, index) => ({ id: 80 - index,
      task_id: 1, title: `Finished action ${80 - index}`, user_name: 'Eleanor', user_id: 2,
      completed_at: new Date(Date.UTC(2026, 8, 13, 16, 0) - index * 3600_000).toISOString() })) };
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.setDefaultTimeout(6000);
  await page.setViewport(viewport);
  // Measure steady-state reading positions, excluding the initial 150ms entry
  // stagger timer. Reduced motion is also a supported user preference.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${base}/view-test?view=${mode}`);
  await page.evaluate(async () => {
    localStorage.clear(); localStorage.setItem('yuvomi:swipeHintSeen', '3'); localStorage.setItem('yuvomi-locale', 'en');
    window.toasts = []; window.liveStreams = [];
    window.yuvomi = { showToast: message => window.toasts.push(message) };
    window.EventSource = class {
      constructor() { this.listeners = new Map(); this.readyState = 1; window.liveStreams.push(this); }
      addEventListener(name, callback) { this.listeners.set(name, callback); }
      close() { this.readyState = 2; }
    };
    await (await import('/i18n.js')).initI18n();
    (await import('/permissions.js')).setPermissions({ admin: true });
    const module = await import('/pages/tasks.js');
    window.subject = module.__test; window.taskContainer = document.getElementById('main-content');
    window.stopTasks = await module.render(window.taskContainer, { user: { id: 1, role: 'admin' } });
  });
  try { await page.waitForSelector('.task-card[data-task-id="25"]'); }
  catch (error) {
    const content = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 2000), error: window.subject?.state.loadError?.message }));
    await page.close();
    throw new Error(`Tasks fixture did not mount: ${JSON.stringify({ errors, content })}`, { cause: error });
  }
  await frames(page);
  return page;
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function refresh(page) { await page.evaluate(() => window.subject.loadTasks(window.taskContainer)); await frames(page); }
async function emitLive(page, version) {
  const previous = fixture.reads;
  await page.evaluate(value => window.liveStreams[0].listeners.get('change')({ data: JSON.stringify({ version: value }) }), version);
  await until(() => fixture.reads > previous);
  await frames(page);
}
async function until(predicate) {
  const limit = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error('Timed out waiting for the fixture request');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function anchor(page, id) {
  await page.evaluate(taskId => {
    const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
    const bucket = card.closest('.task-board__bucket-scroll');
    const scroll = bucket && bucket.scrollHeight > bucket.clientHeight ? bucket : document.querySelector('.app-content');
    const board = card.closest('.task-board');
    if (board) board.scrollLeft = card.closest('[data-bucket-key]').offsetLeft - board.offsetLeft;
    scroll.scrollTop += card.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 20;
    window.anchorCard = card;
    window.untouchedCard = document.querySelector('.task-card[data-task-id="30"]');
    window.retainedBoard = board;
    window.retainedScroll = scroll;
    card.querySelector('.activity-card__open').focus({ preventScroll: true });
  }, id);
  await frames(page);
  return position(page, id);
}
function position(page, id) {
  return page.evaluate(taskId => {
    const card = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
    const bucket = card?.closest('.task-board__bucket-scroll');
    const scroll = bucket && bucket.scrollHeight > bucket.clientHeight ? bucket : document.querySelector('.app-content');
    const board = document.querySelector('.task-board');
    return { y: scroll.scrollTop, x: board?.scrollLeft || 0,
      offset: card ? card.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null,
      pageY: document.scrollingElement.scrollTop, portTop: scroll.getBoundingClientRect().top,
      portHeight: scroll.clientHeight, contentHeight: scroll.scrollHeight,
      sameCard: card === window.anchorCard, sameOther: document.querySelector('.task-card[data-task-id="30"]') === window.untouchedCard,
      sameBoard: board === window.retainedBoard, sameScroll: scroll === window.retainedScroll,
      focused: document.activeElement?.closest('.task-card')?.dataset.taskId || null };
  }, id);
}
function near(actual, expected, explanation) { assert.ok(Math.abs(actual - expected) <= 2, `${explanation}: expected ${expected}, received ${actual}`); }
async function tap(page, selector) {
  await page.$eval(selector, button => { button.focus({ preventScroll: true }); button.click(); });
}
async function switchView(page, mode) {
  await tap(page, '#task-view-btn');
  await tap(page, `[data-task-view="${mode}"]`);
}

test('List subtask completion/reopen preserves viewport, expanded controls and unchanged card identity', async () => {
  const page = await mounted();
  try {
    const before = await anchor(page, 25);
    for (const expected of ['done', 'in_progress']) {
      await tap(page, '[data-action="toggle-subtask"][data-id="2501"]');
      await page.waitForFunction(status => document.querySelector('[data-action="toggle-subtask"][data-id="2501"]').dataset.status === status, {}, expected);
      await frames(page);
      const after = await position(page, 25);
      near(after.offset, before.offset, 'visible parent stays in place');
      assert.equal(after.sameOther, true, 'unrelated Task is reconciled in place');
      assert.equal(await page.$eval('[data-action="toggle-subtasks"][data-id="25"]', node => node.getAttribute('aria-expanded')), 'true');
      assert.equal(await page.evaluate(() => window.subject.state.viewMode), 'list');
    }
    assert.equal(fixture.writes.length, 2);
  } finally { await page.close(); }
});

test('canceling parent completion retains progress and re-enables the reconciled status control', async () => {
  const page = await mounted();
  try {
    const before = await anchor(page, 25);
    const reads = fixture.reads;
    await tap(page, '[data-action="toggle-status"][data-id="25"]');
    await page.waitForSelector('#confirm-modal-cancel');
    await tap(page, '#confirm-modal-cancel');
    await until(() => fixture.reads > reads); await frames(page);
    assert.equal(fixture.writes.length, 0);
    assert.equal(await page.$eval('[data-action="toggle-status"][data-id="25"]', node => node.disabled), false);
    assert.deepEqual(fixture.tasks.find(row => row.id === 25).subtasks.map(row => row.status), ['open', 'open']);
    near((await position(page, 25)).offset, before.offset, 'cancel retains the original reading position');
  } finally { await page.close(); }
});

test('rejected status mutation retains the Task and re-enables its unchanged reconciled control', async () => {
  const page = await mounted();
  try {
    fixture.tasks.find(row => row.id === 25).subtasks = [];
    await refresh(page); const before = await anchor(page, 25);
    fixture.rejectStatus = true;
    const reads = fixture.reads;
    await tap(page, '[data-action="toggle-status"][data-id="25"]');
    await page.waitForFunction(() => window.toasts.some(message => message.includes('changed on another device')));
    await until(() => fixture.reads > reads); await frames(page);
    assert.equal(fixture.writes.length, 1);
    assert.equal(await page.$eval('[data-action="toggle-status"][data-id="25"]', node => node.disabled), false);
    assert.equal(fixture.tasks.find(row => row.id === 25).status, 'open');
    near((await position(page, 25)).offset, before.offset, 'rejection retains the original reading position');
  } finally { await page.close(); }
});

test('Kanban retains horizontal and per-bucket scroll through Task status and subtask changes', async () => {
  const page = await mounted('kanban');
  try {
    fixture.tasks.find(row => row.id === 23).subtasks = [];
    await refresh(page);
    const before = await anchor(page, 25);
    assert.ok(before.x > 0 && before.y > 0, 'fixture exercises both real board axes');
    await tap(page, '[data-action="toggle-subtask"][data-id="2401"]');
    await page.waitForFunction(() => window.subject.state.tasks.find(row => row.id === 24)?.subtasks[0].status === 'done');
    await frames(page);
    let after = await position(page, 25);
    near(after.x, before.x, 'horizontal board offset');
    near(after.offset, before.offset, 'bucket reading position after auto-start');
    assert.equal(after.sameBoard, true); assert.equal(after.sameScroll, true); assert.equal(after.sameOther, true);
    // Completing an independent parent exercises the real status control without
    // a confirmation fixture or changing the lifecycle being tested elsewhere.
    await tap(page, '[data-action="toggle-status"][data-id="23"]');
    await page.waitForFunction(() => window.subject.state.tasks.find(row => row.id === 23)?.status === 'done');
    await frames(page);
    after = await position(page, 25);
    near(after.x, before.x, 'horizontal board offset after status move');
    near(after.offset, before.offset, 'surviving card anchors a status removal above it');
  } finally { await page.close(); }
});

test('card and board-section expansion preserve sibling identity and horizontal position', async () => {
  const page = await mounted('kanban');
  try {
    const before = await anchor(page, 25);
    for (const action of ['toggle-activity-details', 'toggle-subtasks', 'toggle-subtasks']) {
      await tap(page, `[data-action="${action}"][data-id="25"]`);
      await frames(page);
      const after = await position(page, 25);
      near(after.x, before.x, 'expansion does not reset board');
      assert.equal(after.sameOther, true);
      assert.equal(after.focused, '25', 'expansion control retains keyboard context');
    }
    const section = '[data-action="toggle-board-section"][data-section-key="personal:category:group-2:in_progress"]';
    await tap(page, section); await frames(page);
    assert.equal(await page.$eval(section, node => node.getAttribute('aria-expanded')), 'true');
    near((await position(page, 25)).x, before.x, 'direct renderKanban section path retains horizontal scroll');
    await refresh(page);
    assert.equal(await page.$eval(section, node => node.getAttribute('aria-expanded')), 'true');
  } finally { await page.close(); }
});

test('live assignment and recurrence insertion preserve the visible List anchor and current expansion state', async () => {
  const page = await mounted();
  try {
    await tap(page, '[data-action="toggle-activity-details"][data-id="25"]');
    const before = await anchor(page, 25);
    for (const [index, recurring] of [[0, false], [1, true]]) {
      const row = taskRow(700 + index, { title: `A new ${recurring ? 'recurrence' : 'assignment'}`, category: 'group-2', is_recurring: recurring });
      fixture.tasks.push(row);
      await emitLive(page, 10 + index);
      await page.waitForSelector(`.task-card[data-task-id="${row.id}"]`);
      await frames(page);
      const after = await position(page, 25);
      near(after.offset, before.offset, 'inserted work above the current card does not move its visual position');
      assert.equal(after.sameCard, true); assert.equal(after.sameOther, true);
      assert.equal(after.focused, '25');
      assert.equal(await page.$eval('[data-action="toggle-activity-details"][data-id="25"]', node => node.getAttribute('aria-expanded')), 'true');
    }
  } finally { await page.close(); }
});

test('deleted or archived Tasks disappear without restoring their focus or bulk selection', async () => {
  const page = await mounted();
  try {
    await page.evaluate(() => { window.subject.state.bulkSelectMode = true; window.subject.state.selectedTaskIds = new Set([25, 26]); window.subject.renderTaskList(window.taskContainer); });
    await anchor(page, 25);
    fixture.tasks = fixture.tasks.filter(row => row.id !== 25);
    fixture.tasks.find(row => row.id === 26).archived_at = new Date().toISOString();
    await refresh(page);
    assert.equal(await page.$('.task-card[data-task-id="25"]'), null);
    assert.equal(await page.$('.task-card[data-task-id="26"]'), null);
    assert.deepEqual(await page.evaluate(() => [...window.subject.state.selectedTaskIds]), []);
    assert.equal(await page.evaluate(() => document.activeElement === window.anchorCard || window.anchorCard.contains(document.activeElement)), false);
    assert.equal(await page.evaluate(() => window.untouchedCard.isConnected), true);
  } finally { await page.close(); }
});

test('delayed refresh captures the reading position at paint, after the user has scrolled', async () => {
  const page = await mounted('kanban');
  try {
    await anchor(page, 24);
    fixture.holdNext = true;
    await page.evaluate(() => { window.pendingRefresh = window.subject.loadTasks(window.taskContainer); });
    await until(() => fixture.held.length === 1);
    const before = await anchor(page, 27);
    fixture.held.shift().res.json({ data: copy(fixture.tasks) });
    await page.evaluate(() => window.pendingRefresh); await frames(page);
    const after = await position(page, 27);
    near(after.x, before.x, 'latest horizontal position');
    near(after.y, before.y, 'latest bucket scroll position');
    near(after.offset, before.offset, 'latest visible card');
  } finally { await page.close(); }
});

test('intentional filtering beats an older live response and does not resurrect excluded selection or focus', async () => {
  const page = await mounted();
  try {
    fixture.tasks.forEach(row => { row.assigned_to = row.id <= 20 ? 1 : 2; });
    await refresh(page); await anchor(page, 25);
    await page.evaluate(() => { window.subject.state.selectedTaskIds = new Set([25]); });
    fixture.holdNext = true;
    await page.evaluate(() => { window.oldRefresh = window.subject.loadTasks(window.taskContainer); });
    await until(() => fixture.held.length === 1);
    await page.evaluate(async () => { window.subject.state.filters.assigned_to = ['1']; await window.subject.loadTasks(window.taskContainer); });
    const current = await page.$$eval('.task-card', rows => rows.map(row => Number(row.dataset.taskId)));
    assert.equal(current.length, 20);
    fixture.held.shift().res.json({ data: copy(fixture.tasks) });
    await page.evaluate(() => window.oldRefresh); await frames(page);
    assert.deepEqual(await page.$$eval('.task-card', rows => rows.map(row => Number(row.dataset.taskId))), current);
    assert.deepEqual(await page.evaluate(() => window.subject.state.filters.assigned_to), ['1']);
    assert.deepEqual(await page.evaluate(() => [...window.subject.state.selectedTaskIds]), []);
    assert.equal(await page.evaluate(() => window.anchorCard.contains(document.activeElement)), false);
  } finally { await page.close(); }
});

test('open detail, comment draft/selection and both page and modal scroll survive live Task updates', async () => {
  const page = await mounted();
  try {
    const row = fixture.tasks.find(task => task.id === 25);
    row.description = Array.from({ length: 18 }, (_, index) => `Instruction paragraph ${index + 1}. Follow the household routine carefully.`).join('\n\n');
    await refresh(page);
    const before = await anchor(page, 25);
    await tap(page, '.task-card[data-task-id="25"] .activity-card__open');
    await page.waitForSelector('.detail-view__pane .task-comment__input');
    const modalBefore = await page.evaluate(() => {
      window.savedDetailPane = document.querySelector('.detail-view__pane');
      window.savedDetailBody = window.savedDetailPane.closest('.modal-panel__body');
      window.savedDraft = window.savedDetailPane.querySelector('.task-comment__input');
      window.savedDraft.value = 'Please keep my unfinished comment';
      window.savedDraft.focus({ preventScroll: true }); window.savedDraft.setSelectionRange(7, 11);
      window.savedDetailBody.scrollTop = window.savedDetailBody.scrollHeight;
      return window.savedDetailBody.scrollTop;
    });
    assert.ok(modalBefore > 0, 'fixture exercises a scrollable Task detail');
    const pageBeforeRefresh = await position(page, 25);
    row.title = 'Task 025 updated live'; row.revision++;
    await emitLive(page, 75);
    await page.waitForFunction(() => document.getElementById('shared-modal-title')?.textContent === 'Task 025 updated live');
    const result = await page.evaluate(() => ({
      paneRetained: window.savedDetailPane === document.querySelector('.detail-view__pane'),
      bodyRetained: window.savedDetailBody.isConnected, scroll: window.savedDetailBody.scrollTop,
      draftRetained: window.savedDraft === document.querySelector('.task-comment__input'),
      text: window.savedDraft.value, start: window.savedDraft.selectionStart, end: window.savedDraft.selectionEnd,
      focusRetained: document.activeElement === window.savedDraft,
    }));
    assert.equal(result.paneRetained, true); assert.equal(result.bodyRetained, true); assert.equal(result.draftRetained, true);
    assert.equal(result.text, 'Please keep my unfinished comment'); assert.equal(result.focusRetained, true);
    assert.deepEqual([result.start, result.end], [7, 11]);
    near(result.scroll, modalBefore, 'modal reading position');
    near((await position(page, 25)).offset, pageBeforeRefresh.offset, `background List reading position ${JSON.stringify({ before, pageBeforeRefresh })}`);
  } finally { await page.close(); }
});

test('History live refresh keeps previously opened pages and cannot overwrite a later List view', async () => {
  const page = await mounted();
  try {
    await switchView(page, 'history');
    await page.waitForFunction(() => document.querySelectorAll('.history-row').length === 50);
    await tap(page, '#history-more');
    await page.waitForFunction(() => document.querySelectorAll('.history-row').length === 80);
    const before = await page.evaluate(() => {
      const port = document.querySelector('.app-content');
      const row = document.querySelector('[data-view-key="history-entry:15"]');
      port.scrollTop += row.getBoundingClientRect().top - port.getBoundingClientRect().top - 20;
      row.focus({ preventScroll: true }); window.savedHistoryRow = row;
      return { scroll: port.scrollTop, offset: row.getBoundingClientRect().top - port.getBoundingClientRect().top };
    });
    await emitLive(page, 82);
    await page.waitForFunction(() => !window.subject.state.history.loading);
    await frames(page);
    assert.equal(await page.$$eval('.history-row', rows => rows.length), 80);
    const after = await page.evaluate(() => ({ same: window.savedHistoryRow === document.querySelector('[data-view-key="history-entry:15"]'),
      scroll: document.querySelector('.app-content').scrollTop,
      offset: window.savedHistoryRow.getBoundingClientRect().top - document.querySelector('.app-content').getBoundingClientRect().top }));
    assert.equal(after.same, true); near(after.offset, before.offset, 'History reading position');
    fixture.holdHistory = true;
    await emitLive(page, 83);
    await until(() => fixture.heldHistory.length === 1);
    await switchView(page, 'list');
    await page.waitForSelector('.task-card[data-task-id="25"]');
    const pending = fixture.heldHistory.shift(); pending.res.json(pending.result);
    await page.waitForFunction(() => !window.subject.state.history.loading);
    await frames(page);
    assert.equal(await page.$$eval('.history-row', rows => rows.length), 0);
    assert.equal(await page.$$eval('.task-card', rows => rows.length), 60);
    assert.equal(await page.evaluate(() => window.subject.state.viewMode), 'list');
  } finally { await page.close(); }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 412, height: 915 }]) {
  test(`mobile ${viewport.width}px List retains vertical position on live refresh`, async () => {
    const page = await mounted('list', { ...viewport, isMobile: true, hasTouch: true });
    try {
      const before = await anchor(page, 25);
      fixture.tasks.find(row => row.id === 2).revision++;
      await emitLive(page, 51);
      const after = await position(page, 25);
      near(after.offset, before.offset, `mobile reading position ${JSON.stringify({ before, after })}`);
      assert.equal(after.sameCard, true); assert.equal(after.sameOther, true);
    } finally { await page.close(); }
  });
}

for (const mode of ['list', 'kanban']) {
  test(`${mode} refresh preserves top, middle and bottom scroll limits without replacing surviving cards`, async () => {
    const page = await mounted(mode);
    try {
      for (const taskId of mode === 'list' ? [1, 25, 60] : [21, 25, 30]) {
        const before = await anchor(page, taskId);
        fixture.tasks.find(row => row.id === 40).revision++;
        await refresh(page);
        const after = await position(page, taskId);
        near(after.y, before.y, `Task ${taskId} vertical scroll`);
        near(after.x, before.x, `Task ${taskId} horizontal scroll`);
        near(after.offset, before.offset, `Task ${taskId} visual offset`);
        assert.equal(after.sameCard, true);
        assert.equal(after.sameScroll, true);
      }
    } finally { await page.close(); }
  });
}

test('mobile Kanban live insertion anchors the page when bucket content has no independent vertical scrollport', async () => {
  const page = await mounted('kanban', { width: 390, height: 844, isMobile: true, hasTouch: true });
  try {
    const before = await anchor(page, 25);
    const independent = await page.$eval('.task-card[data-task-id="25"]', card => {
      const bucket = card.closest('.task-board__bucket-scroll');
      return bucket.scrollHeight > bucket.clientHeight;
    });
    assert.equal(independent, false, 'mobile CSS lets the page own vertical bucket scrolling');
    assert.ok(before.y > 0 && before.x > 0, 'fixture scrolls page vertically and board horizontally');
    fixture.tasks.push(taskRow(701, { title: 'A new Laundry occurrence', category: 'group-2', is_recurring: true }));
    await emitLive(page, 111);
    await page.waitForSelector('.task-card[data-task-id="701"]');
    await frames(page);
    const after = await position(page, 25);
    near(after.offset, before.offset, 'page-owned Kanban anchor after insertion above it');
    near(after.x, before.x, 'mobile horizontal board offset');
    assert.equal(after.sameCard, true); assert.equal(after.sameBoard, true); assert.equal(after.sameScroll, true);
  } finally { await page.close(); }
});

test('restoring an unchanged viewport does not write scroll offsets and interrupt native momentum', async () => {
  const page = await mounted('kanban');
  try {
    await anchor(page, 25);
    const result = await page.evaluate(async () => {
      const { captureTaskViewport } = await import('/utils/task-view-state.js');
      const root = document.getElementById('task-list');
      const ports = new Set(root.querySelectorAll('.task-board, .task-board__bucket-scroll'));
      for (let node = root; node; node = node.parentElement) ports.add(node);
      ports.add(document.scrollingElement);
      const restores = [];
      const writes = [];
      try {
        for (const port of ports) for (const name of ['scrollTop', 'scrollLeft']) {
          const own = Object.getOwnPropertyDescriptor(port, name);
          let prototype = port;
          let native;
          while (prototype && !native) { native = Object.getOwnPropertyDescriptor(prototype, name); prototype = Object.getPrototypeOf(prototype); }
          if (!native?.get || !native?.set) throw new Error(`Missing native ${name} accessor`);
          Object.defineProperty(port, name, { configurable: true,
            get() { return native.get.call(this); },
            set(value) { writes.push({ port: this.className || this.tagName, axis: name, value }); native.set.call(this, value); } });
          restores.push(() => { if (own) Object.defineProperty(port, name, own); else delete port[name]; });
        }
        const restore = captureTaskViewport(root);
        restore();
        return { checkedPorts: ports.size, writes };
      } finally { restores.reverse().forEach(restore => restore()); }
    });
    assert.ok(result.checkedPorts > 6, 'real nested ports and ancestors were observed');
    assert.deepEqual(result.writes, [], 'equal offsets are left untouched');
  } finally { await page.close(); }
});

test('repeated empty List renders bind the create call to action only once', async () => {
  const page = await mounted();
  try {
    fixture.tasks = [];
    await refresh(page);
    await page.waitForSelector('#empty-cta-tasks');
    await page.evaluate(() => { window.savedEmptyAction = document.getElementById('empty-cta-tasks'); });
    for (let index = 0; index < 4; index++) await refresh(page);
    await page.evaluate(() => {
      window.createInvocations = 0;
      document.querySelector('.page-fab').click = () => { window.createInvocations++; };
    });
    await tap(page, '#empty-cta-tasks');
    assert.equal(await page.evaluate(() => window.createInvocations), 1);
    assert.equal(await page.evaluate(() => window.savedEmptyAction === document.getElementById('empty-cta-tasks')), true);
  } finally { await page.close(); }
});
