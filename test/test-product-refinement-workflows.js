import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esc } from '../public/utils/html.js';

const taskSource = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8').replace(/\r/g, '');
const automationSource = readFileSync(new URL('../public/components/activity-automation.js', import.meta.url), 'utf8').replace(/\r/g, '');
const stateSource = readFileSync(new URL('../public/utils/task-state.js', import.meta.url), 'utf8').replace(/\r/g, '');

// Run the production functions with controlled browser boundaries. No live
// account, server, or database is involved in failure/retry tests.
function loadFunction(source, name, bindings, prefix = '') {
  const declaration = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(declaration, `Missing production function ${name}`);
  return new Function(...Object.keys(bindings), `${prefix}\nreturn (${declaration.replace(/^export /, '')});`)(...Object.values(bindings));
}
const taskRevision = loadFunction(stateSource, 'taskRevision', {});

test('automation fields associate labels and hints without replacing existing field IDs', () => {
  const inputRow = loadFunction(automationSource, 'inputRow', { h: esc }, 'let inputRowSequence = 0;');
  const first = inputRow('Skill & name', '<input name="name">', 'Used for assignment');
  assert.match(first, /<label class="label" for="automation-field-1">Skill &amp; name<\/label>/);
  assert.match(first, /<input name="name" id="automation-field-1" aria-describedby="automation-field-1-hint">/);
  assert.match(first, /id="automation-field-1-hint">Used for assignment/);

  const existing = inputRow('Type', '<select id="variable-type" aria-describedby="type-help"></select>', 'Choose a type');
  assert.match(existing, /for="variable-type"/);
  assert.match(existing, /aria-describedby="type-help automation-field-2-hint"/);
  assert.equal((existing.match(/id="variable-type"/g) || []).length, 1);
  assert.match(inputRow('Notes', '<textarea name="notes"></textarea>'), /<textarea name="notes" id="automation-field-3">/);
  const displayOnly = inputRow('Variable ID', '<code>{{example}}</code>');
  assert.doesNotMatch(displayOnly, /<label|for=/);
  assert.match(displayOnly, /<span class="label">Variable ID<\/span>/);
});

test('Quick Add question labels escape user text exactly once', () => {
  const inputRow = loadFunction(automationSource, 'inputRow', { h: esc }, 'let inputRowSequence = 0;');
  const render = loadFunction(automationSource, 'renderRuntimeQuestion', {
    h: esc, inputRow, workflowVariableId: (question) => question.id,
  });
  const html = render({ id: 'name', label: 'Parent & child <name>', type: 'text' }, [], []);
  assert.match(html, /Parent &amp; child &lt;name&gt;/);
  assert.doesNotMatch(html, /&amp;amp;|&amp;lt;/);
});

function fakeNode(dataset = {}) {
  return {
    dataset, hidden: false, disabled: false, attributes: {}, listeners: {}, html: '', textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    replaceChildren() { this.html = ''; this.textContent = ''; },
    insertAdjacentHTML(_position, html) { this.html += html; },
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolled = true; },
  };
}

function tripFixture(openTripId, failFirst = false) {
  const requests = [];
  const row = fakeNode();
  const button = fakeNode({ viewTrip: '7' });
  const itinerary = fakeNode();
  button.closest = () => row;
  const body = fakeNode();
  body.querySelector = (selector) => selector === '[data-trip-itinerary="7"]' ? itinerary : null;
  body.querySelectorAll = (selector) => selector === '[data-view-trip]' ? [button] : [];
  let failed = false;
  const render = loadFunction(automationSource, 'renderTripsManager', {
    api: { get: async (path) => {
      requests.push(path);
      if (path === '/planning/trips') return { data: [{ id: 7, name: 'Family trip', participants: [] }] };
      if (path === '/planning/admin/context') return {};
      if (failFirst && !failed) { failed = true; throw new Error('Temporary failure'); }
      return { data: { days: { '2026-09-06': { stages: [{ title: 'Depart' }], events: [], meals: [], tasks: [] } } } };
    } },
    replaceHtml: (host, html) => { host.html = html; }, managerHeader: () => '', h: esc,
  });
  return { ready: () => render(body, {}, { openTripId }), requests, button, itinerary, row };
}

