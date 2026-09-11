import test from 'node:test';
import assert from 'node:assert/strict';
import { displayTimeZone, setDisplayTimeZone, zonedFields } from '../public/utils/timezone.js';

test('resolver timezone converts instants without changing the saved display preference', () => {
  setDisplayTimeZone('Europe/London');
  assert.deepEqual(zonedFields('2026-09-08T04:00:00Z', 'America/New_York'), { year: 2026, month: 9, day: 8, hour: 0, minute: 0, second: 0 });
  assert.equal(zonedFields('2026-09-08T10:00:00Z', 'America/New_York').hour, 6);
  assert.equal(displayTimeZone(), 'Europe/London');
  assert.equal(zonedFields('2026-09-08T10:00:00Z').hour, 11);
  setDisplayTimeZone(null);
});

test('resolver timezone override leaves household wall-clock inputs unchanged and follows DST', () => {
  assert.equal(zonedFields('2026-09-08T08:00:00', 'America/New_York').hour, 8);
  assert.equal(zonedFields('2026-11-01T05:30:00Z', 'America/New_York').hour, 1);
  assert.equal(zonedFields('2026-11-01T06:30:00Z', 'America/New_York').hour, 1);
});
