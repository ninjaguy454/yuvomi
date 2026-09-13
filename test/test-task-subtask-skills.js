import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET = 'task-subtask-skills-test-secret';
const { get } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
const { default: idempotency } = await import('../server/middleware/idempotency.js');
const { instantiateWorkflow } = await import('../server/services/activity-workflows.js');
const d = get();
const user = (name, role = 'admin') => Number(d.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
  VALUES (?,?,'x',?,'parent')`).run(name, name, role).lastInsertRowid);
const admin = user('skill-admin');
const other = user('skill-other', 'member');
let actor = admin;
const skill = (name, settings = {}) => Number(d.prepare(`INSERT INTO skills(name,minimum_age,age_promotion,adult_only)
  VALUES (?,0,?,?)`).run(name, settings.promotion || 'normal', settings.adultOnly ? 1 : 0).lastInsertRowid);
const firstSkill = skill('Knife safety');
const secondSkill = skill('Measuring');
function proficiency(id, userId, value) {
  d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES (?,?,?)
    ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`).run(userId, id, value);
}
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = actor === admin ? 'admin' : 'member';
  req.authUserId = actor; req.authRole = role; req.session = { userId: actor, role }; next();
});
let dropResponse = false;
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (dropResponse && req.originalUrl === '/api/v1/tasks' && res.statusCode === 201) {
      dropResponse = false; req.socket.destroy(); return res;
    }
    return json(body);
  };
  next();
});
app.use('/api/v1', idempotency);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/automation', automationRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => { server.close(); d.close(); });
test.afterEach(() => { actor = admin; });
async function call(method, path, body, key) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}
async function create(body) {
  const response = await call('POST', '/tasks', body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}
async function template(body = {}) {
  const response = await call('POST', '/automation/admin/activity-templates', {
    name: 'Reusable household work', title_template: 'Household work', assignment_strategy: 'fixed',
    fixed_user_id: admin, subject_required: false, ...body,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

test('manual Task and inline subtasks persist independent skill IDs, edits and copies', async () => {
  const task = await create({ title: 'Cook dinner', skill_ids: [firstSkill], subtasks: [
    { title: 'Measure flour', skill_ids: [secondSkill] }, { title: 'Set table' },
  ] });
  assert.deepEqual(task.skill_ids, [firstSkill]);
  assert.deepEqual(task.subtasks.map((item) => item.skill_ids), [[secondSkill], []]);
  const updated = await call('PUT', `/tasks/${task.subtasks[0].id}`, { title: 'Measure carefully', skill_ids: [firstSkill, secondSkill] });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const reloaded = (await call('GET', `/tasks/${task.id}`)).body.data;
  assert.deepEqual(reloaded.subtasks[0].skill_ids, [firstSkill, secondSkill]);
  const copy = await create({ title: 'Copy dinner', skill_ids: reloaded.skill_ids,
    subtasks: reloaded.subtasks.map(({ title, skill_ids }) => ({ title, skill_ids })) });
  assert.deepEqual(copy.subtasks.map((item) => item.skill_ids), [[firstSkill, secondSkill], []]);
  assert.notEqual(copy.subtasks[0].id, task.subtasks[0].id);
  assert.equal((await call('PUT', `/tasks/${copy.subtasks[0].id}`, { skill_ids: [] })).status, 200);
  assert.deepEqual((await call('GET', `/tasks/${task.id}`)).body.data.subtasks[0].skill_ids, [firstSkill, secondSkill]);
});

test('invalid inline skills are atomic and a lost response retries the entire Task exactly once', async () => {
  const before = d.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  for (const skill_ids of [[99999999], [null], ['bad'], 'Knife safety']) {
    const response = await call('POST', '/tasks', { title: 'Invalid checklist', subtasks: [{ title: 'Prepare', skill_ids }] });
    assert.equal(response.status, 400);
  }
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, before);
  const body = { title: 'Lost response with checklist', subtasks: [{ title: 'Only once', skill_ids: [firstSkill] }] };
  dropResponse = true;
  await assert.rejects(call('POST', '/tasks', body, 'subtask-lost-response'));
  const replay = await call('POST', '/tasks', body, 'subtask-lost-response');
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.subtasks.length, 1);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE title IN (?,?)').get(body.title, 'Only once').n, 2);
  assert.deepEqual(replay.body.data.subtasks[0].skill_ids, [firstSkill]);
  const recoveredEdit = await call('PUT', `/tasks/${replay.body.data.id}`, { ...body, title: 'Recovered and edited' });
  assert.equal(recoveredEdit.status, 200, JSON.stringify(recoveredEdit.body));
  const changedChildren = await call('PUT', `/tasks/${replay.body.data.id}`, { ...body, subtasks: [] });
  assert.equal(changedChildren.status, 200, 'Task Edit can now deliberately replace its checklist');
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?').get(replay.body.data.id).n, 0);
});

test('template skills/defaults and checklist skills survive generation but do not inherit onto empty subtasks', async () => {
  const activity = await template({ skill_ids: [firstSkill], priority: 'high', points: 17, tags: ['Kitchen', 'Weekly'],
    checklist: [{ title_template: 'Measure', skill_ids: [secondSkill] }, { title_template: 'Set table' }] });
  const task = await create({ title: 'Template dinner', activity_template_id: activity.id });
  assert.equal(task.priority, 'high'); assert.equal(task.points, 17); assert.deepEqual(task.tags, ['Kitchen', 'Weekly']);
  assert.deepEqual(task.skill_ids, [firstSkill]);
  assert.deepEqual(task.subtasks.map((item) => item.skill_ids), [[secondSkill], []]);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM task_skill_requirements WHERE task_id=?').get(task.id).n, 0);
  const options = (await call('GET', '/automation/activity-options')).body.data;
  const option = options.activities.find((item) => item.id === activity.id);
  assert.deepEqual(option.checklist[0].skill_ids, [secondSkill]);
  assert.deepEqual(option.tags, ['Kitchen', 'Weekly']); assert.equal(option.priority, 'high');
  assert.ok(options.skills.some((item) => item.id === firstSkill));
  const changed = await call('PUT', `/automation/admin/activity-templates/${activity.id}`, {
    checklist: [{ title_template: 'New checklist', skill_ids: [firstSkill] }],
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.data.tags, ['Kitchen', 'Weekly']);
  assert.deepEqual((await call('GET', `/tasks/${task.id}`)).body.data.subtasks.map((item) => item.skill_ids), [[secondSkill], []]);
  const custom = await create({ title: 'Edited template checklist', activity_template_id: activity.id,
    subtasks: [{ title: 'User-authored only', skill_ids: [secondSkill] }] });
  assert.equal(custom.subtasks.length, 1); assert.equal(custom.subtasks[0].title, 'User-authored only');
  const empty = await create({ title: 'Deliberately empty', activity_template_id: activity.id, subtasks: [] });
  assert.equal(empty.subtasks.length, 0);
  const conflict = await call('PUT', `/tasks/${task.id}`, { skill_ids: [secondSkill] });
  assert.equal(conflict.status, 400);
  assert.deepEqual((await call('GET', `/tasks/${task.id}`)).body.data.skill_ids, [firstSkill]);
});

test('partial template checklist edits preserve skills by row identity and reject ambiguous legacy replacement', async () => {
  const activity = await template({ checklist: [{ title_template: 'Original item', skill_ids: [secondSkill] }] });
  const renamed = await call('PUT', `/automation/admin/activity-templates/${activity.id}`, {
    checklist: [{ id: activity.checklist[0].id, title_template: 'Renamed item' }],
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual(renamed.body.data.checklist[0].skill_ids, [secondSkill]);
  assert.equal((await call('PUT', `/automation/admin/activity-templates/${activity.id}`, {
    checklist: [{ title_template: 'Ambiguous old client edit' }],
  })).status, 400);
  const explicitClear = await call('PUT', `/automation/admin/activity-templates/${activity.id}`, {
    checklist: [{ title_template: 'Explicitly cleared', skill_ids: [] }],
  });
  assert.equal(explicitClear.status, 200); assert.deepEqual(explicitClear.body.data.checklist[0].skill_ids, []);
});

test('workflow generation carries reusable defaults and independent checklist skills', async () => {
  const activity = await template({ priority: 'urgent', points: 8, tags: ['Workflow'],
    checklist: [{ title_template: 'Work step', skill_ids: [secondSkill] }] });
  const workflowId = Number(d.prepare("INSERT INTO workflow_templates(name,subject_required) VALUES ('Skills flow',0)").run().lastInsertRowid);
  d.prepare(`INSERT INTO workflow_template_steps(workflow_template_id,step_key,activity_template_id,sort_order)
    VALUES (?,'work',?,0)`).run(workflowId, activity.id);
  const result = instantiateWorkflow(d, workflowId, { createdBy: admin });
  const primary = d.prepare(`SELECT t.* FROM tasks t JOIN workflow_instance_tasks wit ON wit.task_id=t.id
    WHERE wit.workflow_instance_id=? AND wit.role='primary'`).get(result.id || result.instance?.id || result.workflow_instance_id);
  assert.ok(primary); assert.equal(primary.priority, 'urgent'); assert.equal(primary.points, 8);
  assert.deepEqual(d.prepare('SELECT tag FROM task_tags WHERE task_id=?').all(primary.id).map((row) => row.tag), ['Workflow']);
  assert.deepEqual(d.prepare(`SELECT ts.skill_id FROM task_skill_requirements ts JOIN tasks t ON t.id=ts.task_id
    WHERE t.parent_task_id=? ORDER BY ts.sort_order`).all(primary.id).map((row) => row.skill_id), [secondSkill]);
});

test('explicit requirements permit supervised assignment and claim but gate completion using current proficiency', async () => {
  proficiency(firstSkill, other, 'supervised');
  const task = await create({ title: 'Skilled supervised work', skill_ids: [firstSkill] });
  assert.equal(task.supervision.actions.length, 0, 'unassigned work has no hypothetical learner or helper');
  assert.equal((await call('PUT', `/tasks/${task.id}`, { assigned_to: [other] })).status, 200);
  assert.equal((await call('POST', '/tasks', { title: 'Valid learner assignment', skill_ids: [firstSkill], assigned_to: [other] })).status, 201);
  d.prepare(`INSERT INTO task_assignment_context(task_id,strategy,state,source) VALUES (?,'open_claimable','open','planning_context')`).run(task.id);
  d.prepare('INSERT INTO task_claim_eligibility(task_id,user_id) VALUES (?,?)').run(task.id, other);
  actor = other;
  assert.equal((await call('POST', `/automation/tasks/${task.id}/claim`, {})).status, 200);
  const blocked=await call('PATCH', `/tasks/${task.id}/status`, {status:'done'});
  assert.equal(blocked.status,409); assert.match(blocked.body.error,/supervisor|supervised/i);
  proficiency(firstSkill, other, 'excluded');
  assert.equal((await call('PUT', `/tasks/${task.id}`, {status:'done',assigned_to:[other],skill_ids:[firstSkill]})).status,409);
  proficiency(firstSkill, other, 'normal');
  assert.equal((await call('PATCH', `/tasks/${task.id}/status`, {status:'done'})).status,200);
  assert.equal((await call('PATCH', `/tasks/${task.id}/status`, {status:'in_progress'})).status,200);
  proficiency(firstSkill, other, 'excluded');
  assert.equal((await call('PATCH', `/tasks/${task.id}/status`, {status:'done'})).status,409);
  actor=admin;
});

test('renaming and deactivating skills preserves references and delete guards cover both owners', async () => {
  const id = skill('Stable identity');
  const task = await create({ title: 'Stable requirement', skill_ids: [id] });
  assert.equal((await call('PUT', `/automation/admin/skills/${id}`, { name: 'Renamed requirement', active: false })).status, 200);
  const read = (await call('GET', `/tasks/${task.id}`)).body.data;
  assert.deepEqual(read.skill_ids, [id]); assert.equal(read.skills[0].name, 'Renamed requirement');
  assert.equal((await call('DELETE', `/automation/admin/skills/${id}`)).status, 409);
  assert.throws(() => d.prepare('DELETE FROM skills WHERE id=?').run(id), /FOREIGN KEY/);
  await call('PUT', `/tasks/${task.id}`, { skill_ids: [] });
  const activity = await template({ checklist: [{ title_template: 'Required only here', skill_ids: [id] }] });
  assert.equal((await call('DELETE', `/automation/admin/skills/${id}`)).status, 409);
  await call('PUT', `/automation/admin/activity-templates/${activity.id}`, { checklist: [] });
  assert.equal((await call('DELETE', `/automation/admin/skills/${id}`)).status, 204);
});

test('all explicit skills remain enforced when inactive, and locked subtask skills cannot be weakened', async () => {
  proficiency(firstSkill, other, 'normal'); proficiency(secondSkill, other, 'supervised');
  const task = await create({ title: 'All required skills', skill_ids: [firstSkill, secondSkill] });
  d.prepare('UPDATE skills SET active=0 WHERE id=?').run(secondSkill);
  const assigned=await call('PUT', `/tasks/${task.id}`, { assigned_to: [other] });
  assert.equal(assigned.status,200);
  assert.ok(assigned.body.data.supervision.actions.some(action=>action.required_skills.some(skill=>skill.id===secondSkill)));
  const locked = await create({ title: 'Locked parent', locked: true, subtasks: [{ title: 'Skilled subtask', skill_ids: [secondSkill] }] });
  actor = other;
  assert.equal((await call('PUT', `/tasks/${locked.subtasks[0].id}`, { skill_ids: [] })).status, 403);
  const supervised = await call('PUT', `/tasks/${locked.subtasks[0].id}`, { assigned_to: [other] });
  assert.equal(supervised.status, 200, 'assignment can now retain a supervised learner without weakening the locked requirement');
  assert.deepEqual(supervised.body.data.skill_ids,[secondSkill]);
  assert.equal(supervised.body.data.supervision_action.state,'assigned');
  actor = admin;
  d.prepare('UPDATE skills SET active=1 WHERE id=?').run(secondSkill);
});

test('recurrence copies checklist skills and keeps rotation position when the next worker becomes ineligible', async () => {
  proficiency(firstSkill, other, 'normal');
  const task = await create({ title: 'Recurring qualified work', skill_ids: [firstSkill], due_date: '2050-01-01',
    is_recurring: 1, recurrence_rule: 'FREQ=DAILY', assignment_mode: 'round_robin', rotation_user_ids: [admin, other],
    subtasks: [{ title: 'Recurring checklist', skill_ids: [secondSkill] }] });
  proficiency(firstSkill, other, 'excluded');
  assert.equal((await call('PATCH', `/tasks/${task.id}/status`, { status: 'done', complete_remaining: true })).status, 200);
  const next = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(task.id);
  assert.equal(next.rotation_index, 1); assert.equal(next.assigned_to, null);
  const read = (await call('GET', `/tasks/${next.id}`)).body.data;
  assert.deepEqual(read.skill_ids, [firstSkill]); assert.equal(read.skill_assignment_needed, true);
  assert.deepEqual(read.subtasks[0].skill_ids, [secondSkill]);
  assert.deepEqual(read.rotation_user_ids, [admin, other]);
  await call('PUT', `/tasks/${read.subtasks[0].id}`, { skill_ids: [] });
  await call('PATCH', `/tasks/${task.id}/status`, { status: 'open', reset_progress: true });
  assert.ok(d.prepare('SELECT 1 FROM tasks WHERE id=?').get(next.id), 'editing checklist skills protects the followup from undo deletion');
});

test('recurrence without explicit skills preserves legacy primary assignments even without join rows', async () => {
  const task = await create({ title: 'Legacy recurrence', assigned_to: [admin], due_date: '2050-01-01',
    is_recurring: 1, recurrence_rule: 'FREQ=DAILY' });
  const child = await create({ title: 'Legacy child', parent_task_id: task.id, assigned_to: [other] });
  d.prepare('DELETE FROM task_assignments WHERE task_id IN (?,?)').run(task.id, child.id);
  assert.equal((await call('PATCH', `/tasks/${task.id}/status`, { status: 'done', complete_remaining: true })).status, 200);
  const next = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(task.id);
  assert.equal(next.assigned_to, admin);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE parent_task_id=?').get(next.id).assigned_to, other);
});

test('recurrence evaluates subtask skills on its shifted due date across an age boundary', async () => {
  const childWorker = user('age-boundary-worker', 'member');
  d.prepare("INSERT INTO birthdays(name,birth_date,created_by,family_user_id) VALUES ('Age boundary','2038-02-15',?,?)").run(admin, childWorker);
  const ageSkill = skill('Independent preparation at twelve');
  d.prepare('UPDATE skills SET minimum_age=12 WHERE id=?').run(ageSkill);
  const root = await create({ title: 'Parent with later preparation', due_date: '2050-01-01', is_recurring: 1, recurrence_rule: 'FREQ=DAILY' });
  const child = await create({ title: 'Work after birthday', parent_task_id: root.id, due_date: '2050-02-20', skill_ids: [ageSkill], assigned_to: [childWorker] });
  assert.equal((await call('PATCH', `/tasks/${root.id}/status`, { status: 'done', complete_remaining: true })).status, 200);
  const next = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=?').get(child.id);
  assert.equal(next.due_date, '2050-02-21');
  assert.equal(next.assigned_to, childWorker, 'the earlier parent date must not disqualify work due after the birthday');
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(next.id).map((row) => row.user_id), [childWorker]);
});

test('undated explicit subtasks evaluate age at the inherited parent occurrence date', async () => {
  const currentYear = new Date().getUTCFullYear();
  const childWorker = user('undated-age-worker', 'member');
  d.prepare('INSERT INTO birthdays(name,birth_date,created_by,family_user_id) VALUES (?,?,?,?)')
    .run('Undated age', `${currentYear - 17}-01-01`, admin, childWorker);
  const ageSkill = skill('Independent preparation at eighteen');
  d.prepare('UPDATE skills SET minimum_age=18 WHERE id=?').run(ageSkill);
  proficiency(ageSkill, childWorker, 'normal');
  const root = await create({ title: 'Future parent with undated work', due_date: `${currentYear + 1}-01-01`, is_recurring: 1, recurrence_rule: 'FREQ=DAILY' });
  const child = await create({ title: 'Undated preparation', parent_task_id: root.id, skill_ids: [ageSkill], assigned_to: [childWorker] });
  d.prepare('DELETE FROM user_skill_proficiency WHERE user_id=? AND skill_id=?').run(childWorker, ageSkill);
  const completed=await call('PATCH', `/tasks/${root.id}/status`, { status: 'done', complete_remaining: true });
  assert.equal(completed.status,200,JSON.stringify(completed.body));
  const next = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=?').get(child.id);
  assert.ok(next,'the planned occurrence is after the worker reaches the required age');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child.id).status,'done');
});

test('both archive API forms retire linked supervision and restore the same helper work',async()=>{
  const required=skill('Archived supervised action'); proficiency(required,other,'supervised'); proficiency(required,admin,'normal');
  const root=await create({title:'Archive original work',assigned_to:[other],subtasks:[{title:'Supervised action',skill_ids:[required]}]});
  const original=(await call('GET',`/tasks/${root.id}`)).body.data;
  const supportId=original.supervision.support_task_id, counterpartId=original.supervision.actions[0].counterpart_task_id;
  assert.ok(supportId); assert.ok(counterpartId);
  for(const path of [`/tasks/${root.id}/archive`,`/tasks/${root.id}/status`]) {
    const response=await call('PATCH',path,path.endsWith('/status')?{status:'archived'}:{archived:true});
    assert.equal(response.status,200,JSON.stringify(response.body));
    for(const id of [supportId,counterpartId]) assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(id).archived_at);
    const blocked=await call('PATCH',`/tasks/${counterpartId}/status`,{status:'done'});
    assert.equal(blocked.status,409); assert.match(blocked.body.error,/Restore the original/);
    const restored=await call('PATCH',`/tasks/${root.id}/archive`,{archived:false});
    assert.equal(restored.status,200,JSON.stringify(restored.body));
    for(const id of [supportId,counterpartId]) assert.equal(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(id).archived_at,null);
  }
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(root.id).n,1);
});

