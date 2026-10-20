import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-calendar-places-'));
const dbPath = join(folder, 'synthetic.db');
Object.assign(process.env, { DB_PATH: dbPath, SESSION_SECRET: 'calendar-place-synthetic-only',
  SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error' });
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const db = get(), password = 'Synthetic-Calendar-Place-Only!';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let server, browser, origin, log = '';

test.before(async () => {
  const hashed = await hashPassword(password, 4);
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'calendaradmin','Calendar Admin',?,'admin','parent',1)").run(hashed);
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(2,'calendarmember','Calendar Member',?,'member','child',1)").run(hashed);
  db.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update'] });
  server = fork(new URL('./helpers/task-card-full-app-server.mjs', import.meta.url), [],
    { env: { ...process.env, PORT: '0', TASK_CARD_BROWSER_SERVER_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-16000); });
  origin = await new Promise((resolveOrigin, reject) => {
    const timeout = setTimeout(() => reject(Error(`Server did not start: ${log}`)), 50000);
    server.once('message', message => { clearTimeout(timeout); resolveOrigin(message.origin); });
    server.once('exit', code => { clearTimeout(timeout); reject(Error(`Server exited ${code}: ${log}`)); });
  });
});
test.after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { server.kill(); await new Promise(done => server.once('exit', done)); }
  db.close();
  if (resolve(folder).startsWith(resolve(tmpdir()) + '\\') && basename(folder).startsWith('vidamia-calendar-places-'))
    rmSync(folder, { recursive: true, force: true });
});

