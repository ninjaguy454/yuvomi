// Run with node --loader ./test/test-browser-loader.mjs --test test/test-calendar-partial-load.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api } from '/api.js';
import { __test as calendar } from '../public/pages/calendar.js';

globalThis.window = { yuvomi: { isModuleDisabled: () => false } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
const from = '2026-09-06';
const to = '2026-09-12';
const event = { id: 1, title: 'Appointment', start_datetime: `${from}T12:00:00` };
const meal = { id: -1, title: 'Dinner', start_datetime: `${from}T18:00:00` };
const task = { id: 2, title: 'Laundry', due_date: from, status: 'open' };
let failures;
let calls;

test.beforeEach(() => {
  failures = new Map();
  calls = [];
  window.yuvomi.isModuleDisabled = () => false;
  api.get = async (path) => {
    calls.push(path);
    for (const [prefix, status] of failures) {
      if (path.startsWith(prefix)) throw Object.assign(new Error('Unavailable'), { status });
    }
    if (path.startsWith('/calendar?')) return { data: [event] };
    if (path.startsWith('/tasks?')) return { data: [task] };
    if (path.startsWith('/planning/')) return { data: [meal] };
    if (path.startsWith('/schedule/')) return { data: { entries: [] } };
    return { data: [] };
  };
});

test('a failed task layer retains events and identifies partial data', async () => {
  failures.set('/tasks?', 500);
  await calendar.loadRange(from, to);
  const result = calendar.calendarLoadSnapshot();
  assert.deepEqual(result.events, [event, meal]);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.failedLayers, ['tasks']);
  assert.equal(result.loadError, null);
});

test('a retry restores missing entries and clears the partial warning', async () => {
  failures.set('/planning/', 503);
  await calendar.loadRange(from, to);
  assert.deepEqual(calendar.calendarLoadSnapshot().failedLayers, ['planning']);
  failures.clear();
  await calendar.loadRange(from, to);
  assert.deepEqual(calendar.calendarLoadSnapshot().events, [event, meal]);
  assert.deepEqual(calendar.calendarLoadSnapshot().failedLayers, []);
});

test('holidays and schedule failures are visible without removing tasks', async () => {
  failures.set('/calendar/holidays?', 500);
  failures.set('/schedule/', 503);
  await calendar.loadRange(from, to);
  assert.deepEqual(calendar.calendarLoadSnapshot().failedLayers, ['holidays', 'schedule']);
  assert.deepEqual(calendar.calendarLoadSnapshot().tasks, [task]);
});

test('a denied layer is intentionally absent and does not suggest futile retries', async () => {
  failures.set('/tasks?', 403);
  await calendar.loadRange(from, to);
  assert.deepEqual(calendar.calendarLoadSnapshot().failedLayers, []);
  assert.deepEqual(calendar.calendarLoadSnapshot().events, [event, meal]);
});

test('disabled Tasks and Schedule modules make no unnecessary requests', async () => {
  window.yuvomi.isModuleDisabled = (name) => ['tasks', 'schedule'].includes(name);
  await calendar.loadRange(from, to);
  assert.equal(calls.some((path) => path.startsWith('/tasks?') || path.startsWith('/schedule/')), false);
  assert.deepEqual(calendar.calendarLoadSnapshot().failedLayers, []);
});

test('failure of the primary calendar keeps the established full-error state', async () => {
  failures.set('/calendar?', 500);
  await calendar.loadRange(from, to);
  assert.equal(calendar.calendarLoadSnapshot().loadError.status, 500);
  assert.deepEqual(calendar.calendarLoadSnapshot().events, []);
  assert.deepEqual(calendar.calendarLoadSnapshot().failedLayers, []);
});

// Exercise the production notice callback against its DOM boundaries. These
// doubles emulate native focus loss when the current button becomes disabled,
// and keep the request pending so navigation/focus changes can happen first.
const calendarSource = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
const noticeDeclaration = calendarSource.match(/^function updatePartialLoadNotice\([\s\S]*?^}/m)?.[0];
assert.ok(noticeDeclaration);

