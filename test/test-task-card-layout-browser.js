import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import puppeteer from 'puppeteer';

// Exercise the real page, card renderer, inherited application styles and
// delegated handlers against a loopback-only fixture API. No household data.
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const applicationStyles = [...readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(match => match[0]).join('\n');
const output = process.env.CARD_QA_OUTPUT;
if (output) mkdirSync(output, { recursive: true });
const baseline = process.env.CARD_QA_BASELINE === '1';
const app = express();
let server, browser, base, tasks, writes;
app.use(express.json());
app.use(express.static(publicDir));
app.get('/card-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${applicationStyles}
  <link rel="stylesheet" href="/styles/tasks.css"><script src="/lucide.min.js"></script>
  <style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}
    .app-content{height:100vh;flex:none}#main-content{padding:16px}
    *,*::before,*::after{animation:none!important;scroll-behavior:auto!important;transition:none!important}
  </style></head><body><div class="app-content"><main id="main-content"></main></div></body></html>`));
const people = [{ id: 1, display_name: 'Creator' }, { id: 2, display_name: 'Duane Sebastian Montgomery' },
  { id: 3, display_name: 'Eleanor Alexandra Montgomery' }];
app.use('/api/v1', (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) writes.push({ method: req.method, path: req.path, body: req.body });
  if (req.path === '/auth/me') return res.json({ user: { id: 1, role: 'admin' }, permissions: { admin: true }, csrfToken: 'fixture' });
  if (req.path === '/tasks/meta/options') return res.json({ users: people,
    categories: [{ key: 'household', name: 'Household', sort_order: 0 }], tags: [], default_points: 0 });
  if (req.path === '/preferences') return res.json({ data: { tasks_subtasks_expanded: false } });
  if (req.path === '/automation/activity-options') return res.json({ data: { activities: [], skills: [] } });
  if (req.path === '/tasks' && req.method === 'GET') return res.json({ data: tasks });
  const detail = req.path.match(/^\/tasks\/(\d+)$/);
  if (detail) return res.json({ data: tasks.find(row => row.id === Number(detail[1])) });
  return res.json({ data: [] });
});

const longTitle = 'Eleanor’s weekly laundry, bedding and school uniform preparation';
function makeTask(id, patch = {}) {
  return { id, revision: 7, title: id === 1 ? "Dad’s Laundry" : longTitle,
    category: 'household', description: 'Gather the laundry, sort lights and darks, then wash the bedding. Follow the instructions for each appliance and return clean clothes to their proper places.',
    assigned_to: 2, assigned_name: people[1].display_name, assigned_users: [people[1]], created_by: 1,
    visibility: 'all', status: 'open', priority: 'medium', points: 5, is_recurring: true,
    due_date: '2026-09-13', due_time: '23:30', location: { name: 'Home laundry room', address: 'Downstairs, beside the kitchen' },
    tags: ['laundry', 'personal', 'routine', 'bedding rotation', 'school preparation'], documents: [],
    permissions: { view: true, complete: true, edit: true, delete_archive: true, comment: true },
    subtasks: Array.from({ length: 8 }, (_, index) => ({ id: id * 100 + index + 1, parent_task_id: id,
      parent_revision: 7, revision: 2, title: index === 0 ? 'Load and start the washing machine using the bedding programme' : `Laundry action ${index + 1}`,
      status: index < 3 ? 'done' : 'open', points: index === 0 ? 2 : 0,
      assigned_users: [people[1]], permissions: { view: true, complete: true } })), ...patch };
}

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

async function mount({ mode = 'kanban', width = 390, theme = 'dark', palette = 'warm', typography = 'sans', doneTask = false, longList = false } = {}) {
  writes = [];
  tasks = [makeTask(1), makeTask(2, { status: 'in_progress', priority: 'high', assigned_to: 3,
    assigned_users: [people[2]], supervision: { state: 'needed', actions: [] } }),
  makeTask(3, { title: 'Gather clothes', subtasks: [], description: '', points: 0, due_date: null, due_time: null,
    tags: [], priority: 'none', is_recurring: false, location: null })];
  if (doneTask) tasks.push(makeTask(4, { title: 'Finished laundry', status: 'done', subtasks: [] }));
  if (longList) tasks.push(...Array.from({ length: 20 }, (_, index) => makeTask(10 + index)));
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
  await page.emulateTimezone('America/New_York');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/card-test?view=${mode}`);
  await page.evaluate(async ({ theme, palette, typography }) => {
    localStorage.clear(); localStorage.setItem('yuvomi:swipeHintSeen', '3'); localStorage.setItem('yuvomi-locale', 'en');
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colorTheme = palette;
    document.documentElement.dataset.typography = typography;
    window.yuvomi = { showToast() {} };
    window.EventSource = class { addEventListener() {} close() {} };
    await (await import('/i18n.js')).initI18n();
    (await import('/permissions.js')).setPermissions({ admin: true });
    const module = await import('/pages/tasks.js');
    window.subject = module.__test;
    window.taskContainer = document.getElementById('main-content');
    window.stopTasks = await module.render(window.taskContainer, { user: { id: 1, role: 'admin' } });
    window.subject.state.expandedTasks.clear();
    window.subject.state.expandedSubtasks.clear();
    window.subject.renderTaskList(window.taskContainer);
  }, { theme, palette, typography });
  await page.waitForSelector('.task-card[data-task-id="1"]');
  await frames(page);
  assert.deepEqual(errors, [], 'application mounts without runtime errors');
  return page;
}

