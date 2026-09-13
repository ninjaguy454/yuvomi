import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Actual browser components and native form events; only the network boundary
// is a fixture. Database/resolver behavior is covered by domain/route tests.
const users = [{ id: 1, display_name: 'Alex', role: 'admin' }, { id: 2, display_name: 'Sam', role: 'member' }];
const places = [{ id: 4, name: 'Home', type: 'home' }, { id: 5, name: 'Workplace', type: 'work' }];
const shift = { id: 7, name: 'Night work', short_code: 'N', start_time: '22:00', end_time: '06:00', color: '#4338CA', availability_state: 'busy', place_id: 5, created_by: 1 };
let patterns, types, overrides, requests;
const reset = () => {
  types = [{ ...shift }]; overrides = []; requests = [];
  patterns = [{ id: 10, user_id: 1, name: 'Existing four on four off', anchor_date: '2026-09-07', cycle_length: 8, is_active: 1,
    days: Array.from({ length: 7 }, (_, position) => ({ position, shift_type_id: position < 4 ? 7 : null })) }];
};
const app = express();
const shellStyles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
app.use(express.json());
app.use('/api/v1', (req, res) => {
  requests.push({ method: req.method, path: req.path, query: req.query, body: req.body });
  if (req.path === '/auth/me') return res.json({ user: users[0] });
  if (req.path === '/auth/users') return res.json({ data: users });
  if (req.path === '/planning/places') return res.json({ data: places });
  if (req.path === '/planning/admin/context') return res.json({ members: users, places, rules: [{ id: 3, user_id: 1, display_name: 'Alex', name: 'School run', weekdays: [1, 2, 3, 4, 5], start_time: '08:00', end_time: '09:00', state: 'busy', active: 1 }], periods: [] });
  if (req.path.startsWith('/planning/availability/') || req.path.startsWith('/planning/presence/')) return res.json({ data: {
    timezone: 'America/New_York', reason: 'A continuous 30-minute eligible window is available.', effective: { state: 'busy' },
    windows: [{ start_at: '2026-09-08T04:00:00Z', end_at: '2026-09-08T10:00:00Z', state: 'busy', reason: 'Night work makes this window unavailable.', eligible: false, availability_usable: false, confirmed_available: false, expected_place: places[1] },
      { start_at: '2026-09-08T10:00:00Z', end_at: '2026-09-09T04:00:00Z', state: 'unknown', reason: 'No planned restriction.', eligible: true, availability_usable: true, confirmed_available: false }],
    current_presence: { place: places[1], source: 'rotating', reason: 'Believed location from Night work; this does not imply spare time.', at: '2026-09-08T05:00:00Z', inferred: true },
    routine_explanations: [{ date_key: '2026-09-08', reason: 'Day off this routine; other commitments still apply.' }],
  } });
  const path = req.path.replace('/planning/routines', '');
  if (path === '/shift-types') {
    if (req.method === 'POST') { types.push({ id: 20, created_by: 1, ...req.body }); return res.json({ data: types.at(-1) }); }
    return res.json({ data: types });
  }
  if (path === '/patterns') {
    if (req.method === 'POST') { patterns.push({ id: 20, ...req.body }); return res.json({ data: patterns.at(-1) }); }
    return res.json({ data: patterns.map(({ days, ...pattern }) => pattern) });
  }
  const daysMatch = path.match(/^\/patterns\/(\d+)\/days$/);
  if (daysMatch) return res.json({ data: patterns.find((p) => p.id === Number(daysMatch[1]))?.days || [] });
  const patternMatch = path.match(/^\/patterns\/(\d+)$/);
  if (patternMatch && req.method === 'PUT') {
    const pattern = patterns.find((p) => p.id === Number(patternMatch[1])); Object.assign(pattern, req.body);
    return res.json({ data: pattern });
  }
  if (path === '/overrides') return res.json({ data: overrides });
  if (path.startsWith('/overrides/') && req.method === 'PUT') {
    overrides = [{ id: 30, date_key: path.split('/').at(-1), ...req.body }]; return res.json({ data: overrides[0] });
  }
  if (path === '/entries') return res.json({ data: { entries: [], warnings: [] } });
  return res.json({ data: [] });
});
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/availability-test', (_req, res) => res.send(`<!doctype html><html lang="en" data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">${shellStyles}<link rel="stylesheet" href="/styles/settings.css"><link rel="stylesheet" href="/styles/schedule.css"></head><body><main id="fixture" class="settings-card settings-card--automation"></main></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.beforeEach(reset);
test.after(async () => { await browser?.close(); await new Promise((resolve) => server?.close(resolve) || resolve()); });
async function mounted({ manager = false, userId = 1, width = 1366 } = {}) {
  const context = await browser.createBrowserContext(); const page = await context.newPage();
  await page.setViewport({ width, height: 1000 }); page.setDefaultTimeout(7000);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.errors = []; page.on('pageerror', (error) => page.errors.push(error.message));
  await page.goto(`${base}/availability-test`);
  await page.evaluate(async ({ manager, user, places }) => {
    localStorage.setItem('yuvomi-lang', 'en'); window.toasts = [];
    window.yuvomi = { showToast: (message) => window.toasts.push(message), user };
    const { setPermissions } = await import('/permissions.js');
    setPermissions({ admin: user.role === 'admin', capabilities: { 'availability.manage_own': 'allow' } });
    const { initI18n, setLocale } = await import('/i18n.js'); await initI18n(); await setLocale('en');
    await import('/components/datepicker.js');
    if (manager) {
      const { renderAvailabilityManager } = await import('/components/activity-automation.js');
      window.disposeFixture = await renderAvailabilityManager(document.querySelector('#fixture'), { user, navigate: async () => {} });
    } else {
      const { renderAvailabilityRoutines } = await import('/pages/schedule.js');
      window.disposeFixture = await renderAvailabilityRoutines(document.querySelector('#fixture'), { user, places });
    }
  }, { manager, user: users.find((user) => user.id === userId), places });
  assert.deepEqual(page.errors, []); page.dispose = () => context.close(); return page;
}
async function set(page, selector, value) {
  await page.$eval(selector, (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }, value);
}