function noticeFixture({ blurOnDisable = true } = {}) {
  const document = { body: {}, activeElement: null };
  document.activeElement = document.body;
  const state = { loadError: null, failedLayers: ['tasks'], rangeFrom: from, rangeTo: to };
  const requests = [];
  let settle;
  const pending = new Promise((resolve) => { settle = resolve; });
  let notice = null;
  let retry = null;
  let renders = 0;
  let update;
  const page = {
    isConnected: true,
    querySelector(selector) {
      if (selector === '#cal-body') return body;
      if (selector === '#cal-partial-notice') return notice;
      if (selector === '[data-calendar-retry]') return retry;
      return null;
    },
  };
  const body = {
    id: 'cal-body', attributes: {}, focusCount: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focusCount += 1; document.activeElement = this; },
    insertAdjacentHTML() {
      const button = {
        connected: true, listeners: [], _disabled: false, focusCount: 0,
        get isConnected() { return this.connected && page.isConnected; },
        get disabled() { return this._disabled; },
        set disabled(value) {
          this._disabled = value;
          if (value && blurOnDisable && document.activeElement === this) document.activeElement = document.body;
        },
        addEventListener(name, handler) { if (name === 'click') this.listeners.push(handler); },
        focus() { this.focusCount += 1; document.activeElement = this; },
      };
      retry = button;
      notice = {
        remove() {
          button.connected = false;
          if (document.activeElement === button) document.activeElement = document.body;
          notice = null;
          retry = null;
        },
      };
    },
  };
  update = new Function('_container', 'state', 'loadRange', 'renderView', 'document', 'esc', 't',
    `return (${noticeDeclaration});`)(
    { querySelector: () => page }, state,
    async (start, end) => { requests.push([start, end]); await pending; },
    () => { renders += 1; update(); }, document, (value) => value, (value) => value,
  );
  update();
  return {
    document, page, body, state, requests,
    retry: () => retry,
    renders: () => renders,
    settle: ({ failed = true } = {}) => { state.failedLayers = failed ? ['tasks'] : []; settle(); },
    click({ focused = true } = {}) {
      const button = retry;
      if (focused) button.focus();
      assert.equal(button.listeners.length, 1, 'the current notice owns one click listener');
      return button.listeners[0]({ currentTarget: button });
    },
  };
}

test('a failed partial retry focuses its replacement button even after native disabled blur', async () => {
  for (const blurOnDisable of [true, false]) {
    const fixture = noticeFixture({ blurOnDisable });
    const original = fixture.retry();
    const clicked = fixture.click();
    assert.equal(original.disabled, true);
    fixture.settle();
    await clicked;
    assert.notEqual(fixture.retry(), original);
    assert.equal(fixture.document.activeElement, fixture.retry());
    assert.equal(fixture.retry().listeners.length, 1);
    assert.deepEqual(fixture.requests, [[from, to]]);
    assert.equal(fixture.renders(), 1);
  }
});

test('a recovered partial retry focuses the Calendar body after removing the notice', async () => {
  const fixture = noticeFixture();
  const clicked = fixture.click();
  fixture.settle({ failed: false });
  await clicked;
  assert.equal(fixture.retry(), null);
  assert.equal(fixture.document.activeElement, fixture.body);
  assert.equal(fixture.body.attributes.tabindex, '-1');
});

test('partial retry preserves focus moved elsewhere and never claims initially absent focus', async () => {
  for (const failed of [true, false]) {
    const fixture = noticeFixture();
    const clicked = fixture.click();
    const otherControl = {};
    fixture.document.activeElement = otherControl;
    fixture.settle({ failed });
    await clicked;
    assert.equal(fixture.document.activeElement, otherControl);
    assert.equal(fixture.body.focusCount, 0);
  }
  const unfocused = noticeFixture();
  const clicked = unfocused.click({ focused: false });
  unfocused.settle({ failed: false });
  await clicked;
  assert.equal(unfocused.document.activeElement, unfocused.document.body);
});

test('partial retry does not render or restore focus after its Calendar page disconnects', async () => {
  const fixture = noticeFixture();
  const original = fixture.retry();
  const clicked = fixture.click();
  fixture.page.isConnected = false;
  fixture.settle({ failed: false });
  await clicked;
  assert.equal(fixture.renders(), 0);
  assert.equal(fixture.retry(), original);
  assert.equal(fixture.body.focusCount, 0);
  assert.equal(fixture.document.activeElement, fixture.document.body);
});
