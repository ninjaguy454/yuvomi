import test from 'node:test';
import assert from 'node:assert/strict';
import { setDisplayTimeZone } from '../public/utils/timezone.js';
import { taskCountdown, taskCountdownDeadline, bindTaskCountdowns, renderTaskCountdown } from '../public/utils/task-countdown.js';

const task = (patch = {}) => ({ countdown: 1, status: 'open', due_date: '2026-10-06', due_time: '14:30', ...patch });
test.afterEach(() => setDisplayTimeZone(null));

test('timed countdown uses the household clock and retains the absolute due date/time', () => {
  setDisplayTimeZone('Pacific/Honolulu');
  const value = taskCountdown(task(), new Date('2026-10-06T22:00:00Z'));
  assert.equal(value.minutes, 150);
  assert.match(value.duration, /2.*30/);
  assert.equal(value.overdue, false);
  assert.match(value.absolute, /2026-10-06.*14:30/);
});
test('disabled, missing and invalid dates and terminal tasks do not count down', () => {
  for (const patch of [{ countdown: 0 }, { countdown: '0' }, { due_date: null },
    { due_date: 'invalid' }, { due_date: '2026-02-30' }, { due_time: '25:00' },
    { status: 'done' }, { status: 'expired' }, { expired_at: '2026-10-05' }, { archived_at: '2026-10-05' }]) {
    assert.equal(taskCountdown(task(patch)), null, JSON.stringify(patch));
  }
});
test('date-only deadlines count calendar days through DST without inventing a due time', () => {
  setDisplayTimeZone('America/New_York');
  const dateOnly = task({ due_date: '2026-03-09', due_time: null });
  const value = taskCountdown(dateOnly, new Date('2026-03-08T05:00:00Z'));
  assert.equal(value.days, 1);
  assert.equal(value.absolute, '2026-03-09');
  assert.equal(taskCountdown(dateOnly, new Date('2026-03-09T23:59:59Z')).overdue, false);
  assert.equal(taskCountdown(dateOnly, new Date('2026-03-10T04:00:00Z')).overdue, true);
});
test('timed deadlines agree with the canonical gap-forward and first-fold policy', () => {
  setDisplayTimeZone('America/New_York');
  for (const [date, time, expected] of [['2026-03-08', '02:30', '2026-03-08T07:30:00Z'],
    ['2026-11-01', '01:30', '2026-11-01T05:30:00Z'], ['2026-03-08', '04:30', '2026-03-08T08:30:00Z']]) {
    assert.equal(taskCountdownDeadline(task({ due_date: date, due_time: time })), Date.parse(expected));
  }
  assert.equal(taskCountdown(task({ due_date: '2026-03-08', due_time: '03:30' }), new Date('2026-03-08T06:30:00Z')).minutes, 60);
});
test('the countdown crosses its deadline without changing task status', () => {
  setDisplayTimeZone('UTC');
  const row = task();
  assert.equal(taskCountdown(row, new Date('2026-10-06T14:29:59Z')).minutes, 1);
  assert.equal(taskCountdown(row, new Date('2026-10-06T14:30:00Z')).minutes, 0);
  assert.equal(taskCountdown(row, new Date('2026-10-06T14:31:00Z')).overdue, true);
  assert.equal(row.status, 'open');
});
test('month chips can show one compact unit while retaining the full accessible countdown', context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T12:00:00Z') });
  setDisplayTimeZone('UTC');
  const html = renderTaskCountdown(task(), { compact: true });
  assert.match(html, /data-countdown-compact="true"/);
  assert.match(html, />2h<\/span>/);
  assert.match(html, /aria-label="[^"]*30[^"]*14:30/);
});
test('one mounted timer updates text, pauses hidden, resumes immediately and disposes', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-06T14:00:00Z') });
  setDisplayTimeZone('UTC');
  const doc = new EventTarget();
  doc.hidden = false;
  doc.defaultView = new EventTarget();
  const classes = new Set();
  const span = { dataset: { dueDate: '2026-10-06', dueTime: '14:30' }, textContent: '',
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    setAttribute() {} };
  const root = { ownerDocument: doc, querySelectorAll: () => [span] };
  const dispose = bindTaskCountdowns(root);
  const first = span.textContent;
  context.mock.timers.tick(60_000);
  assert.notEqual(span.textContent, first);
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  const hidden = span.textContent;
  context.mock.timers.tick(120_000);
  assert.equal(span.textContent, hidden);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  assert.notEqual(span.textContent, hidden);
  context.mock.timers.setTime(Date.parse('2026-10-06T15:00:00Z'));
  doc.defaultView.dispatchEvent(new Event('pageshow'));
  assert.ok(classes.has('task-countdown--overdue'));
  dispose(); const stopped = span.textContent;
  context.mock.timers.tick(120_000);
  doc.defaultView.dispatchEvent(new Event('focus'));
  assert.equal(span.textContent, stopped);
});
