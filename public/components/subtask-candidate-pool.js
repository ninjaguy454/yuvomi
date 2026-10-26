import { renderUserMultiSelect, bindUserMultiSelect, getSelectedUserIds } from '/components/user-multi-select.js';
import { esc } from '/utils/html.js';
import { groupCandidatePool } from '/utils/group-candidate-pool.js';

const read = value => typeof value === 'string' ? JSON.parse(value) : value;

/** Policy choices only; selecting a chip never assigns work to its members. */
export function renderSubtaskCandidatePool({ users = [], groups = [], selected = null, fallback = null, canManage = false } = {}) {
  const pool = read(selected) || fallback || { person_ids: [], group_ids: [] };
  const chosen = new Set(pool.group_ids || []);
  const available = [...groups];
  for (const id of chosen) if (!available.some(group => Number(group.id) === Number(id)))
    available.push({ id, name: 'Saved Group', active: false });
  return `<fieldset class="form-group subtask-candidate-pool" data-subtask-candidate-pool data-pool-group-order="${esc(JSON.stringify(pool.group_ids||[]))}">
    <legend class="label">People &amp; Groups for subtasks</legend>
    ${renderUserMultiSelect(users, pool.person_ids || [], 'subtask_pool_people', 'tasks.assignedLabel', { variant: 'people' })}
    <span class="label">Groups</span>
    <div class="rotation-group-choices" role="group" aria-label="Subtask Group choices">${available.filter(group=>group.active||chosen.has(Number(group.id))).map(group=>`
      <span class="rotation-group-choice-wrap"><button type="button" class="rotation-group-choice" data-subtask-pool-group="${Number(group.id)}" aria-label="Select Group ${esc(group.name)}" aria-pressed="${chosen.has(Number(group.id))}"><span class="rotation-group-choice__avatar" aria-hidden="true"><i data-lucide="users-round"></i></span><span class="rotation-group-choice__name">${esc(group.name)}</span></button>
      ${canManage&&group.name!=='Saved Group'?`<button type="button" class="rotation-group-choice__edit" data-subtask-pool-edit="${Number(group.id)}" aria-label="Edit Group ${esc(group.name)}" title="Edit Group ${esc(group.name)}"><i data-lucide="pencil"></i></button>`:''}</span>`).join('')}
      ${canManage?'<button type="button" class="rotation-group-choice rotation-group-choice--create" data-subtask-pool-create><span class="rotation-group-choice__avatar" aria-hidden="true"><i data-lucide="plus"></i></span><span class="rotation-group-choice__name">Create new group</span></button>':''}
    </div>
  </fieldset>`;
}

export function bindSubtaskCandidatePool(root, { groups = [], onChange = null, onGroupsChanged = null } = {}) {
  const fieldset = root.querySelector('[data-subtask-candidate-pool]');
  if (!fieldset) return null;
  bindUserMultiSelect(fieldset, 'subtask_pool_people');
  let chosen = new Set(JSON.parse(fieldset.dataset.poolGroupOrder||'[]').map(Number));
  const getValue = () => ({ person_ids: getSelectedUserIds(fieldset, 'subtask_pool_people'), group_ids: [...chosen] });
  const refresh = () => fieldset.querySelectorAll('[data-subtask-pool-group]').forEach(button => {
    const id=Number(button.dataset.subtaskPoolGroup), group=groups.find(item=>Number(item.id)===id);
    button.setAttribute('aria-pressed', String(chosen.has(id)));
    if(group){button.querySelector('.rotation-group-choice__name').textContent=group.name;
      button.setAttribute('aria-label',`Select Group ${group.name}`);}
  });
  const changed = () => { refresh(); onChange?.(getValue(), groupCandidatePool(groups, [...chosen])); };
  const addGroup = group => {
    if (!group || fieldset.querySelector(`[data-subtask-pool-group="${Number(group.id)}"]`)) return;
    if(!groups.some(item=>Number(item.id)===Number(group.id)))groups.push(group);
    const wrap = document.createElement('span'); wrap.className = 'rotation-group-choice-wrap';
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'rotation-group-choice';
    chip.dataset.subtaskPoolGroup = String(group.id); chip.setAttribute('aria-label', `Select Group ${group.name}`);
    chip.innerHTML = `<span class="rotation-group-choice__avatar" aria-hidden="true"><i data-lucide="users-round"></i></span><span class="rotation-group-choice__name"></span>`;
    chip.querySelector('.rotation-group-choice__name').textContent = group.name; wrap.append(chip);
    if (fieldset.querySelector('[data-subtask-pool-create]')) {
      const pencil = document.createElement('button'); pencil.type = 'button'; pencil.className = 'rotation-group-choice__edit';
      pencil.dataset.subtaskPoolEdit = String(group.id); pencil.setAttribute('aria-label', `Edit Group ${group.name}`);
      pencil.title = `Edit Group ${group.name}`; pencil.innerHTML = '<i data-lucide="pencil"></i>'; wrap.append(pencil);
    }
    fieldset.querySelector('.rotation-group-choices').insertBefore(wrap, fieldset.querySelector('[data-subtask-pool-create]'));
    window.lucide?.createIcons({ el: wrap }); refresh();
  };
  fieldset.addEventListener('change', event => {
    if (event.target.matches('[data-ms-input="subtask_pool_people"]')) changed();
  });
  fieldset.addEventListener('click', async event => {
    const chip = event.target.closest('[data-subtask-pool-group]');
    if (chip) {
      const id = Number(chip.dataset.subtaskPoolGroup);
      if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
      changed(); chip.focus(); return;
    }
    const edit = event.target.closest('[data-subtask-pool-edit]');
    if (edit) {
      const { openRotationGroup } = await import('/components/rotation-groups.js');
      await openRotationGroup(Number(edit.dataset.subtaskPoolEdit), { edit: true, onChanged: onGroupsChanged });
      if (edit.isConnected) edit.focus({ preventScroll: true });
      return;
    }
    const create = event.target.closest('[data-subtask-pool-create]');
    if (create) {
      const { openNewRotationGroup } = await import('/components/rotation-groups.js');
      const group = await openNewRotationGroup();
      if (!group || !fieldset.isConnected) return;
      addGroup(group); chosen.add(Number(group.id)); changed();
      await onGroupsChanged?.(group);
      root.dispatchEvent(new CustomEvent('rotation-groups-loaded',{bubbles:true,detail:{groups:[group]}}));
      fieldset.querySelector(`[data-subtask-pool-group="${Number(group.id)}"]`)?.focus({ preventScroll: true });
    }
  });
  refresh();
  return { getValue, addGroup, refresh, setValue(pool, { silent = false } = {}) {
    chosen = new Set(pool?.group_ids || []);
    const people = new Set(pool?.person_ids || []);
    fieldset.querySelectorAll('[data-ms-input="subtask_pool_people"]').forEach(input => { input.checked = people.has(Number(input.value)); });
    const none=fieldset.querySelector('.user-ms__none');if(none)none.checked=!people.size;
    refresh(); if (!silent) changed();
  } };
}
