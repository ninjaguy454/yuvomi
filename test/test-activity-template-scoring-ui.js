import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// The mounted browser modules exercise real controls and serialization. The
// disposable loopback API never reaches a household or a shared QA instance.
const members = [{ id: 1, display_name: 'Alex', role: 'admin' }];
const requests = [];
let templates = [], resolved = null;
const app = express();
app.use(express.json());
app.use('/api/v1', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: structuredClone(req.body) });
  if (req.path === '/auth/me') return res.json({ user: members[0], permissions: { admin: true } });
  if (req.path === '/automation/admin/activity-templates' && req.method === 'POST') {
    const saved = { id: 50 + templates.length, ...req.body }; templates.push(saved); return res.json({ data: saved });
  }
  if (/^\/automation\/admin\/activity-templates\/\d+$/.test(req.path) && req.method === 'PUT') {
    const id = Number(req.path.split('/').at(-1)); const index = templates.findIndex(item => item.id === id);
    templates[index] = { ...templates[index], ...req.body }; return res.json({ data: templates[index] });
  }
  if (req.path === '/automation/admin/activity-templates') return res.json({ data: templates, members, skills: [], categories: [{ key: 'misc', label: 'General' }], variables: [], places: [] });
  if (/^\/automation\/activity-templates\/\d+\/resolve$/.test(req.path)) return res.json({ data: resolved });
  if (req.path === '/automation/activity-options') return res.json({ data: { activities: templates, skills: [] } });
  if (req.path === '/tasks/meta/options') return res.json({ users: members, categories: [{ key: 'misc', label: 'General' }], tags: [], default_points: 3 });
  if (req.path === '/tasks' && req.method === 'POST') return res.json({ data: { id: 99, ...req.body } });
  if (req.path === '/preferences') return res.json({ data: {} });
  if (req.path === '/reminders') return res.json({ data: null });
  return res.json({ data: [] });
});
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
app.get('/template-scoring-test', (_req, res) => res.send(`<!doctype html><html lang="en" data-theme="light" data-color-theme="warm"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/tasks.css"><link rel="stylesheet" href="/styles/settings.css"></head><body><main id="fixture"></main></body></html>`));
let server, browser, base, ownedBrowser;
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  ownedBrowser = browser.process();
});
test.after(async () => {
  await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve());
  console.log('TEMPLATE_SCORING_CLEANUP', JSON.stringify({ node_pid: process.pid, browser_pid: ownedBrowser?.pid, browser_exit: ownedBrowser?.exitCode, server_listening: server?.listening }));
});
async function mounted({ tasks = false, width = 1100 } = {}) {
  requests.length = 0;
  const context = await browser.createBrowserContext(), page = await context.newPage();
  await page.setViewport({ width, height: 960 }); await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/template-scoring-test`);
  await page.evaluate(async tasks => {
    localStorage.setItem('yuvomi-lang', 'en'); window.yuvomi = { user: { id: 1, role: 'admin' }, showToast: () => {} };
    const i18n = await import('/i18n.js'); await i18n.initI18n(); await i18n.setLocale('en'); await import('/components/datepicker.js');
    const { setPermissions } = await import('/permissions.js'); setPermissions({ admin: true });
    if (tasks) { const { render } = await import('/pages/tasks.js'); window.disposePage = await render(document.querySelector('#fixture'), { user: { id: 1, role: 'admin' } }); }
    else { const { renderAutomationManager } = await import('/components/activity-automation.js'); await renderAutomationManager(document.querySelector('#fixture'), { tab: 'activities' }); }
  }, tasks);
  page.dispose = async () => { await page.evaluate(() => window.disposePage?.()); await context.close(); assert.deepEqual(errors, [], 'no unhandled browser errors'); };
  return page;
}
const mode = value => `#automation-activity-form input[name="scoring_mode"][value="${value}"]`;
const child = index => `[data-task-subtask-row]:nth-child(${index}) [data-task-subtask-points]`;
const templateWrites = () => requests.filter(row => ['POST', 'PUT'].includes(row.method) && /^\/automation\/admin\/activity-templates(?:\/\d+)?$/.test(row.path));
async function set(page, selector, value) { await page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, String(value)); }
async function create(page) { await page.$eval('#automation-add-activity', el => el.click()); await page.waitForSelector('#automation-activity-form'); await set(page, '[name="name"]', 'Scoring routine'); }
async function edit(page, id) { await page.waitForSelector(`[data-edit-activity="${id}"]`); await page.$eval(`[data-edit-activity="${id}"]`, el => el.click()); await page.waitForSelector('#automation-activity-form'); }
async function save(page) { const before = templateWrites().length; await page.$eval('#automation-activity-form', form => form.requestSubmit()); await page.waitForFunction(() => !document.querySelector('#automation-activity-form')); assert.equal(templateWrites().length, before + 1); return templateWrites().at(-1).body; }

