import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'planning-context-travel-test-secret';

const { ALL_MIGRATIONS } = await import('../server/db.js');
const {
  claimTask,
  overrideTaskAssignment,
} = await import('../server/services/assignment-responsibilities.js');
const { attachTaskActivityBindings } = await import('../server/services/task-activity-bindings.js');
const {
  getCalendarTravelProjection,
  removeCalendarTravelProjection,
  saveCalendarTravelProjection,
} = await import('../server/services/calendar-travel.js');
const {
  getPlanningContext,
  getTravelMealPlanTask,
  ensureTravelMealPlanTask,
  PLANNING_CONTEXT_CONFLICT_RESOLUTIONS,
  reconcilePlanningContextAwayPeriods,
  reconcilePlanningContextConflicts,
  resolvePlanningContextConflict,
  savePlanningContext,
} = await import('../server/services/planning-contexts.js');
const { deleteTrip, saveTrip, tripItinerary } = await import('../server/services/trips.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

function buildDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of ALL_MIGRATIONS) {
    apply(database, migration);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const database = buildDatabase();
test.after(() => database.close());

function addUser(username, name, familyRole = 'parent') {
  return Number(database.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, 'x', 'member', ?)
  `).run(username, name, familyRole).lastInsertRowid);
}

function addPlace(name, type = 'custom') {
  return Number(database.prepare(`
    INSERT INTO places (name, type, active) VALUES (?, ?, 1)
  `).run(name, type).lastInsertRowid);
}

function addEvent({ title, start, end, allDay = false, assignedTo = null, participants = [] }) {
  const result = database.prepare(`
    INSERT INTO calendar_events (
      title, start_datetime, end_datetime, all_day, assigned_to, created_by,
      external_source, visibility
    ) VALUES (?, ?, ?, ?, ?, ?, 'local', 'all')
  `).run(title, start, end, allDay ? 1 : 0, assignedTo, admin);
  const eventId = Number(result.lastInsertRowid);
  const insertAssignment = database.prepare(`
    INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)
  `);
  for (const userId of participants) insertAssignment.run(eventId, userId);
  return eventId;
}

const admin = addUser('context-admin', 'Alex');
const sam = addUser('context-sam', 'Sam');
const child = addUser('context-child', 'Jamie', 'child');
const outsider = addUser('context-outsider', 'Morgan');
const beach = addPlace('Beach House', 'hotel');
const mountains = addPlace('Mountain Cabin', 'hotel');
const city = addPlace('City Hotel', 'hotel');

let sharedContextId;
let sharedTaskId;

test('Calendar Travel projection treats all-day end dates as inclusive and remains idempotent', () => {
  const firstEventId = addEvent({
    title: 'Beach travel',
    start: '2031-07-10',
    end: '2031-07-14',
    allDay: true,
    // assigned_to is deliberately not an Event assignment. The projection must
    // derive its group from event_assignments, not this legacy convenience field.
    assignedTo: outsider,
    participants: [admin, sam],
  });
  const first = saveCalendarTravelProjection(database, firstEventId, {
    destination_place_id: beach,
    lodging_place_id: beach,
    arrival_at_destination: '2031-07-10T15:00:00',
    return_departure_at: '2031-07-14T10:00:00',
    create_away_periods: true,
  }, admin);
  sharedContextId = Number(first.planning_context.id);
  assert.equal(first.event.event_kind, 'travel');
  assert.equal(first.planning_context.starts_at, '2031-07-10T00:00:00');
  assert.equal(first.planning_context.ends_at, '2031-07-15T00:00:00');
  assert.deepEqual(first.planning_context.member_ids.sort((a, b) => a - b), [admin, sam].sort((a, b) => a - b));
  assert.ok(!first.planning_context.member_ids.includes(outsider));

  const originalPeriods = database.prepare(`
    SELECT id, user_id FROM availability_periods
     WHERE note = ? ORDER BY user_id
  `).all(`Planning context:${sharedContextId}:travel`);
  assert.equal(originalPeriods.length, 2);
  const task = getTravelMealPlanTask(database, sharedContextId);
  sharedTaskId = Number(task.id);
  assert.equal(task.title, 'Create travel meal plan');
  assert.equal(task.assigned_to, null);
  assert.equal(task.assignment_state, 'open');
  assert.equal(task.action_path, '/meals');
  assert.deepEqual(task.eligible_user_ids.sort((a, b) => a - b), [admin, sam].sort((a, b) => a - b));
  assert.equal(task.action_params.mode, 'choices');
  assert.equal(task.action_params.context, sharedContextId);
  assert.equal(task.action_params.planning_context_id, sharedContextId);
  const taskApiRow = database.prepare('SELECT * FROM tasks WHERE id = ?').get(sharedTaskId);
  attachTaskActivityBindings(database, [taskApiRow]);
  assert.equal(taskApiRow.activity_template_id, null);
  assert.equal(taskApiRow.activity_assignment_policy, 'open_claimable');
  assert.equal(taskApiRow.activity_assignment_state, 'open');

  const repeated = saveCalendarTravelProjection(database, firstEventId, {
    destination_place_id: beach,
    lodging_place_id: beach,
    create_away_periods: true,
  }, admin);
  assert.equal(repeated.planning_context.id, sharedContextId);
  assert.equal(getTravelMealPlanTask(database, sharedContextId).id, sharedTaskId);
  assert.deepEqual(
    database.prepare('SELECT id FROM availability_periods WHERE note = ? ORDER BY user_id')
      .all(`Planning context:${sharedContextId}:travel`).map((row) => Number(row.id)),
    originalPeriods.map((row) => Number(row.id)),
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM task_action_links
     WHERE action_type = 'travel_meal_plan' AND source_type = 'planning_context' AND source_id = ?
  `).get(sharedContextId).n, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM planning_obligations
     WHERE logical_key = ?
  `).get(`planning-context:${sharedContextId}:travel-meal-plan`).n, 1);

  const relatedEventId = addEvent({
    title: 'Beach return segment',
    start: '2031-07-14T12:00:00',
    end: '2031-07-16T18:00:00',
    participants: [sam, child],
  });
  const related = saveCalendarTravelProjection(database, relatedEventId, {
    planning_context_id: sharedContextId,
    destination_place_id: beach,
    create_away_periods: true,
  }, admin);
  assert.equal(related.planning_context.id, sharedContextId);
  assert.equal(related.planning_context.ends_at, '2031-07-16T18:00:00');
  assert.deepEqual(
    related.planning_context.member_ids.sort((a, b) => a - b),
    [admin, sam, child].sort((a, b) => a - b),
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM planning_context_sources
     WHERE planning_context_id = ? AND source_type = 'calendar_event'
  `).get(sharedContextId).n, 2);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM planning_context_conflicts
     WHERE first_context_id = ? OR second_context_id = ?
  `).get(sharedContextId, sharedContextId).n, 0);
  assert.equal(getTravelMealPlanTask(database, sharedContextId).id, sharedTaskId);
});

test('overlapping distinct contexts create an unresolved conflict without choosing for the member', () => {
  const conflictingEventId = addEvent({
    title: 'Mountain travel',
    start: '2031-07-12T08:00:00',
    end: '2031-07-13T20:00:00',
    participants: [sam],
  });
  const conflicting = saveCalendarTravelProjection(database, conflictingEventId, {
    destination_place_id: mountains,
    create_away_periods: true,
  }, admin);
  const secondContextId = Number(conflicting.planning_context.id);
  assert.notEqual(secondContextId, sharedContextId);
  const conflict = database.prepare(`
    SELECT * FROM planning_context_conflicts
     WHERE user_id = ? AND status = 'open'
       AND (first_context_id = ? OR second_context_id = ?)
  `).get(sam, sharedContextId, sharedContextId);
  assert.ok(conflict);
  for (const contextId of [sharedContextId, secondContextId]) {
    const context = getPlanningContext(database, contextId);
    assert.equal(context.status, 'conflict');
    assert.equal(
      context.members.find((member) => Number(member.user_id) === sam)?.membership_status,
      'conflict',
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS n FROM availability_periods
       WHERE note = ? AND user_id = ?
    `).get(`Planning context:${contextId}:travel`, sam).n, 0);
    assert.ok(!getTravelMealPlanTask(database, contextId).eligible_user_ids.includes(sam));
  }

  assert.deepEqual(
    [...PLANNING_CONTEXT_CONFLICT_RESOLUTIONS].sort(),
    ['keep_first', 'keep_second'],
  );
  assert.throws(
    () => resolvePlanningContextConflict(database, conflict.id, 'allow_both', admin),
    /which planning context to keep/i,
  );
  assert.equal(database.prepare('SELECT status FROM planning_context_conflicts WHERE id = ?').get(conflict.id).status, 'open');

  // Upgrade compatibility: a historical allow-both resolution is reopened so
  // it cannot silently keep feeding both travel plans. Reproduce the old
  // derived state too: both contexts have an Away period and task eligibility.
  for (const contextId of [sharedContextId, secondContextId]) {
    database.prepare(`
      UPDATE planning_context_members
         SET membership_status = 'active'
       WHERE planning_context_id = ? AND user_id = ?
    `).run(contextId, sam);
    database.prepare("UPDATE planning_contexts SET status = 'active' WHERE id = ?").run(contextId);
    reconcilePlanningContextAwayPeriods(database, contextId, admin);
    ensureTravelMealPlanTask(database, contextId, admin);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS n FROM availability_periods
       WHERE note = ? AND user_id = ?
    `).get(`Planning context:${contextId}:travel`, sam).n, 1);
    assert.ok(getTravelMealPlanTask(database, contextId).eligible_user_ids.includes(sam));
  }
  database.prepare(`
    UPDATE planning_context_conflicts
       SET status = 'resolved', resolution = 'allow_both', resolved_by = ?,
           resolved_at = '2031-01-01T00:00:00Z'
     WHERE id = ?
  `).run(admin, conflict.id);
  reconcilePlanningContextConflicts(database);
  const reopened = database.prepare('SELECT * FROM planning_context_conflicts WHERE id = ?').get(conflict.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolution, null);
  assert.equal(reopened.resolved_by, null);
  for (const contextId of [sharedContextId, secondContextId]) {
    assert.equal(
      getPlanningContext(database, contextId).members
        .find((member) => Number(member.user_id) === sam).membership_status,
      'conflict',
    );
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS n FROM availability_periods
       WHERE note = ? AND user_id = ?
    `).get(`Planning context:${contextId}:travel`, sam).n, 0);
    assert.ok(!getTravelMealPlanTask(database, contextId).eligible_user_ids.includes(sam));
  }

  const resolution = Number(conflict.first_context_id) === sharedContextId ? 'keep_first' : 'keep_second';
  const resolved = resolvePlanningContextConflict(database, conflict.id, resolution, admin);
  assert.equal(resolved.status, 'resolved');
  assert.equal(
    getPlanningContext(database, sharedContextId).members
      .find((member) => Number(member.user_id) === sam).membership_status,
    'active',
  );
  assert.equal(
    getPlanningContext(database, secondContextId).members
      .find((member) => Number(member.user_id) === sam).membership_status,
    'released',
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods
     WHERE note = ? AND user_id = ?
  `).get(`Planning context:${sharedContextId}:travel`, sam).n, 1);
  assert.ok(getTravelMealPlanTask(database, sharedContextId).eligible_user_ids.includes(sam));
  assert.ok(!getTravelMealPlanTask(database, secondContextId).eligible_user_ids.includes(sam));
});

test('a home/travel overlap never creates a travel meal-plan Task for home', () => {
  const home = savePlanningContext(database, {
    context_key: 'test-home-2035',
    name: 'Home',
    context_type: 'home',
    starts_at: '2035-08-01T00:00:00',
    ends_at: '2035-08-31T00:00:00',
    member_ids: [outsider],
  }, admin);
  const travel = savePlanningContext(database, {
    context_key: 'test-travel-2035',
    name: 'City trip',
    context_type: 'travel',
    starts_at: '2035-08-10T08:00:00',
    ends_at: '2035-08-14T20:00:00',
    place_id: city,
    member_ids: [outsider],
  }, admin);
  const conflict = database.prepare(`
    SELECT * FROM planning_context_conflicts
     WHERE user_id = ? AND status = 'open'
       AND first_context_id IN (?, ?) AND second_context_id IN (?, ?)
  `).get(outsider, home.id, travel.id, home.id, travel.id);
  assert.ok(conflict);
  assert.equal(ensureTravelMealPlanTask(database, home.id, admin), null);
  assert.equal(getTravelMealPlanTask(database, home.id), null);
  assert.ok(ensureTravelMealPlanTask(database, travel.id, admin));

  const keepTravel = Number(conflict.first_context_id) === Number(travel.id)
    ? 'keep_first'
    : 'keep_second';
  resolvePlanningContextConflict(database, conflict.id, keepTravel, admin);
  assert.equal(getTravelMealPlanTask(database, home.id), null);
  assert.ok(getTravelMealPlanTask(database, travel.id));
});

test('standalone context eligibility claims atomically and retains claim audit', () => {
  assert.throws(() => claimTask(database, sharedTaskId, outsider), /not eligible/i);
  assert.equal(database.prepare('SELECT state FROM task_assignment_context WHERE task_id = ?').get(sharedTaskId).state, 'open');
  const claimed = claimTask(database, sharedTaskId, sam);
  assert.equal(claimed.assigned_to.id, sam);
  assert.equal(claimed.state, 'assigned');
  assert.throws(() => claimTask(database, sharedTaskId, admin), /already been claimed/i);
  assert.deepEqual(
    database.prepare(`
      SELECT role FROM task_responsibilities
       WHERE task_id = ? AND user_id = ? AND status = 'active' ORDER BY role
    `).all(sharedTaskId, sam).map((row) => row.role),
    ['participant', 'primary'],
  );
  const obligation = database.prepare(`
    SELECT * FROM planning_obligations WHERE task_id = ? AND role = 'primary'
  `).get(sharedTaskId);
  assert.equal(obligation.status, 'accepted');
  assert.equal(obligation.responsible_user_id, sam);
  assert.ok(database.prepare(`
    SELECT 1 FROM planning_obligation_events
     WHERE obligation_id = ? AND event = 'claimed' AND actor_user_id = ?
  `).get(obligation.id, sam));
});

test('a claimed travel planning Task supports eligibility-checked reassignment and audit', () => {
  assert.throws(
    () => overrideTaskAssignment(database, sharedTaskId, outsider, admin),
    /not eligible/i,
  );
  const reassigned = overrideTaskAssignment(database, sharedTaskId, admin, admin);
  assert.equal(reassigned.assigned_to.id, admin);
  assert.equal(database.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(sharedTaskId).assigned_to, admin);
  const current = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE task_id = ? AND role = 'primary' AND status = 'pending'
     ORDER BY attempt DESC LIMIT 1
  `).get(sharedTaskId);
  assert.equal(current.responsible_user_id, admin);
  assert.ok(database.prepare(`
    SELECT 1 FROM planning_obligation_events
     WHERE obligation_id = ? AND event = 'override_assigned' AND actor_user_id = ?
  `).get(current.id, admin));
});

