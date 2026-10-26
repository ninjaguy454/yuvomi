import { resolveActivityDueDate, deriveActivityDueOffset } from './activity-schedule.js';

function instanceGroup(value) {
  if(!value)return null;
  const saved=typeof value==='string'?JSON.parse(value):value;
  const {member_order,...configuration}=saved;
  return configuration;
}

/** Manual form defaults only. Generated tasks keep their own context/location. */
export function createManualTaskDraft({ template = null, places = [], defaultPoints = 0, presetDates = null, occurrenceStartDate = null } = {}) {
  const home = places.find((place) => place.type === 'home' && place.active !== 0 && place.active !== false);
  let location = home ? { kind: 'saved_place', place_id: Number(home.id) } : { kind: 'none' };
  if (template?.location_mode === 'fixed') location = { kind: 'saved_place', place_id: Number(template.place_id) || null };
  if (template?.location_mode === 'workflow') location = { kind: 'none' };
  const startDate = occurrenceStartDate || presetDates?.start_date || null;
  const dueDate = template?.due_date_offset_days != null
    ? resolveActivityDueDate(startDate, template.due_date_offset_days) : presetDates?.due_date || null;
  return {
    title: template?.title_template || template?.name || '', description: template?.description || '',
    priority: template?.priority || 'none', category: template?.category || 'misc',
    points: template ? Number(template.points) || 0 : Number(defaultPoints) || 0,
    ...(template?.scoring_mode != null ? { scoring_mode: template.scoring_mode } : {}),
    expiration_policy: template?.expiration_policy || 'keep_overdue',
    tags: [...(template?.tags || [])], location,
    start_date: startDate, due_date: dueDate,
    start_time: template?.start_time || null, due_time: template?.due_time || null,
    recurrence_rule: template?.recurrence_rule || null,
    is_recurring: template?.recurrence_rule ? 1 : 0,
    recurrence_from_completion: template?.recurrence_from_completion ? 1 : 0,
    rotation_bindings: structuredClone(template?.rotation_bindings || JSON.parse(template?.rotation_bindings_json || '[]')),
    assigned_to: template?.assignment_strategy === 'fixed'
      ?template.fixed_assignee_ids?.length?[...template.fixed_assignee_ids]:Number(template.fixed_user_id)||null:null,
    additional_assignee_ids:[...(template?.additional_assignee_ids??JSON.parse(template?.additional_assignee_ids_json||'[]'))],
    skill_ids: [...(template?.skill_ids || [])],
    subtasks: (template?.checklist || []).map((step) => ({ title: step.title_template || step.title || '', skill_ids: [...(step.skill_ids || [])], is_optional: step.is_optional ? 1 : 0,
      ...(step.assignment_rule||step.assignment_rule_json?{assignment_rule:structuredClone(typeof step.assignment_rule_json==='string'?JSON.parse(step.assignment_rule_json):step.assignment_rule),
        supervisor_pool:structuredClone(typeof step.supervisor_pool_json==='string'?JSON.parse(step.supervisor_pool_json):step.supervisor_pool??null)}:{}),
      ...(step.fixed_user_id?{assigned_user_ids:[Number(step.fixed_user_id)]}:{}),
      ...(step.assignment_group_json||step.assignment_group
        ?{assignment_group:instanceGroup(step.assignment_group_json||step.assignment_group)}:{}),
      ...(step.points != null ? { points: Number(step.points) } : {}),
      ...(step.id?{activity_template_checklist_item_id:step.id}:{}) })),
  };
}

/** A snapshot excludes the selector being changed, but includes custom form state. */
export function taskDraftSnapshot(form, { tags = [], documents = [], pendingFiles = false } = {}) {
  const fields = [...form.querySelectorAll('input:not([type="file"]), select, textarea, yuvomi-datepicker')]
    .filter((field) => field.id !== 'task-activity-template' && field.id !== 'task-id')
    .map((field) => [field.name || field.id || field.dataset?.taskSubtaskTitle || '',
      field.type === 'checkbox' || field.type === 'radio' ? [field.value, field.checked] : field.value]);
  const groupOrders=[...form.querySelectorAll('[data-task-group-order], [data-task-subtask-group-order]')]
    .map(root=>root.dataset.groupOrderValue||'null');
  const poolGroups=[...form.querySelectorAll('[data-subtask-pool-group][aria-pressed="true"]')]
    .map(button=>Number(button.dataset?.subtaskPoolGroup));
  return JSON.stringify({ fields, groupOrders, poolGroups, tags, documents, pendingFiles });
}

