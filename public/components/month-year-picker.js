import { t, getLocale } from '/i18n.js';
import { esc } from '/utils/html.js';

/** Shared month grid; callers retain their existing navigation and event handlers. */
export function renderMonthYearPicker(year, currentDate, prefix = 'month-year') {
  const currentMonth = String(currentDate).slice(0, 7);
  const months = Array.from({ length: 12 }, (_, month) => {
    const key = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
    const label = new Intl.DateTimeFormat(getLocale(), { month: 'short', timeZone: 'UTC' })
      .format(new Date(`${key}-01T12:00:00Z`));
    return `<button type="button" class="month-year-picker__month${key === currentMonth ? ' month-year-picker__month--active' : ''}"
      data-${prefix}-month="${month + 1}" data-${prefix}-year="${year}" aria-pressed="${key === currentMonth}">${esc(label)}</button>`;
  }).join('');
  return `<div class="month-year-picker__year">
    <button type="button" class="btn btn--icon btn--ghost btn--icon-sm" data-${prefix}-picker-year="-1" aria-label="${esc(t('tasks.calendarPreviousYear'))}"${year <= 1 ? ' disabled' : ''}>
      <i data-lucide="chevron-down" class="icon-sm" aria-hidden="true"></i>
    </button>
    <strong>${year}</strong>
    <button type="button" class="btn btn--icon btn--ghost btn--icon-sm" data-${prefix}-picker-year="1" aria-label="${esc(t('tasks.calendarNextYear'))}"${year >= 9999 ? ' disabled' : ''}>
      <i data-lucide="chevron-up" class="icon-sm" aria-hidden="true"></i>
    </button>
  </div><div class="month-year-picker__months">${months}</div>`;
}

/** Change the displayed month without allowing short months to spill into the next one. */
export function dateInSelectedMonth(currentDate, year, month, { firstDay = false } = {}) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const monthKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  const last = new Date(`${monthKey}-01T12:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const day = firstDay ? 1 : Math.min(Math.max(1, Number(String(currentDate).slice(8, 10)) || 1), last.getUTCDate());
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}