async function report(page, id = 1) {
  return page.$eval(`.task-card[data-task-id="${id}"]`, card => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const selectors = ['.activity-card__title', '.activity-card__when', '.activity-card__when .due-date:not(.activity-card__location)', '.activity-card__status-label',
      '.activity-card__progress-label', '.activity-card__assignee', '.activity-card__points', '.task-status-btn',
      '.activity-card__details-toggle', '.task-card__drag-handle', '.activity-card__subtasks-toggle'];
    const elements = Object.fromEntries(selectors.map(selector => {
      const node = card.querySelector(selector);
      if (!node) return [selector, null];
      const style = getComputedStyle(node);
      return [selector, { ...rect(node), text: node.textContent.trim(), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflow: style.overflow, textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace, display: style.display, ariaLabel: node.getAttribute('aria-label') }];
    }));
    return { card: rect(card), scrollWidth: card.scrollWidth, clientWidth: card.clientWidth, elements,
      dueText: card.querySelector('.activity-card__when')?.innerText,
      actionIds: [...card.querySelectorAll('[data-action][data-id]')].map(node => [node.dataset.action, node.dataset.id]),
      allDraggables: [...card.querySelectorAll('[draggable="true"]')].map(node => node.matches('[data-task-drag-handle]')) };
  });
}

function assertReadable(measure, selectors) {
  assert.ok(measure.scrollWidth <= measure.clientWidth + 1, 'card has no concealed horizontal overflow');
  for (const selector of selectors) {
    const node = measure.elements[selector];
    assert.ok(node, `${selector} remains present`);
    assert.ok(node.scrollWidth <= node.clientWidth + 1, `${selector} text is not horizontally cut off: ${JSON.stringify(node)}`);
    assert.ok(node.scrollHeight <= node.clientHeight + 1, `${selector} text is not vertically cut off`);
    assert.ok(node.x >= measure.card.x - 1 && node.right <= measure.card.right + 1, `${selector} fits inside its card`);
  }
  for (const [left, right] of [['.activity-card__title', '.activity-card__points'],
    ['.activity-card__when', '.activity-card__points'], ['.activity-card__assignee', '.task-status-btn'],
    ['.task-status-btn', '.task-card__drag-handle']]) {
    const a = measure.elements[left], b = measure.elements[right];
    if (!a || !b) continue;
    const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    assert.ok(overlapX <= 1 || overlapY <= 1, `${left} and ${right} do not collide`);
  }
}

const primaryText = ['.activity-card__title', '.activity-card__when .due-date:not(.activity-card__location)',
  '.activity-card__progress-label', '.activity-card__assignee'];

async function evidence(page, name, value) {
  if (!output) return;
  const viewport = page.viewport();
  const card = await page.$('.task-card[data-task-id="1"]');
  const bounds = await card.boundingBox();
  // A tall expanded card sits in the application's own scrollport. Make the
  // capture viewport tall enough instead of taking a misleading clipped crop.
  if (bounds.height + 500 > viewport.height) {
    await page.setViewport({ ...viewport, height: Math.ceil(bounds.height + 500) });
    await page.$eval('.app-content', node => { node.scrollTop = 0; });
    await frames(page);
  }
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  await card.screenshot({ path: path.join(output, `${name}-card.png`) });
  writeFileSync(path.join(output, `${name}.json`), JSON.stringify(value, null, 2));
  if (page.viewport().height !== viewport.height) await page.setViewport(viewport);
}

