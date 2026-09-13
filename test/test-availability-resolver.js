import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import express from 'express';
import { modernTaskMutationBody } from './helpers/task-client-revision-fixture.js';

// This suite must never discover the application's deployment database.
assert.equal(process.env.DB_PATH, ':memory:', 'Set DB_PATH=:memory: externally before running this suite.');
const { get } = await import('../server/db.js');
const { evaluateAvailability, activityPresenceWindow } = await import('../server/services/presence.js');
const { resolveActivityAssignment, assertEligibleActivityMember } = await import('../server/services/activity-eligibility.js');
const { claimTask, overrideTaskAssignment } = await import('../server/services/assignment-responsibilities.js');
const { saveTrip } = await import('../server/services/trips.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const database = get();
const userId = Number(database.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES ('availability-test','Routine owner','x','admin','parent')").run().lastInsertRowid);
const home = Number(database.prepare("INSERT INTO places(name,type) VALUES ('Resolver Home','home')").run().lastInsertRowid);
const work = Number(database.prepare("INSERT INTO places(name,type) VALUES ('Resolver Work','work')").run().lastInsertRowid);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = userId; req.authRole = 'admin'; req.session = { userId, role: 'admin' }; next();
});
app.use('/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => server.close());
async function taskRequest(method, path, body) {
  body=modernTaskMutationBody(database,method,path,body);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/tasks${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const at = (time) => `2026-09-07T${time}:00`;
function evaluate(start, end, options = {}) {
  return evaluateAvailability(database, { userId, startAt: at(start), endAt: at(end),
    policy: 'available_before_due', nowAt: at('12:00'), ...options });
}
function shift({ start = '08:00', end = '16:00', state = 'busy', place = work } = {}) {
  return Number(database.prepare('INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state,place_id) VALUES (?,?,?,?,?)')
    .run('Work shift', start, end, state, place).lastInsertRowid);
}
function routine(length, shiftId, positions, anchor = '2026-09-07') {
  const id = Number(database.prepare('INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES (?,?,?,?)')
    .run(userId, 'Household rotation', anchor, length).lastInsertRowid);
  const insert = database.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES (?,?,?)');
  for (const position of positions) insert.run(id, position, shiftId);
  return id;
}
function period(source, state, start, end, place = null, category = 'general') {
  return Number(database.prepare('INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,place_id,category) VALUES (?,?,?,?,?,?,?)')
    .run(userId, source, state, at(start), at(end), place, category).lastInsertRowid);
}
function weekly(state = 'available', start = '00:00', end = '23:59', place = home) {
  database.prepare('INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,place_id) VALUES (?,?,?,?,?,?,?)')
    .run(userId, 'Weekly routine', '[0]', start, end, state, place);
}
test.beforeEach(() => {
  database.prepare("INSERT INTO sync_config(key,value) VALUES ('household_timezone','UTC') ON CONFLICT(key) DO UPDATE SET value='UTC'").run();
  for (const table of ['schedule_overrides', 'schedule_patterns', 'availability_periods', 'availability_rules']) {
    database.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
  }
  database.prepare('DELETE FROM calendar_events WHERE assigned_to = ?').run(userId);
});

test('weekly routine produces actual windows and unplanned gaps remain unknown, not confirmed free', () => {
  weekly('busy', '08:00', '16:00', work);
  assert.equal(evaluate('09:00', '10:00').eligible, false);
  const result = evaluate('16:00', '17:00');
  assert.equal(result.eligible, true);
  assert.equal(result.windows[0].state, 'unknown');
  assert.equal(result.windows[0].confirmed_available, false);
  assert.match(result.reason, /unknown; no planned restriction/i);
});

test('Week A/B and four-on/four-off rotations preserve their exact calendar-day sequence', () => {
  const shiftId = shift();
  const id = routine(14, shiftId, [0, 1, 2, 3, 4]);
  for (let position = 5; position < 14; position += 1) database.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES (?,?,NULL)').run(id, position);
  assert.equal(evaluate('10:00', '11:00').eligible, false);
  assert.equal(evaluate('10:00', '11:00', { startAt: '2026-09-14T10:00:00', endAt: '2026-09-14T11:00:00' }).eligible, true);
  database.prepare('DELETE FROM schedule_patterns WHERE id=?').run(id);
  const rotation = routine(8, shiftId, [0, 1, 2, 3]);
  for (let position = 4; position < 8; position += 1) database.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES (?,?,NULL)').run(rotation, position);
  assert.equal(evaluate('10:00', '11:00', { startAt: '2026-09-10T10:00:00', endAt: '2026-09-10T11:00:00' }).eligible, false);
  assert.equal(evaluate('10:00', '11:00', { startAt: '2026-09-11T10:00:00', endAt: '2026-09-11T11:00:00' }).eligible, true);
  assert.equal(evaluate('10:00', '11:00', { startAt: '2026-09-15T10:00:00', endAt: '2026-09-15T11:00:00' }).eligible, false);
});

test('unconfigured day blocks with unknown explanation; explicit day off removes only its routine', () => {
  const id = routine(1, null, []);
  let result = evaluate('09:00', '10:00');
  assert.equal(result.eligible, false);
  assert.equal(result.windows[0].state, 'unknown');
  assert.match(result.reason, /not been configured/);
  database.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES (?,0,NULL)').run(id);
  result = evaluate('09:00', '10:00');
  assert.equal(result.eligible, true);
  assert.equal(result.windows[0].confirmed_available, false);
  assert.match(result.routine_explanations[0].reason, /other commitments/);
  weekly('busy', '08:00', '16:00', work);
  assert.equal(evaluate('09:00', '10:00').eligible, false, 'day off does not cancel unrelated weekly obligations');
});

test('precedence manual > dated trip > workflow > rotating > weekly and raw shadowed availability never grants eligibility', () => {
  weekly();
  routine(1, shift(), [0]);
  let result = evaluate('09:00', '10:00');
  assert.equal(result.windows[0].source, 'rotating');
  assert.equal(result.eligible, false);
  period('workflow', 'available', '09:00', '10:00', home);
  assert.equal(evaluate('09:00', '10:00').eligible, true);
  period('explicit', 'away', '09:00', '10:00', work, 'travel');
  result = evaluate('09:00', '10:00');
  assert.equal(result.windows[0].source, 'explicit');
  assert.equal(result.eligible, false);
  assert.ok(result.windows[0].overridden_sources.some((source) => source.state === 'available'));
  period('manual', 'available', '09:00', '10:00', home);
  assert.equal(evaluate('09:00', '10:00').eligible, true);
  assert.equal(evaluate('09:00', '10:00').windows[0].source, 'manual');
});

test('roster replacement cannot defeat a trip; null override restores other information without all-day free', () => {
  routine(1, shift(), [0]);
  const replacement = shift({ start: '10:00', end: '18:00', state: 'available', place: home });
  database.prepare('INSERT INTO schedule_overrides(user_id,date_key,shift_type_id) VALUES (?,?,?)').run(userId, '2026-09-07', replacement);
  period('explicit', 'away', '00:00', '23:59', work, 'travel');
  assert.equal(evaluate('12:00', '13:00').eligible, false);
  database.prepare('UPDATE schedule_overrides SET shift_type_id=NULL WHERE user_id=?').run(userId);
  assert.equal(evaluate('12:00', '13:00').eligible, false);
  assert.match(evaluate('12:00', '13:00').routine_explanations[0].reason, /Day off/);
});

test('overnight tail loads from preceding day, ends exactly at 06:00 and is not cancelled by next-day off', () => {
  routine(1, shift({ start: '22:00', end: '06:00' }), [0]);
  database.prepare('INSERT INTO schedule_overrides(user_id,date_key,shift_type_id) VALUES (?,?,NULL)').run(userId, '2026-09-07');
  assert.equal(evaluate('02:00', '03:00').eligible, false);
  assert.equal(evaluate('06:00', '07:00').eligible, true);
  assert.equal(evaluate('23:00', '23:30').eligible, true);
});

test('completion finds a continuous gap before a busy due instant; start/due anchors and duration use proper boundaries', () => {
  routine(1, shift({ start: '10:00', end: '16:00' }), [0]);
  const result = evaluate('09:00', '11:00', { requiredDurationMinutes: 60 });
  assert.equal(result.eligible, true);
  assert.equal(result.qualifying_window.duration_minutes, 60);
  assert.equal(evaluate('09:00', '11:00', { requiredDurationMinutes: 61 }).eligible, false);
  assert.equal(evaluate('09:00', '11:00', { windowMode: 'due' }).eligible, false);
  assert.equal(evaluate('09:00', '11:00', { windowMode: 'start' }).eligible, true);
  assert.equal(evaluate('15:00', '16:00', { windowMode: 'due' }).eligible, true, 'due instant at shift end is outside shift');
  assert.equal(evaluate('09:00', '11:00', { windowMode: 'start', requiredDurationMinutes: 61 }).eligible, false);
  assert.equal(evaluate('16:00', '16:30', { windowMode: 'start', requiredDurationMinutes: 60 }).eligible, false, 'start mode cannot search beyond supplied useful end');
  assert.equal(evaluate('16:00', '16:30', { windowMode: 'due', requiredDurationMinutes: 60 }).eligible, false, 'due mode cannot search before supplied useful start');
});

test('adjacent usable segments merge; disjoint short gaps cannot satisfy duration', () => {
  weekly('available', '09:00', '10:00', home);
  period('explicit', 'available', '10:00', '11:00', home);
  assert.equal(evaluate('09:00', '11:00', { requiredDurationMinutes: 120 }).eligible, true);
  period('manual', 'busy', '09:30', '10:30', work);
  assert.equal(evaluate('09:00', '11:00', { requiredDurationMinutes: 45 }).eligible, false);
});

test('Calendar stays advisory and resolving availability never materializes events', () => {
  database.prepare('INSERT INTO calendar_events(title,start_datetime,end_datetime,assigned_to,created_by) VALUES (?,?,?,?,?)')
    .run('Calendar commitment', at('09:00'), at('10:00'), userId, userId);
  const before = database.prepare('SELECT COUNT(*) AS total FROM calendar_events').get().total;
  const result = evaluate('09:00', '10:00');
  assert.equal(result.eligible, true);
  assert.equal(result.windows[0].state, 'unknown');
  assert.equal(result.windows[0].advisory_events[0].title, 'Calendar commitment');
  const point = evaluate('09:30', '09:30', { nowAt: at('09:30') });
  assert.equal(point.effective.state, 'busy', 'legacy top-level effective remains compatible');
  const source = readFileSync(new URL('../public/components/activity-automation.js', import.meta.url), 'utf8');
  const renderSource = source.slice(source.indexOf('function currentLocationHTML('), source.indexOf('\nfunction availabilityWindowsHTML('));
  const renderCards = new Function('h', 'planningTime', `${renderSource}\nreturn currentLocationHTML;`)(String, String);
  const html = renderCards([{ member: { display_name: 'Calendar-only member' }, value: point }]);
  assert.match(html, /Availability now: unknown<\/small>/, 'the Presence card must use the capacity timeline rather than advisory Calendar busy');
  assert.doesNotMatch(html, /Availability now: busy/);
  assert.equal(database.prepare('SELECT COUNT(*) AS total FROM calendar_events').get().total, before);
});

test('believed current location is independent of future availability and never implies free time', () => {
  period('manual', 'busy', '11:00', '13:00', home);
  const result = evaluate('15:00', '16:00');
  assert.equal(result.current_presence.place.id, home);
  assert.equal(result.current_presence.inferred, true);
  assert.match(result.current_presence.reason, /does not imply spare time/);
  assert.equal(evaluate('12:00', '12:30').eligible, false);
  assert.equal(result.windows[0].state, 'unknown');
});

test('task useful-window helper honors dates/mode and actual assignment respects shifts and ignore policy', () => {
  routine(1, shift(), [0]);
  const activityId = Number(database.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,presence_window) VALUES ('Resolver task','Task','fixed','fixed',?,0,'available_before_due','due')").run(userId).lastInsertRowid);
  const activity = database.prepare('SELECT * FROM activity_templates WHERE id=?').get(activityId);
  const task = { start_date: '2026-09-06', due_date: '2026-09-07', due_time: '10:00' };
  const presence = activityPresenceWindow(database, { task, windowMode: 'due' });
  assert.equal(presence.startAt, '2026-09-06T00:00:00');
  assert.equal(presence.endAt, at('10:00'));
  assert.throws(() => resolveActivityAssignment(database, activity, { dateKey: '2026-09-07', presence }), /availability requirement/);
  task.due_time = '17:00';
  assert.equal(resolveActivityAssignment(database, activity, { dateKey: '2026-09-07', presence: activityPresenceWindow(database, { task, windowMode: 'due' }) }).primary.id, userId);
  assert.equal(resolveActivityAssignment(database, activity, { dateKey: '2026-09-07', presence: { ...presence, policy: 'ignore' } }).primary.id, userId);
  const dateOnly = activityPresenceWindow(database, { dateKey: '2026-09-07', windowMode: 'completion' });
  assert.equal(dateOnly.endAt, '2026-09-08T00:00:00');
});

test('invalid, reverse and unbounded windows fail clearly', () => {
  assert.throws(() => evaluate('11:00', '10:00'), /valid availability window/);
  assert.throws(() => evaluate('10:00', '11:00', { requiredDurationMinutes: 0 }), /positive number/);
  assert.throws(() => evaluate('10:00', '11:00', { endAt: '2030-01-01T00:00:00' }), /731 days/);
});

test('overnight availability uses household wall time and actual elapsed duration across DST', () => {
  database.prepare("UPDATE sync_config SET value='America/New_York' WHERE key='household_timezone'").run();
  routine(1, shift({ start: '22:00', end: '06:00', state: 'available', place: home }), [0]);
  const spring = { startAt: '2026-03-07T22:00:00', endAt: '2026-03-08T06:00:00', requiredDurationMinutes: 420 };
  assert.equal(evaluate('09:00', '10:00', spring).qualifying_window.duration_minutes, 420);
  assert.equal(evaluate('09:00', '10:00', { ...spring, requiredDurationMinutes: 421 }).eligible, false);
  const fall = { startAt: '2026-10-31T22:00:00', endAt: '2026-11-01T06:00:00', requiredDurationMinutes: 540 };
  assert.equal(evaluate('09:00', '10:00', fall).qualifying_window.duration_minutes, 540);
  assert.equal(evaluate('09:00', '10:00', { ...fall, requiredDurationMinutes: 541 }).eligible, false);
});

test('equal shift times span 24 hours and clocks moving forward/back have explicit bounded behavior', () => {
  let id = routine(1, shift({ start: '10:00', end: '10:00', state: 'available' }), [0]);
  assert.equal(evaluate('09:00', '10:00', { startAt: '2026-09-07T10:00:00', endAt: '2026-09-08T10:00:00', requiredDurationMinutes: 1440 }).eligible, true);
  database.prepare('DELETE FROM schedule_patterns WHERE id=?').run(id);
  database.prepare("UPDATE sync_config SET value='America/New_York' WHERE key='household_timezone'").run();
  id = routine(1, shift({ start: '02:30', end: '04:00', state: 'available' }), [0]);
  let result = evaluate('09:00', '10:00', { startAt: '2026-03-08T03:30:00', endAt: '2026-03-08T04:00:00' });
  assert.equal(result.windows[0].effective.starts_at, '2026-03-08T07:30:00.000Z');
  assert.ok(result.warnings.some((warning) => /shifted forward/.test(warning.reason || '')));
  database.prepare('DELETE FROM schedule_patterns WHERE id=?').run(id);
  routine(1, shift({ start: '01:30', end: '02:30', state: 'available' }), [0]);
  result = evaluate('09:00', '10:00', { startAt: '2026-11-01T01:30:00', endAt: '2026-11-01T02:30:00', requiredDurationMinutes: 120 });
  assert.equal(result.qualifying_window.start_at, '2026-11-01T05:30:00.000Z', 'ambiguous local start chooses earlier occurrence');
  assert.equal(result.qualifying_window.duration_minutes, 120);
});

test('Task API binding validation uses the same concrete due time as assignment', async () => {
  routine(1, shift({ start: '22:00', end: '06:00' }), [0]);
  const activityId = Number(database.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,presence_window) VALUES ('API night routine','Task','fixed','fixed',?,0,'available_before_due','due')").run(userId).lastInsertRowid);
  const base = { title: 'Daytime work', due_date: '2026-09-07', due_time: '10:00', activity_template_id: activityId };
  const created = await taskRequest('POST', '', base);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rejected = await taskRequest('POST', '', { ...base, title: 'During shift', due_time: '23:00' });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  const manual = await taskRequest('POST', '', { title: 'Bind existing daytime task', due_date: '2026-09-07', due_time: '10:00' });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  const updated = await taskRequest('PUT', `/${manual.body.data.id}`, { activity_template_id: activityId });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
});

test('claim and administrator reassignment honor the concrete task presence window', async () => {
  routine(1, shift({ start: '22:00', end: '06:00' }), [0]);
  const activityId = Number(database.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,presence_window) VALUES ('Claim daytime','Task','eligible_round_robin','open_claimable',0,'available_before_due','due')").run().lastInsertRowid);
  const created = await taskRequest('POST', '', { title: 'Claim daytime work', due_date: '2026-09-07', due_time: '10:00', activity_template_id: activityId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const taskId = created.body.data.id;
  database.prepare("UPDATE task_planning_context SET presence_window='start' WHERE task_id=?").run(taskId);
  assert.throws(() => claimTask(database, taskId, userId), /availability requirement/);
  assert.throws(() => overrideTaskAssignment(database, taskId, userId, userId), /availability requirement/);
  database.prepare("UPDATE task_planning_context SET presence_window='due' WHERE task_id=?").run(taskId);
  assert.equal(claimTask(database, taskId, userId).assigned_to.id, userId);
});

test('Trip availability explains the linked household plan name rather than its internal period marker', () => {
  routine(1, shift(), [0]);
  const trip = saveTrip(database, { name: 'Family beach weekend', destination_place_id: work,
    starts_at: at('08:00'), ends_at: at('18:00'), participant_ids: [userId], status: 'active',
    create_away_periods: true, tasks: [] }, userId);
  const result = evaluate('09:00', '10:00');
  assert.equal(result.eligible, false);
  assert.equal(result.windows[0].source, 'explicit');
  assert.equal(result.windows[0].effective.trip_name, 'Family beach weekend');
  assert.equal(result.windows[0].effective.context_name, 'Family beach weekend');
  assert.equal(result.reason, 'Family beach weekend: away.');
  const source = readFileSync(new URL('../public/components/activity-automation.js', import.meta.url), 'utf8');
  const labelSource = source.slice(source.indexOf('function availabilitySignalLabel('), source.indexOf('\nfunction planningTime('));
  const label = new Function(`${labelSource}\nreturn availabilitySignalLabel;`)();
  assert.equal(label(result.windows[0].effective), 'Family beach weekend', 'overridden Trip sources also display their household name');
  assert.match(result.windows[0].effective.note, /^Planning context:\d+:travel$/, 'raw provenance is preserved separately');
  database.prepare('UPDATE planning_contexts SET name=? WHERE id=?').run('Beach weekend with grandparents', trip.planning_context_id);
  assert.equal(evaluate('09:00', '10:00').reason, 'Beach weekend with grandparents: away.', 'labels follow the actual linked context record');
});

test('assignment failures name availability or location without exposing routine details', () => {
  routine(1, shift(), [0]);
  const activityId = Number(database.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,presence_window) VALUES ('Policy copy','Task','fixed','fixed',?,0,'available_before_due','due')").run(userId).lastInsertRowid);
  const activity = database.prepare('SELECT * FROM activity_templates WHERE id=?').get(activityId);
  for (const [policy, endAt, requirement] of [
    ['available_before_due', at('10:00'), 'availability'],
    ['must_be_home', at('10:00'), 'location'],
    ['must_be_at_location', at('10:00'), 'location'],
    ['must_be_away', at('17:00'), 'location'],
  ]) {
    const options = { dateKey:'2026-09-07', presence:{startAt:at('08:00'),endAt,windowMode:'due',targetPlaceId:home,policy} };
    assert.throws(() => resolveActivityAssignment(database,activity,options),
      {message:`The fixed assignee does not meet this activity’s ${requirement} requirement.`});
    assert.throws(() => assertEligibleActivityMember(database,activity,userId,options),
      {message:`That household member does not meet this activity's ${requirement} requirement.`});
  }
});
