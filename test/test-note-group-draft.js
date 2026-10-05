import test from 'node:test';
import assert from 'node:assert/strict';

const draftModule = await import('../public/utils/note-group-draft.js').catch(() => ({}));
const { createNoteGroupDraft, orderedSelection, moveSelectionBefore, freezeNoteGroupCommand } = draftModule;
const rect = { x: 0, y: 0, width: 4, height: 6, position_locked: false, always_on_top: false };
const note = id => ({ id, revision: id + 10, content: `note ${id}`, layout: { ...rect, revision: id + 20 } });
const group = (id, ids) => ({ id, revision: id + 30, layout: { ...rect }, member_ids: ids, can_manage: true });
const board = () => ({ notes: Array.from({ length: 10 }, (_, i) => note(i + 1)), groups: [group(11, [1, 2, 3, 4]), group(12, [5, 6, 7])] });
const expectedNotes = ids => ids.map(id => ({ id, revision: id + 10, layout_revision: id + 20 }));

test('exports the pure draft contract', () => {
  for (const name of ['createNoteGroupDraft', 'orderedSelection', 'moveSelectionBefore', 'freezeNoteGroupCommand']) assert.equal(typeof draftModule[name], 'function', name);
});

test('operation IDs use secure UUIDs and the local HTTP cryptographic fallback', () => {
  assert.equal(typeof draftModule.newNoteGroupOperationId, 'function');
  assert.equal(draftModule.newNoteGroupOperationId({randomUUID:()=> 'native-uuid'}),'native-uuid');
  let calls=0;
  const cryptoSource={getRandomValues(bytes){calls++;bytes.set(Array.from({length:16},(_,index)=>index));return bytes;}};
  assert.equal(draftModule.newNoteGroupOperationId(cryptoSource),'00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.equal(calls,1);
  assert.throws(()=>draftModule.newNoteGroupOperationId({}),/secure operation identity/i);
});
test('selection deduplicates into canonical order and rejects unknown members', () => {
  assert.deepEqual(orderedSelection([1, 2, 3, 4], [4, 2, 4]), [2, 4]);
  assert.throws(() => orderedSelection([1, 2], [3]), /selection/i);
});
test('the approved block ordering example uses the remaining insertion target', () => {
  const members = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(moveSelectionBefore(members, [9, 2, 7, 5], 4), [1, 3, 2, 5, 7, 9, 4, 6, 8, 10]);
  assert.deepEqual(moveSelectionBefore(members, [5, 2], null), [1, 3, 4, 6, 7, 8, 9, 10, 2, 5]);
  assert.throws(() => moveSelectionBefore(members, [2, 5], 5), /target/i);
});
test('reorder includes all members rather than only the selected block', () => {
  const command = freezeNoteGroupCommand(createNoteGroupDraft(board(), 'reorder-1'), 'reorder', { group_id: 11, selected_ids: [4, 2, 4], before_note_id: 3 });
  assert.deepEqual(command, { operation_id: 'reorder-1', kind: 'reorder', expected: { groups: [{ id: 11, revision: 41 }], notes: expectedNotes([1, 2, 3, 4]) }, group_id: 11, selected_ids: [2, 4], before_note_id: 3 });
});
test('transfer includes both complete groups and preserves source order', () => {
  const command = freezeNoteGroupCommand(createNoteGroupDraft(board(), 'transfer-1'), 'transfer', { source_group_id: 11, target_group_id: 12, selected_ids: [4, 2], before_note_id: 6 });
  assert.deepEqual(command.expected, { groups: [{ id: 11, revision: 41 }, { id: 12, revision: 42 }], notes: expectedNotes([1, 2, 3, 4, 5, 6, 7]) });
  assert.deepEqual(command.selected_ids, [2, 4]);
});
test('create and join snapshot standalone and destination notes', () => {
  const draft = createNoteGroupDraft(board(), 'create-1');
  assert.deepEqual(freezeNoteGroupCommand(draft, 'create', { source_note_id: 8, target_note_id: 9 }).expected, { groups: [], notes: expectedNotes([8, 9]) });
  const join = freezeNoteGroupCommand(draft, 'join', { target_group_id: 11, note_ids: [9, 8, 9], before_note_id: null });
  assert.deepEqual(join.note_ids, [9, 8]);
  assert.deepEqual(join.expected.notes, expectedNotes([1, 2, 3, 4, 8, 9]));
});
test('group-source create snapshots its whole source, and extract preserves exact placements', () => {
  const draft = createNoteGroupDraft(board(), 'extract-1');
  const create = freezeNoteGroupCommand(draft, 'create', { source_group_id: 11, selected_ids: [4, 2], target_note_id: 9 });
  assert.deepEqual(create.expected.notes, expectedNotes([1, 2, 3, 4, 9]));
  assert.deepEqual(create.selected_ids, [2, 4]);
  const placements = [{ ...rect, x: 43, y: 17 }, { ...rect, x: 47, y: 17 }];
  const extract = freezeNoteGroupCommand(draft, 'extract', { source_group_id: 11, selected_ids: [2, 4], result: 'individual', placements });
  assert.deepEqual(extract.placements, placements);
  placements[0].x = 999;
  assert.equal(extract.placements[0].x, 43);
});
test('mixed arrange snapshots all canonical members once', () => {
  const command = freezeNoteGroupCommand(createNoteGroupDraft(board(), 'arrange-1'), 'arrange', { items: [{ kind: 'group', id: 12, layout: rect }, { kind: 'note', id: 8, layout: rect }], include_locked: false });
  assert.deepEqual(command.expected, { groups: [{ id: 12, revision: 42 }], notes: expectedNotes([5, 6, 7, 8]) });
});
test('draft and frozen retry are detached from later board and input mutations', () => {
  const source = board(), fields = { group_id: 11, selected_ids: [2], before_note_id: null };
  const draft = createNoteGroupDraft(source, 'stable-operation');
  source.notes[0].revision = 1000;
  const frozen = freezeNoteGroupCommand(draft, 'reorder', fields), firstPayload = JSON.stringify(frozen);
  fields.selected_ids.push(4);
  assert.throws(() => { frozen.expected.notes[0].revision = 99; }, TypeError);
  assert.throws(() => { frozen.selected_ids.push(4); }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(frozen)), JSON.parse(firstPayload));
  assert.equal(frozen.operation_id, 'stable-operation');
  assert.equal(frozen.expected.notes[0].revision, 11);
});
test('unmanageable or incomplete projections cannot supply structural drafts', () => {
  const source = board(); source.groups[0].can_manage = false;
  assert.throws(() => freezeNoteGroupCommand(createNoteGroupDraft(source, 'denied'), 'reorder', { group_id: 11, selected_ids: [2], before_note_id: null }), /available/i);
  source.groups[0].can_manage = true; source.notes = source.notes.filter(n => n.id !== 1);
  assert.throws(() => freezeNoteGroupCommand(createNoteGroupDraft(source, 'missing'), 'reorder', { group_id: 11, selected_ids: [2], before_note_id: null }), /available/i);
});
test('strict command variants cannot override operation identity or expected snapshots', () => {
  const draft = createNoteGroupDraft(board(), 'strict');
  for (const extra of [{ expected: {} }, { operation_id: 'other' }, { typo: 1 }, { source_group_id: 11, selected_ids: [2] }]) {
    assert.throws(() => freezeNoteGroupCommand(draft, 'create', { source_note_id: 8, target_note_id: 9, ...extra }), /field|source/i);
  }
  assert.throws(() => freezeNoteGroupCommand(draft, 'arrange', { items: [{ kind: 'note', id: 1, layout: rect }], include_locked: false }), /group/i);
});
test('500-note limit covers complete affected membership with no truncation', () => {
  const source = { notes: Array.from({ length: 501 }, (_, i) => note(i + 1)), groups: [group(1, Array.from({ length: 501 }, (_, i) => i + 1))] };
  assert.throws(() => freezeNoteGroupCommand(createNoteGroupDraft(source, 'too-large'), 'reorder', { group_id: 1, selected_ids: [1], before_note_id: null }), /500.*fewer|fewer.*500/i);
});
test('undo uses an empty expected snapshot; the receipt owns the exact revision scope', () => {
  assert.deepEqual(freezeNoteGroupCommand(createNoteGroupDraft(board(), 'undo-1'), 'undo', { undo_operation_id: 'original' }), { operation_id: 'undo-1', kind: 'undo', expected: { groups: [], notes: [] }, undo_operation_id: 'original' });
});
