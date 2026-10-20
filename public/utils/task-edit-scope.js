import { calendarDayOffset } from './activity-schedule.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { memberLabel } from '/utils/member-label.js';
import { validTaskPoints } from './task-form-validation.js';

const ids = values => [...new Set((values || []).map(Number))].sort((a, b) => a - b);
const text = value => String(value ?? '').trim();
const point = value => value === undefined ? 0 : validTaskPoints(value) ? Number(value) : value;
const assignmentGroup=value=>typeof value==='string'?JSON.parse(value):value||null;

/** Compare reusable form intent, excluding status and occurrence-only dates. */
export function taskEditDefinition(value) {
  return {
    title: text(value.title), description: text(value.description),
    category: value.category || 'misc', priority: value.priority || 'none',
    ...(value.card_color_choice?{card_color_choice:value.card_color_choice}:{}),
    ...(value.scoring_mode ? { scoring_mode: value.scoring_mode } : {}),
    points: point(value.points), tags: [...new Set((value.tags || []).map(text).filter(Boolean))].sort(),
    subtasks: (value.subtasks || []).filter(step => text(step.title)).map(step => ({
      id: Number(step.id) || null, ...(step.action_key ? {action_key:step.action_key} : {}), ...(step.client_key ? {client_key:step.client_key} : {}), title: text(step.title), points: point(step.points), is_optional: !!step.is_optional, skill_ids: ids(step.skill_ids),
      ...(step.assigned_user_ids===undefined?{}:{assigned_user_ids:ids(step.assigned_user_ids)}),
      assignment_group:assignmentGroup(step.assignment_group??step.assignment_group_json),
    })),
    skill_ids: ids(value.skill_ids), assigned_to: ids(value.assigned_to),
    assignment_mode: value.assignment_mode || 'fixed',assignment_group:assignmentGroup(value.assignment_group??value.assignment_group_json), rotation_user_ids: (value.rotation_user_ids || []).map(Number),
    rotation_group: text(value.rotation_group), rotation_slot: Number(value.rotation_slot) || 0,
    rotation_bindings:(value.rotation_bindings||[]).map(({direction,...binding}) =>
      !direction || direction === 'first_to_last' ? binding : {...binding,direction}),
    activity_template_id: Number(value.activity_template_id) || null,
    activity_subject_user_id: Number(value.activity_subject_user_id) || null,
    activity_inputs: value.activity_inputs || {},
    visibility: value.visibility || 'all', countdown: !!value.countdown, locked: !!value.locked,
    location: value.location || { kind: 'none' },
    start_time: value.start_time || null, due_time: value.due_time || null,
    due_span: calendarDayOffset(value.start_date, value.due_date),
    is_recurring: !!value.is_recurring, recurrence_rule: value.recurrence_rule || null,
    recurrence_from_completion: !!value.recurrence_from_completion,
    expiration_policy: value.expiration_policy || 'keep_overdue',
  };
}

export function hasTaskDefinitionChanges(before, after) {
  return JSON.stringify(taskEditDefinition(before)) !== JSON.stringify(taskEditDefinition(after));
}

export function taskEditResultMessage(result, fallback) {
  const preserved = result?.series_edit?.preserved ?? result?.preserved;
  const count = Array.isArray(preserved) ? preserved.length : Number(preserved) || 0;
  const historical = result?.series_edit?.current_preserved === true;
  const pending=result?.series_edit?.pending_rotations?.length||0;
  if (!count && !historical && !pending) return fallback;
  const reasons = {
    historical: 'completed, expired or archived', activity: 'existing activity', progress: 'existing progress',
    manual_edit: 'occurrence-specific changes', assignment_response: 'an assignment response',
    unverified_legacy_occurrence: 'an older occurrence that cannot be safely verified',
    schedule_ended: 'the series schedule has ended', schedule_conflict: 'a scheduling conflict',
    eligibility_or_permission: 'eligibility or permission restrictions',
    rotation_snapshot: 'an already resolved rotation snapshot',
  };
  const details = Array.isArray(preserved)
    ? [...new Set(preserved.map(item => reasons[item?.reason]).filter(Boolean))] : [];
  return ['Changes applied.', historical ? result?.series_edit?.scope === 'future_only' ? t('tasks.scoringPreserved') : 'This historical occurrence was preserved.' : '',
    count ? `${count} future ${count === 1 ? 'occurrence was' : 'occurrences were'} preserved because ${count === 1 ? 'it could' : 'they could'} not be safely updated.${details.length ? ` Reasons: ${details.join('; ')}.` : ''}` : '',
    pending?`${pending} future ${pending===1?'occurrence is':'occurrences are'} waiting for rotation resolution.`:''].filter(Boolean).join(' ');
}

