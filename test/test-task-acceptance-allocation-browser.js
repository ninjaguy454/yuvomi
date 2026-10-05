import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express();
let browser, server, base, writes, requests, projection, failure;
const members = [
  { id: 1, display_name: 'Alex Smith', age: 12, username: 'alex.smith', name_collisions: ['first_last_initial'] },
  { id: 2, display_name: 'Alex Stone', username: 'alex.stone', name_collisions: ['first_last_initial'] },
  { id: 3, display_name: '李 明', name_collisions: [] },
];
const authorizedPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY2Bg+P8fAAMCAf/Jsq3uAAAAAElFTkSuQmCC';
const original = {
  task: { id: 7, title: 'Prepare the garden', is_offer: true }, expected_revision: 4,
  primary_mode: 'self', primary_user_id: 1, primary_candidates: [members[0]],
  can_add_helpers: true, coassignee_candidates: members.slice(1),
  subtask_snapshot: [10, 11, 12, 13].map(id => ({ id, revision: 1 })),
  subtasks: [
    { id: 10, title: 'Water seedlings', revision: 1, allocatable: true, eligible_assignee_ids: [1, 2, 3] },
    { id: 11, title: 'Reserved step', revision: 1, allocatable: false, reason: 'Already assigned', eligible_assignee_ids: [] },
    { id: 12, title: 'Plant the herbs', revision: 1, allocatable: true, eligible_assignee_ids: [1, 3] },
    { id: 13, title: '<img src=x onerror=alert(1)>', revision: 1, allocatable: true, eligible_assignee_ids: [1, 2, 3] },
  ],
};
const links = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m => `<link rel="stylesheet" href="${m[1]}">`).join('');
app.use(express.json());
app.get('/allocation-test', (_q, r) => r.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<link rel="stylesheet" href="/styles/tasks.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><button id="start">Start</button></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use('/api/v1', (req, res) => {
  requests.push({ method: req.method, path: req.path });
  if (req.path === '/auth/me') return res.json({ csrfToken: 'fixture' });
  if (req.method === 'GET' && req.path.endsWith('/acceptance')) return res.json({ data: projection });
  if (req.path.endsWith('/accept')) {
    writes.push(structuredClone(req.body));
    if (failure) { failure = false; return res.status(503).json({ error: 'Uncertain' }); }
    return res.json({ data: { ...projection.task, assigned_to: req.body.primary_user_id } });
  }
  return res.json({ data: [] });
});
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); await new Promise(r => server.close(r)); });
async function mount({ width = 390, height = 844, scoped = false, unsafeName = false, touch = false, longList = false, manyPeople = false, photos = false, rawReason = false } = {}) {
  projection = structuredClone(original); writes = []; requests = []; failure = false;
  if (manyPeople) {
    projection.coassignee_candidates = Array.from({ length: 10 }, (_, index) => ({ id: index + 2, display_name: `Garden helper ${index + 2}` }));
    for (const child of projection.subtasks) if (child.allocatable) child.eligible_assignee_ids = Array.from({ length: 11 }, (_, index) => index + 1);
  }
  if (photos) {
    projection.coassignee_candidates[0].avatar_data = 'https://example.invalid/private-avatar';
    projection.coassignee_candidates[1].avatar_data = authorizedPhoto;
  }
  if (rawReason) projection.subtasks[1].reason = 'already_assigned';
  if (longList) {
    const extra = Array.from({ length: 20 }, (_, index) => ({ id: 20 + index, title: `Garden step ${index + 1}`, revision: 1, allocatable: true, eligible_assignee_ids: [1, 2, 3] }));
    projection.subtasks.push(...extra); projection.subtask_snapshot.push(...extra.map(({ id, revision }) => ({ id, revision })));
  }
  if (scoped) projection.coassignee_candidates = [structuredClone(members[2])];
  if (unsafeName) projection.coassignee_candidates[0].display_name = '<script>alert(1)</script> Person';
  const page = await browser.newPage(); page.setDefaultTimeout(6000);
  page.imageRequests = []; page.on('request', request => { if (request.resourceType() === 'image') page.imageRequests.push(request.url()); });
  await page.setViewport({ width, height, isMobile: touch, hasTouch: touch }); await page.goto(base + '/allocation-test');
  await page.evaluate(async ({ members, scoped }) => {
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    if (scoped) (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'display', principal: { kind: 'device', id: 91 }, device: { id: 91 } });
    (await import('/utils/member-label.js')).setMemberLabels(scoped ? [members[0], members[2]] : members);
    // A richer stale profile must never be used by this acceptance component.
    window.yuvomi = { ...window.yuvomi, users: [{ id: 1, display_name: 'Alex Smith', phone: 'SECRET-PHONE', email: 'secret@example.test', avatar_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4x8AAAAASUVORK5CYII=' }] };
    document.querySelector('#start').onclick = () => { window.result = import('/components/task-acceptance.js').then(m => m.acceptOpenTask({ id: 7 })); };
  }, { members, scoped });
  await page.click('#start'); await page.waitForSelector('[data-acceptance-helper]');
  for (const id of scoped ? [3] : manyPeople ? projection.coassignee_candidates.map(person => person.id) : [2, 3]) await page.click(`[data-acceptance-helper="${id}"]`);
  await page.click('[data-acceptance-next]'); return page;
}
async function choose(page, child, recipient) {
  await page.click(`[data-acceptance-target="${child}"]`);
  await page.click(`[data-acceptance-choice="${recipient ?? ''}"]`);
}
function assertNoWrites() {
  assert.deepEqual(requests.filter(request => !['GET', 'HEAD'].includes(request.method)), [], 'draft interactions never make any mutation request');
  assert.equal(writes.length, 0);
}
async function handleBrowserBack(page) {
  await page.evaluate(async () => {
    const { handleBackNavigation } = await import('/utils/overlay-history.js');
    window.overlayBackResults = [];
    window.addEventListener('popstate', async () => { window.overlayBackResults.push(await handleBackNavigation()); });
  });
}

test('stable rows render one accessible target each without making assignments', async () => {
  const page = await mount(); try {
    assert.deepEqual(await page.$$eval('[data-acceptance-person]', els => els.map(el => Number(el.dataset.acceptancePerson))), [1, 2, 3]);
    assert.deepEqual(await page.$$eval('[data-acceptance-child]', els => els.map(el => Number(el.dataset.acceptanceChild))), [10, 11, 12, 13]);
    assert.equal(await page.$$eval('[data-acceptance-target]', els => els.length), 4);
    assert.equal(await page.$eval('[data-acceptance-target="11"]', el => el.disabled), true);
    assert.ok((await page.$eval('[data-acceptance-target="11"]', el => el.getAttribute('aria-label'))).includes('Already assigned'));
    assert.equal(await page.$('[data-acceptance-pool]'), null);
    assert.equal(await page.$('[data-task-acceptance] img'), null);
    assert.equal(await page.$$eval('[data-acceptance-target]', els => els.every(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)), true);
    const before = await page.$$eval('[data-acceptance-child]', els => els.map(el => el.getBoundingClientRect().y));
    await choose(page, 10, 2); await choose(page, 10, 1);
    assert.equal(await page.$eval('[data-acceptance-target="10"]', el => el.dataset.assignee), '1');
    assert.deepEqual(await page.$$eval('[data-acceptance-child]', els => els.map(el => el.getBoundingClientRect().y)), before);
    await choose(page, 10, null);
    assert.equal(await page.$eval('[data-acceptance-target="10"]', el => el.dataset.assignee), '');
    assertNoWrites();
    await page.click('[data-acceptance-next]'); await page.click('[data-acceptance-confirm]'); await page.waitForSelector('[data-task-acceptance]', { hidden: true });
    assert.deepEqual(writes[0].subtask_assignments, [10, 12, 13].map(id => ({ id, user_id: null })));
  } finally { await page.close(); }
});

test('chooser filters eligible selected recipients and keeps collision metadata presentation-only', async () => {
  const page = await mount(); try {
    await page.click('[data-acceptance-target="12"]');
    assert.deepEqual(await page.$$eval('[data-acceptance-choice]', els => els.map(el => [el.dataset.acceptanceChoice, el.textContent.trim()])), [['', 'Unassigned'], ['1', 'ASAlex S. (12)'], ['3', '李明李 明.']]);
    await page.keyboard.press('Escape'); await page.click('[data-acceptance-target="10"]');
    assert.ok((await page.$eval('[data-acceptance-choice="2"]', el => el.textContent)).includes('Alex S. (alex.stone)'));
    await page.click('[data-acceptance-choice="2"]'); await page.click('[data-acceptance-next]');
    assert.equal(await page.$eval('[data-acceptance-identity]', el => el.textContent), 'Alex Smith');
    assertNoWrites();
  } finally { await page.close(); }
});

test('picker owns Escape, Tab and outside dismissal while retaining step focus and draft', async () => {
  const page = await mount(); try {
    await page.focus('[data-acceptance-target="10"]'); await page.keyboard.press('Enter');
    assert.equal(await page.$eval('[data-acceptance-picker]', el => el.contains(document.activeElement)), true);
    await page.focus('[data-acceptance-picker] [data-picker-close]'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.$eval('[data-acceptance-choice="3"]', el => el === document.activeElement), true, 'first Shift+Tab wraps to last');
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval('[data-picker-close]', el => el === document.activeElement), true, 'last Tab wraps to first');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.$eval('[data-acceptance-picker]', el => el.contains(document.activeElement)), true, `Tab ${i + 1} stays in picker`);
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.$('[data-acceptance-picker]'), null);
    assert.equal(await page.$eval('[data-acceptance-target="10"]', el => document.activeElement === el), true);
    assert.ok(await page.$('[data-task-acceptance]'));
    await page.click('[data-acceptance-target="10"]'); await page.click('[data-acceptance-next]');
    assert.equal(await page.$('[data-acceptance-picker]'), null);
    assert.equal(await page.$eval('[data-task-acceptance]', el => el.dataset.stage), 'allocation', 'outside dismissal consumes the action');
    await page.focus('[data-acceptance-target="10"]'); await page.keyboard.press('Space');
    await page.focus('[data-acceptance-choice="2"]'); await page.keyboard.press('Enter');
    assert.equal(await page.$eval('[data-acceptance-target="10"]', el => document.activeElement === el), true);
    assertNoWrites();
  } finally { await page.close(); }
});

