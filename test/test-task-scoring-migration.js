import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-task-scoring-migration';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {awardForCompletion}=await import('../server/services/rewards.js');
const {rewardOccurrenceProvenance}=await import('../server/services/task-recurrence-frontier.js');
const scoring=await import('../server/services/task-scoring.js').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
let d;
test.beforeEach(()=>{d=new Database(':memory:');d.pragma('foreign_keys=ON');for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10054)){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}d.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES(1,'Synthetic','Synthetic','x');INSERT INTO reward_participants(user_id,enabled) VALUES(1,1)");});
test.afterEach(()=>d.close());
function task(points=0,parent=null,status='open'){return Number(d.prepare("INSERT INTO tasks(title,created_by,points,parent_task_id,status,assigned_to) VALUES('Synthetic',1,?,?,?,1)").run(points,parent,status).lastInsertRowid);}
function upgrade(){const migrations=ALL_MIGRATIONS.filter(m=>m.version>10054);assert.equal(migrations.length,1,'one appended scoring migration exists');assert.equal(migrations[0].version,10055);d.transaction(()=>{const m=migrations[0];typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();return migrations[0];}
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
test('10054 upgrade infers only flat unambiguous configured sources and leaves equality ambiguous',()=>{
 const whole=task(7);task(0,whole);const each=task(0);task(4,each);const zero=task(0);task(0,zero);const both=task(7);task(3,both);task(4,both);const nested=task(0);const middle=task(0,nested);task(4,middle);
 upgrade();assert.equal(row(whole).scoring_mode,'whole_task');assert.equal(row(each).scoring_mode,'subtasks');assert.equal(row(zero).scoring_mode,'whole_task');for(const id of [both,nested]){assert.equal(row(id).scoring_mode,'legacy');assert.equal(row(id).scoring_review_required,1);}
});
test('historical ledger and existing claims remain byte equivalent with exact frozen earnings',()=>{
 const root=task(0),child=task(6,root,'done');d.prepare("INSERT INTO reward_ledger(user_id,delta,type,reason,task_id,created_by,created_at) VALUES(1,6,'earn','Original text',?,1,'2024-01-02T03:04:05Z')").run(child);d.prepare("INSERT INTO reward_task_awards(task_id,logical_key,awarded_at) VALUES(?,?,'2024-01-02T03:04:05Z')").run(child,JSON.stringify(['task',child]));
 const ledger=JSON.stringify(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all()),claims=JSON.stringify(d.prepare('SELECT * FROM reward_task_awards ORDER BY task_id').all());upgrade();assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all()),ledger);assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_task_awards ORDER BY task_id').all()),claims);
 const settlement=d.prepare('SELECT * FROM task_scoring_settlements WHERE task_id=?').get(child);assert.equal(settlement.points,6);assert.equal(settlement.settled_at,'2024-01-02T03:04:05Z');assert.deepEqual(JSON.parse(settlement.recipients_json),[{user_id:1,points:6}]);assert.equal(awardForCompletion(d,child,1),false);
});
test('configured sources that conflict with historical awards stay legacy for review',()=>{
 const root=task(9),child=task(0,root,'done');d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(1,3,'earn',?)").run(child);d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(child,JSON.stringify(['task',child]));upgrade();assert.equal(row(root).scoring_mode,'legacy');assert.equal(row(root).scoring_review_required,1);assert.equal(d.prepare('SELECT points FROM task_scoring_settlements WHERE task_id=?').get(child).points,3);
});
test('historical completed unawarded units settle without backfill including reopened completion evidence',()=>{
 const root=task(5,null,'done'),child=task(4,root,'done'),reopened=task(6);d.prepare('INSERT INTO task_completions(task_id,series_id,user_id) VALUES(?,?,1)').run(reopened,reopened);
 upgrade();assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);for(const id of [root,child,reopened]){assert.equal(d.prepare('SELECT outcome FROM task_scoring_settlements WHERE task_id=?').get(id).outcome,'historical_unrewarded');assert.equal(awardForCompletion(d,id,1),false);}assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards').get().n,0);
});
test('scoring schema upgrade is idempotent and preserves original inferred policy after later edits',()=>{
 const root=task(5,null,'done');const migration=upgrade();const before=JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all());d.prepare('UPDATE tasks SET points=99 WHERE id=?').run(root);d.transaction(()=>migration.up(d))();assert.equal(JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),before);assert.equal(row(root).scoring_mode,'whole_task');assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
});
test('workflow owners are inferred separately and container totals cannot award',()=>{
 const container=task(40),activity=task(7,container),check=task(0,activity);const instance=Number(d.prepare('INSERT INTO workflow_instances(parent_task_id,created_by) VALUES(?,1)').run(container).lastInsertRowid);d.prepare('INSERT INTO workflow_instance_tasks(workflow_instance_id,task_id) VALUES(?,?)').run(instance,activity);
 upgrade();assert.equal(row(container).scoring_mode,'legacy');assert.equal(row(container).scoring_review_required,1);assert.equal(row(activity).scoring_mode,'whole_task');assert.equal(row(activity).scoring_review_required,0);assert.equal(awardForCompletion(d,container,1),false);assert.equal(awardForCompletion(d,check,1),false);assert.equal(awardForCompletion(d,activity,1),true);
});
test('mode updates participate in Task and ancestor revisions',()=>{
 const root=task(0),child=task(3,root);upgrade();const before=row(root).revision;d.prepare("UPDATE tasks SET scoring_mode='whole_task' WHERE id=?").run(root);assert.ok(row(root).revision>before);const next=row(root).revision;d.prepare('UPDATE tasks SET scoring_review_required=1 WHERE id=?').run(child);assert.ok(row(root).revision>next);
});
test('durable historic claims keep the mode locked after recipient ledger evidence disappeared',()=>{
 const root=task(0);d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(root,JSON.stringify(['task',root]));upgrade();assert.equal(scoring.taskScoringSummary(d,root).mode_locked,true);
});
test('fix I2 parent claim conflicts with child-positive configuration and freezes no invented amount',()=>{
 const root=task(0),child=task(4,root);d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(root,JSON.stringify(['task',root]));
 const claims=JSON.stringify(d.prepare('SELECT * FROM reward_task_awards').all());upgrade();
 assert.equal(row(root).scoring_mode,'legacy');assert.equal(row(root).scoring_review_required,1);
 const settlement=d.prepare('SELECT * FROM task_scoring_settlements WHERE task_id=?').get(root);assert.equal(settlement.points,null);assert.equal(settlement.earned_once,1);assert.deepEqual(JSON.parse(settlement.recipients_json),[]);
 assert.equal(scoring.taskScoringSummary(d,root).mode_locked,true);assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_task_awards').all()),claims);assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_scoring_settlements WHERE task_id=?').get(child).n,0);
});
test('fix I2 child claim conflicts with parent-positive configuration and preserves empty historical credit',()=>{
 const root=task(9),child=task(0,root);d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(child,JSON.stringify(['task',child]));upgrade();
 assert.equal(row(root).scoring_mode,'legacy');assert.equal(row(root).scoring_review_required,1);assert.equal(d.prepare('SELECT points FROM task_scoring_settlements WHERE task_id=?').get(child).points,null);assert.deepEqual(scoring.taskScoringSummary(d,root).earned,[]);assert.equal(scoring.taskScoringSummary(d,root).mode_locked,true);
});
test('fix I2 claim without reconstructable ledger stays review-required even when current configured source agrees',()=>{
 const root=task(7);d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(root,JSON.stringify(['task',root]));const migration=upgrade();
 assert.equal(row(root).scoring_mode,'legacy');assert.equal(row(root).scoring_review_required,1);assert.equal(d.prepare('SELECT points FROM task_scoring_settlements WHERE task_id=?').get(root).points,null);
 const settlements=JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all());d.transaction(()=>migration.up(d))();assert.equal(JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),settlements);
});
test('fix I2 recipient deletion preserves claims and unknown amounts without guessing today\'s reward terms',()=>{
 d.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES(2,'Former member','Former member','x');INSERT INTO reward_participants(user_id,enabled) VALUES(2,1)");
 const root=task(5,null,'done');d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id,created_by,created_at) VALUES(2,5,'earn',?,1,'2024-01-02T03:04:05Z')").run(root);d.prepare("INSERT INTO reward_task_awards(task_id,logical_key,awarded_at) VALUES(?,?,'2024-01-02T03:04:05Z')").run(root,JSON.stringify(['task',root]));
 d.prepare('UPDATE tasks SET points=0 WHERE id=?').run(root);task(4,root);d.prepare('DELETE FROM users WHERE id=2').run();
 const ledger=JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all()),claims=JSON.stringify(d.prepare('SELECT * FROM reward_task_awards').all());assert.equal(ledger,'[]');const migration=upgrade();
 assert.equal(row(root).scoring_mode,'legacy');assert.equal(row(root).scoring_review_required,1);
 const settlement=d.prepare('SELECT * FROM task_scoring_settlements WHERE task_id=?').get(root);assert.equal(settlement.points,null);assert.equal(settlement.outcome,'historical_claim');assert.equal(settlement.earned_once,1);assert.equal(settlement.settled_at,'2024-01-02T03:04:05Z');assert.deepEqual(JSON.parse(settlement.recipients_json),[]);
 assert.equal(scoring.taskScoringSummary(d,root).mode_locked,true);assert.equal(awardForCompletion(d,root,1),false);d.transaction(()=>migration.up(d))();assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all()),ledger);assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_task_awards').all()),claims);
 assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
});
test('deleted recurring child claims retain their original occurrence root without rewriting detached ledger rows',()=>{
 const root=task(0),child=task(4,root,'done');d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(root);const provenance=rewardOccurrenceProvenance(d,child);
 d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(child,provenance.logicalKey);d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(1,4,'earn',?)").run(child);d.prepare('DELETE FROM tasks WHERE id=?').run(child);const before=JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all());upgrade();
 assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all()),before);assert.equal(row(root).scoring_mode,'legacy');assert.equal(scoring.taskScoringSummary(d,root).mode_locked,true);assert.equal(d.prepare('SELECT root_task_id FROM task_scoring_settlements WHERE task_id=?').get(child).root_task_id,root);
});

