import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'single-supervisor-integration';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { reconcileTaskSupervision, inspectTaskSupervision } = await import('../server/services/task-supervision.js');
const { setTaskSkills } = await import('../server/services/task-skills.js');
const { respondToTaskObligation, recordTaskAssignment } = await import('../server/services/assignment-responsibilities.js');
const { isNotificationDeliveryCurrent, notifyTaskObligations } = await import('../server/services/notification-events.js');
const { taskCapabilities, taskVisibilityWhere } = await import('../server/services/task-access.js');
const { replaceSubjectPermissions } = await import('../server/permissions.js');
const { RESTRICTED_MEMBER_CAPABILITIES } = await import('../server/task-capabilities.js');

let d, actor, admin, learner, first, second, washer, dryer, source, wash, dry;
const app = express();
app.use(express.json());
app.use((req,_res,next)=>{req.authUserId=actor;req.authRole=actor===admin?'admin':'member';req.session={userId:actor,role:req.authRole};next();});
app.use('/api/v1/tasks',tasksRouter);
const server=http.createServer(app);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(()=>server.close());
test.beforeEach(()=>{
  d=new Database(':memory:'); d.pragma('foreign_keys = ON');
  d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT,applied_at TEXT)');
  for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);
    d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);}
  _setTestDatabase(d);
  const user=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(name,name,role).lastInsertRowid);
  admin=user('Creator','admin'); learner=user('Learner'); first=user('First helper'); second=user('Second helper'); actor=admin;
  const skill=name=>Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(name,admin).lastInsertRowid);
  washer=skill('Washing Machine');dryer=skill('Dryer');
  for(const id of [washer,dryer]){proficiency(learner,id,'supervised');proficiency(first,id,'normal');proficiency(second,id,'normal');proficiency(admin,id,'excluded');}
  source=makeTask('Laundry');wash=makeTask('Load washer',source,null);dry=makeTask('Start dryer',source,null);
  setTaskSkills(d,wash,[washer]);setTaskSkills(d,dry,[dryer]);
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});
function proficiency(user,skill,value){d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
 VALUES(?,?,?,'manual',?) ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`).run(user,skill,value,admin);}
function makeTask(title,parent=null,assigned=learner){return Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,assigned_to,due_date,due_time) VALUES(?,?,?,?,'2026-09-14','12:00')").run(title,admin,parent,assigned).lastInsertRowid);}
const revision=id=>d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision;
const pending=()=>d.prepare("SELECT * FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('pending','accepted')").all(source);
async function request(method,path,body,as=admin){actor=as;const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};}

test('legacy action-scoped supervisor route assigns one helper to the whole Task',async()=>{
  const before=reconcileTaskSupervision(d,source);
  const response=await request('POST',`/${wash}/supervisor`,{supervisor_user_id:second,action_task_id:wash,
    expected_revision:revision(wash),expected_source_revision:revision(source)});
  assert.equal(response.status,200,JSON.stringify(response.data));
  const view=inspectTaskSupervision(d,source);
  assert.ok(view.actions.every(action=>action.supervisor_user_id===second));assert.equal(view.supervisor_user_id,second);
  assert.equal(view.support_task_id,before.support_task_id);assert.equal(pending().length,1);assert.equal(pending()[0].responsible_user_id,second);
});

test('manual supervisor choice requires canonical source creator or admin plus assignment permission',async()=>{
  reconcileTaskSupervision(d,source);
  assert.equal((await request('POST',`/${source}/supervisor`,{supervisor_user_id:second},first)).status,403);
  d.prepare('UPDATE tasks SET created_by=? WHERE id=?').run(first,source);
  assert.equal((await request('POST',`/${source}/supervisor`,{supervisor_user_id:second},first)).status,200);
  replaceSubjectPermissions(d,'user',first,{capabilities:{'tasks.change_assignment':'none'}});
  assert.equal((await request('POST',`/${source}/supervisor`,{supervisor_user_id:second},first)).status,403);
});

test('manual per-action candidate cannot bypass a requirement elsewhere in the Task',async()=>{
  proficiency(second,dryer,'excluded');const before=reconcileTaskSupervision(d,source);
  const response=await request('POST',`/${source}/supervisor`,{supervisor_user_id:second,action_task_id:wash});
  assert.equal(response.status,409);assert.equal(inspectTaskSupervision(d,source).supervisor_user_id,first);
  assert.equal(inspectTaskSupervision(d,source).support_task_id,before.support_task_id);
});

test('legacy action identifier and canonical source revision cannot target another Task or overwrite newer scope',async()=>{
  reconcileTaskSupervision(d,source);const stale=revision(source);d.prepare('UPDATE tasks SET title=? WHERE id=?').run('Changed washer',wash);
  assert.equal((await request('POST',`/${wash}/supervisor`,{supervisor_user_id:second,expected_source_revision:stale})).status,409);
  const unrelated=makeTask('Other Task');
  assert.equal((await request('POST',`/${source}/supervisor`,{supervisor_user_id:second,action_task_id:unrelated})).status,400);
});

test('declining a request selects one unattempted whole-scope replacement and never duplicates helper work',()=>{
  const before=reconcileTaskSupervision(d,source);const initial=pending()[0];
  const result=respondToTaskObligation(d,initial.id,'decline',first);
  assert.equal(result.fallback.id,second);const after=inspectTaskSupervision(d,source);
  assert.ok(after.actions.every(action=>action.supervisor_user_id===second));assert.equal(after.support_task_id,before.support_task_id);
  assert.equal(pending().length,1);assert.equal(pending()[0].responsible_user_id,second);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(source).n,1);
});

test('declining the only whole-scope helper leaves partial candidates unresolved and retains learner progress',()=>{
  proficiency(second,dryer,'excluded');reconcileTaskSupervision(d,source);
  const independent=makeTask('Gather laundry',source,null);d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(independent);
  const result=respondToTaskObligation(d,pending()[0].id,'decline',first);
  assert.equal(result.fallback,null);const view=inspectTaskSupervision(d,source);
  assert.equal(view.state,'needed');assert.equal(view.supervisor_user_id,null);assert.equal(pending().length,0);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(source).assigned_to,learner);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(independent).status,'done');
});

test('legacy split helper cannot accept a request for only its own action',()=>{
  reconcileTaskSupervision(d,source);const obligation=pending()[0];
  d.prepare('UPDATE task_supervision_actions SET supervisor_user_id=? WHERE action_task_id=?').run(second,dry);
  assert.throws(()=>respondToTaskObligation(d,obligation.id,'accept',first),/no longer current/);
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(obligation.id).status,'pending');
});

test('delayed refusal of a legacy request does not replace the newer whole-Task supervisor',()=>{
  reconcileTaskSupervision(d,source);const old=pending()[0];
  reconcileTaskSupervision(d,source,{supervisorUserId:second});
  // Old versions could retain two pending requests; simulate one arriving late.
  d.prepare("UPDATE planning_obligations SET status='pending' WHERE id=?").run(old.id);
  const result=respondToTaskObligation(d,old.id,'decline',first);
  assert.equal(result.fallback,null);assert.equal(inspectTaskSupervision(d,source).supervisor_user_id,second);
  assert.equal(pending().length,1);assert.equal(pending()[0].responsible_user_id,second);
});

test('one Task-level notification replaces per-action requests and outdated supervisor delivery',()=>{
  reconcileTaskSupervision(d,source);
  const old=d.prepare("SELECT * FROM notification_inbox WHERE user_id=? AND source_key LIKE 'task-supervision-scope:%'").all(first);
  assert.equal(old.length,1);assert.equal(isNotificationDeliveryCurrent(d,old[0]),true);
  notifyTaskObligations(d,source);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM notification_inbox WHERE user_id=?').get(first).n,1);
  reconcileTaskSupervision(d,source,{supervisorUserId:second});
  assert.equal(isNotificationDeliveryCurrent(d,old[0]),false);
  const current=d.prepare("SELECT * FROM notification_inbox WHERE user_id=? AND source_key LIKE 'task-supervision-scope:%'").all(second);
  assert.equal(current.length,1);assert.equal(isNotificationDeliveryCurrent(d,current[0]),true);
});

test('template parent-only preview does not persist or notify a provisional supervisor before checklist resolution',()=>{
  const user=id=>d.prepare('SELECT id,display_name FROM users WHERE id=?').get(id);
  recordTaskAssignment(d,source,{id:1,assignment_policy:'fixed'}, {primary:user(learner),participants:[user(learner)],supervisor:user(second),strategy:'fixed'});
  assert.equal(pending().length,0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").get(source).n,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM notification_inbox WHERE user_id=?').get(second).n,0);
  assert.equal(reconcileTaskSupervision(d,source).supervisor_user_id,first);
});

test('completed historical mapping does not grant former helper current authority',()=>{
  reconcileTaskSupervision(d,source);replaceSubjectPermissions(d,'user',first,{capabilities:RESTRICTED_MEMBER_CAPABILITIES});
  assert.equal(taskCapabilities(d,first,{id:wash}).complete,true);
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(wash);
  reconcileTaskSupervision(d,source,{supervisorUserId:second});
  assert.equal(d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(wash).supervisor_user_id,first);
  assert.equal(taskCapabilities(d,first,{id:wash}).complete,false);
  const visible=d.prepare(`SELECT t.id FROM tasks t WHERE ${taskVisibilityWhere(d,first,'t','@me')}`).all({me:first});
  assert.equal(visible.some(row=>row.id===source||row.id===wash),false);
});

test('aggregate supervision explanations never reveal private action requirements to other viewers',async()=>{
  proficiency(first,dryer,'excluded');proficiency(second,washer,'excluded');
  d.prepare("UPDATE tasks SET title='Hidden dryer action',visibility='private',created_by=? WHERE id=?").run(second,dry);
  d.prepare("UPDATE skills SET name='Private skill marker' WHERE id=?").run(dryer);
  reconcileTaskSupervision(d,source);
  const response=await request('GET',`/${source}`,undefined,learner);
  assert.equal(response.status,200);const detail=response.data.data;
  assert.equal(detail.supervision.may_assign,false);assert.equal(detail.supervision.actions.length,1);
  assert.equal(JSON.stringify(detail).includes('Private skill marker'),false);
  assert.equal(JSON.stringify(detail).includes('Hidden dryer action'),false);
  assert.match(detail.supervision.reason,/entire remaining supervised scope/);
});

test('visible supervision Activity and nested consolidation history do not reveal private sibling requirements',async()=>{
  d.prepare("UPDATE tasks SET title='Hidden dryer action',visibility='private',created_by=? WHERE id=?").run(second,dry);
  d.prepare("UPDATE skills SET name='Private skill marker' WHERE id=?").run(dryer);
  reconcileTaskSupervision(d,source);
  const checkActivity=async()=>{
    const response=await request('GET',`/${source}/activity`,undefined,learner);
    assert.equal(response.status,200);const events=response.data.data;
    assert.ok(events.some(event=>event.action_task_id===wash));
    assert.equal(events.some(event=>event.action_task_id===dry),false);
    assert.equal(JSON.stringify(events).includes('Hidden dryer action'),false);
    assert.equal(JSON.stringify(events).includes('Private skill marker'),false);
    return events;
  };
  await checkActivity();
  proficiency(first,dryer,'excluded');proficiency(second,washer,'excluded');reconcileTaskSupervision(d,source);
  await checkActivity();
  // Normalize a legacy nested helper scope without adding its private title or
  // skill list to the parent-level consolidation Activity entry.
  const legacySupport=makeTask('Hidden legacy supervision container',dry,second);
  d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(dry,legacySupport);
  d.prepare('UPDATE task_supervision_actions SET source_task_id=? WHERE action_task_id=?').run(dry,dry);
  reconcileTaskSupervision(d,source);
  const events=await checkActivity();
  assert.ok(events.some(event=>event.event_type==='supervision_consolidated'));
  assert.equal(JSON.stringify(events).includes('Hidden legacy supervision container'),false);
});
