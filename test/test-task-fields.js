import test from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeParticipant,
  taskParticipants,
  subtaskParticipants,
  completionCounts,
  taskLocationLabel,
} = await import('../public/utils/task-fields.js');

test('Task participant normalization preserves profile and responsibility data', () => {
  assert.deepEqual(normalizeParticipant({
    id: '7', display_name: 'Avery', avatar_color: '#123456', avatar_data: 'data:image/png;base64,x',
    family_role: 'Parent', phone: '555-0100', email: 'avery@example.test',
  }, 'supervisor'), {
    id: 7,
    display_name: 'Avery',
    color: '#123456',
    avatar_data: 'data:image/png;base64,x',
    family_role: 'Parent',
    phone: '555-0100',
    email: 'avery@example.test',
    role: 'supervisor',
  });
});

test('Task participants are deduplicated across legacy assignment and responsibility rows', () => {
  const people = taskParticipants({
    assigned_users: [{ id: 1, display_name: 'Alex' }],
    activity_responsibilities: [
      { id: 1, display_name: 'Alex', role: 'primary' },
      { id: 2, display_name: 'Sam', role: 'supervisor' },
    ],
  });
  assert.deepEqual(people.map(({ id, role }) => ({ id, role })), [
    { id: 1, role: 'assignee' },
    { id: 2, role: 'supervisor' },
  ]);
});

test('first-class subtask assignees resolve without Tasks-page state', () => {
  const people = subtaskParticipants(
    { assigned_to: 3, assigned_name: null },
    [{ id: 3, display_name: 'Jordan', avatar_color: '#abcdef' }],
  );
  assert.equal(people.length, 1);
  assert.equal(people[0].display_name, 'Jordan');
  assert.equal(people[0].role, 'assignee');
});

test('subtask completion keeps count and point progress together', () => {
  assert.deepEqual(completionCounts({ subtasks: [
    { status: 'done', points: 3 },
    { status: 'open', points: 5 },
  ] }), {
    done: 1,
    total: 2,
    earnedPoints: 3,
    totalPoints: 8,
  });
});

test('learner count and point progress excludes delegated work before and after helper completion', () => {
  const task = { status: 'in_progress', subtasks: [
    { status: 'done', points: 3 },
    { status: 'open', points: 5, supervision_action: { execution_mode: 'supervised' } },
    { status: 'open', points: 7, supervision_action: { execution_mode: 'delegated' } },
  ] };
  assert.deepEqual(completionCounts(task), { done: 1, total: 2, earnedPoints: 3, totalPoints: 8 });
  task.subtasks[2].status = 'done';
  assert.deepEqual(completionCounts(task), { done: 1, total: 2, earnedPoints: 3, totalPoints: 8 });
  assert.deepEqual(completionCounts({ is_supervision_projection: true, subtasks: [{ ...task.subtasks[2], is_supervision_projection: true, points: 0 }] }),
    { done: 1, total: 1, earnedPoints: 0, totalPoints: 0 });
});

test('all transferred actions do not invent a remaining learner step or claim parent points', () => {
  assert.deepEqual(completionCounts({ status: 'in_progress', points: 20, waiting_on_helper: true, subtasks: [
    { status: 'open', points: 7, supervision_action: { execution_mode: 'delegated' } },
  ] }), { done: 0, total: 0, earnedPoints: 0, totalPoints: 0 });
});

test('Task location labels prefer the normalized location contract', () => {
  assert.equal(taskLocationLabel({ location: { label: 'Library', address: '1 Main St' } }), 'Library');
  assert.equal(taskLocationLabel({ location: { address: '1 Main St' } }), '1 Main St');
  assert.equal(taskLocationLabel({ activity_place_name: 'Home' }), 'Home');
});
