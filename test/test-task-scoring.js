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
