import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualTaskDraft, taskDraftToActivity } from '../public/utils/task-draft.js';

test('explicit template modes and all point amounts survive template to Task to template', () => {
  for (const mode of ['whole_task', 'subtasks']) {
    const template = { id: 11, name: 'Routine', title_template: 'Daily routine', points: 0, scoring_mode: mode,
      checklist: [{ id: 21, title_template: 'Brush', points: 0 }, { id: 22, title_template: 'Wash', points: 9, is_optional: 1 }] };
    const draft = createManualTaskDraft({ template, defaultPoints: 50 });
    assert.equal(draft.scoring_mode, mode);
    assert.equal(draft.points, 0);
    assert.deepEqual(draft.subtasks.map(row => [row.title, row.points, row.activity_template_checklist_item_id]), [['Brush', 0, 21], ['Wash', 9, 22]]);
    const saved = taskDraftToActivity(draft, template);
    assert.equal(saved.scoring_mode, mode);
    assert.deepEqual(saved.checklist.map(row => [row.title_template, row.points, row.is_optional]), [['Brush', 0, 0], ['Wash', 9, 1]]);
    assert.deepEqual(createManualTaskDraft({ template: saved }).subtasks.map(row => row.points), [0, 9]);
  }
});

test('saving a Task uses its selected mode instead of the source template mode', () => {
  const result = taskDraftToActivity({ title: 'Changed', points: 12, scoring_mode: 'subtasks', subtasks: [{ title: 'First', points: 0 }, { title: 'Second', points: 10000 }] }, { scoring_mode: 'whole_task' });
  assert.equal(result.scoring_mode, 'subtasks');
  assert.equal(result.points, 12);
  assert.deepEqual(result.checklist.map(row => row.points), [0, 10000]);
});

test('a new template made from an ordinary Task defaults to Whole task', () => {
  assert.equal(taskDraftToActivity({ title: 'Task', subtasks: [] }).scoring_mode, 'whole_task');
});

test('historical Task scoring states cannot become unsupported template modes', () => {
  for (const mode of ['legacy', 'unknown']) {
    assert.equal(taskDraftToActivity({ title: 'Older Task', scoring: { mode }, subtasks: [] }).scoring_mode, 'whole_task');
  }
});
