/** Real Wall HTTP diagnostics must remain stricter than the verified actor's
 * personal Task audience, including on rejected canonical mutations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='wall-adversarial-errors';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:wallRouter}=await import('../server/routes/wall.js');
const {saveWallConfig,WALL_DEFAULTS,issueWallActor}=await import('../server/services/wall.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
const {taskSupervisionTransition}=await import('../server/services/task-supervision.js');
const d=new Database(':memory:');d.pragma('foreign_keys=ON');
for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
_setTestDatabase(d);
const host=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('host','Host','x','admin','parent')").run().lastInsertRowid);
const learner=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('learner','Learner','x','member','parent')").run().lastInsertRowid);
saveWallConfig(d,{...WALL_DEFAULTS,interaction:{mode:'interactive',actions:['task_complete','reward_redeem']}});
function task(title,{visibility='all',parent=null,creator=host,assignee=learner}={}){
  const id=Number(d.prepare('INSERT INTO tasks(title,created_by,assigned_to,visibility,parent_task_id) VALUES(?,?,?,?,?)')
    .run(title,creator,assignee,visibility,parent).lastInsertRowid);
  if(assignee)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,assignee);return id;
}
const proof=id=>issueWallActor(d,{hostId:host,sessionId:'wall-session',user:d.prepare('SELECT * FROM users WHERE id=?').get(id)});
const app=express();app.use(express.json());app.use((req,res,next)=>{
  req.authMethod='session';req.authUserId=host;req.authRole='admin';req.sessionID='wall-session';req.session={userId:host,wallMode:true};next();});
app.use('/wall',wallRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/wall`;
test.after(()=>{server.closeAllConnections();server.close();_setTestDatabase(null);d.close();});
async function complete(id,actor=learner){const row=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const body={status:'done',expected_revision:row.revision,...(row.parent_task_id?
    {expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(row.parent_task_id).revision}:{})};
  const response=await fetch(`${base}/tasks/${id}/status`,{method:'PATCH',headers:{'content-type':'application/json','X-Wall-Actor':proof(actor)},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};}

test('Wall rejection hides an actor-owned private prerequisite even though canonical personal diagnostics may name it',async()=>{
  const visible=task('Public household action'),secret=task('SECRET private prerequisite',{creator:learner,visibility:'private'});
  d.prepare('INSERT INTO workflow_task_dependencies(task_id,depends_on_task_id) VALUES(?,?)').run(visible,secret);
  const response=await complete(visible);assert.equal(response.status,409,JSON.stringify(response));
  assert.doesNotMatch(JSON.stringify(response.body),/SECRET|dependencies|private prerequisite/);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(visible).status,'open');
});

test('Wall supervised-action rejection hides actor-visible private sibling skills, actions and qualification explanations',async()=>{
  const root=task('Shared Laundry'),publicAction=task('Public washer step',{parent:root}),secret=task('SECRET private action',{parent:root,creator:learner,visibility:'private'});
  const addSkill=name=>Number(d.prepare("INSERT INTO skills(name,created_by,minimum_age,age_promotion) VALUES(?,?,0,'normal')").run(name,host).lastInsertRowid);
  const publicSkill=addSkill('Washer'),secretSkill=addSkill('SECRET personal skill');
  for(const [id,skill]of [[publicAction,publicSkill],[secret,secretSkill]])setTaskSkills(d,id,[skill]);
  for(const skill of [publicSkill,secretSkill])for(const [id,proficiency]of [[learner,'supervised'],[host,'normal']])
    d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,?,'manual')").run(id,skill,proficiency);
  reconcileTaskSupervision(d,root);
  assert.throws(()=>taskSupervisionTransition(d,publicAction,'done',learner),error=>{
    assert.match(JSON.stringify(error.details),/SECRET personal skill/,'the personal diagnostic is allowed to explain the actor-owned scope');return true;
  });
  const response=await complete(publicAction);assert.equal(response.status,409,JSON.stringify(response));
  assert.doesNotMatch(JSON.stringify(response.body),/SECRET|supervisor_explanations|supervision.*actions/);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(publicAction).status,'open');
});

test('Wall completion cannot award an upcoming recurring occurrence before its start date',async()=>{
  const root=task('Future household Laundry'),child=task('Future step',{parent:root});
  d.prepare("UPDATE tasks SET points=5,is_recurring=1,recurrence_rule='FREQ=WEEKLY',start_date='2099-01-03' WHERE id=?").run(root);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(learner);
  const response=await complete(child);assert.equal(response.status,409,JSON.stringify(response));
  assert.equal(response.body.reason,'occurrence_not_started');assert.match(response.body.error,/2099-01-03/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(root).n,0);
});
