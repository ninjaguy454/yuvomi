import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'task-release-security-test';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { replaceSubjectPermissions, resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { RESTRICTED_MEMBER_CAPABILITIES } = await import('../server/task-capabilities.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
const { default: readerRouter } = await import('../server/routes/reader.js');
const { default: searchRouter } = await import('../server/routes/search.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: rewardsRouter } = await import('../server/routes/rewards.js');
const { default: planningRouter } = await import('../server/routes/planning.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');
const { buildInboxRouter } = await import('../server/routes/notification-inbox.js');
const { enqueueNotification } = await import('../server/services/notification-inbox.js');
const { callTool } = await import('../server/mcp/tools.js');

const d = new Database(':memory:');
d.pragma('foreign_keys = ON');
d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT)');
for (const migration of ALL_MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
  migration.afterUp?.(d);
  d.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)').run(migration.version,migration.description);
}
_setTestDatabase(d);
const member = (name,role='member') => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES (?,?,'x',?,'child')").run(name,name,role).lastInsertRowid);
const admin=member('Release Admin','admin'), learner=member('Release Learner'), other=member('Release Other');
function seed(title='Owned security task',assigned=learner) {
  const id=Number(d.prepare('INSERT INTO tasks(title,description,assigned_to,created_by,due_date,countdown) VALUES (?, ?, ?, ?, ?,1)').run(title,'- [ ] Protected checklist',assigned,admin,new Date().toISOString().slice(0,10)).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES (?,?)').run(id,assigned);
  return d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}
const owned=seed(), hidden=seed('Secretrelease hidden laundry',other);
const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));
app.use((req,_res,next)=>{
  const actor=d.prepare('SELECT * FROM users WHERE id=?').get(Number(req.headers['x-user']||learner));
  req.authUserId=actor.id;req.authRole=actor.role;req.authMethod='session';
  req.session={userId:actor.id,role:actor.role,csrfToken:'release-security-csrf'};
  req.sessionModuleAccess=buildSessionModuleAccess(resolvePermissions(d,actor));next();
});
app.use('/api/v1/tasks',tasksRouter);app.use('/api/tasks',tasksRouter);
app.use('/api/v1/automation',automationRouter);app.use('/reader',readerRouter);
app.use('/api/v1/search',searchRouter);app.use('/api/v1/dashboard',dashboardRouter);
app.use('/api/v1/rewards',rewardsRouter);app.use('/api/v1/planning',planningRouter);
app.use('/api/v1/housekeeping',housekeepingRouter);
app.use('/api/v1/notifications',buildInboxRouter({database:d}));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.close();d.close();});
test.beforeEach(()=>{
  d.prepare('DELETE FROM access_capabilities').run();d.prepare('DELETE FROM access_permissions').run();
  replaceSubjectPermissions(d,'user',learner,{capabilities:RESTRICTED_MEMBER_CAPABILITIES});
});
async function request(method,path,body,userId=learner) {
  const res=await fetch(base+path,{method,redirect:'manual',headers:{'Content-Type':'application/json','x-user':String(userId)},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:res.status,data,text};
}
const revision=id=>d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision;
const encodedId=id=>[...String(id)].map(c=>`%${c.charCodeAt(0).toString(16)}`).join('');

for(const suffix of ['trailing slash','encoded ID','numeric alias','case variant']) {
  test(`Task capabilities cannot be bypassed by ${suffix}`,async()=>{
    const task=seed();
    const path=suffix==='trailing slash'?`${task.id}/`:suffix==='encoded ID'?encodedId(task.id):suffix==='numeric alias'?`${task.id}.0`:`${task.id}`;
    const response=await request('PUT',`/api/v1/${suffix==='case variant'?'TASKS':'tasks'}/${path}`,{points:777,expected_revision:revision(task.id)});
    assert.ok([400,403,404].includes(response.status),JSON.stringify(response));
    assert.equal(d.prepare('SELECT points FROM tasks WHERE id=?').get(task.id).points,0);
  });
}
test('checklist completion capability covers encoded IDs, suffix junk and trailing slash',async()=>{
  replaceSubjectPermissions(d,'user',learner,{capabilities:{...RESTRICTED_MEMBER_CAPABILITIES,'tasks.complete_own':'none'}});
  for(const path of [`${encodedId(owned.id)}/check`,`${owned.id}junk/check`,`${owned.id}/check/`,`${owned.id}/CHECK`]) {
    const response=await request('PATCH',`/api/v1/tasks/${path}`,{line:0,checked:true,expected_revision:revision(owned.id)});
    assert.ok([400,403,404].includes(response.status),`${path}: ${JSON.stringify(response)}`);
    assert.equal(d.prepare('SELECT description FROM tasks WHERE id=?').get(owned.id).description,'- [ ] Protected checklist');
  }
});
test('Housekeeping deletion and payment cannot bypass linked Task restrictions using aliases',async()=>{
  const visit=Number(d.prepare("INSERT INTO housekeeping_work_sessions(check_in,daily_rate,created_by,payment_task_id) VALUES ('2027-01-01T09:00:00Z',10,?,?)").run(admin,owned.id).lastInsertRowid);
  replaceSubjectPermissions(d,'user',learner,{capabilities:{...RESTRICTED_MEMBER_CAPABILITIES,'tasks.complete_own':'none'}});
  for(const [method,path] of [['DELETE',`/visits/${encodedId(visit)}`],['DELETE',`/visits/${visit}/`],['POST',`/VISITS/${visit}/PAY/`]]) {
    assert.equal((await request(method,`/api/v1/housekeeping${path}`,{expected_revision:revision(owned.id)})).status,403);
    assert.ok(d.prepare('SELECT 1 FROM tasks WHERE id=?').get(owned.id));
    assert.equal(d.prepare('SELECT paid_at FROM housekeeping_work_sessions WHERE id=?').get(visit).paid_at,null);
  }
});
test('normal and compatibility Task endpoints hide inaccessible detail and subordinate resources',async()=>{
  for(const prefix of ['/api/v1/tasks','/api/tasks']) {
    for(const suffix of ['', '/activity','/completions','/comments','/documents'])
      assert.equal((await request('GET',`${prefix}/${hidden.id}${suffix}`)).status,404);
    for(const [method,suffix,body] of [['PUT','',{title:'Hacked'}],['PATCH','/status',{status:'done'}],['PATCH','/archive',{archived:true}],['DELETE','',{}],['POST','/comments',{comment:'Hacked'}]])
      assert.equal((await request(method,`${prefix}/${hidden.id}${suffix}`,{...body,expected_revision:revision(hidden.id)})).status,404);
  }
  assert.equal(d.prepare('SELECT title FROM tasks WHERE id=?').get(hidden.id).title,hidden.title);
});
test('Search and Dashboard do not disclose household Tasks to an own-only member',async()=>{
  const search=await request('GET','/api/v1/search?q=Secretrelease');
  assert.equal(search.status,200);assert.deepEqual(search.data.tasks,[]);
  const dashboard=await request('GET','/api/v1/dashboard');
  assert.equal(dashboard.status,200);assert.doesNotMatch(dashboard.text,/Secretrelease/);
  assert.match(dashboard.text,/Owned security task/);
});
test('Calendar uses the same filtered future Task projection and detail boundary',async()=>{
  const list=await request('GET','/api/v1/tasks?include_future=1');
  assert.equal(list.status,200);assert.doesNotMatch(list.text,/Secretrelease/);
  assert.ok(list.data.data.some(row=>row.id===owned.id));
  assert.equal((await request('GET',`/api/v1/tasks/${hidden.id}`)).status,404);
});
test('notification receipts are re-filtered after an own-only permission change',async()=>{
  d.prepare('DELETE FROM access_capabilities').run();
  const notice=enqueueNotification(d,{userId:learner,sourceKey:'release-hidden-task',category:'tasks',entityType:'task',entityId:hidden.id,title:hidden.title,body:'Hidden work'});
  assert.ok(notice.id);
  replaceSubjectPermissions(d,'user',learner,{capabilities:RESTRICTED_MEMBER_CAPABILITIES});
  const list=await request('GET','/api/v1/notifications/inbox');
  assert.equal(list.status,200);assert.doesNotMatch(list.text,/Secretrelease/);
  assert.equal((await request('GET',`/api/v1/notifications/inbox/${notice.id}`)).status,404);
});
test('Rewards retain value but redact a Task reference outside own-only access',async()=>{
  const id=Number(d.prepare("INSERT INTO reward_ledger(user_id,delta,type,reason,task_id,created_by) VALUES (?,17,'earn',?,?,?)").run(other,hidden.title,hidden.id,admin).lastInsertRowid);
  const response=await request('GET','/api/v1/rewards/ledger');
  assert.equal(response.status,200);assert.doesNotMatch(response.text,/Secretrelease/);
  const row=response.data.data.find(item=>item.id===id);assert.equal(row.delta,17);assert.equal(row.task_id,null);assert.equal(row.reason,null);
});
test('Trips list and itinerary do not bypass the Task projection boundary',async()=>{
  const trip=Number(d.prepare("INSERT INTO trip_plans(name,starts_at,ends_at,created_by) VALUES ('Release security trip','2027-01-01T09:00:00Z','2027-01-03T18:00:00Z',?)").run(admin).lastInsertRowid);
  d.prepare("INSERT INTO trip_tasks(trip_id,task_id,phase) VALUES (?,?,'before_departure')").run(trip,hidden.id);
  for(const path of ['/trips',`/trips/${trip}/itinerary`]) {
    const response=await request('GET',`/api/v1/planning${path}`);assert.equal(response.status,200);assert.doesNotMatch(response.text,/Secretrelease/);
  }
});
test('Reader and MCP cannot create prohibited Tasks or list household-only rows',async()=>{
  assert.equal((await request('POST','/reader/tasks',{csrf:'release-security-csrf',title:'Blocked'})).status,403);
  const reader=await request('GET','/reader?view=tasks');assert.equal(reader.status,200);assert.doesNotMatch(reader.text,/Secretrelease/);
  await assert.rejects(()=>callTool({db:d,actor:{id:learner,role:'member'}},'create_task',{title:'Blocked'}),{status:403});
  const rows=await callTool({db:d,actor:{id:learner,role:'member'}},'list_tasks',{include_future:true});
  assert.ok(rows.some(row=>row.id===owned.id));assert.ok(!rows.some(row=>row.id===hidden.id));
});
test('module revocation caps granular permissions across Task, Search, Calendar and MCP projections',async()=>{
  replaceSubjectPermissions(d,'user',learner,{modules:{tasks:'none'},capabilities:{'tasks.view_own':'allow','tasks.complete_own':'allow'}});
  const list=await request('GET','/api/v1/tasks?include_future=1');assert.equal(list.status,200);assert.deepEqual(list.data.data,[]);
  assert.equal((await request('GET',`/api/v1/tasks/${owned.id}`)).status,404);
  assert.deepEqual((await request('GET','/api/v1/search?q=Owned')).data.tasks,[]);
  assert.deepEqual(await callTool({db:d,actor:{id:learner,role:'member'}},'list_tasks',{}),[]);
});
test('workflow run denial covers trailing slash and case-insensitive route aliases',async()=>{
  for(const path of ['/quick-add/1/create/','/QUICK-ADD/1/CREATE']) {
    const response=await request('POST',`/api/v1/automation${path}`,{});
    assert.equal(response.status,403,JSON.stringify(response));
  }
});
test('compatibility assignment denial covers encoded IDs and trailing slash',async()=>{
  for(const path of [`${encodedId(owned.id)}/assignment`,`${owned.id}/assignment/`]) {
    const response=await request('PUT',`/api/v1/automation/tasks/${path}`,{user_id:other,expected_revision:revision(owned.id)});
    assert.ok([400,403,404].includes(response.status),JSON.stringify(response));
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(owned.id).assigned_to,learner);
  }
});
test('revision-less compatibility claims, reassignments and responses force refresh before mutation',async()=>{
  const task=seed('Revision required compatibility Task');
  replaceSubjectPermissions(d,'user',learner,{capabilities:{'tasks.change_assignment':'allow','tasks.reassign':'allow'}});
  for(const [method,path,body] of [['POST',`/tasks/${task.id}/claim`,{}],['PUT',`/tasks/${encodedId(task.id)}/assignment/`,{user_id:other}]]) {
    const response=await request(method,`/api/v1/automation${path}`,body);
    assert.equal(response.status,428,JSON.stringify(response));assert.equal(response.data.reason,'revision_required');
  }
  const obligation=Number(d.prepare("INSERT INTO planning_obligations(entity_type,entity_id,logical_key,role,responsible_user_id,task_id) VALUES ('task',?,'release-revision-obligation','primary',?,?)").run(task.id,learner,task.id).lastInsertRowid);
  const response=await request('POST',`/api/v1/automation/obligations/${encodedId(obligation)}/respond/`,{action:'accept'});
  assert.equal(response.status,428);assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(task.id).assigned_to,learner);
});
test('stale compatibility assignment cannot overwrite a newer Task revision',async()=>{
  const task=seed('Stale compatibility Task'),expected_revision=revision(task.id);
  d.prepare("UPDATE tasks SET description='Edited by another actor' WHERE id=?").run(task.id);
  const response=await request('PUT',`/api/v1/automation/tasks/${encodedId(task.id)}/assignment/`,{user_id:other,expected_revision},admin);
  assert.equal(response.status,409);assert.equal(response.data.reason,'stale_revision');
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(task.id).assigned_to,learner);
});
