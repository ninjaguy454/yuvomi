import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Serve the real browser modules against controlled API boundaries. Persistence
// and eligibility use separate database route tests; this exercises the mounted
// form, native events, datepicker and modal/history integration without using
// any production or shared QA household.
const users = [{ id: 1, display_name: 'Alex', role: 'admin' }, { id: 2, display_name: 'Sam', role: 'admin' }];
const places = [{ id: 4, name: 'Home', type: 'home', active: 1 }, { id: 5, name: 'Workshop', type: 'room', active: 1 }];
const skills = [{ id: 3, name: 'Knife safety' }];
const templates = [
  { id: 11, name: 'Kitchen reset', title_template: 'Reset the kitchen', description: 'Wipe counters', category: 'misc', priority: 'high', points: 8, tags: ['Kitchen'],
    assignment_strategy: 'open_claimable', subject_required: 0, location_mode: 'none', skill_ids: [3], checklist: [{ title_template: 'Chop vegetables', skill_ids: [3] }] },
  { id: 12, name: 'Workshop reset', title_template: 'Sort the tools', description: 'Put tools away', category: 'misc', priority: 'low', points: 4, tags: ['Workshop'],
    assignment_strategy: 'open_claimable', subject_required: 0, location_mode: 'fixed', place_id: 5, skill_ids: [], checklist: [{ title_template: 'Sweep floor', skill_ids: [] }] },
  { id: 13, name: 'Personal preparation', title_template: 'Prepare for {subject}', description: 'Personal supplies', category: 'misc', priority: 'none', points: 0, tags: [],
    assignment_strategy: 'subject_skill', subject_required: 1, location_mode: 'none', skill_ids: [], checklist: [{ title_template: 'Pack for {subject}', skill_ids: [3] }] },
];
const workflow = { id: 21, name: 'Evening reset', description: 'Two connected Tasks', subject_required: 0, input_schema: [], steps: [] };
const preferenceValues = new Map(), requests = [];
const createReceipts = new Map();
const app = express();
const shellStyles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
app.use(express.json());
app.use('/api/v1', (req, res) => {
  const userId = Number(req.headers.cookie?.match(/(?:^|;\s*)draft-user=(\d+)/)?.[1] || 1);
  requests.push({ method: req.method, path: req.path, userId, body: req.body });
  if (req.path === '/tasks' && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!createReceipts.has(key)) createReceipts.set(key, { id: 99, ...req.body });
    requests.at(-1).idempotencyKey = key;
    return res.json({ data: createReceipts.get(key) });
  }
  if (req.path === '/preferences') {
    if (req.method === 'PUT') preferenceValues.set(userId, { ...preferenceValues.get(userId), ...req.body });
    return res.json({ data: { tasks_template_switch_warning: true, ...preferenceValues.get(userId) } });
  }
  if (req.path === '/tasks/meta/options') return res.json({ users, categories: [{ key: 'misc', label: 'General' }], tags: [], default_points: 3 });
  if (req.path === '/automation/activity-options') return res.json({ data: { activities: templates, skills } });
  if (req.path === '/planning/places') return res.json({ data: places });
  if (req.path === '/planning/place-search/status') return res.json({ data: { configured: false } });
  if (req.path === '/automation/quick-add') return res.json({ data: [workflow], activities: templates, members: users, places });
  if (req.path === '/automation/admin/workflow-templates') return res.json({ data: [workflow], activities: templates, variables: [], members: users, places, categories: [] });
  if (req.path === '/automation/admin/activity-templates') {
    if (req.method === 'POST') return res.json({ data: { id: 50, ...req.body } });
    return res.json({ data: templates, skills, members: users, variables: [], places, categories: [] });
  }
  if (req.path === '/automation/admin/skills' && req.method === 'POST') {
    const skill = { id: 100 + skills.length, ...req.body };
    skills.push(skill);
    return res.status(201).json({ data: skill });
  }
  return res.json({ data: [] });
});
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/draft-test', (_req, res) => res.send(`<!doctype html><html lang="en" data-theme="light" data-color-theme="warm"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${shellStyles}<link rel="stylesheet" href="/styles/tasks.css"><link rel="stylesheet" href="/styles/settings.css">
  <script src="/lucide.min.js" defer></script>
  </head><body><main id="fixture"></main></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
  browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve) || resolve());
});

