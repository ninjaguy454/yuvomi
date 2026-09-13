import assert from 'node:assert/strict';
import test from 'node:test';
import { householdTimeZone, isValidTimeZone, localToUTC, utcToWall } from '../server/utils/timezone.js';

test('reused formatters convert each instant independently across both DST transitions', () => {
  const zone = 'America/New_York';
  for (let repeat = 0; repeat < 3; repeat++) {
    assert.deepEqual(utcToWall('2026-03-08T06:59:00Z', zone), {date:'2026-03-08', time:'01:59:00'});
    assert.deepEqual(utcToWall('2026-03-08T07:00:00Z', zone), {date:'2026-03-08', time:'03:00:00'});
    assert.deepEqual(utcToWall('2026-11-01T05:30:00Z', zone), {date:'2026-11-01', time:'01:30:00'});
    assert.deepEqual(utcToWall('2026-11-01T06:30:00Z', zone), {date:'2026-11-01', time:'01:30:00'});
    assert.equal(localToUTC('2026-01-24T12:24:24', zone), '2026-01-24T17:24:24Z');
    assert.equal(localToUTC('2026-07-24T12:24:24', zone), '2026-07-24T16:24:24Z');
  }
});

test('formatter reuse does not cache household settings or a runtime default zone', () => {
  let zone = 'Asia/Tokyo';
  const database = { prepare: () => ({get: () => ({value:zone})}) };
  const instant = '2026-09-14T01:00:00Z';
  assert.equal(utcToWall(instant, householdTimeZone(database)).time, '10:00:00');
  zone = 'America/New_York';
  assert.deepEqual(utcToWall(instant, householdTimeZone(database)), {date:'2026-09-13', time:'21:00:00'});
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    assert.equal(utcToWall(instant).time, '01:00:00');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(utcToWall(instant).time, '10:00:00');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('repeated explicit-zone conversions do not repeatedly construct ICU formatters', () => {
  const original = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = new Proxy(original, {construct(target, args, newTarget) {
    constructions++;
    return Reflect.construct(target, args, newTarget);
  }});
  try {
    for (let repeat = 0; repeat < 50; repeat++) {
      assert.equal(isValidTimeZone('Pacific/Chatham'), true);
      assert.ok(utcToWall('2026-09-14T01:00:00Z', 'Pacific/Chatham'));
      assert.match(localToUTC('2026-09-14T12:00:00', 'Pacific/Chatham'), /Z$/);
    }
    assert.equal(constructions, 3, 'one constructor per exact zone/format, not per converted instant');
    assert.equal(isValidTimeZone('invalid/timezone'), false);
    assert.equal(utcToWall('2026-09-14T01:00:00Z', 'invalid/timezone'), null);
  } finally { Intl.DateTimeFormat = original; }
});
