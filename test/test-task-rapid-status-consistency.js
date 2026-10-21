import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

test('overlapping subtask completions and delayed stale edits preserve one award and current state',async t=>{
 const f=await scoringFixture(t);
 const made=await f.create({scoring_mode:'subtasks',assigned_to:[2],subtasks:[{title:'One scored step',points:7}]});
 assert.equal(made.status,201,JSON.stringify(made));
 const child=made.data.subtasks[0].id, snapshot=f.revisions(child);
 const finish=()=>f.call('PATCH',`/tasks/${child}/status`,{status:'done',...snapshot});
 const [a,b]=await Promise.all([finish(),finish()]);
 assert.deepEqual([a.status,b.status].sort(),[200,409]);
 assert.equal(f.row(child).status,'done');
 const earned=()=>f.d.prepare("SELECT * FROM reward_ledger WHERE type='earn' AND task_id=?").all(child);
 assert.equal(earned().length,1);
 assert.equal(earned()[0].delta,7);
 const before=f.changes();
 assert.equal((await finish()).status,409,'a delayed retry with the stale snapshot cannot replay a completed update');
 assert.equal(f.changes(),before);
 const newer=f.revisions(child);
 const [reopen,edit]=await Promise.all([
   f.call('PATCH',`/tasks/${child}/status`,{status:'open',...newer}),
   f.call('PUT',`/tasks/${child}`,{title:'Edited once',...newer}),
 ]);
 assert.deepEqual([reopen.status,edit.status].sort(),[200,409]);
 assert.equal(earned().length,1,'no duplicate earning is created by either ordering');
 const current=f.row(child);
 const balance=f.d.prepare('SELECT COALESCE(SUM(delta),0) n FROM reward_ledger WHERE task_id=?').get(child).n;
 assert.equal(balance,current.status==='done'?7:0);
 assert.equal(current.title,edit.status===200?'Edited once':'One scored step');
});
