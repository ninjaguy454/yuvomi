import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-task-scoring';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {awardForCompletion,syncTaskRewards,rewardTargets,createPointAdjustment}=await import('../server/services/rewards.js');
const {retireRecurrenceOccurrences,releaseCorrectedRetiredAwards}=await import('../server/services/task-recurrence-frontier.js');
const scoring=await import('../server/services/task-scoring.js').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;
});
let d;
function migrate(db){for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)db.pragma('foreign_keys=OFF');db.transaction(()=>{typeof m.up==='function'?m.up(db):db.exec(m.up);m.afterUp?.(db);})();if(m.foreignKeysOff)db.pragma('foreign_keys=ON');}}
test.beforeEach(()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');migrate(d);
  // Before implementation these explicit definitions exercise the old award
  // writer, so the red failures demonstrate double credit and actor fallback.
  if(!d.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='scoring_mode'))d.exec("ALTER TABLE tasks ADD COLUMN scoring_mode TEXT NOT NULL DEFAULT 'legacy';ALTER TABLE tasks ADD COLUMN scoring_review_required INTEGER NOT NULL DEFAULT 0;");
  for(const id of [1,2,3,4]){d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'x',?)").run(id,'synthetic-'+id,'Synthetic '+id,id===1?'admin':'member');d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,?)').run(id,id===4?0:1);}
});
test.afterEach(()=>d.close());
function task(points=0,{parent=null,mode='legacy',assigned=[],status='open',id}={}){
  const result=d.prepare('INSERT INTO tasks(id,title,created_by,points,parent_task_id,scoring_mode,status,assigned_to) VALUES(?,\'Synthetic work\',1,?,?,?,?,?)').run(id??null,points,parent,mode,status,assigned[0]??null);
  const key=Number(result.lastInsertRowid);for(const uid of assigned)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(key,uid);return key;
}
const earns=()=>d.prepare("SELECT task_id,user_id,delta FROM reward_ledger WHERE type='earn' ORDER BY id").all();
function api(name,...args){assert.equal(typeof scoring[name],'function',name+' scoring contract is implemented');return scoring[name](...args);}
const summary=(id,viewerId=null)=>api('taskScoringSummary',d,id,{viewerId});
const preview=(id,proposed={},viewerId=null)=>api('previewTaskScoring',d,id,proposed,{viewerId});
const mutate=(id,proposed,scope='occurrence')=>api('assertTaskScoringMutation',d,id,proposed,{scope});
function complete(id,actor=1){d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);return awardForCompletion(d,id,actor);}
function assignment(id,ids){d.prepare('DELETE FROM task_assignments WHERE task_id=?').run(id);d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(ids[0]??null,id);for(const uid of ids)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,uid);}
const reason=value=>error=>error.status===409&&error.reason===value;
const unitPreview=(id,proposed={},options={})=>api('previewTaskScoring',d,id,proposed,{includeUnits:true,...options});
const unit=(ref,points,ids=[],outcome=points===0?'zero':ids.length?'earned':'no_recipients')=>({ref,points,recipients:ids.map(user_id=>({user_id,points})),outcome});
const taskRef=task_id=>({kind:'task',task_id});
const templateRef=template_id=>({kind:'template',template_id});
function unitTotals(units){const totals=new Map();for(const row of units)for(const {user_id,points} of row.recipients)if(points>0)totals.set(user_id,(totals.get(user_id)||0)+points);return [...totals].sort(([a],[b])=>a-b).map(([user_id,points])=>({user_id,points}));}

