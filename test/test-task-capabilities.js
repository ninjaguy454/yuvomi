import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { resolvePermissions, replaceSubjectPermissions, getSubjectPermissions, hasCapability } from '../server/permissions.js';
import { RESTRICTED_MEMBER_CAPABILITIES } from '../server/task-capabilities.js';
import { assertTaskMutation, taskCapabilities, taskVisibilityWhere } from '../server/services/task-access.js';
import { callTool } from '../server/mcp/tools.js';
import { setPermissions, clearPermissions } from '../public/permissions.js';
import { findSettingsLeaf } from '../public/settings/registry.js';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'task-capability-test-secret';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
const { default: readerRouter } = await import('../server/routes/reader.js');
const { default: permissionsRouter } = await import('../server/routes/permissions.js');
const { default: planningRouter } = await import('../server/routes/planning.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { default: remindersRouter } = await import('../server/routes/reminders.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: preferencesRouter } = await import('../server/routes/preferences.js');
const d = new Database(':memory:');
d.pragma('foreign_keys = ON');
d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT 'test')");
for (const migration of ALL_MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
  migration.afterUp?.(d);
  d.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)').run(migration.version,migration.description);
}
_setTestDatabase(d);
const user = (name, role = 'member') => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES (?,?, 'x',?,'child')").run(name,name,role).lastInsertRowid);
const admin = user('Admin','admin'), learner = user('Learner'), other = user('Other'), supervisor = user('Supervisor');
const seed = ({ title = 'Task', creator = admin, assigned = learner, parent = null, visibility = 'all' } = {}) => {
  const id = Number(d.prepare('INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,visibility) VALUES (?,?,?,?,?)').run(title,creator,assigned,parent,visibility).lastInsertRowid);
  if (assigned) d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES (?,?)').run(id,assigned);
  return d.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
};
const own = seed({title:'Learner laundry'}), theirs = seed({title:'Other laundry', assigned:other}), child = seed({title:'Load washer', assigned:null,parent:own.id});
let actor = learner;
const app = express();
app.use(express.json()); app.use(express.urlencoded({extended:false}));
app.use((req,_res,next) => { req.authUserId=actor; req.authRole=actor===admin?'admin':'member'; req.session={userId:actor,role:req.authRole,csrfToken:'capability-csrf'}; next(); });
app.use('/api/v1/tasks',tasksRouter); app.use('/api/v1/automation',automationRouter);
app.use('/api/v1/permissions',permissionsRouter); app.use('/api/v1/planning',planningRouter);
app.use('/api/v1/housekeeping',housekeepingRouter); app.use('/reader',readerRouter);
app.use('/api/v1/reminders',remindersRouter);
app.use('/api/v1/rewards',rewardsRouter);
app.use('/api/v1/meals',mealsRouter);
app.use('/api/v1/preferences',preferencesRouter);
const server=http.createServer(app); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{clearPermissions();server.close();d.close();});
test.beforeEach(()=>{d.prepare('DELETE FROM access_capabilities').run();d.prepare('DELETE FROM access_permissions').run();actor=learner;});
const configure=(capabilities,modules={})=>replaceSubjectPermissions(d,'user',learner,{modules,capabilities});
const restricted=()=>configure(RESTRICTED_MEMBER_CAPABILITIES);
async function request(method,path,body,as=learner){actor=as;const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,data};}

