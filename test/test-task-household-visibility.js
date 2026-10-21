import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'task-household-visibility-test';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { replaceSubjectPermissions, resolvePermissions, buildSessionModuleAccess,
  moduleAccessVerdict, MODULE_ACCESS_ALLOW } = await import('../server/permissions.js');
const { moduleForPath, requiredAccess } = await import('../server/scopes.js');
const { RESTRICTED_MEMBER_CAPABILITIES } = await import('../server/task-capabilities.js');
const { taskCapabilities } = await import('../server/services/task-access.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: readerRouter } = await import('../server/routes/reader.js');
const {captureTaskListClock,recordTaskListDelta,trackableTaskListRoot}=await import('../server/services/task-list-delta.js');

const d = new Database(':memory:');
d.pragma('foreign_keys = ON');
d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT)');
for (const migration of ALL_MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
  migration.afterUp?.(d);
  d.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)').run(migration.version, migration.description);
}
_setTestDatabase(d);
const member = (name, role = 'member', familyRole = 'parent') => Number(d.prepare(`INSERT INTO users
  (username,display_name,password_hash,role,family_role) VALUES (?,?,'x',?,?)`).run(name, name, role, familyRole).lastInsertRowid);
const creator = member('Task creator');
const eleanor = member('Eleanor', 'member', 'child');
const householdViewer = member('Household viewer');
const administrator = member('Other administrator', 'admin');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => {
  const actor = d.prepare('SELECT * FROM users WHERE id=?').get(Number(req.headers['x-user'] || creator));
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = 'session';
  req.session = { userId: actor.id, role: actor.role, csrfToken: 'household-visibility-csrf' };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(d, actor));
  next();
});
// Exercise the same module decision used by index.js, including compatibility
// routes. Aggregate readers apply their own per-module projection checks.
function moduleGuard(req, res, next) {
  const verdict = moduleAccessVerdict(req.sessionModuleAccess, moduleForPath(req.path), requiredAccess(req.method));
  if (verdict !== MODULE_ACCESS_ALLOW) return res.status(403).json({ error: 'Module access denied.' });
  next();
}
app.use('/api/v1', moduleGuard);
app.use('/api', moduleGuard);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/reader', readerRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); d.close(); });
test.beforeEach(() => {
  d.prepare('DELETE FROM access_capabilities').run();
  d.prepare('DELETE FROM access_permissions').run();
});