test('whole task pays the parent once and suppresses positive checklist points',()=>{
 const root=task(9,{mode:'whole_task',assigned:[2,3]}),child=task(7,{parent:root,assigned:[2]});
 assert.equal(complete(child),false);assert.equal(complete(root),true);assert.equal(awardForCompletion(d,root,1),false);
 assert.deepEqual(earns(),[{task_id:root,user_id:2,delta:9},{task_id:root,user_id:3,delta:9}]);
});
test('each subtask inherits all parent recipients and never awards the parent summary',()=>{
 const root=task(40,{mode:'subtasks',assigned:[2,3]}),first=task(4,{parent:root}),second=task(6,{parent:root,assigned:[3]});
 assert.equal(complete(first),true);assert.equal(complete(second),true);assert.equal(complete(root),false);
 assert.deepEqual(earns(),[{task_id:first,user_id:2,delta:4},{task_id:first,user_id:3,delta:4},{task_id:second,user_id:3,delta:6}]);
});
test('ineligible explicit child recipients never inherit or fall back to the actor',()=>{
 const root=task(9,{mode:'subtasks',assigned:[2]}),child=task(6,{parent:root,assigned:[4]});
 assert.deepEqual(rewardTargets(d,child,1),[]);assert.equal(complete(child),false);assert.deepEqual(earns(),[]);
 assert.equal(summary(root).settlements.find(s=>s.task_id===child).outcome,'no_recipients');
});
test('new whole task without configured recipients records no recipient settlement',()=>{
 const root=task(8,{mode:'whole_task'});assert.equal(complete(root),false);assert.deepEqual(earns(),[]);
 assignment(root,[2]);assert.equal(awardForCompletion(d,root,2),false);assert.equal(summary(root).settlements[0].outcome,'no_recipients');
});
test('zero first completion remains settled after point edits and reset',()=>{
 const root=task(0,{mode:'whole_task',assigned:[2]});assert.equal(complete(root),false);
 d.prepare("UPDATE tasks SET points=8,status='open' WHERE id=?").run(root);assert.equal(complete(root),false);
 const result=summary(root,2);assert.equal(result.settlements[0].points,0);assert.equal(result.settlements[0].outcome,'zero');assert.equal(result.personal_total,0);
});
test('earned amounts and recipients survive enrollment, operational assignment, reopen and point drift',()=>{
 const root=task(5,{mode:'whole_task',assigned:[2,4]});complete(root);const first=summary(root);
 d.prepare('UPDATE reward_participants SET enabled=1 WHERE user_id=4').run();assignment(root,[3,4]);d.prepare("UPDATE tasks SET points=30,status='open' WHERE id=?").run(root);complete(root,3);
 assert.deepEqual(summary(root).earned,[{user_id:2,points:5}]);assert.deepEqual(summary(root).settlements,first.settlements);assert.equal(summary(root,2).personal_total,5);
});
test('mode lock is historical earned evidence after adjustments and removal of earned child',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(5,{parent:root});complete(child);
 d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(2,-5,'adjust',?)").run(child);d.prepare('DELETE FROM tasks WHERE id=?').run(child);
 assert.equal(summary(root).mode_locked,true);assert.deepEqual(summary(root).earned,[{user_id:2,points:5}]);assert.throws(()=>mutate(root,{scoring_mode:'whole_task'}),reason('scoring_mode_locked'));
});
test('mode may change before earnings but completed checklist actions cannot be backpaid',()=>{
 const root=task(7,{mode:'whole_task',assigned:[2]}),child=task(4,{parent:root});complete(child);
 assert.doesNotThrow(()=>mutate(root,{scoring_mode:'subtasks'}));d.prepare("UPDATE tasks SET scoring_mode='subtasks' WHERE id=?").run(root);
 assert.equal(awardForCompletion(d,child,2),false);assert.deepEqual(summary(root).potential,[]);
});
test('partial preview preserves earnings and compares only remaining potential by member',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),first=task(3,{parent:root}),second=task(4,{parent:root});complete(first);
 const result=preview(root,{subtasks:[{id:first,title:'Done'},{id:second,points:8,assigned_user_ids:[3]}]},2);
 assert.deepEqual(result.earned,[{user_id:2,points:3}]);assert.deepEqual(result.before,[{user_id:2,points:4}]);assert.deepEqual(result.after,[{user_id:3,points:8}]);assert.equal(result.valid,true);assert.equal(summary(root,2).personal_total,7);assert.equal(summary(root).personal_total,null);
});
test('settled points cannot change while operational responsibility can',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(3,{parent:root});complete(child);
 assert.throws(()=>mutate(root,{subtasks:[{id:child,points:7}]}),reason('settled_rewards'));
 assert.doesNotThrow(()=>mutate(root,{subtasks:[{id:child,assigned_user_ids:[3]}]}));assert.equal(preview(root,{subtasks:[{id:child,points:7}]}).valid,false);
});
test('future only validates a new definition without applying current mode lock or settlements',()=>{
 const root=task(8,{mode:'whole_task',assigned:[2]}),child=task(3,{parent:root});complete(root);
 assert.doesNotThrow(()=>mutate(root,{scoring_mode:'subtasks',points:0,subtasks:[{id:child,points:4}]},'future_only'));
 assert.throws(()=>mutate(root,{scoring_mode:'subtasks'},'future'),reason('scoring_mode_locked'));assert.equal(summary(root).mode,'whole_task');
});
test('future only preview preserves current history and compares fresh prospective occurrence potential',()=>{
 const root=task(8,{mode:'whole_task',assigned:[2]}),child=task(3,{parent:root});complete(child);complete(root);
 const result=api('previewTaskScoring',d,root,{scoring_mode:'subtasks',points:0,subtasks:[{id:child,points:4}]},{viewerId:2,scope:'future_only'});
 assert.equal(result.valid,true);assert.equal(result.scope,'future_only');assert.equal(result.current_preserved,true);assert.deepEqual(result.earned,[{user_id:2,points:8}]);assert.deepEqual(result.before,[{user_id:2,points:8}]);assert.deepEqual(result.after,[{user_id:2,points:4}]);
});
test('wire mode and point ranges reject invalid definitions',()=>{
 const root=task(8,{mode:'whole_task',assigned:[2]});for(const mode of ['legacy','mixed','',null])assert.throws(()=>mutate(root,{scoring_mode:mode}),e=>e.status===400&&e.reason==='invalid_scoring_mode');
 for(const points of [-1,1.5,10001,true,{},'no'])assert.throws(()=>mutate(root,{points}),e=>e.status===400);
 assert.doesNotThrow(()=>mutate(root,{points:'10000'}));
});
test('preview retains omitted values, accepts child assignment alias and adds only new potential',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(3,{parent:root});
 assert.deepEqual(preview(root,{subtasks:[{id:child,assigned_to:[3]},{title:'New',points:4}]}).after,[{user_id:2,points:4},{user_id:3,points:3}]);
});
test('summary and previews perform no provenance, revision, claim or settlement writes',()=>{
 const root=task(8,{mode:'whole_task',assigned:[2]}),child=task(3,{parent:root});d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(root);
 const before=d.prepare('SELECT total_changes() n').get().n;summary(root,2);preview(root,{scoring_mode:'subtasks',subtasks:[{id:child,points:6}]},2);mutate(root,{points:6});assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
});
test('migration flagged unearned legacy scope requires review before positive rewards',()=>{
 const root=task(8,{assigned:[2]}),child=task(3,{parent:root,assigned:[2]});d.prepare('UPDATE tasks SET scoring_review_required=1 WHERE id=?').run(root);
 assert.equal(summary(root).review_required,true);assert.throws(()=>complete(child),reason('scoring_review_required'));
 assert.doesNotThrow(()=>mutate(root,{scoring_mode:'subtasks'}));assert.equal(preview(root,{scoring_mode:'subtasks'}).valid,true);
});
test('rewarded legacy scope preserves its historical policy and permits prospective cancellation',()=>{
 const root=task(8,{assigned:[2]}),first=task(3,{parent:root,assigned:[2]}),second=task(4,{parent:root,assigned:[2]});complete(first);d.prepare('UPDATE tasks SET scoring_review_required=1 WHERE id=?').run(root);
 assert.equal(complete(second),true);assert.doesNotThrow(()=>mutate(root,{points:0}));assert.throws(()=>mutate(root,{scoring_mode:'subtasks'}),reason('scoring_mode_locked'));
});
test('generated helper and container projections remain nonpayable with erroneous positive points',()=>{
 const root=task(8,{mode:'whole_task',assigned:[2]}),support=task(99,{assigned:[3]}),projection=task(99,{parent:support,assigned:[3]});
 d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)").run(root,support);
 d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,?,?,?,'assigned','supervised')").run(root,root,projection,2,3);
 assert.equal(complete(support),false);assert.equal(complete(projection),false);assert.equal(complete(root,3),true);assert.deepEqual(earns(),[{task_id:root,user_id:2,delta:8}]);
});
test('delegated child work credits its eligible helper while a delegated source parent earns nothing',()=>{
 const root=task(11,{mode:'subtasks',assigned:[2]}),child=task(4,{parent:root});d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','delegated')").run(root,child);
 assert.deepEqual(summary(root).potential,[{user_id:3,points:4}]);assert.equal(complete(child,3),true);assert.equal(complete(root,3),false);
 const other=task(11,{mode:'whole_task',assigned:[2]});d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','delegated')").run(other,other);assert.equal(complete(other,3),false);
});
test('supervised child completion credits inherited learner rather than clicking helper',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(4,{parent:root});d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','supervised')").run(root,child);assert.equal(complete(child,3),true);assert.deepEqual(earns(),[{task_id:child,user_id:2,delta:4}]);
});
test('skipped and expired ancestors do not produce completion rewards',()=>{
 for(const status of ['skipped','expired']){const root=task(0,{mode:'subtasks',assigned:[2],status}),child=task(4,{parent:root});assert.equal(awardForCompletion(d,child,2),false);assert.deepEqual(summary(root).potential,[]);}
});
test('original nonrecurring work identity survives delete and readd with the same ID',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(4,{parent:root});complete(child);d.prepare('DELETE FROM tasks WHERE id=?').run(child);task(9,{parent:root,id:child});assert.equal(complete(child),false);assert.deepEqual(summary(root).earned,[{user_id:2,points:4}]);
});
test('regenerated recurrence action keeps its original settled logical identity',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(4,{parent:root});d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(root);complete(child);
 const original=d.prepare('SELECT * FROM task_recurrence_actions WHERE task_id=?').get(child);const occurrence=d.prepare('SELECT * FROM task_recurrence_occurrences WHERE task_id=?').get(root);
 d.prepare('DELETE FROM tasks WHERE id=?').run(root);const replacement=task(0,{mode:'subtasks',assigned:[2]});d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(replacement);
 d.prepare('INSERT INTO task_recurrence_occurrences(task_id,series_id,predecessor_task_id,generation,occurrence_key) VALUES(?,?,?,?,?)').run(replacement,occurrence.series_id,root,occurrence.generation+1,occurrence.occurrence_key);
 const next=task(9,{parent:replacement});d.prepare('INSERT INTO task_recurrence_actions(task_id,occurrence_task_id,action_key) VALUES(?,?,?)').run(next,replacement,original.action_key);
 assert.equal(complete(next),false);assert.equal(summary(replacement).mode_locked,true);assert.deepEqual(summary(replacement).earned,[{user_id:2,points:4}]);
});
test('bound executable Activity owns its checklist independently of reviewed Workflow container',()=>{
 const container=task(99),activity=task(7,{parent:container,mode:'whole_task',assigned:[2]}),check=task(3,{parent:activity});
 const instance=Number(d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES(?,1)').run(container).lastInsertRowid);d.prepare('INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id) VALUES(?,?)').run(instance,activity);
 d.prepare('UPDATE tasks SET scoring_review_required=1 WHERE id=?').run(container);assert.equal(summary(check).root_task_id,activity);assert.equal(complete(check),false);assert.equal(complete(activity),true);assert.equal(complete(container),false);assert.equal(summary(container).potential.length,0);
 assert.throws(()=>mutate(container,{scoring_mode:'subtasks'}),reason('scoring_review_required'));
});
test('unsafe ordinary nested tree requires structural scoring review',()=>{
 const root=task(0),middle=task(4,{parent:root}),leaf=task(3,{parent:middle});assert.throws(()=>mutate(root,{scoring_mode:'subtasks'}),reason('scoring_review_required'));assert.equal(preview(root,{scoring_mode:'whole_task'}).valid,false);
});
test('settlements are immutable and retries through sync/direct callers cannot add recipients',()=>{
 const root=task(4,{mode:'whole_task',assigned:[2]});complete(root);assert.throws(()=>d.prepare('UPDATE task_scoring_settlements SET points=7 WHERE task_id=?').run(root),/immutable/);assert.throws(()=>d.prepare('DELETE FROM task_scoring_settlements WHERE task_id=?').run(root),/immutable/);assignment(root,[3]);syncTaskRewards(d,root,'open','done',3);assert.deepEqual(earns(),[{task_id:root,user_id:2,delta:4}]);
});
test('future preview uses effective future definition rather than an occurrence exception and accepts template child identities',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(19,{parent:root});
 const result=api('previewTaskScoring',d,root,{subtasks:[{id:876,title:'Future template work',points:7,assigned_user_ids:[3]}]},{scope:'future_only',beforeDefinition:{scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,title:'Stored future work',points:5}]}});
 assert.equal(result.valid,true);assert.deepEqual(result.before,[{user_id:2,points:5}]);assert.deepEqual(result.after,[{user_id:3,points:7}]);
});
test('authorized work filters preserve full historical lock without exposing hidden work amounts or IDs',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),hidden=task(7,{parent:root}),visible=task(3,{parent:root});complete(hidden);
 const result=api('taskScoringSummary',d,root,{viewerId:2,authorizedTaskIds:[root,visible]});assert.equal(result.mode_locked,true);assert.deepEqual(result.earned,[]);assert.deepEqual(result.settled_task_ids,[]);assert.deepEqual(result.potential,[{user_id:2,points:3}]);
});
test('viewer summaries exclude separately private child potential and frozen earnings',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),hidden=task(7,{parent:root});d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden);assert.deepEqual(summary(root,2).potential,[]);complete(hidden);assert.deepEqual(summary(root,2).earned,[]);assert.equal(summary(root,2).mode_locked,true);
});
test('root hydration may retain visible deleted settlements while leaf filters and private snapshots remain narrow',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),deleted=task(7,{parent:root}),hidden=task(11,{parent:root}),remaining=task(3,{parent:root});d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden);complete(deleted);complete(hidden);d.prepare('DELETE FROM tasks WHERE id IN (?,?)').run(deleted,hidden);
 const result=api('taskScoringSummary',d,root,{viewerId:2,authorizedTaskIds:[root,remaining],includeHistoricalSettlements:true});assert.deepEqual(result.earned,[{user_id:2,points:7}]);assert.equal(result.personal_total,10);assert.deepEqual(result.settled_task_ids,[deleted]);
 assert.deepEqual(api('taskScoringSummary',d,remaining,{viewerId:2,authorizedTaskIds:[remaining]}).earned,[]);
});
test('fix I1 deleted assignees work keeps scalar and inherited reward recipients separate from visibility',()=>{
 for(const scalar of [true,false]){
  const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(7,{parent:root});
  d.prepare("UPDATE tasks SET visibility='assignees',assigned_to=? WHERE id=?").run(scalar?2:null,child);complete(child);
  const options={viewerId:2,authorizedTaskIds:[root],includeHistoricalSettlements:true};
  assert.deepEqual(api('taskScoringSummary',d,root,options).earned,[]);
  d.prepare('DELETE FROM tasks WHERE id=?').run(child);
  const result=api('taskScoringSummary',d,root,options);
  assert.equal(result.mode_locked,true);assert.deepEqual(result.earned,[]);assert.deepEqual(result.settled_task_ids,[]);assert.deepEqual(result.settlements,[]);
  assert.deepEqual(api('taskScoringSummary',d,root,{...options,viewerId:1}).settled_task_ids,[child]);
  assert.deepEqual(JSON.parse(d.prepare('SELECT visibility_json FROM task_scoring_settlements WHERE task_id=?').get(child).visibility_json).assigned,[]);
 }
});
test('fix I1 deleted visibility snapshots retain actual joins and private creator access',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),joined=task(7,{parent:root,assigned:[3]}),privateChild=task(11,{parent:root,assigned:[3]});
 d.prepare("UPDATE tasks SET visibility='assignees',assigned_to=2 WHERE id=?").run(joined);d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(privateChild);complete(joined);complete(privateChild);
 d.prepare('DELETE FROM tasks WHERE id IN (?,?)').run(joined,privateChild);
 const options={authorizedTaskIds:[root],includeHistoricalSettlements:true};
 assert.deepEqual(api('taskScoringSummary',d,root,{...options,viewerId:3}).earned,[{user_id:3,points:7}]);
 assert.deepEqual(api('taskScoringSummary',d,root,{...options,viewerId:3}).settled_task_ids,[joined]);
 assert.deepEqual(api('taskScoringSummary',d,root,{...options,viewerId:2}).settlements,[]);
 assert.deepEqual(api('taskScoringSummary',d,root,{...options,viewerId:1}).settled_task_ids,[joined,privateChild]);
 assert.equal(api('taskScoringSummary',d,root,{...options,viewerId:2}).mode_locked,true);
});
test('root historical hydration retains archived visible earnings while archived private work remains hidden',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),archived=task(7,{parent:root}),hidden=task(11,{parent:root}),remaining=task(3,{parent:root});d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden);complete(archived);complete(hidden);d.prepare("UPDATE tasks SET archived_at='2026-10-11T00:00:00Z' WHERE id IN (?,?)").run(archived,hidden);
 const result=api('taskScoringSummary',d,root,{viewerId:2,authorizedTaskIds:[root,remaining],includeHistoricalSettlements:true});assert.deepEqual(result.earned,[{user_id:2,points:7}]);assert.equal(result.personal_total,10);assert.deepEqual(result.settled_task_ids,[archived]);assert.deepEqual(api('taskScoringSummary',d,remaining,{viewerId:2,authorizedTaskIds:[remaining]}).earned,[]);
 assert.deepEqual(api('taskScoringSummary',d,root,{authorizedTaskIds:[root,remaining],includeHistoricalSettlements:true}).earned,[{user_id:2,points:7}]);
});
test('legacy previews apply proposed assignments to remaining legacy work',()=>{
 const root=task(4,{assigned:[2]});assert.deepEqual(preview(root,{assigned_to:[3]}).after,[{user_id:3,points:4}]);
});
test('new child preview includes inherited potential in a personal context',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]});assert.deepEqual(preview(root,{subtasks:[{title:'New',points:4}]},2).after,[{user_id:2,points:4}]);
});
function futureTemplate(root,proposed,beforeDefinition={scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[3]},{id:655,points:9,assigned_user_ids:[2]}]}){
 return api('previewTaskScoring',d,root,proposed,{scope:'future_only',beforeDefinition});
}
test('fix I3 reordered partial future templates retain omitted points and recipients by external identity',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]});
 const before=d.prepare('SELECT total_changes() n').get().n;
 const result=futureTemplate(root,{subtasks:[{id:655,points:10},{id:654}]});
 assert.equal(result.valid,true);assert.deepEqual(result.before,[{user_id:2,points:9},{user_id:3,points:5}]);assert.deepEqual(result.after,[{user_id:2,points:10},{user_id:3,points:5}]);
 const reassigned=futureTemplate(root,{subtasks:[{id:655,assigned_to:[3]},{id:654,assigned_user_ids:[2]}]});
 assert.equal(reassigned.valid,true);assert.deepEqual(reassigned.after,[{user_id:2,points:5},{user_id:3,points:9}]);
 assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
});
test('fix I3 new future units never copy omitted terms from an existing position',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]});
 for(const fresh of [{id:876,points:7},{points:7}]){
  const result=futureTemplate(root,{subtasks:[fresh,{id:654}]});
  assert.equal(result.valid,true);assert.deepEqual(result.after,[{user_id:2,points:7},{user_id:3,points:5}]);
 }
 assert.deepEqual(futureTemplate(root,{subtasks:[{id:876},{id:655}]}).after,[{user_id:2,points:9}]);
});
test('fix I3 template add remove and readd forecasts use only the effective definition and stay pure',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]});
 const original={scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[3]},{id:655,points:9,assigned_user_ids:[2]}]};
 const removed={...original,subtasks:[{id:655,points:9,assigned_user_ids:[2]}]},added={...removed,subtasks:[{id:876,points:7,assigned_user_ids:[3]},...removed.subtasks]};
 const frozen=JSON.stringify({original,removed,added}),changes=d.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(futureTemplate(root,{subtasks:[{id:655}]},original).after,[{user_id:2,points:9}]);
 assert.deepEqual(futureTemplate(root,{subtasks:added.subtasks},removed).after,[{user_id:2,points:9},{user_id:3,points:7}]);
 assert.deepEqual(futureTemplate(root,{subtasks:[{id:655},{id:654,points:5,assigned_user_ids:[3]}]},added).after,[{user_id:2,points:9},{user_id:3,points:5}]);
 assert.deepEqual(futureTemplate(root,{subtasks:[{id:654},{id:655}]},removed).after,[{user_id:2,points:9}]);
 assert.equal(JSON.stringify({original,removed,added}),frozen);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
});
test('fix I3 duplicate external template IDs reject both stored definitions and proposed drafts without writes',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),changes=d.prepare('SELECT total_changes() n').get().n;
 const result=futureTemplate(root,{subtasks:[{id:654},{id:654,points:8}]});assert.equal(result.valid,false);assert.equal(result.warnings[0].reason,'scoring_review_required');
 assert.throws(()=>futureTemplate(root,{}, {scoring_mode:'subtasks',subtasks:[{id:654,points:5},{id:654,points:9}]}),reason('scoring_review_required'));
 assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
});
test('explicit fully linked correction appends one release and one replacement while original settlement stays immutable',()=>{
 const root=task(5,{mode:'whole_task',assigned:[2]});d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(root);complete(root);const original=JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all());
 retireRecurrenceOccurrences(d,[root],{actorId:1,reason:'Synthetic correction'});assert.throws(()=>releaseCorrectedRetiredAwards(d,[root],{actorId:1,reason:'Synthetic correction'}),/fully offset/);
 const ledger=d.prepare("SELECT id FROM reward_ledger WHERE task_id=? AND type='earn'").get(root);createPointAdjustment(d,{actorId:1,userId:2,delta:-5,reason:'Synthetic full offset',taskId:root,ledgerId:ledger.id,requestKey:'synthetic-correction'});
 assert.deepEqual(releaseCorrectedRetiredAwards(d,[root],{actorId:1,reason:'Synthetic full offset'}),[root]);assert.deepEqual(releaseCorrectedRetiredAwards(d,[root],{actorId:1,reason:'Retry'}),[]);assert.equal(JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),original);
 const replacement=task(5,{mode:'whole_task',assigned:[2]});d.prepare("UPDATE tasks SET is_recurring=1,recurrence_origin_id=?,due_date='2026-10-11' WHERE id=?").run(root,replacement);
 assert.equal(complete(replacement),true);assert.equal(awardForCompletion(d,replacement,2),false);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_settlement_releases').get().n,1);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_settlements').get().n,2);assert.equal(summary(replacement).mode_locked,true);
 assert.throws(()=>d.prepare('DELETE FROM task_scoring_settlement_releases').run(),/immutable/);
});
test('retired claim flag alone never authorizes releasing an original settlement',()=>{
 const root=task(5,{mode:'whole_task',assigned:[2]});d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(root);complete(root);retireRecurrenceOccurrences(d,[root],{actorId:1,reason:'Synthetic retirement'});d.prepare("UPDATE reward_task_awards SET retired_at='2026-10-11T00:00:00Z' WHERE task_id=?").run(root);
 const replacement=task(5,{mode:'whole_task',assigned:[2]});d.prepare("UPDATE tasks SET is_recurring=1,recurrence_origin_id=?,due_date='2026-10-11' WHERE id=?").run(root,replacement);assert.equal(complete(replacement),false);assert.equal(summary(replacement).mode_locked,true);
});
test('unit projection preserves the default contract and exposes only the selected payable source',()=>{
 const root=task(8,{mode:'whole_task',assigned:[2,3]}),child=task(19,{parent:root,assigned:[2]});
 const plain=preview(root),result=unitPreview(root);
 assert.deepEqual(Object.keys(plain),['mode','mode_locked','review_required','earned','before','after','warnings','valid','scope','current_preserved']);
 assert.deepEqual(result.before_units,[unit(taskRef(root),8,[2,3])]);assert.deepEqual(result.after_units,result.before_units);assert.deepEqual(result.settlements,[]);
 const {before_units,after_units,settlements,...original}=result;assert.deepEqual(original,plain);
 assert.deepEqual(unitTotals(before_units),result.before);assert.deepEqual(unitTotals(after_units),result.after);assert.ok(before_units.every(row=>row.ref.task_id!==child));
});
test('unit projection shows available zero and no-recipient child outcomes and original draft indices',()=>{
 const root=task(90,{mode:'subtasks',assigned:[2]}),zero=task(0,{parent:root}),none=task(6,{parent:root,assigned:[4]});
 const result=unitPreview(root,{subtasks:[{id:zero},{title:'New optional work',points:4,is_optional:true},{id:none},{title:'Unenrolled work',points:7,assigned_user_ids:[4]}]},{viewerId:3,authorizedTaskIds:[root,zero,none]});
 assert.deepEqual(result.before_units,[unit(taskRef(zero),0,[2]),unit(taskRef(none),6)]);
 assert.deepEqual(result.after_units,[unit(taskRef(zero),0,[2]),unit({kind:'draft',draft_index:1},4,[2]),unit(taskRef(none),6),unit({kind:'draft',draft_index:3},7)]);
 assert.deepEqual(result.before,[]);assert.deepEqual(result.after,[{user_id:2,points:4}]);assert.deepEqual(unitTotals(result.after_units),result.after);assert.ok(result.after_units.every(row=>!Object.hasOwn(row,'title')&&!Object.hasOwn(row,'is_optional')));
});
test('unit projection separates frozen settlements from available remainder and invalid settled edits',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),done=task(3,{parent:root}),remaining=task(4,{parent:root});complete(done);
 const result=unitPreview(root,{subtasks:[{id:done},{id:remaining,points:8}]},{viewerId:2});
 assert.equal(result.valid,true);assert.deepEqual(result.earned,[{user_id:2,points:3}]);assert.deepEqual(result.before_units,[unit(taskRef(remaining),4,[2])]);assert.deepEqual(result.after_units,[unit(taskRef(remaining),8,[2])]);
 assert.equal(result.settlements.length,1);assert.equal(result.settlements[0].task_id,done);assert.ok(Number.isSafeInteger(result.settlements[0].settlement_id));assert.equal(result.settlements[0].points,3);assert.deepEqual(result.settlements[0].recipients,[{user_id:2,points:3}]);
 const invalid=unitPreview(root,{subtasks:[{id:done,points:7},{id:remaining}]});assert.equal(invalid.valid,false);assert.equal(invalid.warnings[0].reason,'settled_rewards');assert.deepEqual(invalid.settlements,result.settlements);assert.deepEqual(invalid.after_units,[unit(taskRef(remaining),4,[2])]);
});
test('unit projection omits current done archived skipped and expired work from remaining units',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),active=task(2,{parent:root});
 for(const status of ['done','skipped','expired'])task(9,{parent:root,status});const archived=task(9,{parent:root});d.prepare("UPDATE tasks SET archived_at='2026-10-11T00:00:00Z' WHERE id=?").run(archived);
 assert.deepEqual(unitPreview(root).before_units,[unit(taskRef(active),2,[2])]);d.prepare("UPDATE tasks SET status='expired' WHERE id=?").run(root);assert.deepEqual(unitPreview(root).before_units,[]);
});
test('unit projection uses the shared supervision resolver and excludes helper and Workflow containers',()=>{
 const root=task(11,{mode:'subtasks',assigned:[2]}),delegated=task(5,{parent:root}),supervised=task(4,{parent:root}),helper=task(99,{parent:root,assigned:[3]}),counterpart=task(99,{parent:helper,assigned:[3]});
 d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(root,helper);
 d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,?,?,?,'assigned','delegated')").run(root,delegated,counterpart,2,3);
 d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','supervised')").run(root,supervised);
 const result=unitPreview(root,{}, {viewerId:3});assert.deepEqual(result.before_units,[unit(taskRef(delegated),5,[3]),unit(taskRef(supervised),4,[2])]);assert.deepEqual(unitTotals(result.before_units),result.before);
 const source=task(8,{mode:'whole_task',assigned:[2]});d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','delegated')").run(source,source);assert.deepEqual(unitPreview(source).before_units,[unit(taskRef(source),8)]);
 const container=task(99),activity=task(7,{parent:container,mode:'whole_task',assigned:[2]});task(3,{parent:activity});const instance=Number(d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES(?,1)').run(container).lastInsertRowid);d.prepare('INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id) VALUES(?,?)').run(instance,activity);
 assert.deepEqual(unitPreview(container).before_units,[]);assert.deepEqual(unitPreview(activity).before_units,[unit(taskRef(activity),7,[2])]);
});
test('unit projection retains unknown and heterogeneous frozen amounts without inventing credit',()=>{
 const root=task(8,{mode:'whole_task',assigned:[2]}),definition=api('taskRewardDefinition',d,root);
 api('recordTaskScoringSettlement',d,{...definition,points:null},api('taskScoringIdentity',d,root),{outcome:'historical_claim',awardedRecipients:[],earnedOnce:true});
 const result=unitPreview(root);assert.equal(result.settlements[0].points,null);assert.equal(result.settlements[0].outcome,'historical_claim');assert.deepEqual(result.settlements[0].recipients,[]);assert.deepEqual(result.earned,[]);assert.equal(result.mode_locked,true);assert.deepEqual(result.before_units,[]);
 assignment(root,[3]);d.prepare('UPDATE tasks SET points=100 WHERE id=?').run(root);d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=2').run();assert.deepEqual(unitPreview(root).settlements,result.settlements);
 const other=task(0),child=task(9,{parent:other});const historical=api('taskRewardDefinition',d,child);api('recordTaskScoringSettlement',d,{...historical,points:null},api('taskScoringIdentity',d,child),{awardedRecipients:[{user_id:2,points:5},{user_id:3,points:7}],outcome:'earned'});
 const mixed=unitPreview(other);assert.equal(mixed.settlements[0].points,null);assert.deepEqual(mixed.settlements[0].recipients,[{user_id:2,points:5},{user_id:3,points:7}]);assert.deepEqual(mixed.earned,mixed.settlements[0].recipients);
});
test('unit projection preserves separate immutable correction settlements and gross earning history',()=>{
 const root=task(5,{mode:'whole_task',assigned:[2]});d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(root);complete(root);const original=unitPreview(root).settlements[0];retireRecurrenceOccurrences(d,[root],{actorId:1,reason:'Synthetic correction'});
 const ledger=d.prepare("SELECT id FROM reward_ledger WHERE task_id=? AND type='earn'").get(root);createPointAdjustment(d,{actorId:1,userId:2,delta:-5,reason:'Synthetic offset',taskId:root,ledgerId:ledger.id,requestKey:'unit-projection-correction'});releaseCorrectedRetiredAwards(d,[root],{actorId:1,reason:'Synthetic offset'});
 const replacement=task(5,{mode:'whole_task',assigned:[2]});d.prepare("UPDATE tasks SET is_recurring=1,recurrence_origin_id=?,due_date='2026-10-11' WHERE id=?").run(root,replacement);complete(replacement);
 const result=unitPreview(replacement);assert.equal(result.settlements.length,2);assert.equal(new Set(result.settlements.map(row=>row.settlement_id)).size,2);assert.deepEqual(result.settlements[0],original);assert.deepEqual(result.earned,[{user_id:2,points:10}]);assert.equal(d.prepare('SELECT SUM(delta) total FROM reward_ledger WHERE user_id=2').get().total,5);assert.deepEqual(result.before_units,[]);
});
test('unit projection keeps deleted archived and leaf history permission filters separate from the global lock',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),archived=task(7,{parent:root}),deleted=task(5,{parent:root,assigned:[2]}),privateWork=task(11,{parent:root}),scalarOnly=task(9,{parent:root}),remaining=task(3,{parent:root});
 d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(privateWork);d.prepare("UPDATE tasks SET visibility='assignees' WHERE id=?").run(deleted);d.prepare("UPDATE tasks SET visibility='assignees',assigned_to=2 WHERE id=?").run(scalarOnly);
 for(const id of [archived,deleted,privateWork,scalarOnly])complete(id);d.prepare("UPDATE tasks SET archived_at='2026-10-11T00:00:00Z' WHERE id IN (?,?)").run(archived,privateWork);d.prepare('DELETE FROM tasks WHERE id IN (?,?)').run(deleted,scalarOnly);
 const result=unitPreview(root,{}, {viewerId:2,authorizedTaskIds:[root,remaining],includeHistoricalSettlements:true});assert.equal(result.mode_locked,true);assert.deepEqual(result.earned,[{user_id:2,points:12}]);assert.deepEqual(result.settlements.map(row=>row.task_id),[archived,deleted]);assert.deepEqual(result.before_units,[unit(taskRef(remaining),3,[2])]);
 const leaf=unitPreview(remaining,{}, {viewerId:2,authorizedTaskIds:[remaining]});assert.equal(leaf.mode_locked,true);assert.deepEqual(leaf.settlements,[]);assert.deepEqual(leaf.earned,[]);assert.deepEqual(leaf.before_units,[unit(taskRef(remaining),3,[2])]);
});
test('unit projection preserves external future identities across reorder add remove and root mode choice',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]});task(19,{parent:root});const beforeDefinition={scoring_mode:'subtasks',points:0,assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[3]},{id:655,points:9,assigned_user_ids:[2]}]},options={scope:'future_only',beforeDefinition,authorizedTaskIds:[root],authorizedTemplateIds:[654,655,876]};
 const result=unitPreview(root,{subtasks:[{id:655,points:10},{id:654}]},options);assert.deepEqual(result.before_units,[unit(templateRef(654),5,[3]),unit(templateRef(655),9,[2])]);assert.deepEqual(result.after_units,[unit(templateRef(655),10,[2]),unit(templateRef(654),5,[3])]);assert.deepEqual(unitTotals(result.after_units),result.after);
 const added=unitPreview(root,{subtasks:[{id:876,points:7},{id:654}]},options);assert.deepEqual(added.after_units,[unit(templateRef(876),7,[2]),unit(templateRef(654),5,[3])]);
 const removed={...beforeDefinition,subtasks:[beforeDefinition.subtasks[1]]};assert.deepEqual(unitPreview(root,{subtasks:[{id:654},{id:655}]},{...options,beforeDefinition:removed}).after_units,[unit(templateRef(654),0,[2]),unit(templateRef(655),9,[2])]);
 const whole=unitPreview(root,{scoring_mode:'whole_task',points:6},options);assert.deepEqual(whole.after_units,[unit({kind:'definition_root'},6,[2])]);
 const duplicate=unitPreview(root,{subtasks:[{id:654},{id:654}]},options);assert.equal(duplicate.valid,false);assert.equal(duplicate.warnings[0].reason,'scoring_review_required');assert.deepEqual(duplicate.after_units,duplicate.before_units);
});
for(const hidden of [true,false])test('unit projection canonical template collision ignores current '+(hidden?'private visibility':'delegated supervision'),()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),child=task(11,{parent:root,assigned:[3]});if(hidden)d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(child);
 d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','delegated')").run(root,child);complete(child,3);
 const beforeDefinition={scoring_mode:'subtasks',points:0,assigned_to:[2],subtasks:[{id:child,points:7,assigned_user_ids:[2],visibility:'all'}]},proposed={subtasks:[{id:child,points:9}]},options={scope:'future_only',viewerId:2,beforeDefinition,authorizedTaskIds:hidden?[root]:[root,child],authorizedTemplateIds:[child],includeHistoricalSettlements:true};
 const frozen=JSON.stringify({beforeDefinition,proposed,options}),settlements=JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),changes=d.prepare('SELECT total_changes() n').get().n;
 const result=unitPreview(root,proposed,options);assert.deepEqual(result.before,[{user_id:2,points:7}]);assert.deepEqual(result.after,[{user_id:2,points:9}]);assert.deepEqual(result.before_units,[unit(templateRef(child),7,[2])]);assert.deepEqual(result.after_units,[unit(templateRef(child),9,[2])]);assert.equal(result.mode_locked,true);assert.equal(result.valid,true);assert.equal(result.current_preserved,true);
 assert.deepEqual(result.earned,hidden?[]:[{user_id:3,points:11}]);assert.equal(result.settlements.length,hidden?0:1);assert.equal(JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),settlements);assert.equal(JSON.stringify({beforeDefinition,proposed,options}),frozen);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
 const compatibility=unitPreview(root,{}, {...options,beforeDefinition:null});assert.deepEqual(compatibility.before,hidden?[]:[{user_id:3,points:11}]);assert.deepEqual(compatibility.before_units,hidden?[]:[unit(templateRef(child),11,[3])]);
});
test('unit projection template authorization filters both totals and detail without unioning current IDs',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),beforeDefinition={scoring_mode:'subtasks',points:0,assigned_to:[2],subtasks:[{id:100,points:5,assigned_user_ids:[2]},{id:200,points:8,assigned_user_ids:[3]}]},options={scope:'future_only',viewerId:2,beforeDefinition,authorizedTaskIds:[root],authorizedTemplateIds:[100]};
 const proposal={subtasks:[{id:200,points:99},{id:100}]},result=unitPreview(root,proposal,options);assert.deepEqual(result.before,[{user_id:2,points:5}]);assert.deepEqual(result.after,result.before);assert.deepEqual(result.before_units,[unit(templateRef(100),5,[2])]);assert.deepEqual(result.after_units,result.before_units);
 const plain=api('previewTaskScoring',d,root,proposal,options);assert.deepEqual(plain.before,result.before);assert.deepEqual(plain.after,result.after);assert.equal(Object.hasOwn(plain,'before_units'),false);
 const empty={...options,authorizedTemplateIds:[]};assert.deepEqual(unitPreview(root,{subtasks:[{points:99}]},empty).after_units,[]);assert.deepEqual(unitPreview(root,{},empty).before,[]);
 const whole=unitPreview(root,{scoring_mode:'whole_task',points:6},empty);assert.deepEqual(whole.after_units,[unit({kind:'definition_root'},6,[2])]);assert.deepEqual(unitPreview(root,{scoring_mode:'whole_task',points:6},{...empty,authorizedTaskIds:[]}).after,[]);
 const phases=unitPreview(root,{subtasks:[beforeDefinition.subtasks[1]]},{...options,beforeDefinition:{...beforeDefinition,subtasks:[beforeDefinition.subtasks[0]]},authorizedTemplateIds:[100,200]});assert.deepEqual(phases.before_units,[unit(templateRef(100),5,[2])]);assert.deepEqual(phases.after_units,[unit(templateRef(200),8,[3])]);
});
test('unit projection enrichment is pure and reuses the same eligibility and historical query passes',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),done=task(3,{parent:root}),remaining=task(4,{parent:root});complete(done);const proposed={subtasks:[{id:done},{id:remaining,points:8}]},options={viewerId:2,authorizedTaskIds:[root,done,remaining]};
 let calls=[];const probe=new Proxy(d,{get(target,key){const value=Reflect.get(target,key);if(key==='prepare')return(...args)=>{calls.push(args[0]);return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;}});
 const frozen=JSON.stringify({proposed,options}),changes=d.prepare('SELECT total_changes() n').get().n,plain=api('previewTaskScoring',probe,root,proposed,options),plainCalls=calls;calls=[];
 const enriched=api('previewTaskScoring',probe,root,proposed,{...options,includeUnits:true});assert.ok(Array.isArray(enriched.before_units));assert.deepEqual(calls,plainCalls);assert.ok(calls.filter(sql=>sql.includes('reward_participants WHERE enabled=1')).length>0);
 const {before_units,after_units,settlements,...original}=enriched;assert.deepEqual(original,plain);assert.equal(JSON.stringify({proposed,options}),frozen);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
});
const frozenVisibility=id=>JSON.parse(d.prepare('SELECT visibility_json FROM task_scoring_settlements WHERE task_id=?').get(id).visibility_json);
const sharedHistory=(root,ids=[root],options={})=>api('taskScoringSummary',d,root,{viewerId:null,authorizedTaskIds:ids,includeHistoricalSettlements:true,...options});
function oldHistory(root,id,visibility,amount=7){
 // Insert a synthetic append-only prior-format row once; never UPDATE an
 // immutable settlement to manufacture an old snapshot.
 d.prepare(`INSERT INTO task_scoring_settlements(logical_key,claim_key,task_id,root_task_id,root_logical_key,mode,points,recipients_json,earned_once,outcome,settled_at,visibility_json)
 VALUES(?,?,?,?,?,'legacy',?,?,1,?,'2024-01-02T03:04:05Z',?)`).run(api('taskScoringIdentity',d,id),JSON.stringify(['old-format',id]),id,root,api('taskScoringIdentity',d,root),amount,JSON.stringify(amount==null?[]:[{user_id:3,points:amount}]),amount==null?'historical_claim':'earned',JSON.stringify(visibility));
}
test('historical ancestry live settlement stays private on shared history after cascade deletion',()=>{
 const root=task(),middle=task(0,{parent:root}),leaf=task(37,{parent:middle,assigned:[3]});d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(middle);assert.equal(complete(leaf),true);
 const frozen=JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all());assert.deepEqual(summary(root,2).earned,[{user_id:3,points:37}]);assert.deepEqual(sharedHistory(root).earned,[]);
 d.prepare('DELETE FROM tasks WHERE id=?').run(middle);const result=sharedHistory(root);assert.deepEqual(result.earned,[]);assert.deepEqual(result.settlements,[]);assert.deepEqual(result.settled_task_ids,[]);assert.equal(result.mode_locked,true);
 assert.deepEqual(summary(root,2).earned,[{user_id:3,points:37}]);assert.equal(frozenVisibility(leaf).public_ancestry,false);assert.deepEqual(frozenVisibility(leaf).assigned,[3]);assert.equal(JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),frozen);
});
test('historical ancestry explicit deleted IDs cannot authorize shared summary or enriched settlement detail',()=>{
 const root=task(),middle=task(0,{parent:root}),leaf=task(37,{parent:middle,assigned:[3]});d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(middle);complete(leaf);d.prepare('DELETE FROM tasks WHERE id=?').run(middle);
 const options={viewerId:null,authorizedTaskIds:[root,leaf]},result=api('taskScoringSummary',d,root,options),enriched=unitPreview(root,{},options);
 assert.deepEqual(result.earned,[]);assert.deepEqual(result.settlements,[]);assert.deepEqual(result.settled_task_ids,[]);assert.deepEqual(enriched.earned,[]);assert.deepEqual(enriched.settlements,[]);assert.equal(result.mode_locked,true);assert.equal(enriched.mode_locked,true);
 assert.equal(JSON.stringify({result,enriched}).includes('public_ancestry'),false);
});
test('historical ancestry retains new flat and nested public earnings while private and assignees ancestors stay shared-hidden',()=>{
 const root=task(),flat=task(11,{parent:root,assigned:[3]}),publicMiddle=task(0,{parent:root}),publicLeaf=task(13,{parent:publicMiddle,assigned:[3]}),privateMiddle=task(0,{parent:root}),privateLeaf=task(17,{parent:privateMiddle,assigned:[3]}),assignedMiddle=task(0,{parent:root,assigned:[3]}),assignedLeaf=task(19,{parent:assignedMiddle,assigned:[3]});
 d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(privateMiddle);d.prepare("UPDATE tasks SET visibility='assignees' WHERE id=?").run(assignedMiddle);for(const id of [flat,publicLeaf,privateLeaf,assignedLeaf])complete(id);
 d.prepare('DELETE FROM tasks WHERE id IN (?,?,?,?)').run(flat,publicMiddle,privateMiddle,assignedMiddle);const result=sharedHistory(root);assert.deepEqual(result.earned,[{user_id:3,points:24}]);assert.deepEqual(result.settled_task_ids,[flat,publicLeaf]);assert.equal(result.mode_locked,true);
 for(const id of [flat,publicLeaf])assert.equal(frozenVisibility(id).public_ancestry,true);for(const id of [privateLeaf,assignedLeaf])assert.equal(frozenVisibility(id).public_ancestry,false);assert.deepEqual(summary(root,3).earned,[{user_id:3,points:60}]);assert.equal(JSON.stringify(result).includes('public_ancestry'),false);
});
test('historical ancestry shared archived history checks the extant chain and preserves current visibility semantics',()=>{
 const root=task(),middle=task(0,{parent:root}),privateBranch=task(17,{parent:middle,assigned:[3]}),flat=task(11,{parent:root,assigned:[3]});d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(middle);complete(privateBranch);complete(flat);d.prepare("UPDATE tasks SET archived_at='2026-10-11T00:00:00Z' WHERE id IN (?,?)").run(privateBranch,flat);
 assert.deepEqual(sharedHistory(root).earned,[{user_id:3,points:11}]);assert.deepEqual(sharedHistory(root,[root,privateBranch,flat]).earned,[{user_id:3,points:11}]);assert.deepEqual(summary(root,2).earned,[{user_id:3,points:28}]);
 d.prepare("UPDATE tasks SET visibility='all' WHERE id=?").run(middle);assert.deepEqual(sharedHistory(root).earned,[{user_id:3,points:28}]);assert.equal(frozenVisibility(privateBranch).public_ancestry,false);
 d.prepare('DELETE FROM tasks WHERE id=?').run(middle);assert.deepEqual(sharedHistory(root).earned,[{user_id:3,points:11}]);assert.equal(sharedHistory(root).mode_locked,true);
});
test('historical ancestry old missing null and malformed frozen proofs are denied only when shared ancestry is absent',()=>{
 const root=task(),ids=[];for(const proof of [undefined,null,false,'true',1,[],true]){const id=task(7,{parent:root,assigned:[3]});ids.push(id);oldHistory(root,id,{visibility:'all',created_by:1,assigned:[3],...(proof===undefined?{}:{public_ancestry:proof})});}
 const unknown=task(0,{parent:root});ids.push(unknown);oldHistory(root,unknown,{visibility:'all',created_by:1,assigned:[],public_ancestry:null},null);
 assert.deepEqual(sharedHistory(root,[root,...ids]).earned,[{user_id:3,points:49}]);d.prepare('DELETE FROM tasks WHERE parent_task_id=?').run(root);const frozen=JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),changes=d.prepare('SELECT total_changes() n').get().n;
 for(const result of [sharedHistory(root),sharedHistory(root,[root,...ids]),unitPreview(root,{}, {viewerId:null,authorizedTaskIds:[root,...ids]})]){assert.deepEqual(result.earned,[{user_id:3,points:7}]);assert.deepEqual(result.settlements.map(row=>row.task_id),[ids[6]]);assert.equal(result.mode_locked,true);}
 assert.deepEqual(summary(root,2).earned,[{user_id:3,points:49}]);assert.equal(summary(root,2).settlements.find(row=>row.task_id===unknown).points,null);assert.equal(JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),frozen);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
});
for(const malformed of ['missing parent','cycle'])test('historical ancestry synthetic '+malformed+' read cannot manufacture complete public proof',()=>{
 const root=task(),leaf=task(5,{parent:root,assigned:[3]}),definition=api('taskRewardDefinition',d,leaf);
 // Deliberately inject malformed read evidence. Persisted Tasks stay a valid
 // flat tree; no cyclic Task is created through SQL, lifecycle or public API.
 const probe=new Proxy(d,{get(target,key){const value=Reflect.get(target,key);if(key==='prepare')return sql=>{const statement=value.call(target,sql);if(sql!=='SELECT * FROM tasks WHERE id=?')return statement;return new Proxy(statement,{get(stmt,method){const fn=Reflect.get(stmt,method);if(method==='get')return id=>{const row=fn.call(stmt,id);return id===leaf?{...row,parent_task_id:malformed==='cycle'?leaf:999999}:row;};return typeof fn==='function'?fn.bind(stmt):fn;}});};return typeof value==='function'?value.bind(target):value;}});
 api('recordTaskScoringSettlement',probe,definition,api('taskScoringIdentity',d,leaf));assert.equal(d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(leaf).parent_task_id,root);d.prepare('DELETE FROM tasks WHERE id=?').run(leaf);
 assert.deepEqual(sharedHistory(root).earned,[]);assert.equal(frozenVisibility(leaf).public_ancestry,null);assert.deepEqual(summary(root,2).earned,[{user_id:3,points:5}]);assert.equal(sharedHistory(root).mode_locked,true);
});
test('historical ancestry captures structural parents above an independent bound Activity owner',()=>{
 const container=task(),activity=task(7,{parent:container,mode:'whole_task',assigned:[3]}),instance=Number(d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES(?,1)').run(container).lastInsertRowid);d.prepare('INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id) VALUES(?,?)').run(instance,activity);d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(container);
 assert.equal(complete(activity),true);assert.equal(api('taskScoringRoot',d,activity).id,activity);assert.deepEqual(sharedHistory(activity,[activity]).earned,[]);assert.equal(frozenVisibility(activity).public_ancestry,false);assert.deepEqual(summary(activity,3).earned,[{user_id:3,points:7}]);assert.equal(sharedHistory(activity,[activity]).mode_locked,true);
});
test('historical ancestry proof never turns scalar or inherited reward recipients into frozen visibility joins',()=>{
 const root=task(0,{mode:'subtasks',assigned:[3]}),joined=task(7,{parent:root,assigned:[3]}),scalar=task(4,{parent:root});d.prepare("UPDATE tasks SET visibility='assignees' WHERE id IN (?,?)").run(joined,scalar);d.prepare('UPDATE tasks SET assigned_to=3 WHERE id=?').run(scalar);complete(joined);complete(scalar);d.prepare('DELETE FROM tasks WHERE parent_task_id=?').run(root);
 assert.deepEqual(summary(root,3).earned,[{user_id:3,points:7}]);assert.deepEqual(summary(root,1).earned,[{user_id:3,points:11}]);assert.deepEqual(frozenVisibility(joined).assigned,[3]);assert.deepEqual(frozenVisibility(scalar).assigned,[]);assert.equal(frozenVisibility(joined).public_ancestry,false);assert.equal(frozenVisibility(scalar).public_ancestry,false);assert.deepEqual(sharedHistory(root).settlements,[]);
});

