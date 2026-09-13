import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Actual Tasks rendering/search, application CSS and collapsing-header utility.
// The notification control uses the router's markup contract; no production API.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const styles = [...readFileSync(`${publicDir}/index.html`, 'utf8')
  .matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(match => match[0]).join('\n');
const app = express();
let server, browser, base;
const rows = ['Laundry', 'Make bed'].map((title, index) => ({ id: index + 1, title, category: 'household',
  assigned_to: 1, assigned_name: 'Creator', assigned_users: [{ id: 1, display_name: 'Creator' }],
  created_by: 1, revision: 1, visibility: 'all', status: 'open', priority: 'none', points: 0,
  tags: [], subtasks: [], permissions: { view: true, complete: true, edit: true, delete_archive: true } }));
app.use(express.static(publicDir));
app.get('/header-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  <link rel="stylesheet" href="/styles/tasks.css"><script src="/lucide.min.js"></script>
  <style>html,body{height:100%;margin:0}.app-content{height:100vh}
  *,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style>
  </head><body><div class="app-content"><main id="main-content"></main></div></body></html>`));
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ user: { id: 1, role: 'admin' }, permissions: { admin: true }, csrfToken: 'fixture' });
  if (req.path === '/tasks') return res.json({ data: rows });
  if (req.path === '/tasks/meta/options') return res.json({ users: [{ id: 1, display_name: 'Creator' }],
    categories: [{ key: 'household', name: 'Household' }], tags: [] });
  if (req.path === '/preferences') return res.json({ data: {} });
  if (req.path === '/automation/activity-options') return res.json({ data: { activities: [], skills: [] } });
  return res.json({ data: [] });
});
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function mount(width = 390, query = '') {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setViewport({ width, height: 844 });
  await page.goto(`${base}/header-test?view=list`);
  await page.evaluate(async initialQuery => {
    localStorage.clear(); localStorage.setItem('yuvomi-locale', 'en'); localStorage.setItem('yuvomi:swipeHintSeen', '3');
    window.yuvomi = { showToast() {} };
    window.EventSource = class { addEventListener() {} close() {} };
    await (await import('/i18n.js')).initI18n();
    (await import('/permissions.js')).setPermissions({ admin: true });
    const module = await import('/pages/tasks.js');
    window.subject = module.__test;
    window.subject.state.searchQuery = initialQuery;
    window.taskContainer = document.getElementById('main-content');
    window.stopTasks = await module.render(window.taskContainer, { user: { id: 1, role: 'admin' } });
    const toolbar = document.querySelector('.tasks-toolbar');
    toolbar.classList.add('notification-header-host');
    toolbar.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn--ghost btn--icon notification-header-button" data-notification-center aria-label="Notifications" aria-haspopup="dialog"><i data-lucide="bell" class="icon-md" aria-hidden="true"></i><span class="reminder-bell-badge" aria-hidden="true">3</span></button>');
    window.header = (await import('/utils/ux.js')).wireCollapsingHeader(toolbar, {
      sealIcon: () => { const icon = document.createElement('i'); icon.dataset.lucide = 'list-checks'; return icon; },
    });
    window.lucide?.createIcons({ el: toolbar });
  }, query);
  await page.waitForSelector('.task-card');
  await frames(page);
  return page;
}
async function assertHeaderFit(page) {
  const geometry = await page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const toolbar = document.querySelector('.tasks-toolbar');
    const bell = toolbar.querySelector('.notification-header-button');
    const peers = [...toolbar.children].filter(node => node !== bell && node.getClientRects().length);
    const bellRect = rect(bell);
    const overlap = peers.filter(node => { const r = rect(node); return Math.min(r.right, bellRect.right) - Math.max(r.left, bellRect.left) > 1
      && Math.min(r.bottom, bellRect.bottom) - Math.max(r.top, bellRect.top) > 1; }).map(node => node.className);
    return { toolbar: rect(toolbar), bell: bellRect, badge: rect(bell.querySelector('.reminder-bell-badge')), overlap, viewport: innerWidth,
      search: rect(toolbar.querySelector('#tasks-search-toggle')), title: toolbar.querySelector('h1').innerText,
      scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth };
  });
  assert.deepEqual(geometry.overlap, [], `notification control overlaps ${JSON.stringify(geometry)}`);
  assert.ok(geometry.bell.left >= 0 && geometry.bell.right <= geometry.viewport + 1, JSON.stringify(geometry));
  assert.ok(geometry.search.width >= 44 && geometry.search.height >= 44, 'search touch target stays 44px');
  assert.ok(geometry.bell.width >= 44 && geometry.bell.height >= 44, 'notification touch target stays 44px');
  assert.ok(geometry.badge.left >= geometry.bell.left && geometry.badge.right <= geometry.bell.right
    && geometry.badge.top >= geometry.bell.top && geometry.badge.bottom <= geometry.bell.bottom, 'unread badge stays attached to its notification button');
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'header itself does not overflow');
  assert.equal(geometry.title, 'Tasks');
}

for (const width of [390, 412, 768, 1024, 1440]) {
  test(`Tasks header gives notifications and search separate space at ${width}px`, async () => {
    const page = await mount(width);
    try {
      assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), true);
      await assertHeaderFit(page);
      await page.click('#tasks-search-toggle'); await frames(page);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tasks-search');
      await assertHeaderFit(page);
      await page.keyboard.press('Escape'); await frames(page);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tasks-search-toggle');
      assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), true);
      await assertHeaderFit(page);
    } finally { await page.close(); }
  });
}

test('search retains its query and filtering across collapse, live reload and reopen', async () => {
  const page = await mount();
  try {
    await page.click('#tasks-search-toggle'); await page.type('#tasks-search', 'Laundry');
    await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#tasks-search-toggle', node => node.getAttribute('aria-expanded')), 'false');
    assert.match(await page.$eval('#tasks-search-toggle', node => node.getAttribute('aria-label')), /Laundry/);
    await page.evaluate(() => window.subject.loadTasks(window.taskContainer));
    assert.equal(await page.$$eval('.task-card', nodes => nodes.length), 1);
    assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), true);
    await page.click('#tasks-search-toggle');
    assert.equal(await page.$eval('#tasks-search', node => node.value), 'Laundry');
    await page.click('[data-page-search-clear]');
    await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 2);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tasks-search');
    assert.equal(await page.$eval('#tasks-search-toggle', node => node.classList.contains('tasks-toolbar__search-toggle--active')), false);
  } finally { await page.close(); }
});

test('search is keyboard reachable and History hides it without losing the query', async () => {
  const page = await mount(412, 'Laundry');
  try {
    assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), false, 'restored active filter is visible');
    await page.focus('#tasks-search-toggle'); await page.keyboard.press('Space');
    assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tasks-search');
    await page.click('#task-view-btn');
    await page.click('[data-task-view="history"]');
    assert.equal(await page.$eval('#tasks-search-toggle', node => node.hidden), true);
    assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), true);
    await page.click('#task-view-btn'); await page.click('[data-task-view="list"]');
    assert.equal(await page.$eval('#tasks-search', node => node.value), 'Laundry');
    assert.equal(await page.$eval('#tasks-search-toggle', node => node.hidden), false);
    assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), false);
  } finally { await page.close(); }
});

test('switching List and Kanban preserves an intentionally collapsed search', async () => {
  const page = await mount(390, 'Laundry');
  try {
    await page.focus('[data-page-search-clear]'); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tasks-search-toggle');
    await page.click('#task-view-btn'); await page.click('[data-task-view="kanban"]');
    assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), true);
    assert.equal(await page.$eval('#tasks-search', node => node.value), 'Laundry');
    await page.click('#task-view-btn'); await page.click('[data-task-view="list"]');
    assert.equal(await page.$eval('#tasks-search-panel', node => node.hidden), true);
    assert.equal(await page.$eval('#tasks-search', node => node.value), 'Laundry');
    await assertHeaderFit(page);
  } finally { await page.close(); }
});