test('existing rosters stay visible with missing days distinct from explicit days off and save atomically after shrinking', async () => {
  const page = await mounted();
  try {
    assert.match(await page.$eval('#fixture', (el) => el.textContent), /Existing four on four off/);
    assert.equal(await page.$('#schedule-fab'), null);
    await page.click('[data-pattern="10"] > summary');
    assert.equal(await page.$eval('[data-day="4"]', (el) => el.value), '');
    assert.equal(await page.$eval('[data-day="7"]', (el) => el.value), '__unconfigured__');
    await set(page, '[name="cycle_length"]', '4');
    assert.equal(await page.$$eval('[data-day]', (els) => els.length), 4);
    await page.click('[data-form="pattern-update"] button[type="submit"], [data-form="pattern-update"] button:not([type])');
    await page.waitForFunction(() => window.toasts.includes('Saved.'));
    const saved = requests.find((request) => request.method === 'PUT' && request.path === '/planning/routines/patterns/10');
    assert.equal(saved.body.cycle_length, 4); assert.equal(saved.body.days.length, 4);
    assert.deepEqual(saved.body.days.map((day) => day.shift_type_id), [7, 7, 7, 7]);
    assert.equal(saved.body.routine_mode, undefined);
    assert.ok(!requests.some((request) => request.path.startsWith('/schedule')));
    assert.deepEqual(page.errors, []);
  } finally { await page.dispose(); }
});

test('routine creation exposes Week A/B and every day before saving; advanced rotation preserves explicit assignments only', async () => {
  const page = await mounted();
  try {
    await page.click('[data-routine-add]'); await page.waitForSelector('#schedule-create-form');
    assert.equal(await page.$$eval('#schedule-create-form [data-day]', (els) => els.length), 14);
    assert.match(await page.$eval('#schedule-create-form', (el) => el.textContent), /Week A.*Week B/s);
    assert.equal(await page.$eval('#schedule-create-form [data-cycle-length]', (el) => el.hidden), true);
    await set(page, '#schedule-create-form [name="name"]', 'Four on four off');
    await page.select('#schedule-create-form [name="routine_mode"]', 'rotating');
    await set(page, '#schedule-create-form [name="cycle_length"]', '8');
    for (let day = 0; day < 4; day++) await page.select(`#schedule-create-form [data-day="${day}"]`, '7');
    for (let day = 4; day < 7; day++) await page.select(`#schedule-create-form [data-day="${day}"]`, '');
    await page.click('#schedule-create-form button[type="submit"]');
    await page.waitForFunction(() => window.toasts.includes('Saved.'));
    const saved = requests.find((request) => request.method === 'POST' && request.path === '/planning/routines/patterns');
    assert.equal(saved.body.cycle_length, 8); assert.equal(saved.body.days.length, 7);
    assert.deepEqual(saved.body.days.map((day) => day.shift_type_id), [7, 7, 7, 7, null, null, null]);
    assert.deepEqual(page.errors, []);
  } finally { await page.dispose(); }
});

