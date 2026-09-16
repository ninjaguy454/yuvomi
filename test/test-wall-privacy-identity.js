import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { hashPassword } from '../server/utils/password.js';
import { replaceSubjectPermissions } from '../server/permissions.js';
import { RESTRICTED_MEMBER_CAPABILITIES } from '../server/task-capabilities.js';
import { generateSecret,generateCode } from '../server/utils/totp.js';
import { wallSessionAllows, preserveWallSessionLock, WALL_EXIT_VERIFIED } from '../server/services/wall-session.js';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET||='wall-identity-test-session';
const {wallConfig,saveWallConfig,WALL_DEFAULTS,issueWallActor,verifiedWallActor}=await import('../server/services/wall.js');
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:wallRouter,wallErrorResponse}=await import('../server/routes/wall.js');
const {default:readerRouter}=await import('../server/routes/reader.js');
const {requireAuth}=await import('../server/auth.js');
const d=new Database(':memory:');d.pragma('foreign_keys=ON');
d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT 'test')");
for(const migration of ALL_MIGRATIONS){if(typeof migration.up==='function')migration.up(d);else d.exec(migration.up);migration.afterUp?.(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);}
_setTestDatabase(d);
const password=await hashPassword('wall-test-password',4);
const member=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,?,?,'child')").run(name,name,password,role).lastInsertRowid);
const admin=member('Admin','admin'),child=member('Child'),other=member('Other');
const seed=(title,visibility='all',assigned=child,parent=null)=>{
  const id=Number(d.prepare('INSERT INTO tasks(title,created_by,assigned_to,visibility,parent_task_id) VALUES(?,?,?,?,?)').run(title,admin,assigned,visibility,parent).lastInsertRowid);
  if(assigned)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,assigned);return id;
};
const root=seed('Shared learner work'),step=seed('Independent step','all',null,root),privateTask=seed('SECRET private Task','private'),assigneeTask=seed('SECRET own-only Task','assignees'),otherTask=seed('Other member work','all',other);
const sessions=new Map([['host',{userId:admin,role:'admin'}],['other-tab',{userId:admin,role:'admin'}],['child-host',{userId:child,role:'member'}]]);
const app=express();app.use(express.json());
app.use((req,_res,next)=>{const key=req.get('x-test-session')||'host';req.sessionID=key;req.session=sessions.get(key);req.session.save=cb=>cb();next();});
app.use('/reader',readerRouter);app.use('/api/v1',requireAuth);app.use('/api/v1/wall',wallRouter);
for(const path of ['tasks','dashboard','notifications','search','rewards/overview','calendar','automation/tasks'])app.get(`/api/v1/${path}`,(_req,res)=>res.json({privateData:true}));
const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.close();d.close();});
test.beforeEach(()=>{d.prepare('DELETE FROM access_permissions').run();d.prepare('DELETE FROM access_capabilities').run();saveWallConfig(d,WALL_DEFAULTS);for(const session of sessions.values())delete session.wallMode;});
async function request(method,path,body,{session='host',token}={}) {
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-test-session':session,...(token?{'X-Wall-Actor':token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let payload;try{payload=JSON.parse(text);}catch{payload=text;}return {status:response.status,body:payload};
}
const identity=async(user=child,session='host')=>{const res=await request('POST','/api/v1/wall/identify',{user_id:user,password:'wall-test-password'},{session});assert.equal(res.status,200,JSON.stringify(res.body));return res.body.data.actor_token;};
const interactive=()=>saveWallConfig(d,{...WALL_DEFAULTS,interaction:{mode:'interactive',actions:['task_complete','task_claim','reward_redeem']}});
const revisions=id=>{const row=d.prepare('SELECT revision,parent_task_id FROM tasks WHERE id=?').get(id);return {expected_revision:row.revision,...(row.parent_task_id?{expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(row.parent_task_id).revision}:{})};};

