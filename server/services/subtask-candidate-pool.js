/** Authoring choices only. Never materialize these IDs as Task assignments. */
const invalid = message => Object.assign(new Error(message), { status: 400 });
export function normalizeSubtaskCandidatePool(d, value, { previous = null } = {}) {
  if (value === undefined) return previous;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['person_ids', 'group_ids'].includes(key)))
    throw invalid('Choose valid People and Groups for subtasks.');
  const ids = (source, label) => {
    if (!Array.isArray(source) || source.length > 50 || source.some(id => !Number.isSafeInteger(id) || id < 1)
        || new Set(source).size !== source.length) throw invalid(`Choose distinct valid ${label}.`);
    return [...source];
  };
  const person_ids = ids(value.person_ids, 'subtask people');
  const group_ids = ids(value.group_ids, 'subtask Groups');
  if (person_ids.length) {
    const found = d.prepare(`SELECT id FROM users WHERE id IN (${person_ids.map(() => '?').join(',')})
      AND NOT EXISTS (SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=users.id)
      AND NOT EXISTS (SELECT 1 FROM housekeeping_workers h WHERE h.user_id=users.id)`)
      .all(...person_ids);
    if (found.length !== person_ids.length) throw invalid('A selected subtask person is unavailable.');
  }
  if (group_ids.length) {
    const found = d.prepare(`SELECT id,active FROM rotation_groups WHERE id IN (${group_ids.map(() => '?').join(',')})`)
      .all(...group_ids);
    const prior = new Set(previous?.group_ids || []);
    if (found.length !== group_ids.length || found.some(group => !group.active && !prior.has(group.id)))
      throw invalid('A selected subtask Group is unavailable.');
  }
  return { person_ids, group_ids };
}
