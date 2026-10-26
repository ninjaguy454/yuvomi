import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='synthetic-archive-migration-test-only';
const {ALL_MIGRATIONS}=await import('../server/db.js');

function migrate(d,migration){
  if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
  d.transaction(()=>{
    if(typeof migration.up==='function')migration.up(d);
    else d.exec(migration.up);
    migration.afterUp?.(d);
  })();
  if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');
}

test('schema 10067 to 10078 synthetic dry run preserves historical Task and reward rows',()=>{
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  try{
    for(const migration of ALL_MIGRATIONS.filter(row=>row.version<=10067))migrate(d,migration);
    d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'Archive migration owner','Owner','x','admin','parent')").run();
    const id=Number(d.prepare("INSERT INTO tasks(title,category,status,created_by,assigned_to,archived_at) VALUES('Historic completed','misc','done',1,1,'2026-09-01T00:00:00Z')").run().lastInsertRowid);
    d.prepare("INSERT INTO task_completions(task_id,series_id,user_id,completed_at) VALUES(?,?,1,'2026-08-31T00:00:00Z')").run(id,id);
    const before={task:d.prepare('SELECT * FROM tasks WHERE id=?').get(id),
      completions:d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(id),
      awards:d.prepare('SELECT * FROM reward_ledger').all()};
    const pending=ALL_MIGRATIONS.filter(row=>row.version>=10068&&row.version<=10078);
    assert.deepEqual(pending.map(row=>row.version),[10068,10069,10070,10071,10072,10073,10074,10075,10076,10077,10078]);
    for(const migration of pending)migrate(d,migration);
    const after=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([key])=>key in before.task)),before.task);
    assert.equal(after.auto_archive_after,null);
    assert.equal(after.auto_archived_at,null);
    assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(id),before.completions);
    assert.deepEqual(d.prepare('SELECT * FROM reward_ledger').all(),before.awards);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_subtask_resolution_attempts').get().n,0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_list_delta_events').get().n,0);
  }finally{d.close();}
});
