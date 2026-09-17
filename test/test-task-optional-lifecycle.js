import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='optional-lifecycle-test';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
await import('../server/routes/tasks.js');
const {changeTaskStatus,expireTask}=await import('../server/services/task-lifecycle.js');
const {inspectTaskSupervision,reconcileTaskSupervision,attachTaskSupervision}=await import('../server/services/task-supervision.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {applyTaskActivityBinding}=await import('../server/services/task-activity-bindings.js');
const {overrideTaskAssignment}=await import('../server/services/assignment-responsibilities.js');
const {attachTaskCapabilities,taskCapabilities,withTaskReadProjection}=await import('../server/services/task-access.js');
let d,admin,learner,helper;
const now=new Date('2026-09-14T11:30:00Z');
function migrate(database,until=Infinity){for(const m of ALL_MIGRATIONS.filter(m=>m.version<=until)){
 if(m.foreignKeysOff)database.pragma('foreign_keys=OFF');
 database.transaction(()=>{typeof m.up==='function'?m.up(database):database.exec(m.up);m.afterUp?.(database);})();
 if(m.foreignKeysOff)database.pragma('foreign_keys=ON');
}}
test.beforeEach(()=>{
 d=new Database(':memory:');d.pragma('foreign_keys=ON');migrate(d);_setTestDatabase(d);
 const insert=d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)");
 admin=Number(insert.run('parent','Parent','admin','parent').lastInsertRowid);
 learner=Number(insert.run('child','Child','member','child').lastInsertRowid);
 helper=Number(insert.run('helper','Helper','member','parent').lastInsertRowid);
 d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(learner);
 d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});
