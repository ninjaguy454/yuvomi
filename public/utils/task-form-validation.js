import { parseDateInput, isDateInputValid, parseTimeInput } from '/i18n.js';

/** Validate the live draft without changing its values or dirty snapshot. */
export function taskFormErrors(form) {
  const value = id => form.querySelector(`#${id}`)?.value?.trim() || '';
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!value('task-title')) add('task-title', 'Give this Task a title.');
  const startRaw = value('task-start-date'), dueRaw = value('task-due-date');
  const start = parseDateInput(startRaw), due = parseDateInput(dueRaw);
  if (startRaw && !isDateInputValid(startRaw)) add('task-start-date', 'Enter a valid start date.');
  if (dueRaw && !isDateInputValid(dueRaw)) add('task-due-date', 'Enter a valid due date.');
  const startTimeRaw = value('task-start-time'), dueTimeRaw = value('task-due-time');
  const startTime = parseTimeInput(startTimeRaw), dueTime = parseTimeInput(dueTimeRaw);
  if (startTimeRaw && !startTime) add('task-start-time', 'Enter a valid start time.');
  if (dueTimeRaw && !dueTime) add('task-due-time', 'Enter a valid due time.');
  if (startTime && !start) add('task-start-date', 'Choose a start date for this start time.');
  if (value('task-expiration-policy') === 'expire_incomplete' && !due) add('task-due-date', 'Choose a due date for automatic expiration.');
  // These are wall-clock values in one household timezone, not browser-zone instants.
  if (start && due && `${due}T${dueTime || '23:59'}` < `${start}T${startTime || '00:00'}`) {
    add('task-due-date', 'Due date and time must be at or after the start date and time.');
  }
  const template = form.querySelector('#task-activity-template');
  if (template?.value && template.selectedOptions?.[0]?.dataset.subjectRequired === '1' && !value('task-activity-subject-user')) {
    add('task-activity-subject-user', 'Choose who this activity is for.');
  }
  return errors;
}

/** Server errors still get a visible announcement and the closest relevant field. */
export function taskErrorField(message = '') {
  if (/assignee|assignment|assign someone/i.test(message)) return 'task-fixed-assignment';
  if (/start (date|time)/i.test(message)) return 'task-start-date';
  if (/due|deadline|expiration/i.test(message)) return 'task-due-date';
  if (/title/i.test(message)) return 'task-title';
  if (/subtask/i.test(message)) return 'task-subtasks-heading';
  if (/recurr|rotation/i.test(message)) return 'task-rrule-freq';
  return null;
}

export function showTaskFormErrors(form, errors, { title = "Task couldn't be created", toast = (message) => window.yuvomi?.showToast(message, 'danger') } = {}) {
  const panel = form.closest('.modal-panel') || form;
  const summary = panel.querySelector('#task-form-error');
  if (!summary || !errors.length) return;
  summary.replaceChildren();
  summary.hidden = false;
  summary.setAttribute('role', 'alert');
  summary.setAttribute('aria-live', 'assertive');
  summary.setAttribute('aria-atomic', 'true');
  summary.tabIndex = -1;
  const heading = document.createElement('strong');
  heading.textContent = title;
  const list = document.createElement('ul');
  for (const error of errors) {
    const item = document.createElement('li'); item.textContent = error.message; list.append(item);
  }
  summary.append(heading, list);
  toast(`${title}. ${errors.map(error => error.message).join(' ')}`);
  let first;
  for (const error of errors) {
    const field = error.field && form.querySelector(`#${error.field}`);
    if (!field || field.closest('[hidden]')) continue;
    const target = field.matches('input, select, textarea, button') ? field
      : field.querySelector('input:not([type="hidden"]), select, textarea, button') || field;
    if (target.disabled) continue;
    target.setAttribute('aria-invalid', 'true');
    const prior = (target.getAttribute('aria-describedby') || '').split(/\s+/)
      .filter(id => id && id !== 'task-form-error').join(' ');
    target.setAttribute('aria-describedby', [prior, 'task-form-error'].filter(Boolean).join(' '));
    const clear = () => {
      target.removeAttribute('aria-invalid');
      if (prior) target.setAttribute('aria-describedby', prior); else target.removeAttribute('aria-describedby');
      target.removeEventListener('input', clear); target.removeEventListener('change', clear);
    };
    target.addEventListener('input', clear); target.addEventListener('change', clear);
    first ||= target;
  }
  first ||= summary;
  if (!first.matches('input, select, textarea, button')) first.tabIndex = -1;
  first.focus({ preventScroll: true });
  first.scrollIntoView({ block: 'center', behavior: 'instant' });
}
