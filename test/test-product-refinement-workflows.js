import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esc } from '../public/utils/html.js';

const taskSource = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8').replace(/\r/g, '');
const automationSource = readFileSync(new URL('../public/components/activity-automation.js', import.meta.url), 'utf8').replace(/\r/g, '');

// Run the production functions with controlled browser boundaries. No live
// account, server, or database is involved in failure/retry tests.
function loadFunction(source, name, bindings, prefix = '') {
  const declaration = source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(declaration, `Missing production function ${name}`);
  return new Function(...Object.keys(bindings), `${prefix}\nreturn (${declaration.replace(/^export /, '')});`)(...Object.values(bindings));
}

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

function taskSaveFixture(failurePath) {
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
  const request = async (method, path) => {
    calls.push([method, path]);
    if (path === failurePath && !failed) { failed = true; throw new Error('Ancillary save failed'); }
    return method === 'POST' && path === '/tasks' ? { data: { id: 42 } } : {};
  };
  const save = loadFunction(taskSource, 'handleFormSubmit', {
    document: { getElementById: (id) => fields[`#${id}`] },
    api: { post: (path) => request('POST', path), put: (path) => request('PUT', path), delete: (path) => request('DELETE', path) },
    validateAll: () => true, t: (key) => key,
    parseDateInput: (value) => value, isDateInputValid: () => true,
    getRRuleValues: () => ({ valid_until: true }), normalizeTagList: () => [], modalTags: [],
    getRotationUserIds: () => [], getSelectedUserIds: () => [], readTaskLocation: () => null,
    parseTimeInput: (value) => value,
    taskDocuments: { commit: async () => [9] },
    window: { yuvomi: { showToast() {} } }, refreshReminders() {}, refreshTags: async () => {},
    btnError() {}, btnSuccess() {}, closeModal() {}, setTimeout() {}, console: { error() {} },
  });
  return { fields, calls, save: () => save({ target: form, preventDefault() {} }, { onChanged: async () => {} }) };
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

test('activity reassignment closes and refreshes after success, and recovers after async failure', async () => {
  const start = taskSource.indexOf("  panel.querySelector('[data-activity-reassign-submit]')");
  const listener = taskSource.slice(start, taskSource.indexOf('\n  });', start) + '\n  });'.length);
  assert.ok(start >= 0);
  for (const fail of [false, true]) {
    const button = fakeNode({ taskId: '42' });
    const panel = { querySelector: (selector) => selector === '[data-activity-reassign-submit]' ? button : { value: '3' } };
    const event = { currentTarget: button };
    const actions = [];
    new Function('panel', 'api', 'window', 'closeModal', 'onChanged', listener)(
      panel,
      { put: async () => { event.currentTarget = null; if (fail) throw new Error('Cannot reassign'); } },
      { yuvomi: { showToast: (message) => actions.push(message) } },
      async () => actions.push('closed'), async () => actions.push('refreshed'),
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
    const wire = loadFunction(taskSource, 'wireAssignmentRequestsBtn', {
      state: { assignmentRequests: [{ id: 9, task_title: 'Laundry', status: 'pending' }] }, esc,
      openSharedModal: ({ onSave }) => onSave({ querySelectorAll: () => [button] }),
      api: { post: async () => actions.push(action), get: async () => ({ data: [] }) },
      closeModal: async () => actions.push('closed'), loadTasks: async () => actions.push('refreshed'),
      window: { yuvomi: { showToast: (message) => actions.push(message) } },
    });
    wire({ querySelector: () => trigger });
    trigger.listeners.click();
    await button.listeners.click();
    assert.deepEqual(actions, [action, 'closed', 'refreshed', action === 'accept' ? 'Assignment accepted.' : 'Assignment declined.']);
  }
});
