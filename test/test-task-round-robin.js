import { modernTaskFetch } from './helpers/task-client-revision-fixture.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const {convertLegacyRotationGroups}=await import('../server/services/legacy-rotation-conversion.js');
const {ensureSeriesDefinition}=await import('../server/services/task-series.js');

function buildTestDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const migration of ALL_MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const db = buildTestDb();
_setTestDatabase(db);

function addUser(username, displayName, role = 'member') {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, '$2b$12$x', ?)
  `).run(username, displayName, role).lastInsertRowid);
}

const admin = addUser('admin', 'Admin', 'admin');
const grace = addUser('grace', 'Grace');
const eleanor = addUser('eleanor', 'Eleanor');
const frank = addUser('frank', 'Frank');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(() => server.close());

async function call(method, path, body) {
  const response = await modernTaskFetch(db,`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function followupOf(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? ORDER BY id LIMIT 1').get(taskId);
}

function assignmentIds(taskId) {
  return db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
    .all(taskId).map((row) => row.user_id);
}

function rotationIds(taskId) {
  return db.prepare('SELECT user_id FROM task_rotation_members WHERE task_id = ? ORDER BY sort_order')
    .all(taskId).map((row) => row.user_id);
}

test('round robin advances one member for each recurring occurrence and wraps', async () => {
  const created = await call('POST', '', {
    title: 'Take Shower - 1st',
    due_date: new Date().toISOString().slice(0, 10),
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, eleanor, frank],
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = db.prepare('SELECT * FROM tasks WHERE id = ?').get(created.body.data.id);
  assert.equal(first.assignment_mode, 'round_robin');
  assert.equal(first.rotation_index, 0);
  assert.equal(first.assigned_to, grace);
  assert.deepEqual(assignmentIds(first.id), [grace]);
  assert.deepEqual(rotationIds(first.id), [grace, eleanor, frank]);
  assert.deepEqual(created.body.data.rotation_user_ids, [grace, eleanor, frank]);

  assert.equal((await call('PATCH', `/${first.id}/status`, { status: 'done' })).status, 200);
  const second = followupOf(first.id);
  assert.ok(second);
  assert.equal(second.rotation_index, 1);
  assert.equal(second.assigned_to, eleanor);
  assert.deepEqual(assignmentIds(second.id), [eleanor]);
  assert.deepEqual(rotationIds(second.id), [grace, eleanor, frank]);

  assert.equal((await call('PATCH', `/${second.id}/status`, { status: 'done' })).status, 200);
  const third = followupOf(second.id);
  assert.ok(third);
  assert.equal(third.rotation_index, 2);
  assert.equal(third.assigned_to, frank);

  assert.equal((await call('PATCH', `/${third.id}/status`, { status: 'done' })).status, 200);
  const fourth = followupOf(third.id);
  assert.ok(fourth);
  assert.equal(fourth.rotation_index, 0);
  assert.equal(fourth.assigned_to, grace);
});

test('fixed recurring assignment remains unchanged', async () => {
  const created = await call('POST', '', {
    title: 'Fixed recurring task',
    due_date: new Date().toISOString().slice(0, 10),
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assigned_to: [grace],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.assignment_mode, 'fixed');

  await call('PATCH', `/${created.body.data.id}/status`, { status: 'done' });
  const next = followupOf(created.body.data.id);
  assert.equal(next.assigned_to, grace);
  assert.deepEqual(assignmentIds(next.id), [grace]);
  assert.deepEqual(rotationIds(next.id), []);
});

test('round robin requires a recurring top-level task and at least two members', async () => {
  const nonRecurring = await call('POST', '', {
    title: 'Invalid round robin',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, eleanor],
  });
  assert.equal(nonRecurring.status, 400);

  const oneMember = await call('POST', '', {
    title: 'Invalid one-person rotation',
    due_date: new Date().toISOString().slice(0, 10),
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace],
  });
  assert.equal(oneMember.status, 400);
});


test('rotation group advances the whole cohort atomically and preserves slot offsets', async () => {
  const due = new Date().toISOString().slice(0, 10);
  const group = `Shower order ${Date.now()}`;
  const common = {
    due_date: due,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, eleanor, frank],
    rotation_group: group,
  };

  const first = await call('POST', '', { ...common, title: 'Shower - 1st', rotation_slot: 0 });
  const second = await call('POST', '', { ...common, title: 'Shower - 2nd', rotation_slot: 1 });
  const third = await call('POST', '', { ...common, title: 'Shower - 3rd', rotation_slot: 2 });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(third.status, 201, JSON.stringify(third.body));
  assert.equal(first.body.data.assigned_to, grace);
  assert.equal(second.body.data.assigned_to, eleanor);
  assert.equal(third.body.data.assigned_to, frank);

  await call('PATCH', `/${first.body.data.id}/status`, { status: 'done' });
  assert.equal(followupOf(first.body.data.id), undefined);
  await call('PATCH', `/${second.body.data.id}/status`, { status: 'done' });
  assert.equal(followupOf(second.body.data.id), undefined);
  await call('PATCH', `/${third.body.data.id}/status`, { status: 'done' });

  const nextFirst = followupOf(first.body.data.id);
  const nextSecond = followupOf(second.body.data.id);
  const nextThird = followupOf(third.body.data.id);
  assert.ok(nextFirst && nextSecond && nextThird);
  assert.equal(nextFirst.rotation_cycle, 1);
  assert.equal(nextSecond.rotation_cycle, 1);
  assert.equal(nextThird.rotation_cycle, 1);
  assert.equal(nextFirst.rotation_index, 1);
  assert.equal(nextFirst.assigned_to, eleanor);
  assert.equal(nextSecond.assigned_to, frank);
  assert.equal(nextThird.assigned_to, grace);

  // Reopening any source member removes the whole untouched generated cohort.
  const reopened = await call('PATCH', `/${second.body.data.id}/status`, { status: 'open', reset_progress:true });
  assert.equal(reopened.status, 200);
  assert.equal(followupOf(first.body.data.id), undefined);
  assert.equal(followupOf(second.body.data.id), undefined);
  assert.equal(followupOf(third.body.data.id), undefined);
});

