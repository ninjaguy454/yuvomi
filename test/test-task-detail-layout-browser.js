import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import puppeteer from 'puppeteer';

// The real detail renderer, controller, API client and application styles;
// explicit server-shaped eligibility fixtures never stand in for authorization.
const copy = value => structuredClone(value);
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const styles = [...readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(match => match[0]).join('\n');
const output = process.env.DETAIL_QA_OUTPUT;
if (output) mkdirSync(output, { recursive: true });
const app = express();
let browser, server, base, fixture;
app.use(express.json());
app.use(express.static(publicDir));
app.get('/detail-layout-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  <link rel="stylesheet" href="/styles/tasks.css"><script src="/lucide.min.js"></script>
  <style>*,*::before,*::after{animation:none!important;scroll-behavior:auto!important;transition:none!important}</style>
  </head><body><main>Isolated Task detail QA</main></body></html>`));
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ user: { id: 2 }, permissions: {}, csrfToken: 'fixture' });
  if (req.method === 'PATCH' && /^\/tasks\/\d+\/status$/.test(req.path)) {
    fixture.writes.push({ method: req.method, path: req.path, body: copy(req.body), res });
    if (fixture.failure) return res.status(403).set('X-CSRF-Token', 'fixture').json({ error: fixture.failure });
    return; // The test owns acknowledgement to inspect genuine pending UI.
  }
  if (req.method !== 'GET') {
    fixture.writes.push({ method: req.method, path: req.path, body: copy(req.body) });
    return res.json({ data: fixture.task });
  }
  if (req.path === `/tasks/${fixture.task.id}`) { fixture.reads++; return res.json({ data: fixture.task }); }
  if (req.path.endsWith('/activity')) return res.json({ data: [
    { id: 1, event_type: 'created', actor_name: 'Creator', created_at: '2026-09-13T10:00:00Z', details: {} },
    { id: 2, event_type: 'supervisor_assigned', actor_name: 'Creator', created_at: '2026-09-13T10:02:00Z', details: {} },
  ] });
  if (req.path.endsWith('/comments')) return res.json({ data: [], task_revision: fixture.task.revision });
  return res.json({ data: [] });
});

const learner = { id: 2, display_name: 'Eleanor Alexandra Montgomery-Sebastian' };
const supervisor = { id: 42, display_name: 'Duane Sebastian Montgomery-Sebastian' };
const alternate = { id: 43, display_name: 'Another qualified household supervisor' };
const skills = [{ id: 1, name: 'Laundry Sorting' }, { id: 2, name: 'Washing Machine' },
  { id: 3, name: 'Dryer' }, { id: 4, name: 'Laundry Safety' }];
const reasons = {
  independent: 'Eleanor may sort laundry independently under the current Laundry Sorting proficiency settings.',
  supervised: 'Eleanor may load and start the washer only with an eligible supervisor present for Washing Machine.',
  delegated: 'Eleanor must not operate the dryer under the current Dryer proficiency settings. The helper performs this action.',
  unresolved: 'No single qualified household member is available to cover Washing Machine, Dryer and Laundry Safety during this Task’s completion window.',
};
function requirement(id, skill, proficiency, mode, patch = {}) {
  return { action_task_id: id, action_title: id === 12 ? 'Load and start washer' : id === 13 ? 'Transfer and start dryer' : 'Whole Laundry safety requirement',
    state: 'assigned', execution_mode: mode, required_skills: [skills[skill - 1]], completed: false,
    source_task_id: 10, counterpart_task_id: id + 10, supervisor_user_id: supervisor.id, supervisor_name: supervisor.display_name,
    learner_user_id: learner.id, learner_name: learner.display_name, can_complete: false,
    display_reason: reasons[proficiency], skill_eligibility: [{ skill_id: skill, skill_name: skills[skill - 1].name,
      proficiency: proficiency === 'delegated' ? 'excluded' : proficiency, reason: reasons[proficiency] }], ...patch };
}
function taskFixture({ helper = false, unresolved = false, restricted = false, parentOnly = false } = {}) {
  const actions = [requirement(12, 2, 'supervised', 'supervised'), requirement(13, 3, 'delegated', 'delegated')];
  if (parentOnly) actions.push(requirement(10, 4, 'supervised', 'supervised', { action_title: 'Whole Laundry safety requirement' }));
  if (unresolved) for (const action of actions) { action.state = 'unresolved'; action.supervisor_user_id = null; action.supervisor_name = null; }
  const task = { id: 10, revision: 9, title: 'Eleanor’s laundry and weekly bedding', status: 'open', priority: 'medium',
    assigned_to: learner.id, assigned_users: [learner], assigned_name: learner.display_name, created_by: 99,
    description: 'Gather all laundry and bedding. Sort lights and darks before choosing the correct washing programme.',
    points: 30, category: 'household', tags: ['laundry', 'weekly routine'], visibility: 'all', documents: [],
    start_date: '2026-09-13', due_date: '2026-09-14', due_time: '19:30', recurrence_rule: 'FREQ=WEEKLY;BYDAY=SU', is_recurring: true,
    activity_template_name: 'Household Laundry Template', activity_subject_name: learner.display_name,
    activity_assignment_policy: 'fixed', activity_assignment_state: 'assigned',
    permissions: { view: true, complete: !restricted, edit: false, delete_archive: false, comment: !restricted },
    supervision: { state: unresolved ? 'needed' : 'assigned', source_task_id: 10, source_revision: 9, support_task_id: 20,
      supervisor_user_id: unresolved ? null : supervisor.id, supervisor_name: unresolved ? null : supervisor.display_name,
      may_assign: !restricted, can_view_support: !restricted, eligible_supervisors: unresolved ? [] : [supervisor, alternate],
      display_reason: unresolved ? reasons.unresolved : '', supervisor_explanations: unresolved ? [{ user_id: 42, name: supervisor.display_name,
        eligible: false, display_reason: 'Duane is qualified but unavailable during this Task’s completion window.' }] : [], actions },
    subtasks: [
      { id: 11, parent_task_id: 10, parent_revision: 9, revision: 2, title: 'Sort lights and darks', status: 'open',
        skill_ids: [1], skills: [skills[0]], skill_eligibility: [{ skill_id: 1, skill_name: skills[0].name, proficiency: 'normal', reason: reasons.independent }],
        points: 0, permissions: { view: true, complete: !restricted } },
      ...actions.filter(action => action.action_task_id !== 10).map(action => ({ id: action.action_task_id, parent_task_id: 10,
        parent_revision: 9, revision: 3, title: action.action_title, status: 'open', points: 0,
        skill_ids: action.required_skills.map(skill => skill.id), skills: action.required_skills,
        skill_eligibility: action.skill_eligibility, supervision_action: action, permissions: { view: true, complete: !restricted } })),
      { id: 14, parent_task_id: 10, parent_revision: 9, revision: 4, title: 'Put clean laundry away', status: 'done', points: 0,
        permissions: { view: true, complete: !restricted } },
    ] };
  if (helper) {
    task.id = 20; task.title = 'Supervise Eleanor’s laundry'; task.is_supervision_projection = true; task.points = 0;
    task.assigned_to = supervisor.id; task.assigned_users = [supervisor]; task.assigned_name = supervisor.display_name;
    task.subtasks = actions.map(action => ({ id: action.counterpart_task_id, parent_task_id: 20, parent_revision: 9, revision: 3,
      title: action.action_title, status: 'open', points: 0, is_supervision_projection: true,
      skill_ids: action.required_skills.map(skill => skill.id), skills: action.required_skills,
      supervision_action: { ...action, can_complete: !restricted }, permissions: { view: true, complete: !restricted } }));
  }
  return task;
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function mounted(options = {}) {
  fixture = { task: taskFixture(options), reads: 0, writes: [], errors: [] };
  const page = await browser.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => fixture.errors.push(error.message));
  await page.setViewport({ width: options.width || 390, height: 844, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${base}/detail-layout-test`);
  await page.evaluate(async ({ task, people, skills, helper }) => {
    localStorage.setItem('yuvomi-locale', 'en');
    document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.colorTheme = 'warm';
    window.liveStreams = []; window.toasts = []; window.fixtureTask = task;
    window.yuvomi = { showToast: message => window.toasts.push(message) };
    window.EventSource = class { constructor() { this.listeners = new Map(); this.readyState = 1; window.liveStreams.push(this); }
      addEventListener(name, callback) { this.listeners.set(name, callback); } close() { this.readyState = 2; } };
    await (await import('/i18n.js')).initI18n();
    const { openTaskDetail } = await import('/components/task-detail.js');
    window.view = openTaskDetail({ task, users: people, skills, currentUserId: helper ? 42 : 2, isAdmin: false, onChanged() {} });
  }, { task: copy(fixture.task), people: [learner, supervisor, alternate], skills, helper: options.helper });
  await page.waitForSelector('.detail-task-subtasks'); await frames(page);
  return page;
}
async function emitLive(page) {
  fixture.task.revision++;
  await page.evaluate(revision => window.liveStreams[0].listeners.get('change')({ data: JSON.stringify({ version: revision }) }), fixture.task.revision);
  await page.waitForFunction(revision => window.fixtureTask.revision === revision, {}, fixture.task.revision);
  await frames(page);
}
async function screenshot(page, name) {
  if (!output) return;
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  const scroll = await page.$eval('.modal-panel__body', node => {
    const before = node.scrollTop;
    const subtasks = node.querySelector('.detail-task-subtasks');
    node.scrollTop += subtasks.getBoundingClientRect().top - node.getBoundingClientRect().top - 24;
    return before;
  });
  await frames(page);
  await page.screenshot({ path: path.join(output, `${name}-actions.png`), fullPage: true });
  await page.$eval('.modal-panel__body', node => { node.scrollTop = node.scrollHeight; });
  await frames(page);
  await page.screenshot({ path: path.join(output, `${name}-lower.png`), fullPage: true });
  await page.$eval('.modal-panel__body', (node, value) => { node.scrollTop = value; }, scroll);
  writeFileSync(path.join(output, `${name}.txt`), await page.$eval('.detail-view__pane', node => node.innerText));
}
const disclosure = id => `[data-disclosure-key="subtask-skills-${id}"]`;
const toggle = id => `[data-subtask-id="${id}"] .detail-subtask__toggle`;

