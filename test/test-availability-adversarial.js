import test from 'node:test';
import assert from 'node:assert/strict';

assert.equal(process.env.DB_PATH, ':memory:', 'Set DB_PATH=:memory: externally; never open a deployment database.');
const { get } = await import('../server/db.js');
const { evaluateAvailability, activityPresenceWindow, availabilityInstantMs } = await import('../server/services/presence.js');
const { saveTrip } = await import('../server/services/trips.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');
const database = get();
const userId = Number(database.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES ('adversarial-resolver','Adversarial member','test','admin')").run().lastInsertRowid);
const home = Number(database.prepare("INSERT INTO places(name,type) VALUES ('Adversarial Home','home')").run().lastInsertRowid);
const work = Number(database.prepare("INSERT INTO places(name,type) VALUES ('Adversarial Work','work')").run().lastInsertRowid);
const local = (time, date = '2026-09-07') => `${date}T${time}`;
function timezone(value) {
  database.prepare("INSERT INTO sync_config(key,value) VALUES ('household_timezone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
}
function evaluate(start, end = start, options = {}) {
  return evaluateAvailability(database, { userId, startAt: start, endAt: end,
    policy: 'available_before_due', nowAt: start, ...options });
}
function period(source, state, start, end, place = null, note = source) {
  return Number(database.prepare('INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,place_id,note) VALUES (?,?,?,?,?,?,?)')
    .run(userId, source, state, start, end, place, note).lastInsertRowid);
}
function routine({ start = '08:00', end = '16:00', state = 'busy', place = work,
  days = [0], length = 1, anchor = '2026-09-07', until = null } = {}) {
  const shiftId = Number(database.prepare('INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state,place_id) VALUES (?,?,?,?,?)')
    .run('Adversarial shift', start, end, state, place).lastInsertRowid);
  const id = Number(database.prepare('INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length,valid_until) VALUES (?,?,?,?,?)')
    .run(userId, 'Adversarial rotation', anchor, length, until).lastInsertRowid);
  const insert = database.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES (?,?,?)');
  for (const position of days) insert.run(id, position, shiftId);
  return { id, shiftId };
}
function weekly(state, start, end, place = home) {
  database.prepare('INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,place_id) VALUES (?,?,?,?,?,?,?)')
    .run(userId, 'Adversarial weekly', '[0,1,2,3,4,5,6]', start, end, state, place);
}
function event(start, end, place = work) {
  database.prepare('INSERT INTO calendar_events(title,start_datetime,end_datetime,assigned_to,created_by,place_id) VALUES (?,?,?,?,?,?)')
    .run('Offset appointment', start, end, userId, userId, place);
}
test.beforeEach(() => {
  timezone('UTC');
  for (const table of ['schedule_overrides', 'schedule_patterns', 'availability_periods', 'availability_rules']) {
    database.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
  }
  database.prepare('DELETE FROM calendar_events WHERE assigned_to=?').run(userId);
});

test('half-open capacity boundaries include the start and exclude the exact end', () => {
  period('explicit', 'busy', local('08:00:00'), local('09:00:00'));
  for (const [time, eligible] of [['07:59:59.999', true], ['08:00:00', false], ['08:59:59.999', false], ['09:00:00', true]]) {
    const result = evaluate(local(time));
    assert.equal(result.eligible, eligible, time);
    assert.equal(result.windows[0].confirmed_available, false);
    assert.match(result.reason, eligible ? /unknown; no planned restriction/ : /explicit: busy\./, time);
  }
  const exact = evaluate(local('07:00:00'), local('08:00:00'), { requiredDurationMinutes: 60 });
  assert.equal(exact.eligible, true);
  assert.equal(exact.qualifying_window.end_at, '2026-09-07T08:00:00.000Z');
  assert.equal(exact.qualifying_window.confirmed_available, false);
  assert.match(exact.reason, /continuous 60-minute eligible window.*unknown/);
  const due = evaluate(local('07:00:00'), local('08:00:00'), { windowMode: 'due' });
  assert.equal(due.eligible, false);
  assert.match(due.reason, /explicit: busy\./);
});

test('the last valid overnight occurrence survives midnight and a next-day off override', () => {
  routine({ start: '22:00', end: '06:00', until: '2026-09-07' });
  database.prepare('INSERT INTO schedule_overrides(user_id,date_key,shift_type_id) VALUES (?,?,NULL)').run(userId, '2026-09-08');
  const tail = evaluate(local('00:00:00', '2026-09-08'), local('06:00:00', '2026-09-08'));
  assert.equal(tail.eligible, false);
  assert.equal(tail.windows[0].effective.date_key, '2026-09-07');
  assert.equal(tail.routine_explanations.length, 1);
  assert.match(tail.reason, /Adversarial shift: busy\./);
  assert.equal(tail.windows[0].confirmed_available, false);
  assert.match(tail.routine_explanations[0].reason, /Day off this routine; other commitments still apply/);
  const ended = evaluate(local('06:00:00', '2026-09-08'));
  assert.equal(ended.eligible, true);
  assert.match(ended.reason, /unknown; no planned restriction/);
  assert.equal(evaluate(local('22:00:00', '2026-09-08')).windows[0].confirmed_available, false);
});

test('weekly midnight equality means a full local day and overnight tail ends exactly', () => {
  weekly('busy', '22:00', '06:00');
  const before = evaluate(local('05:59:59.999'));
  const after = evaluate(local('06:00:00'));
  assert.equal(before.eligible, false);
  assert.match(before.reason, /Adversarial weekly: busy\./);
  assert.equal(before.windows[0].confirmed_available, false);
  assert.equal(after.eligible, true);
  assert.match(after.reason, /unknown; no planned restriction/);
  assert.equal(after.windows[0].confirmed_available, false);
  database.prepare('DELETE FROM availability_rules WHERE user_id=?').run(userId);
  weekly('available', '00:00', '00:00');
  const result = evaluate(local('00:00:00'), local('00:00:00', '2026-09-08'), { requiredDurationMinutes: 1440 });
  assert.equal(result.qualifying_window.duration_minutes, 1440);
  assert.equal(result.qualifying_window.confirmed_available, true);
  assert.match(result.reason, /continuous 1440-minute eligible window.*Adversarial weekly: explicitly available/);
});

test('all precedence layers split at their actual boundaries and preserve losing evidence', () => {
  weekly('available', '08:00', '16:00');
  routine();
  period('workflow', 'available', local('09:00:00'), local('15:00:00'));
  period('explicit', 'away', local('10:00:00'), local('14:00:00'), work, 'Dated trip');
  period('manual', 'available', local('11:00:00'), local('13:00:00'), home, 'Manual exception');
  event(local('08:00:00'), local('16:00:00'));
  const result = evaluate(local('08:00:00'), local('16:00:00'));
  assert.deepEqual(result.windows.map((window) => window.source), ['rotating','workflow','explicit','manual','explicit','workflow','rotating']);
  assert.deepEqual(result.windows.map((window) => window.state), ['busy','available','away','available','away','available','busy']);
  assert.equal(result.windows[3].overridden_sources.length, 4);
  assert.equal(result.windows[3].advisory_events.length, 1);
  assert.match(result.windows[3].reason, /Manual exception: explicitly available/);
  assert.deepEqual(result.windows.map((window) => window.confirmed_available), [false,true,false,true,false,true,false]);
  assert.deepEqual(result.windows.map((window) => window.reason), [
    'Adversarial shift: busy.', 'workflow: explicitly available.', 'Dated trip: away.',
    'Manual exception: explicitly available.', 'Dated trip: away.', 'workflow: explicitly available.', 'Adversarial shift: busy.',
  ]);
});

test('a linked Trip beats a roster day off and expires without manufacturing confirmed free time', () => {
  routine();
  database.prepare('INSERT INTO schedule_overrides(user_id,date_key,shift_type_id) VALUES (?,?,NULL)').run(userId, '2026-09-07');
  saveTrip(database, { name: 'Adversarial family trip', destination_place_id: work,
    starts_at: local('09:00:00'), ends_at: local('12:00:00'), participant_ids: [userId], status: 'active', create_away_periods: true, tasks: [] }, userId);
  const during = evaluate(local('09:00:00'));
  assert.equal(during.eligible, false);
  assert.equal(during.windows[0].reason, 'Adversarial family trip: away.');
  const after = evaluate(local('12:00:00'));
  assert.equal(after.eligible, true);
  assert.equal(after.windows[0].confirmed_available, false);
  assert.equal(after.windows[0].state, 'unknown');
  assert.match(after.reason, /unknown; no planned restriction/);
  assert.match(after.routine_explanations[0].reason, /other commitments still apply/);
});

test('unconfigured blocks a weekly available day; explicit off restores only the weekly signal', () => {
  const { id } = routine({ days: [] });
  weekly('available', '08:00', '16:00');
  const missing = evaluate(local('09:00:00'));
  assert.equal(missing.eligible, false);
  assert.equal(missing.windows[0].confirmed_available, false);
  assert.match(missing.reason, /not been configured/);
  database.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES (?,0,NULL)').run(id);
  const inherited = evaluate(local('09:00:00'));
  assert.equal(inherited.windows[0].source, 'rule');
  assert.equal(inherited.windows[0].confirmed_available, true);
  assert.match(inherited.reason, /Adversarial weekly: explicitly available/);
  const outside = evaluate(local('17:00:00'));
  assert.equal(outside.windows[0].confirmed_available, false);
  assert.match(outside.reason, /unknown; no planned restriction/);
});

test('adjacent available and unknown capacity can fit duration but remain unconfirmed', () => {
  period('explicit', 'available', local('08:00:00'), local('08:15:00'));
  period('explicit', 'busy', local('08:45:00'), local('09:00:00'));
  const result = evaluate(local('08:00:00'), local('09:00:00'), { requiredDurationMinutes: 45 });
  assert.equal(result.eligible, true);
  assert.equal(result.qualifying_window.duration_minutes, 45);
  assert.equal(result.qualifying_window.confirmed_available, false);
  assert.match(result.qualifying_window.reason, /explicitly available/);
  assert.match(result.qualifying_window.reason, /unknown/);
  assert.equal(evaluate(local('08:00:00'), local('09:00:00'), { requiredDurationMinutes: 45.001 }).eligible, false);
  period('manual', 'busy', local('08:20:00'), local('08:21:00'));
  const split = evaluate(local('08:00:00'), local('09:00:00'), { requiredDurationMinutes: 30 });
  assert.equal(split.eligible, false);
  assert.deepEqual(split.available_windows.map((window) => window.duration_minutes), [20,24]);
  assert.match(split.reason, /No continuous eligible window/);
});

test('duration in start and due modes cannot escape a shorter useful range', () => {
  for (const windowMode of ['start', 'due']) {
    const result = evaluate(local('08:00:00'), local('08:29:59.999'), { windowMode, requiredDurationMinutes: 30 });
    assert.equal(result.eligible, false, windowMode);
    assert.ok(Date.parse(result.start_at) >= Date.parse(`${local('08:00:00')}Z`));
    assert.ok(Date.parse(result.end_at) <= Date.parse(`${local('08:29:59.999')}Z`));
    assert.equal(result.windows[0].confirmed_available, false);
    assert.match(result.reason, /No continuous eligible window is long enough for 30 minutes/);
  }
});

test('Calendar location signals survive equivalent positive and negative offset encodings', () => {
  for (const [start, end] of [
    ['2026-09-07T18:00:00Z','2026-09-07T19:00:00Z'],
    ['2026-09-08T08:00:00+14:00','2026-09-08T09:00:00+14:00'],
    ['2026-09-07T08:00:00-10:00','2026-09-07T09:00:00-10:00'],
  ]) {
    database.prepare('DELETE FROM calendar_events WHERE assigned_to=?').run(userId);
    event(start, end);
    const result = evaluate('2026-09-07T18:30:00Z');
    assert.equal(result.windows[0].advisory_events.length, 1, start);
    assert.equal(result.current_presence.place.id, work, start);
    assert.equal(result.windows[0].confirmed_available, false);
    assert.match(result.reason, /unknown; no planned restriction\. Calendar events remain advisory/);
    assert.match(result.current_presence.reason, /Believed location from Offset appointment; this does not imply spare time/);
  }
});

test('zone-less Calendar events use the household zone even east of UTC', () => {
  timezone('Asia/Tokyo');
  event(local('09:00:00'), local('10:00:00'));
  const result = evaluate('2026-09-07T00:30:00Z');
  assert.equal(result.windows[0].advisory_events.length, 1);
  assert.equal(result.current_presence.place.id, work);
  assert.equal(result.windows[0].confirmed_available, false);
  assert.match(result.reason, /Calendar events remain advisory/);
  assert.match(result.current_presence.reason, /Offset appointment; this does not imply spare time/);
});

test('a recurring offset Calendar event retains its full duration in a different server zone', () => {
  event('2026-09-07T08:00:00+14:00','2026-09-07T09:00:00+14:00');
  database.prepare("UPDATE calendar_events SET recurrence_rule='FREQ=DAILY;COUNT=3' WHERE assigned_to=?").run(userId);
  const prior = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const rows = database.prepare('SELECT * FROM calendar_events WHERE assigned_to=?').all(userId);
    const projected = expandRecurringEvents(rows, '2026-09-08', '2026-09-08');
    assert.equal(projected.length, 1);
    assert.equal(projected[0].end_datetime, '2026-09-07T19:00:00Z', 'Calendar projection and resolver share the same actual interval');
    const result = evaluate('2026-09-07T18:30:00Z');
    assert.equal(result.windows[0].advisory_events.length, 1);
    assert.equal(result.current_presence.place.id, work);
    assert.equal(result.windows[0].confirmed_available, false);
    assert.match(result.reason, /Calendar events remain advisory/);
    assert.match(result.current_presence.reason, /Offset appointment; this does not imply spare time/);
    assert.equal(evaluate('2026-09-07T19:00:00Z').windows[0].advisory_events.length, 0);
  } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});

test('browser offsets and a different server zone leave the same household shift unchanged', () => {
  timezone('America/New_York');
  routine();
  const prior = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const results = ['2026-09-07T09:00:00', '2026-09-07T13:00:00Z', '2026-09-07T23:00:00+10:00']
      .map((value) => evaluate(value));
    assert.deepEqual(results.map((result) => result.start_at), Array(3).fill('2026-09-07T13:00:00.000Z'));
    assert.deepEqual(results.map((result) => result.eligible), [false,false,false]);
    for (const result of results) {
      assert.equal(result.windows[0].confirmed_available, false);
      assert.match(result.reason, /Adversarial shift: busy\./);
    }
  } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});

