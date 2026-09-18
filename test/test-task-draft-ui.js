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
const users = [{ id: 1, display_name: 'Alex', role: 'admin' }, { id: 2, display_name: 'Eleanor', role: 'admin' }];
const places = [{ id: 4, name: 'Home', type: 'home', active: 1 }, { id: 5, name: 'Workshop', type: 'room', active: 1 }];
const skills = [{ id: 3, name: 'Knife safety' }];
const templates = [
  { id: 11, name: 'Kitchen reset', title_template: 'Reset the kitchen', description: 'Wipe counters', category: 'misc', priority: 'high', points: 8, tags: ['Kitchen'],
    assignment_strategy: 'open_claimable', subject_required: 0, location_mode: 'none', skill_ids: [3], checklist: [{ title_template: 'Chop vegetables', skill_ids: [3] }] },
  { id: 12, name: 'Workshop reset', title_template: 'Sort the tools', description: 'Put tools away', category: 'misc', priority: 'low', points: 4, tags: ['Workshop'],
    assignment_strategy: 'open_claimable', subject_required: 0, location_mode: 'fixed', place_id: 5, skill_ids: [], checklist: [{ title_template: 'Sweep floor', skill_ids: [] }] },
  { id: 13, name: 'Personal preparation', title_template: 'Prepare for {subject}', description: 'Personal supplies', category: 'misc', priority: 'none', points: 0, tags: [],
    assignment_strategy: 'subject_skill', subject_required: 1, location_mode: 'none', skill_ids: [], checklist: [{ title_template: 'Pack for {subject}', skill_ids: [3] }] },
  { id: 14, name: 'Morning routine', title_template: 'Get Ready for the Day', points: 2, assignment_strategy: 'fixed', fixed_user_id: 2,
    due_date_offset_days: 0,
    allow_assignment_override: 1, start_time: '07:00', due_time: '08:00', expiration_policy: 'expire_incomplete',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', recurrence_from_completion: 0,
    checklist: [{ title_template: 'Get dressed', is_optional: 0, skill_ids: [] }, { title_template: 'Put in earrings', is_optional: 1, skill_ids: [] }] },
  { id: 15, name: 'Get Ready for School', title_template: '{{assignee.first_name}} Get Ready for School', points: 2,
    assignment_strategy: 'subject_skill', subject_required: 1, input_schema: [], checklist: [] },
  { id: 16, name: 'Weekly homework', title_template: 'Weekly Homework', points: 5, assignment_strategy: 'fixed', fixed_user_id: 2,
    due_date_offset_days: 4, start_time: '15:30', due_time: '07:30', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', expiration_policy: 'keep_overdue', checklist: [] },
];
const workflow = { id: 21, name: 'Evening reset', description: 'Two connected Tasks', subject_required: 0, input_schema: [], steps: [] };
const preferenceValues = new Map(), requests = [];
let editFixture = null, editFailure = null;
const createReceipts = new Map();
const app = express();
const shellStyles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
app.use(express.json());
app.use('/api/v1', (req, res) => {
  const userId = Number(req.headers.cookie?.match(/(?:^|;\s*)draft-user=(\d+)/)?.[1] || 1);
  requests.push({ method: req.method, path: req.path, userId, body: req.body });
  if (req.path === '/reminders' && req.method === 'GET') return res.json({ data: null });
  if (req.path === '/tasks/70' && editFixture) {
    if (req.method === 'PUT') {
      if (editFailure) return res.status(editFailure.status).json({ error: editFailure.message });
      const currentPreserved = req.body.edit_scope === 'future' && ['done', 'expired'].includes(editFixture.status);
      editFixture = { ...editFixture, ...req.body, assigned_to: 2, revision: editFixture.revision + 1 };
      return res.json({ data: editFixture, series_edit: { preserved: req.body.edit_scope === 'future' ? [80] : [], current_preserved: currentPreserved } });
    }
    return res.json({ data: editFixture });
  }
  if (req.path === '/automation/activity-templates/15/resolve' && req.method === 'POST') {
    if (req.body.subject_user_id !== 2) return res.status(400).json({ error: 'Choose or enter a value for “Assignee”.' });
    return res.json({ data: { title: 'Eleanor Get Ready for School', description: '', checklist: [] } });
  }
  if (req.path === '/tasks' && req.method === 'POST') {
    if (req.body.title === 'Server validation fixture' && !req.body.assigned_to?.length) return res.status(400).json({ error: 'Choose an assignee.' });
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
    if (req.method === 'POST') { const saved = { id: 50, ...req.body }; templates.splice(templates.findIndex(item => item.id === 50) < 0 ? templates.length : templates.findIndex(item => item.id === 50), 1, saved); return res.json({ data: saved }); }
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

async function mounted({ userId = 1, width = 1366, newTask = true, role = 'admin', editTask = null } = {}) {
  if (editTask) { editFixture = structuredClone(editTask); editFailure = null; }
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
  if (editTask) {
    await page.evaluate(async () => { const { openTaskById } = await import('/pages/tasks.js'); await openTaskById(70, { user: { id: 1, role: 'admin' } }); });
    await page.click('#detail-view-edit'); await page.waitForSelector('#task-form');
  } else if (newTask) { await page.click(width < 1024 ? '#fab-new-task' : '#btn-new-task'); await page.waitForSelector('#task-form'); }
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
      await page.focus('[data-task-subtask-row] .task-skill-picker summary');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-task-subtask-row] .task-skill-picker details[open] .task-skill-picker__option', { visible: true });
      await page.focus('[data-task-subtask-row] [data-task-skill-id]');
      await page.keyboard.press('Space');
      await page.focus('[data-task-subtask-row] .task-skill-picker summary');
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
      await page.focus('[data-task-subtask-row] .task-skill-picker summary'); await page.keyboard.press('Enter');
      await page.waitForSelector('[data-task-subtask-row] .task-skill-picker details[open] [data-create-skill]', { visible: true });
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
    await page.focus('#automation-activity-form [data-task-subtask-row] .task-skill-picker summary'); await page.keyboard.press('Enter');
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
    assert.deepEqual(save.body.checklist, [{ title: 'Measure flour', title_template: 'Measure flour', skill_ids: [101], is_optional: 0 }]);
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
    await page.focus('[data-task-subtask-row] .task-skill-picker summary'); await page.keyboard.press('Enter');
    assert.equal(await page.$('[data-create-skill]'), null);
    assert.ok(await page.$('[data-task-subtask-row] [data-task-skill-id][value="3"]'));
  } finally { await page.dispose(); }
});

for (const width of [1366, 390]) {
  test(`validation from the bottom announces all errors, focuses the field and preserves the draft at ${width}px`, async () => {
    const page = await mounted({ width });
    try {
      await set(page, '#task-description', 'Keep every word');
      await set(page, '#task-start-date', '2026-09-17');
      await set(page, '#task-start-time', '09:00');
      await set(page, '#task-due-date', '2026-09-17');
      await set(page, '#task-due-time', '08:00');
      await page.evaluate(async () => {
        const { taskDraftSnapshot } = await import('/utils/task-draft.js');
        window.draftBeforeValidation = taskDraftSnapshot(document.querySelector('#task-form'));
        document.querySelector('#task-form-error').parentElement.scrollIntoView({ block: 'end' });
      });
      await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
      await page.waitForSelector('#task-form-error:not([hidden])');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'task-title');
      assert.match(await page.$eval('#task-form-error', el => el.textContent), /Task couldn't be created.*Give this Task a title.*Due date and time/s);
      assert.equal(await page.$eval('#task-form-error', el => el.getAttribute('role')), 'alert');
      assert.equal(await value(page, '#task-description'), 'Keep every word');
      assert.equal(await page.evaluate(async () => {
        const { taskDraftSnapshot } = await import('/utils/task-draft.js');
        return taskDraftSnapshot(document.querySelector('#task-form')) === window.draftBeforeValidation;
      }), true, 'validation never changes the authored draft or dirty comparison');
      assert.ok(await page.$eval('#task-title', el => { const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }));
      assert.match(await page.evaluate(() => window.toasts.at(-1)), /Task couldn't be created/);
      await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#task-title', el => (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id === 'task-form-error').length), 1);
      await set(page, '#task-title', 'Corrected title');
      assert.equal(await page.$eval('#task-title', el => el.getAttribute('aria-invalid') === 'true' || (el.getAttribute('aria-describedby') || '').includes('task-form-error')), false);
    } finally { await page.dispose(); }
  });
}

test('blank manual assignee is sent, server rejection focuses assignment, and corrected retry keeps the draft', async () => {
  requests.length = 0; createReceipts.clear();
  const page = await mounted();
  try {
    await set(page, '#task-title', 'Server validation fixture');
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForSelector('#task-form-error:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.msInput), 'task_assigned');
    assert.match(await page.evaluate(() => window.toasts.at(-1)), /Choose an assignee/);
    await page.click('[data-ms-input="task_assigned"][value="2"]');
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
    assert.deepEqual(requests.filter(r => r.path === '/tasks' && r.method === 'POST').map(r => r.body.assigned_to), [[], [2]]);
  } finally { await page.dispose(); }
});

test('fixed template defaults, permitted assignee change and recurring times reach the request together', async () => {
  requests.length = 0; createReceipts.clear();
  const page = await mounted();
  try {
    await selectTemplate(page, 14, 'Get Ready for the Day');
    assert.equal(await page.$eval('[data-ms-input="task_assigned"][value="2"]', el => el.checked), true);
    assert.equal(await page.$eval('#task-fixed-assignment', el => el.hidden), false);
    assert.equal(await value(page, '#task-start-time'), '07:00');
    assert.equal(await value(page, '#task-due-time'), '08:00');
    assert.equal(await value(page, '#task-start-date'), ''); assert.equal(await value(page, '#task-due-date'), '');
    await set(page, '#task-start-date', '2026-09-17');
    assert.match(await value(page, '#task-due-date'), /17/);
    await page.click('[data-ms-input="task_assigned"][value="2"]');
    await page.click('[data-ms-input="task_assigned"][value="1"]');
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
    const body = requests.find(r => r.path === '/tasks' && r.method === 'POST').body;
    assert.deepEqual(body.assigned_to, [1]); assert.equal(body.activity_template_id, 14);
    assert.equal(body.start_time, '07:00'); assert.equal(body.due_time, '08:00');
    assert.match(body.recurrence_rule, /BYDAY=MO,TU,WE,TH,FR/);
    assert.equal(body.recurrence_from_completion, 0); assert.equal(body.expiration_policy, 'expire_incomplete');
    assert.deepEqual(body.subtasks.map(row => row.is_optional), [0, 1]);
  } finally { await page.dispose(); }
});

test('Save as Template refreshes the existing picker without replacing draft or manual assignee', async () => {
  requests.length = 0; createReceipts.clear();
  const page = await mounted();
  try {
    await set(page, '#task-title', 'Immediate morning template');
    await page.click('[data-ms-input="task_assigned"][value="2"]');
    await set(page, '#task-start-date', '2026-09-17'); await set(page, '#task-due-date', '2026-09-17');
    await set(page, '#task-start-time', '07:00'); await set(page, '#task-due-time', '08:00');
    await page.evaluate(() => { window.retainedDraft = document.querySelector('#task-form'); });
    await page.click('[data-save-as-template]');
    await page.waitForSelector('#automation-activity-form');
    await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#automation-activity-form'));
    await page.waitForSelector('#task-activity-template option[value="50"]');
    assert.equal(await page.evaluate(() => window.retainedDraft === document.querySelector('#task-form')), true);
    assert.equal(await value(page, '#task-title'), 'Immediate morning template');
    assert.equal(await value(page, '#task-activity-template'), '');
    assert.equal(await page.$eval('[data-ms-input="task_assigned"][value="2"]', el => el.checked), true);
    const template = requests.find(r => r.path === '/automation/admin/activity-templates' && r.method === 'POST').body;
    assert.equal(Number(template.fixed_user_id), 2); assert.equal(template.start_time, '07:00'); assert.equal(template.due_time, '08:00');
    assert.equal(template.due_date_offset_days, 0);
    assert.equal(Object.hasOwn(template, 'start_date'), false); assert.equal(Object.hasOwn(template, 'due_date'), false);
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
    assert.deepEqual(requests.find(r => r.path === '/tasks' && r.method === 'POST').body.assigned_to, [2]);
  } finally { await page.dispose(); }
});

test('template back to Blank clears template assignment and accepts a fresh manual assignee', async () => {
  requests.length = 0; createReceipts.clear(); preferenceValues.clear();
  const page = await mounted();
  try {
    await selectTemplate(page, 14, 'Get Ready for the Day');
    await selectTemplate(page, '', '');
    assert.equal(await value(page, '#task-start-time'), '');
    assert.equal(await value(page, '#task-start-date'), ''); assert.equal(await value(page, '#task-due-date'), '');
    await set(page, '#task-title', 'Blank again');
    await page.click('[data-ms-input="task_assigned"][value="2"]');
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
    const body = requests.find(r => r.path === '/tasks' && r.method === 'POST').body;
    assert.equal(body.activity_template_id, null); assert.deepEqual(body.assigned_to, [2]);
  } finally { await page.dispose(); }
});

for (const width of [1366, 768, 390]) {
  test(`Activity relative schedule, custom days and validation focus work at ${width}px`, async () => {
    requests.length = 0; preferenceValues.clear();
    const page = await mounted({ width });
    try {
      await set(page, '#task-title', 'Weekly Homework');
      await set(page, '#task-start-date', '2026-09-21'); await set(page, '#task-start-time', '15:30');
      await set(page, '#task-due-date', '2026-09-25'); await set(page, '#task-due-time', '07:30');
      await page.click('[data-save-as-template]'); await page.waitForSelector('#automation-activity-form');
      assert.equal(await page.$('#activity-start-date'), null); assert.equal(await page.$('#activity-due-date'), null);
      assert.equal(await value(page, '#activity-due-offset'), '4');
      const geometry = await page.evaluate(() => {
        const rect = id => { const r = document.querySelector(id).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right }; };
        return ['#activity-start-time', '#activity-due-offset', '#activity-due-time'].map(rect);
      });
      if (width > 640) {
        assert.equal(geometry[0].y, geometry[1].y);
        assert.ok(geometry[0].x < geometry[1].x && geometry[2].y > geometry[0].y);
      } else {
        assert.ok(geometry.every((r, i) => !i || r.y > geometry[i - 1].y));
        assert.ok(geometry.every(r => r.x >= 0 && r.right <= width), 'schedule controls stay within the mobile viewport');
      }
      await set(page, '#activity-start-time', '22:00'); await set(page, '#activity-due-time', '06:00');
      await page.select('#activity-due-offset', '0');
      await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
      await page.waitForSelector('[data-activity-error]:not([hidden])');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'activity-due-offset');
      assert.match(await page.evaluate(() => window.toasts.at(-1)), /Set Due to 1 day later/);
      assert.equal(requests.filter(r => r.path === '/automation/admin/activity-templates' && r.method === 'POST').length, 0);
      assert.equal(await value(page, '#activity-start-time'), '22:00');
      await page.select('#activity-due-offset', 'custom');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'activity-due-offset-custom');
      await set(page, '#activity-due-offset-custom', '12');
      await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#automation-activity-form'));
      const payload = requests.find(r => r.path === '/automation/admin/activity-templates' && r.method === 'POST').body;
      assert.equal(payload.due_date_offset_days, 12);
      assert.equal(Object.hasOwn(payload, 'start_date'), false); assert.equal(Object.hasOwn(payload, 'due_date'), false);
      assert.equal(payload.start_time, '22:00'); assert.equal(payload.due_time, '06:00');
      assert.match(await value(page, '#task-due-date'), /25/);
      assert.deepEqual(page.fixtureErrors || [], []);
    } finally { await page.dispose(); }
  });
}

