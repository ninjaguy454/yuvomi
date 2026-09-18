import { addCalendarDays, calendarDayOffset } from '../../public/utils/activity-schedule.js';

export { addCalendarDays, calendarDayOffset };

/** Resolve a reusable schedule against a concrete occurrence date. Explicit
 * nulls clear a concrete field; undefined inherits. Dates are calendar keys,
 * so this never adds elapsed milliseconds across a household DST boundary. */
export function resolveActivitySchedule(activity, task = {}, { fallbackStartDate = null } = {}) {
  const supplied = (key) => Object.hasOwn(task ?? {}, key) && task[key] !== undefined;
  const startDate = supplied('start_date') ? task.start_date : fallbackStartDate;
  const startTime = supplied('start_time') ? task.start_time : activity?.start_time ?? null;
  const dueTime = supplied('due_time') ? task.due_time : activity?.due_time ?? null;
  const relative = activity?.due_date_offset_days != null;
  const dueDate = supplied('due_date') ? task.due_date
    : relative ? addCalendarDays(startDate, activity.due_date_offset_days) : null;
  if (relative && !supplied('due_date') && addCalendarDays(startDate, 0) && !dueDate) {
    throw Object.assign(new Error('The Due interval extends beyond the supported calendar. Choose an earlier Start Date or a shorter Due interval.'), { status: 400 });
  }
  return {
    start_date: startDate,
    start_time: startTime,
    due_date: dueDate,
    due_time: dueTime,
    // Store the resolved span, including a permitted concrete override, rather
    // than consulting a mutable Activity Template during later recurrence.
    due_date_offset_days: relative ? calendarDayOffset(startDate, dueDate) : null,
  };
}
