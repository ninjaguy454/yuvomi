import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';

assert.equal(process.env.DB_PATH, ':memory:', 'Run lifecycle adversarial tests with DB_PATH=:memory:.');
const { get } = await import('../server/db.js');
const { default: scheduleRouter } = await import('../server/routes/schedule.js');
const { cyclePosition, dateKeysInRange, scheduleData } = await import('../server/services/schedule.js');
const { evaluateAvailability } = await import('../server/services/presence.js');
const { routineEntriesOnDay } = await import('../public/utils/availability-calendar.js');
const d = get();
const insertUser = d.prepare('INSERT INTO users(username,display_name,password_hash,role) VALUES (?,?,?,?)');
const owner = Number(insertUser.run('lifecycle-owner', 'Lifecycle Owner', 'x', 'member').lastInsertRowid);
const other = Number(insertUser.run('lifecycle-other', 'Lifecycle Other', 'x', 'member').lastInsertRowid);
const admin = Number(insertUser.run('lifecycle-admin', 'Lifecycle Admin', 'x', 'admin').lastInsertRowid);
const work = Number(d.prepare("INSERT INTO places(name,type) VALUES ('Lifecycle Workplace','work')").run().lastInsertRowid);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = Number(req.headers['x-actor-id'] || owner);
  req.authRole = req.authUserId === admin ? 'admin' : 'member';
  req.session = { userId: req.authUserId, role: req.authRole }; next();
});
app.use('/routines', scheduleRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
test.after(() => new Promise((resolve) => server.close(resolve)));
async function request(method, path, body, actor = owner) {
  const result = await fetch(`http://127.0.0.1:${server.address().port}/routines${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-actor-id': String(actor) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: result.status, data: result.status === 204 ? null : await result.json() };
}
function shift({ start = '08:00', end = '16:00', state = 'busy', creator = owner, name = 'Work' } = {}) {
  return Number(d.prepare('INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state,place_id,created_by) VALUES (?,?,?,?,?,?)')
    .run(name, start, end, state, work, creator).lastInsertRowid);
}
function pattern({ member = owner, length = 1, anchor = '2026-09-11', from = null, until = null, active = 1, days = [] } = {}) {
  const key = Number(d.prepare('INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length,valid_from,valid_until,is_active) VALUES (?,?,?,?,?,?,?)')
    .run(member, 'Lifecycle rotation', anchor, length, from, until, active).lastInsertRowid);
  for (const [position, type] of days) d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES (?,?,?)').run(key, position, type);
  return key;
}
function override(member, date, type = null) {
  return Number(d.prepare('INSERT INTO schedule_overrides(user_id,date_key,shift_type_id,note) VALUES (?,?,?,?)')
    .run(member, date, type, 'Lifecycle exception').lastInsertRowid);
}
function roster(from = '2026-09-11', to = from, userId = owner) {
  return scheduleData(d, { from, to, userId });
}
function evaluate({ userId = owner, start = '2026-09-11T09:00:00', end = '2026-09-11T10:00:00' } = {}) {
  return evaluateAvailability(d, { userId, startAt: start, endAt: end, nowAt: start, policy: 'available_before_due' });
}
function assertUnconfirmedGap(result) {
  assert.equal(result.eligible, true);
  assert.equal(result.windows[0].state, 'unknown');
  assert.equal(result.windows[0].confirmed_available, false);
  assert.match(result.reason, /unknown; no planned restriction/);
}
function assertBusy(result, name = 'Work') {
  assert.equal(result.eligible, false);
  assert.equal(result.windows[0].confirmed_available, false);
  assert.equal(result.reason, `${name}: busy.`);
}
test.beforeEach(() => {
  for (const table of ['schedule_overrides', 'schedule_patterns', 'schedule_shift_types', 'availability_periods', 'availability_rules']) d.prepare(`DELETE FROM ${table}`).run();
  d.prepare("INSERT INTO sync_config(key,value) VALUES ('household_timezone','UTC') ON CONFLICT(key) DO UPDATE SET value='UTC'").run();
});

test('anchor modulo has no start-boundary semantics and remains stable far before and after it', () => {
  for (const [length, date, expected] of [
    [1, '2024-02-29', 0], [7, '2026-09-10', 6], [7, '2026-09-18', 0],
    [8, '2026-09-02', 7], [8, '2026-09-19', 0], [14, '2026-08-28', 0],
    [14, '2026-09-25', 0], [366, '2027-09-12', 0], [366, '2027-09-13', 1],
  ]) assert.equal(cyclePosition('2026-09-11', length, date), expected, `${length}: ${date}`);
  for (const length of [0, -1, 1.5, NaN]) assert.equal(cyclePosition('2026-09-11', length, '2026-09-12'), null);
  pattern({ length: 8, days: [[7,shift()],[0,null]] });
  for (const date of ['2026-09-10','2026-09-18']) {
    assertBusy(evaluate({start:`${date}T09:00:00`,end:`${date}T10:00:00`}));
  }
  const referenceDay = evaluate();
  assertUnconfirmedGap(referenceDay);
  assert.match(referenceDay.routine_explanations[0].reason, /Day off this routine; other commitments still apply/);
});

test('invalid date keys and reversed windows do not resolve manufactured calendar days', () => {
  for (const invalid of ['2026-02-29', '2024-02-30', '2026-13-01', '2026-00-10', '2026-09-00', 'not-a-date']) {
    assert.equal(cyclePosition(invalid, 8, '2026-09-11'), null);
    assert.deepEqual(dateKeysInRange(invalid, '2026-09-11'), []);
  }
  assert.deepEqual(dateKeysInRange('2026-09-12', '2026-09-11'), []);
  assert.deepEqual(dateKeysInRange('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(dateKeysInRange('9999-12-30', '9999-12-31'), ['9999-12-30', '9999-12-31']);
});

test('HTTP creation rejects malformed dates, lengths and incomplete day payloads atomically', async () => {
  const base = { name: 'Invalid candidate', anchor_date: '2026-09-11', cycle_length: 8, user_id: owner };
  for (const patch of [
    { anchor_date: '2026-02-29' }, { valid_from: '2026-13-01' }, { valid_until: '2026-09-00' },
    { valid_from: '2026-09-12', valid_until: '2026-09-11' }, { cycle_length: 0 },
    { cycle_length: 367 }, { cycle_length: 1.5 }, { days: [{ position: 0 }] },
    { days: [{ position: 0, shift_type_id: null }, { position: 0, shift_type_id: null }] },
    { days: [{ position: 8, shift_type_id: null }] }, { days: [{ position: 0, shift_type_id: 999999 }] },
  ]) assert.equal((await request('POST', '/patterns', { ...base, ...patch })).status, 400, JSON.stringify(patch));
  assert.equal(d.prepare('SELECT count(*) n FROM schedule_patterns').get().n, 0);
  assert.equal(d.prepare('SELECT count(*) n FROM schedule_pattern_days').get().n, 0);
});

test('HTTP range limit is inclusive, and malformed/reversed dates never return broad data', async () => {
  const good = await request('GET', '/entries?from=2025-01-01&to=2027-01-01');
  assert.equal(good.status, 200);
  for (const query of [
    'from=2025-01-01&to=2027-01-02', 'from=2026-09-12&to=2026-09-11',
    'from=2026-02-29&to=2026-03-01', 'from=1000-01-01&to=9999-12-31',
  ]) assert.equal((await request('GET', `/entries?${query}`)).status, 400);
});

test('valid-from and valid-until are inclusive and independent of the anchor', () => {
  const type = shift();
  pattern({ length: 8, from: '2026-09-10', until: '2026-09-12', days: [[7, null], [0, type], [1, type]] });
  const entries = roster('2026-09-09', '2026-09-13').entries;
  assert.deepEqual(entries.map((entry) => [entry.date_key, entry.position]), [['2026-09-10', 7], ['2026-09-11', 0], ['2026-09-12', 1]]);
  assert.equal(entries[0].is_free, true);
  for (const date of ['2026-09-09','2026-09-10','2026-09-13']) {
    assertUnconfirmedGap(evaluate({start:`${date}T09:00:00`,end:`${date}T10:00:00`}));
  }
  for (const date of ['2026-09-11','2026-09-12']) {
    assertBusy(evaluate({start:`${date}T09:00:00`,end:`${date}T10:00:00`}));
  }
});

test('overlap winner uses latest validity start then ID, excluding disabled patterns', () => {
  const type = shift();
  pattern({ days: [[0, type]], from: '2026-01-01' });
  const recent = pattern({ days: [[0, null]], from: '2026-09-01' });
  const disabled = pattern({ days: [[0, type]], from: '2026-09-10', active: 0 });
  let result = roster();
  assert.equal(result.entries[0].pattern_id, recent);
  assert.equal(result.entries[0].is_free, true);
  assert.equal(result.warnings[0].pattern_ids.includes(disabled), false);
  const off = evaluate();
  assertUnconfirmedGap(off);
  assert.match(off.routine_explanations[0].reason, /other commitments still apply/);
  const newest = pattern({ days: [[0, type]], from: '2026-09-01' });
  result = roster();
  assert.equal(result.entries[0].pattern_id, newest);
  assertBusy(evaluate());
});

test('household resolution isolates each member and their dated overrides', () => {
  const type = shift();
  pattern({ member: owner, days: [[0, type]] });
  pattern({ member: other, days: [[0, type]] });
  override(owner, '2026-09-11');
  const entries = roster('2026-09-11', '2026-09-11', null).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.user_id === owner).is_free, true);
  assert.equal(entries.find((entry) => entry.user_id === other).shift_type.id, type);
  const ownerResult = evaluate({ userId: owner });
  assertUnconfirmedGap(ownerResult);
  assert.match(ownerResult.routine_explanations[0].reason, /other commitments still apply/);
  assertBusy(evaluate({ userId: other }));
});

test('numeric-string member IDs retain the same roster restrictions and explanations', () => {
  pattern({ days: [[0, shift()]] });
  assert.deepEqual(roster('2026-09-11', '2026-09-11', String(owner)), roster());
  assertBusy(evaluate({ userId: String(owner) }));
  assert.deepEqual(evaluate({ userId: String(owner) }).windows, evaluate().windows);
});

test('invalid explicitly scoped member IDs never broaden into household-wide records', () => {
  pattern({ days: [[0, shift()]] });
  for (const invalid of [0, '', '   ', false, true, -1, 'not-a-user', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(roster('2026-09-11', '2026-09-11', invalid), { entries: [], warnings: [] }, String(invalid));
  }
});

test('deactivate and reactivate immediately remove and restore restrictions without deleting definitions', async () => {
  const key = pattern({ days: [[0, shift()]] });
  const originalDay = d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=?').get(key);
  assertBusy(evaluate());
  assert.equal((await request('PUT', `/patterns/${key}`, { is_active: false })).status, 200);
  assert.deepEqual(roster().entries, []);
  assertUnconfirmedGap(evaluate());
  assert.equal((await request('PUT', `/patterns/${key}`, { is_active: true })).status, 200);
  assertBusy(evaluate());
  assert.deepEqual(d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=?').get(key), originalDay);
});

test('pattern deletion cascades its days but retains independent dated overrides', async () => {
  const type = shift();
  const key = pattern({ days: [[0, type]] });
  const exception = override(owner, '2026-09-11', type);
  const calendarCount = d.prepare('SELECT count(*) n FROM calendar_events').get().n;
  assert.equal((await request('DELETE', `/patterns/${key}`)).status, 204);
  assert.equal(d.prepare('SELECT count(*) n FROM schedule_pattern_days WHERE pattern_id=?').get(key).n, 0);
  assert.equal(roster().entries[0].override_id, exception);
  assertBusy(evaluate(), 'Lifecycle exception');
  assert.equal((await request('DELETE', '/overrides/2026-09-11')).status, 204);
  assert.deepEqual(roster().entries, []);
  assertUnconfirmedGap(evaluate());
  assert.equal(d.prepare('SELECT count(*) n FROM calendar_events').get().n, calendarCount);
});

test('editing shared shift hours/effect immediately updates projection and eligibility without rewriting days', async () => {
  const type = shift();
  const key = pattern({ days: [[0, type]] });
  const original = d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=?').get(key);
  assert.equal((await request('PUT', `/shift-types/${type}`, { name: 'Evening', start_time: '18:00', end_time: '22:00' })).status, 200);
  assertUnconfirmedGap(evaluate());
  assertBusy(evaluate({ start: '2026-09-11T19:00:00', end: '2026-09-11T20:00:00' }), 'Evening');
  assert.equal(roster().entries[0].shift_type.name, 'Evening');
  assert.equal((await request('PUT', `/shift-types/${type}`, { availability_state: 'none' })).status, 200);
  const result = evaluate({ start: '2026-09-11T19:00:00', end: '2026-09-11T20:00:00' });
  assertUnconfirmedGap(result);
  assert.match(result.routine_explanations[0].reason, /information only/);
  assert.equal(routineEntriesOnDay(roster().entries, '2026-09-11').length, 1);
  assert.deepEqual(d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=?').get(key), original);
});

test('referenced shift deletion remains blocked by inactive patterns and independent overrides', async () => {
  const type = shift();
  const key = pattern({ days: [[0, type]], active: 0 });
  override(owner, '2026-09-11', type);
  assert.equal((await request('DELETE', `/shift-types/${type}`)).status, 409);
  assert.equal((await request('DELETE', `/patterns/${key}`)).status, 204);
  assert.equal((await request('DELETE', `/shift-types/${type}`)).status, 409);
  assert.equal((await request('DELETE', '/overrides/2026-09-11')).status, 204);
  assert.equal((await request('DELETE', `/shift-types/${type}`)).status, 204);
  assert.equal((await request('DELETE', `/shift-types/${type}`)).status, 404);
});

test('deleted shift creator does not delete shared shifts or allow other members to redefine them', async () => {
  const creator = Number(insertUser.run('lifecycle-former-creator', 'Former creator', 'x', 'member').lastInsertRowid);
  const type = shift({ creator });
  pattern({ days: [[0, type]] });
  d.prepare('DELETE FROM users WHERE id=?').run(creator);
  assert.equal(roster().entries[0].shift_type.created_by, null);
  assertBusy(evaluate());
  assert.equal((await request('PUT', `/shift-types/${type}`, { availability_state: 'available' })).status, 403);
  assert.equal((await request('PUT', `/shift-types/${type}`, { availability_state: 'available' }, admin)).status, 200);
  const available = evaluate();
  assert.equal(available.eligible, true);
  assert.equal(available.windows[0].confirmed_available, true);
  assert.equal(available.reason, 'Work: explicitly available.');
});

test('unconfigured, explicit day off, and omitted-after-edit remain distinct lifecycle states', async () => {
  const key = pattern();
  assert.equal(evaluate().eligible, false);
  assert.equal(evaluate().windows[0].confirmed_available, false);
  assert.match(evaluate().reason, /not been configured/);
  assert.equal((await request('PUT', `/patterns/${key}/days`, { days: [{ position: 0, shift_type_id: null }] })).status, 200);
  assertUnconfirmedGap(evaluate());
  assert.equal(evaluate().windows[0].confirmed_available, false);
  assert.match(evaluate().routine_explanations[0].reason, /other commitments/);
  assert.equal((await request('PUT', `/patterns/${key}/days`, { days: [] })).status, 200);
  assert.equal(roster().entries[0].is_configured, false);
  assert.equal(roster().entries[0].is_free, false);
  assert.equal(evaluate().eligible, false);
  assert.equal(evaluate().windows[0].confirmed_available, false);
  assert.match(evaluate().reason, /not been configured/);
});

test('shrinking ignores preserved out-of-range day-off rows and validates replacement days before any write', async () => {
  const type = shift();
  const key = pattern({ length: 8, days: [[0, type], [3, type], [7, null]] });
  const rows = d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position').all(key);
  assert.equal((await request('PUT', `/patterns/${key}`, { name: 'Must not stick', cycle_length: 2, days: [{ position: 0, shift_type_id: 999999 }] })).status, 400);
  assert.equal(d.prepare('SELECT name FROM schedule_patterns WHERE id=?').get(key).name, 'Lifecycle rotation');
  assert.deepEqual(d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position').all(key), rows);
  assert.equal((await request('PUT', `/patterns/${key}`, { cycle_length: 2 })).status, 400);
  assert.equal((await request('PUT', `/patterns/${key}`, { cycle_length: 2, days: [{ position: 0, shift_type_id: type }] })).status, 200);
  assert.deepEqual(d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? AND position=7').get(key), rows[2]);
  const entries = roster('2026-09-11', '2026-09-18').entries;
  assert.deepEqual(entries.map((entry) => entry.position), [0, 1, 0, 1, 0, 1, 0, 1]);
  assert.equal(entries[7].is_configured, false, 'inert position 7 does not supply repeated position 1');
  const missing = evaluate({start:'2026-09-18T09:00:00',end:'2026-09-18T10:00:00'});
  assert.equal(missing.eligible, false);
  assert.equal(missing.windows[0].confirmed_available, false);
  assert.match(missing.reason, /not been configured/);
});

test('re-expanding a legacy header restores its preserved explicit day-off record', async () => {
  const key = pattern({ length: 8, days: [[0, shift()], [7, null]] });
  const saved = d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? AND position=7').get(key);
  assert.equal((await request('PUT', `/patterns/${key}`, { cycle_length: 2 })).status, 200);
  assert.equal((await request('PUT', `/patterns/${key}`, { cycle_length: 8 })).status, 200);
  assert.equal(roster('2026-09-18').entries[0].is_free, true);
  assert.deepEqual(d.prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? AND position=7').get(key), saved);
  const restored = evaluate({start:'2026-09-18T09:00:00',end:'2026-09-18T10:00:00'});
  assertUnconfirmedGap(restored);
  assert.match(restored.routine_explanations[0].reason, /other commitments still apply/);
});

test('an overnight occurrence continues beyond its final valid start date', () => {
  const type = shift({ start: '22:00', end: '06:00' });
  pattern({ from: '2026-09-11', until: '2026-09-11', days: [[0, type]] });
  const entries = roster('2026-09-11', '2026-09-12').entries;
  assert.equal(entries.length, 1);
  const continuation = routineEntriesOnDay(entries, '2026-09-12')[0];
  assert.deepEqual([continuation.segment_start_minutes, continuation.segment_end_minutes], [0, 360]);
  assertBusy(evaluate({ start: '2026-09-12T05:00:00', end: '2026-09-12T06:00:00' }));
  assertUnconfirmedGap(evaluate({ start: '2026-09-12T06:00:00', end: '2026-09-12T07:00:00' }));
});

test('day-off overrides replace only their starting occurrence, and deletion restores that night', async () => {
  const type = shift({ start: '22:00', end: '06:00' });
  pattern({ days: [[0, type]] });
  override(owner, '2026-09-12');
  assertBusy(evaluate({ start: '2026-09-12T01:00:00', end: '2026-09-12T02:00:00' }));
  const off = evaluate({ start: '2026-09-12T23:00:00', end: '2026-09-12T23:30:00' });
  assertUnconfirmedGap(off);
  assert.match(off.routine_explanations[0].reason, /other commitments still apply/);
  assert.equal((await request('DELETE', '/overrides/2026-09-12')).status, 204);
  assertBusy(evaluate({ start: '2026-09-12T23:00:00', end: '2026-09-12T23:30:00' }));
});

// Execute the existing production statistics functions without mounting the
// browser page; this verifies its actual nominal-hour arithmetic, not a copy.
const pageSource = readFileSync(new URL('../public/pages/schedule.js', import.meta.url), 'utf8');
const statisticsCode = ['shiftMinutes', 'statisticsSummary'].map((name) => {
  const declaration = pageSource.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))?.[0];
  assert.ok(declaration, `Cannot locate production ${name}`); return declaration;
}).join('\n');
const summarize = new Function('statistics', `${statisticsCode}\nreturn statisticsSummary();`);

test('planned statistics count occurrences once and retain nominal overnight hours across DST', () => {
  d.prepare("UPDATE sync_config SET value='America/New_York' WHERE key='household_timezone'").run();
  const type = shift({ start: '22:00', end: '06:00' });
  for (const date of ['2026-03-07', '2026-10-31']) override(owner, date, type);
  const entries = [...roster('2026-03-07').entries, ...roster('2026-10-31').entries];
  const stats = summarize({ entries });
  assert.equal(stats.totalCount, 2);
  assert.equal(stats.totalMinutes, 960, 'two nominal eight-hour shifts');
  for (const [start, end, expectedMinutes] of [
    ['2026-03-07T22:00:00', '2026-03-08T06:00:00', 420],
    ['2026-10-31T22:00:00', '2026-11-01T06:00:00', 540],
  ]) {
    const result = evaluate({ start, end });
    assert.equal(result.eligible, false);
    assert.equal(result.windows[0].confirmed_available, false);
    assert.match(result.reason, /Lifecycle exception: busy/);
    assert.equal((Date.parse(result.end_at) - Date.parse(result.start_at)) / 60000, expectedMinutes);
  }
  assert.equal(entries.length, 2, 'projecting continuations must not mutate statistics input');
});

test('24-hour and untimed statistics distinguish nominal hours from days without a time range', () => {
  const full = shift({ start: '08:00', end: '08:00' });
  const untimed = shift({ start: null, end: null });
  override(owner, '2026-09-11', full);
  override(owner, '2026-09-12', untimed);
  override(owner, '2026-09-13');
  pattern({ from: '2026-09-14', until: '2026-09-14' });
  const entries = roster('2026-09-11', '2026-09-14').entries;
  const stats = summarize({ entries });
  assert.equal(stats.totalCount, 2);
  assert.equal(stats.totalMinutes, 1440);
  assert.equal(stats.freeDays, 1, 'the unconfigured fourth day must not count as free');
  assert.equal(stats.values.find((value) => value.type.id === untimed).hasHours, false);
  const first = routineEntriesOnDay(entries, '2026-09-11')[0];
  const continued = routineEntriesOnDay(entries, '2026-09-12').find((entry) => entry.date_key === '2026-09-11');
  assert.equal(first.segment_end_minutes - first.segment_start_minutes + continued.segment_end_minutes, 1440);
});

test('deleting one member cascades their roster and exceptions without touching other members', () => {
  const removed = Number(insertUser.run('lifecycle-removed', 'Removed member', 'x', 'member').lastInsertRowid);
  const type = shift();
  pattern({ member: removed, days: [[0, type]] });
  pattern({ member: other, days: [[0, type]] });
  override(removed, '2026-09-11');
  d.prepare('DELETE FROM users WHERE id=?').run(removed);
  const entries = roster('2026-09-11', '2026-09-11', null).entries;
  assert.deepEqual(entries.map((entry) => entry.user_id), [other]);
  assert.equal(d.prepare('SELECT count(*) n FROM schedule_overrides WHERE user_id=?').get(removed).n, 0);
  assertBusy(evaluate({ userId: other }));
  assert.deepEqual(d.pragma('foreign_key_check'), []);
});