test('scoped chooser uses collision flags without exposing another recipient or private card fields', async () => {
  const page = await mount({ scoped: true }); try {
    await page.click('[data-acceptance-target="10"]');
    assert.deepEqual(await page.$$eval('[data-acceptance-choice]', els => els.map(el => el.dataset.acceptanceChoice)), ['', '1', '3']);
    assert.equal(await page.$('[data-task-acceptance] img'), null, 'strip never takes the richer cached photo');
    assert.equal(await page.$('[data-acceptance-picker] img'), null, 'chooser never takes the richer cached photo');
    assert.ok((await page.$eval('[data-acceptance-choice="1"]', el => el.textContent)).includes('Alex S. (12)'));
    await page.keyboard.press('Escape'); await page.focus('[data-acceptance-person="1"]'); await page.keyboard.press('Enter');
    await page.waitForSelector('.task-detail-profile-preview');
    const card = await page.$eval('.task-detail-profile-preview', el => el.textContent);
    assert.ok(card.includes('Alex Smith')); assert.ok(!card.includes('Alex Smith (12)')); assert.ok(!card.includes('SECRET-PHONE')); assert.ok(!card.includes('secret@example.test'));
    assert.equal(await page.$('.task-detail-profile-preview img'), null, 'card never takes the richer cached photo');
    await page.keyboard.press('Escape'); assert.ok(await page.$('[data-task-acceptance]'));
    assert.equal(await page.$eval('[data-acceptance-person="1"]', el => document.activeElement === el), true);
    assert.ok(!requests.some(req => /users|profile|birth|contact/.test(req.path))); assertNoWrites();
  } finally { await page.close(); }
});

