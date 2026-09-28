import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,writeFileSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import { withTaskReadProjection, withTaskReadSnapshot, taskCapabilities, taskVisibilityWhere, assertTaskMutation } from '../server/services/task-access.js';

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

test('owned synchronous snapshot retains bounded reads, actor isolation and unchanged persisted data',()=>{
  const before=d.serialize(),prepare=d.prepare.bind(d);let taskReads=0,actorReads=0;
  d.prepare=(sql,...args)=>{
    if(sql==='SELECT * FROM tasks WHERE id = ?')taskReads++;
    if(sql==='SELECT id, role, family_role FROM users WHERE id = ?')actorReads++;
    return prepare(sql,...args);
  };
  const expected=taskCapabilities(d,first,task);taskReads=0;actorReads=0;
  try {
    const result=withTaskReadSnapshot(d,first,()=>{
      assert.equal(d.inTransaction,true);
      for(let i=0;i<30;i++)assert.deepEqual(taskCapabilities(d,first,task),expected);
      assert.equal(taskReads,1);assert.equal(actorReads,1);
      return withTaskReadProjection(d,second,()=>taskCapabilities(d,second,task));
    });
    assert.equal(result.view,false);assert.equal(d.inTransaction,false);
    assert.deepEqual(d.serialize(),before,'read snapshot creates no Task/history/revision writes');
  }finally{d.prepare=prepare;}
});

test('owned snapshot never reuses permissions after a write or nested rollback',()=>{
  withTaskReadSnapshot(d,first,()=>{
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
    capability(first,'tasks.complete_own','none');
    assert.throws(()=>assertTaskMutation(d,first,task,{status:'done'},{operation:'status'}),{status:403});
  });
  withTaskReadSnapshot(d,first,()=>assert.equal(taskCapabilities(d,first,task).complete,false));
});

test('snapshot failure releases transaction and a new request sees current permissions',()=>{
  assert.throws(()=>withTaskReadSnapshot(d,first,()=>{
    assert.equal(taskCapabilities(d,first,task).complete,true);
    throw new Error('projection failed');
  }),/projection failed/);
  assert.equal(d.inTransaction,false);
  capability(first,'tasks.complete_own','none');
  withTaskReadSnapshot(d,first,()=>assert.equal(taskCapabilities(d,first,task).complete,false));
  assert.throws(()=>withTaskReadSnapshot(d,first,()=>Promise.resolve()),/must be synchronous/);
  assert.equal(d.inTransaction,false);
});

test('snapshot called inside a caller transaction never enables mutation-time caching',()=>{
  d.transaction(()=>withTaskReadSnapshot(d,first,()=>{
    assert.equal(taskCapabilities(d,first,task).complete,true);
    assert.throws(()=>d.transaction(()=>{
      capability(first,'tasks.complete_own','none');
      assert.equal(taskCapabilities(d,first,task).complete,false);
      throw new Error('savepoint rollback');
    })(),/savepoint rollback/);
    assert.equal(taskCapabilities(d,first,task).complete,true);
  }))();
  assert.equal(d.inTransaction,false);
  assert.throws(()=>d.transaction(()=>{
    capability(first,'tasks.complete_own','none');
    assert.throws(()=>withTaskReadSnapshot(d,first,()=>{throw new Error('nested read failure');}),/nested read failure/);
    assert.equal(d.inTransaction,true,'the caller still owns its transaction');
    assert.equal(taskCapabilities(d,first,task).complete,false);
    throw new Error('caller rollback');
  })(),/caller rollback/);
  assert.equal(taskCapabilities(d,first,task).complete,true);
});

test('WAL worker completion commits concurrently while a read snapshot stays consistent and next request refreshes',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'vidamia-read-snapshot-')),file=join(folder,'fixture.db');
  writeFileSync(file,d.serialize());
  const reader=new Database(file);reader.pragma('journal_mode=WAL');
  const signal=new Int32Array(new SharedArrayBuffer(4));let worker;
  try {
    worker=new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='read-snapshot-worker';
        const Database=(await import(workerData.databaseUrl)).default;
        const db=await import(workerData.dbUrl),d=new Database(workerData.file);d.pragma('foreign_keys=ON');db._setTestDatabase(d);
        const {changeTaskStatus}=await import(workerData.lifecycleUrl);
        parentPort.once('message',()=>{
          try {
            changeTaskStatus(d,workerData.taskId,'done',{actorId:workerData.actorId,body:{expected_revision:workerData.revision}});
            d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'tasks.complete_own','none')").run(String(workerData.actorId));
            Atomics.store(new Int32Array(workerData.signal),0,1);
          }catch(error){Atomics.store(new Int32Array(workerData.signal),0,-1);parentPort.postMessage({error:error.message});}
          finally {Atomics.notify(new Int32Array(workerData.signal),0);d.close();}
        });parentPort.postMessage({ready:true});
      })().catch(error=>parentPort.postMessage({error:error.message}));
    `,{eval:true,stdout:true,stderr:true,workerData:{file,signal:signal.buffer,taskId:task.id,actorId:first,revision:task.revision,
      databaseUrl:import.meta.resolve('better-sqlite3-multiple-ciphers'),dbUrl:new URL('../server/db.js',import.meta.url).href,
      lifecycleUrl:new URL('../server/services/task-lifecycle.js',import.meta.url).href}});
    await new Promise((resolve,reject)=>{worker.once('message',value=>value.ready?resolve():reject(new Error(value.error)));worker.once('error',reject);});
    const before=reader.prepare('SELECT status,revision FROM tasks WHERE id=?').get(task.id);
    withTaskReadSnapshot(reader,first,()=>{
      assert.equal(taskCapabilities(reader,first,task).complete,true);
      worker.postMessage('complete');
      assert.notEqual(Atomics.wait(signal,0,0,30000),'timed-out','writer commits while the reader is open');
      assert.equal(Atomics.load(signal,0),1,'canonical worker mutation succeeded');
      assert.deepEqual(reader.prepare('SELECT status,revision FROM tasks WHERE id=?').get(task.id),before);
      assert.equal(taskCapabilities(reader,first,task).complete,true,'one response uses its consistent snapshot');
    });
    withTaskReadSnapshot(reader,first,()=>{
      const current=reader.prepare('SELECT status,revision FROM tasks WHERE id=?').get(task.id);
      assert.equal(current.status,'done');assert.ok(current.revision>before.revision);
      assert.equal(taskCapabilities(reader,first,task).complete,false,'new request observes changed authority');
    });
    assert.equal(reader.prepare("SELECT count(*) n FROM task_activity_events WHERE task_id=? AND event_type='completed'").get(task.id).n,1);
    assert.equal(reader.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(reader.pragma('foreign_key_check'),[]);
  }finally{
    await worker?.terminate();reader.close();
    for(const name of readdirSync(folder))unlinkSync(join(folder,name));rmdirSync(folder);
  }
});