async function mounted({ userId = 1, width = 1366, newTask = true, role = 'admin' } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.setDefaultTimeout(6000);
  page.on('pageerror', (error) => { page.fixtureErrors ||= []; page.fixtureErrors.push(error.message); });
  await page.goto(`${base}/draft-test`);
  await page.evaluate(async ({ userId, role }) => {
    document.cookie = `draft-user=${userId};path=/`;
    localStorage.setItem('yuvomi-lang', 'en');
    window.toasts = [];
    window.yuvomi = { showToast: (message) => window.toasts.push(message), user: { id: userId, role } };
    const { initI18n, setLocale } = await import('/i18n.js');
    await initI18n(); await setLocale('en');
    await import('/components/datepicker.js');
    const { handleBackNavigation } = await import('/utils/overlay-history.js');
    addEventListener('popstate', () => handleBackNavigation());
    const { setPermissions } = await import('/permissions.js');
    setPermissions({ admin: role === 'admin', capabilities: Object.fromEntries(['tasks.create', 'tasks.change_priority', 'tasks.change_points', 'tasks.change_category_tags', 'tasks.change_dates', 'tasks.change_assignment', 'tasks.change_required_skills', 'activities.view', 'workflows.view', 'workflows.run'].map(key => [key, 'allow'])) });
    const { render } = await import('/pages/tasks.js');
    await render(document.querySelector('#fixture'), { user: { id: userId, role } });
  }, { userId, role });
  assert.deepEqual(page.fixtureErrors || [], []);
  if (newTask) { await page.click(width < 1024 ? '#fab-new-task' : '#btn-new-task'); await page.waitForSelector('#task-form'); }
  page.dispose = () => context.close();
  return page;
}
async function value(page, selector) { return page.$eval(selector, (el) => el.value); }
async function set(page, selector, value) {
  await page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
}
async function selectTemplate(page, id, expectedTitle) {
  await page.select('#task-activity-template', String(id));
  if (expectedTitle !== undefined) await page.waitForFunction((expected) => document.querySelector('#task-title')?.value === expected, {}, expectedTitle);
}
async function activeTitle(page) { return page.$eval('#shared-modal-title', (el) => el.textContent.trim()); }

test('untouched Blank and populated templates switch without a warning and restore Home', async () => {
  preferenceValues.clear();
  const page = await mounted();
  try {
    assert.equal(await value(page, '#task-location-place'), '4');
    await selectTemplate(page, 11, 'Reset the kitchen');
    assert.equal(await value(page, '#task-location-place'), '4', 'a template without a location inherits the manual default');
    assert.equal(await page.$('#confirm-modal-ok'), null);
    await selectTemplate(page, 12, 'Sort the tools');
    assert.equal(await value(page, '#task-location-place'), '5');
    assert.equal(await page.$('#confirm-modal-ok'), null);
    await selectTemplate(page, '', '');
    assert.equal(await value(page, '#task-location-place'), '4');
    assert.equal(await page.$('#confirm-modal-ok'), null);
    assert.deepEqual(page.fixtureErrors || [], []);
  } finally { await page.dispose(); }
});

