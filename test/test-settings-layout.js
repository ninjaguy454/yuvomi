import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());
app.use('/api/v1', (req, res) => {
  if (req.path === '/version') return res.json({ version: '2.54.0-test', app_name: 'Legacy household name', setup_required: false });
  if (req.path === '/preferences') return res.json({ data: { color_theme: 'warm', heading_font: 'serif', timezone: 'UTC', timezone_effective: 'UTC', language: 'en', region: 'en-US', date_format: 'mdy', time_format: '12h' } });
  if (req.path.includes('email')) return res.json({ data: { host: '', port: 587, secure: 'starttls', user: '', fromAddress: '', fromName: '', envControlled: {} } });
  return res.json({ data: [] });
});
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
app.get('/settings-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/settings.css"></head><body><main id="main-content"></main></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox'] });
});
test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) || resolve());
});
async function mount({ width = 1366, role = 'admin', path = null } = {}) {
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.setViewport({ width, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${base}/settings-fixture`);
  await page.evaluate(async ({ role, path }) => {
    localStorage.setItem('yuvomi-lang', 'en');
    const { initI18n, setLocale } = await import('/i18n.js');
    await initI18n(); await setLocale('en');
    window.visits = [];
    window.yuvomi = { user: { id: 1, role }, navigate: target => window.visits.push(target), showToast() {} };
    const { renderSettingsShell } = await import('/settings/shell.js');
    const { findSettingsLeaf } = await import('/settings/registry.js');
    await renderSettingsShell(document.querySelector('main'), { user: window.yuvomi.user, leaf: path ? findSettingsLeaf(path, window.yuvomi.user) : null, view: 'domains' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { role, path });
  return page;
}

for (const width of [1366, 768, 390]) {
  test(`Settings overview search opens the same destination and clears correctly at ${width}px`, async () => {
    const page = await mount({ width });
    try {
      const search = '.settings-shell__content > .settings-shell__navigation-search input';
      await page.type(search, 'notifications');
      const results = '.settings-shell__content > .settings-shell__navigation-results';
      assert.equal(await page.$eval(results, el => el.hidden), false);
      await page.click(`${results} [data-leaf-id="personal-notifications"]`);
      assert.deepEqual(await page.evaluate(() => window.visits), ['/settings/personal/notifications']);
      await page.focus(search); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
      assert.equal(await page.$eval(results, el => el.hidden), true);
      assert.equal(await page.$eval('.settings-mobile-overview--domains', el => el.hidden), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  });
}

test('Settings search respects member permissions and announces no matches', async () => {
  const page = await mount({ role: 'member', width: 390 });
  try {
    const search = '.settings-shell__content > .settings-shell__navigation-search input';
    await page.type(search, 'SMTP');
    assert.equal(await page.$$eval('.settings-shell__content > .settings-shell__navigation-results a', els => els.length), 0);
    assert.match(await page.$eval('.settings-shell__content > .settings-shell__navigation-status', el => el.innerText), /No results/i);
    assert.equal(await page.$$eval('.settings-mobile-overview a', els => els.some(el => el.href.includes('/admin/'))), false);
  } finally { await page.close(); }
});

test('Settings layout retains readable controls across theme, appearance and typography combinations', async () => {
  for (const width of [1366, 768, 390]) {
    const page = await mount({ width, path: '/settings/personal/appearance' });
    try {
      for (const colorTheme of ['warm', 'neutral', 'cool']) for (const appearance of ['light', 'dark', 'system']) for (const font of ['default', 'serif']) {
        const layout = await page.evaluate(({ colorTheme, appearance, font }) => {
          document.documentElement.dataset.colorTheme = colorTheme;
          document.documentElement.dataset.theme = appearance;
          document.documentElement.dataset.typography = font;
          const theme = document.querySelector('#color-theme-select').getBoundingClientRect();
          const typography = document.querySelector('#heading-font-select').getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth > innerWidth, theme: { top: theme.top, width: theme.width, height: theme.height }, typography: { top: typography.top, width: typography.width, height: typography.height } };
        }, { colorTheme, appearance, font });
        assert.equal(layout.overflow, false, `${width}/${colorTheme}/${appearance}/${font}`);
        assert.ok(layout.theme.width > 200 && layout.typography.width > 200);
        assert.ok(Math.abs(layout.theme.height - layout.typography.height) < 1);
        if (width >= 768) assert.ok(Math.abs(layout.theme.top - layout.typography.top) < 1);
        else assert.ok(layout.typography.top > layout.theme.top);
      }
      assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  }
});

test('refreshed Settings keeps unsaved form protection on navigation', async () => {
  const page = await mount({ path: '/settings/admin/email' });
  try {
    await page.type('#email-host', 'draft.example.invalid');
    await page.click('.settings-breadcrumb__link');
    await page.waitForSelector('#shared-modal-overlay');
    assert.deepEqual(await page.evaluate(() => window.visits), []);
    await page.click('#shared-modal-overlay [data-action="close-modal"]');
    await page.waitForFunction(() => !document.querySelector('#shared-modal-overlay'));
    assert.equal(await page.$eval('#email-host', el => el.value), 'draft.example.invalid');
    assert.deepEqual(await page.evaluate(() => window.visits), []);
  } finally { await page.close(); }
});

test('System settings renders version, license and status without editable product branding at every width', async () => {
  for (const width of [1366, 768, 390]) {
    const page = await mount({ width, path: '/settings/admin/system' });
    try {
      const text = await page.$eval('#system-info-host', element => element.innerText);
      assert.match(text, /2\.54\.0-test/);
      assert.match(text, /MIT/);
      assert.equal(await page.$('#app-name-input'), null);
      assert.equal(await page.$('#app-name-form'), null);
      assert.equal(await page.$('#app-name-reset-btn'), null);
      assert.doesNotMatch(await page.$eval('.settings-leaf', element => element.innerText), /Legacy household name/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  }
});