test('allocation preserves a partial choice verbatim on uncertain retry', async () => {
  const page = await mount(); try {
    await choose(page, 10, 2); await page.click('[data-acceptance-next]'); failure = true;
    await page.click('[data-acceptance-confirm]'); await page.waitForSelector('[data-acceptance-retry]');
    assert.equal(await page.$('[data-acceptance-target]'), null);
    await page.click('[data-acceptance-retry]'); await page.waitForSelector('[data-task-acceptance]', { hidden: true });
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
    assert.deepEqual(writes[0].subtask_assignments, [{ id: 10, user_id: 2 }, { id: 12, user_id: null }, { id: 13, user_id: null }]);
  } finally { await page.close(); }
});

test('HTML-like participant names stay text in chooser and logout removes a nested layer without writes', async () => {
  const page = await mount({ unsafeName: true }); try {
    await page.click('[data-acceptance-target="10"]');
    assert.equal(await page.$('[data-acceptance-picker] script'), null);
    assert.ok((await page.$eval('[data-acceptance-choice="2"]', el => el.textContent)).includes('<script>alert(1)</script>'));
    await page.evaluate(() => window.dispatchEvent(new Event('auth:context-ending')));
    await page.waitForSelector('[data-task-acceptance]', { hidden: true });
    assert.equal(await page.$('[data-acceptance-picker]'), null); assertNoWrites();
  } finally { await page.close(); }
});