test('relative due follows concrete start until manual override; switching uses the current occurrence start and Blank resets', async () => {
  requests.length = 0; preferenceValues.clear();
  preferenceValues.set(1, { tasks_template_switch_warning: false });
  const page = await mounted();
  try {
    await set(page, '#task-start-date', '2026-09-21');
    await selectTemplate(page, 16, 'Weekly Homework');
    const dates = () => page.evaluate(async () => { const { parseDateInput } = await import('/i18n.js'); return ['start', 'due'].map(key => parseDateInput(document.querySelector(`#task-${key}-date`).value)); });
    assert.deepEqual(await dates(), ['2026-09-21', '2026-09-25']);
    await set(page, '#task-start-date', '2026-11-02');
    assert.deepEqual(await dates(), ['2026-11-02', '2026-11-06']);
    await set(page, '#task-due-date', '2026-11-07');
    await set(page, '#task-start-date', '2026-11-03');
    assert.deepEqual(await dates(), ['2026-11-03', '2026-11-07'], 'explicit concrete due is retained');
    await selectTemplate(page, 14, 'Get Ready for the Day');
    assert.deepEqual(await dates(), ['2026-11-03', '2026-11-03']);
    await selectTemplate(page, '', '');
    assert.deepEqual(await dates(), ['', '']);
    assert.equal(await value(page, '#task-start-time'), ''); assert.equal(await value(page, '#task-due-time'), '');
  } finally { await page.dispose(); }
});

