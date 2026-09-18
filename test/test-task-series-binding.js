import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'series-binding-isolated-test';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { applyTaskActivityBinding, copyTaskActivityBinding, previewTaskActivityBinding, getTaskActivityBinding } = await import('../server/services/task-activity-bindings.js');
const { captureActivityTemplateDefinition, captureTaskActivityBindingDefinition, readTaskActivityDefinition, updateTaskActivitySnapshotSkills } = await import('../server/services/task-activity-snapshot.js');
const { attachTaskSkills } = await import('../server/services/task-skills.js');
const { inspectTaskSupervision } = await import('../server/services/task-supervision.js');
const { overrideTaskAssignment } = await import('../server/services/assignment-responsibilities.js');
const { ensureSeriesDefinition } = await import('../server/services/task-series.js');
const { assertTaskMutation } = await import('../server/services/task-access.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
let d, parent, eleanor, frank, skill, otherSkill, activity;

test.beforeEach(() => {
  d = new Database(':memory:');
  for (const migration of ALL_MIGRATIONS) { typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up); migration.afterUp?.(d); }
  _setTestDatabase(d);
  const user = (name, role) => Number(d.prepare('INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,?, ?,?)')
    .run(name, name, 'x', role, role === 'admin' ? 'parent' : 'child').lastInsertRowid);
  parent = user('Parent', 'admin'); eleanor = user('Eleanor', 'member'); frank = user('Frank', 'member');
  skill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Brush teeth',0,'normal',?)").run(parent).lastInsertRowid);
  otherSkill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washer',0,'supervised',?)").run(parent).lastInsertRowid);
  for (const member of [parent, eleanor, frank]) proficiency(member, skill, 'normal');
  proficiency(parent, otherSkill, 'normal'); proficiency(eleanor, otherSkill, 'supervised'); proficiency(frank, otherSkill, 'excluded');
  activity = Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,
    subject_required,allow_assignment_override,created_by) VALUES('Morning','Morning','fixed','fixed',?,0,1,?)`).run(eleanor,parent).lastInsertRowid);
  d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id,sort_order) VALUES(?,?,0)').run(activity,skill);
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });
function proficiency(userId, skillId, value) {
  d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,?,'manual')
    ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`).run(userId,skillId,value);
}
function task(title = 'Morning', recurring = false) {
  return Number(d.prepare(`INSERT INTO tasks(title,created_by,start_date,due_date,is_recurring,recurrence_rule)
    VALUES(?,?,'2026-09-14','2026-09-14',?,?)`).run(title,parent,recurring?1:0,recurring?'FREQ=DAILY':null).lastInsertRowid);
}
function snapshot(scope = 'series:one') { return { ...captureActivityTemplateDefinition(d,activity), rotation_scope: scope }; }
function bind(id, extra = {}) { return applyTaskActivityBinding(d,id,{activityTemplateId:activity,activitySnapshot:snapshot(),...extra}); }
function replaceTemplateSkill() {
  d.prepare('DELETE FROM activity_template_skills WHERE activity_template_id=?').run(activity);
  d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id,sort_order) VALUES(?,?,0)').run(activity,otherSkill);
}

test('frozen series binding survives source template assignment, skill, override and checklist changes', () => {
  const first = task('First',true); bind(first);
  const saved = captureTaskActivityBindingDefinition(d,first,{seriesId:first});
  d.prepare('UPDATE activity_templates SET fixed_user_id=?,allow_assignment_override=0 WHERE id=?').run(frank,activity);
  replaceTemplateSkill();
  d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template,sort_order) VALUES(?,'New unrelated template step',0)").run(activity);
  const next = task('Next',true);
  copyTaskActivityBinding(d,first,next);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(next).assigned_to,eleanor);
  assert.deepEqual(attachTaskSkills(d,[{id:next}])[0].skill_ids,[skill]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id=?').get(next).n,0);
  assert.equal(getTaskActivityBinding(d,next).activity_assignment_override_allowed,1);
  assert.deepEqual(captureTaskActivityBindingDefinition(d,first,{seriesId:first}),saved);
});

test('snapshot freezes requirement IDs but still checks current proficiency and supervision', () => {
  const id=task();bind(id);
  replaceTemplateSkill();
  assert.equal(inspectTaskSupervision(d,id).actions.length,0,'unrelated new template skill cannot create supervision');
  proficiency(eleanor,skill,'supervised');
  assert.equal(inspectTaskSupervision(d,id).actions.some(row=>row.action_task_id===id&&row.state!=='not_required'),true);
  proficiency(eleanor,skill,'excluded');
  assert.throws(()=>previewTaskActivityBinding(d,{activityTemplateId:activity,activitySnapshot:readTaskActivityDefinition(d,id)}),/cannot perform/);
});

