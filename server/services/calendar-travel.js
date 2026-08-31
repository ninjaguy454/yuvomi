import {
  attachPlanningContextSource,
  detachPlanningContextSource,
  getPlanningContext,
  getTravelMealPlanTask,
  reconcileTravelPlanningContext,
  savePlanningContext,
} from './planning-contexts.js';

export class CalendarTravelValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalendarTravelValidationError';
  }
}

function atomic(database, work) {
  return database.inTransaction ? work() : database.transaction(work)();
}

function positiveId(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new CalendarTravelValidationError(`${field} is required.`);
    return null;
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new CalendarTravelValidationError(`${field} is invalid.`);
  return id;
}

function optionalTimestamp(value, field, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const result = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new CalendarTravelValidationError(`${field} is invalid.`);
  }
  return result;
}

function activePlace(database, value, field, { required = false } = {}) {
  const id = positiveId(value, field, { required });
  if (id && !database.prepare('SELECT 1 FROM places WHERE id = ? AND active = 1').get(id)) {
    throw new CalendarTravelValidationError(`Choose an active ${field}.`);
  }
  return id;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function calendarTravelWindow(event) {
  if (!event?.start_datetime) throw new CalendarTravelValidationError('Travel Event not found.');
  if (event.all_day) {
    const startDate = String(event.start_datetime).slice(0, 10);
    const inclusiveEndDate = String(event.end_datetime || event.start_datetime).slice(0, 10);
    return {
      startsAt: `${startDate}T00:00:00`,
      endsAt: `${addDays(inclusiveEndDate, 1)}T00:00:00`,
    };
  }
  if (!event.end_datetime) throw new CalendarTravelValidationError('A Travel Event needs a return date or time.');
  const startsAt = String(event.start_datetime);
  const endsAt = String(event.end_datetime);
  if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) {
    throw new CalendarTravelValidationError('Travel Event dates are invalid.');
  }
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new CalendarTravelValidationError('Travel Event return must be after departure.');
  return { startsAt, endsAt };
}

function sourceKey(eventId) {
  return `calendar-event:${eventId}`;
}

function eventMemberIds(database, eventId) {
  return database.prepare(`
    SELECT ea.user_id
      FROM event_assignments ea
      JOIN users u ON u.id = ea.user_id
     WHERE ea.event_id = ?
     ORDER BY ea.user_id
  `).all(eventId).map((row) => Number(row.user_id));
}

function eventRow(database, eventId) {
  return database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId) || null;
}

export function getCalendarTravelProjection(database, eventId) {
  const id = positiveId(eventId, 'Calendar Event', { required: true });
  const event = eventRow(database, id);
  if (!event) return null;
  const details = database.prepare(`
    SELECT ctd.*, dp.name AS destination_name, lp.name AS lodging_name
      FROM calendar_travel_details ctd
      LEFT JOIN places dp ON dp.id = ctd.destination_place_id
      LEFT JOIN places lp ON lp.id = ctd.lodging_place_id
     WHERE ctd.calendar_event_id = ?
  `).get(id) || null;
  return {
    event,
    details,
    participant_ids: eventMemberIds(database, id),
    planning_context: details?.planning_context_id
      ? getPlanningContext(database, details.planning_context_id)
      : null,
    meal_plan_task: details?.planning_context_id
      ? getTravelMealPlanTask(database, details.planning_context_id)
      : null,
  };
}