test('Lord Howe half-hour DST transitions preserve real overnight durations', () => {
  timezone('Australia/Lord_Howe');
  routine({ start:'22:00', end:'06:00', state:'available' });
  for (const [start, end, minutes] of [
    ['2026-04-04T22:00:00','2026-04-05T06:00:00',510],
    ['2026-10-03T22:00:00','2026-10-04T06:00:00',450],
  ]) {
    const result = evaluate(start, end, { requiredDurationMinutes: minutes });
    assert.equal(result.qualifying_window.duration_minutes, minutes);
    assert.equal(result.qualifying_window.confirmed_available, true);
    assert.match(result.reason, new RegExp(`continuous ${minutes}-minute eligible window.*Adversarial shift: explicitly available`));
    const tooLong = evaluate(start, end, { requiredDurationMinutes: minutes + 1 });
    assert.equal(tooLong.eligible, false);
    assert.match(tooLong.reason, new RegExp(`No continuous eligible window is long enough for ${minutes + 1} minutes`));
  }
});

test('a DST transition at local midnight produces a 23-hour all-day routine with a warning', () => {
  timezone('America/Santiago');
  routine({ start:null, end:null, state:'available' });
  const result = evaluate('2026-09-06T00:00:00','2026-09-07T00:00:00', { requiredDurationMinutes: 1380 });
  assert.equal(result.qualifying_window.duration_minutes, 1380);
  assert.equal(result.start_at, '2026-09-06T04:00:00.000Z');
  assert.ok(result.warnings.some((warning) => /shifted forward/.test(warning.reason || '')));
  assert.equal(result.qualifying_window.confirmed_available, true);
  assert.match(result.reason, /continuous 1380-minute eligible window.*explicitly available/);
});