const futureFields = ['card_color_choice','title','description','category','priority','start_date','start_time','due_date','due_time','due_date_offset_days','is_recurring','recurrence_rule','recurrence_from_completion','assignment_mode','assignment_group','rotation_group','rotation_slot','points','visibility','countdown','locked','expiration_policy','scoring_mode','assigned_to','rotation_user_ids','skill_ids','tags','rotation_bindings'];
const actionFields = ['title','description','category','priority','start_date','start_time','due_date','due_time','points','visibility','locked','expiration_policy','is_optional','assigned_user_ids','assignment_group','skill_ids','tags'];
const comparable = (key, value) => ['is_optional','is_recurring','countdown','locked','recurrence_from_completion'].includes(key) ? !!value
  : key === 'points' ? point(value) : value;
const writable = (key, value) => value !== undefined && (key !== 'points' || validTaskPoints(value)) && (key !== 'scoring_mode' || ['whole_task','subtasks'].includes(value));

/** Sparse explicit intent over the authorized canonical BEFORE editor projection. */
export function taskFuturePatch(definition, draft, rootIntent = []) {
  const fields = {}, actions = {}, intent = new Set(rootIntent);
  for (const key of futureFields) {
    const baseline=key==='assigned_to'?definition.fields.direct_assignee_ids??definition.fields[key]:definition.fields[key];
    if (intent.has(key) && writable(key,draft[key]) && JSON.stringify(comparable(key,draft[key])) !== JSON.stringify(comparable(key,baseline))) fields[key] = key==='points'?point(draft[key]):draft[key];
  }
  const original = new Map((definition.actions || []).map(action => [action.action_key,action]));
  const next = (draft.subtasks || []).filter(row => row.action_key || text(row.title));
  const update = [], add = [], order = [];
  for (const row of next) {
    const old = original.get(row.action_key), changed = {};
    for (const key of actionFields) if (writable(key,row[key]) && (!old || JSON.stringify(comparable(key,row[key])) !== JSON.stringify(comparable(key,old.fields[key])))) changed[key] = key==='points'?point(row[key]):row[key];
    if (old) { order.push(row.action_key); if (Object.keys(changed).length) update.push({action_key:row.action_key,fields:changed}); }
    else { add.push({client_key:row.client_key,fields:changed}); order.push(`new:${row.client_key}`); }
  }
  const remove = [...original.keys()].filter(key => !next.some(row => row.action_key === key));
  if (update.length) actions.update = update;
  if (add.length) actions.add = add;
  if (remove.length) actions.remove = remove;
  if (JSON.stringify(order) !== JSON.stringify([...original.keys()])) actions.order = order;
  return {...(Object.keys(fields).length ? {fields} : {}), ...(Object.keys(actions).length ? {actions} : {})};
}

/** Editing intent only: no status, recipient eligibility or reward calculation. */
export function hasTaskScoringChanges(before, after) {
  const terms = value => [value.scoring_mode,point(value.points),value.assigned_to,value.assignment_mode,value.rotation_user_ids,
    value.rotation_group,value.rotation_slot,value.rotation_bindings,value.assignment_group,value.skill_ids,
    (value.subtasks || []).map(row => [row.id || row.action_key || row.client_key,point(row.points),row.assigned_user_ids,row.assignment_group,row.skill_ids])];
  return JSON.stringify(terms(before)) !== JSON.stringify(terms(after));
}