test('Calendar Travel updates and removals reconcile one shared context without orphaned away periods', () => {
  const firstEventId = addEvent({
    title: 'Coast departure',
    start: '2033-05-01T08:00:00',
    end: '2033-05-03T18:00:00',
    participants: [admin, child],
  });
  const first = saveCalendarTravelProjection(database, firstEventId, {
    destination_place_id: beach,
    create_away_periods: true,
  }, admin);
  const contextId = Number(first.planning_context.id);
  const taskId = Number(first.planning_context && getTravelMealPlanTask(database, contextId).id);
  const secondEventId = addEvent({
    title: 'Coast return',
    start: '2033-05-03T12:00:00',
    end: '2033-05-05T20:00:00',
    participants: [admin, child],
  });
  saveCalendarTravelProjection(database, secondEventId, {
    planning_context_id: contextId,
    destination_place_id: beach,
    create_away_periods: true,
  }, admin);
  claimTask(database, taskId, child);

  database.prepare(`
    UPDATE calendar_events
       SET start_datetime = '2033-05-02T09:00:00', end_datetime = '2033-05-04T19:00:00'
     WHERE id = ?
  `).run(firstEventId);
  database.prepare('DELETE FROM event_assignments WHERE event_id = ? AND user_id = ?')
    .run(firstEventId, child);
  saveCalendarTravelProjection(database, firstEventId, {
    destination_place_id: beach,
    create_away_periods: true,
  }, admin);
  const updated = getPlanningContext(database, contextId);
  assert.equal(updated.starts_at, '2033-05-02T09:00:00');
  assert.equal(updated.ends_at, '2033-05-05T20:00:00');
  // Child still belongs to the shared context through the related return Event.
  assert.ok(updated.member_ids.includes(child));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods WHERE note = ?
  `).get(`Planning context:${contextId}:travel`).n, 2);

  const firstRemoval = removeCalendarTravelProjection(database, firstEventId, admin);
  assert.equal(firstRemoval.removed, true);
  assert.equal(database.prepare('SELECT event_kind FROM calendar_events WHERE id = ?').get(firstEventId).event_kind, 'general');
  assert.equal(getPlanningContext(database, contextId).status, 'active');
  assert.equal(getPlanningContext(database, contextId).starts_at, '2033-05-03T12:00:00');
  assert.equal(getTravelMealPlanTask(database, contextId).id, taskId);

  const finalRemoval = removeCalendarTravelProjection(database, secondEventId, admin);
  assert.equal(finalRemoval.removed, true);
  assert.equal(getPlanningContext(database, contextId).status, 'cancelled');
  assert.deepEqual(getPlanningContext(database, contextId).member_ids, []);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods WHERE note = ?
  `).get(`Planning context:${contextId}:travel`).n, 0);
  assert.equal(database.prepare('SELECT state FROM task_assignment_context WHERE task_id = ?').get(taskId).state, 'cancelled');
  assert.equal(database.prepare(`
    SELECT status FROM planning_obligations WHERE task_id = ? AND role = 'primary'
  `).get(taskId).status, 'cancelled');
  assert.deepEqual(database.prepare(`
    SELECT DISTINCT status FROM task_responsibilities WHERE task_id = ? ORDER BY status
  `).all(taskId).map((row) => row.status), ['cancelled']);
  assert.equal(removeCalendarTravelProjection(database, secondEventId, admin).removed, false);
});