test('contextual Assignee resolution follows the selected Eleanor and blocked resolution announces an error before creation', async () => {
  requests.length = 0; createReceipts.clear(); preferenceValues.clear();
  const page = await mounted({ width: 390 });
  try {
    await selectTemplate(page, 15, '{{assignee.first_name}} Get Ready for School');
    await page.select('#task-activity-subject-user', '1');
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForSelector('#task-form-error:not([hidden])');
    assert.match(await page.evaluate(() => window.toasts.at(-1)), /Task couldn't be created.*Assignee/);
    assert.equal(requests.filter(r => r.path === '/tasks' && r.method === 'POST').length, 0);
    await page.select('#task-activity-subject-user', '2');
    await page.waitForFunction(() => document.querySelector('#task-title')?.value === 'Eleanor Get Ready for School');
    await page.focus('#task-submit-btn'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
    const body = requests.find(r => r.path === '/tasks' && r.method === 'POST').body;
    assert.equal(body.activity_subject_user_id, 2); assert.equal(body.title, 'Eleanor Get Ready for School');
    assert.deepEqual(body.activity_inputs, {});
    const resolution = requests.filter(r => r.path === '/automation/activity-templates/15/resolve').at(-1);
    assert.equal(resolution.body.subject_user_id, 2);
    assert.deepEqual(resolution.body.task, { start_date: null, start_time: null, due_date: null, due_time: null });
  } finally { await page.dispose(); }
});

const seriesEditFixture = () => ({ id: 70, title: 'Weekly homework', description: 'Read and write', revision: 7,
  permissions: Object.fromEntries(['edit', 'edit_series', 'complete', 'delete_archive', 'change_priority', 'change_points', 'change_category_tags', 'change_dates', 'change_assignment', 'change_required_skills'].map(key => [key, true])),
  recurrence_series_id: 9, recurrence_series_revision: 3, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
  status: 'open', priority: 'none', category: 'misc', points: 5, tags: ['School'], assigned_to: 2, created_by: 1,
  start_date: '2026-09-21', due_date: '2026-09-25', start_time: '15:30', due_time: '07:30',
  visibility: 'all', assignment_mode: 'fixed', location: { kind: 'none' }, documents: [], skill_ids: [],
  subtasks: [{ id: 71, title: 'Read', status: 'open', skill_ids: [], is_optional: 0 },
    { id: 72, title: 'Extra practice', status: 'open', skill_ids: [], is_optional: 1 }] });
const mutations = () => requests.filter(request => !['GET', 'HEAD'].includes(request.method));
async function saveEdit(page) { await page.focus('#task-submit-btn'); await page.keyboard.press('Enter'); }

for (const width of [1366, 390]) {
  test(`recurring Save validates before scope and Cancel keeps the same complete draft at ${width}px`, async () => {
    const page = await mounted({ width, editTask: seriesEditFixture() }); requests.length = 0;
    try {
      await set(page, '#task-title', ''); await saveEdit(page);
      assert.equal(await page.$('#task-edit-scope-form'), null);
      assert.equal(mutations().length, 0);
      await set(page, '#task-title', 'Revised homework');
      await set(page, '#task-description', 'Keep all these details');
      await page.evaluate(() => { window.editDraft = document.querySelector('#task-form'); });
      await saveEdit(page); await page.waitForSelector('#task-edit-scope-form');
      assert.equal(await value(page, '[name="edit_scope"]:checked'), 'occurrence');
      assert.equal(mutations().length, 0);
      assert.equal(await page.$eval('#task-edit-scope-form', el => el.getBoundingClientRect().right <= innerWidth), true);
      if (process.env.TASK_SCOPE_QA_OUTPUT) {
        mkdirSync(process.env.TASK_SCOPE_QA_OUTPUT, { recursive: true });
        await page.screenshot({ path: `${process.env.TASK_SCOPE_QA_OUTPUT}/edit-scope-${width}.png` });
      }
      await page.focus('[name="edit_scope"]:checked'); await page.keyboard.press('ArrowDown');
      assert.equal(await value(page, '[name="edit_scope"]:checked'), 'future');
      await page.click('[data-task-scope-cancel]');
      await page.waitForFunction(() => !document.querySelector('#task-edit-scope-form'));
      assert.equal(await page.evaluate(() => window.editDraft === document.querySelector('#task-form')), true);
      assert.equal(await value(page, '#task-description'), 'Keep all these details');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'task-submit-btn');
      assert.equal(mutations().length, 0);
      assert.equal(await page.$eval('#task-submit-btn', el => el.disabled), false);
    } finally { await page.dispose(); }
  });
}

test('recurring Apply defaults to occurrence and future carries the series revision with preserved feedback', async () => {
  for (const scope of ['occurrence', 'future']) {
    const page = await mounted({ editTask: seriesEditFixture() }); requests.length = 0;
    try {
      await set(page, '#task-points', '6'); await saveEdit(page); await page.waitForSelector('#task-edit-scope-form');
      if (scope === 'future') await page.click('[name="edit_scope"][value="future"]');
      await page.focus('#task-scope-apply'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#task-form'));
      const write = requests.find(request => request.path === '/tasks/70' && request.method === 'PUT');
      assert.equal(write.body.edit_scope, scope); assert.equal(write.body.expected_revision, 7);
      assert.equal(write.body.expected_series_revision, scope === 'future' ? 3 : undefined);
      if (scope === 'future') assert.match(await page.evaluate(() => window.toasts.join(' ')), /1 future occurrence was preserved/);
    } finally { await page.dispose(); }
  }
});

test('unchanged recurring Edit Save closes without any mutation or scope dialog', async () => {
  const page = await mounted({ editTask: seriesEditFixture() }); requests.length = 0;
  try {
    await saveEdit(page); await page.waitForFunction(() => !document.querySelector('#task-form'));
    assert.equal(await page.$('#task-edit-scope-form'), null); assert.equal(mutations().length, 0);
  } finally { await page.dispose(); }
});

test('nonrecurring and unchanged-span occurrence date edits save without scope', async () => {
  for (const recurring of [false, true]) {
    const fixture = seriesEditFixture();
    if (!recurring) { fixture.recurrence_series_id = null; fixture.is_recurring = 0; fixture.recurrence_rule = null; }
    const page = await mounted({ editTask: fixture }); requests.length = 0;
    try {
      if (recurring) { await set(page, '#task-start-date', '2026-09-28'); await set(page, '#task-due-date', '2026-10-02'); }
      else await set(page, '#task-title', 'One-off homework');
      await saveEdit(page); await page.waitForFunction(() => !document.querySelector('#task-form'));
      assert.equal(await page.$('#task-edit-scope-form'), null);
      assert.equal(requests.find(request => request.path === '/tasks/70' && request.method === 'PUT').body.edit_scope, undefined);
    } finally { await page.dispose(); }
  }
});

test('live invalidation keeps an unsaved editor draft and stale series rejection preserves it', async () => {
  const page = await mounted({ editTask: seriesEditFixture() }); requests.length = 0;
  try {
    editFailure = { status: 409, message: 'This recurring series changed. Reload before applying future changes.' };
    await set(page, '#task-title', 'Preserved conflict draft');
    await set(page, '#task-description', 'Keep my unsaved instructions');
    await page.evaluate(() => { window.conflictDraft = document.querySelector('#task-form'); });
    editFixture = { ...editFixture, title: 'Saved by another client', revision: 8, recurrence_series_revision: 4 };
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tasks' && response.request().method() === 'GET'),
      page.evaluate(() => window.dispatchEvent(new Event('task-data-changed'))),
    ]);
    assert.equal(await page.evaluate(() => window.conflictDraft === document.querySelector('#task-form')), true);
    assert.equal(await value(page, '#task-title'), 'Preserved conflict draft');
    assert.equal(await value(page, '#task-description'), 'Keep my unsaved instructions');
    await saveEdit(page); await page.waitForSelector('#task-edit-scope-form');
    await page.click('[name="edit_scope"][value="future"]'); await page.click('#task-scope-apply');
    await page.waitForSelector('#task-form-error:not([hidden])');
    assert.equal(await value(page, '#task-title'), 'Preserved conflict draft');
    assert.match(await page.evaluate(() => window.toasts.join(' ')), /This recurring series changed/);
    assert.equal(requests.filter(request => request.path === '/tasks/70' && request.method === 'PUT').length, 1);
  } finally { editFailure = null; await page.dispose(); }
});