test('historical ancestry genuine upgrade preserves private intermediate denial after deletion without rewriting earn or claim history',()=>{
 for(const id of [2,3])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'x','member')").run(id,'Ancestry '+id,'Ancestry '+id);
 const root=task(),middle=task(0,root),leaf=task(37,middle,'done');d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(middle);d.prepare('UPDATE tasks SET assigned_to=3 WHERE id=?').run(leaf);d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,3)').run(leaf);
 d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id,created_at) VALUES(3,37,'earn',?,'2024-01-02T03:04:05Z')").run(leaf);d.prepare("INSERT INTO reward_task_awards(task_id,logical_key,awarded_at) VALUES(?,?,'2024-01-02T03:04:05Z')").run(leaf,JSON.stringify(['task',leaf]));
 const ledger=JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all()),claims=JSON.stringify(d.prepare('SELECT * FROM reward_task_awards').all()),migration=upgrade(),frozen=JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all());assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all()),ledger);assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_task_awards').all()),claims);
 d.prepare('DELETE FROM tasks WHERE id=?').run(middle);const shared=scoring.taskScoringSummary(d,root,{viewerId:null,authorizedTaskIds:[root],includeHistoricalSettlements:true});assert.deepEqual(shared.earned,[]);assert.deepEqual(shared.settlements,[]);assert.equal(shared.mode_locked,true);assert.deepEqual(scoring.taskScoringSummary(d,root,{viewerId:2,includeHistoricalSettlements:true}).earned,[{user_id:3,points:37}]);
 const settlement=d.prepare('SELECT * FROM task_scoring_settlements WHERE task_id=?').get(leaf);assert.equal(settlement.points,37);assert.equal(settlement.settled_at,'2024-01-02T03:04:05Z');assert.deepEqual(JSON.parse(settlement.recipients_json),[{user_id:3,points:37}]);assert.deepEqual(JSON.parse(settlement.visibility_json),{visibility:'all',created_by:1,assigned:[3],public_ancestry:false});assert.equal(row(root).scoring_mode,'legacy');assert.equal(row(root).scoring_review_required,1);
 d.transaction(()=>migration.up(d))();assert.equal(JSON.stringify(d.prepare('SELECT * FROM task_scoring_settlements').all()),frozen);assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_task_awards').all()),claims);assert.equal(d.prepare('SELECT delta FROM reward_ledger').get().delta,37);assert.equal(awardForCompletion(d,root,1),false);
});
test('historical ancestry genuine migration retains flat and nested public earning but withholds non-public ancestors',()=>{
 const root=task(),flat=task(11,root,'done'),publicMiddle=task(0,root),publicLeaf=task(13,publicMiddle,'done'),privateLeaf=task(17,root,'done'),assignedMiddle=task(0,root),assignedLeaf=task(19,assignedMiddle,'done');d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(privateLeaf);d.prepare("UPDATE tasks SET visibility='assignees' WHERE id=?").run(assignedMiddle);
 for(const [id,amount] of [[flat,11],[publicLeaf,13],[privateLeaf,17],[assignedLeaf,19]]){d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(1,?,'earn',?)").run(amount,id);d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(id,JSON.stringify(['task',id]));}upgrade();d.prepare('DELETE FROM tasks WHERE id IN (?,?,?,?)').run(flat,publicMiddle,privateLeaf,assignedMiddle);
 const shared=scoring.taskScoringSummary(d,root,{authorizedTaskIds:[root],includeHistoricalSettlements:true});assert.deepEqual(shared.earned,[{user_id:1,points:24}]);assert.deepEqual(shared.settled_task_ids,[flat,publicLeaf]);assert.equal(shared.mode_locked,true);assert.deepEqual(scoring.taskScoringSummary(d,root,{viewerId:1,includeHistoricalSettlements:true}).earned,[{user_id:1,points:60}]);
 for(const [id,proof] of [[flat,true],[publicLeaf,true],[privateLeaf,false],[assignedLeaf,false]])assert.equal(JSON.parse(d.prepare('SELECT visibility_json FROM task_scoring_settlements WHERE task_id=?').get(id).visibility_json).public_ancestry,proof);
});
test('historical ancestry already deleted recurring claim migration preserves unknown proof and unknown reward terms',()=>{
 const root=task(),leaf=task(4,root,'done');d.prepare("UPDATE tasks SET is_recurring=1,due_date='2026-10-11' WHERE id=?").run(root);const provenance=rewardOccurrenceProvenance(d,leaf);d.prepare('INSERT INTO reward_task_awards(task_id,logical_key) VALUES(?,?)').run(leaf,provenance.logicalKey);d.prepare('DELETE FROM tasks WHERE id=?').run(leaf);upgrade();
 const settlement=d.prepare('SELECT * FROM task_scoring_settlements WHERE task_id=?').get(leaf);assert.equal(JSON.parse(settlement.visibility_json).public_ancestry,null);assert.equal(settlement.points,null);assert.deepEqual(JSON.parse(settlement.recipients_json),[]);assert.equal(settlement.outcome,'historical_claim');assert.equal(scoring.taskScoringSummary(d,root,{authorizedTaskIds:[root,leaf]}).mode_locked,true);assert.deepEqual(scoring.taskScoringSummary(d,root,{authorizedTaskIds:[root,leaf]}).settlements,[]);
});
