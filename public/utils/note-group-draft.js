/** Pure, in-memory command snapshots. Only the server can authorize a command. */
export function newNoteGroupOperationId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues !== 'function') throw new Error('Secure operation identity is unavailable. Reload the board in a supported browser.');
  // Local HTTP browsers expose getRandomValues even without secure-context UUIDs.
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

const unavailable = () => new Error('This action is no longer available. Reload the board.');
const validId = id => Number.isSafeInteger(id) && id > 0;
const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function ids(value) {
  if (!Array.isArray(value) || !value.length || value.some(id => !validId(id))) throw new TypeError('Choose a valid selection.');
  return [...new Set(value)];
}
function exactFields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !(key in value))) {
    throw new TypeError('Invalid command fields.');
  }
}

export function orderedSelection(memberIds, selectedIds) {
  const selected = new Set(ids(selectedIds));
  if ([...selected].some(id => !memberIds.includes(id))) throw new TypeError('Selection is no longer available.');
  return memberIds.filter(id => selected.has(id));
}

export function moveSelectionBefore(memberIds, selectedIds, beforeId) {
  const selected = orderedSelection(memberIds, selectedIds), remaining = memberIds.filter(id => !selected.includes(id));
  const index = beforeId === null ? remaining.length : remaining.indexOf(beforeId);
  if (index < 0) throw new TypeError('Choose a remaining insertion target.');
  return [...remaining.slice(0, index), ...selected, ...remaining.slice(index)];
}

export function createNoteGroupDraft(board, operationId) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new TypeError('An operation identity is required.');
  if (!Array.isArray(board?.notes) || !Array.isArray(board?.groups)) throw new TypeError('An authorized board is required.');
  // Content and previews are unnecessary for a structural revision snapshot.
  return freeze({ operation_id: operationId, board: {
    notes: board.notes.map(note => ({ id: note.id, revision: note.revision, layout_revision: note.layout?.revision ?? 0 })),
    groups: board.groups.map(group => ({ id: group.id, revision: group.revision, member_ids: [...group.member_ids], can_manage: group.can_manage })),
  } });
}

/** Freeze once, then send this same object on every explicit Retry. */
export function freezeNoteGroupCommand(draft, kind, input) {
  const fields = clone(input), notes = new Map(draft.board.notes.map(note => [note.id, note])), groups = new Map(draft.board.groups.map(group => [group.id, group]));
  const affectedNotes = new Set(), affectedGroups = new Set();
  const memberOf = id => draft.board.groups.find(group => group.member_ids.includes(id));
  const useNote = (id, standalone = false) => {
    if (!validId(id) || !notes.has(id)) throw unavailable();
    if (standalone && memberOf(id)) throw new Error('Choose a standalone note instead of a group member.');
    affectedNotes.add(id);
  };
  const useGroup = id => {
    const group = groups.get(id);
    if (!validId(id) || !group?.can_manage) throw unavailable();
    affectedGroups.add(id); group.member_ids.forEach(id => useNote(id));
    return group;
  };
  const selection = group => { fields.selected_ids = orderedSelection(group.member_ids, fields.selected_ids); };
  const insertion = members => {
    if (fields.before_note_id !== null && !members.includes(fields.before_note_id)) throw new TypeError('Choose a remaining insertion target.');
  };
  switch (kind) {
    case 'create': {
      if ('source_note_id' in fields) {
        exactFields(fields, ['source_note_id', 'target_note_id']);
        useNote(fields.source_note_id, true);
        if (fields.source_note_id === fields.target_note_id) throw new TypeError('Choose a different target note.');
      } else {
        exactFields(fields, ['source_group_id', 'selected_ids', 'target_note_id']);
        selection(useGroup(fields.source_group_id));
      }
      useNote(fields.target_note_id, true);
      break;
    }
    case 'reorder': {
      exactFields(fields, ['group_id', 'selected_ids', 'before_note_id']);
      const group = useGroup(fields.group_id); selection(group);
      insertion(group.member_ids.filter(id => !fields.selected_ids.includes(id)));
      break;
    }
    case 'transfer': {
      exactFields(fields, ['source_group_id', 'target_group_id', 'selected_ids', 'before_note_id']);
      selection(useGroup(fields.source_group_id));
      const target = useGroup(fields.target_group_id);
      insertion(target.member_ids.filter(id => !fields.selected_ids.includes(id)));
      break;
    }
    case 'join': {
      exactFields(fields, ['target_group_id', 'note_ids', 'before_note_id']);
      insertion(useGroup(fields.target_group_id).member_ids);
      fields.note_ids = ids(fields.note_ids); fields.note_ids.forEach(id => useNote(id, true));
      break;
    }
    case 'extract': {
      exactFields(fields, ['source_group_id', 'selected_ids', 'result', 'placements']);
      selection(useGroup(fields.source_group_id));
      if (!['group', 'individual'].includes(fields.result) || !Array.isArray(fields.placements) || fields.placements.length !== (fields.result === 'group' ? 1 : fields.selected_ids.length)) throw new TypeError('Confirm the exact placement preview.');
      break;
    }
    case 'arrange': {
      exactFields(fields, ['items', 'include_locked']);
      if (!Array.isArray(fields.items) || !fields.items.length || typeof fields.include_locked !== 'boolean') throw new TypeError('Invalid arrangement fields.');
      const unique = new Set();
      for (const item of fields.items) {
        exactFields(item, ['kind', 'id', 'layout']);
        if (unique.has(`${item.kind}:${item.id}`)) throw new TypeError('Duplicate arrangement item.');
        unique.add(`${item.kind}:${item.id}`);
        if (item.kind === 'group') useGroup(item.id);
        else if (item.kind === 'note') useNote(item.id, true);
        else throw new TypeError('Invalid arrangement kind.');
      }
      break;
    }
    case 'undo':
      exactFields(fields, ['undo_operation_id']);
      if (typeof fields.undo_operation_id !== 'string' || !fields.undo_operation_id.trim()) throw new TypeError('Choose an operation to undo.');
      // The receipt owns the exact affected scope and checks its after-state.
      break;
    default: throw new TypeError('Unknown group operation.');
  }
  if (affectedNotes.size > 500) throw new RangeError('This action affects more than 500 notes. Choose fewer notes or smaller groups.');
  const expected = {
    groups: [...affectedGroups].sort((a, b) => a - b).map(id => ({ id, revision: groups.get(id).revision })),
    notes: [...affectedNotes].sort((a, b) => a - b).map(id => ({ ...notes.get(id) })),
  };
  return freeze({ operation_id: draft.operation_id, kind, expected, ...fields });
}