test('Wall defaults are read-only and independent of personal Dashboard configuration',()=>{
  d.prepare("INSERT INTO sync_config(key,value) VALUES('dashboard_widgets:user:1','personal') ON CONFLICT(key) DO UPDATE SET value='personal'").run();
  assert.equal(wallConfig(d).interaction.mode,'read_only');
  saveWallConfig(d,{...WALL_DEFAULTS,widgets:[{id:'tasks',visible:true,size:'large',order:0}],appearance:{palette:'cool'}});
  assert.equal(wallConfig(d).appearance.palette,'cool');assert.equal(d.prepare("SELECT value FROM sync_config WHERE key='dashboard_widgets:user:1'").get().value,'personal');
  assert.throws(()=>saveWallConfig(d,{widgets:[{id:'health',visible:true}]}),/Unknown/);
});
test('public Wall projection never inherits host-owned private/assignee Task visibility',async()=>{
  const res=await request('GET','/api/v1/wall/dashboard');assert.equal(res.status,200,JSON.stringify(res.body));
  const text=JSON.stringify(res.body);assert.ok(text.includes('Shared learner work'));assert.ok(!text.includes('SECRET'));
  for(const id of [privateTask,assigneeTask])assert.equal((await request('GET',`/api/v1/wall/tasks/${id}`)).status,404);
  assert.equal((await request('GET',`/api/v1/wall/tasks/${root}`)).body.data.permissions.complete,false);
});
test('Wall entry locks ordinary authenticated and Reader surfaces; no host-admin bypass',async()=>{
  assert.equal((await request('GET','/api/v1/tasks')).status,200);
  assert.equal((await request('POST','/api/v1/wall/enter',{})).status,200);
  for(const path of ['tasks','dashboard','notifications','search','rewards/overview','calendar','automation/tasks'])assert.equal((await request('GET',`/api/v1/${path}`)).status,423,path);
  assert.equal((await request('GET','/reader')).status,423);
  assert.equal((await request('GET','/api/v1/wall/dashboard')).status,200);
  assert.equal((await request('POST','/api/v1/wall/exit',{})).status,403);
  const proof=await identity(admin);assert.equal((await request('POST','/api/v1/wall/exit',{}, {token:proof})).status,200);
  assert.equal((await request('GET','/api/v1/tasks')).status,200);
});
test('settings and exit require verified administrator, not an avatar selection or hosting session',async()=>{
  assert.equal((await request('PUT','/api/v1/wall/config',WALL_DEFAULTS)).status,403);
  const childProof=await identity();assert.equal((await request('PUT','/api/v1/wall/config',WALL_DEFAULTS,{token:childProof})).status,403);
  const adminProof=await identity(admin);assert.equal((await request('PUT','/api/v1/wall/config',WALL_DEFAULTS,{token:adminProof})).status,200);
  const adminOnChild=await identity(admin,'child-host');assert.equal((await request('PUT','/api/v1/wall/config',WALL_DEFAULTS,{session:'child-host',token:adminOnChild})).status,403);
});
test('member proof is session-bound, expires, and cannot survive a password change',async()=>{
  const proof=await identity();assert.equal((await request('GET',`/api/v1/wall/tasks/${root}`,undefined,{session:'other-tab',token:proof})).status,403);
  const user=d.prepare('SELECT * FROM users WHERE id=?').get(child);
  const expired=issueWallActor(d,{sessionId:'host',hostId:admin,user,now:0});
  assert.throws(()=>verifiedWallActor(d,{sessionId:'host',hostId:admin,token:expired}),/Identify/);
  d.prepare("UPDATE users SET password_hash='changed' WHERE id=?").run(child);
  assert.equal((await request('GET',`/api/v1/wall/tasks/${root}`,undefined,{token:proof})).status,403);
  d.prepare('UPDATE users SET password_hash=? WHERE id=?').run(password,child);
});
test('restricted member and host module ceiling remain authoritative',async()=>{
  replaceSubjectPermissions(d,'user',child,{capabilities:RESTRICTED_MEMBER_CAPABILITIES});
  const proof=await identity();
  assert.equal((await request('GET',`/api/v1/wall/tasks/${root}`,undefined,{token:proof})).status,200);
  assert.equal((await request('GET',`/api/v1/wall/tasks/${otherTask}`,undefined,{token:proof})).status,404);
  replaceSubjectPermissions(d,'user',child,{modules:{tasks:'none'}});
  assert.equal((await request('GET',`/api/v1/wall/tasks/${root}`,undefined,{token:proof})).status,403);
  const childHost=await request('GET','/api/v1/wall/dashboard',undefined,{session:'child-host'});assert.deepEqual(childHost.body.data.urgentTasks,[]);
});
test('read-only mode and unverified actions cannot mutate; actual actor starts/completes parent once',async()=>{
  const proof=await identity();const before=d.prepare('SELECT status FROM tasks WHERE id=?').get(step).status;
  assert.equal((await request('PATCH',`/api/v1/wall/tasks/${step}/status`,{status:'done',...revisions(step)},{token:proof})).status,403);
  interactive();assert.equal((await request('PATCH',`/api/v1/wall/tasks/${step}/status`,{status:'done',...revisions(step)})).status,403);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(step).status,before);
  const body={status:'done',...revisions(step)};
  const res=await request('PATCH',`/api/v1/wall/tasks/${step}/status`,body,{token:proof});assert.equal(res.status,200,JSON.stringify(res.body));
  assert.equal(res.body.data.status,'done');assert.equal(res.body.data.parent_task.status,'done');
  const events=d.prepare("SELECT actor_user_id FROM task_activity_events WHERE task_id=? AND event_type='completed'").all(root);
  assert.ok(events.length>=2);assert.ok(events.every(e=>e.actor_user_id===child));
  assert.equal((await request('PATCH',`/api/v1/wall/tasks/${step}/status`,body,{token:proof})).status,409);
});
test('parent bulk completion cannot silently complete an independently private child',async()=>{
  interactive();const parent=seed('Shared container');seed('Hidden action','private',null,parent);
  const proof=await identity(admin);const before=d.prepare('SELECT status FROM tasks WHERE id=?').get(parent).status;
  const res=await request('PATCH',`/api/v1/wall/tasks/${parent}/status`,{status:'done',complete_remaining:true,...revisions(parent)},{token:proof});
  assert.equal(res.status,403);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(parent).status,before);
  assert.ok(!JSON.stringify((await request('GET',`/api/v1/wall/tasks/${parent}`)).body).includes('Hidden action'));
});
test('private Calendar and personal/unpublished Meal details remain unavailable',async()=>{
  const event=Number(d.prepare("INSERT INTO calendar_events(title,start_datetime,created_by,visibility) VALUES('SECRET event','2026-09-20T10:00',?,'private')").run(admin).lastInsertRowid);
  assert.equal((await request('GET',`/api/v1/wall/calendar/${event}`)).status,404);
  for(const scope of ['personal','household']){
    const meal=Number(d.prepare("INSERT INTO meals(title,date,meal_type,created_by,scope,selection_status) VALUES('SECRET draft','2026-09-20','dinner',?,?, 'awaiting_choice')").run(admin,scope).lastInsertRowid);
    assert.equal((await request('GET',`/api/v1/wall/meals/${meal}`)).status,404);
  }
});
test('redemption always belongs to verified actor and durable retries deduct once',async()=>{
  interactive();d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(child);
  d.prepare("INSERT INTO reward_ledger(user_id,delta,type,reason,created_by) VALUES(?,20,'bonus','Fixture',?)").run(child,admin);
  const reward=Number(d.prepare("INSERT INTO reward_catalog(name,cost,created_by) VALUES('Wall movie',5,?)").run(admin).lastInsertRowid);
  const proof=await identity();const body={catalog_id:reward,user_id:admin,request_key:'wall-test-redemption-one'};
  const first=await request('POST','/api/v1/wall/rewards/redemptions',body,{token:proof});assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.data.user_id,child);assert.equal(first.body.data.requested_by,child);
  const again=await request('POST','/api/v1/wall/rewards/redemptions',body,{token:proof});assert.equal(again.status,200);assert.equal(again.body.data.id,first.body.data.id);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM reward_ledger WHERE redemption_id=? AND type='redeem'").get(first.body.data.id).n,1);
});
test('existing second factor cannot be skipped and avatar/password alone do not prove identity',async()=>{
  const secret=generateSecret();
  d.prepare("INSERT INTO user_totp(user_id,secret,confirmed_at) VALUES(?,?,'2026-01-01')").run(other,secret);
  const absent=await request('POST','/api/v1/wall/identify',{user_id:other,password:'wall-test-password'});
  assert.equal(absent.status,403);assert.equal(absent.body.reason,'wall_second_factor_required');
  const valid=await request('POST','/api/v1/wall/identify',{user_id:other,password:'wall-test-password',code:generateCode(secret)});
  assert.equal(valid.status,200,JSON.stringify(valid.body));
  assert.equal((await request('POST','/api/v1/wall/identify',{user_id:other,password:'wrong',code:generateCode(secret)})).status,403);
  d.prepare('DELETE FROM user_totp WHERE user_id=?').run(other);
});
test('forgetting the actor revokes its proof rather than silently reverting actions to hosting administrator',async()=>{
  const proof=await identity();assert.equal((await request('POST','/api/v1/wall/forget',{}, {token:proof})).status,200);
  assert.equal((await request('GET',`/api/v1/wall/tasks/${root}`,undefined,{token:proof})).status,403);
});
test('Wall dashboard respects existing widget restrictions as well as module restrictions',async()=>{
  replaceSubjectPermissions(d,'user',child,{widgets:{tasks:'none'}});
  const response=await request('GET','/api/v1/wall/dashboard',undefined,{session:'child-host'});
  assert.equal(response.status,200);assert.deepEqual(response.body.data.urgentTasks,[]);
});
test('private ICS source stays private even when its imported event says household-visible',async()=>{
  const subscription=Number(d.prepare("INSERT INTO ics_subscriptions(name,url,created_by,shared) VALUES('Private feed','https://example.invalid/feed',?,0)").run(admin).lastInsertRowid);
  const event=Number(d.prepare("INSERT INTO calendar_events(title,start_datetime,created_by,visibility,external_source,subscription_id) VALUES('SECRET feed event','2026-09-20T10:00',?,'all','ics',?)").run(admin,subscription).lastInsertRowid);
  assert.equal((await request('GET',`/api/v1/wall/calendar/${event}`)).status,404);
  d.prepare('UPDATE ics_subscriptions SET shared=1 WHERE id=?').run(subscription);
  assert.equal((await request('GET',`/api/v1/wall/calendar/${event}`)).status,200);
});
test('locked session allows only exact payload-free live channels and Wall routes, not prefix tricks',()=>{
  const check=path=>wallSessionAllows({session:{wallMode:true},originalUrl:path});
  for(const path of ['/api/v1/tasks/changes','/api/v1/rewards/changes','/api/v1/wall/dashboard','/api/v1/auth/me'])assert.equal(check(path),true,path);
  for(const path of ['/api/v1/tasks/changes/../12','/api/v1/rewards/overview','/api/v1/wallpaper','/api/v1/auth/users','/mcp','/openapi.json','/api/tasks'])assert.equal(check(path),false,path);
});
test('a stale ordinary session save cannot erase the Wall lock; only verified exit clears it',()=>{
  const current={userId:admin,wallMode:true};
  const stale={userId:admin,csrfToken:'new-csrf'};
  assert.equal(preserveWallSessionLock(current,stale).wallMode,true);
  const exit={userId:admin,[WALL_EXIT_VERIFIED]:true};
  assert.equal(preserveWallSessionLock(current,exit).wallMode,undefined);
  assert.equal(exit[WALL_EXIT_VERIFIED],undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(exit)),{userId:admin});
});
test('canonical error scopes cannot leak private sibling titles or eligibility histories',()=>{
  const error=Object.assign(new Error('SECRET sibling skill prevents this assignment'),{status:409,details:{supervision:{actions:[{state:'unresolved',action_title:'SECRET action',supervisor_explanations:['SECRET Trip']}]},dependencies:[{title:'SECRET dependent Task'}]}});
  const safe=wallErrorResponse(error);assert.equal(safe.code,409);assert.match(safe.error,/single qualified helper/);assert.ok(!JSON.stringify(safe).includes('SECRET'));
  assert.deepEqual(wallErrorResponse(Object.assign(new Error('Changed'),{status:409,details:{reason:'stale_revision',revision:8,task_id:12}})),{error:'Changed',code:409,reason:'stale_revision',revision:8,task_id:12});
});
test('Wall preserves supervised and delegated ownership and the shared canonical completion state',async()=>{
  const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
  const {setTaskSkills}=await import('../server/services/task-skills.js');
  const skill=name=>Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(name,admin).lastInsertRowid);
  const supervisedSkill=skill('Wall Sorting'),excludedSkill=skill('Wall Washer');
  const proficiency=(id,skill,value)=>d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(id,skill,value,admin);
  proficiency(child,supervisedSkill,'supervised');proficiency(child,excludedSkill,'excluded');
  for(const id of [supervisedSkill,excludedSkill]){proficiency(admin,id,'excluded');proficiency(other,id,'normal');}
  const source=seed('Mixed Wall work'),independent=seed('Gather','all',null,source),supervised=seed('Sort','all',null,source),delegated=seed('Run washer','all',null,source);
  setTaskSkills(d,supervised,[supervisedSkill]);setTaskSkills(d,delegated,[excludedSkill]);
  const scope=reconcileTaskSupervision(d,source);assert.equal(scope.supervisor_user_id,other);
  interactive();const childProof=await identity();
  const learner=(await request('GET',`/api/v1/wall/tasks/${source}`,undefined,{token:childProof})).body.data;
  assert.equal(learner.subtask_total,2);assert.equal(learner.subtasks.find(x=>x.id===independent).permissions.complete,true);
  assert.equal(learner.subtasks.find(x=>x.id===supervised).permissions.complete,false);
  assert.equal(learner.subtasks.find(x=>x.id===delegated).is_delegated_action,true);
  assert.equal(learner.subtasks.find(x=>x.id===delegated).permissions.complete,false);
  const refused=await request('PATCH',`/api/v1/wall/tasks/${delegated}/status`,{status:'done',...revisions(delegated)},{token:childProof});assert.equal(refused.status,409);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(delegated).status,'open');
  const helperProof=await identity(other),counterpart=scope.actions.find(x=>x.action_task_id===delegated).counterpart_task_id;
  const helper=(await request('GET',`/api/v1/wall/tasks/${counterpart}`,undefined,{token:helperProof})).body.data;
  assert.equal(helper.is_supervision_projection,true);assert.equal(helper.is_delegated_action,false);assert.equal(helper.permissions.complete,true);
  const completed=await request('PATCH',`/api/v1/wall/tasks/${counterpart}/status`,{status:'done',...revisions(counterpart)},{token:helperProof});assert.equal(completed.status,200,JSON.stringify(completed.body));
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(delegated).status,'done');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(source).status,'in_progress');
});
test('archived private checklist history does not block completing current shared work',async()=>{
  interactive();
  const source=seed('Shared work with archived history'),archived=seed('SECRET archived step','private',null,source);
  d.prepare("UPDATE tasks SET archived_at='2026-01-01T00:00:00Z' WHERE id=?").run(archived);
  const proof=await identity();
  const result=await request('PATCH',`/api/v1/wall/tasks/${source}/status`,{status:'done',...revisions(source)},{token:proof});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.status,'done');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(archived).status,'open');
});
