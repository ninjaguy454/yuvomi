import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/components/activity-automation.js', import.meta.url), 'utf8').replace(/\r/g, '');
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function load(name, bindings, prefix = '') {
  const declaration = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(declaration, `Missing ${name}`);
  return new Function(...Object.keys(bindings), `${prefix}\nreturn (${declaration.replace(/^export /, '')});`)(...Object.values(bindings));
}
function node(dataset = {}) {
  return { dataset, listeners: {}, isConnected: true, value: '', disabled: false, html: '', textContent: '',
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_position, html) { this.html += html; },
    focus() { this.focused = true; },
  };
}
function launcherHarness({ canCreate = false } = {}) {
  const target = node(), scroll = { scrollTop: 99 }, calls = [], runs = [], editors = [];
  let templates = [{ id: 7, name: 'School morning', description: 'Prepare & leave' }];
  let buttons = [], creator;
  const panel = { querySelector(selector) {
    if (selector === '[data-workflow-launcher]') return target;
    if (selector === '.modal-panel__body') return scroll;
    return buttons.find((item) => selector === `[data-quick-template="${item.dataset.quickTemplate}"]`) || null;
  } };
  target.querySelectorAll = () => buttons;
  target.querySelector = () => creator;
  target.closest = () => null;
  const editorContext = { activities: [{ id: 2, name: 'Pack lunch' }], members: [{ id: 1 }] };
  const open = load('openTaskWorkflows', {
    api: { get: async (path) => { calls.push(path); return { data: templates, members: [{ id: 1 }], places: [{ id: 4 }], activities: [{ id: 2, name: 'MUST NOT APPEAR' }] }; } },
    h: esc, window: {}, toast: (message) => { throw new Error(message); },
    replaceHtml: (_target, html) => {
      target.html = html;
      buttons = [...html.matchAll(/data-quick-template="(\d+)"/g)].map((match) => node({ quickTemplate: match[1] }));
      creator = html.includes('data-create-task-workflow') ? node() : null;
    },
    openModal: (options) => { calls.push(options.title); options.onSave(panel); },
    openQuickAddTemplate: (...args) => runs.push(args),
    loadWorkflowEditorContext: async () => editorContext,
    openWorkflowForm: (...args) => editors.push(args),
  });
  return { open: () => open({ canCreate }), target, panel, scroll, calls, runs, editors, editorContext,
    buttons: () => buttons, creator: () => creator, update: (next) => { templates = next; } };
}

test('the lightning launcher lists workflows only and preserves run context', async () => {
  const fixture = launcherHarness();
  await fixture.open();
  assert.match(fixture.target.html, /School morning/);
  assert.match(fixture.target.html, /Prepare &amp; leave/);
  assert.doesNotMatch(fixture.target.html, /MUST NOT APPEAR|data-create-task-workflow/);
  fixture.buttons()[0].listeners.click();
  assert.equal(fixture.runs[0][0].id, 7);
  assert.deepEqual(fixture.runs[0][1], [{ id: 1 }]);
  assert.deepEqual(fixture.runs[0][2], [{ id: 4 }]);
  assert.equal(fixture.scroll.scrollTop, 99);
});

test('eligible creator reuses the canonical workflow editor and refreshes the retained launcher after Save', async () => {
  const fixture = launcherHarness({ canCreate: true });
  await fixture.open();
  assert.match(fixture.target.html, /Create new Task Workflow/);
  await fixture.creator().listeners.click({ currentTarget: fixture.creator() });
  const [workflow, context, manager, options] = fixture.editors[0];
  assert.equal(workflow, null);
  assert.equal(context, fixture.editorContext);
  assert.equal(manager, null);
  assert.equal(options.asChild, true);
  fixture.update([{ id: 8, name: 'New workflow' }]);
  await options.onSaved({ id: 8 });
  assert.match(fixture.target.html, /New workflow/);
  assert.equal(fixture.buttons()[0].focused, true);
  assert.equal(fixture.scroll.scrollTop, 99);
  assert.equal(fixture.calls.filter((entry) => entry === 'Task Workflows').length, 1, 'the launcher DOM is retained');
});