test('dirty switch Cancel preserves edits; confirmed opt-out is per user and Blank clears all authored fields', async () => {
  preferenceValues.clear(); requests.length = 0;
  const page = await mounted();
  try {
    await selectTemplate(page, 11, 'Reset the kitchen');
    await set(page, '#task-title', 'Custom kitchen Task');
    await selectTemplate(page, 12);
    await page.waitForSelector('#confirm-modal-cancel');
    await page.click('#confirm-modal-checkbox');
    await page.click('#confirm-modal-cancel');
    await page.waitForFunction(() => !document.querySelector('#confirm-modal-cancel'));
    assert.equal(await value(page, '#task-title'), 'Custom kitchen Task');
    assert.equal(await value(page, '#task-activity-template'), '11');
    assert.equal(preferenceValues.has(1), false, 'Cancel never writes the checkbox preference');
    await selectTemplate(page, 12);
    await page.waitForSelector('#confirm-modal-ok');
    await page.click('#confirm-modal-checkbox');
    await page.click('#confirm-modal-ok');
    await page.waitForFunction(() => document.querySelector('#task-title')?.value === 'Sort the tools');
    assert.equal(preferenceValues.get(1).tasks_template_switch_warning, false);
    await set(page, '#task-title', 'Altered title');
    await set(page, '#task-description', 'Altered description');
    await set(page, '#task-points', '99');
    await set(page, '#task-tag-input', 'Unsaved tag');
    await set(page, '#task-start-date', '2026-10-01');
    await set(page, '#task-due-date', '2026-10-02');
    await page.select('#task-rrule-freq', 'WEEKLY');
    await page.click('[data-task-subtask-add]');
    await set(page, '[data-task-subtask-row]:last-child [data-task-subtask-title]', 'Extra step');
    await selectTemplate(page, '', '');
    assert.equal(await value(page, '#task-description'), '');
    assert.equal(await value(page, '#task-points'), '3');
    assert.equal(await value(page, '#task-priority'), 'none');
    assert.equal(await value(page, '#task-tag-input'), '');
    assert.equal(await value(page, '#task-start-date'), '');
    assert.equal(await value(page, '#task-due-date'), '');
    assert.equal(await value(page, '#task-rrule-freq'), '');
    assert.equal(await value(page, '#task-location-place'), '4');
    assert.equal(await page.$$eval('[data-task-subtask-row]', (rows) => rows.length), 0);
    assert.equal(await page.$('#confirm-modal-ok'), null);
    const second = await mounted({ userId: 2 });
    try {
      await set(second, '#task-title', 'Second person draft');
      await selectTemplate(second, 11);
      await second.waitForSelector('#confirm-modal-ok');
      assert.equal(preferenceValues.has(2), false);
    } finally { await second.dispose(); }
    assert.deepEqual(requests.filter((request) => request.method === 'PUT' && request.path === '/preferences').map(({ userId, body }) => ({ userId, body })),
      [{ userId: 1, body: { tasks_template_switch_warning: false } }]);
    assert.deepEqual(page.fixtureErrors || [], []);
  } finally { await page.dispose(); }
});

for (const width of [1366, 768, 390]) {
  test(`Save as Template child Cancel retains the live Task draft at ${width}px`, async () => {
    preferenceValues.clear();
    const page = await mounted({ width });
    try {
      await set(page, '#task-title', 'Reusable draft');
      await set(page, '#task-description', 'Keep my work');
      await page.click('[data-task-subtask-add]');
      await set(page, '[data-task-subtask-title]', 'One personal step');
      await page.focus('[data-task-subtask-row] summary');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-task-subtask-row] details[open] .task-skill-picker__option', { visible: true });
      await page.focus('[data-task-subtask-row] [data-task-skill-id]');
      await page.keyboard.press('Space');
      await page.focus('[data-task-subtask-row] summary');
      await page.keyboard.press('Enter');
      if ([1366, 390].includes(width)) {
        await page.evaluate(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          document.querySelector('[data-task-subtask-title]').scrollIntoView({ behavior: 'instant', block: 'center' });
        });
        mkdirSync('artifacts/tasks-refinement-qa', { recursive: true });
        await page.screenshot({ path: `artifacts/tasks-refinement-qa/new-task-skilled-subtask-${width}.png` });
      }
      await page.evaluate(() => { window.parentForm = document.querySelector('#task-form'); });
      await page.click('[data-save-as-template]');
      await page.waitForSelector('#automation-activity-form');
      assert.equal(await activeTitle(page), 'New Activity Template');
      await page.click('#shared-modal-overlay [data-action="close-modal"]');
      await page.waitForFunction(() => !document.querySelector('#automation-activity-form'));
      await page.waitForFunction(() => !document.querySelector('#task-form')?.closest('[inert]'));
      assert.equal(await page.evaluate(() => window.parentForm === document.querySelector('#task-form')), true);
      assert.equal(await value(page, '#task-title'), 'Reusable draft');
      assert.equal(await value(page, '#task-description'), 'Keep my work');
      assert.equal(await value(page, '[data-task-subtask-title]'), 'One personal step');
      assert.deepEqual(page.fixtureErrors || [], []);
    } finally { await page.dispose(); }
  });
}