function taskPath(task) {
  if (!task?.action_path) return null;
  const params = task.action_params && typeof task.action_params === 'object'
    ? task.action_params
    : {};
  const query = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${task.action_path}?${query}` : task.action_path;
}

/**
 * Stable Calendar API projection.  Calendar Events remain Calendar Events;
 * this is only the explicit travel/planning metadata attached to one Event.
 */
export function getCalendarTravelDetails(database, eventId) {
  const projection = getCalendarTravelProjection(database, eventId);
  if (!projection?.details) return null;
  const context = projection.planning_context;
  const task = projection.meal_plan_task;
  return {
    ...projection.details,
    participant_ids: projection.participant_ids,
    context_name: context?.name || null,
    context_key: context?.context_key || null,
    context_status: context?.status || null,
    context_conflicts: context?.conflicts || [],
    meal_plan_task_id: task?.id || null,
    meal_plan_task_state: task?.assignment_state || null,
    meal_plan_path: taskPath(task),
  };
}

export function saveCalendarTravelProjection(database, eventId, body = {}, actorId = null) {
  const id = positiveId(eventId, 'Calendar Event', { required: true });
  return atomic(database, () => {
    const event = eventRow(database, id);
    if (!event) throw new CalendarTravelValidationError('Calendar Event not found.');
    if (event.recurrence_rule) throw new CalendarTravelValidationError('A Travel Event must use an explicit dated window, not a recurring rule.');
    const participantIds = eventMemberIds(database, id);
    if (!participantIds.length) throw new CalendarTravelValidationError('Choose at least one traveler for the Travel Event.');
    const window = calendarTravelWindow(event);
    const existingDetails = database.prepare('SELECT * FROM calendar_travel_details WHERE calendar_event_id = ?').get(id);
    const existingSource = database.prepare(`
      SELECT * FROM planning_context_sources
       WHERE source_type = 'calendar_event' AND source_key = ?
    `).get(sourceKey(id));
    const requestedContextValue = body.planning_context_id ?? body.planningContextId ?? null;
    const requestedContextId = requestedContextValue === null || requestedContextValue === ''
      ? null
      : positiveId(requestedContextValue, 'Planning context', { required: true });
    const previousContextId = Number(existingDetails?.planning_context_id || existingSource?.planning_context_id || 0) || null;
    let contextId = requestedContextId || previousContextId;
    let context = contextId ? getPlanningContext(database, contextId) : null;
    if (contextId && !context) throw new CalendarTravelValidationError('Planning context not found.');
    if (context && context.context_type !== 'travel') throw new CalendarTravelValidationError('A Travel Event must link to a travel planning context.');

    const destinationPlaceId = activePlace(
      database,
      body.destination_place_id ?? body.destinationPlaceId
        ?? existingDetails?.destination_place_id ?? event.place_id ?? context?.place_id,
      'destination Place',
      { required: true },
    );
    if (context?.place_id && Number(context.place_id) !== destinationPlaceId) {
      throw new CalendarTravelValidationError('Related Travel Events in one planning context must share the same destination Place.');
    }
    const lodgingPlaceId = activePlace(
      database,
      body.lodging_place_id ?? body.lodgingPlaceId ?? existingDetails?.lodging_place_id,
      'lodging Place',
    );
    const arrivalAtDestination = optionalTimestamp(
      body.arrival_at_destination ?? body.arrivalAtDestination,
      'Arrival at destination',
      existingDetails?.arrival_at_destination || null,
    );
    const returnDepartureAt = optionalTimestamp(
      body.return_departure_at ?? body.returnDepartureAt,
      'Return departure',
      existingDetails?.return_departure_at || null,
    );
    const returnArrivalAtHome = optionalTimestamp(
      body.return_arrival_at_home ?? body.returnArrivalAtHome,
      'Return arrival at home',
      existingDetails?.return_arrival_at_home || null,
    );
    const createAwayPeriods = body.create_away_periods === undefined
      ? Boolean(existingDetails?.create_away_periods ?? true)
      : body.create_away_periods === true;
    const creatorId = positiveId(actorId || event.created_by, 'Travel Event creator', { required: true });

    if (!contextId) {
      context = savePlanningContext(database, {
        context_key: body.context_key || `calendar-travel:${id}`,
        name: body.context_name || event.title,
        context_type: 'travel',
        starts_at: window.startsAt,
        ends_at: window.endsAt,
        place_id: destinationPlaceId,
        member_ids: participantIds,
      }, creatorId);
      contextId = Number(context.id);
    }

    if (previousContextId && previousContextId !== contextId && !requestedContextId) {
      throw new CalendarTravelValidationError('Moving a Travel Event to another planning context must be explicit.');
    }
    database.prepare("UPDATE calendar_events SET event_kind = 'travel' WHERE id = ?").run(id);
    database.prepare(`
      INSERT INTO calendar_travel_details (
        calendar_event_id, planning_context_id, destination_place_id, lodging_place_id,
        arrival_at_destination, return_departure_at, return_arrival_at_home,
        create_away_periods, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(calendar_event_id) DO UPDATE SET
        planning_context_id = excluded.planning_context_id,
        destination_place_id = excluded.destination_place_id,
        lodging_place_id = excluded.lodging_place_id,
        arrival_at_destination = excluded.arrival_at_destination,
        return_departure_at = excluded.return_departure_at,
        return_arrival_at_home = excluded.return_arrival_at_home,
        create_away_periods = excluded.create_away_periods,
        updated_at = excluded.updated_at
    `).run(
      id, contextId, destinationPlaceId, lodgingPlaceId, arrivalAtDestination,
      returnDepartureAt, returnArrivalAtHome, createAwayPeriods ? 1 : 0,
    );
    attachPlanningContextSource(database, contextId, {
      sourceType: 'calendar_event', sourceId: id, sourceKey: sourceKey(id),
    }, { allowMove: Boolean(requestedContextId) });
    if (previousContextId && previousContextId !== contextId) {
      reconcileTravelPlanningContext(database, previousContextId, creatorId);
    }
    reconcileTravelPlanningContext(database, contextId, creatorId);
    return getCalendarTravelProjection(database, id);
  });
}

export function removeCalendarTravelProjection(database, eventId, actorId = null) {
  const id = positiveId(eventId, 'Calendar Event', { required: true });
  return atomic(database, () => {
    const event = eventRow(database, id);
    const details = database.prepare('SELECT * FROM calendar_travel_details WHERE calendar_event_id = ?').get(id);
    const source = database.prepare(`
      SELECT * FROM planning_context_sources
       WHERE source_type = 'calendar_event' AND source_key = ?
    `).get(sourceKey(id));
    const contextId = Number(details?.planning_context_id || source?.planning_context_id || 0) || null;
    database.prepare('DELETE FROM calendar_travel_details WHERE calendar_event_id = ?').run(id);
    detachPlanningContextSource(database, { sourceType: 'calendar_event', sourceKey: sourceKey(id) });
    if (event) database.prepare("UPDATE calendar_events SET event_kind = 'general' WHERE id = ?").run(id);
    if (contextId) reconcileTravelPlanningContext(database, contextId, actorId || event?.created_by || null);
    return { calendar_event_id: id, planning_context_id: contextId, removed: Boolean(details || source) };
  });
}
