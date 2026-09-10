import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';
import { resolveExpressionVariables, validateVariableDefinitions } from '../public/utils/variable-expressions.js';

const members = [
  { id: 7, display_name: 'Gracelynn Household', first_name: 'Grace', last_name: 'Household', nickname: 'Gracie' },
  { id: 12, display_name: 'Alexander Household', first_name: 'Alex', last_name: 'Household', nickname: '' },
];
const context = [{ key: 'context.household_member', type: 'household_member', label: 'Person this is for' }];
const member = { id: 1, variable_key: 'member', label: 'Household member', type: 'household_member', kind: 'field', default_value: null };
const expression = { version: 1, source: 'coalesce(member.nickname, member.first_name)' };
let catalog, requests, pending;
const automation = readFileSync(new URL('../public/components/activity-automation.js', import.meta.url), 'utf8');
const tasks = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
const app = express(); app.use(express.json());
app.get('/components/activity-expression-fixture.js', (_req, res) => res.type('text/javascript').send(`${automation}\nexport { openVariableForm, openWorkflowForm, openQuickAddTemplate };`));
app.get('/pages/task-expression-fixture.js', (_req, res) => res.type('text/javascript').send(`${tasks}\nexport function mountExpressionTaskFixture(panel, activity, members) {
  state.activityTemplates = [activity]; state.users = members; state.places = [];
  const form = panel.querySelector('#task-form');
  taskFormControls.set(form, { subtasks: {
    getValue: () => [...form.querySelectorAll('[data-fixture-subtask]')].map(input => ({ title: input.value, skill_ids: [] })),
    setValue: rows => form.querySelectorAll('[data-fixture-subtask]').forEach((input, index) => input.value = rows[index].title),
  } });
  wireActivityTemplatePrefill(panel, { presetActivityTemplate: activity });
}`));
app.use('/api/v1', (req, res) => {
  requests.push({ path: req.path, method: req.method, body: req.body });
  if (req.path === '/automation/admin/variables/preview') {
    const send = () => {
      const current = req.body.variable;
      const key = current.variable_key || current.id;
      const definitions = [...new Map([...catalog, ...context, ...(req.body.definitions || []), current].map(item => [item.variable_key || item.key || item.id, item])).values()];
      const input_schema = definitions.filter(item => !item.expression && item.kind !== 'value' && !String(item.key || '').startsWith('context.'));
      try {
        validateVariableDefinitions(definitions);
        const inputs = { ...req.body.inputs };
        definitions.forEach(item => { const id = item.variable_key || item.key || item.id; if (inputs[id] == null && item.default_value != null) inputs[id] = item.default_value; if (item.type === 'household_member' && inputs[id] != null) inputs[id] = members.find(person => person.id === Number(inputs[id])); });
        if (req.body.subject_user_id) inputs['context.household_member'] = members.find(person => person.id === Number(req.body.subject_user_id));
        const resolved = resolveExpressionVariables(definitions, inputs, { keys: [key] });
        return res.json({ data: { value: resolved.values[key], display_value: String(resolved.values[key]), resolved_values: resolved.values }, input_schema });
      } catch (error) { return res.status(error.code === 'missing_input' ? 422 : 400).json({ error: error.message, reason: error.code === 'missing_input' ? 'missing_input' : 'invalid_expression', input_schema }); }
    };
    if (pending) { pending.push(send); return; }
    return send();
  }
  if (req.path === '/automation/admin/variables' && req.method === 'GET') return res.json({ data: catalog, context, members, places: [] });
  if (req.path.startsWith('/automation/admin/variables') && ['POST', 'PUT'].includes(req.method)) {
    const id = Number(req.path.split('/').at(-1)) || 20;
    const saved = { ...req.body, id, variable_key: req.body.variable_key || 'friendly_name' };
    catalog = [...catalog.filter(item => item.id !== id), saved]; return res.json({ data: saved });
  }
  if (req.path.includes('/admin/workflow-templates')) return res.json({ data: req.method === 'GET' ? [] : { id: 30, ...req.body }, variables: catalog, context, members, places: [], activities: [{ id: 1, name: 'Laundry', active: true }] });
  if (req.path.endsWith('/resolve')) {
    const person = members.find(item => item.id === Number(req.body.inputs.member));
    if (!person) return res.status(422).json({ error: 'Choose a household member.', reason: 'missing_input' });
    return res.json({ data: { title: `Laundry for ${person.nickname || person.first_name}`, description: 'Sort first.', checklist: [{ title_template: `Load washer for ${person.first_name}` }, { title_template: `Dry clothes for ${person.first_name}` }], inputs: req.body.inputs } });
  }
  if (req.path.endsWith('/preview')) return res.json({ data: { steps: [{ title: 'Laundry for Gracie' }], resolved_variables: [{ key: 'friendly_name', label: 'Friendly name', type: 'text', value: 'Gracie', display_value: 'Gracie' }] } });
  return res.json({ data: [] });
});
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/expression-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/settings.css"><script src="/lucide.min.js"></script></head><body><main></main></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
async function pageAt(width = 390) {
  catalog = [member, { id: 2, variable_key: 'friendly_name', label: 'Friendly name', type: 'text', kind: 'field', expression }]; requests = []; pending = null;
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width, height: 900 }); await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await page.goto(`${base}/expression-fixture`);
  await page.evaluate(async () => {
    await (await import('/i18n.js')).initI18n(); await (await import('/i18n.js')).setLocale('en');
    window.yuvomi = { user: { id: 7, role: 'admin' }, showToast(message) { window.lastToast = message; } };
    window.automation = await import('/components/activity-expression-fixture.js');
  });
  return { page, errors };
}
async function openVariable(page, existing = true) {
  await page.evaluate(async existing => {
    const response = await (await import('/api.js')).api.get('/automation/admin/variables');
    window.editorContext = { ...response, variables: response.data };
    window.automation.openVariableForm(existing ? response.data[1] : null, null, { context: window.editorContext, asChild: true, onSaved: saved => window.saved = saved });
  }, existing);
  await page.waitForSelector('[data-expression-source]');
  // Wait for the modal's intentional first-field focus before driving controls.
  await page.waitForFunction(() => document.activeElement?.name === 'label');
}
async function setSource(page, source) { await page.$eval('[data-expression-source]', (field, source) => { field.value = source; field.dispatchEvent(new Event('input', { bubbles: true })); }, source); }