for (const width of [390, 412, 1280]) test(`${width}px detail puts compact supervision before actionable steps and keeps primary metadata together`, async () => {
  const page = await mounted({ width });
  try {
    const order = await page.evaluate(() => {
      const before = (a, b) => !!(document.querySelector(a).compareDocumentPosition(document.querySelector(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { supervision: before('.task-detail-supervision', '.detail-task-subtasks'), tags: before('.task-detail-tags', '.detail-task-subtasks'),
        pointsWithProgress: !!document.querySelector('.task-detail-metrics .task-detail-points') && !!document.querySelector('.task-detail-metrics .task-detail-progress'),
        dates: [...document.querySelectorAll('.task-detail-dates dt')].map(node => node.textContent),
        overflow: document.documentElement.scrollWidth > innerWidth,
        activityClosed: !document.querySelector('.task-detail-activity-disclosure').open,
        historyClosed: !document.querySelector('.task-detail-history-disclosure').open };
    });
    assert.equal(order.supervision, true); assert.equal(order.tags, true); assert.equal(order.pointsWithProgress, true);
    assert.equal(order.dates.length, 2); assert.equal(order.overflow, false);
    assert.equal(order.activityClosed, true); assert.equal(order.historyClosed, true);
    const controls = await page.evaluate(() => {
      const pane = document.querySelector('.detail-view__pane').getBoundingClientRect();
      const selects = [...document.querySelectorAll('.task-detail-status select, .task-detail-supervision select')].map(node => {
        const r = node.getBoundingClientRect(), css = getComputedStyle(node);
        const canvas = document.createElement('canvas').getContext('2d');
        canvas.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        return { left: r.left, right: r.right, width: node.clientWidth, isStatus: !!node.closest('.task-detail-status'),
          required: canvas.measureText(node.selectedOptions[0]?.textContent || '').width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) };
      });
      return { pane: { left: pane.left, right: pane.right }, selects };
    });
    assert.ok(controls.selects.every(control => control.left >= controls.pane.left - 1 && control.right <= controls.pane.right + 1),
      `selects fit the modal pane without concealed clipping: ${JSON.stringify(controls)}`);
    assert.ok(controls.selects.filter(control => control.isStatus).every(control => control.width >= control.required - 1),
      'the Task status value remains fully readable');
    if (width <= 412) {
      const action = await page.$eval('[data-subtask-id="11"]', node => ({
        titleHeight: node.querySelector('.detail-subtask__title').getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(node.querySelector('.detail-subtask__title')).lineHeight),
      }));
      assert.ok(action.titleHeight / action.lineHeight <= 2.05, 'a short mobile action title is not squeezed into three or more lines');
    }
    const rowsFit = await page.$$eval('.detail-subtask', rows => rows.every(row => {
      const r = row.getBoundingClientRect();
      return [...row.children].every(child => { const box = child.getBoundingClientRect(); return box.left >= r.left - 1 && box.right <= r.right + 1; });
    }));
    assert.equal(rowsFit, true, 'subtask action and skill controls remain inside their rows');
    assert.match(await page.$eval('.task-detail-secondary', node => node.textContent), /Household Laundry Template/);
    assert.equal(await page.$$eval('.task-detail-metadata', nodes => nodes.some(node => node.textContent.includes('Household Laundry Template'))), false);
    const names = await page.$$eval('.task-detail-participant__text strong', nodes => nodes.map(node => ({
      width: node.clientWidth, scroll: node.scrollWidth, text: node.textContent, style: getComputedStyle(node).textOverflow,
    })));
    assert.ok(names.some(node => node.text === learner.display_name));
    assert.ok(names.every(node => node.scroll <= node.width + 1 && node.style !== 'ellipsis'));
    assert.equal(await page.$(toggle(13)), null, 'transferred work is not actionable on the learner projection');
    assert.equal(await page.$eval(toggle(12), node => node.disabled), true, 'canonical supervision completion restriction remains');
    await screenshot(page, `detail-${width}`);
  } finally { await page.close(); }
});

test('per-skill disclosure explains independent and supervised steps without duplicating the operational action list', async () => {
  const page = await mounted();
  try {
    assert.equal(await page.$eval(disclosure(11), node => node.open), false);
    assert.equal(await page.$eval(disclosure(12), node => node.open), false);
    assert.match(await page.$eval(`${disclosure(11)} summary`, node => node.textContent), /Laundry Sorting/);
    assert.match(await page.$eval(`${disclosure(12)} summary`, node => node.textContent), /Washing Machine/);
    assert.doesNotMatch(await page.$eval('.detail-task-subtasks', node => node.innerText), /current Laundry Sorting proficiency settings/);
    await page.focus(`${disclosure(11)} summary`); await page.keyboard.press('Space');
    assert.equal(await page.$eval(disclosure(11), node => node.open), true);
    assert.match(await page.$eval(disclosure(11), node => node.innerText), /may sort laundry independently/);
    await page.click(`${disclosure(12)} summary`);
    assert.match(await page.$eval(disclosure(12), node => node.innerText), /only with an eligible supervisor/);
    assert.equal(await page.$eval(disclosure(12), (node, reason) => node.innerText.split(reason).length - 1, reasons.supervised), 1,
      'the same canonical skill and action explanation is displayed only once');
    assert.equal(await page.$$eval('.task-detail-supervision__action', nodes => nodes.filter(node => node.textContent.includes('Load and start washer')).length), 0);
    assert.equal(await page.$$eval('.task-detail-supervision__helper-link', nodes => nodes.length), 1);
    assert.equal(await page.$eval('.task-detail-supervision__helper-link', node => new URL(node.href).searchParams.get('open')), '20');
    assert.deepEqual(fixture.writes, []);
  } finally { await page.close(); }
});

test('delegated and parent-only helper responsibilities remain available without becoming learner actions', async () => {
  const page = await mounted({ parentOnly: true });
  try {
    const others = '.task-detail-supervision__other-actions';
    await page.click(`${others} summary`);
    const text = await page.$eval(others, node => node.innerText);
    assert.match(text, /Transfer and start dryer/); assert.match(text, /Whole Laundry safety requirement/);
    assert.doesNotMatch(text, /Load and start washer/);
    assert.match(text, /performs this|Direct responsibility/i);
    assert.equal(await page.$(toggle(13)), null);
    assert.match(await page.$eval('.task-detail-progress', node => node.innerText), /1 of 3 complete/);
  } finally { await page.close(); }
});

test('helper projection keeps supervised and delegated ownership distinct with existing completion permission', async () => {
  const page = await mounted({ helper: true });
  try {
    assert.match(await page.$eval('[data-subtask-id="22"]', node => node.innerText), /Supervision required/i);
    assert.match(await page.$eval('[data-subtask-id="23"]', node => node.innerText), /Direct responsibility|You perform this/i);
    await page.click(`${disclosure(22)} summary`);
    assert.match(await page.$eval(disclosure(22), node => node.innerText), /performs this with you/i);
    assert.equal(await page.$eval(toggle(22), node => node.disabled), false);
    assert.equal(await page.$eval(toggle(23), node => node.disabled), false);
    assert.equal(await page.$(toggle(12)), null);
    await screenshot(page, 'detail-helper-mobile');
  } finally { await page.close(); }
});

test('one canonical supervisor selector is permission-gated and only contains complete-scope eligible candidates', async () => {
  const page = await mounted();
  try {
    assert.equal(await page.$$eval('[data-focus-key="task-supervisor"]', nodes => nodes.length), 1);
    assert.deepEqual(await page.$$eval('[data-focus-key="task-supervisor"] option', nodes => nodes.map(node => Number(node.value))), [42, 43]);
    assert.equal(await page.$eval('[data-focus-key="assign-task-supervisor"]', node => node.disabled), false);
  } finally { await page.close(); }
  const restricted = await mounted({ restricted: true });
  try {
    assert.equal(await restricted.$('[data-focus-key="task-supervisor"]'), null);
    assert.equal(await restricted.$('[data-focus-key="assign-task-supervisor"]'), null);
    assert.equal(await restricted.$('.task-detail-supervision__helper-link'), null);
    assert.equal(await restricted.$('.task-comment__input'), null);
    assert.ok((await restricted.$$eval('.detail-subtask__toggle', nodes => nodes.map(node => node.disabled))).every(Boolean));
    assert.deepEqual(fixture.writes, []);
  } finally { await restricted.close(); }
});

test('unresolved scope explanation stays immediately visible when no qualified available supervisor exists', async () => {
  const page = await mounted({ unresolved: true });
  try {
    assert.match(await page.$eval('.task-detail-supervision', node => node.innerText), /No single qualified household member is available/);
    assert.equal(await page.$('[data-focus-key="task-supervisor"]'), null);
    assert.equal(await page.$eval(toggle(12), node => node.disabled), true);
    await screenshot(page, 'detail-unresolved-mobile');
  } finally { await page.close(); }
});

test('live snapshots preserve opened explanation, Activity, comment draft, text selection and scroll', async () => {
  const page = await mounted();
  try {
    await page.click(`${disclosure(11)} summary`);
    await page.click('.task-detail-activity-disclosure summary');
    await page.$eval('.task-comment__input', node => { node.value = 'Keep this unsent household discussion draft'; node.focus({ preventScroll: true }); node.setSelectionRange(5, 12); });
    const before = await page.$eval('.modal-panel__body', node => { node.scrollTop = 150; return node.scrollTop; });
    await emitLive(page);
    assert.equal(await page.$eval(disclosure(11), node => node.open), true);
    assert.equal(await page.$eval('.task-detail-activity-disclosure', node => node.open), true);
    assert.deepEqual(await page.$eval('.task-comment__input', node => [node.value, node.selectionStart, node.selectionEnd, document.activeElement === node]),
      ['Keep this unsent household discussion draft', 5, 12, true]);
    assert.ok(Math.abs(await page.$eval('.modal-panel__body', node => node.scrollTop) - before) <= 2);
    assert.deepEqual(fixture.writes, []);
  } finally { await page.close(); }
});

test('optimistic completion and rejection preserve expanded skill explanations and comment draft', async () => {
  const page = await mounted();
  try {
    await page.click(`${disclosure(11)} summary`);
    await page.$eval('.task-comment__input', node => { node.value = 'Preserve while saving'; });
    const before = await page.$eval('.modal-panel__body', node => { node.scrollTop = 120; return node.scrollTop; });
    await page.$eval(toggle(11), node => node.click());
    await page.waitForFunction(() => document.querySelector('[data-subtask-id="11"] .detail-subtask__toggle').getAttribute('aria-busy') === 'true');
    assert.equal(await page.$eval(disclosure(11), node => node.open), true);
    assert.match(await page.$eval('.task-detail-progress', node => node.innerText), /2 of 3 complete/);
    assert.ok(Math.abs(await page.$eval('.modal-panel__body', node => node.scrollTop) - before) <= 2);
    const deadline = Date.now() + 5000;
    while (!fixture.writes.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.writes.length, 1, 'one canonical completion request was dispatched');
    fixture.failure = 'Fixture canonical completion rejection.';
    fixture.writes[0].res.status(403).set('X-CSRF-Token', 'fixture').json({ error: fixture.failure });
    try { await page.waitForFunction(() => window.toasts.length > 0); }
    catch (error) { throw new Error(JSON.stringify({ errors: fixture.errors, writes: fixture.writes.map(({ res, ...write }) => write),
      state: await page.evaluate(() => ({ toasts: window.toasts, pressed: document.querySelector('[data-subtask-id="11"] .detail-subtask__toggle')?.getAttribute('aria-pressed'), busy: document.querySelector('[data-subtask-id="11"] .detail-subtask__toggle')?.getAttribute('aria-busy') })) }), { cause: error }); }
    assert.equal(await page.$eval(disclosure(11), node => node.open), true);
    assert.equal(await page.$eval('.task-comment__input', node => node.value), 'Preserve while saving');
    assert.equal(await page.$eval(toggle(11), node => node.getAttribute('aria-pressed')), 'false');
    assert.deepEqual(fixture.writes[0].body, { status: 'done', expected_revision: 2, expected_parent_revision: 9 });
  } finally { await page.close(); }
});
