import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import('../public/utils/task-acceptance-draft.js').catch(() => ({}));
const projection = (children = true) => ({expected_revision:4,primary_user_id:1,can_add_helpers:true,coassignee_candidates:[{id:2},{id:3}],subtask_snapshot:children?[{id:10,revision:2},{id:11,revision:1}]:[],subtasks:children?[{id:10,allocatable:true,eligible_assignee_ids:[1,2,3]},{id:11,allocatable:false,eligible_assignee_ids:[]}]:[]});
test('allocation screen requires both helpers and subtasks',()=>{
  assert.equal(typeof m.createAcceptanceDraft,'function');
  for(const children of [false,true]) for(const helpers of [false,true]){
    const draft=m.createAcceptanceDraft(projection(children),'op');
    if(helpers)m.setAcceptanceHelpers(draft,[2]);
    assert.equal(m.needsAcceptanceAllocation(draft),children&&helpers);
  }
});
test('none assigned is valid and protected children are omitted',()=>{
  const draft=m.createAcceptanceDraft(projection(),'op');m.setAcceptanceHelpers(draft,[2]);
  assert.deepEqual(m.acceptancePayload(draft),{operation_id:'op',expected_revision:4,primary_user_id:1,coassignee_ids:[2],subtask_snapshot:[{id:10,revision:2},{id:11,revision:1}],subtask_assignments:[{id:10,user_id:null}]});
});
test('removing helpers unassigns their steps; only eligible current participants allowed',()=>{
  const draft=m.createAcceptanceDraft(projection(),'op');m.setAcceptanceHelpers(draft,[2,3,99,1,2]);
  assert.deepEqual(draft.helpers,[2,3]);
  assert.equal(m.assignAcceptanceSubtask(draft,10,2),true);
  assert.equal(m.assignAcceptanceSubtask(draft,11,2),false);
  assert.equal(m.assignAcceptanceSubtask(draft,10,99),false);
  m.setAcceptanceHelpers(draft,[3]);
  assert.equal(draft.assignments[10],null);
});
test('uncertain retry keeps an immutable payload and operation ID',()=>{
  const draft=m.createAcceptanceDraft(projection(),'op');m.setAcceptanceHelpers(draft,[2]);
  const first=m.lockAcceptancePayload(draft);
  m.setAcceptanceHelpers(draft,[3]);m.assignAcceptanceSubtask(draft,10,1);
  assert.deepEqual(m.lockAcceptancePayload(draft),first);
  assert.equal(first.operation_id,'op');
  assert.deepEqual(first.coassignee_ids,[2]);
});
