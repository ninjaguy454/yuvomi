import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
const {ALL_MIGRATIONS}=await import('../server/db.js');
function migrate(d,row){
  if(row.foreignKeysOff)d.pragma('foreign_keys=OFF');
  try{d.transaction(()=>{typeof row.up==='function'?row.up(d):d.exec(row.up);row.afterUp?.(d);})();}
  finally{if(row.foreignKeysOff)d.pragma('foreign_keys=ON');}
}
test('deployed schema10070 upgrades without replaying archive migrations or rewriting occurrence history',()=>{
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  try{
    for(const row of ALL_MIGRATIONS.filter(row=>row.version<=10070))migrate(d,row);
    d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'synthetic-owner','Owner','x','admin')").run();
    const current=Number(d.prepare("INSERT INTO tasks(title,category,status,created_by,assigned_to,is_recurring,recurrence_rule,recurrence_from_completion,due_date) VALUES('Synthetic current','misc','open',1,1,1,'FREQ=DAILY',1,'2026-10-24')").run().lastInsertRowid);
    const backfill=Number(d.prepare("INSERT INTO tasks(title,category,status,created_by,assigned_to,is_recurring,due_date) VALUES('Synthetic backfill','misc','open',1,1,0,'2026-10-23')").run().lastInsertRowid);
    d.prepare('INSERT INTO task_recurrence_series(series_id,revision) VALUES(?,6)').run(current);
    d.prepare('INSERT INTO task_recurrence_occurrences(task_id,series_id,generation,occurrence_key) VALUES(?,?,29,?)').run(current,current,'2026-10-24');
    d.prepare('INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id) VALUES(?,30,?,?)')
      .run(current,JSON.stringify({task:{is_recurring:1,recurrence_rule:'FREQ=DAILY',recurrence_from_completion:0}}),current);
    const before={tasks:d.prepare('SELECT * FROM tasks ORDER BY id').all(),
      occurrences:d.prepare('SELECT * FROM task_recurrence_occurrences').all(),definitions:d.prepare('SELECT * FROM task_recurrence_definitions').all()};
    const pending=ALL_MIGRATIONS.filter(row=>row.version>10070&&row.version<=10080);
    assert.deepEqual(pending.map(row=>row.version),[10071,10072,10073,10074,10075,10076,10077,10078,10079,10080]);
    for(const row of pending)migrate(d,row);
    for(const row of before.tasks){const after=d.prepare('SELECT * FROM tasks WHERE id=?').get(row.id);
      assert.deepEqual(Object.fromEntries(Object.keys(row).map(key=>[key,after[key]])),row);}
    assert.deepEqual(d.prepare('SELECT * FROM task_recurrence_occurrences').all(),before.occurrences);
    assert.deepEqual(d.prepare('SELECT * FROM task_recurrence_definitions').all(),before.definitions);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_subtask_resolution_runs').get().n,0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_subtask_occurrence_overrides').get().n,0);
    assert.equal(d.prepare('SELECT is_recurring FROM tasks WHERE id=?').get(backfill).is_recurring,0);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();}
});