test('explicit offsets distinguish both fall-back occurrences while a local time chooses earlier', () => {
  timezone('America/New_York');
  routine({ start:'01:30', end:'02:30', state:'available' });
  const early = evaluate('2026-11-01T01:30:00');
  const late = evaluate('2026-11-01T01:30:00-05:00');
  assert.equal(early.start_at, '2026-11-01T05:30:00.000Z');
  assert.equal(late.start_at, '2026-11-01T06:30:00.000Z');
  assert.equal(late.eligible, true);
  for (const result of [early, late]) {
    assert.equal(result.windows[0].confirmed_available, true);
    assert.match(result.reason, /Adversarial shift: explicitly available/);
  }
});

test('valid minute-precision local inputs do not report a nonexistent clock-change time', () => {
  timezone('America/New_York');
  const result = evaluate('2026-09-07T09:00', '2026-09-07T10:00');
  assert.equal(result.warnings.length, 0);
  assert.equal(result.start_at, '2026-09-07T13:00:00.000Z');
});

test('the shared instant parser rejects impossible calendar dates and malformed clock values', () => {
  for (const value of ['2026-02-30T12:00:00', '2026-02-30T12:00:00Z', '2026-02-29',
    '2026-09-07T24:00:00', '2026-09-07T25:00:00', '2026-09-07T09:60:00',
    '2026-09-07T09:00:60', '2026-09-07T09:00:00+24:00', '09/07/2026 09:00', 'tomorrow', '']) {
    assert.equal(availabilityInstantMs(value, 'America/New_York'), null, value);
    assert.throws(() => evaluate(value), /valid availability window/, value);
  }
  assert.equal(availabilityInstantMs('2028-02-29T09:00:00-05:00', 'America/New_York'), Date.parse('2028-02-29T14:00:00Z'));
  assert.equal(availabilityInstantMs('2026-09-07 09:00', 'America/New_York'), Date.parse('2026-09-07T13:00:00Z'));
});

