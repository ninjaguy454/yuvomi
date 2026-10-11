import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
let directory,path,d,actor,taskId,revision;
test.beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),'vidamia-skip-races-'));path=join(directory,'synthetic.db');d=new Database(path);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');d.pragma('busy_timeout=15000');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  actor=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic','Synthetic manager','x','admin')").run().lastInsertRowid);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(actor);
  d.exec("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')");
  taskId=Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,points,is_recurring,recurrence_rule,start_date,due_date,due_time,expiration_policy)
    VALUES('Synthetic occurrence',?,?,5,1,'FREQ=DAILY','2026-11-01','2026-11-01','08:00','expire_incomplete')`).run(actor,actor).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(taskId,actor);
  for(const title of ['First','Second'])d.prepare('INSERT INTO tasks(title,created_by,parent_task_id) VALUES(?,?,?)').run(title,actor,taskId);
  revision=d.prepare('SELECT revision FROM tasks WHERE id=?').get(taskId).revision;
});
test.afterEach(()=>{d.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});});
async function race(modes,now){
  const workers=modes.map(mode=>{
    const child=fork(fileURLToPath(new URL('./task-skip-race-worker.mjs',import.meta.url)),[JSON.stringify({path,actorId:actor,taskId,revision,mode,now})],{execPath:process.execPath,env:{...process.env,DB_PATH:':memory:'},stdio:['ignore','pipe','pipe','ipc']});
    let readyResolve,readyReject,resultResolve,resultReject,outcome,output='';const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;}),result=new Promise((r,j)=>{resultResolve=r;resultReject=j;});result.catch(()=>{});
    const timer=setTimeout(()=>child.kill(),30000);child.on('message',m=>{if(m.type==='ready')readyResolve();else if(m.type==='result')outcome=m.outcome;});
    for(const s of [child.stdout,child.stderr])s.on('data',c=>output=(output+c).slice(-6000));
    child.on('error',e=>{clearTimeout(timer);readyReject(e);resultReject(e);});child.on('exit',code=>{clearTimeout(timer);if(code===0&&outcome)resultResolve(outcome);else{const e=new Error(`${mode} worker ${code}: ${output}`);readyReject(e);resultReject(e);}});
    return {child,ready,result};
  });
  try {await Promise.all(workers.map(w=>w.ready));for(const w of workers)w.child.send({run:true});return await Promise.all(workers.map(w=>w.result));}
  catch(error){for(const w of workers)w.child.kill();throw error;}
}
const count=(sql,...args)=>d.prepare(sql).get(...args).n;
function oneNext(){const rows=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(taskId);assert.equal(rows.length,1);assert.equal(rows[0].due_date,'2026-11-02');assert.equal(rows[0].status,'open');}
test('two same-operation writers excuse once and return one replay',async()=>{
  const outcomes=await race(['skip','skip'],'2026-11-01T12:30:00Z');assert.ok(outcomes.every(o=>o.ok),JSON.stringify(outcomes));assert.equal(outcomes.filter(o=>o.value.replayed).length,1);
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='skipped'",taskId),1);assert.equal(count('SELECT COUNT(*) n FROM task_skip_receipts'),1);assert.equal(count('SELECT COUNT(*) n FROM reward_ledger'),0);oneNext();
});
test('completion and skip serialize into one outcome, one next occurrence and only valid earnings',async()=>{
  const outcomes=await race(['skip','complete'],'2026-11-01T12:30:00Z');const status=d.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status;assert.ok(['done','skipped'].includes(status),JSON.stringify(outcomes));
  assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",taskId),status==='done'?1:0);
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='skipped'",taskId),status==='skipped'?1:0);assert.equal(outcomes.filter(o=>o.ok).length,1);oneNext();
});
test('deadline sweep and skip cannot overwrite each other or duplicate the successor',async()=>{
  const outcomes=await race(['skip','expire'],'2026-11-01T13:00:00Z');const status=d.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status;assert.ok(['expired','skipped'].includes(status),JSON.stringify(outcomes));
  assert.equal(count('SELECT COUNT(*) n FROM reward_ledger'),0);assert.equal(count('SELECT COUNT(*) n FROM task_completions'),0);oneNext();
  if(status==='expired')assert.equal(outcomes[0].error.details.reason,'stale_revision');else assert.equal(outcomes[1].value.expired,false);
});

function useCompletionRelativeRecurrence(){
  d.prepare('UPDATE tasks SET recurrence_from_completion=1 WHERE id=?').run(taskId);
  revision=d.prepare('SELECT revision FROM tasks WHERE id=?').get(taskId).revision;
}

test('completion-relative same-operation writers create one receipt and one nominal successor',async()=>{
  useCompletionRelativeRecurrence();
  const outcomes=await race(['skip','skip'],'2026-11-01T12:30:00Z');assert.ok(outcomes.every(row=>row.ok),JSON.stringify(outcomes));
  assert.equal(outcomes.filter(row=>row.value.replayed).length,1);assert.equal(count('SELECT COUNT(*) n FROM task_skip_receipts'),1);
  assert.equal(count('SELECT COUNT(*) n FROM reward_ledger'),0);oneNext();
});

test('completion-relative completion and Skip serialize without duplicate dates or invalid earnings',async()=>{
  useCompletionRelativeRecurrence();
  const outcomes=await race(['skip','complete'],'2026-11-01T12:30:00Z');const status=d.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status;
  assert.ok(['done','skipped'].includes(status),JSON.stringify(outcomes));assert.equal(outcomes.filter(row=>row.ok).length,1);
  assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",taskId),status==='done'?1:0);oneNext();
});

test('completion-relative expiry stays paused if it wins against Skip',async()=>{
  useCompletionRelativeRecurrence();
  const outcomes=await race(['skip','expire'],'2026-11-01T13:00:00Z');const status=d.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status;
  assert.ok(['expired','skipped'].includes(status),JSON.stringify(outcomes));assert.equal(count('SELECT COUNT(*) n FROM reward_ledger'),0);
  assert.equal(count('SELECT COUNT(*) n FROM task_completions'),0);
  if(status==='expired'){
    assert.equal(count('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',taskId),0);
    assert.equal(outcomes[0].error.details.reason,'stale_revision');
  }else{assert.equal(outcomes[1].value.expired,false);oneNext();}
});