test('mapped legacy cohort keeps distinct offsets after a full status cycle', async()=>{
  const due=new Date().toISOString().slice(0,10),key=`Imported rotation ${Date.now()}`;
  const common={due_date:due,is_recurring:1,recurrence_rule:'FREQ=DAILY',assignment_mode:'round_robin',
    rotation_user_ids:[grace,eleanor,frank],rotation_group:key};
  const first=await call('POST','',{...common,title:'Imported first',rotation_slot:0});
  const second=await call('POST','',{...common,title:'Imported second',rotation_slot:1});
  assert.equal(first.status,201);assert.equal(second.status,201);
  db.transaction(()=>convertLegacyRotationGroups(db))();
  const mapped=db.prepare('SELECT group_id FROM legacy_rotation_group_mappings WHERE source_key=?').get(key);
  assert.ok(mapped);
  const detail=await call('GET',`/${first.body.data.id}`);
  assert.equal(detail.status,200);assert.equal(detail.body.data.legacy_rotation_group.group_id,mapped.group_id);
  assert.equal(detail.body.data.legacy_rotation_group.slot,1);
  assert.equal((await call('PATCH',`/${first.body.data.id}/status`,{status:'done'})).status,200);
  assert.equal(followupOf(first.body.data.id),undefined);
  assert.equal((await call('PATCH',`/${second.body.data.id}/status`,{status:'done'})).status,200);
  assert.equal(followupOf(first.body.data.id).assigned_to,eleanor);
  assert.equal(followupOf(second.body.data.id).assigned_to,frank);
  assert.equal((await call('GET',`/${followupOf(first.body.data.id).id}`)).body.data.legacy_rotation_group.group_id,mapped.group_id);
});

test('editing a mapped cohort roster invalidates its Group projection without changing the saved cursor',async()=>{
  const key=`Mapped edit ${Date.now()}`,due=new Date().toISOString().slice(0,10);
  const created=await call('POST','',{title:'Mapped edit',due_date:due,is_recurring:1,recurrence_rule:'FREQ=DAILY',
    assignment_mode:'round_robin',rotation_user_ids:[grace,eleanor,frank],rotation_group:key,rotation_slot:0});
  assert.equal(created.status,201);
  db.transaction(()=>convertLegacyRotationGroups(db))();
  const id=created.body.data.id;
  assert.ok((await call('GET',`/${id}`)).body.data.legacy_rotation_group);
  const changed=await call('PUT',`/${id}`,{title:'Mapped edit',due_date:due,is_recurring:1,recurrence_rule:'FREQ=DAILY',
    assignment_mode:'round_robin',rotation_user_ids:[eleanor,grace,frank],rotation_group:key,rotation_slot:0});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  assert.equal(db.prepare('SELECT is_current FROM legacy_rotation_group_mappings WHERE source_key=?').get(key).is_current,0);
  assert.equal((await call('GET',`/${id}`)).body.data.legacy_rotation_group,null);
  assert.equal(db.prepare('SELECT rotation_index FROM tasks WHERE id=?').get(id).rotation_index,0);
});

test('single legacy series converts its future turn to a Group without changing the current Task',async()=>{
  const key=`Solo conversion ${Date.now()}`,due=new Date().toISOString().slice(0,10);
  const created=await call('POST','',{title:'Solo rotation',due_date:due,is_recurring:1,recurrence_rule:'FREQ=DAILY',
    assignment_mode:'round_robin',rotation_user_ids:[grace,eleanor,frank],rotation_group:key,rotation_slot:0});
  assert.equal(created.status,201);
  const id=created.body.data.id,source=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  ensureSeriesDefinition(db,id);
  db.transaction(()=>convertLegacyRotationGroups(db))();
  const map=db.prepare('SELECT * FROM legacy_rotation_group_mappings WHERE source_key=?').get(key);
  assert.equal(map.compatibility_mode,'converted_independent');
  assert.equal(db.prepare('SELECT * FROM tasks WHERE id=?').get(id).assigned_to,source.assigned_to);
  assert.equal(db.prepare('SELECT * FROM tasks WHERE id=?').get(id).rotation_group,key);
  const nextDef=db.prepare('SELECT definition_json FROM task_recurrence_definitions WHERE series_id=? ORDER BY id DESC LIMIT 1')
    .get(db.prepare('SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?').get(id).series_id);
  assert.equal(JSON.parse(nextDef.definition_json).task.assignment_mode,'fixed');
  assert.equal((await call('PATCH',`/${id}/status`,{status:'done'})).status,200);
  const followup=followupOf(id);assert.ok(followup);
  assert.equal(followup.assigned_to,eleanor);
  assert.equal(followup.assignment_mode,'fixed');
  assert.equal(JSON.parse(followup.assignment_group_json).group_id,map.group_id);
  assert.equal(followup.rotation_group,null);
  assert.equal((await call('PATCH',`/${followup.id}/status`,{status:'done'})).status,200);
  assert.equal(followupOf(followup.id).assigned_to,frank);
});

