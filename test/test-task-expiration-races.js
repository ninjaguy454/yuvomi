import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
process.env.DB_PATH=':memory:';
process.env.LOG_LEVEL='error';
process.env.SESSION_SECRET='task-expiration-races-test';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {registerRecurrenceOccurrence}=await import('../server/services/task-recurrence-frontier.js');
let directory,path,d,actor,taskId,children;

function open() {
  d=new Database(path);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');d.pragma('busy_timeout=15000');
}
test.beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'vidamia-expiration-races-'));path=join(directory,'fixture.db');open();
  for(const m of ALL_MIGRATIONS) {
    if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
    if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
  }
  actor=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('RaceParent','Race Parent','x','admin')").run().lastInsertRowid);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(actor);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  taskId=Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,status,points,is_recurring,recurrence_rule,
    start_date,start_time,due_date,due_time,expiration_policy)
    VALUES('Get Ready for the Day',?,?,'open',2,1,'FREQ=DAILY','2026-09-14','07:00','2026-09-14','08:00','expire_incomplete')`).run(actor,actor).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(taskId,actor);
  children=['Brush teeth','Get dressed'].map(title=>Number(d.prepare('INSERT INTO tasks(title,created_by,parent_task_id) VALUES(?,?,?)').run(title,actor,taskId).lastInsertRowid));
  registerRecurrenceOccurrence(d,taskId);
});
test.afterEach(()=>{
  d?.close();d=null;
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
  rmSync(directory,{recursive:true,force:true});
});

function worker(mode,now) {
  const child=fork(fileURLToPath(new URL('./task-expiration-race-worker.mjs',import.meta.url)),
    [JSON.stringify({path,actorId:actor,taskId,mode,now})],
    {execPath:process.execPath,env:{...process.env,DB_PATH:':memory:',LOG_LEVEL:'error'},stdio:['ignore','pipe','pipe','ipc']});
  let output='',outcome,readyResolve,readyReject,resultResolve,resultReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const result=new Promise((resolve,reject)=>{resultResolve=resolve;resultReject=reject;});
  // Register a rejection observer while the caller is still waiting on readiness.
  result.catch(()=>{});
  const timer=setTimeout(()=>{child.kill();},30000);
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-8000);});
  child.on('message',message=>{
    if(message.type==='ready')readyResolve();
    if(message.type==='result')outcome=message.outcome;
  });
  child.on('error',error=>{clearTimeout(timer);readyReject(error);resultReject(error);});
  child.on('exit',code=>{
    clearTimeout(timer);
    if(code===0&&outcome)resultResolve(outcome);
    else {const error=new Error(`Expiration ${mode} worker failed (${code}): ${output}`);readyReject(error);resultReject(error);}
  });
  return {ready,result,run:()=>child.send({run:true}),stop:()=>child.kill()};
}
async function race(operations) {
  const workers=operations.map(([mode,now])=>worker(mode,now));
  try {
    await Promise.all(workers.map(child=>child.ready));
    for(const child of workers)child.run();
    return await Promise.all(workers.map(child=>child.result));
  } catch(error) {for(const child of workers)child.stop();throw error;}
}
const read=()=>d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
const successors=()=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(taskId);
const count=(sql,...args)=>d.prepare(sql).get(...args).n;
function assertOneNext() {
  const next=successors();assert.equal(next.length,1);
  assert.equal(next[0].due_date,'2026-09-15');assert.equal(next[0].start_date,'2026-09-15');
  assert.equal(next[0].due_time,'08:00');assert.equal(next[0].start_time,'07:00');assert.equal(next[0].points,2);
  assert.equal(next[0].status,'open');
  const fresh=d.prepare('SELECT status FROM tasks WHERE parent_task_id=?').all(next[0].id);
  assert.equal(fresh.length,2);assert.ok(fresh.every(row=>row.status==='open'));
  assert.deepEqual(d.prepare(`SELECT series_id,occurrence_key,COUNT(*) n FROM task_recurrence_occurrences
    WHERE state='materialized' GROUP BY series_id,occurrence_key HAVING n>1`).all(),[]);
}

test('separate processes racing deadline completion, expiration and materialization create one missed occurrence and one successor',async()=>{
  const now='2026-09-14T12:00:00Z';
  const outcomes=await race([['complete',now],['expire',now],['expire',now],['reconcile',now],['reconcile',now]]);
  assert.equal(outcomes[0].ok,false);assert.equal(outcomes[0].error.details.reason,'task_expired');
  assert.ok(outcomes.slice(1).every(row=>row.ok));
  assert.equal(read().status,'expired');assertOneNext();
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'",taskId),1);
  assert.equal(count('SELECT COUNT(*) n FROM task_completions WHERE task_id=?',taskId),0);
  assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn'"),0);
});

test('an earlier completion committed in another process wins over subsequent expiration and repeated materialization',async()=>{
  const [completed]=await race([['complete','2026-09-14T11:59:59Z']]);
  assert.equal(completed.ok,true,JSON.stringify(completed));assert.equal(read().status,'done');
  const now='2026-09-14T12:00:00Z';
  const outcomes=await race([['expire',now],['reconcile',now],['reconcile',now]]);
  assert.ok(outcomes.every(row=>row.ok));assert.equal(read().status,'done');assertOneNext();
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'",taskId),0);
  assert.equal(count('SELECT COUNT(*) n FROM task_completions WHERE task_id=?',taskId),1);
  assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",taskId),1);
  assert.equal(d.prepare("SELECT SUM(delta) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(taskId).n,2);
});

test('simultaneous independent writers choose one terminal transition without duplicate rewards or successors',async()=>{
  const outcomes=await race([['complete','2026-09-14T11:59:59Z'],['expire','2026-09-14T12:00:00Z'],['reconcile','2026-09-14T12:00:00Z']]);
  assert.equal(outcomes[1].ok,true);assert.equal(outcomes[2].ok,true);
  const status=read().status;assert.ok(['done','expired'].includes(status));assertOneNext();
  const earns=count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",taskId);
  const expirations=count("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'",taskId);
  const completions=count('SELECT COUNT(*) n FROM task_completions WHERE task_id=?',taskId);
  assert.equal(earns,status==='done'?1:0);assert.equal(completions,earns);assert.equal(expirations,status==='expired'?1:0);
});

test('fresh server process after downtime preserves Monday partial history and materializes fresh Tuesday idempotently',async()=>{
  d.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(taskId);
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(children[0]);
  d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(?,?,?,'completed','{}')").run(taskId,children[0],actor);
  const original=d.prepare('SELECT * FROM task_activity_events').all();
  d.close();d=null;
  const [startup]=await race([['sweep','2026-09-15T11:30:00Z']]);
  assert.equal(startup.ok,true,JSON.stringify(startup));assert.equal(startup.value.expired,1);assert.equal(startup.value.failed,0);
  open();assert.equal(read().status,'expired');assertOneNext();
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(children[0]).status,'done');
  assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id<=? ORDER BY id').all(original.at(-1).id),original);
  assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn'"),0);
  d.close();d=null;
  const [restart]=await race([['sweep','2026-09-15T11:30:00Z']]);
  assert.equal(restart.ok,true);assert.equal(restart.value.expired,0);
  open();assertOneNext();assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'",taskId),1);
});

test('restart advances a mixed completed and expired rotation cohort on one shared calendar anchor',async()=>{
  const peerActor=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('RacePeer','Race Peer','x','member')").run().lastInsertRowid);
  d.prepare("UPDATE tasks SET status='done',assignment_mode='round_robin',rotation_group='morning-race',rotation_slot=0 WHERE id=?").run(taskId);
  d.prepare("UPDATE tasks SET status='done' WHERE parent_task_id=?").run(taskId);
  const peer=Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,points,is_recurring,recurrence_rule,
    start_date,start_time,due_date,due_time,expiration_policy,assignment_mode,rotation_group,rotation_slot)
    VALUES('Second morning position',?,?,2,1,'FREQ=DAILY','2026-09-14','07:00','2026-09-14','08:00',
      'expire_incomplete','round_robin','morning-race',1)`).run(actor,peerActor).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(peer,peerActor);
  for(const id of [taskId,peer])for(const [index,userId] of [actor,peerActor].entries())
    d.prepare('INSERT INTO task_rotation_members(task_id,user_id,sort_order) VALUES(?,?,?)').run(id,userId,index);
  registerRecurrenceOccurrence(d,peer);
  d.close();d=null;
  const [startup]=await race([['sweep','2026-09-16T11:30:00Z']]);
  assert.equal(startup.ok,true,JSON.stringify(startup));assert.equal(startup.value.failed,0);
  open();
  const cohorts=d.prepare("SELECT rotation_cycle,due_date,status FROM tasks WHERE rotation_group='morning-race' AND parent_task_id IS NULL ORDER BY rotation_cycle,rotation_slot").all();
  assert.deepEqual(cohorts.map(row=>row.due_date),['2026-09-14','2026-09-14','2026-09-15','2026-09-15','2026-09-16','2026-09-16']);
  assert.deepEqual(cohorts.map(row=>row.status),['done','expired','expired','expired','open','open']);
  assert.deepEqual(cohorts.map(row=>row.rotation_cycle),[0,0,1,1,2,2]);
});
