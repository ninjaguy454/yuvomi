import test from 'node:test';
import assert from 'node:assert/strict';
import { routineEntriesOnDay, routineSegmentTimeLabel } from '../public/utils/availability-calendar.js';

const date = '2026-09-11';
const next = '2026-09-12';
function occurrence(start = '08:00', end = '16:00', extra = {}) {
  return {
    date_key: date, user_id: 1, pattern_id: 7, is_configured: true,
    shift_type: { id: 4, name: 'Work', start_time: start, end_time: end },
    ...extra,
  };
}
function bounds(entry) {
  return [entry.segment_start_minutes, entry.segment_end_minutes];
}

test('a normal shift projects only its actual hours on its starting date', () => {
  const entry = occurrence();
  const [segment] = routineEntriesOnDay([entry], date);
  assert.deepEqual(bounds(segment), [480, 960]);
  assert.equal(routineSegmentTimeLabel(segment), '08:00–16:00');
  assert.equal(segment.continues_from_previous, false);
  assert.equal(segment.continues_to_next, false);
  assert.deepEqual(routineEntriesOnDay([entry], next), []);
});

test('overnight shifts have actual first-day and following-day portions', () => {
  const entry = occurrence('22:00', '06:00');
  const [first] = routineEntriesOnDay([entry], date);
  const [continuation] = routineEntriesOnDay([entry], next);
  assert.deepEqual(bounds(first), [1320, 1440]);
  assert.deepEqual(bounds(continuation), [0, 360]);
  assert.equal(first.continues_to_next, true);
  assert.equal(continuation.continues_from_previous, true);
  assert.equal(continuation.continues_to_next, false);
  assert.equal(continuation.date_key, date);
  assert.equal(continuation.display_date_key, next);
  assert.equal(routineSegmentTimeLabel(first), '22:00–24:00');
  assert.equal(routineSegmentTimeLabel(continuation), '00:00–06:00');
});

test('a single-day view can display only the prior day overnight continuation', () => {
  const previous = occurrence('22:00', '06:00', { date_key: '2026-09-10' });
  const tooOld = occurrence('22:00', '06:00', { date_key: '2026-09-09' });
  const [segment] = routineEntriesOnDay([tooOld, previous], date);
  assert.deepEqual(bounds(segment), [0, 360]);
  assert.equal(segment.date_key, '2026-09-10');
  assert.equal(routineEntriesOnDay([tooOld, previous], date).length, 1);
});

test('equal non-midnight times represent exactly 24 hours split at midnight', () => {
  const entry = occurrence('08:00', '08:00');
  const [first] = routineEntriesOnDay([entry], date);
  const [second] = routineEntriesOnDay([entry], next);
  assert.deepEqual(bounds(first), [480, 1440]);
  assert.deepEqual(bounds(second), [0, 480]);
  assert.equal(first.segment_end_minutes - first.segment_start_minutes + second.segment_end_minutes, 1440);
});

test('midnight-to-midnight is one full day with no empty next-day fragment', () => {
  const entry = occurrence('00:00', '00:00');
  const [first] = routineEntriesOnDay([entry], date);
  assert.deepEqual(bounds(first), [0, 1440]);
  assert.equal(first.continues_to_next, false);
  assert.deepEqual(routineEntriesOnDay([entry], next), []);
});

test('a shift ending exactly at midnight does not occupy the next date', () => {
  const entry = occurrence('16:00', '00:00');
  assert.deepEqual(bounds(routineEntriesOnDay([entry], date)[0]), [960, 1440]);
  assert.deepEqual(routineEntriesOnDay([entry], next), []);
});

test('short overnight shifts keep precise bounds without an artificial minimum duration', () => {
  const entry = occurrence('23:55', '00:05');
  assert.deepEqual(bounds(routineEntriesOnDay([entry], date)[0]), [1435, 1440]);
  assert.deepEqual(bounds(routineEntriesOnDay([entry], next)[0]), [0, 5]);
});

test('untimed shifts retain one all-day label on their starting day', () => {
  const entry = occurrence(null, null);
  const [segment] = routineEntriesOnDay([entry], date);
  assert.deepEqual(bounds(segment), [0, 1440]);
  assert.equal(routineSegmentTimeLabel(segment), '');
  assert.deepEqual(routineEntriesOnDay([entry], next), []);
});

test('unconfigured and day-off entries never manufacture shift or free-day overlays', () => {
  assert.deepEqual(routineEntriesOnDay([
    occurrence(null, null, { shift_type: null, is_configured: false }),
    occurrence(null, null, { shift_type: null }),
    occurrence('08:00', '16:00', { is_configured: false }),
  ], date), []);
});

test('a day off cancels its own starting shift, not the previous overnight portion', () => {
  const entry = occurrence('22:00', '06:00');
  const dayOff = occurrence(null, null, { date_key: next, shift_type: null, source: 'override' });
  const projected = routineEntriesOnDay([entry, dayOff], next);
  assert.equal(projected.length, 1);
  assert.deepEqual(bounds(projected[0]), [0, 360]);
});

test('adjacent overnight occurrences remain distinct and raw inputs remain unchanged', () => {
  const first = occurrence('22:00', '06:00');
  const second = occurrence('22:00', '06:00', { date_key: next });
  Object.freeze(first.shift_type);
  Object.freeze(first);
  const entries = Object.freeze([first, second]);
  const before = JSON.stringify(entries);
  const segments = routineEntriesOnDay(entries, next);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(bounds), [[0, 360], [1320, 1440]]);
  assert.deepEqual(segments.map((segment) => segment.date_key), [date, next]);
  assert.equal(JSON.stringify(entries), before);
});

test('calendar date arithmetic crosses month, leap-day and year boundaries', () => {
  for (const [startDate, followingDate] of [
    ['2026-09-30', '2026-10-01'], ['2028-02-29', '2028-03-01'], ['2026-12-31', '2027-01-01'],
  ]) {
    const [segment] = routineEntriesOnDay([occurrence('22:00', '06:00', { date_key: startDate })], followingDate);
    assert.equal(segment.date_key, startDate);
    assert.deepEqual(bounds(segment), [0, 360]);
  }
});
