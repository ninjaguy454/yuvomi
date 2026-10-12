import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTaskDefinitionChanges, taskEditResultMessage, taskFuturePatch, taskScoringErrorMessage, hasTaskScoringChanges } from '../public/utils/task-edit-scope.js';

const task = { title: 'Homework', start_date: '2026-09-21', due_date: '2026-09-25', start_time: '15:30', due_time: '07:30',
  is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', points: 5, tags: ['School'], assigned_to: [2],
  subtasks: [{ id: 10, title: 'Read', skill_ids: [3], is_optional: 0 }] };

test('scope comparison excludes status and shifted occurrence dates with an unchanged span', () => {
  assert.equal(hasTaskDefinitionChanges(task, { ...task, start_date: '2026-09-28', due_date: '2026-10-02', status: 'done', documents: [1] }), false);
  assert.equal(hasTaskDefinitionChanges(task, { ...task, due_date: '2026-09-26' }), true);
});
test('scope comparison normalizes insignificant whitespace, ordering of sets and boolean representations', () => {
  assert.equal(hasTaskDefinitionChanges(task, { ...task, title: ' Homework ', points: '5', tags: ['School', 'School'], assigned_to: ['2'], is_recurring: true }), false);
});
test('definition changes include checklist structure, optionality, skills and recurrence policy', () => {
  for (const edit of [{ subtasks: [{ ...task.subtasks[0], title: 'Write' }] }, { subtasks: [{ ...task.subtasks[0], is_optional: 1 }] },
    { subtasks: [{ ...task.subtasks[0], skill_ids: [4] }] }, { start_time: '16:00' }, { points: 6 }, { is_recurring: 0 }, { expiration_policy: 'expire_incomplete' }]) {
    assert.equal(hasTaskDefinitionChanges(task, { ...task, ...edit }), true, JSON.stringify(edit));
  }
});

test('existing Rotation bindings keep no-change behavior; changing direction is a reusable definition edit', () => {
  const binding={purpose_key:'shower_order',group_id:7,strategy:'rotating_order'};
  const before={...task,rotation_bindings:[binding]};
  assert.equal(hasTaskDefinitionChanges(before,{...before,rotation_bindings:[{...binding,direction:'first_to_last'}]}),false);
  assert.equal(hasTaskDefinitionChanges(before,{...before,rotation_bindings:[{...binding,direction:'last_to_first'}]}),true);
  assert.equal(hasTaskDefinitionChanges({...before,rotation_bindings:[{direction:'last_to_first',...binding}]},
    {...before,rotation_bindings:[{...binding,direction:'last_to_first'}]}),false);
});
test('preserved future occurrences get an explicit human-readable save result', () => {
  assert.equal(taskEditResultMessage({ series_edit: { preserved: [80] } }, 'Saved'), 'Changes applied. 1 future occurrence was preserved because it could not be safely updated.');
  assert.match(taskEditResultMessage({ series_edit: { preserved: [{ reason: 'manual_edit' }, { reason: 'schedule_conflict' }, { reason: 'eligibility_or_permission' }] } }, 'Saved'), /3 future occurrences were preserved.*occurrence-specific changes; a scheduling conflict; eligibility or permission restrictions/);
  assert.equal(taskEditResultMessage({}, 'Saved'), 'Saved');
  assert.equal(taskEditResultMessage({ series_edit: { current_preserved: true, preserved: [] } }, 'Saved'), 'Changes applied. This historical occurrence was preserved.');
  assert.match(taskEditResultMessage({series_edit:{preserved:[{reason:'rotation_snapshot'}],pending_rotations:[{task_id:2}]}},'Saved'),/already resolved rotation snapshot.*1 future occurrence is waiting for rotation resolution/);
});

test('future patch preserves canonical membership without explicit intent and uses stable keys for changes',()=>{
  const fields={title:'Future',points:8,scoring_mode:'subtasks'},actions=[{action_key:'a',fields:{title:'First',points:2,is_optional:false}},{action_key:'hidden-from-current',fields:{title:'Second',points:6,is_optional:true}}];
  const definition={fields,actions},rows=actions.map(row=>({action_key:row.action_key,...row.fields}));
  assert.deepEqual(taskFuturePatch(definition,{...fields,title:'Programmatic rebase',subtasks:rows}),{});
  assert.deepEqual(taskFuturePatch(definition,{...fields,points:'0',subtasks:[{...rows[1],points:7},{client_key:'draft-Z',title:'Added',points:'0',is_optional:false}]},['points']),{fields:{points:0},actions:{update:[{action_key:'hidden-from-current',fields:{points:7}}],add:[{client_key:'draft-Z',fields:{title:'Added',points:0,is_optional:false}}],remove:['a'],order:['hidden-from-current','new:draft-Z']}});
  assert.deepEqual(taskFuturePatch(definition,{...fields,scoring_mode:'whole_task',subtasks:rows},['scoring_mode']),{fields:{scoring_mode:'whole_task'}});
});

test('future serializer omits invalid inactive amounts and never treats null as zero',()=>{
  const definition={fields:{points:8,scoring_mode:'whole_task'},actions:[{action_key:'a',fields:{title:'Work',points:2}}]};
  for(const value of [null,'',1.5,10001,-1,'bad'])assert.deepEqual(taskFuturePatch(definition,{points:value,subtasks:[{action_key:'a',title:'Work',points:value}]},['points']),{},String(value));
  assert.deepEqual(taskFuturePatch(definition,{scoring_mode:'legacy',subtasks:[{action_key:'a',title:'Work',points:2}]},['scoring_mode']),{});
});

test('all authoritative unavailable forecast codes produce specific guidance without raw private codes',()=>{
  for(const [code,key] of Object.entries({next_occurrence_unavailable:'scoringNoNext',recurrence_ended:'scoringEnded',target_preserved:'scoringTargetPreserved',random_assignment_unresolved:'scoringRandom',binding_policy_changed:'scoringBindingChanged',projection_evidence_unavailable:'scoringEvidence'})){
    const message=taskScoringErrorMessage({data:{reason:'scoring_projection_unavailable',conditions:[code,code,'private_unknown']}});assert.equal(message,`tasks.scoringForecastUnavailable tasks.${key}`);
  }
});

test('recipient-rule intent requires a scoring preview while ordinary titles do not',()=>{
  const before={points:5,assigned_to:[2],skill_ids:[3],rotation_bindings:[],subtasks:[{id:10,points:2,skill_ids:[3]}]};
  assert.equal(hasTaskScoringChanges(before,{...before,title:'New title'}),false);
  for(const edit of [{skill_ids:[4]},{rotation_bindings:[{purpose_key:'order',group_id:7,direction:'last_to_first'}]},{subtasks:[{...before.subtasks[0],skill_ids:[4]}]}])assert.equal(hasTaskScoringChanges(before,{...before,...edit}),true,JSON.stringify(edit));
});
