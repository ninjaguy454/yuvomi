import {
  householdTimeZone,
  shiftDateKey,
  storedToInstantMs,
  utcToWall,
  localToUTC,
} from '../utils/timezone.js';
import { expandRecurringEvents, loadEventExceptions } from './calendar-events.js';

const SOURCE_PRIORITY = Object.freeze({ manual: 400, explicit: 300, workflow: 250, rule: 200, calendar: 100 });

function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function instantMs(value, timezone) {
  return storedToInstantMs(value, timezone);
}

function intersects(startMs, endMs, candidateStart, candidateEnd) {
  return candidateStart < endMs && candidateEnd > startMs;
}

function placeRow(database, id) {
  return id == null ? null : database.prepare('SELECT * FROM places WHERE id = ?').get(id) ?? null;
}

export function placeWithInheritedAddress(database, place) {
  if (!place) return null;
  const seen = new Set();
  let current = place;
  const chain = [];
  const inherited = {};
  while (current && !seen.has(Number(current.id))) {
    seen.add(Number(current.id));
    chain.unshift({ id: current.id, name: current.name, type: current.type });
    for (const key of ['street_address', 'city', 'region', 'postal_code', 'country', 'latitude', 'longitude']) {
      if (inherited[key] == null && current[key] != null && current[key] !== '') inherited[key] = current[key];
    }
    current = current.parent_place_id ? placeRow(database, current.parent_place_id) : null;
  }
  return { ...place, ...inherited, path: chain, path_label: chain.map((item) => item.name).join(' / ') };
}

export function isPlaceWithin(database, actualPlaceId, targetPlaceId) {
  if (!actualPlaceId || !targetPlaceId) return false;
  const target = Number(targetPlaceId);
  const seen = new Set();
  let current = placeRow(database, actualPlaceId);
  while (current && !seen.has(Number(current.id))) {
    if (Number(current.id) === target) return true;
    seen.add(Number(current.id));
    current = current.parent_place_id ? placeRow(database, current.parent_place_id) : null;
  }
  return false;
}

function periodSignals(database, userId, startMs, endMs, timezone) {
  return database.prepare(`
    SELECT ap.*, p.name AS place_name, p.type AS place_type
      FROM availability_periods ap
      LEFT JOIN places p ON p.id = ap.place_id
     WHERE ap.user_id = ? AND ap.active = 1
     ORDER BY ap.starts_at, ap.id
  `).all(userId).flatMap((row) => {
    const rowStart = instantMs(row.starts_at, timezone);
    const rowEnd = row.ends_at ? instantMs(row.ends_at, timezone) : Number.POSITIVE_INFINITY;
    if (rowStart == null || rowEnd == null || !intersects(startMs, endMs, rowStart, rowEnd)) return [];
    return [{
      source: row.source,
      source_id: row.id,
      priority: SOURCE_PRIORITY[row.source] ?? SOURCE_PRIORITY.explicit,
      state: row.state,
      custom_state: row.custom_state,
      place_id: row.place_id,
      place_name: row.place_name,
      category: row.category,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      start_ms: rowStart,
      end_ms: rowEnd,
      advisory: false,
    }];
  });
}

