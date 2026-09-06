/** Isolated product inspection. Uses only a fresh temporary demo database.
 * Run: AUDIT_LABEL=baseline QA_OUTPUT_DIR=/tmp/yuvomi-review node test/product-refinement.browser.mjs
 * Requires the declared Puppeteer dev dependency and its installed Chromium.
 */
import puppeteer from 'puppeteer';
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
const report = { label, node: process.version, observations: [], interactions: [], errors: [] };
let server;
let browser;
let serverLog = '';
const routes = ['/', '/tasks', '/meals', '/recipes', '/shopping', '/pantry', '/calendar',
  '/settings', '/settings/modules/automation', '/places', '/reader'];

async function capture(page, name, requests, errors) {
  await delay(550);
  const observation = await page.evaluate(() => {
    const visible = (el) => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const width = document.documentElement.clientWidth;
    return { url: location.pathname, title: document.title, theme: document.documentElement.dataset.theme,
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
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
      activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
    };
  });
  const session = await page.createCDPSession();
  const tree = await session.send('Accessibility.getFullAXTree');
  observation.unnamedControls = tree.nodes.filter(n => !n.ignored &&
    ['button', 'textbox', 'combobox', 'checkbox', 'spinbutton'].includes(n.role?.value) &&
    !n.name?.value).map(n => ({ role: n.role.value, backendDOMNodeId: n.backendDOMNodeId }));
  await session.detach();
  observation.name = name;
  observation.requests = [...requests];
  observation.pageErrors = [...errors];
  report.observations.push(observation);
  await page.screenshot({ path: join(output, `${label}-${name}.png`), fullPage: true });
  console.log(`${name}: ${observation.title}; unnamed=${observation.unnamedControls.length}; errors=${errors.length}; width=${observation.documentWidth}`);
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
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1 });
      await page.emulateTimezone('America/New_York');
      await page.evaluateOnNewDocument((theme) => {
        localStorage.setItem('yuvomi-locale', 'en');
        localStorage.setItem('yuvomi-onboarded', '1');
        localStorage.setItem('yuvomi-install-dismissed', String(Date.now()));
        localStorage.setItem('yuvomi-theme', theme);
      }, theme);
      let requests = [];
      let errors = [];
      page.on('response', r => { if (r.url().includes('/api/')) requests.push({ path: new URL(r.url()).pathname, status: r.status() }); });
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
      await page.type('#username', 'alex');
      await page.type('#password', 'demo1234');
      await page.click('#auth-btn');
      await page.waitForFunction(() => location.pathname === '/', { timeout: 15000 });
      for (const route of routes) {
        requests = []; errors = [];
        await page.goto(base + route, { waitUntil: 'networkidle0', timeout: 30000 });
        const name = `${width}-${theme}-${route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')}`;
        await capture(page, name, requests, errors);
        if (route === '/tasks') {
          const selector = width === 390 ? '#fab-new-task' : '#btn-new-task';
          if (await page.$(selector)) {
            await page.click(selector);
            await capture(page, `${name}-create`, [], errors);
            await page.keyboard.press('Escape');
            await delay(200);
            report.interactions.push({ name: `${name}-escape`, dialogs: await page.$$eval('[role="dialog"]', es => es.filter(e => e.getClientRects().length).length), path: new URL(page.url()).pathname });
          }
        }
      }
      await page.goto(base, { waitUntil: 'networkidle0' });
      await page.evaluate(() => localStorage.setItem('yuvomi-wall-mode', '1'));
      await page.reload({ waitUntil: 'networkidle0' });
      await capture(page, `${width}-${theme}-wall`, [], errors);
      await context.close();
    }
  }
} catch (error) {
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
