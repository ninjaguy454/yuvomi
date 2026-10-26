import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerFromSavedTask, orderedOwnerAssignees } from '../public/utils/task-owner-selection.js';

test('saved primary identifies Owner even when its direct roster has a different order',()=>{
  assert.equal(ownerFromSavedTask({assigned_to:2,direct_assignee_ids:[1,2]}),2);
  assert.deepEqual(orderedOwnerAssignees(2,[1,2]),[2,1]);
});

test('legacy multi-person record without a primary remains unresolved',()=>{
  assert.equal(ownerFromSavedTask({assigned_to:null,direct_assignee_ids:[1,2]}),null);
  assert.equal(orderedOwnerAssignees(null,[1,2]),null);
});

test('a sole fixed person is an unambiguous Owner',()=>{
  assert.equal(ownerFromSavedTask({assigned_to:null,direct_assignee_ids:[3]}),3);
  assert.deepEqual(orderedOwnerAssignees(null,[3]),[3]);
});
