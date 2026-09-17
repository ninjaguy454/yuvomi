import test from 'node:test';
import assert from 'node:assert/strict';
import { moveSubtaskRow, bindSubtaskReorder } from '../public/utils/subtask-reorder.js';
import { renderSubtaskEditor } from '../public/components/task-requirements.js';

function listFixture() {
  const models = [
    { id: 11, title: 'Brush teeth', status: 'done', is_optional: 0, skill_ids: [8], notes: { retained: true } },
    { id: 12, title: 'Stretch', status: 'open', is_optional: 1, skill_ids: [9] },
    { id: 13, title: 'Pack bag', status: 'open', is_optional: 0, skill_ids: [] },
  ];
  const list = { children: [], isConnected: true, insertBefore(row, before) {
    this.children.splice(this.children.indexOf(row), 1);
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, row);
  } };
  list.children = models.map(model => ({ model,
    get nextElementSibling() { return list.children[list.children.indexOf(this) + 1] || null; },
    querySelector: () => ({ value: model.title }),
  }));
  return { list, models };
}

test('shared editor renders dotted handles and a compact Optional control with menu-based keyboard moves', () => {
  const html = renderSubtaskEditor({ template: true, subtasks: [{ id: 91, title_template: '<optional>', is_optional: 1, skill_ids: [4], extra: 'retained' }] });
  assert.match(html, /data-task-subtask-handle/);
  assert.match(html, /<details class="task-subtask-editor__actions">/);
  assert.match(html, /data-task-subtask-optional checked/);
  assert.match(html, /data-subtask-id="91"/);
  assert.match(html, /&quot;extra&quot;:&quot;retained&quot;/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<optional>|>↑<|>↓</);
});

test('row moves preserve stable objects, IDs, skills, Optional and completed progress', () => {
  const { list, models } = listFixture();
  const original = [...list.children];
  assert.equal(moveSubtaskRow(list, original[0], 2), true);
  assert.deepEqual(list.children.map(row => row.model.id), [12, 13, 11]);
  assert.equal(list.children[2], original[0]);
  assert.equal(list.children[2].model, models[0]);
  assert.deepEqual(list.children[2].model.notes, { retained: true });
  assert.equal(list.children[0].model.is_optional, 1);
  assert.equal(list.children[2].model.status, 'done');
  assert.equal(moveSubtaskRow(list, original[0], 0), true);
  assert.deepEqual(list.children, original);
  assert.equal(moveSubtaskRow(list, original[0], -1), false);
  assert.equal(moveSubtaskRow(list, original[0], 0), false);
});

test('drag uses a held handle and the same announcement/change path as keyboard moves', async () => {
  const { list } = listFixture();
  let options, changes = 0, readOnly = false;
  const announcements = [], disabled = [];
  const controller = bindSubtaskReorder(list, { isReadOnly: () => readOnly, onChange: () => changes++, announce: text => announcements.push(text),
    createSortable: async (_list, opts) => { options = opts; return { option: (...args) => disabled.push(args), destroy() {} }; },
  });
  await controller.ready;
  assert.equal(options.handle, '[data-task-subtask-handle]');
  assert.equal(options.draggable, '[data-task-subtask-row]');
  assert.equal(options.delay, 220);
  assert.equal(options.touchStartThreshold, 8);
  const row = list.children[0];
  moveSubtaskRow(list, row, 2); // Sortable has already moved the same DOM node.
  options.onEnd({ item: row, oldIndex: 0, newIndex: 2 });
  assert.equal(changes, 1);
  assert.equal(announcements[0], 'Brush teeth moved to position 3 of 3.');
  assert.equal(controller.move(row, 1), true);
  assert.equal(changes, 2);
  readOnly = true; controller.refresh();
  assert.deepEqual(disabled.at(-1), ['disabled', true]);
  assert.equal(controller.move(row, 0), false);
  moveSubtaskRow(list, row, 0);
  options.onEnd({ item: row, oldIndex: 1, newIndex: 0 });
  assert.equal(list.children[1], row, 'a permission change during drag rolls back its DOM move');
  assert.equal(changes, 2);
  controller.dispose();
});

test('closing an editor while Sortable loads destroys the late instance', async () => {
  const { list } = listFixture(); let finish, destroyed = 0;
  const controller = bindSubtaskReorder(list, { createSortable: () => new Promise(resolve => { finish = resolve; }) });
  controller.dispose();
  finish({ destroy: () => destroyed++, option() {} });
  await controller.ready;
  assert.equal(destroyed, 1);
});

test('keyboard reordering remains available when the optional drag library cannot load', async () => {
  const { list } = listFixture();
  const controller = bindSubtaskReorder(list, { createSortable: async () => { throw new Error('Offline'); } });
  assert.equal(await controller.ready, null);
  assert.equal(controller.move(list.children[0], 1), true);
  controller.dispose();
});