for (const layout of [{ mode: 'kanban', width: 390 }, { mode: 'kanban', width: 412 }, { mode: 'kanban', width: 1280 },
  { mode: 'list', width: 390 }, { mode: 'list', width: 1280 }]) {
  test(`${layout.mode} ${layout.width}px card keeps title, complete due time, status and progress readable`, async () => {
    const page = await mount(layout);
    try {
      if (layout.mode === 'kanban') await page.$eval('[data-section-status="in_progress"]', button => button.click());
      const small = await report(page);
      await evidence(page, `${baseline ? 'before' : 'after'}-${layout.mode}-${layout.width}`, small);
      if (baseline) return;
      assertReadable(small, primaryText);
      assert.match(small.dueText, /11:30|23:30/, 'the actual due time remains in the card');
      assert.match(small.elements['.activity-card__progress-label'].text, /3\s*(?:\/|of)\s*8/);
      assert.match(small.elements['.activity-card__progress-label'].text, /38%/);
      assert.equal(small.elements['.activity-card__status-label'], null, 'normal status uses its labelled control without duplicate prose');
      assert.match(small.elements['.task-status-btn'].ariaLabel, /Not Started/i, 'icon control explains the current status accessibly');
      for (const selector of ['.task-status-btn', '.activity-card__details-toggle', '.activity-card__subtasks-toggle',
        ...(layout.mode === 'kanban' ? ['.task-card__drag-handle'] : [])]) {
        const control = small.elements[selector];
        assert.ok(control.width >= 43.5 && control.height >= 43.5, `${selector} has a 44px touch target`);
      }
      assert.ok(small.actionIds.some(([action, id]) => action === 'open-task' && id === '1'));
      assert.ok(small.actionIds.some(([action, id]) => action === 'toggle-status' && id === '1'));
      assert.ok(small.allDraggables.every(Boolean), 'only the explicit handle is draggable');
      const hiddenTags = await page.$$eval('[data-responsive-tag][hidden]', nodes => nodes.map(node => getComputedStyle(node).display));
      assert.ok(hiddenTags.every(display => display === 'none'), 'overflowed tags are hidden when the +N marker is shown');
      const inProgress = await report(page, 2);
      assertReadable(inProgress, primaryText);
      assert.match(inProgress.elements['.task-status-btn'].ariaLabel, /In Progress/i);
    } finally { await page.close(); }
  });
}

test('expanded card preserves description, participants and linked operational subtask controls on mobile', async () => {
  const page = await mount({ mode: 'list', width: 390 });
  try {
    await page.click('[data-action="toggle-activity-details"][data-id="1"]');
    await page.click('[data-action="toggle-subtasks"][data-id="1"]');
    await frames(page);
    const measure = await report(page);
    await evidence(page, `${baseline ? 'before' : 'after'}-expanded-mobile`, measure);
    if (baseline) return;
    assert.ok(await page.$eval('#activity-details-1', node => node.innerText.includes('Gather the laundry')));
    assert.equal(await page.$$eval('#subtasks-1 .subtask-item', nodes => nodes.length), 8);
    assert.equal(await page.$eval('[data-action="toggle-subtasks"][data-id="1"]', node => node.getAttribute('aria-expanded')), 'true');
    const steps = await page.$$eval('#subtasks-1 .subtask-item', nodes => nodes.map(node => {
      const title = node.querySelector('.subtask-item__title');
      const checkbox = node.querySelector('[data-action="toggle-subtask"]');
      const r = checkbox.getBoundingClientRect();
      return { id: checkbox.dataset.id, titleWidth: title.clientWidth, titleScroll: title.scrollWidth,
        width: r.width, height: r.height, cardWidth: node.clientWidth, scrollWidth: node.scrollWidth };
    }));
    assert.deepEqual(steps.map(step => step.id), Array.from({ length: 8 }, (_, i) => String(101 + i)));
    for (const step of steps) {
      assert.ok(step.titleScroll <= step.titleWidth + 1, 'long subtask title wraps without clipping');
      assert.ok(step.scrollWidth <= step.cardWidth + 1, 'subtask row does not overflow');
      assert.ok(step.width >= 43.5 && step.height >= 43.5, 'subtask toggle has a 44px target');
    }
    assertReadable(measure, primaryText);
  } finally { await page.close(); }
});

for (const palette of ['warm', 'neutral', 'cool']) for (const theme of ['light', 'dark']) {
  test(`${palette} ${theme} serif card retains readable primary information at 390px`, async () => {
    const page = await mount({ mode: 'list', width: 390, palette, theme, typography: 'serif' });
    try {
      const measure = await report(page, 2);
      await evidence(page, `${baseline ? 'before' : 'after'}-${palette}-${theme}-serif`, measure);
      if (!baseline) assertReadable(measure, primaryText);
    } finally { await page.close(); }
  });
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function holdTitle(page, id = 1) {
  const title = await page.$(`.activity-card__open[data-id="${id}"]`);
  await title.scrollIntoView();
  // Scrolling is intentionally a cancellation signal. Start a distinct contact
  // only once the programmatic fixture positioning has settled.
  await pause(250);
  const box = await title.boundingBox();
  await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + 10);
  await page.mouse.down();
}

