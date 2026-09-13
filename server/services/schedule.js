/** Resolve schedule patterns without materialising calendar events. */
import { daysBetweenDateKeys, shiftDateKey } from '../utils/timezone.js';

export function cyclePosition(anchorDate, cycleLength, dateKey) {
  const days = daysBetweenDateKeys(anchorDate, dateKey);
  const length = Number(cycleLength);
  if (days === null || !Number.isInteger(length) || length < 1) return null;
  return ((days % length) + length) % length;
}

export function dateKeysInRange(from, to) {
  const count = daysBetweenDateKeys(from, to);
  if (count === null || count < 0) return [];
  return Array.from({ length: count + 1 }, (_, index) => shiftDateKey(from, index));
}

/**
 * Resolve one user's patterns and overrides in an inclusive date window.
 * `patterns` must be ordered by descending valid_from, so the first matching
 * pattern is the documented winner when a user accidentally overlaps them.
 */
export function resolveEntries({ from, to, userId, patterns, patternDays, overrides }) {
  const overrideByDate = new Map(overrides.map((row) => [row.date_key, row]));
  const entries = [];
  const warnings = [];
  for (const date_key of dateKeysInRange(from, to)) {
    const override = overrideByDate.get(date_key);
    if (override) {
      entries.push({ user_id: userId, date_key, source: 'override', override_id: override.id,
        shift_type_id: override.shift_type_id, note: override.note ?? null,
        is_configured: true, is_free: override.shift_type_id == null });
      continue;
    }
    const matches = patterns.filter((pattern) =>
      (!pattern.valid_from || pattern.valid_from <= date_key) && (!pattern.valid_until || pattern.valid_until >= date_key));
    if (!matches.length) continue;
    if (matches.length > 1) warnings.push({ user_id: userId, date_key, pattern_ids: matches.map((p) => p.id) });
    const pattern = matches[0];
    const position = cyclePosition(pattern.anchor_date, pattern.cycle_length, date_key);
    const day = patternDays.get(`${pattern.id}:${position}`);
    entries.push({ user_id: userId, date_key, source: 'pattern', pattern_id: pattern.id,
      pattern_name: pattern.name ?? null, position, is_configured: Boolean(day),
      shift_type_id: day?.shift_type_id ?? null, note: null,
      is_free: Boolean(day) && day.shift_type_id == null });
  }
  return { entries, warnings };
}

/** One read-only roster projection shared by Availability, legacy APIs and Calendar. */
export function scheduleData(database, { from, to, userId = null }) {
  // SQL accepts numeric-string IDs, but the per-member filter below compares
  // numbers. Normalize once so shared resolver callers cannot silently lose
  // rotating restrictions. Only an omitted/null ID requests household data;
  // an invalid explicit scope must never broaden into that request.
  if (userId != null) {
    if (!['number', 'string'].includes(typeof userId)) return { entries: [], warnings: [] };
    userId = Number(userId);
    if (!Number.isSafeInteger(userId) || userId < 1) return { entries: [], warnings: [] };
  }
  const condition = userId ? 'AND user_id = ?' : '';
  const patterns = database.prepare(`SELECT * FROM schedule_patterns WHERE is_active = 1
    AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?) ${condition}
    ORDER BY user_id, valid_from DESC, id DESC`).all(...(userId ? [to, from, userId] : [to, from]));
  const patternDays = new Map();
  if (patterns.length) {
    const ids = patterns.map((p) => p.id);
    for (const row of database.prepare(`SELECT * FROM schedule_pattern_days WHERE pattern_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      patternDays.set(`${row.pattern_id}:${row.position}`, row);
    }
  }
  const users = userId ? [userId] : database.prepare('SELECT id FROM users ORDER BY id').all().map((row) => row.id);
  const entries = []; const warnings = [];
  for (const memberId of users) {
    const overrides = database.prepare('SELECT * FROM schedule_overrides WHERE user_id = ? AND date_key BETWEEN ? AND ?').all(memberId, from, to);
    const resolved = resolveEntries({ from, to, userId: memberId, patterns: patterns.filter((p) => p.user_id === memberId), patternDays, overrides });
    entries.push(...resolved.entries); warnings.push(...resolved.warnings);
  }
  const typeIds = [...new Set(entries.map((entry) => entry.shift_type_id).filter(Boolean))];
  const types = new Map();
  if (typeIds.length) {
    for (const row of database.prepare(`SELECT * FROM schedule_shift_types WHERE id IN (${typeIds.map(() => '?').join(',')})`).all(...typeIds)) types.set(row.id, row);
  }
  return { entries: entries.map((entry) => {
    const shift = types.get(entry.shift_type_id) ?? null;
    return { ...entry, shift_type: shift,
      crosses_midnight: Boolean(shift?.start_time && shift?.end_time && shift.end_time <= shift.start_time) };
  }), warnings };
}
