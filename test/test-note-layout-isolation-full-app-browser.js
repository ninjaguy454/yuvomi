/** Production shell/routes, real cookies/CSRF/SSE and a disposable encrypted DB.
 * Viewports emulate phone/desktop; this is not physical-device validation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-layout-isolation-browser-'));
process.env.DB_PATH = join(folder, 'notes.db');
Object.assign(process.env, { DB_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AUTH_ALLOW_PASSWORD_LOGIN: 'true', RATE_LIMIT_MAX_ATTEMPTS: '200', TRUST_PROXY: 'loopback',
  SESSION_SECRET: 'synthetic-layout-isolation-browser', SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error' });
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const d = get(), password = 'Synthetic-layout-isolation-2026!';
const output = process.env.NOTES_LAYOUT_ISOLATION_BROWSER_EVIDENCE || process.env.NOTES_LAYOUT_ISOLATION_EVIDENCE || join(folder, 'evidence');
mkdirSync(output, { recursive: true });
const evidence = { scope: 'Real app, encrypted synthetic DB, Chromium desktop/phone emulation', steps: [], errors: [], mutations: [], network: [] };
const pages = new Map();
let server, browser, origin, activePage, client = 0;
const seed = { x: 8.25, y: 12.125, width: 4, height: 6, position_locked: false, always_on_top: false };
const rectangle = value => Object.fromEntries(Object.keys(seed).map(key => [key, value[key]]));

test.before(async () => {
  const hash = await hashPassword(password, 4);
  for (const [id, name] of [[1, 'Layout One'], [2, 'Layout Two'], [3, 'Layout New']])
    d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,1)').run(id, name, name, hash, 'admin', 'parent');
  for (let id = 101; id <= 108; id++) {
    const privateNote = [105, 106].includes(id);
    d.prepare('INSERT INTO notes(id,title,content,visibility,created_by,pinned) VALUES(?,?,?,?,1,0)').run(id, `Isolation ${id}`, privateNote ? `PRIVATE isolation body ${id}` : `Shared isolation body ${id}`, privateNote ? 'private' : 'all');
    d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,position_locked,always_on_top) VALUES(?,?,?,?,?,0,0)').run(id, seed.x, Math.max(0, seed.y + (id - 103) * 8), seed.width, seed.height);
  }
  for (const [id, members, y] of [[11, [101, 102], 1.25], [12, [105, 106], 30.25]]) {
    d.prepare('INSERT INTO note_groups(id,x,y,width,height,position_locked,always_on_top) VALUES(?,0.5,?,4,6,1,0)').run(id, y);
    members.forEach((noteId, ordinal) => d.prepare('INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(?,?,?)').run(noteId, id, ordinal));
  }
  server = fork(new URL('./helpers/note-board-full-app-server.mjs', import.meta.url), [], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => log = (log + chunk).slice(-6000));
  origin = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log || 'Server did not start')), 60000); server.once('message', message => { clearTimeout(timer); resolve(message.origin); }); server.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${log}`)); }); });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
  assert.notEqual(readFileSync(process.env.DB_PATH).subarray(0, 16).toString(), 'SQLite format 3\0', 'fixture DB is encrypted');
});
test.afterEach(async context => {
  if (context.error) for (const [name, page] of pages) {
    evidence.steps.push({ failure: context.name, page: name, url: page.url(), body: await page.$eval('body', el => el.innerText.slice(-1600)).catch(() => '') });
    await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
  }
  for (const page of pages.values()) await page.browserContext().close(); pages.clear();
});
test.after(async () => {
  writeFileSync(join(output, 'results.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
  d.close(); rmSync(folder, { recursive: true, force: true });
});

async function pageFor(name, width = 1280) {
  const context = await browser.createBrowserContext(), page = await context.newPage(); pages.set(name, page);
  // Match the existing full-app multi-client fixtures: give each synthetic
  // browser its own rate-limit address while retaining actual auth cookies.
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.51.100.${++client}` });
  page.setDefaultTimeout(15000); await page.setViewport({ width, height: 960 });
  const cdp = await page.createCDPSession(); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => { localStorage.setItem('yuvomi-lang', 'en'); localStorage.setItem('yuvomi-locale', 'en'); Object.defineProperty(navigator, 'onLine', { get: () => true }); });
  await page.setRequestInterception(true); page.on('request', request => { const url = new URL(request.url()); if ((['http:', 'https:'].includes(url.protocol) && url.origin !== origin) || url.pathname === '/sw.js') return request.abort(); return request.continue(); });
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.lastNoteRead = 0;
  const noteRead = request => { if (new URL(request.url()).pathname === '/api/v1/notes/board') page.lastNoteRead = Date.now(); };
  page.on('request', noteRead); page.on('response', response => noteRead(response.request()));
  const trace = (phase, request, extra = {}) => { if (/^\/api\/v1\/notes\/(board|group-operations)$/.test(new URL(request.url()).pathname)) evidence.network.push({ page: name, phase, path: new URL(request.url()).pathname, type: request.resourceType(), time: Date.now(), ...extra }); };
  page.on('request', request => trace('request', request)); page.on('response', response => trace('response', response.request(), { status: response.status() }));
  page.on('requestfinished', request => trace('finished', request)); page.on('requestfailed', request => trace('failed', request, { error: request.failure()?.errorText }));
  page.on('request', request => { if (request.method() !== 'GET' && /\/notes\/.*(?:layout|group-operations)/.test(request.url())) evidence.mutations.push({ page: name, path: new URL(request.url()).pathname, body: request.postData() }); });
  return page;
}
async function field(page, selector, value) { await page.waitForSelector(selector); await page.$eval(selector, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(value)); }
// Activate the real DOM control through its production click handlers. Canvas
// controls can lie beyond the viewport and modal focus restoration can otherwise
// retarget Enter while switching between multiple genuine browser contexts.
// Observe actual requests/responses rather than outstanding request objects:
// Chromium can abandon those objects on a document navigation without emitting
// requestfinished. DOM readiness plus response quiescence is the relevant fence.
async function settleReads(page) { const deadline = Date.now() + 5000; while (Date.now() - page.lastNoteRead < 200) { assert.ok(Date.now() < deadline, 'real Notes reads settle before the next UI action'); await new Promise(resolve => setTimeout(resolve, 25)); } }
async function activate(page) { if (activePage === page) return; activePage = page; page.lastNoteRead = Date.now(); await page.bringToFront(); await settleReads(page); }
async function press(page, selector) { await activate(page); await page.waitForSelector(selector); await page.$eval(selector, el => el.click()); }
async function login(page, name) { await field(page, '#username', name); await field(page, '#password', password); const response = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/login') && r.request().method() === 'POST'); await press(page, '#auth-btn'); assert.equal((await response).status(), 200); await page.waitForSelector('.dashboard'); }
async function personal(name, username, width = 1280) { const page = await pageFor(name, width); await page.goto(origin + '/login'); await login(page, username); await notesPage(page); return page; }
async function notesPage(page, reload = false) {
  await activate(page);
  if (reload) { await page.goto(origin + '/notes'); await page.waitForSelector('.notes-page,.dashboard'); }
  if (!await page.$('.notes-page')) { await page.waitForFunction(() => typeof window.yuvomi?.navigate === 'function'); for (let attempt = 0; attempt < 30; attempt++) { await page.evaluate(() => window.yuvomi.navigate('/notes')); if (new URL(page.url()).pathname === '/notes') break; await new Promise(resolve => setTimeout(resolve, 100)); } }
  await page.waitForSelector('.notes-page'); await page.waitForFunction(() => !document.querySelector('#notes-grid[aria-busy]'));
  await settleReads(page);
}
const board = page => page.evaluate(async () => (await (await import('/api.js')).api.get('/notes/board')).data);
const noteLayout = async (page, id) => rectangle((await board(page)).notes.find(note => note.id === id).layout);
async function adjust(page, key, layout) {
  await press(page, `[data-board-key="${key}"] [data-board-menu] summary`); await press(page, `[data-board-key="${key}"] [data-board-action="adjust"]`);
  for (const [name, value] of Object.entries(layout)) await field(page, `#note-layout-${name}`, value);
  const response = page.waitForResponse(r => r.url().endsWith('/notes/group-operations') && r.request().method() === 'POST');
  await press(page, '#note-layout-save'); const result = await response; assert.equal(result.status(), 200, await result.text());
  await page.waitForFunction(() => !document.querySelector('#note-layout-save') && !!document.querySelector('[data-group-undo]'));
  await settleReads(page);
}
async function flag(page, key, name) {
  await activate(page); await settleReads(page);
  if (name === 'top') await press(page, `[data-board-key="${key}"] [data-board-menu] summary`);
  const expected = await page.$eval(`[data-board-key="${key}"] [data-board-action="${name}"]`, el => el.getAttribute('aria-pressed') !== 'true');
  const response = page.waitForResponse(r => r.url().endsWith('/notes/group-operations') && r.request().method() === 'POST');
  await press(page, `[data-board-key="${key}"] [data-board-action="${name}"]`); const result = await response; assert.equal(result.status(), 200, await result.text());
  await page.waitForFunction(({ key, name, expected }) => document.querySelector(`[data-board-key="${key}"] [data-board-action="${name}"]`)?.getAttribute('aria-pressed') === String(expected), {}, { key, name, expected });
  await settleReads(page);
}
async function assertCanvas(page, key, layout) {
  await page.waitForFunction(() => document.querySelector('#notes-grid')?.dataset.boardView === 'canvas');
  const actual = await page.$eval(`[data-board-key="${key}"]`, el => {
    const grid = el.closest('#notes-grid'), viewport = grid.closest('.notes-scroll'), css = getComputedStyle(viewport);
    const pitch = Math.max(640, viewport.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0)) / 12;
    const gap = parseFloat(getComputedStyle(grid).getPropertyValue('--space-3')) || 12;
    return { x: parseFloat(el.style.left) / pitch, y: parseFloat(el.style.top) / 48, width: (parseFloat(el.style.width) + gap) / pitch, height: (parseFloat(el.style.height) + gap) / 48,
      position_locked: el.querySelector('[data-board-action="lock"]')?.getAttribute('aria-pressed') === 'true', always_on_top: el.querySelector('[data-board-action="top"]')?.getAttribute('aria-pressed') === 'true' };
  });
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - layout[key]) < .001, `${key}: rendered ${actual[key]} expected ${layout[key]}`);
  for (const key of ['position_locked', 'always_on_top']) assert.equal(actual[key], layout[key], `${key} control reflects saved owner layout`);
}
async function overview(page, groupId) { await press(page, `[data-board-key="group:${groupId}"] [data-group-page="overview"]`); await page.waitForSelector('.note-group-overview'); }
async function groupOrder(page, groupId) { await overview(page, groupId); const ids = await page.$$eval('.note-group-overview__page[data-group-page]', els => els.map(el => Number(el.dataset.groupPage))); await page.keyboard.press('Escape'); await page.waitForSelector('.note-group-overview', { hidden: true }); return ids; }
async function selectPage(page, id) { if (await page.$eval('[data-group-selection-mode]', el => el.getAttribute('aria-pressed') === 'false')) await press(page, '[data-group-selection-mode]'); await press(page, `[data-group-select="${id}"]`); }
async function groupAction(page, action) { if (!await page.$eval('[data-group-menu]', el => el.open)) await press(page, '[data-group-menu] summary'); await press(page, `.note-group-overview [data-group-action="${action}"]`); }
async function confirmGroup(page) { const response = page.waitForResponse(r => r.url().endsWith('/notes/group-operations') && r.request().method() === 'POST'); await press(page, '[data-group-confirm]'); const result = await response; assert.equal(result.status(), 200, await result.text()); await page.waitForSelector('.note-group-overview', { hidden: true }); }
async function paired(name, admin, edit = true) {
  const page = await pageFor(name); await page.goto(origin + '/device/pair'); await press(page, '[data-pair-start]'); await page.waitForSelector('[data-pair-code]'); const code = await page.$eval('[data-pair-code]', el => el.textContent);
  const result = await admin.evaluate(async ({ code, name, edit }) => (await (await import('/api.js')).api.post('/devices/pairing-approve', { code, name, permissions: { capabilities: { 'device_notes.view': 'allow', 'device_notes.create': 'none', 'device_notes.edit': edit ? 'allow' : 'none', 'device_notes.delete': 'none' } } })), { code, name, edit });
  assert.ok(result); await page.waitForSelector('[data-pair-claim]'); await press(page, '[data-pair-claim]'); await page.waitForSelector('[data-device-login]'); await page.waitForSelector('.dashboard'); await notesPage(page);
  const context = await page.evaluate(async () => (await (await import('/api.js')).api.get('/device/context'))); assert.equal(context.principal.kind, 'device');
  return { page, id: context.principal.id };
}
async function temporary(page) { await press(page, '[data-device-login]'); await login(page, 'Layout One'); await page.waitForSelector('.nav-sidebar [data-device-return]'); await notesPage(page); const context = await page.evaluate(async () => (await (await import('/api.js')).api.get('/device/context'))); assert.ok(context.temporary); assert.equal(context.user.id, 1); }
async function assertNoPrivate(page) { assert.equal(await page.evaluate(() => document.body.textContent.includes('PRIVATE isolation body')), false); assert.equal(await page.$('.note-group-overview'), null); assert.equal(await page.$('.note-modal'), null); assert.equal(await page.$('[data-group-retry]'), null); const snapshot = await board(page); assert.ok(snapshot.notes.every(note => note.visibility === 'all')); assert.ok(!snapshot.groups.some(group => group.member_ids.some(id => [105, 106].includes(id)))); }

test('real personal desktop and phone share geometry; other and newly initialized humans retain the frozen seed', { timeout: 150000 }, async () => {
  const one = await personal('personal-one', 'Layout One'), two = await personal('personal-two', 'Layout Two');
  assert.deepEqual(await noteLayout(two, 103), seed);
  const changed = { x: 2.75, y: 4.125, width: 5, height: 7, position_locked: true, always_on_top: true };
  await adjust(one, 'note:103', { x: changed.x, y: changed.y, width: changed.width, height: changed.height }); await flag(one, 'note:103', 'lock'); await flag(one, 'note:103', 'top'); await notesPage(one, true);
  assert.deepEqual(await noteLayout(one, 103), changed); await assertCanvas(one, 'note:103', changed);
  await notesPage(two, true); assert.deepEqual(await noteLayout(two, 103), seed, 'different human must retain independent seed'); await assertCanvas(two, 'note:103', seed);
  const phone = await personal('personal-phone', 'Layout One', 390); assert.equal(await phone.$eval('#notes-grid', el => el.dataset.boardView), 'list'); assert.deepEqual(await noteLayout(phone, 103), changed);
  await phone.setViewport({ width: 1280, height: 960 }); await notesPage(phone, true); await assertCanvas(phone, 'note:103', changed);
  const fresh = await personal('new-human', 'Layout New'); assert.deepEqual(await noteLayout(fresh, 103), seed, 'new human cannot inherit another owner mutation');
  await adjust(fresh, 'note:104', { x: 6.5, y: 25.5 }); assert.deepEqual(await noteLayout(fresh, 103), seed, 'first write copies immutable seed');
  await one.screenshot({ path: join(output, 'personal-desktop.png') }); await phone.setViewport({ width: 390, height: 960 }); await notesPage(phone, true); await phone.screenshot({ path: join(output, 'personal-phone.png') });
  evidence.steps.push('Same human phone/desktop share fractional geometry, resize, canvas pin and top; distinct and newly initialized humans keep immutable seed');
});

test('real group overview order and extraction persist only for the acting human', { timeout: 150000 }, async () => {
  const one = await personal('group-one', 'Layout One'), two = await personal('group-two', 'Layout Two');
  assert.deepEqual(await groupOrder(two, 11), [101, 102]);
  await overview(one, 11); await selectPage(one, 102); await groupAction(one, 'order'); await one.select('[data-group-before]', '101'); await confirmGroup(one); await notesPage(one, true);
  assert.deepEqual(await groupOrder(one, 11), [102, 101]); await notesPage(two, true); assert.deepEqual(await groupOrder(two, 11), [101, 102], 'other human group order stays unchanged');
  await overview(one, 11); await selectPage(one, 102); await groupAction(one, 'remove'); await press(one, '[data-group-position] summary'); await field(one, '[data-group-x]', 14.25); await field(one, '[data-group-y]', 4.5); await confirmGroup(one); await notesPage(one, true);
  assert.equal(await one.$('[data-board-key="group:11"]'), null); assert.ok(await one.$('[data-board-key="note:101"]')); assert.ok(await one.$('[data-board-key="note:102"]'));
  const extracted = await noteLayout(one, 102); assert.equal(extracted.x, 14.25); assert.equal(extracted.y, 4.5); assert.equal(extracted.position_locked, false); await assertCanvas(one, 'note:102', extracted);
  await notesPage(two, true); assert.deepEqual(await groupOrder(two, 11), [101, 102]);
  const phone = await personal('group-phone', 'Layout One', 390); assert.equal(await phone.$('[data-board-key="group:11"]'), null); assert.ok(await phone.$('[data-board-key="note:102"]'));
  await two.screenshot({ path: join(output, 'other-human-group-seed.png') }); evidence.steps.push('Actual overview reorder/extraction persist after reload and same-human phone login; other human retains group membership/order');
});

test('real paired devices have independent layouts; temporary human login, return and expiry restore the device and clear private portals', { timeout: 240000 }, async () => {
  const admin = await personal('pair-admin', 'Layout One');
  const first = await paired('device-one', admin), second = await paired('device-two', admin);
  assert.notEqual(first.id, second.id, 'genuine backend identities distinguish paired devices');
  const original = { ...seed, y: seed.y + 32 }, changed = { ...original, x: 1.625, y: 7.375, width: 6, height: 8, position_locked: true, always_on_top: true };
  await adjust(first.page, 'note:107', { x: changed.x, y: changed.y, width: changed.width, height: changed.height }); await flag(first.page, 'note:107', 'lock'); await flag(first.page, 'note:107', 'top'); await notesPage(first.page, true); await assertCanvas(first.page, 'note:107', changed);
  await notesPage(second.page, true); assert.deepEqual(await noteLayout(second.page, 107), original, 'different paired device keeps its own seed'); await assertCanvas(second.page, 'note:107', original);
  await adjust(second.page, 'note:108', { x: 6.25, y: 50.5 }); assert.deepEqual(await noteLayout(second.page, 107), original, 'device first write copies frozen seed');
  await temporary(first.page); assert.deepEqual(await noteLayout(first.page, 107), original, 'temporary login uses human layout');
  await adjust(first.page, 'note:107', { x: 9.5, y: 18.25, width: 5, height: 9 }); const human = await noteLayout(first.page, 107);
  await notesPage(admin, true); assert.deepEqual(await noteLayout(admin, 107), human, 'ordinary human session sees temporary-session layout');
  await overview(first.page, 12); assert.equal(await first.page.evaluate(() => document.body.textContent.includes('PRIVATE isolation body')), true);
  await Promise.all([first.page.waitForNavigation({ waitUntil: 'domcontentloaded' }), first.page.evaluate(() => document.querySelector('.nav-sidebar [data-device-return]').click())]);
  await first.page.waitForSelector('[data-device-login]'); await first.page.waitForSelector('.dashboard'); await notesPage(first.page); await assertNoPrivate(first.page); assert.deepEqual(await noteLayout(first.page, 107), changed); await assertCanvas(first.page, 'note:107', changed);
  await temporary(first.page); assert.deepEqual(await noteLayout(first.page, 107), human); await overview(first.page, 12);
  const beforeExpiry = evidence.mutations.filter(item => item.page === 'device-one').length;
  // Advance only the synthetic credential's real persisted deadline. Actual route
  // revalidation and app context handling perform expiry; no synthetic auth event.
  d.prepare('UPDATE device_credentials SET temporary_started_at=? WHERE device_id=? AND temporary_sid IS NOT NULL').run(Date.now() - 3600000, first.id);
  await first.page.evaluate(async () => { try { await (await import('/api.js')).api.get('/notes/board'); } catch {} });
  await first.page.waitForFunction(() => !document.body.textContent.includes('PRIVATE isolation body') && !document.querySelector('.note-group-overview'));
  await first.page.waitForSelector('[data-device-login]'); await notesPage(first.page); await assertNoPrivate(first.page); assert.deepEqual(await noteLayout(first.page, 107), changed); await assertCanvas(first.page, 'note:107', changed);
  assert.equal(evidence.mutations.filter(item => item.page === 'device-one').length, beforeExpiry, 'expiry does not retry human mutations into device context');
  const readOnly = await paired('device-read-only', admin, false); assert.equal(await readOnly.page.$('[data-board-action="adjust"]'), null); await assertNoPrivate(readOnly.page);
  await first.page.screenshot({ path: join(output, 'device-after-expiry.png') }); evidence.steps.push('Two backend-paired devices keep independent arrangements; real temporary login shares human owner; return/real deadline expiry restore device layout and remove private group portal without retries; read-only device has no arrangement control');
  assert.deepEqual(evidence.errors, []); assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
