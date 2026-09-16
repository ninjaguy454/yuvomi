import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
process.env.DB_PATH=':memory:';
process.env.LOG_LEVEL='error';
process.env.SESSION_SECRET='task-expiration-write-races';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
let d,other,actor,taskId,directory,server,base,transaction,preWrite;

test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-14T11:59:59Z')});
  directory=mkdtempSync(join(tmpdir(),'vidamia-expiration-write-race-'));
  const path=join(directory,'fixture.db');
  d=new Database(path);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');
  for(const m of ALL_MIGRATIONS) {
    if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
    if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
  }
  _setTestDatabase(d);
  other=new Database(path);other.pragma('foreign_keys=ON');other.pragma('busy_timeout=1000');
  actor=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('Editor','Editor','x','admin')").run().lastInsertRowid);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  taskId=Number(d.prepare(`INSERT INTO tasks(title,description,created_by,assigned_to,due_date,due_time,points,expiration_policy)
    VALUES('Morning routine','- [ ] Brush teeth',?,?,'2026-09-14','08:00',2,'expire_incomplete')`).run(actor,actor).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(taskId,actor);
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.authUserId=actor;req.authRole='admin';req.session={userId:actor,role:'admin'};next();});
  app.use('/tasks',router);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}/tasks`;
  transaction=d.transaction;
  // Deterministically let another connection commit, or the clock reach the
  // deadline, after middleware/preflight but immediately before writer lock.
  d.transaction=function(fn) {
    const tx=transaction.call(this,fn);
    const run=(method,args)=>{
      const hook=preWrite;preWrite=null;hook?.();
      return Reflect.apply(method,tx,args);
    };
    const wrapped=(...args)=>run(tx,args);
    for(const mode of ['immediate','deferred','exclusive'])wrapped[mode]=(...args)=>run(tx[mode],args);
    return wrapped;
  };
});
test.afterEach(async()=>{
  preWrite=null;d.transaction=transaction;
  await new Promise(resolve=>server.close(resolve));
  _setTestDatabase(null);other.close();d.close();
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});
});
const read=()=>d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
async function write(kind,hook) {
  const snapshot=read();
  preWrite=hook;
  const put=kind==='PUT';
  const body=put
    ? {title:'Late edit',due_date:'2026-09-16',expiration_policy:'keep_overdue',expected_revision:snapshot.revision}
    : {line:0,checked:true,expect:'- [ ] Brush teeth',expected_revision:snapshot.revision};
  const response=await fetch(`${base}/${taskId}${put?'':'/check'}`,{method:put?'PUT':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(preWrite,null,'test hook must run at the actual write transaction');
  return {status:response.status,body:await response.json()};
}

for(const kind of ['PUT','check']) {
  test(`${kind} cannot change progress or reactivate a task expired after preflight on another connection`,async()=>{
    const response=await write(kind,()=>{
      other.prepare("UPDATE tasks SET status='expired',expired_at='2026-09-14T12:00:00Z' WHERE id=?").run(taskId);
    });
    assert.equal(response.status,409,JSON.stringify(response.body));
    assert.ok(['stale_revision','task_expired'].includes(response.body.reason));
    const task=read();assert.equal(task.status,'expired');assert.equal(task.title,'Morning routine');
    assert.equal(task.description,'- [ ] Brush teeth');assert.equal(task.due_date,'2026-09-14');
    assert.equal(task.expiration_policy,'expire_incomplete');assert.equal(task.expired_at,'2026-09-14T12:00:00Z');
  });

  test(`${kind} reevaluates the deadline after acquiring the writer transaction`,async t=>{
    const before=read();
    const response=await write(kind,()=>t.mock.timers.setTime(Date.parse('2026-09-14T12:00:00Z')));
    assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(response.body.reason,'task_expired');
    assert.deepEqual(read(),before,'deadline rejection leaves original work intact for background expiration');
  });

  test(`${kind} rejects a revision made stale between preflight and writer acquisition`,async()=>{
    const response=await write(kind,()=>other.prepare("UPDATE tasks SET title='Newer device edit' WHERE id=?").run(taskId));
    assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(response.body.reason,'stale_revision');
    const task=read();assert.equal(task.title,'Newer device edit');assert.equal(task.description,'- [ ] Brush teeth');
    assert.equal(task.expiration_policy,'expire_incomplete');assert.equal(task.due_date,'2026-09-14');
  });
}
