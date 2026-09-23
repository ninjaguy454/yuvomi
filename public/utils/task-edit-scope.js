import { calendarDayOffset } from './activity-schedule.js';

const ids = values => [...new Set((values || []).map(Number))].sort((a, b) => a - b);
const text = value => String(value ?? '').trim();

/** Compare reusable form intent, excluding status and occurrence-only dates. */
export function taskEditDefinition(value) {
  return {
    title: text(value.title), description: text(value.description),
    category: value.category || 'misc', priority: value.priority || 'none',
    points: Number(value.points) || 0, tags: [...new Set((value.tags || []).map(text).filter(Boolean))].sort(),
    subtasks: (value.subtasks || []).filter(step => text(step.title)).map(step => ({
      id: Number(step.id) || null, title: text(step.title), is_optional: !!step.is_optional, skill_ids: ids(step.skill_ids),
      ...(step.assigned_user_ids===undefined?{}:{assigned_user_ids:ids(step.assigned_user_ids)}),
    })),
    skill_ids: ids(value.skill_ids), assigned_to: ids(value.assigned_to),
    assignment_mode: value.assignment_mode || 'fixed', rotation_user_ids: (value.rotation_user_ids || []).map(Number),
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
  return ['Changes applied.', historical ? 'This historical occurrence was preserved.' : '',
    count ? `${count} future ${count === 1 ? 'occurrence was' : 'occurrences were'} preserved because ${count === 1 ? 'it could' : 'they could'} not be safely updated.${details.length ? ` Reasons: ${details.join('; ')}.` : ''}` : '',
    pending?`${pending} future ${pending===1?'occurrence is':'occurrences are'} waiting for rotation resolution.`:''].filter(Boolean).join(' ');
}