test('a dated period crossing a missing local time explains the same forward adjustment as routines', () => {
  timezone('America/New_York');
  period('manual', 'busy', '2026-03-08T02:30:00', '2026-03-08T04:00:00', home, 'Clock-change exception');
  const result = evaluate('2026-03-08T03:30:00', '2026-03-08T04:00:00');
  assert.equal(result.eligible, false);
  assert.ok(result.warnings.some((warning) => warning.source === 'manual' && /shifted forward/.test(warning.reason)));
});

test('a rejected away-at-home policy never explains that the member is expected home', () => {
  const actualHome = database.prepare("SELECT id FROM places WHERE active=1 AND type='home' ORDER BY CASE WHEN parent_place_id IS NULL THEN 0 ELSE 1 END,id LIMIT 1").get().id;
  period('manual', 'away', local('08:00:00'), local('16:00:00'), actualHome);
  for (const policy of ['must_be_home', 'must_be_at_location']) {
    const result = evaluate(local('09:00:00'), local('10:00:00'), { policy, targetPlaceId: actualHome });
    assert.equal(result.eligible, false);
    assert.match(result.reason, /^Not expected/);
  }
});

test('a future start-only Task gets a same-day useful window instead of an earlier fallback due date', () => {
  for (const windowMode of ['start','due','completion']) {
    const window = activityPresenceWindow(database, { task: { start_date: '2026-12-15' }, dateKey:'2026-09-07', windowMode });
    assert.equal(window.startAt, '2026-12-15T00:00:00');
    assert.equal(evaluateAvailability(database, { userId, ...window, policy:'available_before_due' }).eligible, true);
    assert.ok(window.endAt.startsWith(windowMode === 'completion' ? '2026-12-16' : '2026-12-15'));
  }
});

