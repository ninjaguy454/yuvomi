import { t, getFormatLocale, formatDate, formatTime } from '/i18n.js';
import { esc } from '/utils/html.js';
import { displayTimeZone, zonedFields } from '/utils/timezone.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const wallMs = fields => Date.UTC(fields.year, fields.month - 1, fields.day,
  fields.hour || 0, fields.minute || 0, fields.second || 0);

function dueFields(task) {
  const date = String(task?.due_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return null;
  const time = String(task.due_time || '');
  if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return null;
  return { date, time, midnight };
}

/** Same wall-clock deadline policy as task-window/presence on the server:
 * nonexistent DST times move forward; repeated times use the first instant.
 * No configured household zone retains the browser's existing local fallback. */
export function taskCountdownDeadline(task) {
  const due = dueFields(task);
  if (!due?.time) return null;
  const local = `${due.date}T${due.time}`;
  const zone = displayTimeZone();
  if (!zone) return new Date(local).getTime();
  const wanted = Date.parse(`${local}Z`);
  const asWall = instant => wallMs(zonedFields(new Date(instant), zone));
  let candidate = wanted + (wanted - asWall(wanted));
  const seen = new Set();
  for (let iteration = 0; iteration < 4; iteration++) {
    const correction = wanted - asWall(candidate);
    if (!correction) {
      let earlier = candidate;
      for (const probe of [candidate - DAY, candidate + DAY]) {
        const alternate = wanted - (asWall(probe) - probe);
        if (asWall(alternate) === wanted) earlier = Math.min(earlier, alternate);
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

const unitFormats = new Map();
function unit(value, name) {
  const locale = getFormatLocale();
  const key = `${locale}:${name}`;
  if (!unitFormats.has(key)) unitFormats.set(key, new Intl.NumberFormat(locale, {
    style: 'unit', unit: name, unitDisplay: 'narrow', maximumFractionDigits: 0,
  }));
  return unitFormats.get(key).format(value);
}

function durationLabel(minutes) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const mins = minutes % 60;
  if (days) return [unit(days, 'day'), hours ? unit(hours, 'hour') : ''].filter(Boolean).join(' ');
  if (hours) return [unit(hours, 'hour'), mins ? unit(mins, 'minute') : ''].filter(Boolean).join(' ');
  return unit(mins, 'minute');
}

/** Presentation only: never alters task status, expiration, or stored dates. */
export function taskCountdown(task, now = new Date()) {
  if (!(task?.countdown === true || Number(task?.countdown) === 1)
    || task.archived_at || task.expired_at || ['done', 'expired'].includes(task.status)) return null;
  const due = dueFields(task);
  const fields = zonedFields(now);
  if (!due || !fields) return null;
  const absolute = `${formatDate(due.date)}${due.time ? `, ${formatTime(`${due.date}T${due.time}`)}` : ''}`;
  let duration, overdue, minutes, days;
  if (!due.time) {
    days = Math.round((due.midnight - Date.UTC(fields.year, fields.month - 1, fields.day)) / DAY);
    overdue = days < 0;
    duration = unit(Math.abs(days), 'day');
  } else {
    const delta = taskCountdownDeadline(task) - Number(now);
    if (!Number.isFinite(delta)) return null;
    overdue = delta < 0;
    minutes = Math.ceil(Math.abs(delta) / MINUTE);
    duration = durationLabel(minutes);
  }
  const label = overdue ? `${t('tasks.overdue')} · ${duration}`
    : days === 0 ? t('common.today')
      : minutes === 0 ? new Intl.RelativeTimeFormat(getFormatLocale(), { numeric: 'auto' }).format(0, 'second')
        : t('tasks.countdownRemaining', { duration });
  const compactAmount = days != null ? days : (overdue ? -1 : 1) *
    (minutes >= 1440 ? Math.floor(minutes / 1440) : minutes >= 60 ? Math.floor(minutes / 60) : minutes);
  const compactUnit = days != null || minutes >= 1440 ? 'day' : minutes >= 60 ? 'hour' : 'minute';
  return { label, absolute, overdue, duration, days, minutes, compact: unit(compactAmount, compactUnit) };
}

export function renderTaskCountdown(task, { className = '', compact = false } = {}) {
  const value = taskCountdown(task);
  if (!value) return '';
  return `<span class="task-countdown${value.overdue ? ' task-countdown--overdue' : ''}${className ? ` ${esc(className)}` : ''}"
    data-task-countdown data-countdown-compact="${compact}" data-due-date="${esc(task.due_date)}" data-due-time="${esc(task.due_time || '')}"
    title="${esc(value.absolute)}" aria-label="${esc(`${value.label} · ${value.absolute}`)}">${esc(compact ? value.compact : value.label)}</span>`;
}

/** One timer per mounted surface, including replacement cards. Update text only
 * so a tick preserves focused controls, selection, expansion, and scroll. */
export function bindTaskCountdowns(root) {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  let timer = null;
  let disposed = false;
  function refresh() {
    const now = new Date();
    for (const element of root.querySelectorAll('[data-task-countdown]')) {
      const value = taskCountdown({ countdown: 1, due_date: element.dataset.dueDate, due_time: element.dataset.dueTime }, now);
      if (!value) continue;
      const label = element.dataset.countdownCompact === 'true' ? value.compact : value.label;
      if (element.textContent !== label) element.textContent = label;
      element.classList.toggle('task-countdown--overdue', value.overdue);
      element.title = value.absolute;
      element.setAttribute('aria-label', `${value.label} · ${value.absolute}`);
    }
  }
  function resume() {
    clearTimeout(timer);
    if (disposed || doc.hidden) return;
    refresh();
    timer = setTimeout(resume, MINUTE - Date.now() % MINUTE);
  }
  doc.addEventListener('visibilitychange', resume);
  view?.addEventListener('focus', resume);
  view?.addEventListener('pageshow', resume);
  resume();
  return () => {
    disposed = true;
    clearTimeout(timer);
    doc.removeEventListener('visibilitychange', resume);
    view?.removeEventListener('focus', resume);
    view?.removeEventListener('pageshow', resume);
  };
}