async function request(method, path, body, userId = creator) {
  const response = await fetch(base + path, {
    method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'x-user': String(userId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text };
}
let sequence = 0;
async function createTask(fields = {}, userId = creator) {
  const payload = { title: `Household visibility Task ${++sequence}`, assigned_to: [eleanor], visibility: 'all', ...fields };
  const response = await request('POST', '/api/v1/tasks', payload, userId);
  assert.equal(response.status, 201, response.text);
  return { payload, task: response.data.data };
}
async function list(userId, query = '', prefix = '/api/v1/tasks') {
  const response = await request('GET', prefix + query, undefined, userId);
  assert.equal(response.status, 200, response.text);
  return response.data.data;
}
test('Task list cursor returns an empty authorized delta and resets on query change',async()=>{
  const full=await request('GET','/api/v1/tasks?status=open',undefined,creator);
  assert.equal(full.status,200,full.text);
  assert.equal(typeof full.data.delta_cursor,'string');
  const same=await request('GET',`/api/v1/tasks?status=open&delta=${encodeURIComponent(full.data.delta_cursor)}`,undefined,creator);
  assert.equal(same.status,200,same.text);
  assert.equal(same.data.reset_required,false);
  assert.deepEqual(same.data.data,[]);
  const changed=await request('GET',`/api/v1/tasks?status=done&delta=${encodeURIComponent(full.data.delta_cursor)}`,undefined,creator);
  assert.equal(changed.status,200,changed.text);
  assert.equal(changed.data.reset_required,true);
  assert.equal(changed.data.data,undefined);
});
test('permission revocation invalidates the list cursor',async()=>{
  const {task}=await createTask({visibility:'all',assigned_to:[eleanor]});
  const first=await request('GET','/api/v1/tasks',undefined,householdViewer);
  assert.ok(first.data.data.some(row=>row.id===task.id));
  replaceSubjectPermissions(d,'user',householdViewer,{capabilities:RESTRICTED_MEMBER_CAPABILITIES});
  const after=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,householdViewer);
  assert.equal(after.status,200,after.text);
  assert.equal(after.data.reset_required,true);
  const fresh=await request('GET','/api/v1/tasks',undefined,householdViewer);
  assert.ok(!fresh.data.data.some(row=>row.id===task.id));
});
test('Task location projection changes invalidate an older list cursor',async()=>{
  const {task}=await createTask({visibility:'all'});
  const first=await request('GET','/api/v1/tasks',undefined,creator);
  d.prepare("INSERT INTO task_locations(task_id,kind,user_label) VALUES(?,'manual','Library')").run(task.id);
  const after=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(after.status,200,after.text);
  assert.equal(after.data.reset_required,true);
});
test('linked document visibility changes invalidate Task card counts',async()=>{
  const {task}=await createTask({visibility:'all'});
  const docId=Number(d.prepare(`INSERT INTO family_documents
    (name,original_name,mime_type,file_size,content_data,created_by)
    VALUES('Synthetic document','synthetic.txt','text/plain',1,'eA==',?)`).run(creator).lastInsertRowid);
  d.prepare('INSERT INTO task_documents(task_id,document_id) VALUES(?,?)').run(task.id,docId);
  const first=await request('GET','/api/v1/tasks',undefined,creator);
  assert.equal(first.status,200,first.text);
  assert.equal(first.data.data.find(row=>row.id===task.id)?.document_count,1);
  d.prepare("UPDATE family_documents SET status='archived' WHERE id=?").run(docId);
  const after=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(after.status,200,after.text);
  assert.equal(after.data.reset_required,true);
  const fresh=await request('GET','/api/v1/tasks',undefined,creator);
  assert.equal(fresh.data.data.find(row=>row.id===task.id)?.document_count,0);
});
test('document access revocation resets a Task cursor before returning private counts',async()=>{
  const {task}=await createTask({visibility:'all'});
  const docId=Number(d.prepare(`INSERT INTO family_documents
    (name,original_name,mime_type,file_size,content_data,created_by,visibility)
    VALUES('Restricted synthetic','synthetic.txt','text/plain',1,'eA==',?,'restricted')`).run(creator).lastInsertRowid);
  d.prepare('INSERT INTO task_documents(task_id,document_id) VALUES(?,?)').run(task.id,docId);
  d.prepare('INSERT INTO family_document_access(document_id,user_id) VALUES(?,?)').run(docId,householdViewer);
  const first=await request('GET','/api/v1/tasks',undefined,householdViewer);
  assert.equal(first.data.data.find(row=>row.id===task.id)?.document_count,1);
  d.prepare('DELETE FROM family_document_access WHERE document_id=? AND user_id=?').run(docId,householdViewer);
  const delta=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,householdViewer);
  assert.equal(delta.data.reset_required,true);
  const fresh=await request('GET','/api/v1/tasks',undefined,householdViewer);
  assert.equal(fresh.data.data.find(row=>row.id===task.id)?.document_count,0);
});
test('Task list delta returns a filtered removal and a newly entered root',async()=>{
  const {task}=await createTask({visibility:'all'});
  const first=await request('GET','/api/v1/tasks?status=open',undefined,creator);
  assert.equal(first.status,200,first.text);
  d.transaction(()=>{const before=captureTaskListClock(d);
    d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id);
    recordTaskListDelta(d,before,[task.id]);
  })();
  const exit=await request('GET',`/api/v1/tasks?status=open&delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(exit.status,200,exit.text);
  assert.equal(exit.data.reset_required,false);
  assert.ok(exit.data.removed.includes(task.id));
  assert.ok(!exit.data.data.some(row=>row.id===task.id));
  d.transaction(()=>{const before=captureTaskListClock(d);
    d.prepare("UPDATE tasks SET status='open' WHERE id=?").run(task.id);
    recordTaskListDelta(d,before,[task.id]);
  })();
  const enter=await request('GET',`/api/v1/tasks?status=open&delta=${encodeURIComponent(exit.data.delta_cursor)}`,undefined,creator);
  assert.equal(enter.status,200,enter.text);
  assert.equal(enter.data.reset_required,false);
  assert.ok(enter.data.data.some(row=>row.id===task.id));
});
test('Task list delta never returns a private row after assignment revocation',async()=>{
  const {task}=await createTask({visibility:'assignees'},creator);
  const first=await request('GET','/api/v1/tasks',undefined,eleanor);
  assert.equal(first.status,200,first.text);
  assert.ok(first.data.data.some(row=>row.id===task.id));
  d.transaction(()=>{const before=captureTaskListClock(d);
    d.prepare('DELETE FROM task_assignments WHERE task_id=? AND user_id=?').run(task.id,eleanor);
    d.prepare('UPDATE tasks SET assigned_to=NULL WHERE id=?').run(task.id);
    recordTaskListDelta(d,before,[task.id]);
  })();
  const after=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,eleanor);
  assert.equal(after.status,200,after.text);
  assert.equal(after.data.reset_required,false);
  assert.deepEqual(after.data.data.filter(row=>row.id===task.id),[]);
  assert.ok(after.data.removed.includes(task.id));
  assert.ok(!after.text.includes(task.title));
});
test('ordinary status route records its authorized delta atomically',async()=>{
  const {task}=await createTask({visibility:'all',points:0});
  const first=await request('GET','/api/v1/tasks?status=open',undefined,creator);
  const changed=await request('PATCH',`/api/v1/tasks/${task.id}/status`,
    {status:'done',expected_revision:task.revision},creator);
  assert.equal(changed.status,200,changed.text);
  const delta=await request('GET',`/api/v1/tasks?status=open&delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(delta.status,200,delta.text);
  assert.equal(delta.data.reset_required,false,'the ordinary status route should have complete root coverage');
  assert.ok(delta.data.removed.includes(task.id));
});
test('ordinary child status refreshes the parent progress through its root delta',async()=>{
  const {task:parent}=await createTask({visibility:'all',points:0});
  const {task:child}=await createTask({parent_task_id:parent.id,visibility:'all',points:0,
    expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(parent.id).revision});
  const first=await request('GET','/api/v1/tasks',undefined,creator);
  const before=first.data.data.find(row=>row.id===parent.id);
  assert.equal(before.subtask_done,0);
  const changed=await request('PATCH',`/api/v1/tasks/${child.id}/status`,
    {status:'done',expected_revision:child.revision,expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(parent.id).revision},creator);
  assert.equal(changed.status,200,changed.text);
  const delta=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(delta.status,200,delta.text);
  assert.equal(delta.data.reset_required,false);
  assert.deepEqual(delta.data.data.map(row=>row.id),[parent.id]);
  assert.equal(delta.data.data[0].subtask_done,1);
});
test('legacy rotation and generated links exclude a Task tree from covered deltas',async()=>{
  const {task:parent}=await createTask({visibility:'all',points:0});
  const {task:child}=await createTask({parent_task_id:parent.id,visibility:'all',points:0,
    expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(parent.id).revision});
  assert.equal(trackableTaskListRoot(d,child.id),parent.id);
  d.prepare("UPDATE tasks SET rotation_group='legacy-cohort' WHERE id=?").run(child.id);
  assert.equal(trackableTaskListRoot(d,parent.id),null);
});
test('two clients see the same authorized edit while a stale competing edit is rejected',async()=>{
  const {task}=await createTask({visibility:'all',points:0});
  const first=await request('GET','/api/v1/tasks',undefined,creator);
  const second=await request('GET','/api/v1/tasks',undefined,creator);
  const saved=await request('PUT',`/api/v1/tasks/${task.id}`,
    {title:'First client won',expected_revision:task.revision},creator);
  assert.equal(saved.status,200,saved.text);
  const stale=await request('PUT',`/api/v1/tasks/${task.id}`,
    {title:'Stale second client',expected_revision:task.revision},creator);
  assert.equal(stale.status,409,stale.text);
  for(const cursor of [first.data.delta_cursor,second.data.delta_cursor]){
    const delta=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(cursor)}`,undefined,creator);
    assert.equal(delta.status,200,delta.text);
    assert.equal(delta.data.reset_required,false);
    assert.equal(delta.data.data.find(row=>row.id===task.id)?.title,'First client won');
  }
});
test('ordinary Task creation enters an existing authorized list without a full scan',async()=>{
  const first=await request('GET','/api/v1/tasks?status=open',undefined,creator);
  assert.equal(first.status,200,first.text);
  const {task}=await createTask({visibility:'all',points:0});
  const delta=await request('GET',`/api/v1/tasks?status=open&delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(delta.status,200,delta.text);
  assert.equal(delta.data.reset_required,false);
  assert.ok(delta.data.data.some(row=>row.id===task.id));
});
test('ordinary title edit refreshes only the changed authorized root',async()=>{
  const {task}=await createTask({visibility:'all',points:0});
  const first=await request('GET','/api/v1/tasks',undefined,creator);
  const edited=await request('PUT',`/api/v1/tasks/${task.id}`,
    {title:'Delta edited title',expected_revision:task.revision},creator);
  assert.equal(edited.status,200,edited.text);
  const delta=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(delta.status,200,delta.text);
  assert.equal(delta.data.reset_required,false);
  assert.deepEqual(delta.data.data.map(row=>row.id),[task.id]);
  assert.equal(delta.data.data[0].title,'Delta edited title');
});
test('archive and restore move an ordinary Task in and out of the active query',async()=>{
  const {task}=await createTask({visibility:'all',points:0});
  const first=await request('GET','/api/v1/tasks',undefined,creator);
  const archived=await request('PATCH',`/api/v1/tasks/${task.id}/archive`,{archived:true,expected_revision:task.revision},creator);
  assert.equal(archived.status,200,archived.text);
  const exit=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(exit.data.reset_required,false);
  assert.ok(exit.data.removed.includes(task.id));
  const restored=await request('PATCH',`/api/v1/tasks/${task.id}/archive`,{archived:false,expected_revision:archived.data.data.revision},creator);
  assert.equal(restored.status,200,restored.text);
  const enter=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(exit.data.delta_cursor)}`,undefined,creator);
  assert.equal(enter.data.reset_required,false);
  assert.ok(enter.data.data.some(row=>row.id===task.id));
});
test('deleting an ordinary Task yields only its previously visible ID',async()=>{
  const {task}=await createTask({visibility:'all',points:0});
  const first=await request('GET','/api/v1/tasks',undefined,creator);
  const deleted=await request('DELETE',`/api/v1/tasks/${task.id}`,{expected_revision:task.revision},creator);
  assert.equal(deleted.status,200,deleted.text);
  const delta=await request('GET',`/api/v1/tasks?delta=${encodeURIComponent(first.data.delta_cursor)}`,undefined,creator);
  assert.equal(delta.status,200,delta.text);
  assert.equal(delta.data.reset_required,false);
  assert.ok(delta.data.removed.includes(task.id));
  assert.ok(!delta.text.includes(task.title));
});
async function assertAudience(task, userId, visible) {
  assert.equal(taskCapabilities(d, userId, task).view, visible, 'canonical capability result');
  for (const prefix of ['/api/v1/tasks', '/api/tasks']) {
    const first = await list(userId, '', prefix);
    const refreshed = await list(userId, '', prefix);
    assert.equal(first.some(row => row.id === task.id), visible, `${prefix} list audience`);
    assert.deepEqual(refreshed.map(row => row.id), first.map(row => row.id), 'refresh preserves the same audience');
    const detail = await request('GET', `${prefix}/${task.id}`, undefined, userId);
    assert.equal(detail.status, visible ? 200 : 404, `${prefix} detail audience`);
    if (visible) {
      assert.equal(detail.data.data.id, task.id);
      assert.equal(detail.data.data.permissions.view, true);
    }
  }
}

test('creation persists explicit household visibility, actual assignee and creator without changing the audience', async () => {
  const { payload, task } = await createTask();
  const persisted = d.prepare('SELECT created_by,assigned_to,visibility,status,archived_at,parent_task_id FROM tasks WHERE id=?').get(task.id);
  assert.deepEqual(persisted, {
    created_by: creator, assigned_to: eleanor, visibility: payload.visibility,
    status: 'open', archived_at: null, parent_task_id: null,
  });
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id), [{ user_id: eleanor }]);
  assert.equal(task.visibility, 'all');
  assert.deepEqual(task.assigned_users.map(user => user.id), [eleanor]);
  for (const userId of [creator, householdViewer, eleanor]) await assertAudience(task, userId, true);
});

test('an explicit assignee filter narrows the list without changing household Task authorization', async () => {
  const { task } = await createTask();
  assert.ok((await list(creator, `?assigned_to=${eleanor}`)).some(row => row.id === task.id));
  assert.ok(!(await list(creator, `?assigned_to=${creator}`)).some(row => row.id === task.id));
  assert.equal((await request('GET', `/api/v1/tasks/${task.id}`, undefined, creator)).status, 200);
});

test('Not Started and In Progress household Tasks both appear under the normal active status filter', async () => {
  const { task } = await createTask();
  const active = '?status=open&status=in_progress';
  assert.ok((await list(householdViewer, active)).some(row => row.id === task.id && row.status === 'open'));
  const changed = await request('PATCH', `/api/v1/tasks/${task.id}/status`, { status: 'in_progress', expected_revision: task.revision });
  assert.equal(changed.status, 200, changed.text);
  assert.ok((await list(householdViewer, active)).some(row => row.id === task.id && row.status === 'in_progress'));
  await assertAudience(task, householdViewer, true);
});

test('future start is a list scope choice; include_future reveals the authorized Task and detail remains accessible', async () => {
  const { task } = await createTask({ start_date: '2199-01-01' });
  for (const userId of [creator, householdViewer, eleanor]) {
    assert.ok(!(await list(userId)).some(row => row.id === task.id));
    assert.ok((await list(userId, '?include_future=1')).some(row => row.id === task.id));
    assert.equal((await request('GET', `/api/v1/tasks/${task.id}`, undefined, userId)).status, 200);
  }
});

test('private Task stays creator-only despite assignment and an unrelated administrator role', async () => {
  const { task } = await createTask({ visibility: 'private' });
  await assertAudience(task, creator, true);
  for (const userId of [eleanor, householdViewer, administrator]) await assertAudience(task, userId, false);
});

test('assignee-only Task remains limited to creator and explicit assignees', async () => {
  const { task } = await createTask({ visibility: 'assignees' });
  for (const userId of [creator, eleanor]) await assertAudience(task, userId, true);
  for (const userId of [householdViewer, administrator]) await assertAudience(task, userId, false);
});

test('view own Tasks allows the assigned child but does not disclose another member household-visible work', async () => {
  replaceSubjectPermissions(d, 'user', eleanor, { capabilities: RESTRICTED_MEMBER_CAPABILITIES });
  const own = (await createTask()).task;
  const other = (await createTask({ assigned_to: [householdViewer] })).task;
  await assertAudience(own, eleanor, true);
  await assertAudience(other, eleanor, false);
});

test('granting household viewing reveals household Tasks without revealing private or other assignee-only Tasks', async () => {
  replaceSubjectPermissions(d, 'user', eleanor, { capabilities: {
    ...RESTRICTED_MEMBER_CAPABILITIES, 'tasks.view_household': 'allow',
  } });
  const shared = (await createTask({ assigned_to: [householdViewer] })).task;
  const privateTask = (await createTask({ assigned_to: [householdViewer], visibility: 'private' })).task;
  const ownOnly = (await createTask({ assigned_to: [householdViewer], visibility: 'assignees' })).task;
  await assertAudience(shared, eleanor, true);
  await assertAudience(privateTask, eleanor, false);
  await assertAudience(ownOnly, eleanor, false);
});

test('module denial caps household capability on normal and compatibility Task APIs', async () => {
  const { task } = await createTask();
  replaceSubjectPermissions(d, 'user', householdViewer, {
    modules: { tasks: 'none' }, capabilities: { 'tasks.view_household': 'allow' },
  });
  assert.equal(taskCapabilities(d, householdViewer, task).view, false);
  for (const prefix of ['/api/v1/tasks', '/api/tasks']) {
    assert.equal((await request('GET', prefix, undefined, householdViewer)).status, 403);
    assert.equal((await request('GET', `${prefix}/${task.id}`, undefined, householdViewer)).status, 403);
  }
});

test('read-only Task module retains household visibility while denying Task creation', async () => {
  const { task } = await createTask();
  replaceSubjectPermissions(d, 'user', householdViewer, { modules: { tasks: 'read' } });
  await assertAudience(task, householdViewer, true);
  assert.equal((await request('POST', '/api/v1/tasks', { title: 'Denied create', visibility: 'all' }, householdViewer)).status, 403);
});

test('Reader and Dashboard expose authorized household Tasks and honor own-only restrictions', async () => {
  const { task } = await createTask({ title: 'Visible on aggregate surfaces', due_date: '2000-01-01', priority: 'urgent' });
  const dashboard = await request('GET', '/api/v1/dashboard', undefined, householdViewer);
  assert.equal(dashboard.status, 200, dashboard.text);
  assert.ok(dashboard.data.urgentTasks.some(row => row.id === task.id));
  const reader = await request('GET', '/reader?view=tasks', undefined, householdViewer);
  assert.equal(reader.status, 200, reader.text);
  assert.ok(reader.text.includes(task.title));
  replaceSubjectPermissions(d, 'user', householdViewer, { capabilities: RESTRICTED_MEMBER_CAPABILITIES });
  const restrictedDashboard = await request('GET', '/api/v1/dashboard', undefined, householdViewer);
  assert.ok(!restrictedDashboard.data.urgentTasks.some(row => row.id === task.id));
  const restrictedReader = await request('GET', '/reader?view=tasks', undefined, householdViewer);
  assert.ok(!restrictedReader.text.includes(task.title));
});