const read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const count=(sql,...args)=>d.prepare(sql).get(...args).n;
function task(title,parent=null,optional=false,points=0){return Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,is_optional,points,start_date,start_time,due_date,due_time)
 VALUES(?,?,?,?,?,?,'2026-09-14','07:00','2026-09-14','08:00')`).run(title,admin,parent?null:learner,parent,optional?1:0,points).lastInsertRowid);}
function transition(id,status='done',actor=learner,body={}){return changeTaskStatus(d,id,status,{actorId:actor,requireRevision:false,body,now});}
function skill(name,learnerLevel='supervised',helperLevel='normal'){
 const id=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(name,admin).lastInsertRowid);
 for(const [user,level] of [[learner,learnerLevel],[helper,helperLevel],[admin,'excluded']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(user,id,level,admin);
 return id;
}

test('nine required steps finish the recurring parent once while optional work remains incomplete',()=>{
 const root=task('Morning',null,false,2);
 d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=DAILY',expiration_policy='expire_incomplete' WHERE id=?").run(root);
 const required=Array.from({length:9},(_,i)=>task(`Required ${i+1}`,root));
 const optional=task('Optional hair care',root,true);
 for(const id of required)transition(id);
 assert.equal(read(root).status,'done');assert.equal(read(optional).status,'open');
 assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",root),1);
 assert.equal(d.prepare('SELECT delta FROM reward_ledger WHERE task_id=?').get(root).delta,2);
 const successors=()=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(root);
 assert.equal(successors().length,1);assert.ok(successors()[0].due_date>read(root).due_date);
 assert.equal(successors()[0].start_time,'07:00');assert.equal(successors()[0].due_time,'08:00');
 assert.equal(d.prepare('SELECT SUM(is_optional) n FROM tasks WHERE parent_task_id=?').get(successors()[0].id).n,1);
 transition(root);
 assert.throws(()=>transition(optional),error=>error.details?.reason==='optional_parent_completed');
 assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",root),1);
 assert.equal(successors().length,1);
});

test('bulk completion skips optional branches and their independent points',()=>{
 const root=task('Morning',null,false,2),required=task('Required',root),optional=task('Optional',root,true,5),nested=task('Optional branch child',optional);
 transition(root,'done',learner,{complete_remaining:true});
 assert.equal(read(required).status,'done');assert.equal(read(optional).status,'open');assert.equal(read(nested).status,'open');
 assert.equal(count('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?',optional),0);
 assert.equal(d.prepare('SELECT SUM(delta) n FROM reward_ledger').get().n,2);
 assert.throws(()=>transition(nested),error=>error.details?.reason==='optional_parent_completed');
});

test('completed optional progress is retained and all-optional parents need explicit completion',()=>{
 const root=task('Only optional',null,false,2),first=task('First',root,true),second=task('Second',root,true);
 transition(first);assert.equal(read(root).status,'in_progress');
 transition(root);assert.equal(read(root).status,'done');assert.equal(read(first).status,'done');assert.equal(read(second).status,'open');
});

test('standalone optional action controls close with the parent and return after explicit reopening',()=>{
 const root=task('Parent'),required=task('Required',root),optional=task('Optional group',root,true),nested=task('Nested optional action',optional);
 transition(required);
 withTaskReadProjection(d,admin,()=>{
  for(const id of [optional,nested]){
   assert.equal(attachTaskCapabilities(d,admin,[read(id)])[0].permissions.complete,false);
   assert.equal(taskCapabilities(d,admin,read(id)).complete,true,'presentation does not change the stored authorization snapshot');
  }
  assert.equal(attachTaskCapabilities(d,admin,[read(required)])[0].permissions.complete,true,'required action behavior remains unchanged');
 });
 assert.throws(()=>transition(nested),error=>error.details?.reason==='optional_parent_completed');
 transition(root,'in_progress',admin);
 for(const id of [optional,nested])assert.equal(attachTaskCapabilities(d,admin,[read(id)])[0].permissions.complete,true);
});

test('optional work requires explicit parent reopening and does not replace an existing successor',()=>{
 const root=task('Morning',null,false,2),required=task('Required',root),optional=task('Optional',root,true);
 d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=DAILY' WHERE id=?").run(root);
 transition(required);
 const successor=d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root).id;
 assert.throws(()=>transition(optional),error=>error.details?.reason==='optional_parent_completed');
 transition(root,'in_progress',admin);assert.equal(read(required).status,'done');
 assert.ok(read(successor),'explicit optional reopening retains the anchored successor');
 transition(optional);assert.equal(read(root).status,'done');assert.equal(read(optional).status,'done');
 assert.deepEqual(d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(root),[{id:successor}]);
 assert.equal(d.prepare('SELECT SUM(delta) n FROM reward_ledger WHERE task_id=?').get(root).n,2);
});

test('confirmed reset can reset completed optional descendants without weakening direct action guards',()=>{
 const root=task('Parent'),group=task('Group',root),required=task('Required',group),optional=task('Optional',group,true);
 transition(optional);transition(required);assert.equal(read(root).status,'done');
 assert.throws(()=>transition(optional,'open',admin),error=>error.details?.reason==='optional_parent_completed');
 transition(root,'open',admin,{reset_progress:true});
 for(const id of [root,group,required,optional])assert.equal(read(id).status,'open');
});

test('unresolved optional supervision cannot block required completion and closes after the parent completes',()=>{
 const root=task('Parent',null,false,2),required=task('Required',root),optional=task('Optional skill',root,true);
 setTaskSkills(d,optional,[skill('No qualified helper','supervised','excluded')]);
 const view=reconcileTaskSupervision(d,root),action=view.actions.find(action=>action.action_task_id===optional);
 assert.equal(action.state,'unresolved');assert.equal(action.is_optional,true);
 assert.throws(()=>transition(optional),error=>error.code==='supervision_required');
 transition(required);
 assert.equal(read(root).status,'done');assert.equal(read(optional).status,'open');
 const closed=inspectTaskSupervision(d,root).actions.find(action=>action.action_task_id===optional);
 assert.equal(closed.state,'not_required');assert.equal(closed.closed_optional,true);
 const presented=attachTaskSupervision(d,[read(action.counterpart_task_id)],admin)[0];
 assert.equal(presented.supervision_action.can_complete,false);
 assert.equal(attachTaskCapabilities(d,admin,[presented])[0].permissions.complete,false);
 assert.ok(read(action.counterpart_task_id).archived_at);assert.notEqual(read(action.counterpart_task_id).status,'done');
 assert.equal(count("SELECT COUNT(*) n FROM planning_obligations WHERE task_id=? AND status IN ('pending','accepted')",root),0);
 assert.throws(()=>transition(action.counterpart_task_id,'done',admin),error=>error.details?.reason==='optional_parent_completed');
 assert.equal(count('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?',root),1);
 const version=d.prepare('SELECT version FROM task_change_clock').get().version;
 reconcileTaskSupervision(d,root);inspectTaskSupervision(d,root);
 assert.equal(d.prepare('SELECT version FROM task_change_clock').get().version,version,'closed optional reconciliation is idempotent');
});

test('an impossible optional skill does not invalidate the supervisor of required work',()=>{
 const root=task('Parent',null,false,2),required=task('Supervised required',root),optional=task('Unavailable optional',root,true);
 setTaskSkills(d,required,[skill('Required skill')]);setTaskSkills(d,optional,[skill('Optional skill','supervised','excluded')]);
 const view=reconcileTaskSupervision(d,root),requiredAction=view.actions.find(action=>action.action_task_id===required);
 assert.equal(requiredAction.state,'assigned');assert.equal(requiredAction.supervisor_user_id,helper);
 assert.equal(view.actions.find(action=>action.action_task_id===optional).state,'unresolved');
 transition(requiredAction.counterpart_task_id,'done',helper);
 assert.equal(read(required).status,'done');assert.equal(read(root).status,'done');assert.equal(read(optional).status,'open');
 assert.equal(d.prepare('SELECT SUM(delta) n FROM reward_ledger WHERE task_id=?').get(root).n,2);
});

test('optional delegated work still requires the qualified helper when performed',()=>{
 const root=task('Parent',null,false,2),required=task('Required',root),optional=task('Delegated optional',root,true);
 setTaskSkills(d,optional,[skill('Delegated skill','excluded','normal')]);
 const view=reconcileTaskSupervision(d,root),action=view.actions.find(action=>action.action_task_id===optional);
 assert.equal(action.execution_mode,'delegated');assert.equal(action.supervisor_user_id,helper);
 assert.throws(()=>transition(optional),error=>error.code==='supervision_required');
 transition(action.counterpart_task_id,'done',helper);assert.equal(read(optional).status,'done');assert.notEqual(read(root).status,'done');
 transition(required);assert.equal(read(root).status,'done');
 assert.equal(count('SELECT COUNT(*) n FROM reward_ledger WHERE user_id=?',helper),0);
});

test('expiration retires incomplete required and optional work while preserving completed optional history',()=>{
 const root=task('Morning',null,false,2),required=task('Required',root),optional=task('Unfinished optional',root,true),finished=task('Finished optional',root,true);
 d.prepare("UPDATE tasks SET expiration_policy='expire_incomplete' WHERE id=?").run(root);
 transition(finished);
 assert.equal(expireTask(d,root,{now:new Date('2026-09-14T12:00:00Z')}).expired,true);
 for(const id of [root,required,optional])assert.equal(read(id).status,'expired');
 assert.equal(read(finished).status,'done');assert.equal(count('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?',root),0);
 assert.equal(expireTask(d,root,{now:new Date('2026-09-14T12:00:01Z')}).expired,false);
 assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'",root),1);
});

test('migration10036 is additive, required by default, and optional changes invalidate parent/client revisions',()=>{
 const legacy=new Database(':memory:');migrate(legacy,10035);
 legacy.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'legacy','Legacy','x','admin')").run();
 legacy.prepare("INSERT INTO tasks(id,title,created_by) VALUES(1,'Parent',1)").run();
 legacy.prepare("INSERT INTO tasks(id,title,created_by,parent_task_id) VALUES(2,'Child',1,1)").run();
 const before=legacy.prepare('SELECT * FROM tasks ORDER BY id').all();
 const migration=ALL_MIGRATIONS.find(m=>m.version===10036);legacy.transaction(()=>legacy.exec(migration.up))();
 for(const row of before){const after=legacy.prepare('SELECT * FROM tasks WHERE id=?').get(row.id);for(const [key,value] of Object.entries(row))assert.deepEqual(after[key],value);assert.equal(after.is_optional,0);}
 const parentRevision=legacy.prepare('SELECT revision FROM tasks WHERE id=1').get().revision;
 const clock=legacy.prepare('SELECT version FROM task_change_clock').get().version;
 legacy.prepare('UPDATE tasks SET is_optional=1 WHERE id=2').run();
 assert.ok(legacy.prepare('SELECT revision FROM tasks WHERE id=1').get().revision>parentRevision);
 assert.ok(legacy.prepare('SELECT version FROM task_change_clock').get().version>clock);
 assert.throws(()=>legacy.prepare('UPDATE tasks SET is_optional=2 WHERE id=2').run(),/CHECK/);
 assert.deepEqual(legacy.pragma('foreign_key_check'),[]);assert.equal(legacy.pragma('integrity_check',{simple:true}),'ok');legacy.close();
});

test('explicit allowed assignee override persists with the binding and obeys current template permissions',()=>{
 const template=Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,allow_assignment_override,presence_policy,subject_required,created_by)
 VALUES('Morning','Morning','fixed','fixed',?,1,'ignore',0,?)`).run(learner,admin).lastInsertRowid);
 const root=task('Morning');applyTaskActivityBinding(d,root,{activityTemplateId:template});
 overrideTaskAssignment(d,root,helper,admin);
 assert.equal(read(root).assigned_to,helper);
 assert.equal(d.prepare('SELECT assignment_override_user_id FROM task_activity_bindings WHERE task_id=?').get(root).assignment_override_user_id,helper);
 d.prepare('UPDATE activity_templates SET allow_assignment_override=0 WHERE id=?').run(template);
 assert.equal(d.prepare('SELECT override_allowed FROM task_assignment_context WHERE task_id=?').get(root).override_allowed,1,'the old context remains a historical snapshot');
 const before=d.prepare('SELECT COUNT(*) n FROM planning_obligations').get().n;
 assert.throws(()=>overrideTaskAssignment(d,root,learner,admin),/overrides are disabled/);
 assert.equal(read(root).assigned_to,helper);assert.equal(d.prepare('SELECT COUNT(*) n FROM planning_obligations').get().n,before);
});