test('new template modes preserve zero and inactive amounts across save, edit and reopen', async () => {
  templates = []; resolved = null;
  const page = await mounted();
  try {
    await create(page);
    assert.notEqual(await page.$(mode('whole_task')), null, 'new templates offer Whole task scoring');
    assert.equal(await page.$eval(mode('whole_task'), el => el.checked), true);
    await set(page, '[name="points"]', 10);
    for (const title of ['Brush teeth', 'Wash']) { await page.$eval('[data-task-subtask-add]', el => el.click()); await set(page, '[data-task-subtask-row]:last-child [data-task-subtask-title]', title); }
    assert.equal(await page.$eval(child(1), el => el.disabled), true);
    await page.click(mode('subtasks'));
    assert.equal(await page.$eval('[name="points"]', el => el.disabled), true);
    await set(page, child(1), 0); await set(page, child(2), 7);
    await page.click(mode('whole_task')); assert.equal(await page.$eval('[name="points"]', el => el.value), '10');
    await set(page, '[name="points"]', 0); await page.click(mode('subtasks'));
    assert.equal(await page.$eval(child(2), el => el.value), '7');
    const first = await save(page); assert.equal(first.scoring_mode, 'subtasks'); assert.equal(first.points, 0); assert.deepEqual(first.checklist.map(row => row.points), [0, 7]);
    await edit(page, templates[0].id); assert.equal(await page.$eval(mode('subtasks'), el => el.checked), true); assert.equal(await page.$eval(child(2), el => el.value), '7');
    await page.click(mode('whole_task')); const second = await save(page); assert.equal(second.scoring_mode, 'whole_task'); assert.equal(second.points, 0); assert.deepEqual(second.checklist.map(row => row.points), [0, 7]);
    await edit(page, templates[0].id); await page.click(mode('subtasks')); assert.equal(await page.$eval(child(1), el => el.value), '0'); assert.equal(await page.$eval(child(2), el => el.value), '7');
  } finally { await page.dispose(); }
});

test('legacy edits preserve null or absent mode until the user chooses a mode', async () => {
  for (const legacy of [{}, { scoring_mode: null }]) {
    templates = [{ id: 11, name: 'Older routine', title_template: 'Older routine', points: 50000, assignment_strategy: 'open_claimable', subject_required: 0, checklist: [{ title_template: 'Original step' }], ...legacy }];
    const page = await mounted();
    try {
      await edit(page, 11); assert.equal(await page.$$eval('#automation-activity-form [name="scoring_mode"]:checked', els => els.length), 0);
      assert.match(await page.$eval('[data-activity-scoring-legacy]', el => el.textContent), /existing|original|legacy/i);
      await set(page, '[name="description"]', 'Revised instructions'); const body = await save(page);
      assert.equal(Object.hasOwn(body, 'scoring_mode'), Object.hasOwn(legacy, 'scoring_mode')); assert.equal(body.scoring_mode, legacy.scoring_mode); assert.equal(body.points, 50000);
      await edit(page, 11); await page.click(mode('whole_task')); await set(page, '[name="points"]', 0);
      assert.equal((await save(page)).scoring_mode, 'whole_task');
    } finally { await page.dispose(); }
  }
});

test('point validation rejects blanks, fractions, negatives and values above 10000', async () => {
  templates = []; const page = await mounted();
  try {
    await create(page);
    for (const value of ['', '-1', '1.5', '10001']) {
      await set(page, '[name="points"]', value); await page.$eval('#automation-activity-form', form => form.requestSubmit());
      assert.equal(templateWrites().length, 0); assert.equal(await page.$eval('[data-activity-error]', el => !el.hidden), true); assert.equal(await page.$eval('[name="points"]', el => el.getAttribute('aria-invalid')), 'true');
    }
    await set(page, '[name="points"]', 10000); await page.click(mode('subtasks')); await page.$eval('[data-task-subtask-add]', el => el.click()); await set(page, '[data-task-subtask-title]', 'Step');
    for (const value of ['', '-1', '1.5', '10001']) {
      await set(page, child(1), value); await page.$eval('#automation-activity-form', form => form.requestSubmit());
      assert.equal(templateWrites().length, 0); assert.equal(await page.$eval(child(1), el => el.getAttribute('aria-invalid')), 'true');
    }
    await set(page, child(1), 10000); const body = await save(page); assert.equal(body.points, 10000); assert.equal(body.checklist[0].points, 10000);
  } finally { await page.dispose(); }
});