test('workflow creator Cancel and runtime browser Back return to the retained launcher', async () => {
  const page = await mounted({ newTask: false });
  try {
    await page.click('#btn-quick-add');
    await page.waitForSelector('[data-workflow-launcher]');
    await page.evaluate(() => { window.launcher = document.querySelector('[data-workflow-launcher]'); });
    assert.equal(await page.$('[data-quick-activity]'), null);
    await page.click('[data-create-task-workflow]');
    await page.waitForSelector('#automation-workflow-form');
    await page.click('#shared-modal-overlay [data-action="close-modal"]');
    await page.waitForFunction(() => document.querySelector('#shared-modal-title')?.textContent === 'Task Workflows');
    assert.equal(await page.evaluate(() => window.launcher === document.querySelector('[data-workflow-launcher]')), true);
    await page.click('[data-quick-template="21"]');
    await page.waitForSelector('#quick-add-form');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.querySelector('#shared-modal-title')?.textContent === 'Task Workflows');
    assert.equal(await page.evaluate(() => window.launcher === document.querySelector('[data-workflow-launcher]')), true);
    assert.deepEqual(page.fixtureErrors || [], []);
  } finally { await page.dispose(); }
});

test('lost create response freezes subject-generated subtasks, preserves assignment UI, and retries the same Task identity', async () => {
  preferenceValues.clear(); requests.length = 0; createReceipts.clear();
  const page = await mounted();
  try {
    await selectTemplate(page, 13);
    await page.waitForFunction(() => document.querySelector('#task-activity-template')?.value === '13');
    await page.select('#task-activity-subject-user', '1');
    assert.equal(await value(page, '[data-task-subtask-title]'), 'Pack for Alex');
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      let firstCreate = true;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]).endsWith('/api/v1/tasks') && args[1]?.method === 'POST' && firstCreate) {
          firstCreate = false;
          throw new TypeError('Simulated lost response after server acceptance');
        }
        return response;
      };
    });
    await page.click('#task-submit-btn');
    await page.waitForFunction(() => document.querySelector('#task-form-error')?.hidden === false && document.querySelector('#task-submit-btn')?.disabled === false);
    assert.equal(createReceipts.size, 1, 'the accepted server-side Task exists despite the missing response');
    assert.equal(await page.$eval('[data-task-subtask-title]', (el) => el.disabled), true);
    await page.select('#task-activity-subject-user', '2');
    assert.equal(await value(page, '[data-task-subtask-title]'), 'Pack for Alex', 'subject changes cannot rebuild a possibly-persisted child snapshot');
    assert.equal(await page.$eval('[data-task-subtask-add]', (el) => el.disabled), true);
    await selectTemplate(page, '');
    assert.equal(await value(page, '#task-activity-template'), '13');
    assert.equal(await page.$eval('#task-manual-assignment-mode', (el) => el.hidden), true);
    assert.equal(await page.$eval('#task-activity-subject', (el) => el.hidden), false);
    await page.focus('#task-submit-btn');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#task-form')).catch(async (error) => {
      const state = await page.evaluate(() => ({ error: document.querySelector('#task-form-error')?.textContent,
        submit: document.querySelector('#task-submit-btn')?.outerHTML, toasts: window.toasts }));
      throw new Error(`Task retry did not close: ${JSON.stringify({ state, requests: requests.filter((request) => request.method !== 'GET') })}`, { cause: error });
    });
    const creates = requests.filter((request) => request.path === '/tasks' && request.method === 'POST');
    assert.equal(creates.length, 2);
    assert.ok(creates[0].idempotencyKey);
    assert.equal(creates[0].idempotencyKey, creates[1].idempotencyKey);
    assert.deepEqual(creates[0].body, creates[1].body);
    assert.equal(createReceipts.size, 1);
    assert.equal([...createReceipts.values()][0].subtasks[0].title, 'Pack for Alex');
    assert.deepEqual(page.fixtureErrors || [], []);
  } finally { await page.dispose(); }
});