for (const touch of [false, true]) test(`${touch ? 'touch' : 'mouse'} long press opens only the person card and suppresses assignment`, async () => {
  const page = await mount({ touch }); let cdp; try {
    const source = await (await page.$('[data-acceptance-person="2"]')).boundingBox();
    const x = source.x + source.width / 2, y = source.y + source.height / 2;
    if (touch) {
      cdp = await page.createCDPSession();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    } else { await page.mouse.move(x, y); await page.mouse.down(); }
    await page.waitForSelector('.task-detail-profile-preview');
    if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await page.mouse.up();
    assert.equal(await page.$$eval('.task-detail-profile-preview', els => els.length), 1);
    assert.equal(await page.$$eval('[data-acceptance-target]:not(:disabled)', els => els.every(el => el.dataset.assignee === '')), true);
    assertNoWrites();
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('[data-acceptance-person="2"]', el => document.activeElement === el), true);
    assert.ok(await page.$('[data-task-acceptance]'));
  } finally { await cdp?.detach(); await page.close(); }
});

test('native touch pans the step list and taps a chooser without starting an avatar gesture', async () => {
  const page = await mount({ touch: true, longList: true }); let cdp; try {
    cdp = await page.createCDPSession();
    const body = await page.$eval('.modal-panel__body', el => el.getBoundingClientRect().toJSON());
    const x = body.left + 30, startY = body.bottom - 60, endY = body.top + 100;
    const before = await page.$eval('.modal-panel__body', el => el.scrollTop);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
    for (let step = 1; step <= 10; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY + (endY - startY) * step / 10 }] });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(before => document.querySelector('.modal-panel__body').scrollTop > before + 60, {}, before);
    await page.waitForFunction(() => {
      const y = document.querySelector('.modal-panel__body').scrollTop, now = performance.now();
      if (!window.panSettled || window.panSettled.y !== y) { window.panSettled = { y, since: now }; return false; }
      return now - window.panSettled.since >= 120;
    });
    assert.equal(await page.$('.task-allocation__ghost'), null); assert.equal(await page.$('.task-detail-profile-preview'), null);
    assertNoWrites();
    await page.$eval('[data-acceptance-target="24"]', el => el.scrollIntoView({ block: 'center' }));
    async function tap(selector) {
      const box = await (await page.$(selector)).boundingBox();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await tap('[data-acceptance-target="24"]'); await page.waitForSelector('[data-acceptance-picker]');
    await tap('[data-acceptance-choice="2"]');
    assert.equal(await page.$eval('[data-acceptance-target="24"]', el => el.dataset.assignee), '2');
    assert.equal(await page.$('.task-allocation__ghost'), null); assert.equal(await page.$('.task-detail-profile-preview'), null);
    assertNoWrites();
  } finally { await cdp?.detach(); await page.close(); }
});

test('supplied canonical photos appear in strip, chooser and assignment while remote photo URLs stay initials', async () => {
  const page = await mount({ photos: true }); try {
    assert.equal(await page.$eval('[data-acceptance-person="3"] img', el => el.getAttribute('src')), authorizedPhoto);
    assert.equal(await page.$eval('[data-acceptance-person="3"] img', async el => { await el.decode(); return el.naturalWidth; }), 1);
    assert.equal(await page.$('[data-acceptance-person="2"] img'), null);
    await page.click('[data-acceptance-target="10"]');
    assert.equal(await page.$eval('[data-acceptance-choice="3"] img', el => el.getAttribute('src')), authorizedPhoto);
    assert.equal(await page.$eval('[data-acceptance-choice="3"] img', async el => { await el.decode(); return el.naturalWidth; }), 1);
    assert.equal(await page.$('[data-acceptance-choice="2"] img'), null);
    await page.click('[data-acceptance-choice="3"]');
    assert.equal(await page.$eval('[data-acceptance-target="10"] img', el => el.getAttribute('src')), authorizedPhoto);
    assert.equal(await page.$eval('[data-acceptance-target="10"] img', async el => { await el.decode(); return el.naturalWidth; }), 1);
    await choose(page, 10, 2);
    assert.equal(await page.$('[data-acceptance-target="10"] img'), null);
    assert.equal(await page.$eval('[data-acceptance-target="10"]', el => el.textContent), 'AS');
    assert.ok(page.imageRequests.every(url => url.startsWith('data:image/')), 'photos never trigger a profile or remote image fetch');
    assert.ok(!requests.some(req => /profile|birth|contact|avatar/.test(req.path))); assertNoWrites();
  } finally { await page.close(); }
});

