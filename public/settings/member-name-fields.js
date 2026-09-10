import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const fields = [
  ['first_name', 'contacts.firstNameLabel', 'given-name'],
  ['last_name', 'contacts.lastNameLabel', 'family-name'],
  ['nickname', 'contacts.nicknameLabel', 'nickname'],
];

/** Explicit optional member names; a display name is never split as a guess. */
export function memberNameFields(prefix, member = {}) {
  const hintId = `${prefix}-names-hint`;
  return `<div class="modal-grid modal-grid--2">
    ${fields.map(([key, label, autocomplete]) => `<div class="form-group">
      <label class="form-label" for="${prefix}-${key}">${t(label)}</label>
      <input class="form-input" type="text" id="${prefix}-${key}" maxlength="128"
        value="${esc(member[key] ?? '')}" autocomplete="${autocomplete}" aria-describedby="${hintId}">
    </div>`).join('')}
  </div><p class="form-hint" id="${hintId}">${t('settings.memberNamesHint')}</p>`;
}

export function readMemberNames(container, prefix) {
  return Object.fromEntries(fields.map(([key]) => [key, container.querySelector(`#${prefix}-${key}`)?.value.trim() || null]));
}