export function taskScoringErrorMessage(error) {
  if(error.data?.reason!=='scoring_projection_unavailable')return error.data?.error || error.message;
  const codes={next_occurrence_unavailable:'scoringNoNext',recurrence_ended:'scoringEnded',target_preserved:'scoringTargetPreserved',random_assignment_unresolved:'scoringRandom',binding_policy_changed:'scoringBindingChanged',projection_evidence_unavailable:'scoringEvidence'};
  return [t('tasks.scoringForecastUnavailable'),...[...new Set(error.data.conditions || [])].filter(code=>codes[code]).map(code=>t(`tasks.${codes[code]}`))].join(' ');
}

export function renderTaskScoringPreview(data, users = []) {
  const label = id => memberLabel(users.find(user => Number(user.id) === Number(id)) || {id}) || t('tasks.commentUnknownAuthor');
  const recipients = rows => (rows || []).map(row => `<span>${esc(label(row.user_id))}: <strong>${row.points}</strong></span>`).join(' · ');
  const history = (data.settlements || []).map(row => `<li data-scoring-settlement="${esc(row.settlement_id)}">${esc(row.title || t('tasks.scoringHistory'))}: ${row.points === null ? esc(t('tasks.scoringUnknown')) : row.points}${row.is_optional ? ` · ${esc(t('tasks.scoringOptional'))}` : ''}<div>${recipients(row.recipients)}</div></li>`).join('');
  const phase = name => `<section><h4>${t(name === 'before' ? 'tasks.scoringBefore' : 'tasks.scoringAfter')}</h4><p>${recipients(data[name])}</p><ul>${(data[`${name}_units`] || []).map(unit => `<li data-scoring-unit="${esc(JSON.stringify(unit.ref))}">${esc(unit.title)}${unit.is_optional ? ` · ${esc(t('tasks.scoringOptional'))}` : ''}: ${unit.points}<div>${recipients(unit.recipients) || esc(t(unit.outcome === 'zero' ? 'tasks.scoringZero' : 'tasks.scoringNoRecipients'))}</div></li>`).join('')}</ul></section>`;
  const forecast = data.forecast_context;
  const conditions = {completion_date_assumed:'tasks.scoringAssumed',binding_assignment_reprepared:'tasks.scoringReprepared',prospective_supervision_unresolved:'tasks.scoringUnresolved'};
  return `<div class="task-scoring-preview"><h3>${t(forecast ? 'tasks.scoringNext' : 'tasks.scoringCurrent')}</h3>${forecast ? `<p>${esc(t('tasks.scoringAsOf',{date:forecast.as_of_date,generation:forecast.effective_generation}))}</p>${['before','after'].map(name=>`<p>${t(name==='before'?'tasks.scoringBefore':'tasks.scoringAfter')}: ${esc(t('tasks.scoringWindow',{start:[forecast[name].start_date,forecast[name].start_time].filter(Boolean).join(' ') || '—',due:[forecast[name].due_date,forecast[name].due_time].filter(Boolean).join(' ') || '—',preparation:t(forecast[name].preparation==='fresh'?'tasks.scoringFresh':'tasks.scoringUntouched')}))}</p>`).join('')}${(forecast.conditions || []).filter(code=>conditions[code]).map(code=>`<p>${esc(t(conditions[code]))}</p>`).join('')}` : ''}
    ${data.current_preserved ? `<p>${esc(t('tasks.scoringPreserved'))}</p>` : ''}
    <section><h4>${t('tasks.scoringHistory')}</h4><p>${recipients(data.earned)}</p><ul>${history}</ul></section>
    <div class="task-scoring-preview__phases">${phase('before')}${phase('after')}</div>
    ${(data.warnings || []).map(warning=>`<p role="status">${esc(warning.reason === 'prospective_supervision_unresolved' ? t('tasks.scoringUnresolved') : warning.message)}</p>`).join('')}
  </div>`;
}