test('an existing series uses its frozen fixed-assignee override policy after the source template changes', async () => {
  const activity = templates.find(template => template.id === 14), previous = structuredClone(activity);
  Object.assign(activity, { assignment_strategy: 'open_claimable', allow_assignment_override: 0, subject_required: 1 });
  const fixture = { ...seriesEditFixture(), activity_template_id: 14, activity_assignment_strategy: 'fixed',
    activity_assignment_override_allowed: 1, activity_subject_required: 0 };
  const page = await mounted({ editTask: fixture }); requests.length = 0;
  try {
    assert.equal(await page.$eval('#task-fixed-assignment', el => el.hidden), false);
    assert.equal(await page.$eval('#task-activity-subject', el => el.hidden), true);
    assert.equal(await page.$eval('[data-ms-input="task_assigned"][value="1"]', el => el.disabled), false);
    await page.click('[data-ms-input="task_assigned"][value="2"]');
    await page.click('[data-ms-input="task_assigned"][value="1"]');
    await saveEdit(page); await page.waitForSelector('#task-edit-scope-form');
    await page.click('[name="edit_scope"][value="future"]'); await page.click('#task-scope-apply');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
    const body = requests.find(request => request.path === '/tasks/70' && request.method === 'PUT').body;
    assert.deepEqual(body.assigned_to, [1]); assert.equal(body.activity_subject_user_id, null);
  } finally { Object.assign(activity, previous); await page.dispose(); }
});

