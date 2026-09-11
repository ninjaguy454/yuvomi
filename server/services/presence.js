import {
  householdTimeZone,
  shiftDateKey,
  storedToInstantMs,
  hasExplicitZone,
  utcToWall,
} from '../utils/timezone.js';
import { expandRecurringEvents, loadEventExceptions } from './calendar-events.js';
import { scheduleData } from './schedule.js';

const SOURCE_PRIORITY = Object.freeze({ manual: 400, explicit: 300, workflow: 250, rotating: 225, rule: 200, calendar: 100 });

function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function instantMs(value, timezone) {
  let candidate = storedToInstantMs(value, timezone);
  if (candidate == null || hasExplicitZone(String(value))) return candidate;
  const raw = String(value);
  const local = raw.length <= 10 ? `${raw}T00:00:00` : raw;
  const wanted = Date.parse(`${local}Z`);
  if (!Number.isFinite(wanted)) return null;
  const seen = new Set();
  // The legacy timezone helper samples one offset. Correct it after crossing a
  // DST boundary. Gaps shift forward (02:30 -> 03:30); overlaps use the earlier
  // instant. Four steps bounds nonexistent-time loops.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const wall = utcToWall(new Date(candidate).toISOString(), timezone);
    if (!wall) return null;
    const actual = Date.parse(`${wall.date}T${wall.time}Z`) + ((candidate % 1000) + 1000) % 1000;
    const correction = wanted - actual;
    if (!correction) {
      let earlier = candidate;
      for (const probe of [candidate - 86_400_000, candidate + 86_400_000]) {
        const probeWall = utcToWall(new Date(probe).toISOString(), timezone);
        if (!probeWall) continue;
        const offset = Date.parse(`${probeWall.date}T${probeWall.time}Z`) - (probe - ((probe % 1000) + 1000) % 1000);
        const alternate = wanted - offset;
        const alternateWall = utcToWall(new Date(alternate).toISOString(), timezone);
        if (alternateWall && Date.parse(`${alternateWall.date}T${alternateWall.time}Z`) + ((alternate % 1000) + 1000) % 1000 === wanted) earlier = Math.min(earlier, alternate);
      }
      return earlier;
    }
    seen.add(candidate);
    const next = candidate + correction;
    if (seen.has(next)) return Math.max(next, ...seen);
    candidate = next;
  }
  return candidate;
}

function timeAdjustment(localValue, instant, timezone) {
  if (hasExplicitZone(String(localValue)) || instant == null) return null;
  const wall = utcToWall(new Date(instant).toISOString(), timezone);
  const local = String(localValue).length <= 10 ? `${localValue}T00:00:00` : String(localValue);
  if (!wall || `${wall.date}T${wall.time}` === local.slice(0, 19)) return null;
  return `The local time ${localValue} does not exist during the clock change; shifted forward to ${wall.date} ${wall.time}.`;
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
    SELECT ap.*, p.name AS place_name, p.type AS place_type,
           (SELECT pc.name FROM trip_participants tp
             JOIN trip_plans trip ON trip.id = tp.trip_id
             JOIN planning_contexts pc ON pc.id = trip.planning_context_id
            WHERE tp.availability_period_id = ap.id AND tp.user_id = ap.user_id
            ORDER BY trip.id LIMIT 1) AS context_name,
           (SELECT trip.name FROM trip_participants tp
             JOIN trip_plans trip ON trip.id = tp.trip_id
            WHERE tp.availability_period_id = ap.id AND tp.user_id = ap.user_id
            ORDER BY trip.id LIMIT 1) AS trip_name
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
      note: row.note,
      context_name: row.context_name,
      trip_name: row.trip_name,
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
  for (; date <= finalDate; date = shiftDateKey(date, 1)) {
    const jsDay = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekday = (jsDay + 6) % 7;
    for (const row of rules) {
      const weekdays = parseJson(row.weekdays_json, []).map(Number);
      if (!weekdays.includes(weekday)) continue;
      const crossesMidnight = row.end_time <= row.start_time;
      const endDate = crossesMidnight ? shiftDateKey(date, 1) : date;
      const rowStart = instantMs(`${date}T${row.start_time}:00`, timezone);
      const rowEnd = instantMs(`${endDate}T${row.end_time}:00`, timezone);
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
        time_adjustment: timeAdjustment(`${date}T${row.start_time}:00`, rowStart, timezone)
          || timeAdjustment(`${endDate}T${row.end_time}:00`, rowEnd, timezone),
      });
    }
  }
  return output;
}