test('invalid inactive amounts cannot be silently changed or sent to the API', async () => {
  templates = []; const page = await mounted();
  try {
    await create(page); await set(page, '[name="points"]', ''); await page.click(mode('subtasks'));
    await page.$eval('#automation-activity-form', form => form.requestSubmit());
    assert.equal(templateWrites().length, 0, 'a disabled blank overall amount is not converted into zero');
    assert.match(await page.$eval('[data-activity-error]', el => el.textContent), /Whole task/);
    await page.click(mode('whole_task')); await set(page, '[name="points"]', 5); await page.click(mode('subtasks'));
    await page.$eval('[data-task-subtask-add]', el => el.click()); await set(page, '[data-task-subtask-title]', 'Step'); await set(page, child(1), '1.5'); await page.click(mode('whole_task'));
    await page.$eval('#automation-activity-form', form => form.requestSubmit());
    assert.equal(templateWrites().length, 0, 'a hidden fractional child amount is not sent');
    assert.match(await page.$eval('[data-activity-error]', el => el.textContent), /Each subtask/);
  } finally { await page.dispose(); }
});

test('Task template prefill, resolution, save as template and Task create carry mode and all amounts', async () => {
  templates = [{ id: 11, name: 'Routine', title_template: '{{label}}', points: 8, scoring_mode: 'whole_task', input_schema: [{ id: 'label', label: 'Name', type: 'text', kind: 'value', expression: { type: 'literal', value: 'Resolved routine' } }],
    assignment_strategy: 'open_claimable', subject_required: 0, location_mode: 'none', skill_ids: [], checklist: [{ id: 21, title_template: 'First', points: 2 }, { id: 22, title_template: 'Second', points: 4 }] }];
  resolved = { title: 'Resolved routine', description: '', scoring_mode: 'subtasks', points: 0, checklist: [{ title_template: 'First resolved', points: 0 }, { title_template: 'Second resolved', points: 9 }] };
  const page = await mounted({ tasks: true, width: 390 });
  try {
    await page.$eval('#fab-new-task', el => el.click()); await page.waitForSelector('#task-form'); await page.select('#task-activity-template', '11');
    await page.waitForFunction(() => document.querySelector('#task-title')?.value === 'Resolved routine');
    assert.equal(await page.$eval('#task-form [name="scoring_mode"][value="subtasks"]', el => el.checked), true);
    assert.equal(await page.$eval('#task-points', el => el.value), '0'); assert.equal(await page.$eval(child(1), el => el.value), '0'); assert.equal(await page.$eval(child(2), el => el.value), '9');
    await page.$eval('[data-save-as-template]', el => el.click()); await page.waitForSelector('#automation-activity-form');
    assert.equal(await page.$eval(mode('subtasks'), el => el.checked), true); assert.equal(await page.$eval('#automation-activity-form [name="points"]', el => el.value), '0'); assert.equal(await page.$eval(`#automation-activity-form ${child(2)}`, el => el.value), '9');
    await save(page); assert.equal(templateWrites().at(-1).body.scoring_mode, 'subtasks');
    await page.$eval('#task-form', form => form.requestSubmit()); await page.waitForFunction(() => !document.querySelector('#task-form'));
    const body = requests.findLast(row => row.path === '/tasks' && row.method === 'POST').body;
    assert.equal(body.scoring_mode, 'subtasks'); assert.equal(body.points, 0); assert.deepEqual(body.subtasks.map(row => row.points), [0, 9]);
  } finally { await page.dispose(); }
});

test('mobile template scoring controls stay within the viewport', async () => {
  templates = [{ id: 11, name: 'Mobile routine', title_template: 'Mobile routine', scoring_mode: 'subtasks', points: 8, assignment_strategy: 'open_claimable', subject_required: 0, checklist: [{ title_template: 'Brush teeth', points: 0 }, { title_template: 'Wash', points: 7 }] }];
  const page = await mounted({ width: 390 });
  try {
    await edit(page, 11);
    assert.equal(await page.$eval(child(2), el => el.disabled), false);
    assert.equal(await page.$eval('#automation-activity-form', form => form.scrollWidth <= form.clientWidth + 1), true);
    const directory = new URL('../test-artifacts/template-scoring/', import.meta.url); mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('mobile-subtask-mode.png', directory)), fullPage: true });
    await page.$eval(mode('subtasks'), el => el.closest('fieldset').scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: fileURLToPath(new URL('mobile-subtask-amounts.png', directory)), fullPage: true });
  } finally { await page.dispose(); }
});
