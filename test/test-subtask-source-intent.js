import test from 'node:test';
import assert from 'node:assert/strict';
import {taskDraftToActivity,createManualTaskDraft} from '../public/utils/task-draft.js';
import {taskEditDefinition} from '../public/utils/task-edit-scope.js';
const oldRule={kind:'group',group_id:9,mode:'smart'};

test('explicit null source overrides stale API aliases in Save as Template and edit comparison',()=>{
  const row={title:'Chosen Person',subtask_assignment_rule:oldRule,assignment_rule:null,
    assignment_group_json:JSON.stringify({group_id:9}),assignment_group:null,assigned_user_ids:[2],
    subtask_supervisor_pool:{kind:'person',user_id:1},supervisor_pool:null};
  const item=taskDraftToActivity({title:'Saved template',subtasks:[row]}).checklist[0];
  assert.equal(item.assignment_rule,null);assert.equal(item.fixed_user_id,2);assert.equal(item.assignment_group,null);
  const compared=taskEditDefinition({title:'Edited',subtasks:[row]}).subtasks[0];
  assert.equal(compared.assignment_rule,null);assert.equal(compared.assignment_group,null);assert.equal(compared.supervisor_pool,null);
});

test('canonical fixed policy and cleared supervisor win over stale Group and supervisor aliases',()=>{
  const row={title:'Fixed source',assignment_rule:{kind:'fixed',user_ids:[2]},subtask_assignment_rule:oldRule,
    supervisor_pool:null,subtask_supervisor_pool:{kind:'person',user_id:1}};
  const item=taskDraftToActivity({title:'Saved fixed',subtasks:[row]}).checklist[0];
  assert.deepEqual(item.assignment_rule,{kind:'fixed',user_ids:[2]});assert.equal(item.supervisor_pool,null);
  assert.equal(taskEditDefinition({subtasks:[row]}).subtasks[0].supervisor_pool,null);
});

test('aliases still supply policy when the canonical field is absent',()=>{
  const row={title:'Saved source',subtask_assignment_rule:oldRule,subtask_supervisor_pool:{kind:'person',user_id:1}};
  assert.deepEqual(taskDraftToActivity({title:'Alias template',subtasks:[row]}).checklist[0].assignment_rule,oldRule);
  assert.deepEqual(taskEditDefinition({subtasks:[row]}).subtasks[0].assignment_rule,oldRule);
  const manual=createManualTaskDraft({template:{checklist:[{title_template:'Cleared',assignment_rule:null,assignment_rule_json:JSON.stringify(oldRule)}]}});
  assert.equal(manual.subtasks[0].assignment_rule,null);
});
