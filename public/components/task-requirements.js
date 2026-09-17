import { esc } from '../utils/html-escape.js';
import { bindSubtaskReorder } from '../utils/subtask-reorder.js';

function skillIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number(typeof value === 'object' ? value?.id : value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);
}

function componentRoot(root, selector) {
  return root?.matches?.(selector) ? root : root?.querySelector(selector);
}

function pickerOptions(skills, selectedIds, name) {
  const selected = new Set(skillIds(selectedIds));
  const choices = new Map((skills || []).filter((skill) => Number.isSafeInteger(Number(skill.id)) && Number(skill.id) > 0)
    .map((skill) => [Number(skill.id), skill]));
  // A temporarily unavailable catalogue must not silently erase saved IDs.
  for (const id of selected) if (!choices.has(id)) choices.set(id, { id, name: 'Unavailable skill' });
  return [...choices.values()].map((skill) => `<label class="task-skill-picker__option">
    <input type="checkbox" name="${esc(name)}" data-task-skill-id value="${Number(skill.id)}" ${selected.has(Number(skill.id)) ? 'checked' : ''}>
    <span>${esc(skill.name)}</span>
  </label>`).join('') || '<p class="form-hint">No skills available.</p>';
}

function selectionLabel(count) {
  return count ? `${count} selected` : 'Optional';
}

export function renderSkillPicker({ skills = [], selectedIds = [], name = 'skill_ids', label = 'Required skills', readOnly = false, canCreateSkill = false } = {}) {
  return `<fieldset class="task-skill-picker" data-task-skill-picker ${readOnly ? 'disabled' : ''}>
    <legend class="sr-only">${esc(label)}</legend>
    <details>
      <summary><span>${esc(label)}</span><span class="task-skill-picker__summary" data-task-skill-summary>${selectionLabel(skillIds(selectedIds).length)}</span></summary>
      <div class="task-skill-picker__options">${pickerOptions(skills, selectedIds, name)}</div>
      ${canCreateSkill ? '<button type="button" class="btn btn--ghost btn--sm" data-create-skill>+ Create skill</button>' : ''}
    </details>
  </fieldset>`;
}

