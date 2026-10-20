import { memberLabel } from '/utils/member-label.js';
import { esc } from '../utils/html-escape.js';
import { bindSubtaskReorder } from '../utils/subtask-reorder.js';
import { bindSubtaskPeople } from './task-subtask-people.js';
import { api } from '/api.js';
import {bindGroupAssignmentOrder} from '/components/group-assignment-order.js';

export function assignmentGroupBehavior(group,{dateKey=null,template=false}={}) {
  if(!group||!Array.isArray(group.usage_versions))return group;
  const versions=group.usage_versions;
  const today=group.household_today,active=today?versions.filter(row=>row.effective_date<=today).at(-1):versions.at(-1);
  if(template&&new Set([active?.usage_mode||'independent',...versions.filter(row=>!today||row.effective_date>today).map(row=>row.usage_mode)]).size>1)
    return {...group,usage_mode:'mixed',shared_config:null};
  const key=dateKey||today;
  const version=key?versions.filter(row=>row.effective_date<=key).at(-1):versions.at(-1);
  return {...group,usage_mode:version?.usage_mode||'independent',shared_config:version?.shared_config||null};
}

export function assignmentGroupSummary(group,{scope='Activity'}={}) {
  const members=group?.members?.filter(member=>member.active==null||Boolean(member.active)).map(member=>member.display_name).filter(Boolean).join(', ');
  if(group?.usage_mode==='mixed')return `${members||group.name} · This Group changes between independent and shared rotations by Activity date. Set an order, start and direction for independent dates; shared dates use the Group schedule. Presence and skills on this ${scope} also apply.`;
  if(group?.usage_mode!=='shared')return `${members||'Group membership is shared.'} · This ${scope} chooses its member order, starting member and direction. Presence and skills follow this ${scope}.`;
  const config=group.shared_config||{};
  const method={round_robin:'Round Robin',rotating_order:'Rotating Order',fixed_order:'Fixed Order'}[config.strategy]||'Shared rotation';
  const start=config.start_mode==='random'?'Random member':config.start_mode==='explicit'
    ?group.members?.find(member=>Number(member.id)===Number(config.starting_member_id))?.display_name||'Saved starting member':'First member';
  const direction=config.strategy==='rotating_order'?(config.direction==='last_to_first'?'Last to first':'First to last'):null;
  const eligibility=config.eligibility||{},restrictions=[];
  if(eligibility.skill_ids?.length)restrictions.push(`${eligibility.skill_ids.length} Group skill${eligibility.skill_ids.length===1?'':'s'}`);
  if(eligibility.presence_policy&&eligibility.presence_policy!=='ignore')restrictions.push(`Group presence: ${eligibility.presence_policy.replaceAll('_',' ')}`);
  if(eligibility.place_id)restrictions.push('a Group Place');
  return `${members||group.name} · ${[method,start,direction].filter(Boolean).join(' · ')}. These settings are locked here; edit the shared schedule in Group management. This ${scope} also applies its own presence and skills.${restrictions.length?` Saved Group eligibility also applies (${restrictions.join(', ')}).`:''}`;
}

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

