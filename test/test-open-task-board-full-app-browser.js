/** Bounty sidebar and inspection on the actual app, with an encrypted disposable household. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-bounty-full-app-'));
process.env.DB_PATH = join(folder, 'household.db'); process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SESSION_SECRET = 'synthetic-bounty-inspection-only'; process.env.SESSION_SECURE = 'false';
process.env.BACKUP_ENABLED = 'false'; process.env.NODE_ENV = 'development'; process.env.LOG_LEVEL = 'error';
const { get } = await import('../server/db.js'); const { hashPassword } = await import('../server/utils/password.js');
const d = get(), password = 'Synthetic-bounty-layout-2026!';
const output = process.env.OPEN_TASK_SCREENSHOTS || join(folder, 'evidence'); mkdirSync(output, { recursive: true });
const evidence = { scope: 'Actual app, encrypted synthetic household, Chromium viewport emulation', layout: [], errors: [] };
let server, browser, origin, page, offerId, noteIds, originalLayouts;
test.before(async () => {
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,?,?,?,\'admin\',\'parent\',1)')
    .run('Bounty Parent', 'Bounty Parent', await hashPassword(password, 4));
  server = fork(new URL('./helpers/note-board-full-app-server.mjs', import.meta.url), [], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => log = (log + chunk).slice(-6000));
  origin = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log || 'Server startup failed')), 60000); server.once('message', value => { clearTimeout(timer); resolve(value.origin); }); server.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${log}`)); }); });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
  page = await browser.newPage(); page.setDefaultTimeout(15000);
  await page.setViewport({ width: 752, height: 939, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => { localStorage.setItem('yuvomi-locale', 'en'); Object.defineProperty(navigator, 'onLine', { get: () => true }); });
  await page.setRequestInterception(true); page.on('request', request => { const url = new URL(request.url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin || url.pathname === '/sw.js') return request.abort(); return request.continue(); });
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto(origin + '/login'); await page.waitForSelector('#username'); await page.type('#username', 'Bounty Parent'); await page.type('#password', password);
  const login = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
  await page.click('#auth-btn'); assert.equal((await login).status(), 200); await page.waitForSelector('.dashboard');
  offerId = await page.evaluate(async () => { const { api } = await import('/api.js'); await api.post('/notes', { title: 'Garden notes', content: 'Spring beds and watering.', visibility: 'all' }); const response = await api.post('/tasks', { title: 'Prepare the garden', description: 'Read the seed plan.\n- [ ] Inspect the soil', assigned_to: [], points: 0 }); return response.data.id; });
  await page.evaluate(async () => { const { api } = await import('/api.js'); for (const title of ['Seed list', 'Watering plan']) await api.post('/notes', { title, content: 'A shared garden note.', visibility: 'all' }); });
  noteIds = d.prepare('SELECT id FROM notes ORDER BY id').all().map(row => row.id);
  noteIds.forEach((id, index) => d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,position_locked) VALUES(?,?,0,4,6,1)').run(id, index * 8));
  originalLayouts = d.prepare('SELECT * FROM note_layouts ORDER BY note_id').all();
  d.prepare('INSERT INTO tasks(title,description,created_by,parent_task_id,points) VALUES(?,?,1,?,2)').run('Inspect the soil', 'Keep the soil loose.', offerId);
  const positive = await page.evaluate(async () => { const { api } = await import('/api.js'); return api.post('/tasks', { title: 'Water the garden', assigned_to: [], points: 5 }); });
  evidence.positiveOfferId = positive.data.id;
  assert.notEqual(readFileSync(process.env.DB_PATH).subarray(0, 16).toString(), 'SQLite format 3\0', 'disposable DB is encrypted');
  await page.evaluate(() => window.yuvomi.navigate('/notes')); await page.waitForSelector('.notes-page'); await page.waitForSelector(`[data-open-task="${offerId}"]`);
});
test.after(async () => {
  writeFileSync(join(output, 'bounty-full-app-results.json'), JSON.stringify(evidence, null, 2)); await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
  d.close(); rmSync(folder, { recursive: true, force: true });
});

test('actual phone, open Fold and desktop keep a readable Bounty rail and read-only offer', async () => {
  for (const width of [390, 690, 752, 1920]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 939, isMobile: width <= 752, hasTouch: width <= 752 });
    await page.waitForFunction(expected => document.querySelector('#notes-grid')?.dataset.boardView === expected, {}, width < 640 ? 'list' : 'canvas');
    await page.waitForFunction(id => { const card=document.querySelector(`.note-card[data-id="${id}"]`); return card?.isConnected&&card.getBoundingClientRect().width>0&&card.querySelector('.note-card__title')?.getBoundingClientRect().width>0; }, {}, noteIds[0]);
    const geometry = await page.evaluate(() => { const note = document.querySelector('.notes-scroll').getBoundingClientRect(), offer = document.querySelector('#notes-open-tasks').getBoundingClientRect(), workspace = document.querySelector('.notes-page'); return { page: workspace.clientWidth, canvas: note.width, sidebar: offer.width, nr: note.right, ol: offer.left, nt: note.top, ob: offer.bottom, scroll: document.documentElement.scrollWidth, width: innerWidth }; });
    if (width >= 690) { assert.ok(geometry.nr <= geometry.ol + 1, JSON.stringify(geometry)); assert.ok(geometry.canvas >= 450, JSON.stringify(geometry)); assert.ok(geometry.sidebar >= 210 && geometry.sidebar <= 250, JSON.stringify(geometry)); }
    else assert.ok(geometry.ob <= geometry.nt + 1, 'phone stacks offers above notes');
    assert.ok(geometry.scroll <= geometry.width + 1, 'no document horizontal overflow'); evidence.layout.push({ viewport: width, ...geometry });
    if (width >= 690) {
      const card = await page.$eval(`.note-card[data-id="${noteIds[0]}"]`, el => ({ width: el.getBoundingClientRect().width, title: el.querySelector('.note-card__title').getBoundingClientRect().width }));
      assert.ok(card.width >= 190 && card.title >= 80, 'default note keeps readable title space beside Bounty rail: ' + JSON.stringify(card));
      evidence.layout.at(-1).card = card;
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.screenshot({ path: join(output, `actual-bounty-${width}-${theme}.png`) });
    }
    const points = await page.$$eval(`[data-open-task="${offerId}"] .text-muted:not([data-task-countdown])`, rows => rows.map(row => row.textContent.trim()));
    assert.ok(points.includes('0 points')); assert.match(await page.$eval(`[data-open-task="${evidence.positiveOfferId}"]`, el => el.textContent), /5 points/);
  }
  const writes = []; const track = request => { if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); }; page.on('request', track);
  await page.setViewport({ width: 752, height: 939, isMobile: true, hasTouch: true });
  await page.waitForSelector(`[data-open-task="${offerId}"]`, { visible: true });
  await page.waitForFunction(()=>document.querySelector('#notes-grid')?.dataset.boardView==='canvas');
  await page.$eval(`.note-card[data-id="${noteIds.at(-1)}"]`, el => el.scrollIntoView({ block: 'nearest', inline: 'center' }));
  const handleState = await page.$eval(`.note-card[data-id="${noteIds.at(-1)}"]`, el => ({ isConnected: el.isConnected, hasScrollAncestor: !!el.closest('.notes-scroll'), currentCardExists: !!document.querySelector(`.note-card[data-id="${el.dataset.id}"]`) }));
  console.log('BOUNTY_PAN_HANDLE_STATE', JSON.stringify(handleState));
  const reached = await page.evaluate(id => { const el=document.querySelector(`.note-card[data-id="${id}"]`), host=document.querySelector('.notes-scroll'); if(!el||!host||!host.contains(el))throw Error('Current canvas note or scroll ancestor missing'); const card=el.getBoundingClientRect(),viewport=host.getBoundingClientRect(); return { left: card.left, right: card.right, viewportLeft: viewport.left, viewportRight: viewport.right }; }, noteIds.at(-1));
  assert.ok(reached.left >= reached.viewportLeft && reached.right <= reached.viewportRight, 'horizontal canvas reveals the distant original note: ' + JSON.stringify(reached));
  await page.$eval('.notes-scroll', el => { el.scrollLeft = 0; });
  assert.deepEqual(d.prepare('SELECT * FROM note_layouts ORDER BY note_id').all(), originalLayouts, 'responsive projection and panning never persist note placements');
  await page.evaluate(id => { const button=document.querySelector(`[data-open-task="${id}"]`); if(!button||!button.isConnected)throw Error('Current Bounty offer missing before keyboard inspection'); button.focus(); }, offerId);
  await page.keyboard.press('Enter'); await page.waitForSelector('#task-detail-claim');
  assert.equal(await page.$('.modal-panel select,.modal-panel input,.modal-panel textarea,.modal-panel [data-task-operation],.modal-panel .note-md-box[data-md-line],#task-detail-delete,#task-detail-archive,#detail-view-edit'), null);
  assert.match(await page.$eval('.detail-view__pane', el => el.textContent), /Inspect the soil/);
  assert.match(await page.$eval('.task-detail-points', el => el.textContent), /0 points/);
  await page.screenshot({ path: join(output, 'actual-bounty-fold-inspection.png') });
  assert.deepEqual(writes, []); assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts').get().n, 0);
  assert.deepEqual(evidence.errors, []); assert.equal(d.pragma('integrity_check', { simple: true }), 'ok');
  page.off('request', track);
});