function ruleSignals(database, userId, startMs, endMs, timezone) {
  const startWall = utcToWall(new Date(startMs).toISOString(), timezone);
  const endWall = utcToWall(new Date(Math.max(startMs, endMs - 1)).toISOString(), timezone);
  if (!startWall || !endWall) return [];
  const rules = database.prepare(`
    SELECT ar.*, p.name AS place_name, p.type AS place_type
      FROM availability_rules ar
      LEFT JOIN places p ON p.id = ar.place_id
     WHERE ar.user_id = ? AND ar.active = 1
     ORDER BY ar.id
  `).all(userId);
  const output = [];
  let date = shiftDateKey(startWall.date, -1);
  const finalDate = shiftDateKey(endWall.date, 1);
  for (let guard = 0; guard < 370 && date <= finalDate; guard += 1, date = shiftDateKey(date, 1)) {
    const jsDay = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekday = (jsDay + 6) % 7;
    for (const row of rules) {
      const weekdays = parseJson(row.weekdays_json, []).map(Number);
      if (!weekdays.includes(weekday)) continue;
      const crossesMidnight = row.end_time <= row.start_time;
      const endDate = crossesMidnight ? shiftDateKey(date, 1) : date;
      const rowStart = new Date(localToUTC(`${date}T${row.start_time}:00`, timezone)).getTime();
      const rowEnd = new Date(localToUTC(`${endDate}T${row.end_time}:00`, timezone)).getTime();
      if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd) || !intersects(startMs, endMs, rowStart, rowEnd)) continue;
      output.push({
        source: 'rule',
        source_id: row.id,
        priority: SOURCE_PRIORITY.rule,
        state: row.state,
        custom_state: row.custom_state,
        place_id: row.place_id,
        place_name: row.place_name,
        category: row.category,
        starts_at: new Date(rowStart).toISOString(),
        ends_at: new Date(rowEnd).toISOString(),
        start_ms: rowStart,
        end_ms: rowEnd,
        advisory: false,
        rule_name: row.name,
      });
    }
  }
  return output;
}

function calendarSignals(database, userId, startMs, endMs, timezone) {
  const startDate = utcToWall(new Date(startMs).toISOString(), timezone)?.date;
  const endDate = utcToWall(new Date(Math.max(startMs, endMs - 1)).toISOString(), timezone)?.date;
  const rows = database.prepare(`
    SELECT e.id, e.title, e.start_datetime, e.end_datetime, e.all_day,
           e.place_id, p.name AS place_name, e.recurrence_rule, e.tzid
      FROM calendar_events e
      LEFT JOIN places p ON p.id = e.place_id
     WHERE (e.assigned_to = ? OR EXISTS (
       SELECT 1 FROM event_assignments ea WHERE ea.event_id = e.id AND ea.user_id = ?
     ))
       AND (e.recurrence_rule IS NOT NULL OR e.start_datetime <= ?)
  `).all(userId, userId, new Date(endMs).toISOString());
  const recurringIds = rows.filter((row) => row.recurrence_rule).map((row) => row.id);
  const expanded = startDate && endDate
    ? expandRecurringEvents(rows, shiftDateKey(startDate, -1), shiftDateKey(endDate, 1), loadEventExceptions(database, recurringIds))
    : rows;
  return expanded.flatMap((row) => {
    const rowStart = instantMs(row.start_datetime, timezone);
    const rowEnd = instantMs(row.end_datetime || row.start_datetime, timezone);
    const effectiveEnd = rowEnd != null && rowEnd > rowStart ? rowEnd : (rowStart == null ? null : rowStart + 60_000);
    if (rowStart == null || effectiveEnd == null || !intersects(startMs, endMs, rowStart, effectiveEnd)) return [];
    return [{
      source: 'calendar',
      source_id: row.id,
      priority: SOURCE_PRIORITY.calendar,
      state: 'busy',
      custom_state: null,
      place_id: row.place_id,
      place_name: row.place_name,
      category: 'general',
      starts_at: row.start_datetime,
      ends_at: row.end_datetime,
      start_ms: rowStart,
      end_ms: effectiveEnd,
      advisory: true,
      title: row.title,
    }];
  });
}

function winnerAt(signals, anchorMs) {
  return signals
    .filter((signal) => signal.start_ms <= anchorMs && signal.end_ms > anchorMs)
    .sort((a, b) => b.priority - a.priority || b.start_ms - a.start_ms || b.source_id - a.source_id)[0] ?? null;
}