function subtaskRow(subtask, skills, template, index, canCreateSkill = false, users = [], groups = [],canCreateGroup=false) {
  const assigned = Number(subtask.assigned_to || subtask.assigned_user_ids?.[0] || subtask.assigned_users?.[0]?.id) || null;
  const group=typeof subtask.assignment_group_json==='string'?JSON.parse(subtask.assignment_group_json):subtask.assignment_group||subtask.assignment_group_json;
  const selectedGroup=groups.find(item=>Number(item.id)===Number(group?.group_id));
  const assignment = !template && users.length ? `<span class="task-subtask-editor__assignment" data-task-subtask-assignment hidden>
    <button type="button" class="task-allocation__target task-allocation__target--empty" data-task-subtask-target aria-haspopup="dialog" aria-expanded="false"><span aria-hidden="true">?</span></button>
    <select data-task-subtask-assignee hidden aria-label="Subtask ${index + 1} assignee"><option value="">Use the parent Activity's responsibility</option>${assigned && !users.some(user => Number(user.id) === assigned) ? `<option value="${assigned}" selected>Unavailable member</option>` : ''}${users.map(user => `<option value="${Number(user.id)}" ${assigned === Number(user.id) ? 'selected' : ''}>${esc(memberLabel(user, users))}</option>`).join('')}</select>
  </span>` : '';
  return `<div class="task-subtask-editor__row" data-task-subtask-row data-action-key="${esc(subtask.action_key || '')}" data-subtask-value="${esc(JSON.stringify(subtask))}"${Array.isArray(subtask.eligible_assignee_ids) ? ` data-eligible-assignee-ids="${esc(JSON.stringify(subtask.eligible_assignee_ids))}"` : ''}${subtask.id ? ` data-subtask-id="${Number(subtask.id)}"` : ''}>
    <div class="task-subtask-editor__main">
      <span class="task-subtask-editor__handle" data-task-subtask-handle role="img" aria-label="Drag to reorder subtask" title="Drag to reorder; use Subtask actions for keyboard controls"><svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="11" cy="10" r="1.5"/><circle cx="5" cy="16" r="1.5"/><circle cx="11" cy="16" r="1.5"/></svg></span>
      <input class="input" data-task-subtask-title ${template ? 'data-variable-mentions="activity-title"' : ''}
        aria-label="Subtask ${index + 1}" maxlength="200" placeholder="Subtask name"
        value="${esc(subtask.title ?? subtask.title_template ?? '')}">
      ${assignment}
      ${groups.length||canCreateGroup||group?`<details class="task-subtask-editor__group" data-task-subtask-group-behavior><summary>${group?`Group: ${esc(groups.find(item=>Number(item.id)===Number(group.group_id))?.name||'Rotation Group')}`:'Assign a Rotation Group'}</summary>
        <p class="form-hint" data-task-subtask-group-summary>${selectedGroup?.members?.filter(member=>member.active).map(member=>esc(member.display_name)).join(' → ')||'Group membership is shared.'} ${selectedGroup?.usage_mode==='shared'?'The shared Group schedule controls direction, start and timing.':'This subtask chooses its member order, starting member and direction.'} Presence follows this Activity's window and required skills.</p>
        <label class="form-label">Group<select class="input" data-task-subtask-group><option value="">No Group</option>${group&&!groups.some(item=>Number(item.id)===Number(group.group_id))?`<option value="${Number(group.group_id)}" selected>Saved Rotation Group</option>`:''}${groups.map(item=>`<option value="${Number(item.id)}" ${Number(item.id)===Number(group?.group_id)?'selected':''} ${item.active||Number(item.id)===Number(group?.group_id)?'':'disabled'}>${esc(item.name)}${item.active?'':' (inactive)'}</option>`).join('')}</select></label>
        <label class="form-label">Start with<select class="input" data-task-subtask-group-start><option value="first" ${group?.start_mode!=='random'?'selected':''}>First member</option><option value="random" ${group?.start_mode==='random'?'selected':''}>Random member, chosen once</option></select></label>
        <label class="form-label">Rotation direction<select class="input" data-task-subtask-group-direction><option value="first_to_last" ${group?.direction!=='last_to_first'?'selected':''}>First to last</option><option value="last_to_first" ${group?.direction==='last_to_first'?'selected':''}>Last to first</option></select></label>
        <div data-task-subtask-group-order></div>
        ${canCreateGroup?'<button class="btn btn--secondary btn--sm" type="button" data-task-subtask-manage-group>Manage Group members and order</button>':''}
      </details>`:''}
      <label class="task-subtask-editor__points">Points<input class="input" type="number" name="subtask_points" data-task-subtask-points ${template ? 'required' : ''}
        aria-label="Subtask ${index + 1} points" inputmode="numeric" min="0" max="10000" step="1"
        value="${esc(subtask.points ?? 0)}"></label>
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

export function renderSubtaskEditor({ subtasks = [], skills = [], template = false, canCreateSkill = false,canCreateGroup=false, users = [],groups=[] } = {}) {
  return `<div class="task-subtask-editor" data-task-subtask-editor>
    ${!template && users.length ? '<div class="task-subtask-editor__people" data-task-subtask-people hidden><div class="task-allocation__strip" role="group" aria-label="Subtask assignees"></div></div>' : ''}
    <div class="task-subtask-editor__rows" data-task-subtask-rows>${subtasks.map((subtask, index) => subtaskRow(subtask, skills, template, index, canCreateSkill, users,groups,canCreateGroup)).join('')}</div>
    <button type="button" class="btn btn--ghost btn--sm" data-task-subtask-add>+ Add subtask</button>
    <span class="sr-only" role="status" aria-live="polite" data-task-subtask-announcement></span>
  </div>`;
}

export function bindSubtaskEditor(root, { skills = [], template = false, dateKey = null, onChange = null, onCreateSkill = null,canCreateGroup=false, users = [],groups=[], assignmentsEnabled = false, canAssign = true, canChangePoints = true } = {}) {
  const editor = componentRoot(root, '[data-task-subtask-editor]');
  if (!editor) throw new Error('Subtask editor is not mounted.');
  const rows = editor.querySelector('[data-task-subtask-rows]');
  const pickers = new Map();
  const groupOrders=new Map();
  const originals = new WeakMap();
  let readOnly = false;
  let preserveAssignmentHistory = true;
  let pointsMode = null, settledIds = new Set();
  const assignments = !template ? bindSubtaskPeople(editor, { users,groups }) : null;
  const getValue = ({ withKeys = false } = {}) => [...rows.children].map((row) => {
    const {assigned_user_ids: oldIds,...original}=originals.get(row)||{};
    if (withKeys && !template && !original.id && !original.action_key) {
      row.dataset.clientKey ||= original.client_key || globalThis.crypto.randomUUID();
      original.client_key = row.dataset.clientKey;
    }
    const rawPoints = row.querySelector('[data-task-subtask-points]')?.value;
    const pointsValue = rawPoints !== undefined && rawPoints.trim() !== '' && Number.isInteger(Number(rawPoints)) && Number(rawPoints) >= 0 && Number(rawPoints) <= 10000 ? Number(rawPoints) : rawPoints;
    const previous=oldIds||original.assigned_users?.map(user=>user.id)||(original.assigned_to?[original.assigned_to]:[]);
    const groupId=Number(row.querySelector('[data-task-subtask-group]')?.value)||null;
    const groupConfig=groupId?{group_id:groupId,start_mode:row.querySelector('[data-task-subtask-group-start]').value,
      direction:row.querySelector('[data-task-subtask-group-direction]').value,
      ...(groupOrders.get(row)?.getValue()?{member_order:groupOrders.get(row).getValue()}:{})}:null;
    const originalGroup=typeof original.assignment_group_json==='string'?JSON.parse(original.assignment_group_json):original.assignment_group||original.assignment_group_json||null;
    const groupChanged=JSON.stringify(groupConfig)!==JSON.stringify(originalGroup);
    const selected=groupId&&!groupChanged?(Number(original.assigned_to||previous[0])||null)
      :Number(row.querySelector('[data-task-subtask-assignee]')?.value)||null;
    const assignmentChanged = groupChanged || selected !== (Number(original.assigned_to || previous[0]) || null);
    const includeAssignment = oldIds !== undefined || !original.id || assignmentChanged;
    return ({
    ...original,
    ...(row.dataset.subtaskId ? { id: Number(row.dataset.subtaskId) } : {}),
    title: row.querySelector('[data-task-subtask-title]').value,
    ...(template ? { title_template: row.querySelector('[data-task-subtask-title]').value } : {}),
    points: pointsValue,
    skill_ids: pickers.get(row).getValue(),
    is_optional: row.querySelector('[data-task-subtask-optional]').checked ? 1 : 0,
    ...(groupId||originalGroup?{assignment_group:groupConfig}:{}),
    ...(assignmentsEnabled && includeAssignment && row.querySelector('[data-task-subtask-assignee]') ? {assigned_user_ids: assignmentChanged ? groupId?[]:selected ? [selected] : [] : previous} : {}),
  });});
  const changed = () => onChange?.(getValue());
  const refresh = () => {
    const pool = editor.querySelector('[data-task-subtask-people]');
    if (pool) pool.hidden = !assignmentsEnabled;
    [...rows.children].forEach((row, index) => {
      const permissions=originals.get(row)?.permissions;
      const rowReadOnly=readOnly || permissions?.edit === false;
      row.querySelector('[data-task-subtask-title]').setAttribute('aria-label', `Subtask ${index + 1}`);
      row.querySelector('[data-task-subtask-title]').disabled = rowReadOnly;
      row.querySelector('[data-task-subtask-optional]').disabled = rowReadOnly;
      const points = row.querySelector('[data-task-subtask-points]');
      if (points) {
        points.closest('label').hidden = pointsMode === 'whole_task';
        points.disabled = readOnly || !canChangePoints || pointsMode === 'whole_task' || settledIds.has(Number(row.dataset.subtaskId)) || originals.get(row)?.permissions?.change_points === false;
        points.setAttribute('aria-label', `Subtask ${index + 1} points`);
      }
      const assignee=row.querySelector('[data-task-subtask-assignee]');
      const closedAssignment = preserveAssignmentHistory && (!!originals.get(row)?.archived_at || ['done','expired','skipped'].includes(originals.get(row)?.status));
      if(assignee){assignee.closest('[data-task-subtask-assignment]').hidden=!assignmentsEnabled;assignee.disabled=rowReadOnly||closedAssignment||!canAssign||permissions?.change_assignment===false;}
      const selectedGroup=assignmentGroupBehavior(groups.find(group=>String(group.id)===row.querySelector('[data-task-subtask-group]')?.value),
        {dateKey:typeof dateKey==='function'?dateKey():dateKey,template});
      const shared=selectedGroup?.usage_mode==='shared';
      groupOrders.get(row)?.set(selectedGroup,undefined,{readOnly:rowReadOnly||closedAssignment||!canAssign||permissions?.change_assignment===false});
      row.querySelectorAll('[data-task-subtask-group], [data-task-subtask-group-start], [data-task-subtask-group-direction]').forEach(control=>control.disabled=rowReadOnly||closedAssignment||!canAssign||permissions?.change_assignment===false||(shared&&!control.matches('[data-task-subtask-group]')));
      const summary=row.querySelector('[data-task-subtask-group-summary]');if(summary)summary.textContent=assignmentGroupSummary(selectedGroup,{scope:'subtask'});
      for(const field of ['start','direction']){const label=row.querySelector(`[data-task-subtask-group-${field}]`)?.closest('label');if(label)label.hidden=shared;}
      const manage=row.querySelector('[data-task-subtask-manage-group]');if(manage)manage.disabled=!selectedGroup;
      const menu = row.querySelector('.task-subtask-editor__actions');
      menu.querySelector('summary').setAttribute('aria-label', `Subtask ${index + 1} actions`);
      menu.querySelector('summary').setAttribute('aria-disabled', String(readOnly));
      menu.querySelector('summary').tabIndex = readOnly ? -1 : 0;
      if (readOnly) menu.open = false;
      row.querySelector('[data-task-subtask-handle]').setAttribute('aria-disabled', String(readOnly));
      row.querySelector('[data-task-subtask-action="up"]').disabled = readOnly || index === 0;
      row.querySelector('[data-task-subtask-action="down"]').disabled = readOnly || index === rows.children.length - 1;
      row.querySelector('[data-task-subtask-action="remove"]').disabled = rowReadOnly;
      pickers.get(row).setReadOnly(rowReadOnly || permissions?.change_required_skills===false);
    });
    editor.querySelector('[data-task-subtask-add]').disabled = readOnly;
    reorder.refresh();
    assignments?.refresh();
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
    const original=JSON.parse(row.dataset.subtaskValue || '{}');
    originals.set(row,original);
    delete row.dataset.subtaskValue;
    pickers.set(row, bindSkillPicker(row, { onChange: changed, onCreateSkill: createSkill }));
    const orderRoot=row.querySelector('[data-task-subtask-group-order]');
    if(orderRoot){
      const config=typeof original.assignment_group_json==='string'?JSON.parse(original.assignment_group_json):original.assignment_group||original.assignment_group_json;
      const order=bindGroupAssignmentOrder(orderRoot,{onChange:()=>row.dispatchEvent(new Event('input',{bubbles:true}))});
      order.set(assignmentGroupBehavior(groups.find(group=>Number(group.id)===Number(config?.group_id)),
        {dateKey:typeof dateKey==='function'?dateKey():dateKey,template}),config?.member_order||[]);
      groupOrders.set(row,order);
    }
  };
  const click = (event) => {
    if (readOnly) { if (event.target.closest('.task-subtask-editor__actions')) event.preventDefault(); return; }
    const manage=event.target.closest('[data-task-subtask-manage-group]');
    if(manage){const groupId=Number(manage.closest('[data-task-subtask-row]').querySelector('[data-task-subtask-group]')?.value);
      if(groupId)import('/components/rotation-groups.js').then(module=>module.openRotationGroup(groupId,{onChanged:async()=>{
        const result=await api.get('/automation/activity-options');groups.splice(0,groups.length,...(result.data?.rotation_groups||[]));refresh();}}))
        .then(()=>manage.focus({preventScroll:true})).catch(error=>{const status=editor.querySelector('[data-task-subtask-announcement]');status.textContent=error.message;});
      return;}
    const add = event.target.closest('[data-task-subtask-add]');
    if (add && editor.contains(add)) {
      rows.insertAdjacentHTML('beforeend', subtaskRow({}, skills, template, rows.children.length, !!onCreateSkill, users,groups,canCreateGroup));
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
      groupOrders.get(row)?.dispose();
      groupOrders.delete(row);
      row.remove();
      (target?.querySelector('[data-task-subtask-title]') || editor.querySelector('[data-task-subtask-add]')).focus();
    }
    refresh();
    changed();
  };
  const input = (event) => { if (!readOnly && event.target.matches('[data-task-subtask-title], [data-task-subtask-points]')) changed(); };
  const change = (event) => { if (!readOnly && event.target.matches('[data-task-subtask-optional], [data-task-subtask-assignee], [data-task-subtask-group], [data-task-subtask-group-start], [data-task-subtask-group-direction]')) {
    if(event.target.matches('[data-task-subtask-group]')){const row=event.target.closest('[data-task-subtask-row]');if(event.target.value){const person=row.querySelector('[data-task-subtask-assignee]');if(person){person.value='';person.dispatchEvent(new Event('change',{bubbles:true}));}}refresh();}
    changed();
  } };
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
    refresh,
    addSkill,
    addGroup(group){if(!group||groups.some(item=>Number(item.id)===Number(group.id)))return;
      groups.push(group);
      for(const row of rows.children){const select=row.querySelector('[data-task-subtask-group]');if(select)select.add(new Option(group.name,String(group.id)));}
    },
    ready: reorder.ready.then(() => undefined),
    setValue(subtasks = []) {
      pickers.forEach((picker) => picker.dispose());
      pickers.clear();
      groupOrders.forEach(order=>order.dispose());groupOrders.clear();
      rows.replaceChildren();
      rows.insertAdjacentHTML('beforeend', subtasks.map((subtask, index) => subtaskRow(subtask, skills, template, index, !!onCreateSkill, users,groups,canCreateGroup)).join(''));
      [...rows.children].forEach(bindRow);
      refresh();
    },
    setReadOnly(value) { readOnly = Boolean(value); refresh(); },
    setAssignmentsEnabled(value, {allowed=canAssign,preserveHistory=true}={}) { assignmentsEnabled=Boolean(value);canAssign=allowed;preserveAssignmentHistory=preserveHistory;refresh(); },
    setPointsMode(value, { settledTaskIds = [], allowed = canChangePoints } = {}) { pointsMode = value; settledIds = new Set(settledTaskIds.map(Number)); canChangePoints = allowed; refresh(); },
    dispose() {
      editor.removeEventListener('click', click);
      editor.removeEventListener('input', input);
      editor.removeEventListener('change', change);
      editor.removeEventListener('keydown', keydown);
      reorder.dispose();
      assignments?.dispose();
      pickers.forEach((picker) => picker.dispose());
      groupOrders.forEach(order=>order.dispose());
    },
  };
}
