import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {captureTaskListClock, recordTaskListDelta, taskListCursor, readTaskListDelta} from '../server/services/task-list-delta.js';
process.env.SESSION_SECRET ||= 'synthetic-task-list-delta-test-secret';

function fixture(){
  const d=new Database(':memory:');
  d.exec(`CREATE TABLE task_change_clock(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
    INSERT INTO task_change_clock VALUES(1,0);
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES(10077);
    CREATE TABLE task_list_delta_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
      before_clock INTEGER NOT NULL,after_clock INTEGER NOT NULL,root_ids_json TEXT NOT NULL);`);
  return d;
}
const context={actor:11,query:'status=open&tag=chores',ids:[3,7]};

test('contiguous committed changes produce a bounded changed-root list',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,context);
    d.transaction(()=>{const before=captureTaskListClock(d);
      d.exec('UPDATE task_change_clock SET version=version+3 WHERE id=1');
      assert.equal(recordTaskListDelta(d,before,[3,9]),true);
    })();
    const delta=readTaskListDelta(d,{cursor,actor:11,query:context.query});
    assert.equal(delta.reset_required,false);
    assert.deepEqual(delta.changed_ids,[3,9]);
    assert.deepEqual(delta.known_ids,[3,7]);
    assert.equal(delta.version,3);
  }finally{d.close();}
});

test('an uninstrumented clock change makes every older cursor reset',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,context);
    d.exec('UPDATE task_change_clock SET version=version+1 WHERE id=1');
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query}).reset_required,true);
  }finally{d.close();}
});

test('a gap between covered writes cannot be hidden by the later write',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,context);
    d.exec('UPDATE task_change_clock SET version=version+1 WHERE id=1');
    d.transaction(()=>{const before=captureTaskListClock(d);
      d.exec('UPDATE task_change_clock SET version=version+1 WHERE id=1');
      recordTaskListDelta(d,before,[3]);
    })();
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query}).reset_required,true);
  }finally{d.close();}
});

test('actor and query identity are bound to the cursor without revealing IDs',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,context);
    assert.equal(readTaskListDelta(d,{cursor,actor:12,query:context.query}).reset_required,true);
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:'status=done'}).reset_required,true);
    assert.equal(readTaskListDelta(d,{cursor:cursor.slice(0,-1)+'x',actor:11,query:context.query}).reset_required,true);
  }finally{d.close();}
});

test('a changed authorization context invalidates an otherwise current cursor',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,{...context,authority:'household:allow'});
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query,authority:'household:none'}).reset_required,true);
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query,authority:'household:allow'}).reset_required,false);
  }finally{d.close();}
});

test('a passed future start forces a full scope read even without a database change',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,{...context,nextStartAt:2000});
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query,now:1999}).reset_required,false);
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query,now:2000}).reason,'start_boundary');
  }finally{d.close();}
});

test('a schema migration invalidates a cursor without a Task-clock change',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,context);
    d.prepare('INSERT INTO schema_migrations(version) VALUES(10078)').run();
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query}).reason,'schema_changed');
  }finally{d.close();}
});

test('oversized GET cursors are refused before they can exceed practical URL budgets',()=>{
  const d=fixture();
  try{
    assert.throws(()=>taskListCursor(d,{...context,ids:Array.from({length:401},(_,i)=>i+1)}),/Invalid Task list cursor/);
    assert.equal(taskListCursor(d,{...context,ids:Array.from({length:400},(_,i)=>Number.MAX_SAFE_INTEGER-i)}),null);
  }
  finally{d.close();}
});

test('no-op and rollback leave no durable journal row',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,context),before=captureTaskListClock(d);
    d.transaction(()=>assert.equal(recordTaskListDelta(d,before,[3]),false))();
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_list_delta_events').get().n,0);
    assert.throws(()=>d.transaction(()=>{d.exec('UPDATE task_change_clock SET version=version+1 WHERE id=1');
      recordTaskListDelta(d,before,[3]);throw new Error('rollback');})(),/rollback/);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_list_delta_events').get().n,0);
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query}).version,0);
  }finally{d.close();}
});

test('journal retention stays bounded and expires an older cursor',()=>{
  const d=fixture();
  try{
    const cursor=taskListCursor(d,context);
    for(let i=0;i<576;i++)d.transaction(()=>{
      const before=captureTaskListClock(d);
      d.prepare('UPDATE task_change_clock SET version=version+1 WHERE id=1').run();
      recordTaskListDelta(d,before,[3]);
    })();
    assert.ok(d.prepare('SELECT COUNT(*) n FROM task_list_delta_events').get().n<=512);
    assert.equal(readTaskListDelta(d,{cursor,actor:11,query:context.query}).reset_required,true);
  }finally{d.close();}
});
