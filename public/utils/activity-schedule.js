/** Reusable scheduling uses calendar dates, never elapsed local-time hours. */
export const MAX_ACTIVITY_DUE_OFFSET_DAYS = 3650;

export function normalizeActivityDueOffset(value) {
  if (value == null) return null;
  const validType = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
  const number = validType ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_ACTIVITY_DUE_OFFSET_DAYS) {
    throw new Error(`Due must be a whole number from 0 to ${MAX_ACTIVITY_DUE_OFFSET_DAYS} days.`);
  }
  return number;
}

function calendarDateMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) return null;
  return milliseconds;
}

export function addCalendarDays(startDate, offset) {
  const start = calendarDateMs(startDate);
  if (start === null || !Number.isSafeInteger(offset) || offset < 0) return null;
  const result = new Date(start + offset * 86400000);
  if (!Number.isFinite(result.getTime())) return null;
  const date = result.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export function calendarDayOffset(startDate, dueDate) {
  const start = calendarDateMs(startDate), due = calendarDateMs(dueDate);
  if (start === null || due === null || due < start) return null;
  return (due - start) / 86400000;
}

export const resolveActivityDueDate = addCalendarDays;
export const deriveActivityDueOffset = calendarDayOffset;
