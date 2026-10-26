import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualTaskDraft, taskDraftSnapshot, taskDraftToActivity } from '../public/utils/task-draft.js';

test('fixed multi-person Template drafts and Save as Template retain the complete roster',()=>{
  const source={assignment_strategy:'fixed',fixed_user_id:7,fixed_assignee_ids:[7,9],checklist:[]};
  assert.deepEqual(createManualTaskDraft({template:source}).assigned_to,[7,9]);
  const saved=taskDraftToActivity({title:'Shared work',assigned_users:[7,9],subtasks:[]},source);
  assert.equal(saved.assignment_strategy,'fixed');
  assert.equal(saved.fixed_user_id,7);
  assert.deepEqual(saved.fixed_assignee_ids,[7,9]);
  assert.deepEqual(createManualTaskDraft({template:saved}).assigned_to,[7,9]);
});

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
  assert.deepEqual(draft.subtasks, [{ title: 'Chop', skill_ids: [2], is_optional: 0 }]);
  draft.subtasks[0].skill_ids.push(3); assert.deepEqual(template.checklist[0].skill_ids, [2]);
  const blank = createManualTaskDraft({ places });
  for (const field of ['title', 'description']) assert.equal(blank[field], '');
  for (const field of ['tags', 'skill_ids', 'subtasks']) assert.deepEqual(blank[field], []);
  assert.equal(blank.start_date, null); assert.equal(blank.due_date, null);
});
test('Template checklist Groups start each subtask from Group order',()=>{
  const saved={group_id:9,start_mode:'random',direction:'first_to_last',member_order:[2,1]};
  const draft=createManualTaskDraft({template:{checklist:[{title_template:'Action',assignment_group_json:JSON.stringify(saved)}]}});
  assert.deepEqual(draft.subtasks[0].assignment_group,{group_id:9,start_mode:'random',direction:'first_to_last'});
  assert.deepEqual(saved.member_order,[2,1]);
});
test('dirty comparison means difference from baseline, including custom fields and pending documents', () => {
  const fields = [{ id: 'task-activity-template', value: '1' }, { id: 'task-title', value: 'Filled template' }, { id: 'task-due-date', value: '' }, { id: 'task-locked', type: 'checkbox', value: 'on', checked: false }];
  const groupOrder={dataset:{groupOrderValue:'null'}};
  const form = { querySelectorAll: selector => selector.includes('data-task-group-order')?[groupOrder]:fields };
  const baseline = taskDraftSnapshot(form);
  fields[0].value = '2'; assert.equal(taskDraftSnapshot(form), baseline);
  fields[1].value += ' edited'; assert.notEqual(taskDraftSnapshot(form), baseline);
  fields[1].value = 'Filled template'; assert.equal(taskDraftSnapshot(form), baseline);
  assert.notEqual(taskDraftSnapshot(form, { tags: ['one'] }), baseline);
  assert.notEqual(taskDraftSnapshot(form, { documents: [9] }), baseline);
  assert.notEqual(taskDraftSnapshot(form, { pendingFiles: true }), baseline);
  fields[2].value = '2026-09-08'; assert.notEqual(taskDraftSnapshot(form), baseline);
  fields[2].value = '';groupOrder.dataset.groupOrderValue='[2,1]';assert.notEqual(taskDraftSnapshot(form),baseline);
});
test('Save as Template copies reusable fields and excludes occurrence-only settings', () => {
  const draft = { title: 'Prep', description: 'Dinner', priority: 'high', category: 'misc', points: 8, tags: ['home'], skill_ids: [1], subtasks: [{ title: 'Chop', skill_ids: [2] }], location: { kind: 'saved_place', place_id: 2 }, assigned_users: [7], due_date: '2026-09-08', recurrence_rule: 'FREQ=DAILY', countdown: 1, documents: [3], reminder: { remind_at: 'now' } };
  const result = taskDraftToActivity(draft);
  assert.deepEqual(result.checklist, [{ title_template: 'Chop', skill_ids: [2], is_optional: 0 }]);
  assert.deepEqual(result.skill_ids, [1]); assert.equal(result.location_mode, 'fixed');
  assert.equal(result.place_id, 2); assert.equal(result.assignment_strategy, 'fixed');
  assert.equal(result.fixed_user_id, 7); assert.equal(result.subject_required, 0);
  assert.equal(result.recurrence_rule, 'FREQ=DAILY');
  assert.equal(result.due_date_offset_days, null, 'one date is insufficient to derive an interval');
  for (const key of ['start_date', 'due_date', 'countdown', 'documents', 'reminder']) assert.equal(Object.hasOwn(result, key), false);
});
test('template conversion retains an existing strategy and saves multiple manual assignees as fixed', () => {
  const draft = { title: 'Prep', assigned_users: [1, 2], location: { kind: 'manual', user_label: 'Temporary' } };
  assert.equal(taskDraftToActivity(draft).assignment_strategy, 'fixed');
  assert.deepEqual(taskDraftToActivity(draft).fixed_assignee_ids,[1,2]);
  assert.equal(taskDraftToActivity(draft).location_mode, 'none');
  const result = taskDraftToActivity(draft, { id: 4, assignment_strategy: 'eligible_round_robin', rotation_group: 'Kitchen', subject_required: 1 });
  assert.equal(result.id, undefined); assert.equal(result.assignment_strategy, 'eligible_round_robin');
  assert.equal(result.rotation_group, 'Kitchen'); assert.equal(result.subject_required, 1);
});