test('editing the current legacy Task title keeps its converted future Group assignment',async()=>{
  const key=`Solo future edit ${Date.now()}`,due=new Date().toISOString().slice(0,10);
  const created=await call('POST','',{title:'Before rename',due_date:due,is_recurring:1,recurrence_rule:'FREQ=DAILY',
    assignment_mode:'round_robin',rotation_user_ids:[grace,eleanor,frank],rotation_group:key,rotation_slot:0});
  assert.equal(created.status,201);
  const id=created.body.data.id;
  ensureSeriesDefinition(db,id);
  db.transaction(()=>convertLegacyRotationGroups(db))();
  const seriesId=db.prepare('SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?').get(id).series_id;
  const seriesRevision=db.prepare('SELECT revision FROM task_recurrence_series WHERE series_id=?').get(seriesId).revision;
  const edited=await call('PUT',`/${id}`,{title:'After rename',due_date:due,is_recurring:1,recurrence_rule:'FREQ=DAILY',
    assignment_mode:'round_robin',rotation_user_ids:[grace,eleanor,frank],rotation_group:key,rotation_slot:0,
    edit_scope:'future',expected_series_revision:seriesRevision});
  assert.equal(edited.status,200,JSON.stringify(edited.body));
  assert.equal((await call('PATCH',`/${id}/status`,{status:'done'})).status,200);
  const next=followupOf(id);
  assert.ok(next);
  assert.equal(next.assigned_to,eleanor);
  assert.equal(next.assignment_mode,'fixed');
  assert.equal(JSON.parse(next.assignment_group_json).group_id,
    db.prepare('SELECT group_id FROM legacy_rotation_group_mappings WHERE source_key=?').get(key).group_id);
});

test('rotation group rejects roster mismatch and duplicate positions', async () => {
  const due = new Date().toISOString().slice(0, 10);
  const group = `Validation group ${Date.now()}`;
  const first = await call('POST', '', {
    title: 'Grouped first', due_date: due, is_recurring: 1, recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin', rotation_user_ids: [grace, eleanor, frank],
    rotation_group: group, rotation_slot: 0,
  });
  assert.equal(first.status, 201);

  const duplicate = await call('POST', '', {
    title: 'Duplicate slot', due_date: due, is_recurring: 1, recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin', rotation_user_ids: [grace, eleanor, frank],
    rotation_group: group, rotation_slot: 0,
  });
  assert.equal(duplicate.status, 400);

  const mismatch = await call('POST', '', {
    title: 'Mismatched roster', due_date: due, is_recurring: 1, recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin', rotation_user_ids: [eleanor, grace, frank],
    rotation_group: group, rotation_slot: 1,
  });
  assert.equal(mismatch.status, 400);
});

test('rotation group undo preserves the entire next cohort when one followup is touched', async () => {
  const due = new Date().toISOString().slice(0, 10);
  const group = `Touched group ${Date.now()}`;
  const common = {
    due_date: due, is_recurring: 1, recurrence_rule: 'FREQ=DAILY', assignment_mode: 'round_robin',
    rotation_user_ids: [grace, eleanor], rotation_group: group,
  };
  const a = await call('POST', '', { ...common, title: 'A', rotation_slot: 0 });
  const b = await call('POST', '', { ...common, title: 'B', rotation_slot: 1 });
  await call('PATCH', `/${a.body.data.id}/status`, { status: 'done' });
  await call('PATCH', `/${b.body.data.id}/status`, { status: 'done' });
  const nextA = followupOf(a.body.data.id);
  const nextB = followupOf(b.body.data.id);
  assert.ok(nextA && nextB);

  // An added subtask is user work according to Yuvomi's existing safe-undo rule.
  db.prepare(`INSERT INTO tasks (title, category, priority, status, created_by, parent_task_id, visibility)
              VALUES ('Touched child', 'misc', 'none', 'open', ?, ?, 'all')`).run(admin, nextA.id);

  await call('PATCH', `/${a.body.data.id}/status`, { status: 'open' });
  assert.ok(db.prepare('SELECT id FROM tasks WHERE id = ?').get(nextA.id));
  assert.ok(db.prepare('SELECT id FROM tasks WHERE id = ?').get(nextB.id));
});