const executionContext=units=>({context:{kind:'next_occurrence',generation:1,as_of_date:'2026-11-01',assumed_completion_date:null,preparation:'fresh',conditions:[]},units,warnings:[]});
const executionUnit=(ref,role,assigned_user_ids,supervision=null)=>({ref,role,assigned_user_ids,supervision});
const delegatedFact={execution_mode:'delegated',state:'assigned',learner_user_id:2,supervisor_user_id:3};
function executionDatabaseSnapshot(){const schema=d.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();return JSON.stringify({schema,tables:Object.fromEntries(schema.filter(row=>row.type==='table').map(({name})=>[name,d.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row)).sort()]))});}
function executionPreview(root,beforeDefinition,beforeExecutionContext,afterExecutionContext=beforeExecutionContext,proposed={}){
 const snapshot=executionDatabaseSnapshot(),changes=d.prepare('SELECT total_changes() n').get().n,input=JSON.stringify({beforeDefinition,beforeExecutionContext,afterExecutionContext,proposed});
 try{return unitPreview(root,proposed,{scope:'future_only',beforeDefinition,beforeExecutionContext,afterExecutionContext});}finally{assert.equal(executionDatabaseSnapshot(),snapshot);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);assert.equal(JSON.stringify({beforeDefinition,beforeExecutionContext,afterExecutionContext,proposed}),input);}
}
test('prospective execution ignored-context beneficiary red pays the helper through the central phase resolver',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),beforeDefinition={scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[2]}]},facts=executionContext([executionUnit({kind:'definition_root'},'source_root',[2]),executionUnit(templateRef(654),'source_action',[2],delegatedFact)]);
 const frozen=JSON.stringify({beforeDefinition,facts}),changes=d.prepare('SELECT total_changes() n').get().n,result=executionPreview(root,beforeDefinition,facts);
 assert.deepEqual(result.before,[{user_id:3,points:5}]);assert.deepEqual(result.after,result.before);assert.deepEqual(result.after_units,[unit(templateRef(654),5,[3])]);assert.equal(result.valid,true);assert.equal(JSON.stringify({beforeDefinition,facts}),frozen);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
 const plain=unitPreview(root,{}, {scope:'future_only',beforeDefinition});assert.deepEqual(plain.after,[{user_id:2,points:5}]);assert.equal(Object.hasOwn(plain,'executionContext'),false);
});
test('prospective execution phase null clears delegation and root SQL mappings never supply prospective execution',()=>{
 const root=task(7,{mode:'whole_task',assigned:[2]});d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','delegated')").run(root,root);
 const definition={scoring_mode:'whole_task',points:7,assigned_to:[2],subtasks:[]},delegated=executionContext([executionUnit({kind:'definition_root'},'source_root',[2],delegatedFact)]),normal=executionContext([executionUnit({kind:'definition_root'},'source_root',[2])]),result=executionPreview(root,definition,delegated,normal);
 assert.deepEqual(result.before,[]);assert.deepEqual(result.after,[{user_id:2,points:7}]);assert.deepEqual(result.after_units,[unit({kind:'definition_root'},7,[2])]);assert.deepEqual(unitPreview(root,{}, {scope:'future_only',beforeDefinition:definition}).after,[]);
});
test('prospective execution operational recipient rotation does not replace assignees visibility or canonical joins',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]});d.prepare("UPDATE tasks SET visibility='assignees' WHERE id=?").run(root);const definition={scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[2]}]},facts=executionContext([executionUnit({kind:'definition_root'},'source_root',[3]),executionUnit(templateRef(654),'source_action',[3])]),options={scope:'future_only',beforeDefinition:definition,beforeExecutionContext:facts,afterExecutionContext:facts,viewerId:2,authorizedTaskIds:[root],authorizedTemplateIds:[654]};
 const result=unitPreview(root,{},options);assert.deepEqual(result.after,[{user_id:3,points:5}]);assert.deepEqual(result.after_units,[unit(templateRef(654),5,[3])]);assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(root),[{user_id:2}]);assert.throws(()=>unitPreview(root,{}, {...options,viewerId:3}),error=>error.status===404);
});
test('prospective execution inheritance multiple assignees enrollment and source roles share one resolver',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),definition={scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[2]},{id:655,points:0,assigned_user_ids:[2]},{id:656,points:8,assigned_user_ids:[2]}]},facts=executionContext([executionUnit({kind:'definition_root'},'source_root',[2,3]),executionUnit(templateRef(654),'source_action',[]),executionUnit(templateRef(655),'source_action',[3]),executionUnit(templateRef(656),'helper_projection',[3],delegatedFact)]);
 const result=executionPreview(root,definition,facts);assert.deepEqual(result.after,[{user_id:2,points:5},{user_id:3,points:5}]);assert.deepEqual(result.after_units,[unit(templateRef(654),5,[2,3]),unit(templateRef(655),0,[3])]);assert.deepEqual(unitTotals(result.after_units),result.after);
 const noRecipients=executionContext(facts.units.map(row=>row.ref.kind==='template'&&row.ref.template_id===654?{...row,assigned_user_ids:[4]}:row));assert.deepEqual(executionPreview(root,definition,noRecipients).after,[]);
 const delegated=executionContext(facts.units.map(row=>row.ref.kind==='template'&&row.ref.template_id===654?{...row,supervision:delegatedFact}:row));d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=3').run();const disabled=executionPreview(root,definition,delegated);assert.deepEqual(disabled.after,[]);assert.equal(disabled.after_units[0].outcome,'no_recipients');
 const container=executionContext(facts.units.map(row=>row.ref.kind==='definition_root'?{...row,role:'container'}:row));assert.deepEqual(executionPreview(root,definition,container).after_units,[]);
});
test('prospective execution supplied phase facts require exact safe complete refs with explicit independent supervision',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),definition={scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[2]}]},facts=executionContext([executionUnit({kind:'definition_root'},'source_root',[2]),executionUnit(templateRef(654),'source_action',[2])]),projection=error=>error.status===409&&error.reason==='scoring_projection_unavailable';
 const malformed=[{...facts,units:facts.units.slice(0,1)},{...facts,units:[...facts.units,facts.units[1]]},{...facts,units:[facts.units[0],{...facts.units[1],ref:templateRef(655)}]},{...facts,units:[facts.units[0],{...facts.units[1],supervision:undefined}]},{...facts,units:[facts.units[0],{...facts.units[1],assigned_user_ids:[true]}]},{...facts,units:[facts.units[0],{...facts.units[1],supervision:{...delegatedFact,supervisor_user_id:null}}]},{...facts,units:[facts.units[0],{...facts.units[1],recipients:[{user_id:3,points:99}]}]}];
 const changes=d.prepare('SELECT total_changes() n').get().n;for(const context of malformed)assert.throws(()=>executionPreview(root,definition,context),projection);assert.throws(()=>unitPreview(root,{}, {scope:'future_only',beforeDefinition:definition,beforeExecutionContext:facts}),projection);assert.throws(()=>unitPreview(root,{}, {beforeExecutionContext:facts,afterExecutionContext:facts}),projection);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
});
test('prospective execution typed context cannot erase a demonstrated structural Workflow container boundary',()=>{
 const container=task(99),activity=task(7,{parent:container,mode:'whole_task',assigned:[2]}),instance=Number(d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES(?,1)').run(container).lastInsertRowid);d.prepare('INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id) VALUES(?,?)').run(instance,activity);
 const wrong=executionContext([executionUnit({kind:'definition_root'},'source_root',[2])]),definition={points:99,assigned_to:[2],subtasks:[]};assert.throws(()=>executionPreview(container,definition,wrong),error=>error.status===409&&error.reason==='scoring_projection_unavailable');
 const proper=executionContext([executionUnit({kind:'definition_root'},'container',[2])]);assert.deepEqual(executionPreview(container,definition,proper).after_units,[]);const own=executionContext([executionUnit({kind:'definition_root'},'source_root',[2])]);assert.deepEqual(executionPreview(activity,{scoring_mode:'whole_task',points:7,assigned_to:[2],subtasks:[]},own).after,[{user_id:2,points:7}]);
});
test('prospective execution colliding template identity cannot borrow private current delegation or historical recipients',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),current=task(9,{parent:root,assigned:[2]});d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(current);d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,supervisor_user_id,state,execution_mode) VALUES(?,?,2,3,'assigned','delegated')").run(root,current);complete(current);
 const definition={scoring_mode:'subtasks',points:0,assigned_to:[2],subtasks:[{id:current,points:5,assigned_user_ids:[2]}]},facts=executionContext([executionUnit({kind:'definition_root'},'source_root',[2]),executionUnit(templateRef(current),'source_action',[2])]),result=executionPreview(root,definition,facts);assert.deepEqual(result.after,[{user_id:2,points:5}]);assert.deepEqual(result.after_units,[unit(templateRef(current),5,[2])]);assert.deepEqual(result.earned,[{user_id:3,points:9}]);assert.equal(result.mode_locked,true);
 const restricted=unitPreview(root,{}, {scope:'future_only',beforeDefinition:definition,beforeExecutionContext:facts,afterExecutionContext:facts,authorizedTaskIds:[root],authorizedTemplateIds:[current],viewerId:2});assert.deepEqual(restricted.earned,[]);assert.deepEqual(restricted.after,[{user_id:2,points:5}]);assert.deepEqual(restricted.settlements,[]);
});
test('prospective execution retained not-required facts become independent and planning facts never appear in public output',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),definition={scoring_mode:'subtasks',points:0,assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[2]}]},facts=executionContext([executionUnit({kind:'definition_root'},'source_root',[2]),executionUnit(templateRef(654),'source_action',[2],{...delegatedFact,state:'not_required',supervisor_user_id:null})]),result=executionPreview(root,definition,facts);assert.deepEqual(result.after,[{user_id:2,points:5}]);assert.deepEqual(result.after_units,[unit(templateRef(654),5,[2])]);assert.equal(JSON.stringify(result).includes('supervision'),false);assert.equal(JSON.stringify(result).includes('assigned_user_ids'),false);
});
test('prospective execution scope warnings survive private fact projection and remain deduplicated generic phase guidance',()=>{
 const root=task(7,{mode:'whole_task',assigned:[2]}),definition={scoring_mode:'whole_task',points:7,assigned_to:[2],subtasks:[]},normal=executionContext([executionUnit({kind:'definition_root'},'source_root',[2])]),before={...normal,warnings:[{reason:'prospective_supervision_unresolved',message:'Private hidden action and secret skill'},{reason:'prospective_supervision_unresolved',message:'Another private action'}]},result=executionPreview(root,definition,before,normal);assert.deepEqual(result.warnings,[{reason:'prospective_supervision_unresolved',message:'The prospective occurrence requires supervision that is not currently resolved.'}]);assert.deepEqual(result.after,[{user_id:2,points:7}]);assert.equal(result.valid,true);assert.equal(JSON.stringify(result).includes('Private hidden'),false);
 assert.throws(()=>executionPreview(root,definition,{...normal,warnings:[{reason:'private_skill_detail',message:'Private hidden'}]}),error=>error.status===409&&error.reason==='scoring_projection_unavailable');
});
test('prospective execution malformed self-supervision cannot masquerade as delegated eligibility',()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),definition={scoring_mode:'subtasks',assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[2]}]},facts=executionContext([executionUnit({kind:'definition_root'},'source_root',[2]),executionUnit(templateRef(654),'source_action',[2],{...delegatedFact,supervisor_user_id:2})]);assert.throws(()=>executionPreview(root,definition,facts),error=>error.status===409&&error.reason==='scoring_projection_unavailable');
});
for(const phase of ['before','after'])test(`prospective execution fix PE-M1 rejects malformed ${phase} unit shapes generically`,()=>{
 const root=task(0,{mode:'subtasks',assigned:[2]}),definition={scoring_mode:'subtasks',points:0,assigned_to:[2],subtasks:[{id:654,points:5,assigned_user_ids:[2]}]},valid=executionContext([executionUnit({kind:'definition_root'},'source_root',[2]),executionUnit(templateRef(654),'source_action',[2])]);
 for(const [index,value] of [[0,null],[1,null],[1,undefined],[1,42],[1,'invalid'],[1,[]],[1,Object.assign([],valid.units[1])]]){const malformed=structuredClone(valid);malformed.units[index]=value;assert.throws(()=>executionPreview(root,definition,phase==='before'?malformed:valid,phase==='after'?malformed:valid),error=>error.status===409&&error.reason==='scoring_projection_unavailable'&&error.message==='The prospective execution context cannot be prepared safely.');}
 assert.deepEqual(executionPreview(root,definition,valid).after,[{user_id:2,points:5}]);
});