function runtimeHarness({ deferCreate = false } = {}) {
  const form = node(), preview = node(), submit = node(), input = node({ runtimeInput: 'destination', type: 'text' });
  input.value = 'Library';
  const requests = [], pending = [], completed = [], toasts = [], creates = [];
  let create;
  const panel = { isConnected: true, querySelector(selector) {
    if (selector === '#quick-add-form') return form;
    if (selector === '#quick-add-preview') return preview;
    if (selector.includes('type="submit"')) return submit;
    return null;
  } };
  form.querySelectorAll = () => [input];
  preview.querySelector = () => create;
  const api = { post(path, body) {
    requests.push({ path, body });
    if (path.endsWith('/create')) return deferCreate
      ? new Promise((resolve, reject) => creates.push({ resolve, reject }))
      : Promise.resolve({ data: { run_id: 9 } });
    return new Promise((resolve) => pending.push(resolve));
  } };
  const renderQuickPreview = load('renderQuickPreview', { api, h: esc, window: {}, renderResolvedVariables: load('renderResolvedVariables', { h: esc }), singlePendingAction: load('singlePendingAction', {}), toast: (value) => toasts.push(value),
    replaceHtml: (_target, html) => { preview.html = html; create = node(); } });
  const open = load('openQuickAddTemplate', { api, h: esc, inputRow: (_label, html) => html,
    footer: () => '', renderRuntimeQuestion: () => '', memberOptions: () => '',
    collectRuntimeInputs: load('collectRuntimeInputs', {}), renderQuickPreview,
    toast: (value) => toasts.push(value),
    openChildModal: ({ onSave }) => { onSave(panel); return { close: async () => completed.push('child closed') }; },
  });
  open({ id: 3, name: 'Trip Tasks', input_schema: [] }, [], [], (data) => completed.push(data));
  return { form, preview, input, requests, pending, completed, panel, toasts, creates, create: () => create,
    submit: () => form.listeners.submit({ preventDefault() {} }) };
}

test('changing workflow answers invalidates a visible preview and rejects late stale previews', async () => {
  const fixture = runtimeHarness();
  const first = fixture.submit();
  fixture.input.value = 'Pool';
  fixture.form.listeners.input();
  fixture.pending[0]({ data: { steps: [{ title: 'OLD Library task' }] } });
  await first;
  assert.equal(fixture.preview.html, '');
  const second = fixture.submit();
  fixture.pending[1]({ data: { steps: [{ title: 'Pool task' }] } });
  await second;
  assert.match(fixture.preview.html, /Pool task/);
  fixture.input.value = 'Park';
  fixture.form.listeners.change();
  assert.equal(fixture.preview.html, '', 'the stale Create action is removed with the preview');
});

test('creating previewed Tasks uses the reviewed inputs and restores its parent before refreshing Tasks', async () => {
  const fixture = runtimeHarness();
  const pending = fixture.submit();
  fixture.pending[0]({ data: { steps: [{ title: 'Library task' }] } });
  await pending;
  await fixture.create().listeners.click();
  assert.deepEqual(fixture.requests.at(-1), { path: '/automation/quick-add/3/create', body: { subject_user_id: null, inputs: { destination: 'Library' } } });
  assert.deepEqual(fixture.completed, ['child closed', { run_id: 9 }]);
});

test('pending workflow creation rejects duplicate clicks and permits retry after failure', async () => {
  const fixture = runtimeHarness({ deferCreate: true });
  const preview = fixture.submit();
  fixture.pending[0]({ data: { steps: [{ title: 'Library task' }] } });
  await preview;
  const first = fixture.create().listeners.click();
  assert.equal(fixture.create().disabled, true);
  await fixture.create().listeners.click();
  assert.equal(fixture.creates.length, 1);
  fixture.creates[0].reject(new Error('Try again'));
  await first;
  assert.equal(fixture.create().disabled, false);
  const retry = fixture.create().listeners.click();
  assert.equal(fixture.creates.length, 2);
  fixture.creates[1].resolve({ data: { run_id: 9 } });
  await retry;
  assert.deepEqual(fixture.completed, ['child closed', { run_id: 9 }]);
  for (const formId of ['automation-activity-form', 'automation-workflow-form']) {
    assert.ok(source.includes(`panel.querySelector('#${formId}')?.addEventListener('submit', singlePendingAction(`),
      `${formId} uses the same pending action guard`);
  }
});