test('Trips project into a context and preserve one claimable meal-plan Task across edits', () => {
  const trip = saveTrip(database, {
    name: 'City break',
    trip_type: 'vacation',
    status: 'planning',
    participant_ids: [admin, outsider],
    destination_place_id: city,
    lodging_place_id: city,
    starts_at: '2032-03-10T09:00:00',
    ends_at: '2032-03-13T18:00:00',
    create_away_periods: true,
  }, admin);
  assert.ok(trip.planning_context_id);
  assert.equal(trip.travel_meal_plan_task.assigned_to, null);
  assert.equal(trip.travel_meal_plan_task.assignment_state, 'open');
  assert.deepEqual(
    trip.travel_meal_plan_task.eligible_user_ids.sort((a, b) => a - b),
    [admin, outsider].sort((a, b) => a - b),
  );
  const taskId = Number(trip.travel_meal_plan_task.id);
  database.prepare("UPDATE tasks SET due_date = '2032-02-20' WHERE id = ?").run(taskId);

  const updated = saveTrip(database, {
    name: 'City break updated',
    starts_at: '2032-03-11T09:00:00',
    ends_at: '2032-03-14T18:00:00',
    destination_place_id: city,
    lodging_place_id: city,
    status: 'planning',
    trip_type: 'vacation',
    create_away_periods: true,
  }, admin, trip.id);
  assert.equal(updated.travel_meal_plan_task.id, taskId);
  assert.equal(database.prepare('SELECT due_date FROM tasks WHERE id = ?').get(taskId).due_date, '2032-02-20');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM task_action_links
     WHERE source_type = 'planning_context' AND source_id = ? AND action_type = 'travel_meal_plan'
  `).get(trip.planning_context_id).n, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods WHERE note = ?
  `).get(`Planning context:${trip.planning_context_id}:travel`).n, 2);

  assert.equal(deleteTrip(database, trip.id), 1);
  assert.equal(getPlanningContext(database, trip.planning_context_id).status, 'cancelled');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods WHERE note = ?
  `).get(`Planning context:${trip.planning_context_id}:travel`).n, 0);
  assert.equal(database.prepare('SELECT state FROM task_assignment_context WHERE task_id = ?').get(taskId).state, 'cancelled');
});

test('Trip itinerary includes only meals and Calendar Events from its planning context', () => {
  const trip = saveTrip(database, {
    name: 'Context-filtered journey',
    trip_type: 'family',
    status: 'planning',
    participant_ids: [admin, child],
    destination_place_id: city,
    starts_at: '2034-06-10T08:00:00',
    ends_at: '2034-06-13T20:00:00',
    create_away_periods: true,
  }, admin);
  const linkedEventId = addEvent({
    title: 'Return train',
    start: '2034-06-13T15:00:00',
    end: '2034-06-13T20:00:00',
    participants: [admin, child],
  });
  saveCalendarTravelProjection(database, linkedEventId, {
    planning_context_id: trip.planning_context_id,
    destination_place_id: city,
  }, admin);
  const unrelatedEventId = addEvent({
    title: 'Unrelated appointment',
    start: '2034-06-11T10:00:00',
    end: '2034-06-11T11:00:00',
    participants: [admin],
  });
  const contextMealId = Number(database.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by, planning_context_id)
    VALUES ('2034-06-11', 'dinner', 'Travel dinner', ?, ?)
  `).run(admin, trip.planning_context_id).lastInsertRowid);
  const householdMealId = Number(database.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by)
    VALUES ('2034-06-11', 'dinner', 'Home dinner', ?)
  `).run(admin).lastInsertRowid);

  const itinerary = tripItinerary(database, trip.id);
  const events = Object.values(itinerary.days).flatMap((day) => day.events);
  const meals = Object.values(itinerary.days).flatMap((day) => day.meals);
  assert.ok(events.some((event) => Number(event.id) === linkedEventId));
  assert.ok(!events.some((event) => Number(event.id) === unrelatedEventId));
  assert.ok(meals.some((meal) => Number(meal.id) === contextMealId));
  assert.ok(!meals.some((meal) => Number(meal.id) === householdMealId));
});

test('Calendar travel detail reads remain separate from Tasks', () => {
  const eventProjection = database.prepare(`
    SELECT calendar_event_id FROM calendar_travel_details WHERE planning_context_id = ? ORDER BY calendar_event_id LIMIT 1
  `).get(sharedContextId);
  const projection = getCalendarTravelProjection(database, eventProjection.calendar_event_id);
  assert.ok(projection.event);
  assert.ok(projection.details);
  assert.equal(projection.details.calendar_event_id, projection.event.id);
  assert.equal(projection.details.planning_context_id, sharedContextId);
  const action = database.prepare(`
    SELECT * FROM task_action_links WHERE task_id = ?
  `).get(sharedTaskId);
  assert.equal(action.source_type, 'planning_context');
  assert.equal(action.source_id, sharedContextId);
  assert.equal(action.action_type, 'travel_meal_plan');
});
