import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMonthYearPicker, dateInSelectedMonth } from '../public/components/month-year-picker.js';
import { __test as calendar } from '../public/pages/calendar.js';

test('shared month picker retains Tasks data hooks and marks only the selected month', () => {
  const html = renderMonthYearPicker(2026, '2026-09-08', 'task-calendar');
  assert.equal((html.match(/data-task-calendar-month=/g) || []).length, 12);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /data-task-calendar-month="9" data-task-calendar-year="2026" aria-pressed="true"/);
  assert.match(html, /data-task-calendar-picker-year="-1"/);
  assert.match(html, /data-task-calendar-picker-year="1"/);
});

test('browsing another year does not falsely select the same month', () => {
  assert.doesNotMatch(renderMonthYearPicker(2027, '2026-09-08', 'cal'), /aria-pressed="true"/);
});

test('year navigation stops at valid four digit date boundaries', () => {
  assert.match(renderMonthYearPicker(1, '0001-01-01'), /data-month-year-picker-year="-1"[^>]+ disabled/);
  assert.match(renderMonthYearPicker(9999, '9999-01-01'), /data-month-year-picker-year="1"[^>]+ disabled/);
});

test('selected month clamps a long day to February and honors leap years', () => {
  assert.equal(dateInSelectedMonth('2026-01-31', 2026, 2), '2026-02-28');
  assert.equal(dateInSelectedMonth('2026-01-31', 2028, 2), '2028-02-29');
  assert.equal(dateInSelectedMonth('2026-01-15', 2028, 2), '2028-02-15');
});

test('invalid month and year selections do not create invalid date cursors', () => {
  for (const [year, month] of [[0, 1], [10000, 1], [2026, 0], [2026, 13], [2026, 1.5]]) {
    assert.equal(dateInSelectedMonth('2026-01-31', year, month), null);
  }
});

test('Calendar month view starts at first day while day, week and agenda retain a valid day', () => {
  assert.equal(calendar.selectedCalendarMonthDate('2026-01-31', 2028, 2, 'month'), '2028-02-01');
  for (const view of ['day', 'week', 'agenda']) {
    assert.equal(calendar.selectedCalendarMonthDate('2026-01-31', 2028, 2, view), '2028-02-29');
  }
});
