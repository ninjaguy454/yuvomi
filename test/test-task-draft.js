import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualTaskDraft, taskDraftSnapshot, taskDraftToActivity } from '../public/utils/task-draft.js';

const places = [{ id: 1, type: 'home', active: 1 }, { id: 2, type: 'other', active: 1 }];
test('manual blank defaults use active Home, household points and independent empty collections', () => {
  const first = createManualTaskDraft({ places, defaultPoints: 5 });
  assert.deepEqual(first.location, { kind: 'saved_place', place_id: 1 });
  assert.equal(first.points, 5); assert.equal(first.category, 'misc');
  first.tags.push('changed'); first.subtasks.push({ title: 'changed' });
  assert.deepEqual(createManualTaskDraft({ places }).tags, []);
  assert.deepEqual(createManualTaskDraft({ places: [{ ...places[0], active: 0 }] }).location, { kind: 'none' });
});
test('template explicit locations override Home; workflow locations are never silently bound to Home', () => {
  assert.deepEqual(createManualTaskDraft({ places, template: { location_mode: 'fixed', place_id: 2 } }).location, { kind: 'saved_place', place_id: 2 });
  assert.deepEqual(createManualTaskDraft({ places, template: { location_mode: 'workflow' } }).location, { kind: 'none' });
});
test('template values and skills are copied without sharing mutable arrays or occurrence state', () => {
  const template = { name: 'Prep', title_template: 'Prepare dinner', description: 'Carefully', priority: 'high', points: 8, tags: ['home'], skill_ids: [1], checklist: [{ title_template: 'Chop', skill_ids: [2] }] };
  const draft = createManualTaskDraft({ template, places });
  assert.equal(draft.title, 'Prepare dinner'); assert.equal(draft.points, 8);
  assert.deepEqual(draft.subtasks, [{ title: 'Chop', skill_ids: [2] }]);
  draft.subtasks[0].skill_ids.push(3); assert.deepEqual(template.checklist[0].skill_ids, [2]);
  const blank = createManualTaskDraft({ places });
  for (const field of ['title', 'description']) assert.equal(blank[field], '');
  for (const field of ['tags', 'skill_ids', 'subtasks']) assert.deepEqual(blank[field], []);
  assert.equal(blank.start_date, null); assert.equal(blank.due_date, null);
});
test('dirty comparison means difference from baseline, including custom fields and pending documents', () => {
  const fields = [{ id: 'task-activity-template', value: '1' }, { id: 'task-title', value: 'Filled template' }, { id: 'task-due-date', value: '' }, { id: 'task-locked', type: 'checkbox', value: 'on', checked: false }];
  const form = { querySelectorAll: () => fields };
  const baseline = taskDraftSnapshot(form);
  fields[0].value = '2'; assert.equal(taskDraftSnapshot(form), baseline);
  fields[1].value += ' edited'; assert.notEqual(taskDraftSnapshot(form), baseline);
  fields[1].value = 'Filled template'; assert.equal(taskDraftSnapshot(form), baseline);
  assert.notEqual(taskDraftSnapshot(form, { tags: ['one'] }), baseline);
  assert.notEqual(taskDraftSnapshot(form, { documents: [9] }), baseline);
  assert.notEqual(taskDraftSnapshot(form, { pendingFiles: true }), baseline);
  fields[2].value = '2026-09-08'; assert.notEqual(taskDraftSnapshot(form), baseline);
});
test('Save as Template copies reusable fields and excludes occurrence-only settings', () => {
  const draft = { title: 'Prep', description: 'Dinner', priority: 'high', category: 'misc', points: 8, tags: ['home'], skill_ids: [1], subtasks: [{ title: 'Chop', skill_ids: [2] }], location: { kind: 'saved_place', place_id: 2 }, assigned_users: [7], due_date: '2026-09-08', recurrence_rule: 'FREQ=DAILY', countdown: 1, documents: [3], reminder: { remind_at: 'now' } };
  const result = taskDraftToActivity(draft);
  assert.deepEqual(result.checklist, [{ title_template: 'Chop', skill_ids: [2] }]);
  assert.deepEqual(result.skill_ids, [1]); assert.equal(result.location_mode, 'fixed');
  assert.equal(result.place_id, 2); assert.equal(result.assignment_strategy, 'fixed');
  assert.equal(result.fixed_user_id, 7); assert.equal(result.subject_required, 0);
  for (const key of ['due_date', 'recurrence_rule', 'countdown', 'documents', 'reminder']) assert.equal(Object.hasOwn(result, key), false);
});
test('template conversion retains existing strategy; multiple manual assignees do not become a rotation', () => {
  const draft = { title: 'Prep', assigned_users: [1, 2], location: { kind: 'manual', user_label: 'Temporary' } };
  assert.equal(taskDraftToActivity(draft).assignment_strategy, 'open_claimable');
  assert.equal(taskDraftToActivity(draft).location_mode, 'none');
  const result = taskDraftToActivity(draft, { id: 4, assignment_strategy: 'eligible_round_robin', rotation_group: 'Kitchen', subject_required: 1 });
  assert.equal(result.id, undefined); assert.equal(result.assignment_strategy, 'eligible_round_robin');
  assert.equal(result.rotation_group, 'Kitchen'); assert.equal(result.subject_required, 1);
});