test('Save as Template prepares a create draft without overwriting an existing template ID', async () => {
  const response = { skills: [{ id: 2 }], members: [{ id: 3 }], categories: [], places: [] };
  let opened;
  const open = load('openActivityTemplateEditor', {
    document: { getElementById: () => ({ isConnected: true, inert: false }) },
    api: { get: async (path) => { assert.equal(path, '/automation/admin/activity-templates'); return response; } },
    activityEditorContext: load('activityEditorContext', {}),
    openActivityForm: (...args) => { opened = args; return 'child handle'; },
  });
  const onSaved = () => {};
  const draft = { id: 50, name: 'Reusable Task', skill_ids: [2], checklist: [{ title_template: 'Chop', skill_ids: [7] }], points: 5, priority: 'high', tags: ['Kitchen'], location_mode: 'fixed', place_id: 6 };
  assert.equal(await open({ draft, onSaved }), 'child handle');
  assert.deepEqual(opened[0], { ...draft, id: null, skills: [{ id: 2 }] });
  assert.deepEqual(opened[3], { asChild: true, onSaved, onSkillCreated: null });
  assert.equal(draft.id, 50, 'the source task/template object is untouched');
});

test('a template context request finishing after its parent closed cannot open a detached editor', async () => {
  const parent = { isConnected: true, inert: false };
  let opened = false, resolve;
  const open = load('openActivityTemplateEditor', { document: { getElementById: () => parent },
    api: { get: () => new Promise((done) => { resolve = done; }) },
    activityEditorContext: load('activityEditorContext', {}), openActivityForm: () => { opened = true; },
  });
  const pending = open();
  parent.isConnected = false;
  resolve({});
  assert.equal(await pending, null);
  assert.equal(opened, false);
});

test('the reused Activity editor saves reusable fields and per-subtask skills through the canonical create API', async () => {
  const fields = new Map(), requests = [], closed = [], saved = [];
  const values = { name: 'Dinner prep', title_template: 'Dinner prep', description: 'Wash first', category: 'kitchen',
    priority: 'high', points: '8', tags: 'Dinner, Cooking', assignment_strategy: 'open_claimable',
    participant_count: '1', location_mode: 'fixed', place_id: '5', presence_policy: 'ignore', presence_window: 'due' };
  const form = node();
  const panel = { querySelector(selector) {
    if (selector === '#automation-activity-form') return form;
    if (!fields.has(selector)) { const field = node(); field.value = selector === '[name="title_template"]' ? 'Dinner prep' : ''; fields.set(selector, field); }
    return fields.get(selector);
  } };
  let mounted, renderedSubtasks, renderedSkills;
  const open = load('openActivityForm', {
    canCapability: () => true,
    singlePendingAction: load('singlePendingAction', {}),
    h: esc, t: (key) => key, inputRow: (_label, html) => html, footer: () => '',
    categoryOptions: () => '', memberOptions: () => '', placeOptions: () => '',
    PRIORITIES: () => [{ value: 'none', label: 'None' }, { value: 'high', label: 'High' }], normalizeTagList: (tags) => tags || [],
    renderSubtaskEditor: (props) => { renderedSubtasks = props; return '<div data-task-subtask-editor></div>'; },
    renderSkillPicker: (props) => { renderedSkills = props; return '<div data-task-skill-picker></div>'; },
    bindSubtaskEditor: () => ({ getValue: () => [{ title: ' Chop vegetables ', skill_ids: [9] }, { title: ' ', skill_ids: [] }] }),
    bindSkillPicker: () => ({ getValue: () => [3] }), wireVariableMentions: () => {},
    openChildModal: (options) => { mounted = options; options.onSave(panel); return { close: async () => closed.push(true) }; },
    openModal: () => { throw new Error('must use child editor'); },
    FormData: class { get(name) { return values[name] ?? null; } has(name) { return name === 'allow_assignment_override'; } },
    api: { post: async (path, payload) => { requests.push({ path, payload }); return { data: { id: 17, ...payload } }; } },
    toast: () => {}, refreshAutomationManager: () => { throw new Error('must retain Task editor'); },
  });
  const draft = { name: 'Dinner prep', title_template: 'Dinner prep', subject_required: false,
    skill_ids: [3], checklist: [{ title_template: 'Chop vegetables', skill_ids: [9] }], points: 8, priority: 'high', tags: ['Dinner'] };
  open(draft, { skills: [{ id: 3 }, { id: 9 }], categories: [], members: [], places: [], variables: [] }, null,
    { asChild: true, onSaved: (data) => saved.push(data) });
  assert.equal(mounted.title, 'New Activity Template');
  assert.match(mounted.content, /Dates, reminders, recurrence and attached documents stay with this Task/);
  assert.doesNotMatch(mounted.content, /name="subject_required" checked/);
  assert.deepEqual(renderedSubtasks.subtasks, draft.checklist);
  assert.deepEqual(renderedSkills.selectedIds, [3]);
  const saving = form.listeners.submit({ preventDefault() {}, currentTarget: form });
  assert.equal(fields.get('[type="submit"]').disabled, true);
  await form.listeners.submit({ preventDefault() {}, currentTarget: form });
  await saving;
  assert.equal(requests.length, 1, 'a repeated submit cannot create the template twice while its save is pending');
  assert.equal(requests[0].path, '/automation/admin/activity-templates');
  assert.deepEqual(requests[0].payload.checklist, [{ title_template: 'Chop vegetables', skill_ids: [9] }]);
  assert.deepEqual(requests[0].payload.skill_ids, [3]);
  assert.deepEqual(requests[0].payload.tags, ['Dinner', ' Cooking']);
  assert.equal(requests[0].payload.points, 8);
  assert.equal(requests[0].payload.priority, 'high');
  assert.equal(requests[0].payload.place_id, 5);
  assert.equal(requests[0].payload.subject_required, false);
  assert.equal(closed.length, 1);
  assert.equal(saved[0].id, 17);
  assert.equal(requests[0].payload.due_date, undefined);
});