function homePlace(database) {
  return database.prepare(`
    SELECT * FROM places
     WHERE active = 1 AND type = 'home'
     ORDER BY CASE WHEN parent_place_id IS NULL THEN 0 ELSE 1 END, id
     LIMIT 1
  `).get() ?? null;
}

function policyResult(database, policy, signal, signals, targetPlaceId, endMs) {
  if (policy === 'ignore') return { eligible: true, reason: 'Location is ignored for this activity.' };
  if (!signal) return policy === 'available_before_due'
    ? { eligible: true, reason: 'No availability conflict is planned before the due time.' }
    : { eligible: false, reason: 'No planned availability is known for this time.' };
  const home = homePlace(database);
  const atHome = home && isPlaceWithin(database, signal.place_id, home.id);
  const atTarget = targetPlaceId && isPlaceWithin(database, signal.place_id, targetPlaceId);
  if (policy === 'must_be_home') {
    return { eligible: Boolean(atHome && signal.state !== 'away'), reason: atHome ? 'Expected to be home.' : 'Not expected to be home.' };
  }
  if (policy === 'must_be_at_location') {
    if (!targetPlaceId) return { eligible: false, reason: 'This activity needs a location.' };
    return { eligible: Boolean(atTarget && signal.state !== 'away'), reason: atTarget ? 'Expected at the activity location.' : 'Not expected at the activity location.' };
  }
  if (policy === 'must_be_away') {
    const away = signal.state === 'away' || (signal.place_id && home && !atHome);
    return { eligible: Boolean(away), reason: away ? 'Expected to be away from home.' : 'Not expected to be away.' };
  }
  if (policy === 'available_before_due') {
    if (signal.advisory) return { eligible: true, reason: 'Calendar overlap is advisory and does not remove eligibility.' };
    const usable = signals.some((item) => item.start_ms < endMs
      && item.state === 'available'
      && (!targetPlaceId || isPlaceWithin(database, item.place_id, targetPlaceId)));
    const implicit = signal.state !== 'away' && signal.state !== 'busy';
    return { eligible: Boolean(usable || implicit), reason: usable || implicit ? 'Expected to be available before the due time.' : 'No available time is planned before the due time.' };
  }
  return { eligible: false, reason: 'Unknown presence policy.' };
}

export function evaluatePresence(database, {
  userId,
  startAt,
  endAt = null,
  targetPlaceId = null,
  policy = 'ignore',
} = {}) {
  const timezone = householdTimeZone(database);
  const startMs = instantMs(startAt, timezone);
  const endMs = instantMs(endAt || startAt, timezone);
  if (startMs == null || endMs == null) throw new Error('A valid presence window is required.');
  const effectiveEnd = Math.max(startMs + 1, endMs);
  const signals = [
    ...periodSignals(database, userId, startMs, effectiveEnd, timezone),
    ...ruleSignals(database, userId, startMs, effectiveEnd, timezone),
    ...calendarSignals(database, userId, startMs, effectiveEnd, timezone),
  ].sort((a, b) => b.priority - a.priority || a.start_ms - b.start_ms);
  const anchorMs = Math.max(startMs, effectiveEnd - 1);
  const effective = winnerAt(signals, anchorMs);
  const policyEvaluation = policyResult(database, policy, effective, signals, targetPlaceId, effectiveEnd);
  return {
    user_id: Number(userId),
    timezone,
    start_at: new Date(startMs).toISOString(),
    end_at: new Date(effectiveEnd).toISOString(),
    target_place: placeWithInheritedAddress(database, placeRow(database, targetPlaceId)),
    policy,
    effective: effective ? {
      ...effective,
      place: placeWithInheritedAddress(database, placeRow(database, effective.place_id)),
      start_ms: undefined,
      end_ms: undefined,
    } : null,
    signals: signals.map((signal) => ({
      ...signal,
      place: placeWithInheritedAddress(database, placeRow(database, signal.place_id)),
      start_ms: undefined,
      end_ms: undefined,
    })),
    ...policyEvaluation,
  };
}
