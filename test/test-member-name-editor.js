import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

const user = { id: 1, username: 'member-editor', display_name: 'Keep display name', role: 'admin',
  family_role: 'parent', avatar_color: '#007AFF', first_name: null, last_name: null, nickname: null };
const requests = [];
const app = express();
app.use(express.json());
app.use('/api/v1', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body });
  if (req.path === '/auth/me') return res.json({ user, csrfToken: 'a'.repeat(64) });
  if (req.path === '/auth/users') return res.json({ data: [user] });
  if (req.path === '/auth/me/profile' && req.method === 'PATCH') return res.json({ user: { ...user, ...req.body } });
  if (req.path === '/auth/users/1' && req.method === 'PATCH') return res.json({ user: { ...user, ...req.body } });
  if (req.path === '/auth/oidc/config') return res.json({ enabled: false });
  if (req.path === '/auth/oidc/link') return res.json({ available: false });
  if (req.path === '/preferences') return res.json({ data: { language: 'en' } });
  return res.json({ data: [] });
});
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  .matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
app.get('/member-editor-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  <link rel="stylesheet" href="/styles/settings.css">
  <style>body{display:block;height:auto;padding:16px}main{max-width:760px;margin:auto;height:auto;overflow:visible}.settings-profile-editor{min-width:0}</style>
  </head><body><main id="fixture" class="settings-page"></main></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });

async function open(width, leaf = 'personal-account') {
  const page = await browser.newPage(); await page.setViewport({ width, height: 900 });
  await page.goto(`${base}/member-editor-fixture`);
  await page.evaluate(async ({ leaf, user }) => {
    await (await import('/i18n.js')).initI18n();
    window.yuvomi = { showToast() {} };
    await (await import(`/settings/pages/${leaf}.js`)).render(document.querySelector('#fixture'), { user });
  }, { leaf, user });
  return page;
}

for (const width of [390, 768, 1366]) test(`optional profile names fit at ${width}px and save explicit values`, async () => {
  const page = await open(width);
  try {
    assert.deepEqual(await page.$$eval('[id^="profile-"][autocomplete="given-name"], [id^="profile-"][autocomplete="family-name"], [id^="profile-"][autocomplete="nickname"]',
      fields => fields.map(field => ({ value: field.value, required: field.required, max: field.maxLength }))),
    [{ value: '', required: false, max: 128 }, { value: '', required: false, max: 128 }, { value: '', required: false, max: 128 }]);
    for (const theme of ['neutral', 'warm', 'cool']) for (const appearance of ['light', 'dark']) {
      const result = await page.evaluate(({ theme, appearance }) => {
        Object.assign(document.documentElement.dataset, { colorTheme: theme, theme: appearance, typography: 'serif' });
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          fieldsFit: ['first_name', 'last_name', 'nickname'].every(key => {
            const field = document.querySelector(`#profile-${key}`), box = field.getBoundingClientRect();
            return box.width > 100 && box.left >= 0 && box.right <= innerWidth && !!field.labels?.length;
          }) };
      }, { theme, appearance });
      assert.equal(result.overflow, false); assert.equal(result.fieldsFit, true);
    }
    await page.type('#profile-first_name', ' María José ');
    await page.type('#profile-last_name', 'van der Berg');
    await page.type('#profile-nickname', 'MJ');
    if (process.env.MEMBER_NAME_SCREENSHOTS === '1') {
      const directory = new URL('../artifacts/member-name-editor/', import.meta.url); mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: fileURLToPath(new URL(`profile-${width}-cool-dark-serif.png`, directory)), fullPage: true });
    }
    await page.$eval('#profile-form', form => form.requestSubmit());
    await page.waitForFunction(() => !document.querySelector('#profile-form [type="submit"]').disabled);
    const save = requests.filter(row => row.method === 'PATCH' && row.path === '/auth/me/profile').at(-1);
    assert.equal(save.body.first_name, 'María José'); assert.equal(save.body.last_name, 'van der Berg');
    assert.equal(save.body.nickname, 'MJ'); assert.equal(save.body.display_name, user.display_name);
  } finally { await page.close(); }
});

test('admin member editor reuses the fields and Cancel does not submit them', async () => {
  const page = await open(390, 'admin-family');
  try {
    await page.click('[data-edit-user="1"]'); await page.waitForSelector('#edit-member-first_name');
    // The existing asynchronous member modal captures its baseline after 150 ms.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    await page.type('#edit-member-first_name', 'Unsaved', { delay: 20 });
    assert.equal(await page.$eval('#edit-member-display-name', field => field.value), user.display_name);
    const before = requests.filter(row => row.method === 'PATCH').length;
    await page.click('#edit-member-cancel');
    await page.waitForSelector('#confirm-modal-ok', { visible: true });
    await page.waitForFunction(() => {
      const box = document.querySelector('#confirm-modal-ok').getBoundingClientRect();
      return box.width > 0 && box.top >= 0 && box.bottom <= innerHeight;
    });
    await page.click('#confirm-modal-ok');
    await page.waitForSelector('#edit-member-first_name', { hidden: true });
    assert.equal(requests.filter(row => row.method === 'PATCH').length, before);
  } finally { await page.close(); }
});
