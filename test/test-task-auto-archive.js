import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';

const service = await import('../server/services/task-auto-archive.js').catch(() => ({}));
const NOW = new Date('2026-11-01T12:00:00Z');
const OLD = '2026-10-02T11:59:59Z';
const YOUNG = '2026-10-02T12:00:01Z';

async function root(f, title) {
  const response = await f.create({title});
  assert.equal(response.status, 201, JSON.stringify(response));
  return response.data.id;
}
function done(f, id, closedAt) {
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(id);
  if (closedAt) f.d.prepare('INSERT INTO task_completions(task_id,series_id,user_id,completed_at) VALUES(?,?,?,?)')
    .run(id,id,2,closedAt);
}
function skipped(f, id, closedAt) {
  f.d.prepare("UPDATE tasks SET status='skipped',skipped_at=? WHERE id=?").run(closedAt,id);
}

test('archives only terminal roots with durable closure evidence at least 30 days old', async t => {
  const f = await scoringFixture(t);
  const oldDone = await root(f,'Old done'); done(f,oldDone,OLD);
  const exactDone = await root(f,'Exactly thirty days'); done(f,exactDone,'2026-10-02T12:00:00Z');
  const youngerMillis = await root(f,'Just under thirty days'); done(f,youngerMillis,'2026-10-02T12:00:00.001Z');
  const youngDone = await root(f,'Young done'); done(f,youngDone,YOUNG);
  const missing = await root(f,'Missing completion'); done(f,missing,null);
  const oldSkipped = await root(f,'Old skipped'); skipped(f,oldSkipped,OLD);
  const youngSkipped = await root(f,'Young skipped'); skipped(f,youngSkipped,YOUNG);
  const open = await root(f,'Old but open');
  f.d.prepare("UPDATE tasks SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(open);
  assert.equal(typeof service.reconcileTaskAutoArchive,'function');
  const result = service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:10});
  assert.deepEqual(result.archivedIds.sort((a,b)=>a-b),[oldDone,exactDone,oldSkipped].sort((a,b)=>a-b));
  for (const id of [oldDone,exactDone,oldSkipped]) assert.ok(f.row(id).archived_at,id);
  assert.equal(f.row(oldDone).auto_archived_at,f.row(oldDone).archived_at,'automatic origin is reversible');
  for (const id of [youngerMillis,youngDone,missing,youngSkipped,open]) assert.equal(f.row(id).archived_at,null,id);
  assert.equal(f.row(oldDone).status,'done');
  assert.equal(f.row(oldSkipped).status,'skipped');
  assert.equal(f.d.prepare('SELECT completed_at FROM task_completions WHERE task_id=?').get(oldDone).completed_at,OLD);
  const changes=f.changes();
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:10}).archivedIds,[]);
  assert.equal(f.changes(),changes,'repeat is zero-write');
});

test('bounded sweep defers unresolved child and never archives a root from child closure', async t => {
  const f = await scoringFixture(t);
  const a = await root(f,'First');done(f,a,OLD);
  const b = await root(f,'Second');done(f,b,OLD);
  const blocked = await root(f,'Unfinished child');done(f,blocked,OLD);
  const child = Number(f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Action','household','open',1,?)")
    .run(blocked).lastInsertRowid);
  assert.equal(typeof service.reconcileTaskAutoArchive,'function');
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:1}).archivedIds,[a]);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:1}).archivedIds,[b]);
  assert.equal(f.row(blocked).archived_at,null);
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(child);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:1}).archivedIds,[blocked]);
  assert.equal(f.row(child).archived_at,null,'history remains attached to archived root');
});

test('manually archived open child still blocks automatic parent archival', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Closed parent with hidden open work');done(f,id,OLD);
  f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id,archived_at) VALUES('Still open','household','open',1,?,'2026-10-01T00:00:00Z')").run(id);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[]);
  assert.equal(f.row(id).archived_at,null);
});

test('standalone linked helper and counterpart block automatic source archival', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Closed with standalone helper');done(f,id,OLD);
  const helper=await root(f,'Legacy Workflow helper');
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(id,helper);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[]);
  assert.equal(f.row(id).archived_at,null);
  assert.equal(f.row(helper).archived_at,null);
});

test('legacy helper linked from a child scope also blocks parent archival', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Closed activity');done(f,id,OLD);
  const child=Number(f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Done action','household','done',1,?)")
    .run(id).lastInsertRowid);
  const helper=await root(f,'Open helper for child');
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(child,helper);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[]);
  assert.equal(f.row(id).archived_at,null);
  assert.equal(f.row(helper).archived_at,null);
});

test('terminal child-scoped helper retires with a completed source', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Closed activity with done helper');done(f,id,OLD);
  const child=Number(f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Done action','household','done',1,?)")
    .run(id).lastInsertRowid);
  const helper=await root(f,'Done legacy helper');
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(helper);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(child,helper);
  const result=service.reconcileTaskAutoArchive(f.d,{now:NOW});
  assert.deepEqual(result.archivedIds,[id]);
  assert.ok(f.row(helper).archived_at,'the helper must not remain in the active Task list');
});