/** Convert only fields supported by reusable Activity Templates. */
export function taskDraftToActivity(draft, template = null) {
  const location = draft.location || {};
  const { start_date: _startDate, due_date: _dueDate, ...reusableTemplate } = template || {};
  const scoringMode = draft.scoring_mode || draft.scoring?.mode || template?.scoring_mode;
  const decodeGroup=value=>typeof value==='string'?JSON.parse(value):value??null;
  const assignmentGroup=decodeGroup(Object.hasOwn(draft,'assignment_group')?draft.assignment_group:template?.assignment_group_json);
  const fixedIds=[...new Set((draft.assigned_users||[]).map(Number).filter(Boolean))];
  const assignmentStrategy=assignmentGroup?'group_rotation':template?.assignment_strategy==='group_rotation'
    ?fixedIds.length?'fixed':'open_claimable'
    :template?.assignment_strategy||(fixedIds.length?'fixed':'open_claimable');
  return {
    ...reusableTemplate, id: undefined, name: draft.title, title_template: draft.title,
    description: draft.description || '', priority: draft.priority || 'none', category: draft.category,
    points: Number(draft.points) || 0, tags: [...(draft.tags || [])], skill_ids: [...(draft.skill_ids || [])],
    scoring_mode: ['whole_task', 'subtasks'].includes(scoringMode) ? scoringMode : 'whole_task',
    expiration_policy: draft.expiration_policy || 'keep_overdue',
    due_date_offset_days: deriveActivityDueOffset(draft.start_date, draft.due_date),
    start_time: draft.start_time || null, due_time: draft.due_time || null,
    recurrence_rule: draft.recurrence_rule || null,
    recurrence_from_completion: draft.recurrence_from_completion ? 1 : 0,
    rotation_bindings: structuredClone(draft.rotation_bindings || []),
    checklist: (draft.subtasks || []).map((step) => ({ title_template: step.title, skill_ids: [...(step.skill_ids || [])], is_optional: step.is_optional ? 1 : 0,
      ...(step.assignment_rule||step.subtask_assignment_rule?{assignment_rule:structuredClone(step.assignment_rule??step.subtask_assignment_rule),supervisor_pool:structuredClone(step.supervisor_pool??step.subtask_supervisor_pool??null)}:{}),
      ...(!step.assignment_rule&&!step.subtask_assignment_rule&&!step.assignment_group&&!step.assignment_group_json&&step.assigned_user_ids?.length
        ?{fixed_user_id:Number(step.assigned_user_ids[0])}:{}),
      ...(Object.hasOwn(step,'assignment_group')||Object.hasOwn(step,'assignment_group_json')
        ?{assignment_group:decodeGroup(Object.hasOwn(step,'assignment_group')?step.assignment_group:step.assignment_group_json)}:{}),
      ...(step.points != null ? { points: Number(step.points) } : {}) })),
    location_mode: location.kind === 'saved_place' ? 'fixed' : 'none',
    place_id: location.kind === 'saved_place' ? location.place_id : null,
    assignment_strategy: assignmentStrategy, assignment_group_json:assignmentGroup,
    subtask_candidate_pool_json:draft.subtask_candidate_pool??template?.subtask_candidate_pool_json??null,
    additional_assignee_ids:[...(draft.additional_assignee_ids??template?.additional_assignee_ids??JSON.parse(template?.additional_assignee_ids_json||'[]'))],
    fixed_user_id: assignmentGroup?null:fixedIds[0]||null,
    fixed_assignee_ids:assignmentGroup?null:fixedIds.length>1?fixedIds:null,
    subject_required: template?.subject_required ? 1 : 0,
  };
}