const set = (page, selector, value) => page.$eval(selector, (input, next) => {
  input.value = next; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
async function session(width, username = 'calendaradmin') {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.setViewport({ width, height: 850, isMobile: width < 600, hasTouch: width < 600 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => { delete Navigator.prototype.serviceWorker; localStorage.setItem('yuvomi-lang', 'en'); });
  await page.goto(`${origin}/login`);
  const login = await page.evaluate(async ({ username, password }) => {
    const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return response.status;
  }, { username, password });
  assert.equal(login, 200);
  await page.goto(`${origin}/calendar`);
  await page.waitForSelector(width < 600 ? '#fab-new-event' : '#cal-add');
  await page.waitForSelector('#cal-view-tab-agenda');
  await page.click('#cal-view-tab-agenda');
  return { context, page, errors };
}
async function createForm(page, width) {
  await page.click(width < 600 ? '#fab-new-event' : '#cal-add');
  await page.waitForSelector('#modal-title', { visible: true });
}
async function addPlace(page, name) {
  if (page.viewport().width >= 600) { await page.focus('#modal-add-place'); await page.keyboard.press('Enter'); }
  else await page.click('#modal-add-place');
  await page.waitForSelector('#automation-place-form', { visible: true });
  await set(page, '#automation-place-form [name="name"]', name);
  await set(page, '#automation-place-form [name="city"]', 'Synthetic City');
  if (page.viewport().width >= 600) {
    await page.focus('.modal-overlay:not([inert]) [type="submit"]');
    await page.keyboard.press('Enter');
  } else await page.click('.modal-overlay:not([inert]) [type="submit"]');
  await page.waitForSelector('#automation-place-form', { hidden: true });
  await page.waitForFunction(() => {
    const parent = document.querySelector('#modal-title')?.closest('.modal-overlay');
    return parent && !parent.inert && document.querySelectorAll('.modal-overlay').length === 1;
  });
  await page.waitForFunction(() => document.querySelector('#modal-place')?.value !== '');
}
async function assertDraft(page, title, location, description) {
  assert.equal(await page.$eval('#modal-title', input => input.value), title);
  assert.equal(await page.$eval('#modal-location', input => input.value), location);
  assert.equal(await page.$eval('#modal-description', input => input.value), description);
  assert.equal(await page.evaluate(() => document.querySelector('#modal-title') === window.calendarDraftTitle), true);
  assert.equal(await page.evaluate(() => document.querySelector('#modal-title').closest('.modal-overlay').querySelector('.modal-panel__body') === window.calendarDraftBody), true);
  assert.equal(await page.evaluate(() => document.querySelector('#modal-title').closest('.modal-overlay').querySelector('.modal-panel__body').scrollTop),
    await page.evaluate(() => window.calendarDraftScroll));
  assert.equal(await page.$eval('.modal-overlay:not([inert]) .modal-panel', panel => panel.scrollWidth > panel.clientWidth + 1), false);
}

for (const width of [1280, 390]) test(`Calendar Place child returns to create and edit drafts at ${width}px`, { timeout: 120000 }, async () => {
  const { context, page, errors } = await session(width);
  try {
    await createForm(page, width);
    assert.equal(await page.$('#modal-place') !== null, true, 'Place picker remains available with an empty catalogue');
    const title = `Synthetic Calendar Place ${width}`;
    await set(page, '#modal-title', title);
    await set(page, '#modal-location', 'Original location draft');
    await set(page, '#modal-description', 'Original description draft');
    await page.$eval('#modal-add-place', button => button.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => {
      window.calendarDraftTitle = document.querySelector('#modal-title');
      window.calendarDraftBody = window.calendarDraftTitle.closest('.modal-overlay').querySelector('.modal-panel__body');
      window.calendarDraftScroll = window.calendarDraftBody.scrollTop;
    });
    await page.click('#modal-add-place');
    await page.waitForSelector('#automation-place-form', { visible: true });
    await page.click('.modal-overlay:not([inert]) [data-action="close-modal"]');
    await page.waitForSelector('#automation-place-form', { hidden: true });
    await page.waitForFunction(() => !document.querySelector('#modal-title')?.closest('.modal-overlay')?.inert && document.querySelectorAll('.modal-overlay').length === 1);
    await assertDraft(page, title, 'Original location draft', 'Original description draft');
    if (width < 600) {
      await page.tap('#modal-add-place');
      await page.waitForSelector('#automation-place-form', { visible: true });
      await page.evaluate(() => history.back());
      await page.waitForSelector('#automation-place-form', { hidden: true });
      await page.waitForFunction(() => !document.querySelector('#modal-title')?.closest('.modal-overlay')?.inert && document.querySelectorAll('.modal-overlay').length === 1);
      await assertDraft(page, title, 'Original location draft', 'Original description draft');
    }
    await addPlace(page, `Synthetic Park ${width}`);
    await assertDraft(page, title, 'Original location draft', 'Original description draft');
    const linkedPlace = Number(await page.$eval('#modal-place', select => select.value));
    assert.ok(linkedPlace > 0);
    assert.match(await page.$eval('#modal-place-status', node => node.textContent), /selected/);
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.modal-overlay:not([inert])') !== null), true);
    if (width >= 600) await page.click('#modal-save');
    else await page.tap('#modal-save');
    await page.waitForSelector('#modal-title', { hidden: true });
    const created = db.prepare('SELECT id,place_id,location,description FROM calendar_events WHERE title=?').get(title);
    assert.equal(created?.place_id, linkedPlace);
    assert.equal(created?.location, 'Original location draft');
    assert.equal(created?.description, 'Original description draft');

    await page.waitForSelector(`.agenda-event[data-id="${created.id}"]`, { visible: true });
    if (width >= 600) { await page.focus(`.agenda-event[data-id="${created.id}"]`); await page.keyboard.press('Enter'); }
    else await page.click(`.agenda-event[data-id="${created.id}"]`);
    const edit = width >= 600 ? '#detail-popover-edit' : '#detail-view-edit';
    await page.waitForSelector(edit, { visible: true });
    await page.click(edit);
    await page.waitForSelector('#modal-title', { visible: true });
    const editedTitle = `${title} edited`;
    await set(page, '#modal-title', editedTitle);
    await set(page, '#modal-location', 'Edited location draft');
    await set(page, '#modal-description', 'Edited description draft');
    await page.$eval('#modal-add-place', button => button.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => {
      window.calendarDraftTitle = document.querySelector('#modal-title');
      window.calendarDraftBody = window.calendarDraftTitle.closest('.modal-overlay').querySelector('.modal-panel__body');
      window.calendarDraftScroll = window.calendarDraftBody.scrollTop;
    });
    await addPlace(page, `Synthetic Studio ${width}`);
    await assertDraft(page, editedTitle, 'Edited location draft', 'Edited description draft');
    const editedPlace = Number(await page.$eval('#modal-place', select => select.value));
    assert.notEqual(editedPlace, linkedPlace);
    if (width >= 600) { await page.focus('#modal-save'); await page.keyboard.press('Enter'); }
    else await page.tap('#modal-save');
    await page.waitForSelector('#modal-title', { hidden: true });
    const updated = db.prepare('SELECT title,place_id,location,description FROM calendar_events WHERE id=?').get(created.id);
    assert.deepEqual(updated, { title: editedTitle, place_id: editedPlace, location: 'Edited location draft', description: 'Edited description draft' });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Place creation is absent without Place management capability', { timeout: 40000 }, async () => {
  const { context, page, errors } = await session(1280, 'calendarmember');
  try {
    await createForm(page, 1280);
    assert.equal(await page.$('#modal-add-place'), null);
    assert.ok(await page.$('#modal-place'));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