test('one-second title hold selects one Task without opening or mutating it; compact checkboxes keep 44px targets', async () => {
  const page = await mount({ mode: 'list', width: 390 });
  try {
    const before = structuredClone(tasks);
    await holdTitle(page);
    await pause(700);
    assert.equal(await page.$('.task-bulk-checkbox'), null, 'selection does not activate early');
    await page.waitForSelector('.task-bulk-checkbox[data-task-id="1"]');
    await page.mouse.up();
    await frames(page);
    assert.deepEqual(await page.evaluate(() => [...window.subject.state.selectedTaskIds]), [1]);
    assert.equal(await page.$('.detail-view__pane'), null, 'release after a hold does not open Task detail');
    const checkbox = await page.$eval('.task-bulk-checkbox[data-task-id="1"]', node => {
      const inner = node.getBoundingClientRect(), outer = node.closest('label').getBoundingClientRect();
      return { width: inner.width, height: inner.height, targetWidth: outer.width, targetHeight: outer.height,
        checked: node.checked, label: node.getAttribute('aria-label') };
    });
    assert.equal(checkbox.width, 18);
    assert.equal(checkbox.height, 18);
    assert.ok(checkbox.targetWidth >= 44 && checkbox.targetHeight >= 44);
    assert.equal(checkbox.checked, true);
    assert.match(checkbox.label, /Dad’s Laundry/);
    await evidence(page, 'after-mobile-selection', await report(page));
    await page.click('#bulk-exit');
    assert.equal(await page.$('.task-bulk-checkbox'), null);
    assert.deepEqual(await page.evaluate(() => [...window.subject.state.selectedTaskIds]), []);
    assert.deepEqual(tasks, before, 'selection preserves Task/progress data');
    assert.deepEqual(writes, [], 'selection and exit perform no API mutation');
  } finally { await page.close(); }
});

test('Shift+Space enters selection and Escape exits; ordinary title activation still opens detail', async () => {
  const page = await mount({ mode: 'list', width: 1280 });
  try {
    await page.focus('.activity-card__open[data-id="1"]');
    await page.keyboard.down('Shift'); await page.keyboard.press('Space'); await page.keyboard.up('Shift');
    assert.deepEqual(await page.evaluate(() => [...window.subject.state.selectedTaskIds]), [1]);
    assert.equal(await page.$('.detail-view__pane'), null);
    await page.keyboard.press('Escape');
    assert.equal(await page.$('.task-bulk-checkbox'), null);
    assert.deepEqual(await page.evaluate(() => [...window.subject.state.selectedTaskIds]), []);
    await page.click('.activity-card__open[data-id="1"]');
    await page.waitForSelector('.detail-view__pane');
    assert.equal(await page.evaluate(() => window.subject.state.bulkSelectMode), false);
    assert.deepEqual(writes, [], 'selection and opening details remain read-only');
  } finally { await page.close(); }
});

test('movement cancels a pending selection hold and permits normal List scrolling', async () => {
  const page = await mount({ mode: 'list', width: 390, longList: true });
  try {
    await holdTitle(page);
    await page.mouse.move(100, 650, { steps: 3 });
    await page.mouse.wheel({ deltaY: 200 });
    await pause(1100);
    await page.mouse.up();
    assert.equal(await page.$('.task-bulk-checkbox'), null);
    assert.equal(await page.evaluate(() => window.subject.state.bulkSelectMode), false);
    assert.ok(await page.$eval('.app-content', node => node.scrollTop) > 0);
    assert.deepEqual(writes, []);
  } finally { await page.close(); }
});

test('status icons distinguish empty, half-filled and completed green-check states with accessible labels', async () => {
  const page = await mount({ mode: 'kanban', width: 1280, doneTask: true });
  try {
    await page.$eval('[data-section-status="in_progress"]', node => node.click());
    await page.$eval('[data-section-status="done"]', node => node.click());
    const statuses = await page.$$eval('.task-status-btn', nodes => Object.fromEntries(nodes.map(node => {
      const face = getComputedStyle(node, '::after');
      const check = node.querySelector('.task-status-btn__check');
      return [node.dataset.id, { label: node.getAttribute('aria-label'), title: node.title,
        background: face.backgroundColor, image: face.backgroundImage, check: getComputedStyle(check).display }];
    })));
    assert.match(statuses[1].label, /Not Started/);
    assert.equal(statuses[1].image, 'none');
    assert.equal(statuses[1].check, 'none');
    assert.match(statuses[2].label, /In Progress/);
    assert.match(statuses[2].image, /linear-gradient/);
    assert.match(statuses[2].image, /50%/);
    assert.equal(statuses[2].check, 'none');
    assert.match(statuses[4].label, /Completed/);
    assert.equal(statuses[4].check, 'block');
    const [red, green, blue] = statuses[4].background.match(/\d+/g).map(Number);
    assert.ok(green > red && green > blue, 'completed status has a green success fill');
    assert.deepEqual(writes, []);
  } finally { await page.close(); }
});
