import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { withTaskReadProjection, taskCapabilities, taskVisibilityWhere, assertTaskMutation } from '../server/services/task-access.js';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'task-read-projection-cache';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
let d, admin, first, second, task;
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys=ON');
  for (const migration of ALL_MIGRATIONS) {
    typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
    migration.afterUp?.(d);
  }
  _setTestDatabase(d);
  const user = (name, role) => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'x',?)")
    .run(name,name,role).lastInsertRowid);
  admin=user('Admin','admin'); first=user('First','member'); second=user('Second','member');
  const id=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility) VALUES('Personal Task',?,?,'assignees')")
    .run(admin,first).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,first);
  task=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
});
test.afterEach(() => {_setTestDatabase(null);d.close();});
function capability(userId,key,access) {
  d.prepare(`INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,?)
    ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access`).run(String(userId),key,access);
}

test('one synchronous projection reuses persisted Task capabilities and current actor permissions', () => {
  const prepare=d.prepare.bind(d);let actorReads=0,taskReads=0;
  d.prepare=(sql,...args)=>{
    if(sql==='SELECT id, role, family_role FROM users WHERE id = ?')actorReads++;
    if(sql==='SELECT * FROM tasks WHERE id = ?')taskReads++;
    return prepare(sql,...args);
  };
  try {
    withTaskReadProjection(d,first,()=>{
      for(let index=0;index<30;index++) {
        assert.equal(taskCapabilities(d,first,task).complete,true);
        taskVisibilityWhere(d,first);
      }
    });
    assert.equal(actorReads,1);assert.equal(taskReads,1);
  }finally{d.prepare=prepare;}
});

test('different actors and nested scopes never inherit another member permissions', () => {
  withTaskReadProjection(d,first,()=>{
    assert.equal(taskCapabilities(d,first,task).view,true);
    assert.equal(taskCapabilities(d,second,task).view,false);
    withTaskReadProjection(d,second,()=>{
      assert.equal(taskCapabilities(d,second,task).view,false);
      assert.equal(taskCapabilities(d,first,task).view,true);
    });
    assert.equal(taskCapabilities(d,first,task).view,true);
  });
});

test('mutating a returned capability object cannot change another row or later projection', () => {
  withTaskReadProjection(d,first,()=>{
    const initial=taskCapabilities(d,first,task);
    initial.view=false;initial.complete=false;
    const next=taskCapabilities(d,first,{id:task.id});
    assert.equal(next.view,true);assert.equal(next.complete,true);
    next.view=false;
    assert.equal(taskCapabilities(d,first,task).view,true);
  });
});

test('next scope observes revoked permissions, role and assignment changes with fresh Task revision', () => {
  withTaskReadProjection(d,first,()=>assert.equal(taskCapabilities(d,first,task).complete,true));
  capability(first,'tasks.complete_own','none');
  withTaskReadProjection(d,first,()=>assert.equal(taskCapabilities(d,first,task).complete,false));
  d.prepare("UPDATE users SET role='admin' WHERE id=?").run(first);
  withTaskReadProjection(d,first,()=>assert.equal(taskCapabilities(d,first,task).complete,true));
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(second,task.id);
  d.prepare('DELETE FROM task_assignments WHERE task_id=?').run(task.id);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(task.id,second);
  assert.ok(d.prepare('SELECT revision FROM tasks WHERE id=?').get(task.id).revision>task.revision);
  withTaskReadProjection(d,first,()=>assert.equal(taskCapabilities(d,first,task).view,false));
});

test('unexpected writes invalidate a live read scope and canonical mutation checks always re-read permissions', () => {
  withTaskReadProjection(d,first,()=>{
    assert.equal(taskCapabilities(d,first,task).complete,true);
    capability(first,'tasks.complete_own','none');
    assert.throws(()=>assertTaskMutation(d,first,task,{status:'done'},{operation:'status'}),{status:403});
    assert.equal(taskCapabilities(d,first,task).complete,false);
    capability(first,'tasks.complete_own','allow');
    assert.doesNotThrow(()=>assertTaskMutation(d,first,task,{status:'done'},{operation:'status'}));
    assert.equal(taskCapabilities(d,first,task).complete,true);
  });
});

test('rolled-back writes and nested savepoints never leave temporary permission snapshots cached', () => {
  withTaskReadProjection(d,first,()=>{
    assert.equal(taskCapabilities(d,first,task).complete,true);
    assert.throws(()=>d.transaction(()=>{
      capability(first,'tasks.complete_own','none');
      assert.equal(taskCapabilities(d,first,task).complete,false);
      assert.throws(()=>d.transaction(()=>{
        capability(first,'tasks.complete_own','allow');
        assert.equal(taskCapabilities(d,first,task).complete,true);
        throw new Error('inner rollback');
      })(),/inner rollback/);
      assert.equal(taskCapabilities(d,first,task).complete,false);
      throw new Error('outer rollback');
    })(),/outer rollback/);
    assert.equal(taskCapabilities(d,first,task).complete,true);
  });
});

test('failed and asynchronous scope exits cannot retain old permissions', () => {
  assert.throws(()=>withTaskReadProjection(d,first,()=>{
    assert.equal(taskCapabilities(d,first,task).complete,true);
    throw new Error('read failed');
  }),/read failed/);
  capability(first,'tasks.complete_own','none');
  assert.equal(taskCapabilities(d,first,task).complete,false);
  assert.throws(()=>withTaskReadProjection(d,first,()=>Promise.resolve()),/must be synchronous/);
  capability(first,'tasks.complete_own','allow');
  assert.equal(taskCapabilities(d,first,task).complete,true);
});

test('missing rows are not cached from caller metadata and deleted private rows stay inaccessible', () => {
  withTaskReadProjection(d,first,()=>{
    const missing=999999;
    assert.equal(taskCapabilities(d,first,{id:missing,created_by:first,visibility:'private'}).view,true);
    assert.equal(taskCapabilities(d,first,{id:missing,created_by:second,visibility:'private'}).view,false);
    assert.equal(taskCapabilities(d,first,{id:task.id}).view,true);
    d.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    assert.equal(taskCapabilities(d,first,{id:task.id,created_by:second,visibility:'private'}).view,false);
  });
});
