/** A dialog-local draft: recipient selection never changes the session identity. */
export function createAcceptanceDraft(projection, operationId) {
  return { projection, operationId, primary: Number(projection.primary_user_id) || null, helpers: [], assignments: {}, submission: null };
}

export function setAcceptanceHelpers(draft, ids) {
  if (draft.submission) return;
  const allowed = new Set(draft.projection.can_add_helpers ? draft.projection.coassignee_candidates.map(member => Number(member.id)) : []);
  draft.helpers = [...new Set(ids.map(Number))].filter(id => id !== draft.primary && allowed.has(id));
  for (const [id, recipient] of Object.entries(draft.assignments)) {
    if (recipient !== draft.primary && !draft.helpers.includes(recipient)) draft.assignments[id] = null;
  }
  // Without helpers there is no allocation screen, so no hidden allocations.
  if (!draft.helpers.length) draft.assignments = {};
}

export function needsAcceptanceAllocation(draft) {
  return draft.helpers.length > 0 && draft.projection.subtasks.length > 0;
}

export function assignAcceptanceSubtask(draft, id, userId) {
  if (draft.submission) return false;
  const child = draft.projection.subtasks.find(row => Number(row.id) === Number(id));
  const recipient = userId == null ? null : Number(userId);
  if (!child?.allocatable || recipient != null && (!(recipient === draft.primary || draft.helpers.includes(recipient)) || !child.eligible_assignee_ids.map(Number).includes(recipient))) return false;
  draft.assignments[Number(id)] = recipient;
  return true;
}

export function acceptancePayload(draft) {
  return {
    operation_id: draft.operationId,
    expected_revision: draft.projection.expected_revision,
    primary_user_id: draft.primary,
    coassignee_ids: [...draft.helpers],
    subtask_snapshot: draft.projection.subtask_snapshot.map(row => ({ id: row.id, revision: row.revision })),
    subtask_assignments: draft.projection.subtasks.filter(row => row.allocatable).map(row => ({ id: row.id, user_id: draft.assignments[row.id] ?? null })),
  };
}

export function lockAcceptancePayload(draft) {
  // Keep this object verbatim on uncertain network retries. Editing requires a
  // fresh projection and a new deliberate confirmation, never a reused key.
  if (!draft.submission) draft.submission = acceptancePayload(draft);
  return structuredClone(draft.submission);
}