function rotatingSignals(database, userId, startMs, endMs, timezone) {
  const from = utcToWall(new Date(startMs).toISOString(), timezone)?.date;
  const to = utcToWall(new Date(endMs - 1).toISOString(), timezone)?.date;
  if (!from || !to) return { signals: [], warnings: [], explanations: [] };
  // Previous-day occurrences can still be working after midnight today.
  const roster = scheduleData(database, { from: shiftDateKey(from, -1), to, userId });
  const signals = [];
  const explanations = [];
  for (const entry of roster.entries) {
    const type = entry.shift_type;
    const unconfigured = entry.is_configured === false;
    const startTime = type?.start_time || '00:00';
    const endTime = type?.end_time || '00:00';
    const endDate = !type?.start_time || endTime <= startTime
      ? shiftDateKey(entry.date_key, 1) : entry.date_key;
    const rowStart = instantMs(`${entry.date_key}T${startTime}:00`, timezone);
    const rowEnd = instantMs(`${endDate}T${endTime}:00`, timezone);
    if (rowStart == null || rowEnd == null || !intersects(startMs, endMs, rowStart, rowEnd)) continue;
    if (entry.is_free || type?.availability_state === 'none') {
      explanations.push({ date_key: entry.date_key, pattern_id: entry.pattern_id ?? null,
        override_id: entry.override_id ?? null, source: 'rotating', note: entry.note ?? null,
        reason: entry.is_free ? 'Day off this routine; other commitments still apply.' : 'This routine entry is information only and adds no availability restriction.' });
      continue;
    }
    if (!unconfigured && !type) continue;
    signals.push({
      source: 'rotating', source_id: entry.override_id ?? entry.pattern_id,
      priority: SOURCE_PRIORITY.rotating, state: unconfigured ? 'unknown' : (type.availability_state || 'busy'),
      custom_state: null, place_id: type?.place_id ?? null, category: 'general',
      start_ms: rowStart, end_ms: rowEnd,
      starts_at: new Date(rowStart).toISOString(), ends_at: new Date(rowEnd).toISOString(),
      advisory: false, is_configured: !unconfigured, blocking_unknown: unconfigured || type?.availability_state === 'unknown',
      pattern_id: entry.pattern_id ?? null, pattern_name: entry.pattern_name ?? null,
      override_id: entry.override_id ?? null, date_key: entry.date_key,
      shift_name: type?.name ?? null, note: entry.note ?? null,
      time_adjustment: timeAdjustment(`${entry.date_key}T${startTime}:00`, rowStart, timezone)
        || timeAdjustment(`${endDate}T${endTime}:00`, rowEnd, timezone),
    });
  }
  return { signals, warnings: roster.warnings || [], explanations };
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

function signalLabel(signal) {
  return signal?.context_name || signal?.trip_name || signal?.note || signal?.shift_name || signal?.rule_name || signal?.title || signal?.source || 'No planned signal';
}

function segmentPolicy(database, policy, signal, locationSignal, targetPlaceId) {
  if (policy === 'ignore') return { eligible: true, reason: 'Availability and location are ignored for this activity.' };
  if (policy === 'available_before_due') {
    if (!signal) return { eligible: true, reason: 'Availability is unknown; no planned restriction. Calendar events remain advisory.' };
    const usable = !signal.blocking_unknown && signal.state !== 'away' && signal.state !== 'busy';
    const placeMatches = !targetPlaceId || !signal.place_id || isPlaceWithin(database, signal.place_id, targetPlaceId);
    return { eligible: Boolean(usable && placeMatches), reason: !usable
      ? (signal.is_configured === false ? 'This routine day has not been configured.' : `${signalLabel(signal)}: ${signal.state}.`)
      : !placeMatches ? 'The planned location does not match this activity.'
        : signal.state === 'available' ? `${signalLabel(signal)}: explicitly available.` : 'Availability is unknown; no planned restriction.' };
  }
  if (!locationSignal) return { eligible: false, reason: 'No planned location is known for this time.' };
  const home = homePlace(database);
  const atHome = home && isPlaceWithin(database, locationSignal.place_id, home.id);
  const atTarget = targetPlaceId && isPlaceWithin(database, locationSignal.place_id, targetPlaceId);
  if (policy === 'must_be_home') {
    return { eligible: Boolean(atHome && locationSignal.state !== 'away'), reason: atHome ? 'Expected to be home.' : 'Not expected to be home.' };
  }
  if (policy === 'must_be_at_location') {
    if (!targetPlaceId) return { eligible: false, reason: 'This activity needs a location.' };
    return { eligible: Boolean(atTarget && locationSignal.state !== 'away'), reason: atTarget ? 'Expected at the activity location.' : 'Not expected at the activity location.' };
  }
  if (policy === 'must_be_away') {
    const away = locationSignal.state === 'away' || (locationSignal.place_id && home && !atHome);
    return { eligible: Boolean(away), reason: away ? 'Expected to be away from home.' : 'Not expected to be away.' };
  }
  return { eligible: false, reason: 'Unknown presence policy.' };
}

/** A task's date-only start is midnight; an untimed due date includes the full day. */
export function activityPresenceWindow(database, {
  task = null, dateKey, windowMode = 'due', requiredDurationMinutes = null,
} = {}) {
  const timezone = householdTimeZone(database);
  const today = utcToWall(new Date().toISOString(), timezone).date;
  const dueDate = dateKey || task?.due_date || today;
  const startDate = task?.start_date || dueDate;
  const dueTime = task?.due_time;
  return {
    startAt: `${startDate}T00:00:00`,
    endAt: dueTime ? `${dueDate}T${dueTime}:00`
      : windowMode === 'completion' ? `${shiftDateKey(dueDate, 1)}T00:00:00` : `${dueDate}T23:59:59.999`,
    windowMode,
    requiredDurationMinutes,
  };
}

function serializedSignal(database, signal) {
  if (!signal) return null;
  const { start_ms, end_ms, ...publicSignal } = signal;
  return { ...publicSignal, place: placeWithInheritedAddress(database, placeRow(database, signal.place_id)) };
}

function continuousWindows(windows, field) {
  const result = [];
  for (const window of windows) {
    if (!window[field]) continue;
    const previous = result.at(-1);
    if (previous?.end_at === window.start_at) {
      previous.end_at = window.end_at;
      previous.confirmed_available = previous.confirmed_available && window.confirmed_available;
      if (!previous.reasons.includes(window.reason)) previous.reasons.push(window.reason);
    } else result.push({ start_at: window.start_at, end_at: window.end_at,
      confirmed_available: window.confirmed_available, reasons: [window.reason] });
  }
  return result.map((window) => ({ ...window, reason: window.reasons.join(' '),
    duration_minutes: (Date.parse(window.end_at) - Date.parse(window.start_at)) / 60_000 }));
}

/** Resolve precedence independently in every interval; Calendar is never materialized here. */
export function evaluateAvailability(database, {
  userId,
  startAt,
  endAt = null,
  targetPlaceId = null,
  policy = 'ignore',
  windowMode = 'completion',
  requiredDurationMinutes = null,
  nowAt = new Date().toISOString(),
} = {}) {
  const timezone = householdTimeZone(database);
  const requestedStart = instantMs(startAt, timezone);
  const requestedEnd = instantMs(endAt || startAt, timezone);
  if (requestedStart == null || requestedEnd == null || requestedEnd < requestedStart) throw new Error('A valid availability window is required.');
  if (!['start', 'due', 'completion'].includes(windowMode)) throw new Error('Choose start, due, or completion for the availability window.');
  const duration = requiredDurationMinutes == null ? null : Number(requiredDurationMinutes);
  if (duration != null && (!Number.isFinite(duration) || duration <= 0 || duration > 527040)) throw new Error('Required duration must be a positive number of minutes within one year.');
  const durationMs = duration == null ? 1 : duration * 60_000;
  const startMs = windowMode === 'due' ? (duration == null ? requestedEnd : Math.max(requestedStart, requestedEnd - durationMs)) : requestedStart;
  const effectiveEnd = windowMode === 'start' ? (duration != null && endAt != null
    ? Math.max(startMs + 1, Math.min(requestedEnd, startMs + durationMs)) : startMs + durationMs)
    : windowMode === 'due' ? (duration == null ? startMs + 1 : Math.max(startMs + 1, requestedEnd))
      : Math.max(startMs + 1, requestedEnd);
  if (effectiveEnd - startMs > 731 * 86_400_000) throw new Error('Availability windows are limited to 731 days.');
  const roster = rotatingSignals(database, userId, startMs, effectiveEnd, timezone);
  const signals = [
    ...periodSignals(database, userId, startMs, effectiveEnd, timezone),
    ...ruleSignals(database, userId, startMs, effectiveEnd, timezone),
    ...roster.signals,
    ...calendarSignals(database, userId, startMs, effectiveEnd, timezone),
  ].sort((a, b) => b.priority - a.priority || a.start_ms - b.start_ms);
  const boundaries = [...new Set([startMs, effectiveEnd, ...signals.flatMap((signal) => [
    Math.max(startMs, signal.start_ms), Math.min(effectiveEnd, signal.end_ms),
  ])])].sort((a, b) => a - b);
  const windows = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const active = signals.filter((signal) => signal.start_ms <= start && signal.end_ms > start);
    const effective = winnerAt(active.filter((signal) => !signal.advisory), start);
    // Location is a separate axis: a busy shift without a Place does not claim a location.
    const location = winnerAt(active.filter((signal) => signal.place_id != null || signal.state === 'away'), start);
    const availability = segmentPolicy(database, 'available_before_due', effective, location, targetPlaceId);
    const decision = policy === 'available_before_due' ? availability : segmentPolicy(database, policy, effective, location, targetPlaceId);
    windows.push({ start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(),
      state: effective?.state || 'unknown', confirmed_available: effective?.state === 'available',
      source: effective?.source || null, source_id: effective?.source_id ?? null,
      effective: serializedSignal(database, effective),
      expected_place: placeWithInheritedAddress(database, placeRow(database, location?.place_id)),
      availability_usable: availability.eligible, eligible: decision.eligible,
      reason: policy === 'ignore' ? availability.reason : decision.reason,
      overridden_sources: active.filter((signal) => !signal.advisory && signal !== effective).map((signal) => serializedSignal(database, signal)),
      advisory_events: active.filter((signal) => signal.advisory).map((signal) => serializedSignal(database, signal)),
    });
  }
  const availableWindows = continuousWindows(windows, 'availability_usable');
  const eligibleWindows = continuousWindows(windows, 'eligible');
  const qualifying = eligibleWindows.find((window) => Date.parse(window.end_at) - Date.parse(window.start_at) >= durationMs) || null;
  const anchorMs = Math.max(startMs, effectiveEnd - 1);
  const effective = winnerAt(signals, anchorMs);
  const nowMs = instantMs(nowAt, timezone);
  const nowInside = nowMs != null && nowMs >= startMs && nowMs < effectiveEnd;
  // Presence is a real-now snapshot, independent of the expected windows above.
  // Reuse fetched signals when possible, otherwise resolve that point separately.
  const currentSignals = nowMs == null ? [] : nowInside ? signals : [
    ...periodSignals(database, userId, nowMs, nowMs + 1, timezone),
    ...ruleSignals(database, userId, nowMs, nowMs + 1, timezone),
    ...rotatingSignals(database, userId, nowMs, nowMs + 1, timezone).signals,
    ...calendarSignals(database, userId, nowMs, nowMs + 1, timezone),
  ];
  const currentLocation = winnerAt(currentSignals.filter((signal) => signal.place_id != null || signal.state === 'away'), nowMs);
  const currentPresence = {
    at: nowMs == null ? null : new Date(nowMs).toISOString(),
    place: placeWithInheritedAddress(database, placeRow(database, currentLocation?.place_id)),
    source: currentLocation?.source || null, inferred: true,
    expires_at: currentLocation?.ends_at || null,
    reason: currentLocation ? `Believed location from ${signalLabel(currentLocation)}; this does not imply spare time.`
        : 'Current location is unknown; no current location signal.',
  };
  return {
    user_id: Number(userId),
    timezone,
    start_at: new Date(startMs).toISOString(),
    end_at: new Date(effectiveEnd).toISOString(),
    target_place: placeWithInheritedAddress(database, placeRow(database, targetPlaceId)),
    policy,
    window_mode: windowMode, required_duration_minutes: duration,
    requested_start_at: new Date(requestedStart).toISOString(), requested_end_at: new Date(requestedEnd).toISOString(),
    effective: serializedSignal(database, effective),
    signals: signals.map((signal) => serializedSignal(database, signal)),
    windows, available_windows: availableWindows, qualifying_window: qualifying,
    current_presence: currentPresence,
    warnings: [...roster.warnings, ...signals.filter((signal) => signal.time_adjustment).map((signal) => ({
      type: 'clock_change', source: signal.source, source_id: signal.source_id, reason: signal.time_adjustment,
    })), ...[timeAdjustment(startAt, requestedStart, timezone), timeAdjustment(endAt || startAt, requestedEnd, timezone)]
      .filter(Boolean).map((reason) => ({ type: 'clock_change', source: 'request', reason }))],
    routine_explanations: roster.explanations,
    eligible: policy === 'ignore' || Boolean(qualifying),
    reason: policy === 'ignore' ? 'Availability and location are ignored for this activity.'
      : qualifying ? (duration == null ? qualifying.reason : `A continuous ${duration}-minute eligible window is available. ${qualifying.reason}`)
        : duration != null && eligibleWindows.length ? `No continuous eligible window is long enough for ${duration} minutes.`
          : windows.map((window) => window.reason).filter((reason, index, reasons) => reasons.indexOf(reason) === index).join(' '),
  };
}

// Retained for existing task, meal and planning callers.
export const evaluatePresence = evaluateAvailability;
