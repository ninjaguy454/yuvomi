import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCandidatePool } from '../public/utils/group-candidate-pool.js';

test('candidate pool retains Group identities and deduplicates overlapping active people', () => {
  const groups = [
    { id: 7, members: [{ id: 3, active: 1 }, { id: 2, active: 1 }, { id: 1, active: 0 }] },
    { id: 8, members: [{ id: 3, active: 1 }, { id: 5, active: 1 }, { id: 4, active: null }] },
  ];
  assert.deepEqual(groupCandidatePool(groups, [7, 8, 7]), {
    groupIds: [7, 8], userIds: [3, 2, 5, 4],
  });
});

test('candidate pool preserves a selected saved Group missing from the current catalogue', () => {
  assert.deepEqual(groupCandidatePool([{ id: 7, members: [{ id: 2 }] }], [999, 7, 0, 'oops']), {
    groupIds: [999, 7], userIds: [2],
  });
});