test('trip deep links open the requested itinerary and retain accessible cached toggling', async () => {
  const fixture = tripFixture('7');
  await fixture.ready();
  assert.equal(fixture.requests.filter((path) => path.endsWith('/itinerary')).length, 1);
  assert.match(fixture.itinerary.html, /Depart/);
  assert.equal(fixture.button.attributes['aria-controls'], 'trip-itinerary-7');
  assert.equal(fixture.button.attributes['aria-expanded'], 'true');
  assert.equal(fixture.button.focused, true);
  assert.equal(fixture.row.scrolled, true);
  await fixture.button.listeners.click();
  assert.equal(fixture.itinerary.hidden, true);
  assert.equal(fixture.button.attributes['aria-expanded'], 'false');
  await fixture.button.listeners.click();
  assert.equal(fixture.itinerary.hidden, false);
  assert.equal(fixture.requests.filter((path) => path.endsWith('/itinerary')).length, 1);
});

test('invalid or missing trip targets do not open an unrelated itinerary', async () => {
  for (const target of [null, 'invalid', '8', '-7', '7.5']) {
    const fixture = tripFixture(target);
    await fixture.ready();
    assert.equal(fixture.requests.some((path) => path.endsWith('/itinerary')), false);
    assert.equal(fixture.itinerary.hidden, true);
  }
});

test('failed itinerary loads can be retried without leaving the previous error behind', async () => {
  const fixture = tripFixture('7', true);
  await fixture.ready();
  assert.equal(fixture.itinerary.textContent, 'Temporary failure');
  assert.equal(fixture.button.disabled, false);
  await fixture.button.listeners.click();
  assert.equal(fixture.itinerary.textContent, '');
  assert.match(fixture.itinerary.html, /Depart/);
});

function taskSaveFixture(failurePath, { initialError = new Error('Ancillary save failed'), invalidResponse = false, failUpdate = false, laterErrors = [] } = {}) {
  const calls = [];
  const fields = {
    '#task-id': { value: '' }, '#task-form-error': {}, '#task-submit-btn': {},
    '#reminder-toggle': { checked: failurePath === '/reminders' },
    '#reminder-offset': { value: 'offset_1d' },
  };
  const form = { querySelector: (selector) => fields[selector] || null };
  for (const [key, value] of Object.entries({ title: 'Test task', description: '', priority: 'none', category: 'misc', due_date: '2026-09-08' })) {
    form[key] = { value };
  }
  let failed = false;
  let updateFailed = false;
  const request = async (method, path, body, options) => {
    calls.push([method, path, structuredClone(body), structuredClone(options)]);
    if (path === failurePath && !failed) {
      failed = true;
      if (invalidResponse) return null;
      throw initialError;
    }
    if (path === failurePath && laterErrors.length) throw laterErrors.shift();
    if (failUpdate && method === 'PUT' && path === '/tasks/42' && !updateFailed) {
      updateFailed = true;
      throw new Error('Update failed');
    }
    return method === 'POST' && path === '/tasks' ? { data: { id: 42 } } : {};
  };
  const api = {
    post: (path, body, options) => request('POST', path, body, options),
    put: (path, body) => request('PUT', path, body),
    delete: (path) => request('DELETE', path),
  };
  const taskFormControls = new WeakMap();
  const taskCreateAttempts = new WeakMap();
  const saveTaskRecord = loadFunction(taskSource, 'saveTaskRecord', { api, t: (key) => key, taskFormControls, taskCreateAttempts, taskRevision });
  const permittedTaskBody = loadFunction(taskSource, 'permittedTaskBody', { canTask: () => true });
  const applyTaskFormPermissions = loadFunction(taskSource, 'applyTaskFormPermissions', { canTask: () => true, canCapability: () => true });
  const save = loadFunction(taskSource, 'handleFormSubmit', {
    document: { getElementById: (id) => fields[`#${id}`] },
    api, saveTaskRecord, taskFormControls, taskCreateAttempts, permittedTaskBody, applyTaskFormPermissions, taskRevision,
    validateAll: () => true, t: (key) => key,
    parseDateInput: (value) => value, isDateInputValid: () => true,
    getRRuleValues: () => ({ valid_until: true }), normalizeTagList: () => [], modalTags: [],
    getRotationUserIds: () => [], getSelectedUserIds: () => [], readTaskLocation: () => null,
    parseTimeInput: (value) => value,
    taskDocuments: { commit: async () => [9] },
    window: { yuvomi: { showToast() {} } }, refreshReminders() {}, refreshTags: async () => {},
    btnError() {}, btnSuccess() {}, closeModal() {}, setTimeout() {}, console: { error() {} },
  });
  return { form, fields, calls, save: () => save({ target: form, preventDefault() {} }, { onChanged: async () => {} }) };
}