test('deleting a source action or replacing the checklist cannot leave orphan supervisor counterparts',async()=>{
  const required=skill('Removable supervised action'); proficiency(required,other,'supervised'); proficiency(required,admin,'normal');
  for(const method of ['DELETE','PUT']) {
    const root=await create({title:`Remove ${method} source action`,assigned_to:[other],subtasks:[{title:'Remove this action',skill_ids:[required]}]});
    const initial=(await call('GET',`/tasks/${root.id}`)).body.data;
    const action=initial.supervision.actions[0], supportId=initial.supervision.support_task_id;
    const response=await call(method,method==='DELETE'?`/tasks/${action.action_task_id}`:`/tasks/${root.id}`,method==='PUT'?{subtasks:[]}:undefined);
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(d.prepare('SELECT id FROM tasks WHERE id=?').get(action.counterpart_task_id),undefined);
    assert.equal(d.prepare('SELECT id FROM task_supervision_actions WHERE id=?').get(action.id),undefined);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id=?').get(supportId).n,0);
    assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(supportId).archived_at,'empty helper container is retired');
    assert.equal(d.prepare('SELECT id FROM tasks WHERE id=?').get(root.id).id,root.id);
  }
});

test('root skill/date edits preserve child-only participants without inheriting requirements', async () => {
  const rootWorker = user('root-skilled-worker', 'member');
  const extraRequirement = skill('Parent planning');
  proficiency(firstSkill, other, 'excluded'); proficiency(secondSkill, other, 'normal');
  proficiency(extraRequirement, other, 'excluded');
  const task = await create({ title: 'Parent with independent work', skill_ids: [firstSkill], assigned_to: [rootWorker] });
  const child = await create({ title: 'Child work', parent_task_id: task.id, skill_ids: [secondSkill], assigned_to: [other] });
  const dateEdit = await call('PUT', `/tasks/${task.id}`, { due_date: '2050-02-01' });
  assert.equal(dateEdit.status, 200, JSON.stringify(dateEdit.body));
  assert.equal(dateEdit.body.data.assigned_to, rootWorker, 'date-only edits retain the root primary, not the lowest participant ID');
  const skillsEdit = await call('PUT', `/tasks/${task.id}`, { skill_ids: [firstSkill, extraRequirement], assigned_to: [rootWorker, other] });
  assert.equal(skillsEdit.status, 200, JSON.stringify(skillsEdit.body));
  assert.equal(skillsEdit.body.data.assigned_to, rootWorker);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map((row) => row.user_id), [other, rootWorker]);
  assert.deepEqual(skillsEdit.body.data.subtasks.find((row) => row.id === child.id).skill_ids, [secondSkill]);
  const promoted = await call('PUT', `/tasks/${task.id}`, { assigned_to: [other, rootWorker] });
  assert.equal(promoted.status, 400, 'derived membership cannot bypass qualification for primary assignment');
  const newlySelected = user('new-unqualified-root-worker', 'member');
  proficiency(firstSkill, newlySelected, 'excluded');
  assert.equal((await call('PUT', `/tasks/${task.id}`, { assigned_to: [rootWorker, other, newlySelected] })).status, 400);
  const noRootWorker = await create({ title: 'Unassigned parent', skill_ids: [firstSkill] });
  await create({ title: 'Assigned child only', parent_task_id: noRootWorker.id, skill_ids: [secondSkill], assigned_to: [other] });
  const unassignedDateEdit = await call('PUT', `/tasks/${noRootWorker.id}`, { due_date: '2050-02-01' });
  assert.equal(unassignedDateEdit.status, 200, JSON.stringify(unassignedDateEdit.body));
  assert.equal(unassignedDateEdit.body.data.assigned_to, null, 'derived child participation does not become primary assignment');
});