test('skipped source and terminal separate helper archive and restore together', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Old skipped source');skipped(f,id,OLD);
  const helper=await root(f,'Separate helper');
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(helper);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(id,helper);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[id]);
  assert.ok(f.row(id).archived_at);
  assert.equal(f.row(helper).auto_archived_at,f.row(helper).archived_at);
  const restored=await f.call('PATCH',`/tasks/${id}/archive`,{archived:false});
  assert.equal(restored.status,200,JSON.stringify(restored));
  assert.equal(f.row(id).archived_at,null);
  assert.equal(f.row(helper).archived_at,null);
  assert.equal(f.row(helper).auto_archived_at,null);
  const changes=f.changes();
  assert.equal((await f.call('PATCH',`/tasks/${id}/archive`,{archived:false})).status,200);
  assert.equal(f.changes(),changes,'repeat restore does not rewrite the helper');
});

test('skipped source also archives a terminal helper linked from a child scope', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Old skipped source with child');skipped(f,id,OLD);
  const child=Number(f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Skipped action','household','skipped',1,?)")
    .run(id).lastInsertRowid);
  const helper=await root(f,'Separate child helper');
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(helper);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(child,helper);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[id]);
  assert.ok(f.row(helper).archived_at);
});

test('skipped source with unfinished separate helper remains active', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Old skipped with open helper');skipped(f,id,OLD);
  const helper=await root(f,'Open separate helper');
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(id,helper);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[]);
  assert.equal(f.row(id).archived_at,null);
  assert.equal(f.row(helper).archived_at,null);
});

test('restoring skipped source preserves a separately archived helper', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Skipped with prearchived helper');skipped(f,id,OLD);
  const helper=await root(f,'Manually archived helper');
  f.d.prepare("UPDATE tasks SET status='done',archived_at='2026-10-12T00:00:00Z' WHERE id=?").run(helper);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(id,helper);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[id]);
  const restored=await f.call('PATCH',`/tasks/${id}/archive`,{archived:false});
  assert.equal(restored.status,200,JSON.stringify(restored));
  assert.equal(f.row(helper).archived_at,'2026-10-12T00:00:00Z');
  assert.equal(f.row(helper).auto_archived_at,null);
});

test('skipped helper archive failure rolls back source and sibling helper', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Skipped atomic source');skipped(f,id,OLD);
  const helper=await root(f,'Skipped atomic helper');
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(helper);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(id,helper);
  f.d.exec(`CREATE TRIGGER synthetic_skipped_helper_abort BEFORE UPDATE OF archived_at ON tasks
    WHEN NEW.id=${helper} AND NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic skipped helper failure'); END`);
  const result=service.reconcileTaskAutoArchive(f.d,{now:NOW,onError:()=>{}});
  assert.deepEqual(result.failedIds,[id]);
  assert.equal(f.row(id).archived_at,null);
  assert.equal(f.row(helper).archived_at,null);
});

test('restoring an old occurrence gives it 30 days before automatic rearchive', async t => {
  const f = await scoringFixture(t);
  const id = await root(f,'Restore grace');done(f,id,OLD);
  service.reconcileTaskAutoArchive(f.d,{now:NOW});
  const restored = await f.call('PATCH',`/tasks/${id}/archive`,{archived:false});
  assert.equal(restored.status,200,JSON.stringify(restored));
  assert.equal(f.row(id).archived_at,null);
  assert.equal(f.row(id).auto_archived_at,null);
  assert.equal(f.row(id).auto_archive_after,'2026-12-01T12:00:00Z');
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:new Date('2026-11-02T12:00:00Z')}).archivedIds,[]);
  assert.equal(f.row(id).archived_at,null);
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:new Date('2026-12-01T12:00:00Z')}).archivedIds,[id]);
});

test('automatic archive removes a card through an authorized list delta and retains archive search', async t => {
  const f = await scoringFixture(t);
  const id = await root(f,'Search archive needle');done(f,id,OLD);
  const before = await f.call('GET','/tasks');
  assert.ok(before.data.some(row=>row.id===id));
  service.reconcileTaskAutoArchive(f.d,{now:NOW});
  const delta = await f.call('GET',`/tasks?delta=${encodeURIComponent(before.delta_cursor)}`);
  assert.equal(delta.status,200,JSON.stringify(delta));
  assert.equal(delta.reset_required,false);
  assert.ok(delta.removed.includes(id),JSON.stringify(delta));
  const active=await f.call('GET','/tasks?search=archive');
  assert.ok(!active.data.some(row=>row.id===id));
  const archived=await f.call('GET','/tasks?archived=only&search=archive');
  assert.ok(archived.data.some(row=>row.id===id));
});