test('current Presence uses now independently, changes at exact expiry and never confirms future availability', () => {
  period('manual', 'busy', local('08:00:00'), local('09:00:00'), home, 'At home now');
  period('explicit', 'away', local('09:00:00'), local('10:00:00'), work, 'Leaving now');
  for (const [nowAt, expectedPlace, expectedSource] of [
    [local('08:59:59.999'),home,'manual'], [local('09:00:00'),work,'explicit'], [local('10:00:00'),null,null],
  ]) {
    const result = evaluate(local('12:00:00'), local('13:00:00'), { nowAt });
    assert.equal(result.current_presence.place?.id ?? null, expectedPlace);
    assert.equal(result.current_presence.source, expectedSource);
    assert.equal(result.windows[0].confirmed_available, false);
    assert.equal(result.windows[0].source, null);
  }
});

test('ordinary unplanned gaps remain eligible but neither their segments nor duration window confirm availability', () => {
  const result = evaluate(local('08:00:00'),local('09:00:00'),{requiredDurationMinutes:30});
  assert.equal(result.eligible,true);
  assert.equal(result.windows[0].state,'unknown');
  assert.equal(result.windows[0].source,null);
  assert.equal(result.windows[0].confirmed_available,false);
  assert.equal(result.qualifying_window.confirmed_available,false);
  assert.match(result.reason,/unknown; no planned restriction/);
  assert.doesNotMatch(result.reason,/explicitly available/);
});

