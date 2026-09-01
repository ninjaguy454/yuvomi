import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

process.env.SESSION_SECRET ??= 'calendar-travel-route-test-secret';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const dbmod = await import('../server/db.js');
const { default: calendarRouter } = await import('../server/routes/calendar.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: planningRouter } = await import('../server/routes/planning.js');
const database = dbmod.get();

const ADMIN = { id: 1, role: 'admin' };
const SAM = { id: 2, role: 'member' };
const JAMIE = { id: 3, role: 'member' };

database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES (?, ?, 'x', ?, ?)
`).run('travel-route-admin', 'Alex', 'admin', 'parent');
database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES (?, ?, 'x', ?, ?)
`).run('travel-route-sam', 'Sam', 'member', 'parent');
database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES (?, ?, 'x', ?, ?)
`).run('travel-route-jamie', 'Jamie', 'member', 'child');

function addPlace(name, active = 1) {
  return Number(database.prepare(`
    INSERT INTO places (name, type, active) VALUES (?, 'hotel', ?)
  `).run(name, active).lastInsertRowid);
}

const BEACH = addPlace('Route Test Beach House');
const MOUNTAINS = addPlace('Route Test Mountain Cabin');
const INACTIVE = addPlace('Route Test Closed Hotel', 0);

let actor = ADMIN;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/planning', planningRouter);
app.use('/meals', mealsRouter);
app.use('/', calendarRouter);

const server = app.listen(0);
const baseUrl = await new Promise((resolve) => {
  server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
test.after(() => server.close());

async function call(method, route, { as = ADMIN, body } = {}) {
  actor = as;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  if (contentType.includes('application/json')) payload = await response.json();
  return { status: response.status, body: payload };
}

function travelBody(overrides = {}) {
  return {
    title: 'Route Test Travel Event',
    start_datetime: '2040-09-10T08:00:00',
    end_datetime: '2040-09-12T20:00:00',
    assigned_to: [ADMIN.id, SAM.id],
    event_kind: 'travel',
    travel_details: {
      destination_place_id: BEACH,
      lodging_place_id: BEACH,
      arrival_at_destination: '2040-09-10T15:00:00',
      return_departure_at: '2040-09-12T12:00:00',
      create_away_periods: true,
    },
    ...overrides,
  };
}

function assertMealPlanPath(details, contextId, week = '2040-09-10') {
  assert.ok(details.meal_plan_task_id);
  assert.equal(details.meal_plan_task_state, 'open');
  assert.ok(details.meal_plan_path);
  const target = new URL(details.meal_plan_path, 'http://yuvomi.test');
  assert.equal(target.pathname, '/meals');
  assert.equal(target.searchParams.get('week'), week);
  assert.equal(target.searchParams.get('mode'), 'choices');
  assert.equal(target.searchParams.get('context'), String(contextId));
  assert.equal(target.searchParams.get('planning_context_id'), String(contextId));
}

test('Calendar Travel HTTP lifecycle preserves one shared context and reconciles generalization/deletion', async () => {
  const created = await call('POST', '/', { body: travelBody() });
  assert.equal(created.status, 201, created.body?.error);
  const firstEventId = Number(created.body.data.id);
  const contextId = Number(created.body.data.travel_details.planning_context_id);
  assert.equal(created.body.data.event_kind, 'travel');
  assert.deepEqual(
    [...created.body.data.travel_details.participant_ids].sort((a, b) => a - b),
    [ADMIN.id, SAM.id],
  );
  assertMealPlanPath(created.body.data.travel_details, contextId);

  const fetched = await call('GET', `/${firstEventId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.travel_details.planning_context_id, contextId);
  assertMealPlanPath(fetched.body.data.travel_details, contextId);

  const listed = await call('GET', '/?from=2040-09-01&to=2040-09-30');
  assert.equal(listed.status, 200);
  const firstFromList = listed.body.data.find((event) => Number(event.id) === firstEventId);
  assert.ok(firstFromList);
  assert.equal(firstFromList.travel_details.planning_context_id, contextId);
  assertMealPlanPath(firstFromList.travel_details, contextId);

  const related = await call('POST', '/', {
    body: travelBody({
      title: 'Route Test Return Segment',
      start_datetime: '2040-09-12T12:00:00',
      end_datetime: '2040-09-15T21:00:00',
      assigned_to: [SAM.id, JAMIE.id],
      travel_details: {
        planning_context_id: contextId,
        destination_place_id: BEACH,
        lodging_place_id: BEACH,
        return_arrival_at_home: '2040-09-15T21:00:00',
        create_away_periods: true,
      },
    }),
  });
  assert.equal(related.status, 201, related.body?.error);
  const secondEventId = Number(related.body.data.id);
  assert.equal(related.body.data.travel_details.planning_context_id, contextId);
  assert.deepEqual(
    database.prepare(`
      SELECT user_id FROM planning_context_members
       WHERE planning_context_id = ? AND membership_status = 'active'
       ORDER BY user_id
    `).all(contextId).map((row) => Number(row.user_id)),
    [ADMIN.id, SAM.id, JAMIE.id],
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM planning_context_conflicts
     WHERE first_context_id = ? OR second_context_id = ?
  `).get(contextId, contextId).n, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM task_action_links
     WHERE source_type = 'planning_context' AND source_id = ?
       AND action_type = 'travel_meal_plan'
  `).get(contextId).n, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods
     WHERE note = ?
  `).get(`Planning context:${contextId}:travel`).n, 3);

  const mismatchedDestination = await call('PUT', `/${secondEventId}`, {
    body: {
      event_kind: 'travel',
      travel_details: {
        planning_context_id: contextId,
        destination_place_id: MOUNTAINS,
      },
    },
  });
  assert.equal(mismatchedDestination.status, 400);
  assert.match(mismatchedDestination.body.error, /destination Place/i);
  assert.equal(
    database.prepare('SELECT destination_place_id FROM calendar_travel_details WHERE calendar_event_id = ?')
      .get(secondEventId).destination_place_id,
    BEACH,
  );

  const updated = await call('PUT', `/${secondEventId}`, {
    body: {
      start_datetime: '2040-09-13T09:00:00',
      end_datetime: '2040-09-16T19:00:00',
      assigned_to: [SAM.id],
      event_kind: 'travel',
      travel_details: {
        planning_context_id: contextId,
        destination_place_id: BEACH,
        lodging_place_id: BEACH,
        return_arrival_at_home: '2040-09-16T19:00:00',
        create_away_periods: true,
      },
    },
  });
  assert.equal(updated.status, 200, updated.body?.error);
  assert.equal(updated.body.data.travel_details.return_arrival_at_home, '2040-09-16T19:00:00');
  const contextAfterUpdate = database.prepare('SELECT * FROM planning_contexts WHERE id = ?').get(contextId);
  assert.equal(new Date(contextAfterUpdate.starts_at).toISOString(), '2040-09-10T08:00:00.000Z');
  assert.equal(contextAfterUpdate.ends_at, '2040-09-16T19:00:00');
  assert.deepEqual(
    database.prepare(`
      SELECT user_id FROM planning_context_members
       WHERE planning_context_id = ? AND membership_status = 'active'
       ORDER BY user_id
    `).all(contextId).map((row) => Number(row.user_id)),
    [ADMIN.id, SAM.id],
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods WHERE note = ?
  `).get(`Planning context:${contextId}:travel`).n, 2);

  const generalized = await call('PUT', `/${secondEventId}`, {
    body: { event_kind: 'general' },
  });
  assert.equal(generalized.status, 200);
  assert.equal(generalized.body.data.event_kind, 'general');
  assert.equal(Object.hasOwn(generalized.body.data, 'travel_details'), false);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM calendar_travel_details WHERE calendar_event_id = ?
  `).get(secondEventId).n, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM planning_context_sources
     WHERE source_type = 'calendar_event' AND source_id = ?
  `).get(secondEventId).n, 0);
  assert.equal(database.prepare('SELECT status FROM planning_contexts WHERE id = ?').get(contextId).status, 'active');

  const plan = await call('POST', '/meals/plans', {
    body: {
      name: 'Route Test Travel Meals',
      effective_from: '2040-09-01',
      effective_until: '2040-09-30',
      rules: [{
        weekday: 0,
        meal_type: 'dinner',
        policy: 'fixed',
        fixed_user_id: SAM.id,
        participant_ids: [ADMIN.id, SAM.id],
      }],
    },
  });
  assert.equal(plan.status, 201, plan.body?.error);
  const planId = Number(plan.body.data.id);
  const attached = await call('PUT', `/meals/plans/${planId}/contexts/${contextId}`, {
    body: { is_primary: true },
  });
  assert.equal(attached.status, 200, attached.body?.error);
  const materialized = await call(
    'GET',
    `/meals/week-model?start=2040-09-10&end=2040-09-10&planning_context_id=${contextId}`,
  );
  assert.equal(materialized.status, 200, materialized.body?.error);
  const travelMeal = database.prepare(`
    SELECT m.*, oa.assigned_user_id
      FROM meals m
      JOIN meal_occurrence_assignments oa ON oa.meal_id = m.id
     WHERE m.planning_context_id = ? AND m.meal_plan_id = ? AND m.date = '2040-09-10'
  `).get(contextId, planId);
  assert.ok(travelMeal, 'the context Meal occurrence was materialized');
  assert.equal(Number(travelMeal.assigned_user_id), SAM.id);
  const travelChoice = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND status IN ('pending', 'accepted')
  `).get(travelMeal.id);
  assert.ok(travelChoice, 'the travel Meal has a live chooser request before cancellation');

  const deleted = await call('DELETE', `/${firstEventId}`);
  assert.equal(deleted.status, 204);
  assert.equal((await call('GET', `/${firstEventId}`)).status, 404);
  assert.equal(database.prepare('SELECT status FROM planning_contexts WHERE id = ?').get(contextId).status, 'cancelled');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM planning_context_sources WHERE planning_context_id = ?
  `).get(contextId).n, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM availability_periods WHERE note = ?
  `).get(`Planning context:${contextId}:travel`).n, 0);
  const taskState = database.prepare(`
    SELECT tac.state
      FROM task_action_links tal
      JOIN task_assignment_context tac ON tac.task_id = tal.task_id
     WHERE tal.source_type = 'planning_context' AND tal.source_id = ?
       AND tal.action_type = 'travel_meal_plan'
  `).get(contextId);
  assert.equal(taskState.state, 'cancelled');
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?')
    .get(travelChoice.id).status, 'superseded');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n
      FROM planning_obligations o
      JOIN meals m ON m.id = o.entity_id AND o.entity_type = 'meal'
     WHERE m.planning_context_id = ? AND o.role = 'chooser'
       AND o.status IN ('pending', 'accepted')
  `).get(contextId).n, 0, 'cancelling travel cannot invoke chooser fallback');
  assert.equal(database.prepare(`
    SELECT assigned_user_id FROM meal_occurrence_assignments WHERE meal_id = ?
  `).get(travelMeal.id).assigned_user_id, SAM.id, 'historical assignment remains auditable');
  assert.ok(database.prepare(`
    SELECT 1 FROM planning_obligation_events
     WHERE obligation_id = ? AND event = 'meal_choice_request_superseded'
  `).get(travelChoice.id));

  const staleContextChoiceId = Number(database.prepare(`
    INSERT INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id,
      due_at, response_deadline, status
    ) VALUES ('meal', ?, ?, 'chooser', ?, '2040-09-09T18:00:00Z',
              '2040-09-09T18:00:00Z', 'pending')
  `).run(
    travelMeal.id,
    `legacy-cancelled-travel:${contextId}:chooser`,
    SAM.id,
  ).lastInsertRowid);
  const orphanChoiceId = Number(database.prepare(`
    INSERT INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id,
      due_at, response_deadline, status
    ) VALUES ('meal', 987654321, ?, 'chooser', ?, '2020-01-01T00:00:00Z',
              '2020-01-01T00:00:00Z', 'pending')
  `).run(`legacy-orphan-meal:${contextId}:chooser`, ADMIN.id).lastInsertRowid);
  const homeMealId = Number(database.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by, selection_status)
    VALUES ('2040-09-10', 'lunch', 'Still actionable at home', ?, 'awaiting_choice')
  `).run(ADMIN.id).lastInsertRowid);
  const homeChoiceId = Number(database.prepare(`
    INSERT INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id,
      due_at, response_deadline, status
    ) VALUES ('meal', ?, ?, 'chooser', ?, '2040-09-10T11:00:00Z',
              '2040-09-10T11:00:00Z', 'pending')
  `).run(homeMealId, `active-home-meal:${contextId}:chooser`, ADMIN.id).lastInsertRowid);
  const inbox = await call('GET', '/meals/selection-requests-household');
  assert.equal(inbox.status, 200, inbox.body?.error);
  const inboxIds = inbox.body.data.map((row) => Number(row.id));
  assert.ok(inboxIds.includes(homeChoiceId));
  assert.ok(!inboxIds.includes(staleContextChoiceId));
  assert.ok(!inboxIds.includes(orphanChoiceId));
  assert.deepEqual(database.prepare(`
    SELECT id, status FROM planning_obligations WHERE id IN (?, ?) ORDER BY id
  `).all(staleContextChoiceId, orphanChoiceId), [
    { id: staleContextChoiceId, status: 'superseded' },
    { id: orphanChoiceId, status: 'superseded' },
  ]);
  const repeatedInbox = await call('GET', '/meals/selection-requests-household');
  assert.equal(repeatedInbox.status, 200, repeatedInbox.body?.error);
  assert.deepEqual(database.prepare(`
    SELECT obligation_id, COUNT(*) AS n
      FROM planning_obligation_events
     WHERE obligation_id IN (?, ?) AND event = 'meal_choice_request_superseded'
     GROUP BY obligation_id ORDER BY obligation_id
  `).all(staleContextChoiceId, orphanChoiceId), [
    { obligation_id: staleContextChoiceId, n: 1 },
    { obligation_id: orphanChoiceId, n: 1 },
  ], 'legacy cleanup remains idempotent across repeated inbox reads');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('Calendar Travel HTTP validation rejects recurrence, missing/invalid destination, and no travelers', async () => {
  const invalidCases = [
    {
      label: 'recurring Travel Event',
      body: travelBody({
        title: 'Invalid Recurring Travel',
        start_datetime: '2041-01-01T08:00:00',
        end_datetime: '2041-01-02T20:00:00',
        recurrence_rule: 'FREQ=DAILY;COUNT=2',
      }),
      pattern: /explicit dated window|recurring rule/i,
    },
    {
      label: 'missing destination',
      body: travelBody({
        title: 'Invalid Destination-Free Travel',
        start_datetime: '2041-02-01T08:00:00',
        end_datetime: '2041-02-02T20:00:00',
        travel_details: {},
      }),
      pattern: /destination Place.*required/i,
    },
    {
      label: 'inactive destination',
      body: travelBody({
        title: 'Invalid Inactive Destination Travel',
        start_datetime: '2041-03-01T08:00:00',
        end_datetime: '2041-03-02T20:00:00',
        travel_details: { destination_place_id: INACTIVE },
      }),
      pattern: /active destination Place/i,
    },
    {
      label: 'Travel Event without travelers',
      body: travelBody({
        title: 'Invalid Traveler-Free Travel',
        start_datetime: '2041-04-01T08:00:00',
        end_datetime: '2041-04-02T20:00:00',
        assigned_to: [],
      }),
      pattern: /at least one traveler/i,
    },
  ];

  for (const invalid of invalidCases) {
    const response = await call('POST', '/', { body: invalid.body });
    assert.equal(response.status, 400, invalid.label);
    assert.match(response.body.error, invalid.pattern, invalid.label);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE title = ?')
      .get(invalid.body.title).n, 0, `${invalid.label} rolled back the Event row`);
  }
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('distinct overlapping Travel Events stay separate until an administrator keeps one context', async () => {
  const beachTrip = await call('POST', '/', {
    body: travelBody({
      title: 'Explicit Beach Trip',
      start_datetime: '2042-05-10T08:00:00',
      end_datetime: '2042-05-14T20:00:00',
      assigned_to: [SAM.id],
      travel_details: {
        destination_place_id: BEACH,
        lodging_place_id: BEACH,
        create_away_periods: true,
      },
    }),
  });
  assert.equal(beachTrip.status, 201, beachTrip.body?.error);
  const beachContextId = Number(beachTrip.body.data.travel_details.planning_context_id);

  const mountainTrip = await call('POST', '/', {
    body: travelBody({
      title: 'Explicit Mountain Trip',
      start_datetime: '2042-05-12T09:00:00',
      end_datetime: '2042-05-13T18:00:00',
      assigned_to: [SAM.id],
      travel_details: {
        destination_place_id: MOUNTAINS,
        lodging_place_id: MOUNTAINS,
        create_away_periods: true,
      },
    }),
  });
  assert.equal(mountainTrip.status, 201, mountainTrip.body?.error);
  const mountainContextId = Number(mountainTrip.body.data.travel_details.planning_context_id);
  assert.notEqual(mountainContextId, beachContextId);
  assert.equal(mountainTrip.body.data.travel_details.context_status, 'conflict');
  assert.equal(mountainTrip.body.data.travel_details.context_conflicts.length, 1);
  const embeddedConflict = mountainTrip.body.data.travel_details.context_conflicts[0];
  assert.equal(embeddedConflict.status, 'open');
  assert.ok(embeddedConflict.first_context_starts_at);
  assert.ok(embeddedConflict.first_context_ends_at);
  assert.ok(embeddedConflict.second_context_starts_at);
  assert.ok(embeddedConflict.second_context_ends_at);
  assert.deepEqual(
    [embeddedConflict.first_context_place_name, embeddedConflict.second_context_place_name].sort(),
    ['Route Test Beach House', 'Route Test Mountain Cabin'].sort(),
  );

  const conflicts = await call('GET', '/planning/context-conflicts');
  assert.equal(conflicts.status, 200, conflicts.body?.error);
  const conflict = conflicts.body.data.find((row) => (
    Number(row.user_id) === SAM.id
    && [Number(row.first_context_id), Number(row.second_context_id)].includes(beachContextId)
    && [Number(row.first_context_id), Number(row.second_context_id)].includes(mountainContextId)
  ));
  assert.ok(conflict);

  const allowBoth = await call('POST', `/planning/admin/context-conflicts/${conflict.id}/resolve`, {
    body: { resolution: 'allow_both' },
  });
  assert.equal(allowBoth.status, 400);
  assert.match(allowBoth.body.error, /which planning context to keep/i);
  assert.equal(database.prepare('SELECT status FROM planning_context_conflicts WHERE id = ?').get(conflict.id).status, 'open');

  // Calendar loads this endpoint on entry. It is also the upgrade/read-path
  // trigger that reopens a historical allow-both decision before rendering.
  database.prepare(`
    UPDATE planning_context_conflicts
       SET status = 'resolved', resolution = 'allow_both', resolved_by = ?,
           resolved_at = '2042-01-01T00:00:00Z'
     WHERE id = ?
  `).run(ADMIN.id, conflict.id);
  database.prepare(`
    UPDATE planning_context_members
       SET membership_status = 'active'
     WHERE user_id = ? AND planning_context_id IN (?, ?)
  `).run(SAM.id, beachContextId, mountainContextId);
  database.prepare(`
    UPDATE planning_contexts SET status = 'active' WHERE id IN (?, ?)
  `).run(beachContextId, mountainContextId);
  const contextsAfterUpgrade = await call('GET', '/planning/contexts');
  assert.equal(contextsAfterUpgrade.status, 200, contextsAfterUpgrade.body?.error);
  const reopened = database.prepare('SELECT * FROM planning_context_conflicts WHERE id = ?').get(conflict.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolution, null);
  assert.deepEqual(
    database.prepare(`
      SELECT membership_status FROM planning_context_members
       WHERE user_id = ? AND planning_context_id IN (?, ?)
       ORDER BY planning_context_id
    `).all(SAM.id, beachContextId, mountainContextId).map((row) => row.membership_status),
    ['conflict', 'conflict'],
  );

  const resolution = Number(conflict.first_context_id) === beachContextId
    ? 'keep_first'
    : 'keep_second';
  const resolved = await call('POST', `/planning/admin/context-conflicts/${conflict.id}/resolve`, {
    body: { resolution },
  });
  assert.equal(resolved.status, 200, resolved.body?.error);
  assert.equal(resolved.body.data.status, 'resolved');
  assert.equal(database.prepare(`
    SELECT membership_status FROM planning_context_members
     WHERE planning_context_id = ? AND user_id = ?
  `).get(beachContextId, SAM.id).membership_status, 'active');
  assert.equal(database.prepare(`
    SELECT membership_status FROM planning_context_members
     WHERE planning_context_id = ? AND user_id = ?
  `).get(mountainContextId, SAM.id).membership_status, 'released');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});