test('time range availability effect and Place survive native form submission; routine exception can explicitly remove its restriction', async () => {
  const page = await mounted();
  try {
    await page.click('[data-tab="shifts"]'); await page.click('[data-routine-add]');
    await set(page, '#schedule-create-form [name="name"]', 'At work');
    await set(page, '#schedule-create-form [name="start_time"]', '22:00'); await set(page, '#schedule-create-form [name="end_time"]', '06:00');
    await page.select('#schedule-create-form [name="availability_state"]', 'busy'); await page.select('#schedule-create-form [name="place_id"]', '5');
    await page.click('#schedule-create-form button[type="submit"]'); await page.waitForFunction(() => window.toasts.includes('Saved.'));
    const saved = requests.find((request) => request.method === 'POST' && request.path.endsWith('/shift-types'));
    assert.equal(saved.body.start_time, '22:00'); assert.equal(saved.body.end_time, '06:00'); assert.equal(saved.body.availability_state, 'busy'); assert.equal(saved.body.place_id, 5);
    await page.click('[data-tab="overrides"]'); await page.click('[data-routine-add]');
    await set(page, '#schedule-create-form [name="date_key"]', '2026-09-08'); await page.select('#schedule-create-form [name="shift_type_id"]', '');
    await page.click('#schedule-create-form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#schedule-create-form'));
    assert.equal(requests.find((request) => request.method === 'PUT' && request.path.endsWith('/overrides/2026-09-08')).body.shift_type_id, null);
    assert.deepEqual(page.errors, []);
  } finally { await page.dispose(); }
});

test('Availability retains weekly routines and shows timezone-correct reasons independently from current inferred location', async () => {
  const page = await mounted({ manager: true });
  try {
    const text = await page.$eval('#fixture', (el) => el.textContent);
    assert.match(text, /Weekly routines/); assert.match(text, /School run/); assert.match(text, /Current household location/);
    assert.match(text, /Expected location: Workplace/); assert.match(text, /Availability now: busy/);
    assert.match(text, /Night work makes this window unavailable/); assert.match(text, /Day off this routine; other commitments still apply/);
    assert.match(text, /Times shown in America\/New_York/);
    const firstWindow = await page.$eval('.availability-window strong', (el) => el.textContent);
    assert.match(firstWindow, /(?:12:00|00:00).*06:00/);
    assert.match(await page.$eval('.availability-window:last-child strong', (el) => el.textContent), /\(next day\)/);
    assert.match(await page.$eval('.availability-window', (el) => el.textContent), /Unavailable for this window/);
    const explanationRequest = requests.find((request) => request.path.startsWith('/planning/availability/'));
    assert.equal(explanationRequest.query.policy, 'available_before_due');
    assert.equal(explanationRequest.query.window_mode, 'completion');
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(page.errors, []);
  } finally { await page.dispose(); }
});

test('member mount retains own routine access while other people’s saved day assignments are read-only', async () => {
  const page = await mounted({ manager: true, userId: 2 });
  try {
    await page.click('[data-pattern="10"] > summary');
    assert.equal(await page.$('[data-form="pattern-update"]'), null);
    assert.equal(await page.$eval('[data-day="0"]', (el) => el.disabled), true);
    await page.click('[data-routine-add]');
    assert.deepEqual(await page.$$eval('#schedule-create-form [name="user_id"] option', (options) => options.map((el) => el.value)), ['2']);
    assert.ok(!requests.some((request) => request.path === '/planning/admin/context'));
    assert.deepEqual(page.errors, []);
  } finally { await page.dispose(); }
});
