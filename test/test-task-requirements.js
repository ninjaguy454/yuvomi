import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';
import { renderSkillPicker, renderSubtaskEditor } from '../public/components/task-requirements.js';

const app = express();
const requests = [];
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use('/api/v1', (req, res) => {
  requests.push({ method: req.method, path: req.path, body: req.body });
  if (req.method === 'PUT' && req.path === '/tasks/2') return res.json({ data: {
    id: 2, ...req.body, skills: (req.body.skill_ids || []).map((id) => ({ id, name: `Skill ${id}` })),
    skill_assignment_needed: (req.body.skill_ids || []).length > 0,
  } });
  if (req.method === 'POST' && req.path === '/tasks') return res.json({ data: {
    id: 3, ...req.body, status: 'open', skills: (req.body.skill_ids || []).map((id) => ({ id, name: `Skill ${id}` })),
  } });
  if (req.path === '/automation/activity-options') return res.json({ data: { skills: [{ id: 1, name: 'Kitchen safety' }, { id: 2, name: 'Knife skills' }] } });
  if (req.path === '/automation/admin/skills' && req.method === 'POST') return res.status(201).json({ data: { id: 7, ...req.body } });
  return res.json({ data: [] });
});
app.get('/requirements-test', (_req, res) => res.send(`<!doctype html><html><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/layout.css">
  <link rel="stylesheet" href="/styles/typography.css">
  <link rel="stylesheet" href="/styles/detail-view.css">
  <link rel="stylesheet" href="/styles/tasks.css">
  <link rel="stylesheet" href="/styles/task-requirements.css">
  <style>body{margin:0;padding:16px}main{max-width:680px;margin:auto}*{box-sizing:border-box}</style>
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

async function mounted(kind = 'subtasks', options = {}, viewport = { width: 768, height: 900 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(`${base}/requirements-test`);
  await page.evaluate(async ({ kind, options }) => {
    const ui = await import('/components/task-requirements.js');
    const skills = [{ id: 1, name: 'Kitchen safety' }, { id: 2, name: 'Knife skills' }];
    const fixture = document.querySelector('#fixture');
    window.changes = [];
    if (kind === 'skills') {
      fixture.innerHTML = ui.renderSkillPicker({ skills, ...options });
      window.editor = ui.bindSkillPicker(fixture, { onChange: (value) => window.changes.push(value) });
    } else {
      fixture.innerHTML = ui.renderSubtaskEditor({ skills, ...options });
      window.editor = ui.bindSubtaskEditor(fixture, { skills, template: options.template, onChange: (value) => window.changes.push(value) });
    }
  }, { kind, options });
  return page;
}

test('rendered requirements escape titles and names and preserve template mention hooks', () => {
  const markup = renderSkillPicker({ skills: [{ id: 1, name: '<img src=x onerror=bad()>' }], selectedIds: [1], label: '<script>bad()</script>' });
  assert.doesNotMatch(markup, /<img|<script/);
  assert.match(markup, /&lt;img/);
  const subtasks = renderSubtaskEditor({ template: true, subtasks: [{ title_template: 'Close "door" <secure>', skill_ids: [1] }] });
  assert.match(subtasks, /data-variable-mentions="activity-title"/);
  assert.match(subtasks, /maxlength="200"/);
  assert.match(subtasks, /&quot;door&quot; &lt;secure&gt;/);
});

test('skill selection returns stable IDs, supports rename-independent presets and read-only state', async () => {
  const page = await mounted('skills', { selectedIds: ['2', 2, 1] });
  try {
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [1, 2]);
    await page.click('summary');
    await page.click('[data-task-skill-id][value="1"]');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [2]);
    assert.deepEqual(await page.evaluate(() => window.changes), [[2]]);
    await page.evaluate(() => window.editor.setValue([1, 9]));
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [1, 9]);
    assert.equal(await page.$eval('[data-task-skill-summary]', (el) => el.textContent), '2 selected');
    assert.match(await page.$eval('.task-skill-picker__options', (el) => el.textContent), /Unavailable skill/);
    await page.evaluate(() => window.editor.setReadOnly(true));
    assert.equal(await page.$eval('[data-task-skill-id]', (el) => el.matches(':disabled')), true);
    await page.click('[data-task-skill-id][value="1"]');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [1, 9]);
    await page.evaluate(() => window.editor.setReadOnly(false));
    await page.click('[data-task-skill-id][value="1"]');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [9]);
  } finally { await page.close(); }
});

test('subtask editor adds, edits, assigns skills, reorders and removes rows without mixing their requirements', async () => {
  const page = await mounted('subtasks', { subtasks: [{ title: 'Chop', skill_ids: [2] }, { title: 'Wash', skill_ids: [1] }] });
  try {
    assert.equal(await page.$eval('[data-task-subtask-action="up"]', (el) => el.disabled), true);
    await page.click('[data-task-subtask-action="down"]');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [
      { title: 'Wash', skill_ids: [1] }, { title: 'Chop', skill_ids: [2] },
    ]);
    await page.click('[data-task-subtask-add]');
    await page.type('[data-task-subtask-row]:last-child [data-task-subtask-title]', 'Serve');
    await page.click('[data-task-subtask-row]:last-child summary');
    await page.click('[data-task-subtask-row]:last-child [data-task-skill-id][value="1"]');
    assert.deepEqual((await page.evaluate(() => window.editor.getValue())).at(-1), { title: 'Serve', skill_ids: [1] });
    await page.click('[data-task-subtask-action="remove"]');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [
      { title: 'Chop', skill_ids: [2] }, { title: 'Serve', skill_ids: [1] },
    ]);
    assert.equal(await page.$eval('[data-task-subtask-title]', (el) => el.getAttribute('aria-label')), 'Subtask 1');
    const changeCount = await page.evaluate(() => window.changes.length);
    assert.ok(changeCount > 3);
    await page.evaluate(() => window.editor.setValue([{ title_template: 'Fresh template', skill_ids: [2] }]));
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [{ title: 'Fresh template', skill_ids: [2] }]);
    assert.equal(await page.evaluate(() => window.changes.length), changeCount, 'programmatic reset is silent');
    await page.evaluate(() => window.editor.setValue([]));
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), []);
  } finally { await page.close(); }
});

test('subtask editor keeps read-only drafts unchanged and disposal removes event handlers', async () => {
  const page = await mounted('subtasks', { subtasks: [{ title: 'Rest', skill_ids: [1] }] });
  try {
    await page.evaluate(() => window.editor.setReadOnly(true));
    assert.equal(await page.$eval('[data-task-subtask-title]', (el) => el.disabled), true);
    await page.click('[data-task-subtask-add]');
    await page.click('[data-task-subtask-action="remove"]');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [{ title: 'Rest', skill_ids: [1] }]);
    await page.evaluate(() => window.editor.setReadOnly(false));
    await page.click('[data-task-subtask-add]');
    assert.equal((await page.evaluate(() => window.editor.getValue())).length, 2);
    await page.evaluate(() => window.editor.dispose());
    await page.click('[data-task-subtask-add]');
    assert.equal((await page.evaluate(() => window.editor.getValue())).length, 2);
  } finally { await page.close(); }
});

test('requirements controls fit desktop, tablet and mobile with readable touch targets across themes', async () => {
  for (const width of [1366, 768, 390]) {
    const page = await mounted('subtasks', { subtasks: [{ title: 'A long but ordinary household subtask', skill_ids: [1, 2] }] }, { width, height: 900 });
    try {
      await page.click('summary');
      for (const theme of ['neutral', 'warm', 'cool']) for (const appearance of ['light', 'dark']) {
        const measured = await page.evaluate(({ theme, appearance }) => {
          document.documentElement.dataset.colorTheme = theme;
          document.documentElement.dataset.theme = appearance;
          document.documentElement.dataset.typography = 'serif';
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            buttons: [...document.querySelectorAll('[data-task-subtask-action]')].map((button) => {
              const { width, height } = button.getBoundingClientRect();
              return { width, height };
            }),
          };
        }, { theme, appearance });
        assert.equal(measured.overflow, false, `${width} ${theme} ${appearance}`);
        assert.ok(measured.buttons.every((button) => button.width >= 44 && button.height >= 44));
      }
    } finally { await page.close(); }
  }
});

test('Task detail shows read-only skills and operational completion without exposing structural controls', async () => {
  const page = await browser.newPage();
  try {
    requests.length = 0;
    await page.goto(`${base}/requirements-test`);
    await page.evaluate(async () => {
      window.yuvomi = { showToast() {} };
      const { openTaskDetail } = await import('/components/task-detail.js');
      openTaskDetail({ task: { id: 1, revision: 1, title: 'Prepare dinner', status: 'open', created_by: 1,
        description: 'Follow these instructions first.', permissions: { complete: true, edit: true, comment: true },
        skill_ids: [1], skills: [{ id: 1, name: 'Kitchen safety' }],
        subtasks: [{ id: 2, revision: 3, parent_revision: 1, title: 'Chop vegetables', status: 'open',
          permissions: { complete: true }, skill_ids: [1], skills: [{ id: 1, name: 'Kitchen safety' }] }] },
        currentUserId: 1, isAdmin: true, onChanged() {} });
    });
    await page.waitForSelector('.detail-subtask__toggle');
    assert.match(await page.$eval('[data-subtask-id="2"]', el => el.innerText), /Kitchen safety/);
    assert.equal(await page.$('.detail-subtask__editor'), null);
    assert.equal(await page.$('.detail-subtask__actions'), null);
    assert.equal(await page.$('.detail-subtask--add'), null);
    assert.equal(await page.$('.task-skill-picker'), null);
    const positions = await page.evaluate(() => ({ description: document.querySelector('.task-detail__note').getBoundingClientRect().top,
      subtasks: document.querySelector('.detail-task-subtasks').getBoundingClientRect().top,
      metadata: document.querySelector('.task-detail-metadata').getBoundingClientRect().top }));
    assert.ok(positions.description < positions.subtasks && positions.subtasks < positions.metadata);
    await page.click('.detail-subtask__toggle');
    await page.waitForFunction(() => !document.querySelector('.detail-subtask__toggle')?.disabled);
    assert.deepEqual(requests.find(request => request.method === 'PATCH' && request.path === '/tasks/2/status').body,
      { status: 'done', expected_revision: 3, expected_parent_revision: 1 });
  } finally { await page.close(); }
});

test('mobile Task detail skill context and supervision labels wrap without editable administrative controls', async () => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${base}/requirements-test`);
    await page.evaluate(async () => {
      window.yuvomi = { showToast() {} };
      const { openTaskDetail } = await import('/components/task-detail.js');
      openTaskDetail({ task: { id: 1, revision: 1, title: 'Template dinner', status: 'open', permissions: { complete: true },
        activity_template_id: 1, activity_template_name: 'Kitchen reset',
        subtasks: [{ id: 2, revision: 1, title: 'Slice vegetables', status: 'open', permissions: { complete: true },
          skill_ids: [1], skills: [{ id: 1, name: 'Kitchen knife safety' }], supervision_action: {
            state: 'assigned', supervisor_user_id: 2, supervisor_name: 'Parent', reason: 'Supervision required' } }] },
        currentUserId: 1, isAdmin: false, onChanged() {} });
    });
    await page.waitForSelector('.detail-subtask__toggle');
    assert.match(await page.$eval('[data-subtask-id="2"]', el => el.innerText), /Kitchen knife safety.*Supervision required.*Supervisor: Parent/s);
    assert.equal(await page.$eval('.detail-subtask__toggle', el => el.disabled), true);
    assert.equal(await page.$('#detail-view-edit'), null);
    assert.equal(await page.$('.task-skill-picker'), null);
    const layout = await page.$eval('[data-subtask-id="2"]', row => {
      const title = row.querySelector('.detail-subtask__title').getBoundingClientRect();
      const toggle = row.querySelector('.detail-subtask__toggle').getBoundingClientRect();
      const meta = row.querySelector('.detail-subtask__meta').getBoundingClientRect();
      return { titleHeight: title.height, toggleHeight: toggle.height, metaTop: meta.top, toggleBottom: toggle.bottom,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.ok(layout.titleHeight < 60);
    assert.ok(layout.toggleHeight >= 44);
    assert.ok(layout.metaTop >= layout.toggleBottom);
    assert.equal(layout.overflow, false);
  } finally { await page.close(); }
});

test('subtask definitions and nested Skill creation live under Edit and preserve the draft on return', async () => {
  const page = await browser.newPage();
  try {
    requests.length = 0;
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`${base}/requirements-test`);
    await page.evaluate(async () => {
      window.yuvomi = { showToast() {} };
      const { setPermissions } = await import('/permissions.js'); setPermissions({ admin: true });
      const { openTaskDetail } = await import('/components/task-detail.js');
      const { renderSubtaskEditor, bindSubtaskEditor } = await import('/components/task-requirements.js');
      openTaskDetail({ task: { id: 1, revision: 1, title: 'Keep dinner details', status: 'open', created_by: 1,
          permissions: { complete: true, edit: true }, subtasks: [] }, currentUserId: 1, isAdmin: true,
        edit: { mount(_panel, pane) {
          pane.insertAdjacentHTML('beforeend', renderSubtaskEditor({ subtasks: [{ id: 4, title: 'Measure ingredients', skill_ids: [] }], canCreateSkill: true }));
          window.editor = bindSubtaskEditor(pane, { onCreateSkill: async () => {
            const { openSkillEditor } = await import('/components/activity-automation.js'); return openSkillEditor();
          } });
        } }, onChanged() {} });
    });
    assert.equal(await page.$('[data-task-subtask-title]'), null);
    await page.click('#detail-view-edit');
    await page.waitForSelector('[data-task-subtask-title]');
    await page.click('[data-task-subtask-row] summary');
    await page.click('[data-task-subtask-row] [data-create-skill]');
    await page.waitForSelector('#automation-skill-form');
    await page.click('#shared-modal-overlay [data-action="close-modal"]');
    await page.waitForFunction(() => !document.querySelector('#automation-skill-form'));
    assert.equal(await page.$eval('[data-task-subtask-title]', el => el.value), 'Measure ingredients');
    await page.click('[data-task-subtask-row] [data-create-skill]');
    await page.waitForSelector('#automation-skill-form');
    await page.type('#automation-skill-form [name="name"]', 'Measuring by weight');
    await page.focus('#shared-modal-overlay [type="submit"]'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#automation-skill-form'));
    await page.waitForFunction(() => document.querySelector('[data-task-skill-id][value="7"]')?.checked);
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), [{ id: 4, title: 'Measure ingredients', skill_ids: [7] }]);
  } finally { await page.close(); }
});
