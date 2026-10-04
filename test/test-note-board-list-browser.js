import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Real Notes renderer, CSS, Markdown and permission store; only the HTTP API is a fixture.
const app = express();
let browser, server, base, notes, writes, reads;
const tail = 'PRIVATE_TAIL_ONLY_AFTER_EXPANDING';
const original = [
  { id: 1, title: 'Private instructions', content: `**Family** 🐈 ${'🌼'.repeat(220)}\n\n- [ ] Feed pets\n\n[Family guide](https://example.test/guide)\n\n${tail}\n\n<script>window.noteInjection = true</script>`, color: '#C7DED9', pinned: 1, created_by: 1, creator_name: 'Parent', visibility: 'private', access_user_ids: [], revision: 4, permissions: { view: true, edit: true, delete: true, manage_visibility: true }, layout: { x: 2, y: 3, width: 5, height: 7, revision: 2 } },
  { id: 2, title: 'Household plan', content: `Second note ${'long '.repeat(65)}SECOND_PRIVATE_TAIL`, color: '#EFE3BE', creator_name: 'Parent', visibility: 'all', revision: 1, permissions: { view: true, edit: true, delete: true }, layout: { x: 8, y: 30, width: 4, height: 6, revision: 0 } },
  { id: 3, title: '', content: 'An untitled reminder.', color: '#EFE3BE', visibility: 'all', revision: 1, permissions: { view: true, edit: true, delete: true }, layout: { x: 1, y: 45, width: 3, height: 4, revision: 0 } },
];
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m => `<link rel="stylesheet" href="${m[1]}">`).join('');
app.get('/list-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ csrfToken: 'fixture' });
  if (req.path === '/notes/members') return res.json({ data: [{ id: 1, display_name: 'Parent' }] });
  if (req.path === '/notes/changes') return res.status(204).end();
  if (req.path === '/notes' && req.method === 'GET') { reads++; return res.json({ data: structuredClone(notes) }); }
  if (req.method !== 'GET') writes.push({ path: req.path, method: req.method, body: req.body });
  const note = notes.find(n => n.id === Number(req.path.split('/')[2]));
  if (req.path.endsWith('/check') && note) {
    const lines = note.content.split('\n');
    lines[req.body.line] = lines[req.body.line].replace('- [ ]', '- [x]');
    note.content = lines.join('\n'); note.revision++;
    return res.json({ data: note });
  }
  if (req.path.endsWith('/layout') && note) {
    note.layout = { ...note.layout, ...req.body.layout, ...Object.fromEntries(['position_locked','always_on_top'].filter(key => key in req.body).map(key => [key, req.body[key]])), revision: note.layout.revision + 1 };
    return res.json({ data: note.layout });
  }
  return res.json({ data: [] });
});
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function mount(width = 360, height = 840, role = 'admin') {
  notes = structuredClone(original); writes = []; reads = 0;
  if (role !== 'admin') for (const note of notes) note.permissions = { view: true, edit: false, delete: false, manage_visibility: false };
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setViewport({ width, height }); await page.goto(base + '/list-test');
  await page.evaluate(async role => {
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    window.yuvomi = { showToast() {} };
    (await import('/permissions.js')).setPermissions(role === 'admin' ? { admin: true } : role === 'read' ? { modules: { notes: 'read' } } : { principal_kind: 'device', modules: { notes: 'read' }, capabilities: { 'device_notes.view': 'allow', 'device_notes.create': 'allow' } });
    window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 1 } });
  }, role);
  return page;
}
async function view(page, expected) {
  assert.equal(await page.$eval('#notes-grid', el => el.dataset.boardView), expected);
}
async function refresh(page) {
  const before = reads;
  const response = page.waitForResponse(response => response.url() === base + '/api/v1/notes' && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await (await response).json();
  assert.ok(reads > before, 'focus revalidates Notes');
  // Give the renderer the response plus two animation frames to repaint.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const card = id => `.note-card[data-id="${id}"]`;
const body = id => `${card(id)} .note-card__content`;
const expand = id => `${card(id)} [data-note-expand]`;

for (const [width, height, expected] of [[320, 740, 'list'], [360, 840, 'list'], [390, 844, 'list'], [430, 932, 'list'], [752, 835, 'canvas'], [1280, 900, 'canvas']]) {
  test(`${width}x${height} chooses ${expected} with all notes reachable`, async () => {
    const page = await mount(width, height);
    try {
      await view(page, expected);
      assert.equal(await page.$eval('#notes-compact-view', el => el.hidden), expected === 'list');
      assert.equal(await page.$eval('#notes-compact-view', el => el.getAttribute('aria-label')), 'List view');
      assert.equal(await page.$('#notes-board-hint'), null);
      assert.equal(await page.$$eval('.note-card', els => els.length), 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      if (expected === 'list') {
        assert.equal(await page.$('[data-board-handle]'), null);
        const positions = await page.$$eval('.note-card', els => els.map(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })));
        assert.ok(positions[1].top >= positions[0].bottom - 1, 'list rows do not overlap');
        assert.ok(positions[1].top - positions[0].bottom < 40, 'canonical board gaps do not become list gaps');
        await page.$eval(card(3), el => el.scrollIntoView({ block: 'center' }));
        assert.ok(await page.$eval(card(3), el => el.getBoundingClientRect().top < innerHeight));
      }
      assert.equal(writes.length, 0);
    } finally { await page.close(); }
  });
}

test('usable board width decides the 640px boundary and viewport transitions retain canonical geometry', async () => {
  const page = await mount(1280);
  try {
    await view(page, 'canvas');
    const geometry = await page.$$eval('.note-card', els => els.map(el => ({ id: el.dataset.id, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height })));
    const canonical = structuredClone(notes.map(note => note.layout));
    await page.click('#notes-compact-view'); await view(page, 'list');
    assert.equal(await page.$('#notes-board-hint'), null);
    await page.click('#notes-compact-view'); await view(page, 'canvas');
    await page.$eval('.notes-scroll', el => { el.style.paddingInline = '0'; el.style.width = '639px'; });
    assert.equal(await page.$eval('.notes-scroll', el => el.clientWidth), 639);
    await page.waitForFunction(() => document.querySelector('#notes-grid').dataset.boardView === 'list');
    assert.equal(await page.$eval('#notes-grid', el => el.clientWidth), 639);
    await page.$eval('.notes-scroll', el => el.style.width = '640px');
    await page.waitForFunction(() => document.querySelector('#notes-grid').dataset.boardView === 'canvas');
    await page.$eval('.notes-scroll', el => { el.style.removeProperty('width'); el.style.removeProperty('padding-inline'); });
    await page.setViewport({ width: 360, height: 840 });
    await page.waitForFunction(() => document.querySelector('#notes-grid').dataset.boardView === 'list');
    await page.select('#notes-list-density', 'compact'); await page.select('#notes-list-density', 'expanded');
    await page.setViewport({ width: 1280, height: 900 });
    await page.waitForFunction(() => document.querySelector('#notes-grid').dataset.boardView === 'canvas');
    assert.deepEqual(await page.$$eval('.note-card', els => els.map(el => ({ id: el.dataset.id, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height }))), geometry);
    assert.deepEqual(notes.map(note => note.layout), canonical);
    assert.equal(writes.length, 0, 'projection and density changes never write layout');
  } finally { await page.close(); }
});

test('explicit List view restores its desktop toggle after phone density changes', async () => {
  const page = await mount(1280, 900);
  try {
    await view(page, 'canvas');
    const geometry = await page.$$eval('.note-card', els => els.map(el => ({ id: el.dataset.id, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height })));
    const canonical = structuredClone(notes.map(note => note.layout));
    await page.click('#notes-compact-view');
    await view(page, 'list');
    await page.setViewport({ width: 360, height: 840 });
    await page.select('#notes-list-density', 'compact');
    assert.equal(await page.$eval('#notes-compact-view', el => el.hidden), true, 'phone density repaint hides the redundant list toggle');
    await page.setViewport({ width: 1280, height: 900 });
    // Observe the resize itself; a later live refresh must not rescue a stale toolbar.
    await page.waitForFunction(() => !document.querySelector('#notes-compact-view').hidden, { timeout: 1000 });
    await view(page, 'list');
    assert.equal(await page.$eval('#notes-list-density', el => el.value), 'compact');
    assert.equal(await page.$eval('#notes-compact-view', el => el.getAttribute('aria-pressed')), 'true');
    await page.click('#notes-compact-view');
    await view(page, 'canvas');
    assert.deepEqual(await page.$$eval('.note-card', els => els.map(el => ({ id: el.dataset.id, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height }))), geometry);
    assert.deepEqual(notes.map(note => note.layout), canonical);
    assert.equal(writes.length, 0, 'explicit List view, resizing and density changes never write geometry');
  } finally { await page.close(); }
});

test('Expanded list caps visible Unicode preview at 200 and Show more reveals safe Markdown without opening a modal', async () => {
  const page = await mount();
  try {
    assert.equal(await page.$eval('#notes-list-density', el => el.value), 'expanded');
    const preview = await page.$eval(body(1), el => el.textContent);
    assert.ok([...preview.replace(/…$/, '')].length <= 200, 'preview budget counts visible Unicode characters');
    assert.ok(!preview.includes('\ufffd'), 'no split surrogate pairs');
    assert.ok(!(await page.$eval(card(1), el => el.innerHTML)).includes(tail), 'collapsed DOM does not retain hidden tail');
    assert.match(await page.$eval(expand(1), el => el.textContent), /show more/i);
    await page.click(expand(1));
    assert.equal(await page.$('.note-modal'), null);
    assert.ok((await page.$eval(body(1), el => el.textContent)).includes(tail));
    assert.ok(await page.$(`${body(1)} strong`));
    assert.equal(await page.$eval(`${body(1)} a`, el => el.href), 'https://example.test/guide');
    assert.equal(await page.$(`${body(1)} script`), null);
    assert.equal(await page.evaluate(() => window.noteInjection), undefined);
    assert.match(await page.$eval(expand(1), el => el.textContent), /show less/i);
    await page.click(expand(1));
    assert.ok(!(await page.$eval(card(1), el => el.innerHTML)).includes(tail));
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('Compact density is title-only and numeric adjustment is accessible outside the ordinary menu', async () => {
  const page = await mount();
  try {
    await page.select('#notes-list-density', 'compact');
    assert.ok(await page.$eval(`${card(3)} .note-card__title`, el => el.textContent.trim().length > 0));
    assert.equal(await page.$$eval('.note-card__content', els => els.map(el => el.textContent.trim()).join('')), '', 'Compact does not retain hidden note bodies');
    assert.equal(await page.$('[data-note-expand]'), null);
    assert.ok(!(await page.$eval('#notes-grid', el => el.textContent)).includes('An untitled reminder.'));
    assert.equal(await page.$('[data-board-handle]'), null);
    const menu = `${card(1)} details[data-board-menu]`;
    assert.ok(await page.$(`${menu} summary`));
    assert.ok(await page.$eval(`${menu} summary`, el => !!(el.getAttribute('aria-label') || el.textContent).trim()));
    assert.equal(await page.$(`${menu} [data-board-action="adjust"]`), null);
    await page.focus(`${menu} summary`); await page.keyboard.press('Enter');
    assert.equal(await page.$eval(menu, el => el.open), true);
    assert.equal(await page.$('.note-modal'), null);
    await page.focus(`${card(1)} [data-board-action="adjust"]`); await page.keyboard.press('Enter'); await page.waitForSelector('#note-layout-width');
    assert.equal(await page.$eval('#note-layout-width', el => el.value), '5');
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('narrow header keeps Search on title row, hides organize and removes duplicate open glyph', async () => {
  const page = await mount(320);
  try {
    const positions = await page.evaluate(() => {
      const title = document.querySelector('.notes-toolbar h1').getBoundingClientRect();
      const search = document.querySelector('.notes-toolbar__search').getBoundingClientRect();
      return { titleBottom: title.bottom, titleTop: title.top, searchBottom: search.bottom, searchTop: search.top };
    });
    assert.ok(positions.searchTop < positions.titleBottom && positions.titleTop < positions.searchBottom, 'Search shares title row');
    assert.equal(await page.$eval('#notes-organize', n => n.hidden || n.getClientRects().length === 0), true);
    assert.equal(await page.$('.note-card__open'), null);
    assert.equal(await page.$eval(expand(1), n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)', 'inline expansion has no filled button surface');
    await page.focus(`${card(1)} [data-action="open"]`); await page.keyboard.press('Enter');
    assert.ok(await page.$('.note-modal[data-view="read"]'), 'title remains keyboard-accessible');
  } finally { await page.close(); }
});

test('position lock and always-on-top persist separately from dashboard pin', async () => {
  const page = await mount(1280);
  try {
    const lock = `${card(1)} [data-board-action="lock"]`;
    assert.equal(await page.$eval(lock, n => n.getAttribute('aria-pressed')), 'false', 'old dashboard pin does not imply position lock');
    await page.click(lock);
    await page.waitForFunction(() => document.querySelector('[data-board-action="lock"]').getAttribute('aria-pressed') === 'true');
    assert.equal(writes[0].body.position_locked, true);
    assert.equal(notes[0].pinned, 1);
    assert.equal(writes[0].body.expected_layout_revision, 2);
    await page.click(`${card(1)} summary`);
    assert.equal(await page.$eval(`${card(1)} [data-action="pin"]`, n => n.textContent.trim().replace(/^✓\s*/, '')), 'Show on Dashboard');
    await page.click(`${card(1)} [data-board-action="top"]`);
    await page.waitForFunction(() => document.querySelector('[data-board-action="top"]').getAttribute('aria-pressed') === 'true');
    assert.equal(writes[1].body.always_on_top, true);
    assert.equal(writes[1].body.expected_layout_revision, 3);
    assert.equal(notes[0].pinned, 1);
    assert.equal(notes[0].layout.position_locked, true);
  } finally { await page.close(); }
});

for (const width of [360,1280]) test(`${width} cards and reader omit audience prose; edit retains audience selection`, async () => {
  const page = await mount(width);
  try {
    assert.equal(await page.$('.note-card__audience'), null);
    assert.ok(!(await page.$eval('#notes-grid', n => n.textContent)).includes('Only me'));
    await page.$eval(`${card(1)} [data-action="open"]`, n => n.click());
    assert.equal(await page.$('.note-read-view .note-audience-summary'), null);
    assert.equal(await page.$('.note-modal > .note-audience-summary'), null);
    await page.click('#note-tab-edit');
    assert.ok(await page.$('#note-visibility'), 'create/edit retains audience selection');
  } finally { await page.close(); }
});

test('expanded checklist preserves source line indices and expansion survives revalidation per note', async () => {
  const page = await mount();
  try {
    await page.click(expand(1));
    const line = original[0].content.split('\n').findIndex(text => text.startsWith('- [ ]'));
    assert.equal(await page.$eval(`${body(1)} .note-md-box`, el => Number(el.dataset.mdLine)), line);
    await page.click(`${body(1)} .note-md-box`);
    await page.waitForFunction(() => document.querySelector('.note-card[data-id="1"] .note-md-box').getAttribute('aria-checked') === 'true');
    for (let i = 0; writes.length === 0 && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(writes[0].path, '/notes/1/check'); assert.equal(writes[0].body.line, line); assert.equal(writes[0].body.expect, '- [ ] Feed pets');
    await refresh(page);
    assert.ok((await page.$eval(body(1), el => el.textContent)).includes(tail));
    assert.ok(!(await page.$eval(card(2), el => el.innerHTML)).includes('SECOND_PRIVATE_TAIL'));
    assert.equal(await page.$('.note-modal'), null);
  } finally { await page.close(); }
});

test('revocation removes expanded private content and ending authentication clears expansion state', async () => {
  const page = await mount();
  try {
    await page.click(expand(1));
    notes = notes.filter(note => note.id !== 1); await refresh(page);
    await page.waitForFunction(() => !document.querySelector('.note-card[data-id="1"]'));
    assert.ok(!(await page.$eval('#main-content', el => el.innerHTML)).includes(tail));
    await page.click(expand(2));
    await page.evaluate(() => window.dispatchEvent(new Event('auth:context-ending')));
    assert.equal(await page.$eval('#main-content', el => el.textContent), '');
    notes = structuredClone(original);
    await page.evaluate(async () => { window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 2 } }); });
    assert.ok(!(await page.$eval('#notes-grid', el => el.innerHTML)).includes('SECOND_PRIVATE_TAIL'));
    assert.ok(!(await page.$eval('#notes-grid', el => el.innerHTML)).includes(tail));
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const role of ['read', 'create-only']) test(`${role} list respects actual note and principal permissions`, async () => {
  const page = await mount(360, 840, role);
  try {
    await view(page, 'list');
    assert.equal(await page.$('[data-board-action="adjust"]'), null);
    assert.equal(await page.$('[data-board-handle]'), null);
    assert.equal(await page.$('#notes-organize'), null);
    assert.equal(await page.$('[data-action="delete"]'), null);
    await page.click(expand(1));
    assert.equal(await page.$(`${body(1)} button.note-md-box`), null);
    assert.equal(writes.length, 0);
    await page.select('#notes-list-density', 'compact');
    assert.equal(await page.$('[data-board-action="adjust"]'), null);
  } finally { await page.close(); }
});