test('a weekly unknown signal permits unconfirmed time but cannot override a busy rotating routine', () => {
  weekly('unknown','08:00','16:00');
  const weeklyOnly = evaluate(local('09:00:00'),local('10:00:00'));
  assert.equal(weeklyOnly.eligible,true);
  assert.equal(weeklyOnly.windows[0].source,'rule');
  assert.equal(weeklyOnly.windows[0].state,'unknown');
  assert.equal(weeklyOnly.windows[0].confirmed_available,false);
  assert.match(weeklyOnly.reason,/unknown; this policy permits unconfirmed time/);
  routine();
  const withShift = evaluate(local('09:00:00'),local('10:00:00'));
  assert.equal(withShift.eligible,false);
  assert.equal(withShift.windows[0].state,'busy');
  assert.equal(withShift.windows[0].overridden_sources[0].state,'unknown');
});

test('manual unknown with a Place supersedes busy rotation without claiming that free time is confirmed', () => {
  routine();
  period('manual','unknown',local('09:00:00'),local('10:00:00'),home,'Location-only manual note');
  const result = evaluate(local('09:00:00'),local('10:00:00'),{targetPlaceId:home});
  assert.equal(result.eligible,true,'preserved permissive semantics of an effective nonrotating unknown period');
  assert.equal(result.windows[0].state,'unknown');
  assert.equal(result.windows[0].source,'manual');
  assert.equal(result.windows[0].confirmed_available,false);
  assert.equal(result.qualifying_window.confirmed_available,false);
  assert.equal(result.windows[0].overridden_sources[0].state,'busy');
  assert.equal(result.current_presence.place.id,home);
  assert.match(result.reason,/Location-only manual note: availability is unknown; this policy permits unconfirmed time/);
  assert.doesNotMatch(result.reason,/no planned restriction|explicitly available/);
  assert.equal(evaluate(local('10:00:00')).eligible,false,'the busy rotation resumes when the manual period expires');
});

test('explicit rotating unknown remains blocking and never receives the permissive unknown explanation', () => {
  routine({state:'unknown'});
  const result = evaluate(local('09:00:00'),local('10:00:00'));
  assert.equal(result.eligible,false);
  assert.equal(result.windows[0].state,'unknown');
  assert.equal(result.windows[0].confirmed_available,false);
  assert.equal(result.available_windows.length,0);
  assert.match(result.reason,/Adversarial shift: unknown/);
  assert.doesNotMatch(result.reason,/permits unconfirmed time|explicitly available/);
});

test('ignore bypasses capacity and supplied duration without claiming that a duration-fit window exists', () => {
  routine();
  const result = evaluate(local('09:00:00'),local('09:15:00'),{policy:'ignore',requiredDurationMinutes:60});
  assert.equal(result.eligible,true);
  assert.equal(result.reason,'Availability and location are ignored for this activity.');
  assert.equal(result.qualifying_window,null);
  assert.equal(result.available_windows.length,0);
  assert.equal(result.windows[0].eligible,true);
  assert.equal(result.windows[0].availability_usable,false);
  assert.equal(result.windows[0].confirmed_available,false);
  assert.doesNotMatch(result.reason,/continuous|60-minute|explicitly available/);
});