for (const failurePath of ['/reminders', '/tasks/42/documents']) {
  test(`new Task retry after ${failurePath} failure updates the original Task`, async () => {
    const fixture = taskSaveFixture(failurePath);
    await fixture.save();
    assert.equal(Number(fixture.fields['#task-id'].value), 42);
    assert.equal(fixture.fields['#task-submit-btn'].disabled, false);
    assert.equal(fixture.fields['#task-form-error'].hidden, false);
    await fixture.save();
    assert.equal(fixture.calls.filter(([method, path]) => method === 'POST' && path === '/tasks').length, 1);
    assert.ok(fixture.calls.some(([method, path]) => method === 'PUT' && path === '/tasks/42'));
    assert.equal(fixture.calls.filter(([, path]) => path === failurePath).length, 2);
  });
}

for (const [label, options] of [
  ['lost response', {}],
  ['invalid success response', { invalidResponse: true }],
  ['server failure', { initialError: Object.assign(new Error('Unavailable'), { status: 500 }) }],
  ['in-progress conflict', { initialError: Object.assign(new Error('In progress'), { status: 409 }) }],
]) {
  test(`Task create retries retain their request identity after ${label}`, async () => {
    const fixture = taskSaveFixture('/tasks', options);
    await fixture.save();
    assert.equal(fixture.fields['#task-id'].value, '');
    assert.equal(fixture.fields['#task-submit-btn'].disabled, false);
    await fixture.save();
    const creates = fixture.calls.filter(([method, path]) => method === 'POST' && path === '/tasks');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[1], creates[0], 'retry sends the original payload and same key');
    assert.ok(creates[0][3].headers['Idempotency-Key']);
    assert.equal(Number(fixture.fields['#task-id'].value), 42);
    assert.equal(fixture.calls.some(([method, path]) => method === 'PUT' && path === '/tasks/42'), false);
    assert.equal(fixture.calls.some(([, path, , options]) => path !== '/tasks' && options?.headers?.['Idempotency-Key']), false);
  });
}

test('Task edits after a lost create response recover the original ID before updating, including update failure', async () => {
  const fixture = taskSaveFixture('/tasks', { failUpdate: true });
  await fixture.save();
  fixture.form.title.value = 'Revised task';
  await fixture.save();
  const creates = fixture.calls.filter(([method, path]) => method === 'POST' && path === '/tasks');
  assert.deepEqual(creates[1], creates[0]);
  assert.equal(creates[0][2].title, 'Test task');
  assert.equal(Number(fixture.fields['#task-id'].value), 42, 'ID survives failed follow-up edit');
  assert.equal(fixture.fields['#task-submit-btn'].disabled, false);
  await fixture.save();
  assert.equal(fixture.calls.filter(([method, path]) => method === 'POST' && path === '/tasks').length, 2);
  const updates = fixture.calls.filter(([method, path]) => method === 'PUT' && path === '/tasks/42');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(([, , body]) => body.title === 'Revised task'));
});

for (const status of [400, 403, 429]) {
  test(`an initial HTTP ${status} rejection allows corrected Task input with a new create request`, async () => {
    const fixture = taskSaveFixture('/tasks', { initialError: Object.assign(new Error('Request rejected'), { status }) });
    await fixture.save();
    fixture.form.title.value = 'Corrected task';
    await fixture.save();
    const creates = fixture.calls.filter(([method, path]) => method === 'POST' && path === '/tasks');
    assert.notEqual(creates[0][3].headers['Idempotency-Key'], creates[1][3].headers['Idempotency-Key']);
    assert.equal(creates[1][2].title, 'Corrected task');
  });
}

