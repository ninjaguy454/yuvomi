import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRevision} from '../public/utils/task-state.js';

test('private supervisor status forwards the parent concurrency token without a parent navigation ID',()=>{
  assert.deepEqual(taskRevision({id:2,revision:17,parent_task_id:null,parent_revision:59}),
    {expected_revision:17,expected_parent_revision:59});
});