test('simultaneous SQLite writers atomically settle an inherited work unit once',async()=>{
 assert.ok(ALL_MIGRATIONS.some(m=>m.version===10055),'scoring settlement migration is available');
 const directory=mkdtempSync(join(tmpdir(),'vidamia-scoring-race-')),path=join(directory,'synthetic.db');let db;const workers=[];
 try{db=new Database(path);db.pragma('journal_mode=WAL');migrate(db);db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES(1,'Synthetic','Synthetic','x');INSERT INTO reward_participants(user_id,enabled) VALUES(1,1)");
 db.exec("INSERT INTO tasks(id,title,created_by,points,scoring_mode) VALUES(1,'Root',1,0,'subtasks');INSERT INTO task_assignments(task_id,user_id) VALUES(1,1);INSERT INTO tasks(id,title,created_by,points,parent_task_id) VALUES(2,'Work',1,4,1)");
 const gate=new SharedArrayBuffer(4);for(let i=0;i<4;i++)workers.push(new Worker(new URL('./reward-integrity-worker.mjs',import.meta.url),{workerData:{path,kind:'award',args:[2,1],gate}}));
 const outcomes=workers.map(worker=>new Promise((ok,no)=>{worker.on('message',v=>{if(!v.ready)ok(v);});worker.on('error',no);}));await Promise.all(workers.map(worker=>new Promise((ok,no)=>{worker.once('message',ok);worker.once('error',no);})));Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0,4);
 const results=await Promise.all(outcomes);assert.equal(results.filter(r=>r.result===true).length,1);assert.ok(results.every(r=>!r.error));assert.equal(db.prepare('SELECT COUNT(*) n FROM task_scoring_settlements').get().n,1);assert.equal(db.prepare('SELECT SUM(delta) n FROM reward_ledger').get().n,4);
 }finally{await Promise.all(workers.map(worker=>worker.terminate()));db?.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}
});
