import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET ||= 'supervision-request-cache-regression';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {attachTaskSupervision,reconcileTaskSupervision,taskSupervisionTransition}=await import('../server/services/task-supervision.js');
const d=new Database(':memory:');d.pragma('foreign_keys=ON');
for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);}
_setTestDatabase(d);
const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'x',?)").run(name,name,role).lastInsertRowid);
const admin=user('Cache parent','admin'),learner=user('Cache learner','member'),helper=user('Cache helper','member');
const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washer',0,'normal',?)").run(admin).lastInsertRowid);
for(const [id,proficiency] of [[admin,'excluded'],[learner,'supervised'],[helper,'normal']])d.prepare(
  "INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(id,skill,proficiency,admin);
const root=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to) VALUES('Laundry',?,?)").run(admin,learner).lastInsertRowid);
const child=Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id) VALUES('Load washer',?,?)").run(admin,root).lastInsertRowid);
d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id) VALUES (?,?)').run(child,skill);
const initial=reconcileTaskSupervision(d,root);
const prepare=d.prepare.bind(d);let sourceEvaluations=0;
d.prepare=(sql,...args)=>{
  if(sql.trim()==='SELECT * FROM task_supervision_actions WHERE source_task_id = ?')sourceEvaluations++;
  return prepare(sql,...args);
};
const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=admin;req.authRole='admin';req.session={userId:admin};next();});app.use('/tasks',tasksRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/tasks`;
test.after(()=>{server.closeAllConnections();server.close();d.close();});
const read=async path=>{const res=await fetch(base+path);assert.equal(res.status,200);return (await res.json()).data;};

test('one list response resolves source, action and helper projections together once',async()=>{
  sourceEvaluations=0;const rows=await read('');
  assert.ok(rows.some(row=>row.id===root));assert.ok(rows.some(row=>row.id===initial.support_task_id));
  assert.equal(sourceEvaluations,1);
});

test('one detail response shares supervision between parent and operational subtasks',async()=>{
  sourceEvaluations=0;const row=await read('/'+root);
  assert.equal(sourceEvaluations,1);
  assert.equal(row.supervision.state,'assigned');
  assert.equal(row.subtasks.find(item=>item.id===child).supervision_action.supervisor_user_id,helper);
});

test('new requests and action-time eligibility never reuse an earlier response snapshot',async()=>{
  const earlier=await read('/'+root);assert.equal(earlier.supervision.state,'assigned');
  d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id=?").run(helper,skill);
  try {
    sourceEvaluations=0;const current=await read('/'+root);
    assert.equal(sourceEvaluations,1);assert.equal(current.supervision.state,'needed');
    assert.match(current.supervision.reason,/no single qualified supervisor/i);
    assert.throws(()=>taskSupervisionTransition(d,child,'done',helper),/no single qualified supervisor/i);
    assert.equal(earlier.supervision.state,'assigned');
  }finally{d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=? AND skill_id=?").run(helper,skill);}
});

test('per-actor completion hints cannot mutate another actor projection',()=>{
  const sourceViews=new Map(),helperRows=[{id:child}],learnerRows=[{id:child}];
  attachTaskSupervision(d,helperRows,helper,sourceViews);
  assert.equal(helperRows[0].supervision_action.can_complete,true);
  attachTaskSupervision(d,learnerRows,learner,sourceViews);
  assert.equal(learnerRows[0].supervision_action.can_complete,false);
  assert.equal(helperRows[0].supervision_action.can_complete,true);
});