test('series template skills remain editable by an authorized user and archived actions stay absent', async () => {
  const fixture = { ...seriesEditFixture(), activity_template_id: 14, activity_subject_required: 0 };
  fixture.subtasks.push({ id: 73, title: 'Historical removed step', status: 'done', archived_at: '2026-09-20 00:00:00', skill_ids: [] });
  const page = await mounted({ editTask: fixture }); requests.length = 0;
  try {
    const skill = '#task-root-skills [data-task-skill-id][value="3"]';
    assert.equal(await page.$eval(skill, el => el.matches(':disabled')), false);
    await page.click('#task-root-skills summary');
    await page.click(skill); await saveEdit(page); await page.waitForSelector('#task-edit-scope-form');
    await page.click('#task-scope-apply');
    await page.waitForFunction(() => !document.querySelector('#task-form'));
    const body = requests.find(request => request.path === '/tasks/70' && request.method === 'PUT').body;
    assert.deepEqual(body.skill_ids, [3]); assert.equal(body.subtasks.some(step => step.id === 73), false);
  } finally { await page.dispose(); }
});

test('future scope is disabled when the server does not authorize series editing', async () => {
  const fixture = seriesEditFixture(); fixture.permissions.edit_series = false;
  const page = await mounted({ editTask: fixture }); requests.length = 0;
  try {
    await set(page, '#task-title', 'Allowed occurrence edit'); await saveEdit(page); await page.waitForSelector('#task-edit-scope-form');
    assert.equal(await page.$eval('[name="edit_scope"][value="future"]', el => el.disabled), true);
    assert.equal(await value(page, '[name="edit_scope"]:checked'), 'occurrence');
    await page.click('[data-task-scope-cancel]'); assert.equal(mutations().length, 0);
  } finally { await page.dispose(); }
});

