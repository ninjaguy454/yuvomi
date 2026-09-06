/** Product review and regressions against a fresh, disposable demo household.
 * Run: QA_OUTPUT_DIR=/tmp/yuvomi-review node test/product-refinement-regressions.browser.mjs
 * Uses the declared Puppeteer dependency. Never connects to a production DB.
 */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'yuvomi-product-review-'));
const output = resolve(process.env.QA_OUTPUT_DIR || join(temporary, 'artifacts'));
const label = (process.env.AUDIT_LABEL || 'review').replace(/[^a-z0-9_-]/gi, '_');
mkdirSync(output, { recursive: true });
const port = Number(process.env.QA_PORT || 3197);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DB_PATH: join(temporary, 'qa.db'), DB_ENCRYPTION_KEY: '',
  SESSION_SECRET: randomBytes(32).toString('hex'), PORT: String(port), NODE_ENV: 'test',
  TRUST_PROXY: '0', SESSION_SECURE: 'false', TZ: 'America/New_York' };
const report = { label, node: process.version, observations: [], interactions: [], regressions: [], errors: [] };
report.commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
let server;
let browser;
let currentPage;
let serverLog = '';
const routes = ['/', '/tasks', '/meals', '/recipes', '/shopping', '/pantry', '/calendar',
  '/settings', '/settings/modules/automation', '/places', '/reader'];

async function capture(page, name, requests, errors) {
  await delay(550);
  const observation = await page.evaluate(() => {
    const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const width = document.documentElement.clientWidth;
    return { url: location.pathname, title: document.title, theme: document.documentElement.dataset.theme,
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      text: document.body.innerText.slice(0, 16000),
      buttons: [...document.querySelectorAll('button')].filter(visible).map(el => ({
        id: el.id, text: el.innerText, aria: el.getAttribute('aria-label'), title: el.title,
        expanded: el.getAttribute('aria-expanded'), disabled: el.disabled })),
      fields: [...document.querySelectorAll('input,select,textarea')].filter(visible).map(el => ({
        id: el.id, type: el.type, name: el.name, placeholder: el.placeholder,
        labels: [...(el.labels || [])].map(l => l.innerText), aria: el.getAttribute('aria-label') })),
      overflow: [...document.querySelectorAll('main *,[role="dialog"] *')].filter(el => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > width + 2 || r.left < -2);
      }).slice(0, 25).map(el => ({ tag: el.tagName, id: el.id, class: el.className,
        text: el.innerText?.slice(0, 80), width: Math.round(el.getBoundingClientRect().width) })),
      activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id } };
  });
  const session = await page.createCDPSession();
  const tree = await session.send('Accessibility.getFullAXTree');
  observation.unnamedControls = tree.nodes.filter(n => !n.ignored &&
    ['button', 'textbox', 'combobox', 'checkbox', 'spinbutton'].includes(n.role?.value) &&
    !n.name?.value).map(n => ({ role: n.role.value, backendDOMNodeId: n.backendDOMNodeId }));
  await session.detach();
  Object.assign(observation, { name, requests: [...requests], pageErrors: [...errors] });
  report.observations.push(observation);
  await page.screenshot({ path: join(output, `${label}-${name}.png`), fullPage: true });
  assert.equal(errors.length, 0, `${name}: page exception`);
  assert.ok(!requests.some(r => r.status >= 400), `${name}: failed API response`);
  assert.ok(observation.documentWidth <= observation.viewport.width, `${name}: document overflow`);
  if (/-create$/.test(name) || /-(places|settings-modules-automation)-form$/.test(name)) {
    assert.equal(observation.unnamedControls.length, 0, `${name}: unnamed form control`);
  }
  console.log(`${name}: unnamed=${observation.unnamedControls.length}; errors=${errors.length}; width=${observation.documentWidth}`);
}