for (const status of [400, 401, 403, 429]) {
  test(`a later HTTP ${status} cannot discard a Task create identity after response loss`, async () => {
    const fixture = taskSaveFixture('/tasks', { laterErrors: [Object.assign(new Error('Retry rejected'), { status })] });
    await fixture.save();
    await fixture.save();
    await fixture.save();
    const creates = fixture.calls.filter(([method, path]) => method === 'POST' && path === '/tasks');
    assert.equal(creates.length, 3);
    assert.deepEqual(creates[1], creates[0]);
    assert.deepEqual(creates[2], creates[0]);
    assert.equal(Number(fixture.fields['#task-id'].value), 42);
  });
}

test('separate Task forms use separate create identities', async () => {
  const first = taskSaveFixture();
  const second = taskSaveFixture();
  await first.save();
  await second.save();
  assert.notEqual(first.calls[0][3].headers['Idempotency-Key'], second.calls[0][3].headers['Idempotency-Key']);
});

test('activity reassignment closes and refreshes after success, and recovers after async failure', async () => {
  const start = taskSource.indexOf("  panel.querySelector('[data-activity-reassign-submit]')");
  const listener = taskSource.slice(start, taskSource.indexOf('\n  });', start) + '\n  });'.length);
  assert.ok(start >= 0);
  for (const fail of [false, true]) {
    const button = fakeNode({ taskId: '42' });
    const panel = { querySelector: (selector) => selector === '[data-activity-reassign-submit]' ? button : { value: '3' } };
    const event = { currentTarget: button };
    const actions = [];
    new Function('panel', 'api', 'window', 'closeModal', 'onChanged', 'taskRevision', 'task', listener)(
      panel,
      { put: async (path, body) => { assert.equal(path, '/automation/tasks/42/assignment'); assert.deepEqual(body, {user_id:3, expected_revision:7}); event.currentTarget = null; if (fail) throw new Error('Cannot reassign'); } },
      { yuvomi: { showToast: (message) => actions.push(message) } },
      async () => actions.push('closed'), async () => actions.push('refreshed'),
      taskRevision, {id:42, revision:7},
    );
    await button.listeners.click(event);
    if (fail) {
      assert.equal(button.disabled, false);
      assert.deepEqual(actions, ['Cannot reassign']);
    } else assert.deepEqual(actions, ['Assignment updated.', 'closed', 'refreshed']);
  }
});

test('assignment request responses use the shared close action and refresh Tasks', async () => {
  for (const action of ['accept', 'decline']) {
    const button = fakeNode({ requestAction: action });
    button.closest = () => ({ dataset: { assignmentRequest: '9' } });
    const trigger = fakeNode();
    const actions = [];
    let reads = 0;
    const wire = loadFunction(taskSource, 'wireAssignmentRequestsBtn', {
      taskRevision,
      state: { assignmentRequests: [{ id: 9, task_title: 'Laundry', status: 'pending' }] }, esc,
      openSharedModal: ({ onSave }) => onSave({ querySelectorAll: () => [button] }),
      api: { post: async (path, body) => { assert.equal(path, '/automation/obligations/9/respond'); assert.deepEqual(body, {action, expected_revision:8, expected_parent_revision:5}); actions.push(action); },
        get: async () => ({ data: reads++ === 0 ? [{ id:9, task_title:'Laundry', status:'pending', task_revision:8, task_parent_revision:5 }] : [] }) },
      closeModal: async () => actions.push('closed'), loadTasks: async () => actions.push('refreshed'),
      window: { yuvomi: { showToast: (message) => actions.push(message) } },
    });
    wire({ querySelector: () => trigger });
    await trigger.listeners.click();
    await button.listeners.click();
    assert.deepEqual(actions, [action, 'closed', 'refreshed', action === 'accept' ? 'Assignment accepted.' : 'Assignment declined.']);
  }
});