test('Save as Template carries current root and subtask Group choices instead of a source Template choice',()=>{
  const root={group_id:32,start_mode:'random',direction:'last_to_first'};
  const subtask={group_id:31,start_mode:'first',direction:'first_to_last'};
  const saved=taskDraftToActivity({title:'Current Task',assignment_group:root,assigned_users:[],
    subtasks:[{title:'Current action',assignment_group:subtask}]},
    {assignment_strategy:'group_rotation',assignment_group_json:JSON.stringify({group_id:99,start_mode:'first',direction:'first_to_last'})});
  assert.equal(saved.assignment_strategy,'group_rotation');
  assert.deepEqual(saved.assignment_group_json,root);
  assert.equal(saved.fixed_user_id,null);
  assert.deepEqual(saved.checklist[0].assignment_group,subtask);
  const removed=taskDraftToActivity({title:'Unassigned now',assignment_group:null,assigned_users:[],subtasks:[]},
    {assignment_strategy:'group_rotation',assignment_group_json:JSON.stringify(root)});
  assert.equal(removed.assignment_strategy,'open_claimable');
  assert.equal(removed.assignment_group_json,null);
});

test('morning template round trip keeps reusable times, anchored weekdays, fixed assignee and fresh optional state', () => {
  const activity = taskDraftToActivity({ title: 'Get Ready for the Day', assigned_users: [7], points: 2,
    start_date: '2026-09-21', due_date: '2026-09-21',
    start_time: '07:00', due_time: '08:00', recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    recurrence_from_completion: 0, expiration_policy: 'expire_incomplete',
    subtasks: [{ id: 20, title: 'Get dressed', status: 'done' }, { id: 21, title: 'Put in earrings', is_optional: 1, status: 'done', skill_ids: [4] }] });
  const draft = createManualTaskDraft({ template: activity, occurrenceStartDate: '2026-09-21' });
  assert.equal(activity.due_date_offset_days, 0);
  assert.equal(Object.hasOwn(activity, 'start_date'), false); assert.equal(Object.hasOwn(activity, 'due_date'), false);
  assert.equal(draft.assigned_to, 7); assert.equal(draft.points, 2);
  assert.equal(draft.start_time, '07:00'); assert.equal(draft.due_time, '08:00');
  assert.equal(draft.start_date, '2026-09-21'); assert.equal(draft.due_date, '2026-09-21');
  assert.equal(draft.recurrence_rule, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(draft.recurrence_from_completion, 0); assert.equal(draft.expiration_policy, 'expire_incomplete');
  assert.deepEqual(draft.subtasks.map(row => [row.id, row.status, row.is_optional]), [[undefined, undefined, 0], [undefined, undefined, 1]]);
});

test('template relative dates resolve only from a supplied occurrence start, including DST and calendar selection', () => {
  const template = { due_date_offset_days: 4, start_time: '15:30', due_time: '07:30' };
  assert.equal(createManualTaskDraft({ template }).due_date, null);
  const selected = createManualTaskDraft({ template, presetDates: { start_date: '2026-09-21', due_date: '2026-09-22' } });
  assert.equal(selected.start_date, '2026-09-21'); assert.equal(selected.due_date, '2026-09-25');
  const following = createManualTaskDraft({ template, occurrenceStartDate: '2026-11-02' });
  assert.equal(following.due_date, '2026-11-06'); assert.equal(following.start_time, '15:30'); assert.equal(following.due_time, '07:30');
  const timeOnly = createManualTaskDraft({ template: { start_time: '07:00', due_time: '08:00' } });
  assert.equal(timeOnly.start_date, null); assert.equal(timeOnly.due_date, null);
  assert.equal(createManualTaskDraft().start_date, null, 'switch to Blank clears template schedule');
});

test('Save as Template derives calendar days safely and removes obsolete absolute dates from source templates', () => {
  const activity = taskDraftToActivity({ title: 'Homework', start_date: '2026-10-30', due_date: '2026-11-03', start_time: '15:30', due_time: '07:30' },
    { start_date: '2000-01-01', due_date: '2000-01-02', due_date_offset_days: 1 });
  assert.equal(activity.due_date_offset_days, 4);
  assert.equal(Object.hasOwn(activity, 'start_date'), false); assert.equal(Object.hasOwn(activity, 'due_date'), false);
  for (const draft of [{ due_date: '2026-09-25' }, { start_date: '2026-09-21' }, { start_date: 'bad', due_date: '2026-09-25' }, { start_date: '2026-09-25', due_date: '2026-09-21' }]) {
    assert.equal(taskDraftToActivity({ title: 'Incomplete', ...draft }).due_date_offset_days, null);
  }
});
