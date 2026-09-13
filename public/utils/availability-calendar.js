/**
 * Read-only projection of resolved routine occurrences onto calendar days.
 * Keep the occurrence's starting date/identity; these segments are never saved
 * as Calendar events and must not be used as occurrence/hour statistics.
 */

function previousDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function minutes(time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) return null;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** Return only the actual portion of each occurrence touching this day. */
export function routineEntriesOnDay(entries, dateKey) {
  const previous = previousDateKey(dateKey);
  return entries.flatMap((entry) => {
    if (!entry.shift_type || entry.is_configured === false) return [];
    if (entry.date_key !== dateKey && entry.date_key !== previous) return [];
    const start = minutes(entry.shift_type.start_time);
    const end = minutes(entry.shift_type.end_time);
    if (start === null || end === null) {
      return entry.date_key === dateKey ? [{
        ...entry, display_date_key: dateKey, segment_start_minutes: 0,
        segment_end_minutes: 1440, continues_from_previous: false,
        continues_to_next: false,
      }] : [];
    }

    // Equal times describe 24 hours from the named start, not an all-day label.
    const crossesMidnight = end <= start;
    const isContinuation = entry.date_key !== dateKey;
    if (isContinuation && (!crossesMidnight || end === 0)) return [];
    return [{
      ...entry,
      display_date_key: dateKey,
      segment_start_minutes: isContinuation ? 0 : start,
      segment_end_minutes: isContinuation ? end : (crossesMidnight ? 1440 : end),
      continues_from_previous: isContinuation,
      continues_to_next: !isContinuation && crossesMidnight && end > 0,
    }];
  });
}

function clockLabel(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function routineSegmentTimeLabel(entry) {
  if (minutes(entry.shift_type?.start_time) === null || minutes(entry.shift_type?.end_time) === null) return '';
  return `${clockLabel(entry.segment_start_minutes)}–${clockLabel(entry.segment_end_minutes)}`;
}