test('existing members keep Task rights; management remains denied by default',()=>{assert.equal(hasCapability(d,learner,'tasks.edit_others'),true);assert.equal(hasCapability(d,learner,'skills.manage'),false);assert.equal(hasCapability(d,learner,'availability.manage_own'),true);});
test('family role is a configurable profile, not an automatic child restriction',()=>{replaceSubjectPermissions(d,'role','child',{capabilities:{'tasks.create':'none'}});assert.equal(hasCapability(d,learner,'tasks.create'),false);assert.equal(hasCapability(d,other,'tasks.create'),false);});
test('explicit member allow overrides role deny and reset restores inheritance',()=>{replaceSubjectPermissions(d,'role','child',{capabilities:{'tasks.create':'none'}});configure({'tasks.create':'allow'});assert.equal(hasCapability(d,learner,'tasks.create'),true);configure({});assert.equal(hasCapability(d,learner,'tasks.create'),false);});
test('member module write can override role module none',()=>{replaceSubjectPermissions(d,'role','child',{modules:{tasks:'none'}});configure({}, {tasks:'write'});assert.equal(hasCapability(d,learner,'tasks.complete_own'),true);});
test('legacy rights PUT without capability field preserves configured capabilities',()=>{configure({'tasks.create':'none'});replaceSubjectPermissions(d,'user',learner,{modules:{calendar:'read'}});assert.equal(hasCapability(d,learner,'tasks.create'),false);});
test('module read and none cap granular allows',()=>{configure({'tasks.complete_own':'allow'},{tasks:'read'});assert.equal(taskCapabilities(d,learner,own).complete,false);configure({'tasks.view_own':'allow'},{tasks:'none'});assert.equal(taskCapabilities(d,learner,own).view,false);});
test('administrators bypass capability restrictions without bypassing private visibility',()=>{replaceSubjectPermissions(d,'role','child',{capabilities:RESTRICTED_MEMBER_CAPABILITIES});assert.equal(hasCapability(d,admin,'tasks.create'),true);const privateTask=seed({creator:other,assigned:other,visibility:'private'});assert.equal(taskCapabilities(d,admin,privateTask).view,false);});
test('participant can operate own Task and inherited child but cannot edit definitions',()=>{restricted();assert.equal(taskCapabilities(d,learner,own).complete,true);assert.equal(taskCapabilities(d,learner,child).complete,true);assert.equal(taskCapabilities(d,learner,child).edit,false);assert.doesNotThrow(()=>assertTaskMutation(d,learner,child,{status:'done'},{operation:'status'}));assert.throws(()=>assertTaskMutation(d,learner,child,{skill_ids:[1]}),{status:403});});
test('own-only SQL and per-row capabilities agree and hide another member',()=>{restricted();const rows=d.prepare(`SELECT t.* FROM tasks t WHERE ${taskVisibilityWhere(d,learner,'t','@me')}`).all({me:learner});assert.ok(rows.some(row=>row.id===own.id));assert.ok(rows.some(row=>row.id===child.id));assert.ok(!rows.some(row=>row.id===theirs.id));for(const row of rows)assert.equal(taskCapabilities(d,learner,row).view,true);});
test('explicitly assigned sibling does not inherit learner completion permission',()=>{restricted();const sibling=seed({parent:own.id,assigned:other});assert.equal(taskCapabilities(d,learner,sibling).complete,false);});
test('private subtask remains private even under an owned parent',()=>{restricted();const hidden=seed({parent:own.id,assigned:null,creator:other,visibility:'private'});assert.equal(taskCapabilities(d,learner,hidden).view,false);});
test('unchanged protected fields do not prevent allowed status-only changes',()=>{configure({'tasks.change_priority':'none','tasks.change_points':'none','tasks.change_dates':'none'});assert.doesNotThrow(()=>assertTaskMutation(d,learner,own,{priority:own.priority,points:own.points,due_date:own.due_date,status:'in_progress'}));});
for(const [field,value,capability] of [['priority','urgent','change_priority'],['points',50,'change_points'],['category','school','change_category_tags'],['due_date','2027-02-01','change_dates'],['assigned_to',[other],'change_assignment'],['skill_ids',[],'change_required_skills']]) {
  test(`denied ${capability} rejects effective ${field} changes`,()=>{configure({[`tasks.${capability}`]:'none'});if(field==='skill_ids'){const id=Number(d.prepare("INSERT INTO skills(name) VALUES ('Permission skill')").run().lastInsertRowid);d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES (?,?,0)').run(own.id,id);}assert.throws(()=>assertTaskMutation(d,learner,own,{[field]:value}),{status:403});});
}
test('REST creation denial cannot be bypassed by compatibility MCP create',async()=>{restricted();assert.equal((await request('POST','/api/v1/tasks',{title:'Bypass'})).status,403);await assert.rejects(()=>callTool({db:d,actor:{id:learner,role:'member'}},'create_task',{title:'Bypass'}),{status:403});});
test('Reader creation denial is server-enforced',async()=>{restricted();assert.equal((await request('POST','/reader/tasks',{csrf:'capability-csrf',title:'Reader bypass'})).status,403);assert.equal((await request('GET','/reader?view=add-task')).status,403);});
test('MCP and Reader lists respect own-only visibility',async()=>{restricted();const rows=await callTool({db:d,actor:{id:learner,role:'member'}},'list_tasks',{});assert.ok(rows.some(row=>row.id===own.id));assert.ok(!rows.some(row=>row.id===theirs.id));const reader=await request('GET','/reader?view=tasks');assert.equal(reader.status,200);assert.match(reader.data,/Learner laundry/);assert.doesNotMatch(reader.data,/Other laundry/);});
test('REST household Task and child detail IDs do not bypass own-only scope',async()=>{restricted();assert.equal((await request('GET',`/api/v1/tasks/${theirs.id}`)).status,404);assert.equal((await request('PATCH',`/api/v1/tasks/${theirs.id}/status`,{status:'done'})).status,404);assert.equal((await request('PUT',`/api/v1/tasks/${own.id}`,{points:50})).status,403);assert.equal((await request('DELETE',`/api/v1/tasks/${own.id}`)).status,403);});
test('workflow runtime endpoints enforce configured view/run/create separately',async()=>{restricted();assert.equal((await request('GET','/api/v1/automation/quick-add')).status,403);configure({'workflows.run':'none'});assert.equal((await request('POST','/api/v1/automation/quick-add/1/create',{})).status,403);});
test('claim compatibility endpoint respects claim capability',async()=>{configure({'tasks.claim':'none'});assert.equal((await request('POST',`/api/v1/automation/tasks/${own.id}/claim`,{})).status,403);});
test('restricted member cannot edit skills or elevate their own permissions',async()=>{restricted();assert.equal((await request('POST','/api/v1/automation/admin/skills',{name:'Bypass'})).status,403);assert.equal((await request('PUT',`/api/v1/permissions/user/${learner}`,{capabilities:{'tasks.create':'allow'}})).status,403);});
test('delegated Skill manager can create skills but cannot access permissions',async()=>{configure({'skills.manage':'allow'});assert.equal((await request('POST','/api/v1/automation/admin/skills',{name:'Delegated skill'})).status,201);assert.equal((await request('GET','/api/v1/permissions/catalog')).status,403);});
test('administration capabilities cannot be granted to nonadmins',()=>{assert.throws(()=>configure({'admin.permissions':'allow'}),/administrator-only/);assert.equal(hasCapability(d,learner,'admin.permissions'),false);});
test('restricted member cannot create own routine through retained Schedule API',async()=>{restricted();assert.equal((await request('POST','/api/v1/planning/routines/patterns',{name:'Bypass',user_id:learner,anchor_date:'2027-01-01',cycle_length:7})).status,403);});
test('capability configuration validates unknown keys and preserves previous rights atomically',()=>{configure({'tasks.create':'none'});assert.throws(()=>configure({'tasks.nonexistent':'allow'}),/Unknown/);assert.equal(getSubjectPermissions(d,'user',learner).capabilities['tasks.create'],'none');});
test('assigned supervisor owns the linked action but not independent learner work',()=>{
  replaceSubjectPermissions(d,'user',supervisor,{capabilities:RESTRICTED_MEMBER_CAPABILITIES});
  const action=seed({parent:own.id,assigned:null}), independent=seed({parent:own.id,assigned:null});
  const support=seed({parent:own.id,assigned:supervisor}), counterpart=seed({parent:support.id,assigned:supervisor});
  d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state) VALUES (?,?,?,?,?,'assigned')").run(own.id,action.id,counterpart.id,learner,supervisor);
  d.prepare("INSERT INTO task_responsibilities(task_id,user_id,role,status,source) VALUES (?,?,'supervisor','active','supervision')").run(own.id,supervisor);
  assert.equal(taskCapabilities(d,supervisor,action).complete,true);
  assert.equal(taskCapabilities(d,supervisor,counterpart).complete,true);
  assert.equal(taskCapabilities(d,supervisor,own).view,true);
  assert.equal(taskCapabilities(d,supervisor,independent).complete,false);
  const visible=d.prepare(`SELECT t.id FROM tasks t WHERE ${taskVisibilityWhere(d,supervisor,'t','@me')}`).all({me:supervisor});
  assert.ok(visible.some(row=>row.id===own.id));assert.ok(visible.some(row=>row.id===action.id));
  d.prepare("UPDATE task_supervision_actions SET state='unresolved', supervisor_user_id=NULL WHERE action_task_id=?").run(action.id);
  assert.equal(taskCapabilities(d,supervisor,action).complete,false);
});
test('stale compatibility claim revision is rejected before domain mutation',async()=>{
  const revision=d.prepare('SELECT revision FROM tasks WHERE id=?').get(own.id).revision;
  d.prepare("UPDATE tasks SET description='Changed elsewhere' WHERE id=?").run(own.id);
  const response=await request('POST',`/api/v1/automation/tasks/${own.id}/claim`,{expected_revision:revision});
  assert.equal(response.status,409);assert.match(response.data.error,/changed on another device/);
});
test('Task tag/category compatibility mutations cannot bypass field capabilities',async()=>{
  configure({'tasks.change_category_tags':'none'});
  assert.equal((await request('POST','/api/v1/tasks/tags/apply',{ids:[own.id],add:['bypass']})).status,403);
  assert.equal((await request('POST','/api/v1/tasks/categories',{name:'Bypass category'})).status,403);
});
test('linked Housekeeping payment cannot bypass Task completion or deletion restrictions',async()=>{
  configure({'tasks.complete_own':'none','tasks.delete_archive':'none'});
  const session=Number(d.prepare("INSERT INTO housekeeping_work_sessions(check_in,daily_rate,created_by,payment_task_id) VALUES ('2027-01-01T09:00:00Z',10,?,?)").run(admin,own.id).lastInsertRowid);
  assert.equal((await request('POST',`/api/v1/housekeeping/visits/${session}/pay`,{})).status,403);
  assert.equal((await request('DELETE',`/api/v1/housekeeping/visits/${session}`)).status,403);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(own.id).status,'open');
});

test('previously configured reminder cannot disclose a Task after own-only permissions change',async()=>{
  const hidden=seed({title:'Private household reminder',assigned:other});
  d.prepare("INSERT INTO reminders(entity_type,entity_id,remind_at,created_by) VALUES ('task',?,'2000-01-01T00:00:00Z',?)").run(hidden.id,learner);
  restricted();
  const response=await request('GET','/api/v1/reminders/pending');
  assert.equal(response.status,200);
  assert.equal(response.data.data.some(row=>row.entity_type==='task' && row.entity_id===hidden.id),false);
});

test('legacy self-claim cannot bypass a denied claim capability or change another assignee',()=>{
  const task=seed({assigned:other});
  configure({'tasks.claim':'none'});
  assert.throws(()=>assertTaskMutation(d,learner,task,{assigned_to:[other,learner]}),{status:403});
  configure({'tasks.claim':'allow','tasks.change_assignment':'none','tasks.reassign':'none'});
  assert.doesNotThrow(()=>assertTaskMutation(d,learner,task,{assigned_to:[other,learner]}));
  assert.throws(()=>assertTaskMutation(d,learner,task,{assigned_to:[learner]}),{status:403});
});

test('delegated Skills manager can reach the canonical manager without administrative settings',()=>{
  configure({'skills.manage':'allow','activities.view':'none','workflows.view':'none'});
  setPermissions(resolvePermissions(d,d.prepare('SELECT * FROM users WHERE id=?').get(learner)));
  assert.ok(findSettingsLeaf('/settings/modules/automation',{role:'member'}));
  assert.equal(findSettingsLeaf('/settings/admin/permissions',{role:'member'}),null);
});

test('participant Settings retains personal appearance and excludes blocked automation',()=>{
  restricted();
  setPermissions(resolvePermissions(d,d.prepare('SELECT * FROM users WHERE id=?').get(learner)));
  assert.ok(findSettingsLeaf('/settings/personal/appearance',{role:'member'}));
  assert.equal(findSettingsLeaf('/settings/modules/automation',{role:'member'}),null);
});

test('Trip list and itinerary do not reveal other members Tasks through linked projections',async()=>{
  const trip=Number(d.prepare("INSERT INTO trip_plans(name,starts_at,ends_at,created_by) VALUES ('Permission trip','2027-01-01T09:00:00Z','2027-01-03T18:00:00Z',?)").run(admin).lastInsertRowid);
  const hidden=seed({title:'Other member packing',assigned:other});
  d.prepare("INSERT INTO trip_tasks(trip_id,task_id,phase) VALUES (?,?,'before_departure')").run(trip,hidden.id);
  restricted();
  const list=await request('GET','/api/v1/planning/trips');
  assert.equal(list.status,200);assert.deepEqual(list.data.data.find(row=>row.id===trip).tasks,[]);
  const itinerary=await request('GET',`/api/v1/planning/trips/${trip}/itinerary`);
  assert.equal(itinerary.status,200);assert.deepEqual(itinerary.data.data.trip.tasks,[]);
  for(const day of Object.values(itinerary.data.data.days))assert.deepEqual(day.tasks,[]);
});

test('Rewards keeps earned amounts while hiding inaccessible Task title snapshots',async()=>{
  const hidden=seed({title:'Hidden earned work',assigned:other});
  const ledger=Number(d.prepare("INSERT INTO reward_ledger(user_id,delta,type,reason,task_id,created_by) VALUES (?,5,'earn',?,?,?)").run(other,hidden.title,hidden.id,admin).lastInsertRowid);
  restricted();
  const response=await request('GET','/api/v1/rewards/ledger');
  assert.equal(response.status,200);
  const row=response.data.data.find(item=>item.id===ledger);
  assert.equal(row.delta,5);assert.equal(row.reason,null);assert.equal(row.task_id,null);
});

test('stale obligation ownership does not disclose or authorize an inaccessible Task',async()=>{
  const hidden=seed({title:'Hidden requested work',assigned:other});
  const obligation=Number(d.prepare("INSERT INTO planning_obligations(entity_type,entity_id,logical_key,role,responsible_user_id,task_id) VALUES ('task',?,'permission-stale-obligation','supervisor',?,?)").run(hidden.id,learner,hidden.id).lastInsertRowid);
  restricted();
  const inbox=await request('GET','/api/v1/automation/obligations');
  assert.equal(inbox.status,200);assert.equal(inbox.data.data.some(row=>row.id===obligation),false);
  assert.equal((await request('POST',`/api/v1/automation/obligations/${obligation}/respond`,{action:'accept'})).status,404);
});

test('shared Wall visibility permits public Tasks while rejecting malformed signed-in actors',()=>{
  const publicPredicate=taskVisibilityWhere(d,null,'t','@me');
  assert.ok(d.prepare(`SELECT t.id FROM tasks t WHERE ${publicPredicate}`).all({me:0}).some(row=>row.id===own.id));
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${taskVisibilityWhere(d,{},'t','@me')}`).get({me:0}).n,0);
});

test('explicit Meal Task creation cannot bypass Task create denial',async()=>{
  restricted();
  assert.equal((await request('POST','/api/v1/meals/1/execution-tasks',{})).status,403);
  assert.equal((await request('POST','/api/v1/meals/execution/prepare',{from:'2027-01-01',to:'2027-01-02'})).status,403);
});

test('Meal execution projection hides another member Task snapshot',async()=>{
  const meal=Number(d.prepare("INSERT INTO meals(date,meal_type,title,created_by) VALUES ('2027-01-01','dinner','Permission dinner',?)").run(admin).lastInsertRowid);
  const hidden=seed({title:'Hidden dinner cleanup',assigned:other});
  const snapshot=Number(d.prepare("INSERT INTO meal_execution_snapshots(logical_key,meal_id,source_fingerprint,meal_date_snapshot,meal_type_snapshot,meal_title_snapshot,snapshot_json,created_by) VALUES ('permission-meal',?,'test','2027-01-01','dinner','Permission dinner','{}',?)").run(meal,admin).lastInsertRowid);
  d.prepare("INSERT INTO meal_execution_tasks(meal_snapshot_id,meal_id,role,logical_key,task_id,title_snapshot) VALUES (?,?,'cleanup','permission-meal-cleanup',?,?)").run(snapshot,meal,hidden.id,hidden.title);
  restricted();
  const response=await request('GET',`/api/v1/meals/${meal}/execution`);
  assert.equal(response.status,200);assert.deepEqual(response.data.data.tasks,[]);
});

test('public child status response does not disclose its private parent',async()=>{
  const parent=seed({title:'Secret parent instructions',creator:other,assigned:other,visibility:'private'});
  const visible=seed({title:'Public child',creator:other,assigned:learner,parent:parent.id});
  const response=await request('PATCH',`/api/v1/tasks/${visible.id}/status`,{status:'done'});
  assert.equal(response.status,200);assert.equal(response.data.data.parent_task,undefined);
  assert.equal(JSON.stringify(response.data).includes(parent.title),false);
});

test('blocked status and legacy update omit private dependency titles and IDs',async()=>{
  const privateTask=seed({title:'Secret prerequisite',creator:other,assigned:other,visibility:'private'});
  const dependent=seed({title:'Public dependent'});
  d.prepare('INSERT INTO workflow_task_dependencies(task_id,depends_on_task_id) VALUES (?,?)').run(dependent.id,privateTask.id);
  for(const [method,path] of [['PATCH',`/api/v1/tasks/${dependent.id}/status`],['PUT',`/api/v1/tasks/${dependent.id}`]]){
    const response=await request(method,path,{status:'done'});
    assert.equal(response.status,409);assert.deepEqual(response.data.dependencies,[]);
    assert.equal(JSON.stringify(response.data).includes(privateTask.title),false);
  }
});

test('supervision denial explains the visible action without disclosing a private sibling',async()=>{
  const parent=seed({title:'Supervised parent'});
  const visible=seed({title:'Visible supervised action',parent:parent.id,assigned:null});
  const hidden=seed({title:'Secret supervised action',parent:parent.id,creator:other,assigned:null,visibility:'private'});
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion) VALUES ('Permission supervised skill',0,'normal')").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES (?,?,'supervised','manual',?)").run(learner,skill,admin);
  for(const action of [visible,hidden])d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES (?,?,0)').run(action.id,skill);
  const response=await request('PATCH',`/api/v1/tasks/${visible.id}/status`,{status:'done'});
  assert.equal(response.status,409);assert.ok(response.data.supervision.actions.some(action=>action.action_task_id===visible.id));
  assert.equal(response.data.supervision.actions.some(action=>action.action_task_id===hidden.id),false);
  assert.equal(JSON.stringify(response.data).includes(hidden.title),false);
});

test('generated supervision projections cannot be independently edited, archived, deleted or claimed',async()=>{
  const source=seed({title:'Projection source'}),action=seed({title:'Projection action',parent:source.id,assigned:null});
  const support=seed({title:'Projection container',parent:source.id,assigned:supervisor});
  const counterpart=seed({title:'Projection counterpart',parent:support.id,assigned:supervisor});
  d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES (?,?)').run(source.id,support.id);
  d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state) VALUES (?,?,?,?,?,'assigned')").run(source.id,action.id,counterpart.id,learner,supervisor);
  for(const row of [support,counterpart]) {
    const c=taskCapabilities(d,admin,row);assert.equal(c.view,true);assert.equal(c.complete,true);assert.equal(c.comment,true);
    for(const key of ['edit','delete_archive','claim','reassign','change_assignment','change_required_skills'])assert.equal(c[key],false,key);
    assert.equal((await request('PUT',`/api/v1/tasks/${row.id}`,{title:'Disconnected'},admin)).status,403);
    assert.equal((await request('DELETE',`/api/v1/tasks/${row.id}`,undefined,admin)).status,403);
  }
});

test('a counterpart inherits its private source action visibility',()=>{
  const source=seed({title:'Public source'}),privateAction=seed({title:'Private projected title',parent:source.id,creator:other,assigned:null,visibility:'private'});
  const counterpart=seed({title:privateAction.title,assigned:supervisor});
  d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state) VALUES (?,?,?,?,?,'assigned')").run(source.id,privateAction.id,counterpart.id,learner,supervisor);
  assert.equal(taskCapabilities(d,supervisor,counterpart).view,false);
  const rows=d.prepare(`SELECT t.id FROM tasks t WHERE ${taskVisibilityWhere(d,supervisor,'t','@me')}`).all({me:supervisor});
  assert.equal(rows.some(row=>row.id===counterpart.id),false);
});

test('restricted personal appearance cannot alter shared household date/time formats',async()=>{
  restricted();
  for(const body of [{date_format:'mdy'},{time_format:'12h'},{week_start:'sunday'}])
    assert.equal((await request('PUT','/api/v1/preferences',body)).status,403);
  assert.equal((await request('PUT','/api/v1/preferences',{color_theme:'warm',heading_font:'serif'})).status,200);
});

test('parent bulk completion cannot bypass a supervised grandchild',async()=>{
  const source=seed({title:'Nested supervised Task'}),child=seed({title:'Nested child',parent:source.id,assigned:null});
  const leaf=seed({title:'Supervised grandchild',parent:child.id,assigned:learner});
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion) VALUES ('Nested supervised skill',0,'normal')").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES (?,?,'supervised','manual',?)").run(learner,skill,admin);
  d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES (?,?,0)').run(leaf.id,skill);
  const response=await request('PATCH',`/api/v1/tasks/${source.id}/status`,{status:'done',complete_remaining:true});
  assert.equal(response.status,409);assert.match(response.data.error,/supervis/i);
  for(const row of [source,child,leaf])assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(row.id).status,'open');
});

test('unassigned supervision work does not inherit learner responsibility from its source',()=>{
  const source=seed({title:'Learner source'}),action=seed({title:'Learner action',parent:source.id,assigned:null});
  const support=seed({title:'Unresolved helper',parent:source.id,assigned:null});
  const counterpart=seed({title:'Unresolved helper action',parent:support.id,assigned:null});
  d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES (?,?)').run(source.id,support.id);
  d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,state) VALUES (?,?,?,?,'unresolved')").run(source.id,action.id,counterpart.id,learner);
  restricted();
  const rows=d.prepare(`SELECT t.id FROM tasks t WHERE ${taskVisibilityWhere(d,learner,'t','@me')}`).all({me:learner});
  for(const projection of [support,counterpart]) {
    assert.equal(taskCapabilities(d,learner,projection).own,false);
    assert.equal(taskCapabilities(d,learner,projection).view,false);
    assert.equal(taskCapabilities(d,learner,projection).complete,false);
    assert.equal(rows.some(row=>row.id===projection.id),false);
  }
  assert.equal(taskCapabilities(d,learner,source).view,true);
  assert.equal(taskCapabilities(d,learner,action).own,true);
  replaceSubjectPermissions(d,'user',supervisor,{capabilities:RESTRICTED_MEMBER_CAPABILITIES});
  for(const projection of [support,counterpart]) d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(supervisor,projection.id);
  d.prepare("UPDATE task_supervision_actions SET supervisor_user_id=?,state='assigned' WHERE source_task_id=?").run(supervisor,source.id);
  const supervisorRows=d.prepare(`SELECT t.id FROM tasks t WHERE ${taskVisibilityWhere(d,supervisor,'t','@me')}`).all({me:supervisor});
  for(const projection of [support,counterpart]) {
    assert.equal(taskCapabilities(d,supervisor,projection).own,true);
    assert.equal(taskCapabilities(d,supervisor,projection).view,true);
    assert.equal(supervisorRows.some(row=>row.id===projection.id),true);
  }
});