test('protected step labels retain Unchanged without exposing server reason codes', async () => {
  const page = await mount({ rawReason: true }); try {
    const target = await page.$eval('[data-acceptance-target="11"]', el => ({ label: el.getAttribute('aria-label'), title: el.title, disabled: el.disabled }));
    assert.equal(target.disabled, true); assert.ok(target.label.includes('Unchanged'));
    assert.ok(!target.label.includes('already_assigned')); assert.ok(!target.title.includes('already_assigned'));
    assertNoWrites();
  } finally { await page.close(); }
});

test('browser Back closes only the chooser and preserves the acceptance draft and target focus', async () => {
  const page = await mount(); try {
    await handleBrowserBack(page); await choose(page, 10, 2);
    await page.click('[data-acceptance-target="12"]');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => window.overlayBackResults.length === 1);
    await page.waitForSelector('[data-acceptance-picker]', { hidden: true });
    assert.ok(await page.$('[data-task-acceptance]'), 'Back preserves the acceptance dialog');
    assert.equal(await page.$eval('[data-acceptance-target="10"]', el => el.dataset.assignee), '2');
    assert.equal(await page.$eval('[data-acceptance-target="12"]', el => el === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => window.overlayBackResults), [true]);
    await page.waitForFunction(() => history.state?.overlay === true);
    assertNoWrites();
    await page.evaluate(() => history.back());
    await page.waitForSelector('[data-task-acceptance]', { hidden: true });
    assert.equal(await page.evaluate(async () => (await import('/utils/overlay-history.js')).hasOpenOverlay()), false, 'one further Back closes the parent, without a phantom picker entry');
    assertNoWrites();
  } finally { await page.close(); }
});

for (const dismissal of ['Escape', 'outside', 'selection', 'auth']) test(`picker dismissal by ${dismissal} leaves no orphan overlay history`, async () => {
  const page = await mount(); try {
    await handleBrowserBack(page); await choose(page, 10, 2); await page.click('[data-acceptance-target="12"]');
    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else if (dismissal === 'outside') await page.click('[data-acceptance-next]');
    else if (dismissal === 'selection') await page.click('[data-acceptance-choice="1"]');
    else await page.evaluate(() => window.dispatchEvent(new Event('auth:context-ending')));
    await page.waitForSelector('[data-acceptance-picker]', { hidden: true });
    if (dismissal !== 'auth') {
      assert.ok(await page.$('[data-task-acceptance]'));
      assert.equal(await page.$eval('[data-acceptance-target="10"]', el => el.dataset.assignee), '2');
      await page.evaluate(() => history.back());
    }
    await page.waitForSelector('[data-task-acceptance]', { hidden: true });
    assert.equal(await page.evaluate(async () => (await import('/utils/overlay-history.js')).hasOpenOverlay()), false);
    await page.waitForFunction(() => history.state?.overlay !== true);
    assertNoWrites();
  } finally { await page.close(); }
});

for (const [width, height] of [[390, 844], [844, 390]]) test(`reopening an assigned chooser keeps its last recipient focus visible at ${width}x${height}`, async () => {
  const page = await mount({ width, height, manyPeople: true }); try {
    await choose(page, 10, 11);
    const beforeOpen = await page.$eval('.modal-panel__body', el => el.scrollTop);
    await page.click('[data-acceptance-target="10"]');
    const result = await page.$eval('[data-acceptance-picker]', panel => {
      const chosen = panel.querySelector('[data-acceptance-choice="11"]');
      const bounds = panel.getBoundingClientRect(), button = chosen.getBoundingClientRect();
      return { focused: chosen === document.activeElement, top: button.top, bottom: button.bottom, panelTop: bounds.top, panelBottom: bounds.bottom, parentScroll: document.querySelector('.modal-panel__body').scrollTop };
    });
    assert.equal(result.focused, true);
    assert.ok(result.top >= result.panelTop && result.bottom <= result.panelBottom, `focused recipient must be within the picker: ${JSON.stringify(result)}`);
    assert.equal(result.parentScroll, beforeOpen, 'revealing the selected recipient only scrolls the picker');
    const parentScroll = result.parentScroll;
    await page.keyboard.press('Escape'); await page.click('[data-acceptance-target="10"]');
    assert.equal(await page.$eval('.modal-panel__body', el => el.scrollTop), parentScroll, 'scrolling the selected choice does not move the acceptance body');
    assertNoWrites();
  } finally { await page.close(); }
});
