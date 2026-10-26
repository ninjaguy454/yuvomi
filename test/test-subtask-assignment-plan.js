import test from 'node:test';
import assert from 'node:assert/strict';
import {planSubtaskAssignments} from '../server/services/subtask-assignment-plan.js';

const plan=rows=>planSubtaskAssignments({snapshotVersion:'synthetic-v1',occurrenceKey:'series:7:generation:3',rows});
const group=(key,mode,members,eligible=members,points=0,extra={})=>({
  key,points,eligible_user_ids:eligible,source:{kind:'group',group_id:31,mode,member_order:members,
    direction:'first_to_last',start_mode:'first',...extra},
});
const person=(key,people,eligible=people,points=0)=>({
  key,points,eligible_user_ids:eligible,source:{kind:'fixed',user_ids:people},
});
const assignee=(result,key)=>result.decisions.find(row=>row.key===key)?.assignee_ids;

test('fixed multi-person work counts fully and Smart uses points then count',()=>{
  const result=plan([person('fixed',[1,2],[1,2],8),
    group('zero','smart',[1,2,3],[1,2,3],0),group('small','smart',[1,2,3],[1,2,3],3)]);
  assert.deepEqual(result.conflicts,[]);
  assert.deepEqual(assignee(result,'fixed'),[1,2]);
  assert.deepEqual(assignee(result,'small'),[3]);
  assert.notEqual(assignee(result,'zero')[0],assignee(result,'small')[0]);
});

test('all-zero Smart work balances counts and finds distinct overlapping matches',()=>{
  const result=plan([
    group('only-one','smart',[1,2],[1],0,{group_id:31}),
    group('overlap','smart',[1,2],[1,2],0,{group_id:32}),
    group('third','smart',[1,2,3],[2,3],0,{group_id:33}),
    group('reuse','smart',[1,2,3],[1,2,3],0,{group_id:34}),
  ]);
  assert.deepEqual(result.conflicts,[]);
  assert.equal(assignee(result,'only-one')[0],1);
  assert.equal(new Set(['only-one','overlap','third'].map(key=>assignee(result,key)[0])).size,3);
  assert.equal(assignee(result,'reuse')[0],1);
  assert.deepEqual(result.decisions.map(row=>row.source.group_id),[31,32,33,34]);
});

test('Smart processes actual skill-restricted eligible pools before broad raw Groups',()=>{
  const result=plan([
    group('broad-first-name','smart',[1,2],[1,2],2,{group_id:31}),
    group('restricted','smart',[1,2,3,4],[1],5,{group_id:32}),
  ]);
  assert.deepEqual(assignee(result,'restricted'),[1]);
  assert.deepEqual(assignee(result,'broad-first-name'),[2]);
});

test('Random is stable by occurrence and action; persisted or locked work is not rerolled',()=>{
  const rows=[group('step','random',[1,2,3],[1,2,3],2)];
  const first=plan(rows),again=plan(rows);
  assert.deepEqual(first,again);
  assert.match(first.decisions[0].decision_key,/series:7:generation:3:step:group:31/);
  const saved=plan([{...rows[0],persisted_user_ids:[first.decisions[0].assignee_ids[0]]}]);
  assert.deepEqual(assignee(saved,'step'),assignee(first,'step'));
  const locked=plan([{...rows[0],locked:true,persisted_user_ids:[2],eligible_user_ids:[1]}]);
  assert.deepEqual(assignee(locked,'step'),[2]);
});

test('Global keeps the universal scheduled member or reports a conflict',()=>{
  const valid=plan([group('global','global',[1,2],[1,2],0,{shared:true,scheduled_user_id:2})]);
  assert.deepEqual(assignee(valid,'global'),[2]);assert.deepEqual(valid.cursor_advances,[]);
  const excluded=plan([group('global','global',[1,2],[1],0,{shared:true,scheduled_user_id:2})]);
  assert.deepEqual(excluded.conflicts,[{key:'global',reason:'no_eligible_group_member'}]);
  const notShared=plan([group('global','global',[1,2],[1,2],0,{scheduled_user_id:2})]);
  assert.deepEqual(notShared.conflicts,[{key:'global',reason:'global_requires_shared_group'}]);
});

test('Synced uses the common eligible member and advances its Activity cursor once',()=>{
  const rows=[group('restricted','synced',[1,2,3],[2],0,{cursor_user_id:1}),
    group('broad','synced',[1,2,3],[2,3],0,{cursor_user_id:1})];
  const result=plan(rows);
  assert.deepEqual(assignee(result,'restricted'),[2]);assert.deepEqual(assignee(result,'broad'),[2]);
  assert.deepEqual(result.cursor_advances,[{group_id:31,user_id:2,decision_key:'series:7:generation:3:synced:31'}]);
  const blocked=plan([{...rows[0],eligible_user_ids:[1]},rows[1]]);
  assert.deepEqual(blocked.conflicts.map(row=>row.reason),['synced_no_common_eligible_member','synced_no_common_eligible_member']);
  const held=plan([{...rows[0],locked:true,persisted_user_ids:[2]},rows[1]]);
  assert.deepEqual(assignee(held,'broad'),[2]);assert.deepEqual(held.cursor_advances,[]);
});

test('ineligible fixed targets remain explicit conflicts and cannot be silently replaced',()=>{
  const result=plan([person('skill-restricted',[2],[1],5)]);
  assert.deepEqual(result.conflicts,[{key:'skill-restricted',reason:'fixed_person_ineligible'}]);
  assert.deepEqual(assignee(result,'skill-restricted'),[]);
});