test('editing frozen root requirements changes only that concrete definition and keeps skill permissions enforced', () => {
  const first=task(),second=task();bind(first);bind(second);
  updateTaskActivitySnapshotSkills(d,first,[otherSkill]);
  assert.deepEqual(attachTaskSkills(d,[{id:first},{id:second}]).map(row=>row.skill_ids),[[otherSkill],[skill]]);
  assert.equal(inspectTaskSupervision(d,first).actions.some(row=>row.action_task_id===first&&row.required_skills.some(required=>required.id===otherSkill)),true);
  assert.deepEqual(d.prepare('SELECT skill_id FROM activity_template_skills WHERE activity_template_id=?').all(activity).map(row=>row.skill_id),[skill]);
  d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'tasks.change_required_skills','none')").run(String(eleanor));
  assert.throws(()=>assertTaskMutation(d,eleanor,d.prepare('SELECT * FROM tasks WHERE id=?').get(first),{skill_ids:[otherSkill]}),/permissions/);
  updateTaskActivitySnapshotSkills(d,first,[]);
  assert.deepEqual(attachTaskSkills(d,[{id:first}])[0].skill_ids,[]);
});

test('authorized assignment override follows frozen policy while still enforcing current required skills', () => {
  const id=task();bind(id);
  d.prepare('UPDATE activity_templates SET allow_assignment_override=0,fixed_user_id=? WHERE id=?').run(parent,activity);
  replaceTemplateSkill();
  assert.equal(overrideTaskAssignment(d,id,frank,parent).assigned_to.id,frank);
  proficiency(frank,skill,'excluded');
  assert.throws(()=>overrideTaskAssignment(d,id,frank,parent),/cannot perform/);
});

test('separate series use independent rotating cursors without changing source template rotation', () => {
  d.prepare("UPDATE activity_templates SET assignment_strategy='eligible_round_robin',assignment_policy='eligible_round_robin' WHERE id=?").run(activity);
  const base={...snapshot('series:A'),rotation_cursor_user_id:parent};
  const firstA=task(),nextA=task(),firstB=task();
  bind(firstA,{activitySnapshot:base});bind(nextA,{activitySnapshot:base});
  bind(firstB,{activitySnapshot:{...base,rotation_scope:'series:B'}});
  const assigned=id=>d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to;
  assert.equal(assigned(firstA),eleanor);assert.equal(assigned(nextA),frank);assert.equal(assigned(firstB),eleanor);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM activity_rotation_state WHERE activity_template_id=?').get(activity).n,0);
});

test('migration-style series snapshot reads preserve original Task revision/history without a binding-row rewrite', () => {
  const id=task('Existing',true);applyTaskActivityBinding(d,id,{activityTemplateId:activity});
  const before=d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision;
  const events=d.prepare('SELECT * FROM task_activity_events WHERE task_id=? ORDER BY id').all(id);
  ensureSeriesDefinition(d,id);
  assert.equal(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id).definition_snapshot_json,null);
  assert.equal(d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision,before);
  assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE task_id=? ORDER BY id').all(id),events);
  replaceTemplateSkill();
  assert.deepEqual(readTaskActivityDefinition(d,id).required_skill_ids,[skill]);
  assert.deepEqual(attachTaskSkills(d,[{id}])[0].skill_ids,[skill]);
  updateTaskActivitySnapshotSkills(d,id,[]);
  assert.deepEqual(readTaskActivityDefinition(d,id).required_skill_ids,[]);
});

test('ordinary nonseries bindings preserve their existing live-template behavior', () => {
  const id=task();applyTaskActivityBinding(d,id,{activityTemplateId:activity});
  replaceTemplateSkill();
  assert.deepEqual(attachTaskSkills(d,[{id}])[0].skill_ids,[otherSkill]);
  assert.equal(getTaskActivityBinding(d,id).definition_snapshot_json,null);
});

test('Skill deletion cannot remove a requirement referenced only by a frozen binding or durable series definition', async () => {
  const direct=task(),series=task('Existing series',true);bind(direct);
  applyTaskActivityBinding(d,series,{activityTemplateId:activity});ensureSeriesDefinition(d,series);
  d.prepare('DELETE FROM activity_template_skills WHERE activity_template_id=?').run(activity);
  const app=express();app.use((req,_res,next)=>{req.authUserId=parent;req.authRole='admin';req.session={userId:parent,role:'admin'};next();});
  app.use(automationRouter);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/admin/skills/${skill}`;
    const bound=await fetch(url,{method:'DELETE'});assert.equal(bound.status,409);
    d.prepare('DELETE FROM task_activity_bindings WHERE task_id=?').run(direct);
    const definition=await fetch(url,{method:'DELETE'});assert.equal(definition.status,409);
    assert.ok(d.prepare('SELECT 1 FROM skills WHERE id=?').get(skill));
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});