test('external task-list settings distinguish list synchronization from notification reminders', () => {
  const locale = JSON.parse(readFileSync(new URL('../public/locales/en.json', import.meta.url), 'utf8')).settings;
  assert.equal(locale.pageSyncReminders, 'Task & Shopping list sync');
  assert.match(locale.caldavRemindersHint, /CalDAV task lists/);
  assert.match(locale.caldavRemindersHint, /Notification reminders are managed on each Task/);
  assert.equal(locale.caldavSyncReminders, 'Sync external lists');
});

test('Skill creation reuses the administrator editor and returns its saved result only after restoring the parent', async () => {
  for (const cancel of [false, true]) {
    const form = node(), submit = node(), requests = [];
    let restore, restored = false;
    const closed = new Promise((resolve) => { restore = () => { restored = true; resolve(); }; });
    const panel = { querySelector: (selector) => selector === '#automation-skill-form' ? form : submit };
    const values = { name: 'Kitchen balance', description: 'Use the scale', minimum_age: '8', age_promotion: 'normal' };
    const openSkillForm = load('openSkillForm', {
      h: esc, inputRow: (_label, html) => html, footer: () => '', singlePendingAction: load('singlePendingAction', {}),
      FormData: class { get(name) { return values[name]; } has() { return false; } },
      api: { post: async (path, payload) => { requests.push({ path, payload }); return { data: { id: 71, ...payload } }; } },
      toast: () => {}, refreshAutomationManager: () => { throw new Error('must not replace the retained caller'); },
      openModal: () => { throw new Error('must use a child dialog'); },
      openChildModal: (options) => { assert.equal(options.title, 'New skill'); options.onSave(panel); return { closed, close: async () => restore() }; },
    });
    const open = load('openSkillEditor', { openSkillForm });
    const result = open();
    if (cancel) restore();
    else await form.listeners.submit({ preventDefault() {}, currentTarget: form });
    const saved = await result;
    assert.equal(restored, true);
    assert.equal(saved?.id ?? null, cancel ? null : 71);
    assert.equal(requests.length, cancel ? 0 : 1);
    if (!cancel) {
      assert.equal(requests[0].path, '/automation/admin/skills');
      assert.equal(requests[0].payload.minimum_age, 8);
      assert.equal(requests[0].payload.age_promotion, 'normal');
    }
  }
});
