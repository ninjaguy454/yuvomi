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

test('Task location labels prefer the normalized location contract', () => {
  assert.equal(taskLocationLabel({ location: { label: 'Library', address: '1 Main St' } }), 'Library');
  assert.equal(taskLocationLabel({ location: { address: '1 Main St' } }), '1 Main St');
  assert.equal(taskLocationLabel({ activity_place_name: 'Home' }), 'Home');
});
