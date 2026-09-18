import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, calendarDayOffset, normalizeActivityDueOffset } from '../public/utils/activity-schedule.js';

test('relative dates use calendar days across both DST changes, month ends and leap years', () => {
  for (const [start, offset, due] of [
    ['2026-03-06', 4, '2026-03-10'], ['2026-10-30', 4, '2026-11-03'],
    ['2026-09-21', 0, '2026-09-21'], ['2026-09-21', 4, '2026-09-25'],
    ['2028-02-28', 2, '2028-03-01'], ['2026-12-31', 1, '2027-01-01'],
  ]) {
    assert.equal(addCalendarDays(start, offset), due);
    assert.equal(calendarDayOffset(start, due), offset);
  }
});

test('missing or invalid concrete dates cannot invent a reusable offset', () => {
  for (const [start, due] of [[null, '2026-09-25'], ['2026-09-21', null], ['2026-02-30', '2026-03-02'], ['2026-09-25', '2026-09-21']]) {
    assert.equal(calendarDayOffset(start, due), null);
  }
  for (const [start, offset] of [[null, 0], ['2026-02-30', 0], ['2026-09-21', null], ['2026-09-21', -1], ['2026-09-21', 0.5], ['9999-12-31', 1]]) {
    assert.equal(addCalendarDays(start, offset), null);
  }
});

test('reusable offset accepts only a sensible non-negative integer or unspecified value', () => {
  for (const value of [null, undefined]) assert.equal(normalizeActivityDueOffset(value), null);
  for (const value of [0, 1, 4, 8, 3650, '4']) assert.equal(normalizeActivityDueOffset(value), Number(value));
  for (const value of [-1, 0.5, 3651, '', '1.5', 'one', true, false, [], {}, NaN, Infinity]) {
    assert.throws(() => normalizeActivityDueOffset(value), /whole number from 0 to 3650/);
  }
});