test('calculated value preview uses typed member samples, refreshes results and saves normal recipe-independent data', async () => {
  const { page, errors } = await pageAt();
  try {
    await openVariable(page); await page.click('[data-expression-preview]');
    await page.waitForSelector('[data-expression-samples] [data-variable-input="member"]');
    assert.equal(await page.$('[data-expression-subject]'), null, 'an ordinary member variable does not add a second subject picker');
    await page.select('[data-expression-samples] [data-variable-input="member"]', '7');
    await page.waitForFunction(() => document.querySelector('[data-expression-result]').textContent === 'Gracie');
    await page.select('[data-expression-samples] [data-variable-input="member"]', '12');
    assert.equal(await page.$eval('[data-expression-result]', node => node.textContent), '');
    await page.waitForFunction(() => document.querySelector('[data-expression-result]').textContent === 'Alex');
    await page.click('[type="submit"]'); await page.waitForFunction(() => window.saved);
    assert.deepEqual(await page.evaluate(() => window.saved.expression), expression);
    assert.equal(await page.evaluate(() => window.saved.kind), 'field'); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('invalid properties and dependency cycles stay inline and block Save', async () => {
  const { page, errors } = await pageAt();
  try {
    await openVariable(page);
    for (const source of ['member.password', 'friendly_name']) {
      await setSource(page, source); await page.click('[type="submit"]');
      assert.equal(await page.$eval('[data-expression-error]', node => node.hidden), false);
      assert.equal(await page.$eval('[data-expression-source]', node => node.getAttribute('aria-invalid')), 'true');
    }
    assert.equal(requests.filter(request => request.method === 'PUT').length, 0); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('input defaults remain adjustable in a successful expression preview', async () => {
  const { page, errors } = await pageAt();
  try {
    catalog[0] = { ...catalog[0], default_value: 7 };
    await openVariable(page); await page.click('[data-expression-preview]');
    await page.waitForFunction(() => document.querySelector('[data-expression-result]').textContent === 'Gracie');
    assert.equal(await page.$eval('[data-expression-samples] [data-variable-input="member"]', field => field.value), '7');
    await page.select('[data-expression-samples] [data-variable-input="member"]', '12');
    await page.waitForFunction(() => document.querySelector('[data-expression-result]').textContent === 'Alex'); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('late previews cannot overwrite an edited expression', async () => {
  const { page, errors } = await pageAt();
  try {
    await openVariable(page); await setSource(page, '"First"'); pending = [];
    await page.click('[data-expression-preview]'); await page.waitForFunction(() => document.querySelector('[data-expression-preview]').disabled);
    await setSource(page, '"Second"');
    while (!pending.length) await new Promise(resolve => setTimeout(resolve, 5));
    pending.shift()(); pending = null;
    await page.waitForFunction(() => !document.querySelector('[data-expression-preview]').disabled);
    assert.equal(await page.$eval('[data-expression-result]', node => node.textContent), ''); assert.deepEqual(errors, []);
  } finally { pending?.forEach(send => send()); pending = null; await page.close(); }
});

test('out-of-order sample previews cannot restore the previously selected member', async () => {
  const { page, errors } = await pageAt();
  const waitForPending = async count => {
    const deadline = Date.now() + 3000;
    while (pending.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pending.length, count);
  };
  try {
    await openVariable(page); await page.click('[data-expression-preview]');
    await page.waitForSelector('[data-expression-samples] [data-variable-input="member"]');
    pending = [];
    await page.select('[data-expression-samples] [data-variable-input="member"]', '7'); await waitForPending(1);
    await page.select('[data-expression-samples] [data-variable-input="member"]', '12'); await waitForPending(2);
    pending[1]();
    await page.waitForFunction(() => document.querySelector('[data-expression-result]').textContent === 'Alex');
    pending[0](); pending = null;
    await page.waitForNetworkIdle({ idleTime: 100 });
    assert.equal(await page.$eval('[data-expression-result]', node => node.textContent), 'Alex'); assert.deepEqual(errors, []);
  } finally { pending?.forEach(send => send()); pending = null; await page.close(); }
});

test('context-dependent formulas offer a subject sample and recalculate it automatically', async () => {
  const { page, errors } = await pageAt();
  try {
    await openVariable(page); await setSource(page, 'context.household_member.first_name'); await page.click('[data-expression-preview]');
    await page.waitForSelector('[data-expression-subject]'); await page.select('[data-expression-subject]', '7');
    await page.waitForFunction(() => document.querySelector('[data-expression-result]').textContent === 'Grace');
    await page.select('[data-expression-subject]', '12');
    await page.waitForFunction(() => document.querySelector('[data-expression-result]').textContent === 'Alex'); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 768, 1366]) test(`reference picker, ID insertion and expression layout fit ${width}px`, async () => {
  const { page, errors } = await pageAt(width);
  try {
    await openVariable(page); await page.click('.variable-expression__reference summary');
    assert.equal(await page.$$eval('[data-expression-insert]', nodes => nodes.some(node => node.dataset.expressionInsert === 'member.nickname')), true);
    await setSource(page, 'switch(member.id, '); await page.select('[data-expression-member]', '7'); await page.click('[data-expression-insert-member]');
    assert.equal(await page.$eval('[data-expression-source]', node => node.value), 'switch(member.id, 7');
    for (const colorTheme of ['warm', 'neutral', 'cool']) for (const theme of ['light', 'dark']) {
      await page.evaluate(values => Object.assign(document.documentElement.dataset, values), { colorTheme, theme, typography: 'serif' });
      const sizes = await page.evaluate(() => { const panel = document.querySelector('.modal-panel'), field = document.querySelector('[data-expression-source]'); return { overflow: document.documentElement.scrollWidth > innerWidth, panel: panel.getBoundingClientRect().width, field: field.getBoundingClientRect().width }; });
      assert.equal(sizes.overflow, false); assert.ok(sizes.field <= sizes.panel);
    }
    if (process.env.EXPRESSION_SCREENSHOTS) { const dir = new URL('../artifacts/derived-variable-ui/', import.meta.url); mkdirSync(dir, { recursive: true }); await page.screenshot({ path: fileURLToPath(new URL(`editor-${width}.png`, dir)) }); }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('workflow local calculations preserve typed bindings and canonical linked formulas', async () => {
  const { page, errors } = await pageAt(1366);
  try {
    await page.evaluate(() => window.automation.openWorkflowForm({ id: 8, name: 'Laundry', input_schema: [
      { id: 'member', label: 'Member', type: 'household_member' },
      { id: 'friendly_name', definition_id: 3, reusable_definition_id: 2, label: 'Friendly name', type: 'text', expression: { version: 1, source: 'coalesce(member.nickname, member.first_name)' } },
      { id: 'assignee', label: 'Person doing the work', type: 'household_member', expression: { version: 1, source: 'member' } },
    ], steps: [{ activity_template_id: 1, subject_variable_id: 'assignee' }] }, {
      activities: [{ id: 1, name: 'Laundry' }], members: [], places: [], categories: [], variables: [], context: [],
    }, null, { asChild: true, onSaved: saved => window.saved = saved }));
    await page.waitForSelector('#automation-workflow-form');
    assert.equal(await page.$eval('[data-variable-id="friendly_name"] [data-expression-source]', node => node.readOnly), true);
    assert.equal(await page.$eval('[data-step-subject-variable]', node => node.value), 'assignee');
    await page.click('[type="submit"]'); await page.waitForFunction(() => window.saved);
    const saved = await page.evaluate(() => window.saved);
    assert.deepEqual(saved.input_schema.find(item => item.id === 'assignee').expression, { version: 1, source: 'member' });
    assert.equal(saved.steps[0].subject_variable_id, 'assignee'); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('workflow launch only asks for inputs and shows calculated values in the reviewed preview', async () => {
  const { page, errors } = await pageAt();
  try {
    await page.evaluate(members => window.automation.openQuickAddTemplate({ id: 5, name: 'Laundry', input_schema: [
      { id: 'member', label: 'Member', type: 'household_member', default_value: 7 },
      { id: 'friendly_name', label: 'Friendly name', type: 'text', expression: { version: 1, source: 'member.nickname' } },
      { id: 'room', label: 'Room', type: 'text', kind: 'value', default_value: 'Laundry room' },
    ] }, members, [], () => {}), members);
    await page.waitForSelector('#quick-add-form');
    assert.deepEqual(await page.$$eval('[data-runtime-input]', fields => fields.map(field => [field.dataset.runtimeInput, field.value])), [['member', '7']]);
    await page.click('[type="submit"]'); await page.waitForSelector('.variable-resolved-values');
    assert.match(await page.$eval('.variable-resolved-values', node => node.textContent), /Friendly name.*Gracie/s);
    assert.deepEqual(requests.at(-1).body.inputs, { member: 7 }); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Activity Template values resolve through the server and remain independently editable', async () => {
  const { page, errors } = await pageAt();
  try {
    await page.evaluate(async () => {
      const host = document.createElement('div'); document.querySelector('main').append(host);
      window.activityValues = (await import('/components/variable-expression-editor.js')).bindActivityVariableInputs(host, {
        activity: { id: 1, title_template: 'Laundry for {{friendly_name}}', input_schema: [{ id: 'member', label: 'Member', type: 'household_member' }] },
        members: [{ id: 7, display_name: 'Gracie' }, { id: 12, display_name: 'Alex' }], onResolved: value => window.resolvedTask = value,
      });
    });
    await page.select('[data-variable-input="member"]', '7'); await page.click('[data-activity-values-apply]');
    await page.waitForFunction(() => window.resolvedTask?.title === 'Laundry for Gracie');
    assert.equal(await page.evaluate(() => window.activityValues.ready()), true);
    await page.select('[data-variable-input="member"]', '12'); assert.equal(await page.evaluate(() => window.activityValues.ready()), false);
    await page.click('[data-activity-values-apply]'); await page.waitForFunction(() => window.resolvedTask?.title === 'Laundry for Alex');
    assert.deepEqual(await page.evaluate(() => window.activityValues.inputs()), { member: 12 }); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Task template recalculation preserves manual instructions across repeated member changes', async () => {
  const { page, errors } = await pageAt();
  try {
    await page.evaluate(async members => {
      const panel = document.querySelector('main');
      panel.insertAdjacentHTML('beforeend', `<form id="task-form"><input id="task-id" value=""><select id="task-activity-template"><option value="1" selected>Laundry</option></select><select id="task-activity-subject-user"><option value="">Choose…</option></select><input id="task-title" value="Laundry for {{friendly_name}}"><textarea id="task-description">Sort first.</textarea><input data-fixture-subtask value="Load washer for {{member.first_name}}"><input data-fixture-subtask value="Dry clothes for {{member.first_name}}"><section id="task-template-values"></section></form>`);
      (await import('/pages/task-expression-fixture.js')).mountExpressionTaskFixture(panel, {
        id: 1, title_template: 'Laundry for {{friendly_name}}', description: 'Sort first.',
        input_schema: [{ id: 'member', type: 'household_member', label: 'Member' }],
        checklist: [{ title_template: 'Load washer for {{member.first_name}}' }, { title_template: 'Dry clothes for {{member.first_name}}' }],
      }, members);
    }, members);
    await page.select('[data-variable-input="member"]', '7'); await page.click('[data-activity-values-apply]');
    await page.waitForFunction(() => document.querySelector('#task-title').value === 'Laundry for Gracie');
    await page.$eval('#task-title', field => field.value = 'My custom title');
    await page.$eval('#task-description', field => field.value = 'My custom instructions');
    await page.$eval('[data-fixture-subtask]', field => field.value = 'My custom wash instructions');
    for (const [id, name] of [['12', 'Alex'], ['7', 'Grace']]) {
      await page.select('[data-variable-input="member"]', id); await page.click('[data-activity-values-apply]');
      await page.waitForFunction(name => document.querySelectorAll('[data-fixture-subtask]')[1].value === `Dry clothes for ${name}`, {}, name);
      assert.equal(await page.$eval('[data-fixture-subtask]', field => field.value), 'My custom wash instructions');
      assert.equal(await page.$eval('#task-title', field => field.value), 'My custom title');
      assert.equal(await page.$eval('#task-description', field => field.value), 'My custom instructions');
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