test('open linked helper defers archival without changing recurrence or earned points', async t => {
  const f = await scoringFixture(t);
  const response=await f.create({title:'Recurring supervised work',is_recurring:true,recurrence_rule:'FREQ=DAILY',
    due_date:'2026-10-01',assigned_to:[2],points:4});
  assert.equal(response.status,201,JSON.stringify(response));
  const id=response.data.id;
  done(f,id,OLD);
  const helper=Number(f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Supervise','household','open',1,?)")
    .run(id).lastInsertRowid);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(id,helper);
  f.d.prepare("INSERT INTO reward_ledger(user_id,delta,type,task_id,created_by) VALUES(2,4,'earn',?,1)").run(id);
  const recurrence=f.d.prepare('SELECT * FROM task_recurrence_occurrences WHERE task_id=?').get(id);
  assert.ok(recurrence,'the source remains a recurrence occurrence');
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[]);
  assert.equal(f.row(id).archived_at,null);
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(helper);
  service.reconcileTaskAutoArchive(f.d,{now:NOW});
  assert.ok(f.row(id).archived_at);
  assert.deepEqual(f.d.prepare('SELECT * FROM task_recurrence_occurrences WHERE task_id=?').get(id),recurrence);
  assert.equal(f.d.prepare('SELECT delta FROM reward_ledger WHERE task_id=?').get(id).delta,4);
  assert.equal(f.row(helper).status,'done');
  assert.ok(f.row(helper).archived_at,'terminal linked helper follows source archive');
});

test('one failed archive rolls back and does not prevent another eligible occurrence', async t => {
  const f=await scoringFixture(t);
  const bad=await root(f,'Failed archive');done(f,bad,OLD);
  const good=await root(f,'Good archive');done(f,good,OLD);
  f.d.exec(`CREATE TRIGGER synthetic_archive_abort BEFORE UPDATE OF archived_at ON tasks
    WHEN NEW.id=${bad} AND NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
  const result=service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:2});
  assert.deepEqual(result.failedIds,[bad]);
  assert.deepEqual(result.archivedIds,[good]);
  assert.equal(f.row(bad).archived_at,null);
  assert.ok(f.row(good).archived_at);
  f.d.exec('DROP TRIGGER synthetic_archive_abort');
  assert.deepEqual(service.reconcileTaskAutoArchive(f.d,{now:NOW}).archivedIds,[bad]);
});

test('failure while archiving a linked helper rolls back the source and its list change', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Atomic linked source');done(f,id,OLD);
  const helper=Number(f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Helper','household','done',1,?)")
    .run(id).lastInsertRowid);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(id,helper);
  f.d.exec(`CREATE TRIGGER synthetic_helper_abort BEFORE UPDATE OF archived_at ON tasks
    WHEN NEW.id=${helper} AND NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic helper failure'); END`);
  const clock=f.d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  const result=service.reconcileTaskAutoArchive(f.d,{now:NOW,onError:()=>{}});
  assert.deepEqual(result.failedIds,[id]);
  assert.equal(f.row(id).archived_at,null);
  assert.equal(f.row(helper).archived_at,null);
  assert.equal(f.d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version,clock);
});

test('failed candidate pages cannot starve a later eligible occurrence', async t => {
  const f=await scoringFixture(t);
  const bad=[];
  for(let i=0;i<85;i++){const id=await root(f,`Broken ${i}`);done(f,id,OLD);bad.push(id);}
  const good=await root(f,'Later healthy occurrence');done(f,good,OLD);
  f.d.exec(`CREATE TRIGGER synthetic_batch_abort BEFORE UPDATE OF archived_at ON tasks
    WHEN NEW.id IN (${bad.join(',')}) AND NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
  const first=service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:20,onError:()=>{}});
  const second=service.reconcileTaskAutoArchive(f.d,{now:NOW,maxBatch:20,cursor:first.nextCursor,onError:()=>{}});
  assert.equal(first.scanned,80);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.archivedIds,[]);
  assert.ok(second.archivedIds.includes(good));
  assert.ok(f.row(good).archived_at);
  assert.ok(bad.every(id=>f.row(id).archived_at===null));
});

test('maintenance starts without a read request and can be stopped', async t => {
  const f=await scoringFixture(t);
  const id=await root(f,'Maintenance startup');done(f,id,OLD);
  const stop=service.startTaskAutoArchive({getDatabase:()=>f.d,now:()=>NOW,pollMs:3_600_000});
  t.after(stop);
  assert.ok(f.row(id).archived_at);
});

test('private archives remain absent from an unrelated member search', async t => {
  const f=await scoringFixture(t);
  const response=await f.create({title:'Private archival evidence',visibility:'private',assigned_to:[2]});
  assert.equal(response.status,201);
  const id=response.data.id;done(f,id,OLD);
  service.reconcileTaskAutoArchive(f.d,{now:NOW});
  const owner=await f.call('GET','/tasks?archived=only&search=archival',undefined,1);
  const outsider=await f.call('GET','/tasks?archived=only&search=archival',undefined,3);
  assert.equal(owner.status,200);assert.equal(outsider.status,200);
  assert.ok(owner.data.some(row=>row.id===id));
  assert.ok(!outsider.data.some(row=>row.id===id));
});