try {
  const migration = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./server/db.js')"], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  if (migration.status !== 0) throw new Error(`Migration failed: ${migration.stderr}`);
  const seed = spawnSync(process.execPath, ['scripts/seed-demo.js', '--db', env.DB_PATH, '--locale', 'en'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  if (seed.status !== 0) throw new Error(`Demo seed failed: ${seed.stderr}`);
  server = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { serverLog += data; });
  server.stderr.on('data', data => { serverLog += data; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Disposable server exited');
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error('Disposable server did not become ready');
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.QA_CHROME ? { executablePath: process.env.QA_CHROME } : {}) });
  report.browser = await browser.version();
  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark']) {
      // Respect the real 300/minute limiter instead of changing middleware.
      if (report.observations.length) await delay(61000);
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      currentPage = page;
      await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
      await page.emulateTimezone('America/New_York');
      await page.evaluateOnNewDocument(theme => {
        localStorage.setItem('yuvomi-locale', 'en');
        localStorage.setItem('yuvomi-onboarded:1', '1');
        localStorage.setItem('yuvomi-install-dismissed', String(Date.now()));
        localStorage.setItem('yuvomi-theme', theme);
      }, theme);
      let requests = [];
      let errors = [];
      page.on('response', r => { if (r.url().includes('/api/')) requests.push({ path: new URL(r.url()).pathname, status: r.status() }); });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#username');
      await page.evaluate(() => {
        window.__reviewInitialPage = 'initial-document';
        document.querySelector('#username').value = 'draft-before-worker';
      });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 20000 });
      await delay(700);
      assert.deepEqual(await page.evaluate(() => [window.__reviewInitialPage, document.querySelector('#username')?.value]),
        ['initial-document', 'draft-before-worker'], 'first service-worker activation erased the login draft');
      report.regressions.push(`${width}-${theme}: first service-worker activation preserves login draft`);
      await page.$eval('#username', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type('#username', 'alex');
      await page.type('#password', 'demo1234');
      await page.click('#auth-btn');
      await page.waitForFunction(() => location.pathname === '/', { timeout: 15000 });
      for (const route of routes) {
        requests = []; errors = [];
        await page.goto(base + route, { waitUntil: 'networkidle0', timeout: 30000 });
        const name = `${width}-${theme}-${route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')}`;
        await capture(page, name, requests, errors);
        const extra = { '/places': '#automation-add-place', '/settings/modules/automation': '#automation-add-skill', '/meals': '#meal-plan-manage' }[route];
        if (extra) {
          await page.waitForSelector(extra, { visible: true });
          await page.click(extra);
          await capture(page, `${name}-form`, [], errors);
          if (route !== '/meals') {
            const labels = await page.evaluate(() => {
              const form = document.querySelector('#shared-modal-overlay form');
              const fields = [...form.querySelectorAll('input:not([type="checkbox"]),select,textarea')];
              const unnamed = fields.filter(f => ![...(f.labels || [])].some(l => l.textContent.trim()));
              const ids = fields.map(f => f.id);
              const first = fields[0];
              first.labels[0]?.click();
              const descriptions = fields.flatMap(f => (f.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
              return { unnamed: unnamed.length, uniqueIds: new Set(ids).size === ids.length,
                labelFocus: document.activeElement === first,
                hintsExist: descriptions.every(id => document.getElementById(id)?.textContent.trim()) };
            });
            assert.deepEqual(labels, { unnamed: 0, uniqueIds: true, labelFocus: true, hintsExist: true });
            report.regressions.push(`${name}: native labels, unique IDs, label focus and help associations`);
          }
          if (route === '/places' && width === 1440 && theme === 'light') {
            const nameValue = 'QA <Place> & "address"';
            await page.type('#automation-place-form [name="name"]', nameValue);
            await page.type('#automation-place-form [name="street_address"]', 'Example address');
            const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/v1/planning/admin/places') && r.request().method() === 'POST');
            await page.click('#automation-place-form [type="submit"]');
            const response = await responsePromise;
            assert.ok(response.ok(), 'Place form no longer saves');
            const body = await response.json();
            const place = body.data || body;
            assert.equal(place.name, nameValue);
            await page.waitForSelector('#shared-modal-overlay', { hidden: true });
            await page.click(`[data-edit-place="${place.id}"]`);
            assert.equal(await page.$eval('#automation-place-form [name="name"]', el => el.value), nameValue);
            await capture(page, `${name}-edit`, [], errors);
            report.regressions.push('Place create/edit round trip preserves names, values and escaping');
          }
          await page.keyboard.press('Escape');
          await page.waitForSelector('#shared-modal-overlay', { hidden: true, timeout: 5000 });
          report.interactions.push({ name: `${name}-form-escape`, closed: true, path: new URL(page.url()).pathname });
        }
        if (route === '/tasks') {
          const selector = width === 390 ? '#fab-new-task' : '#btn-new-task';
          await page.waitForSelector(selector, { visible: true });
          await page.click(selector);
          await capture(page, `${name}-create`, [], errors);
          for (const kind of ['saved_place', 'manual', 'google_place', 'none']) {
            await page.select('#task-location-kind', kind);
            const unnamed = await page.evaluate(() => [...document.querySelectorAll('#task-location-fieldset input:not([type="hidden"]),#task-location-fieldset select,#task-location-fieldset textarea')]
              .filter(el => !el.getAttribute('aria-label') && !el.labels?.length).map(el => el.id));
            assert.deepEqual(unnamed, []);
          }
          await page.keyboard.press('Escape');
          await page.waitForSelector('#shared-modal-overlay', { hidden: true, timeout: 5000 });
          report.interactions.push({ name: `${name}-escape`, closed: true, path: new URL(page.url()).pathname });
          report.regressions.push(`${name}: location control names in every choice branch`);
          await page.click('[data-action="open-task"]');
          await page.waitForSelector('#detail-view-edit', { visible: true });
          await capture(page, `${name}-detail`, [], errors);
          await page.click('#detail-view-edit');
          await page.waitForSelector('#task-location-kind', { visible: true });
          assert.equal(await page.$eval('#task-location-kind', el => el.getAttribute('aria-label')), 'Location type');
          await capture(page, `${name}-edit`, [], errors);
          await page.evaluate(async () => (await import('/components/modal.js')).closeModal({ force: true }));
          await page.waitForSelector('#shared-modal-overlay', { hidden: true });
        }
      }
      if (width === 1440 && theme === 'light') {
        await page.goto(`${base}/tasks`, { waitUntil: 'networkidle0' });
        await page.evaluate(() => window.yuvomi.navigate('/settings/modules/automation'));
        await page.waitForSelector('#automation-add-skill');
        await page.click('.nav-sidebar__history [data-history-direction="back"]');
        await page.waitForFunction(() => location.pathname === '/tasks');
        await page.click('.nav-sidebar__history [data-history-direction="forward"]');
        await page.waitForFunction(() => location.pathname === '/settings/modules/automation');
        report.interactions.push({ name: 'Tasks to Household Automation: shell Back and Forward', passed: true });
        await page.click('[data-automation-tab="activities"]');
        await page.waitForSelector('#automation-add-activity');
        await page.click('#automation-add-activity');
        await page.waitForSelector('#automation-assignment-strategy');
        await page.select('#automation-assignment-strategy', 'fixed');
        await page.select('#automation-location-mode', 'fixed');
        assert.ok(await page.$eval('#automation-fixed-place', el => !el.hidden));
        assert.ok(await page.$eval('#automation-fixed-user', el => !el.hidden));
        assert.equal(await page.$eval('#automation-assignment-strategy', el => el.labels[0]?.htmlFor), 'automation-assignment-strategy');
        await capture(page, '1440-light-activity-dynamic-fields', [], errors);
        report.regressions.push('Activity editor retains existing IDs and dynamic assignment/location listeners');
        await page.evaluate(async () => (await import('/components/modal.js')).closeModal({ force: true }));
        await page.waitForSelector('#shared-modal-overlay', { hidden: true });
      }
      await page.goto(base, { waitUntil: 'networkidle0' });
      await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
      await page.reload({ waitUntil: 'networkidle0' });
      await capture(page, `${width}-${theme}-wall`, [], errors);
      await context.close();
    }
  }
} catch (error) {
  console.error(error);
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {});
    report.failurePage = await currentPage.evaluate(() => ({ path: location.pathname, text: document.body.innerText })).catch(() => null);
  }
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  writeFileSync(join(output, `${label}-report.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(output, `${label}-server.log`), serverLog);
  if (!output.startsWith(temporary + '/')) rmSync(temporary, { recursive: true, force: true });
  console.log(`Review artifacts: ${output}`);
}