export function bindSkillPicker(root, { onChange = null, onCreateSkill = null } = {}) {
  const picker = componentRoot(root, '[data-task-skill-picker]');
  if (!picker) throw new Error('Skill picker is not mounted.');
  const getValue = () => skillIds([...picker.querySelectorAll('[data-task-skill-id]:checked')].map((input) => input.value));
  const refresh = () => { picker.querySelector('[data-task-skill-summary]').textContent = selectionLabel(getValue().length); };
  const change = (event) => {
    if (!picker.disabled && event.target.matches('[data-task-skill-id]')) {
      refresh();
      onChange?.(getValue());
    }
  };
  picker.addEventListener('change', change);
  const addSkill = (skill) => {
    const id = Number(skill?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const existing = picker.querySelector(`[data-task-skill-id][value="${id}"]`);
    if (existing) existing.closest('label').querySelector('span').textContent = skill.name;
    else {
      const options = picker.querySelector('.task-skill-picker__options');
      const name = picker.querySelector('[data-task-skill-id]')?.name || 'skill_ids';
      options.querySelector('.form-hint')?.remove();
      options.insertAdjacentHTML('beforeend', pickerOptions([skill], [], name));
    }
  };
  const createButton = picker.querySelector('[data-create-skill]');
  const create = async () => {
    if (picker.disabled || createButton?.disabled || !onCreateSkill) return;
    createButton.disabled = true;
    let selected = false;
    try {
      const skill = await onCreateSkill();
      if (!skill || !picker.isConnected || picker.disabled) return;
      addSkill(skill);
      const option = picker.querySelector(`[data-task-skill-id][value="${Number(skill.id)}"]`);
      if (!option) return;
      option.checked = true;
      refresh();
      onChange?.(getValue());
      option.focus({ preventScroll: true });
      selected = true;
    } catch (error) { window.yuvomi?.showToast?.(error.message || 'Could not open the Skill editor.', 'danger'); }
    finally {
      createButton.disabled = false;
      if (!selected && createButton.isConnected && !picker.closest('[inert]')) createButton.focus({ preventScroll: true });
    }
  };
  if (createButton) {
    createButton.hidden = !onCreateSkill;
    createButton.addEventListener('click', create);
  }
  refresh();
  return {
    getValue,
    addSkill,
    setValue(ids) {
      const selected = new Set(skillIds(ids));
      const options = picker.querySelector('.task-skill-picker__options');
      const name = picker.querySelector('[data-task-skill-id]')?.name || 'skill_ids';
      for (const id of selected) {
        if (!picker.querySelector(`[data-task-skill-id][value="${id}"]`)) {
          options.querySelector('.form-hint')?.remove();
          options.insertAdjacentHTML('beforeend', pickerOptions([], [id], name));
        }
      }
      picker.querySelectorAll('[data-task-skill-id]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      refresh();
    },
    setReadOnly(value) { picker.disabled = Boolean(value); },
    dispose() { picker.removeEventListener('change', change); createButton?.removeEventListener('click', create); },
  };
}

function subtaskRow(subtask, skills, template, index, canCreateSkill = false) {
  return `<div class="task-subtask-editor__row" data-task-subtask-row data-subtask-value="${esc(JSON.stringify(subtask))}"${subtask.id ? ` data-subtask-id="${Number(subtask.id)}"` : ''}>
    <div class="task-subtask-editor__main">
      <span class="task-subtask-editor__handle" data-task-subtask-handle role="img" aria-label="Drag to reorder subtask" title="Drag to reorder; use Subtask actions for keyboard controls"><svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="11" cy="10" r="1.5"/><circle cx="5" cy="16" r="1.5"/><circle cx="11" cy="16" r="1.5"/></svg></span>
      <input class="input" data-task-subtask-title ${template ? 'data-variable-mentions="activity-title"' : ''}
        aria-label="Subtask ${index + 1}" maxlength="200" placeholder="Subtask name"
        value="${esc(subtask.title ?? subtask.title_template ?? '')}">
      <label class="task-subtask-editor__optional"><input type="checkbox" data-task-subtask-optional ${subtask.is_optional === true || Number(subtask.is_optional) === 1 ? 'checked' : ''}> Optional</label>
      <details class="task-subtask-editor__actions">
        <summary aria-label="Subtask ${index + 1} actions" title="Subtask actions">⋯</summary>
        <div class="task-subtask-editor__menu">
          <button type="button" class="btn btn--ghost" data-task-subtask-action="up">Move up</button>
          <button type="button" class="btn btn--ghost" data-task-subtask-action="down">Move down</button>
          <button type="button" class="btn btn--danger-ghost" data-task-subtask-action="remove">Remove subtask</button>
        </div>
      </details>
    </div>
    ${renderSkillPicker({ skills, selectedIds: subtask.skill_ids ?? subtask.skills ?? [], name: 'subtask_skill_ids', canCreateSkill })}
  </div>`;
}

export function renderSubtaskEditor({ subtasks = [], skills = [], template = false, canCreateSkill = false } = {}) {
  return `<div class="task-subtask-editor" data-task-subtask-editor>
    <div class="task-subtask-editor__rows" data-task-subtask-rows>${subtasks.map((subtask, index) => subtaskRow(subtask, skills, template, index, canCreateSkill)).join('')}</div>
    <button type="button" class="btn btn--ghost btn--sm" data-task-subtask-add>+ Add subtask</button>
    <span class="sr-only" role="status" aria-live="polite" data-task-subtask-announcement></span>
  </div>`;
}

export function bindSubtaskEditor(root, { skills = [], template = false, onChange = null, onCreateSkill = null } = {}) {
  const editor = componentRoot(root, '[data-task-subtask-editor]');
  if (!editor) throw new Error('Subtask editor is not mounted.');
  const rows = editor.querySelector('[data-task-subtask-rows]');
  const pickers = new Map();
  const originals = new WeakMap();
  let readOnly = false;
  const getValue = () => [...rows.children].map((row) => ({
    ...originals.get(row),
    ...(row.dataset.subtaskId ? { id: Number(row.dataset.subtaskId) } : {}),
    title: row.querySelector('[data-task-subtask-title]').value,
    ...(template ? { title_template: row.querySelector('[data-task-subtask-title]').value } : {}),
    skill_ids: pickers.get(row).getValue(),
    is_optional: row.querySelector('[data-task-subtask-optional]').checked ? 1 : 0,
  }));
  const changed = () => onChange?.(getValue());
  const refresh = () => {
    [...rows.children].forEach((row, index) => {
      row.querySelector('[data-task-subtask-title]').setAttribute('aria-label', `Subtask ${index + 1}`);
      row.querySelector('[data-task-subtask-title]').disabled = readOnly;
      row.querySelector('[data-task-subtask-optional]').disabled = readOnly;
      const menu = row.querySelector('.task-subtask-editor__actions');
      menu.querySelector('summary').setAttribute('aria-label', `Subtask ${index + 1} actions`);
      menu.querySelector('summary').setAttribute('aria-disabled', String(readOnly));
      menu.querySelector('summary').tabIndex = readOnly ? -1 : 0;
      if (readOnly) menu.open = false;
      row.querySelector('[data-task-subtask-handle]').setAttribute('aria-disabled', String(readOnly));
      row.querySelector('[data-task-subtask-action="up"]').disabled = readOnly || index === 0;
      row.querySelector('[data-task-subtask-action="down"]').disabled = readOnly || index === rows.children.length - 1;
      row.querySelector('[data-task-subtask-action="remove"]').disabled = readOnly;
      pickers.get(row).setReadOnly(readOnly);
    });
    editor.querySelector('[data-task-subtask-add]').disabled = readOnly;
    reorder.refresh();
  };
  const reorder = bindSubtaskReorder(rows, { isReadOnly: () => readOnly,
    onChange: () => { refresh(); changed(); },
    announce: message => { editor.querySelector('[data-task-subtask-announcement]').textContent = message; },
  });
  const addSkill = (skill) => {
    if (!Number.isSafeInteger(Number(skill?.id)) || Number(skill.id) <= 0) return;
    skills = [...skills.filter((item) => Number(item.id) !== Number(skill.id)), skill];
    pickers.forEach((picker) => picker.addSkill(skill));
  };
  const createSkill = onCreateSkill ? async () => {
    const skill = await onCreateSkill();
    if (skill) addSkill(skill);
    return skill;
  } : null;
  const bindRow = (row) => {
    originals.set(row, JSON.parse(row.dataset.subtaskValue || '{}'));
    delete row.dataset.subtaskValue;
    pickers.set(row, bindSkillPicker(row, { onChange: changed, onCreateSkill: createSkill }));
  };
  const click = (event) => {
    if (readOnly) { if (event.target.closest('.task-subtask-editor__actions')) event.preventDefault(); return; }
    const add = event.target.closest('[data-task-subtask-add]');
    if (add && editor.contains(add)) {
      rows.insertAdjacentHTML('beforeend', subtaskRow({}, skills, template, rows.children.length, !!onCreateSkill));
      bindRow(rows.lastElementChild);
      refresh();
      rows.lastElementChild.querySelector('[data-task-subtask-title]').focus();
      changed();
      return;
    }
    const button = event.target.closest('[data-task-subtask-action]');
    if (!button || !editor.contains(button) || button.disabled) return;
    const row = button.closest('[data-task-subtask-row]');
    const action = button.dataset.taskSubtaskAction;
    if (action === 'up' || action === 'down') {
      reorder.move(row, [...rows.children].indexOf(row) + (action === 'up' ? -1 : 1));
      row.querySelector('.task-subtask-editor__actions').open = false;
      row.querySelector('.task-subtask-editor__actions summary').focus();
      return;
    }
    else if (action === 'remove') {
      const target = row.nextElementSibling || row.previousElementSibling;
      pickers.get(row).dispose();
      pickers.delete(row);
      row.remove();
      (target?.querySelector('[data-task-subtask-title]') || editor.querySelector('[data-task-subtask-add]')).focus();
    }
    refresh();
    changed();
  };
  const input = (event) => { if (!readOnly && event.target.matches('[data-task-subtask-title]')) changed(); };
  const change = (event) => { if (!readOnly && event.target.matches('[data-task-subtask-optional]')) changed(); };
  const keydown = (event) => {
    const menu = event.target.closest('.task-subtask-editor__actions');
    if (event.key === 'Escape' && menu?.open) { event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector('summary').focus(); }
  };
  [...rows.children].forEach(bindRow);
  refresh();
  editor.addEventListener('click', click);
  editor.addEventListener('input', input);
  editor.addEventListener('change', change);
  editor.addEventListener('keydown', keydown);
  return {
    getValue,
    addSkill,
    ready: reorder.ready.then(() => undefined),
    setValue(subtasks = []) {
      pickers.forEach((picker) => picker.dispose());
      pickers.clear();
      rows.replaceChildren();
      rows.insertAdjacentHTML('beforeend', subtasks.map((subtask, index) => subtaskRow(subtask, skills, template, index, !!onCreateSkill)).join(''));
      [...rows.children].forEach(bindRow);
      refresh();
    },
    setReadOnly(value) { readOnly = Boolean(value); refresh(); },
    dispose() {
      editor.removeEventListener('click', click);
      editor.removeEventListener('input', input);
      editor.removeEventListener('change', change);
      editor.removeEventListener('keydown', keydown);
      reorder.dispose();
      pickers.forEach((picker) => picker.dispose());
    },
  };
}