test('expired historical series offers future-only editing and explains preservation', async () => {
  const fixture = seriesEditFixture(); fixture.status = 'expired';
  const page = await mounted({ editTask: fixture }); requests.length = 0;
  try {
    const locked = '#task-status, #task-sync-target, .reminder-section input, .reminder-section select, [data-doc-attach] input, [data-doc-attach] button';
    assert.ok(await page.$$eval(locked, fields => fields.length > 5 && fields.every(field => field.disabled)));
    assert.match(await page.$eval('#task-historical-edit-hint', el => el.textContent), /status, reminders and documents, will be preserved/);
    await page.$eval('[data-doc-attach]', field => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['history'], 'history.txt', { type: 'text/plain' }));
      field.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    assert.equal(await page.$$eval('.doc-attach__chip--pending', fields => fields.length), 0);
    await set(page, '#task-title', 'Future homework title'); await saveEdit(page); await page.waitForSelector('#task-edit-scope-form');
    assert.equal(await page.$eval('[name="edit_scope"][value="occurrence"]', el => el.disabled), true);
    assert.equal(await value(page, '[name="edit_scope"]:checked'), 'future');
    assert.match(await page.$eval('#task-edit-scope-form', el => el.textContent), /historical occurrence will be preserved/);
    await page.click('#task-scope-apply'); await page.waitForFunction(() => !document.querySelector('#task-form'));
    assert.equal(requests.find(request => request.path === '/tasks/70' && request.method === 'PUT').body.status, undefined);
    assert.equal(mutations().some(request => /^\/(?:reminders|documents)(?:\/|$)/.test(request.path) || request.path.endsWith('/documents')), false);
    assert.match(await page.evaluate(() => window.toasts.join(' ')), /This historical occurrence was preserved/);
  } finally { await page.dispose(); }
});