for (const width of [1366, 390]) {
  test(`creating a missing subtask Skill retains the Task draft and catalogue at ${width}px`, async () => {
    preferenceValues.clear(); skills.splice(1);
    const page = await mounted({ width });
    try {
      await set(page, '#task-title', 'Keep this Task');
      await page.focus('[data-task-subtask-add]'); await page.keyboard.press('Enter');
      await page.waitForSelector('[data-task-subtask-title]');
      await set(page, '[data-task-subtask-title]', 'Weigh ingredients');
      await page.evaluate(() => { window.originalTaskForm = document.querySelector('#task-form'); });
      await page.focus('[data-task-subtask-row] summary'); await page.keyboard.press('Enter');
      await page.waitForSelector('[data-task-subtask-row] details[open] [data-create-skill]', { visible: true });
      await page.focus('[data-task-subtask-row] [data-create-skill]'); await page.keyboard.press('Enter');
      await page.waitForSelector('#automation-skill-form');
      await page.click('#shared-modal-overlay [data-action="close-modal"]');
      await page.waitForFunction(() => !document.querySelector('#automation-skill-form'));
      assert.equal(await value(page, '[data-task-subtask-title]'), 'Weigh ingredients');
      assert.equal(skills.length, 1, 'Cancel does not create a Skill');
      await page.focus('[data-task-subtask-row] [data-create-skill]'); await page.keyboard.press('Enter');
      await page.waitForSelector('#automation-skill-form');
      await set(page, '#automation-skill-form [name="name"]', 'Use a kitchen scale');
      await page.select('#automation-skill-form [name="age_promotion"]', 'normal');
      await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#automation-skill-form'));
      await page.waitForFunction(() => document.querySelector('[data-task-subtask-row] [data-task-skill-id][value="101"]')?.checked);
      mkdirSync('artifacts/tasks-refinement-qa', { recursive: true });
      await page.screenshot({ path: `artifacts/tasks-refinement-qa/created-subtask-skill-${width}.png` });
      assert.equal(await page.evaluate(() => document.querySelector('#task-form') === window.originalTaskForm), true);
      assert.equal(await value(page, '#task-title'), 'Keep this Task');
      assert.equal(await page.$eval('[data-task-subtask-row] [data-task-skill-summary]', (el) => el.textContent), '1 selected');
      await page.click('[data-task-subtask-add]');
      assert.equal(await page.$eval('[data-task-subtask-row]:last-child [data-task-skill-id][value="101"]', (el) => el.checked), false);
      assert.match(await page.$eval('[data-task-subtask-row]:last-child .task-skill-picker__options', (el) => el.textContent), /Use a kitchen scale/);
      await selectTemplate(page, 11);
      await page.waitForSelector('#confirm-modal-ok'); await page.click('#confirm-modal-ok');
      await page.waitForFunction(() => document.querySelector('#task-title')?.value === 'Reset the kitchen');
      assert.match(await page.$eval('[data-task-subtask-row] .task-skill-picker__options', (el) => el.textContent), /Use a kitchen scale/);
      assert.deepEqual(page.fixtureErrors || [], []);
    } finally { await page.dispose(); }
  });
}

test('nested Activity subtask Skill creation selects the saved Skill and returns through Save as Template to the Task', async () => {
  preferenceValues.clear(); requests.length = 0; skills.splice(1);
  const page = await mounted({ width: 768 });
  try {
    await set(page, '#task-title', 'Reusable preparation');
    await page.click('[data-task-subtask-add]');
    await set(page, '[data-task-subtask-title]', 'Measure flour');
    await page.click('[data-save-as-template]');
    await page.waitForSelector('#automation-activity-form');
    await page.focus('#automation-activity-form [data-task-subtask-row] summary'); await page.keyboard.press('Enter');
    await page.click('#automation-activity-form [data-task-subtask-row] [data-create-skill]');
    await page.waitForSelector('#automation-skill-form');
    await set(page, '#automation-skill-form [name="name"]', 'Measure dry ingredients');
    await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#automation-skill-form'));
    await page.waitForFunction(() => document.querySelector('#automation-activity-form [data-task-skill-id][value="101"]')?.checked);
    await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#automation-activity-form'));
    assert.equal(await value(page, '#task-title'), 'Reusable preparation');
    const save = requests.find((request) => request.path === '/automation/admin/activity-templates' && request.method === 'POST');
    assert.deepEqual(save.body.checklist, [{ title_template: 'Measure flour', skill_ids: [101] }]);
    assert.equal(await page.$eval('#task-form [data-task-subtask-row] [data-task-skill-id][value="101"]', (el) => el.checked), false,
      'saving a reusable template does not replace the current Task requirement selection');
    assert.deepEqual(page.fixtureErrors || [], []);
  } finally { await page.dispose(); }
});

test('members can select existing subtask Skills without seeing administrator-only creation', async () => {
  const page = await mounted({ role: 'member' });
  try {
    await page.focus('[data-task-subtask-add]'); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-task-subtask-title]');
    await page.focus('[data-task-subtask-row] summary'); await page.keyboard.press('Enter');
    assert.equal(await page.$('[data-create-skill]'), null);
    assert.ok(await page.$('[data-task-subtask-row] [data-task-skill-id][value="3"]'));
  } finally { await page.dispose(); }
});
