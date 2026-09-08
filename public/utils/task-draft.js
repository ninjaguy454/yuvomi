/** Manual form defaults only. Generated tasks keep their own context/location. */
export function createManualTaskDraft({ template = null, places = [], defaultPoints = 0, presetDates = null } = {}) {
  const home = places.find((place) => place.type === 'home' && place.active !== 0 && place.active !== false);
  let location = home ? { kind: 'saved_place', place_id: Number(home.id) } : { kind: 'none' };
  if (template?.location_mode === 'fixed') location = { kind: 'saved_place', place_id: Number(template.place_id) || null };
  if (template?.location_mode === 'workflow') location = { kind: 'none' };
  return {
    title: template?.title_template || template?.name || '', description: template?.description || '',
    priority: template?.priority || 'none', category: template?.category || 'misc',
    points: template ? Number(template.points) || 0 : Number(defaultPoints) || 0,
    tags: [...(template?.tags || [])], location,
    start_date: presetDates?.start_date || null, due_date: presetDates?.due_date || null,
    skill_ids: [...(template?.skill_ids || [])],
    subtasks: (template?.checklist || []).map((step) => ({ title: step.title_template || step.title || '', skill_ids: [...(step.skill_ids || [])] })),
  };
}

/** A snapshot excludes the selector being changed, but includes custom form state. */
export function taskDraftSnapshot(form, { tags = [], documents = [], pendingFiles = false } = {}) {
  const fields = [...form.querySelectorAll('input:not([type="file"]), select, textarea, yuvomi-datepicker')]
    .filter((field) => field.id !== 'task-activity-template' && field.id !== 'task-id')
    .map((field) => [field.name || field.id || field.dataset.taskSubtaskTitle || '',
      field.type === 'checkbox' || field.type === 'radio' ? [field.value, field.checked] : field.value]);
  return JSON.stringify({ fields, tags, documents, pendingFiles });
}

/** Convert only fields supported by reusable Activity Templates. */
export function taskDraftToActivity(draft, template = null) {
  const location = draft.location || {};
  return {
    ...(template || {}), id: undefined, name: draft.title, title_template: draft.title,
    description: draft.description || '', priority: draft.priority || 'none', category: draft.category,
    points: Number(draft.points) || 0, tags: [...(draft.tags || [])], skill_ids: [...(draft.skill_ids || [])],
    checklist: (draft.subtasks || []).map((step) => ({ title_template: step.title, skill_ids: [...(step.skill_ids || [])] })),
    location_mode: location.kind === 'saved_place' ? 'fixed' : 'none',
    place_id: location.kind === 'saved_place' ? location.place_id : null,
    assignment_strategy: template?.assignment_strategy || (draft.assigned_users?.length === 1 ? 'fixed' : 'open_claimable'),
    fixed_user_id: template?.fixed_user_id || (draft.assigned_users?.length === 1 ? draft.assigned_users[0] : null),
    subject_required: template?.subject_required ? 1 : 0,
  };
}
