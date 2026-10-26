import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement ??= class {};
globalThis.customElements ??= {define(){},get(){}};
const {__test}=await import('../public/pages/tasks.js');
const {setPermissions}=await import('../public/permissions.js');

test('the edit form offers occurrence-only work from a person, keeping Group provenance separate',()=>{
  setPermissions({admin:true,capabilities:{'tasks.change_assignment':'allow','tasks.reassign':'allow'}});
  const person={id:2,display_name:'Eleanor'};
  __test.state.users=[person,{id:3,display_name:'Frank'}];
  __test.state.rotationGroups=[{id:4,name:'Kids',active:true,members:[person]}];
  __test.state.placeSearchStatus={configured:false};
  const permissions={view:true,edit:true,change_assignment:true,reassign:true};
  const task={id:70,title:'Activity',category:'misc',status:'open',assigned_to:2,
    permissions,subtasks:[{id:71,title:'Step',status:'open',assigned_to:2,assigned_users:[person],
      permissions,subtask_assignment_rule:{kind:'group',group_id:4,mode:'smart'}}]};
  const html=__test.renderModalContent({task,users:__test.state.users});
  assert.match(html,/data-task-occurrence-reassign/);
  assert.match(html,/Reassign work from Eleanor/);
  assert.match(html,/Apply to this occurrence/);
  assert.doesNotMatch(html,/data-occurrence-apply[^>]*type="submit"/);
  assert.doesNotMatch(__test.renderModalContent({task:{...task,permissions:{...permissions,reassign:false}},users:__test.state.users}),
    /data-task-occurrence-reassign/);
  assert.doesNotMatch(__test.renderModalContent({task:{...task,status:'done'},users:__test.state.users}),
    /data-task-occurrence-reassign/);
});
