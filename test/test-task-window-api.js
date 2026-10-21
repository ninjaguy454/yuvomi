import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

const view={groupMode:'none',sort:{field:'title',direction:'asc'},locale:'en',limit:2,offset:0};
const url=(options={})=>`/tasks/window?view=${encodeURIComponent(JSON.stringify({...view,...options}))}`;

test('authorized Task window returns bounded cards, refill and a stable continuation',async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium','open',1,?)");
  const a=Number(insert.run('Alpha','all').lastInsertRowid);
  const b=Number(insert.run('Beta','all').lastInsertRowid);
  const c=Number(insert.run('Gamma','all').lastInsertRowid);
  const first=await f.call('GET',url());
  assert.equal(first.status,200);
  assert.deepEqual(first.data.map(row=>row.id),[a,b]);
  assert.equal(first.total,3);
  assert.equal(first.groups[0].total,3);
  assert.equal(first.next_offset,2);
  assert.ok(first.next_cursor);
  const next=await f.call('GET',`${url({offset:2})}&page_cursor=${encodeURIComponent(first.next_cursor)}`);
  assert.equal(next.status,200);
  assert.deepEqual(next.data.map(row=>row.id),[c]);
  assert.equal(next.next_offset,null);
  const enlarged=await f.call('GET',`${url({offset:2,limit:100})}&page_cursor=${encodeURIComponent(first.next_cursor)}`);
  assert.equal(enlarged.status,200,'signed offset permits a bounded larger refill page');
  assert.deepEqual(enlarged.data.map(row=>row.id),[c]);
  f.d.prepare("UPDATE tasks SET title='Aardvark',revision=revision+1 WHERE id=?").run(c);
  const stale=await f.call('GET',`${url({offset:2})}&page_cursor=${encodeURIComponent(first.next_cursor)}`);
  assert.equal(stale.reset_required,true);
  const refilled=await f.call('GET',url());
  assert.deepEqual(refilled.data.map(row=>row.id),[c,a]);
});

test('Task window excludes private rows and refuses unsupported view projections',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES('Hidden','misc','medium','open',2,'private')").run();
  f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES('Visible','misc','medium','open',1,'all')").run();
  const response=await f.call('GET',url());
  assert.equal(response.status,200);
  assert.deepEqual(response.data.map(row=>row.title),['Visible']);
  const unsupported=await f.call('GET',url({sort:{field:'points',direction:'asc'}}));
  assert.equal(unsupported.status,409);
  const offers=await f.call('GET',`${url()}&offers=1`);
  assert.equal(offers.status,409,'offers use a separate authorized projection');
});

test('window cards retain ordinary full-list scoring, children and private-child projection',async t=>{
  const f=await scoringFixture(t);
  const parent=await f.create({title:'Parent',assigned_to:[2],points:4});
  assert.equal(parent.status,201);
  f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility,parent_task_id,points) VALUES('Shared child','misc','medium','open',1,'all',?,2)").run(parent.data.id);
  f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility,parent_task_id,points) VALUES('Hidden child','misc','medium','open',1,'private',?,9)").run(parent.data.id);
  const full=await f.call('GET','/tasks',undefined,2);
  const page=await f.call('GET',url(),undefined,2);
  assert.equal(page.status,200);
  const a=full.data.find(row=>row.id===parent.data.id);
  const b=page.data.find(row=>row.id===parent.data.id);
  assert.ok(a&&b);
  for(const key of ['id','title','status','subtask_total','subtask_done','completion_points','waiting_on_helper'])
    assert.deepEqual(b[key],a[key],key);
  assert.deepEqual(b.subtasks.map(row=>row.title),a.subtasks.map(row=>row.title));
});

test('page cursor rejects changes in label ordering and effective permissions without returning task data',async t=>{
  const f=await scoringFixture(t);
  for(const title of ['Alpha','Beta','Gamma'])f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium','open',1,'all')").run(title);
  const first=await f.call('GET',url());
  const changedLabels=await f.call('GET',`${url({offset:2,labels:{noLocation:'Elsewhere'}})}&page_cursor=${encodeURIComponent(first.next_cursor)}`);
  assert.equal(changedLabels.reset_required,true);
  const changedActor=await f.call('GET',`${url({offset:2})}&page_cursor=${encodeURIComponent(first.next_cursor)}`,undefined,2);
  assert.equal(changedActor.reset_required,true);
  assert.ok(!changedActor.data);
});

test('window search, grouped counts, collapsed groups and off-window entry are authoritative',async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,?,'medium','open',1,'all')");
  const a=Number(insert.run('Alpha milk','kitchen').lastInsertRowid);
  insert.run('Beta milk','kitchen');
  const c=Number(insert.run('Gamma juice','garden').lastInsertRowid);
  const options={groupMode:'category',sort:{field:'title',direction:'asc'},
    categories:[{key:'kitchen'},{key:'garden'}],categoryLabels:{kitchen:'Kitchen',garden:'Garden'},limit:1};
  const first=await f.call('GET',`${url(options)}&search=milk`);
  assert.equal(first.status,200,JSON.stringify(first));
  assert.deepEqual(first.data.map(row=>row.id),[a]);
  assert.equal(first.total,2);
  assert.deepEqual(first.groups.map(row=>[row.id,row.total]),[['kitchen',2]]);
  const collapsed=await f.call('GET',`${url({...options,collapsed:['kitchen']})}&search=milk`);
  assert.equal(collapsed.total,0);
  assert.equal(collapsed.groups[0].total,2);
  assert.deepEqual(collapsed.data,[]);
  f.d.prepare("UPDATE tasks SET title='Aardvark milk',category='kitchen',revision=revision+1 WHERE id=?").run(c);
  const entered=await f.call('GET',`${url(options)}&search=milk`);
  assert.deepEqual(entered.data.map(row=>row.id),[c]);
  assert.equal(entered.total,3);
});

test('permission loss resets continuation and refills the first page without disclosing removal details',async t=>{
  const f=await scoringFixture(t);
  const firstId=Number(f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES('Alpha','misc','medium','open',1,'all')").run().lastInsertRowid);
  f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES('Beta','misc','medium','open',1,'all')").run();
  f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES('Gamma','misc','medium','open',1,'all')").run();
  const first=await f.call('GET',url(),undefined,2);
  assert.equal(first.status,200);
  assert.equal(first.data[0].id,firstId);
  f.d.prepare("UPDATE tasks SET visibility='private',revision=revision+1 WHERE id=?").run(firstId);
  const stale=await f.call('GET',`${url({offset:2})}&page_cursor=${encodeURIComponent(first.next_cursor)}`,undefined,2);
  assert.equal(stale.reset_required,true);
  assert.ok(!stale.data);
  const fresh=await f.call('GET',url(),undefined,2);
  assert.deepEqual(fresh.data.map(row=>row.title),['Beta','Gamma']);
});

test('a time-only due-order boundary invalidates an old page offset without a database write',async t=>{
  const f=await scoringFixture(t);
  t.mock.timers.setTime(Date.parse('2026-11-01T11:59:59Z'));
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility,due_date,due_time) VALUES(?,'misc','medium','open',1,'all','2026-11-01',?)");
  insert.run('Due soon','12:00:00');insert.run('Due later','13:00:00');insert.run('Due last','14:00:00');
  const dueView={groupMode:'none',sort:{field:'default',direction:'asc'},timeZone:'UTC'};
  const first=await f.call('GET',url(dueView));
  assert.equal(first.status,200,JSON.stringify(first));
  assert.ok(first.next_cursor);
  assert.equal(first.visibility.next_start_at,Date.parse('2026-11-01T12:00:00Z')+1,'open page schedules its due-order refresh');
  const writes=f.changes();
  t.mock.timers.setTime(Date.parse('2026-11-01T12:00:01Z'));
  const stale=await f.call('GET',`${url({...dueView,offset:2})}&page_cursor=${encodeURIComponent(first.next_cursor)}`);
  assert.equal(stale.reset_required,true);
  assert.equal(stale.reason,'start_boundary');
  assert.equal(f.changes(),writes);
});

test('due grouping follows the viewer zone when the server calendar day differs',async t=>{
  const f=await scoringFixture(t);
  t.mock.timers.setTime(Date.parse('2026-11-02T00:30:00Z'));
  f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility,due_date) VALUES('West-coast today','misc','medium','open',1,'all','2026-11-01')").run();
  const response=await f.call('GET',url({groupMode:'due',sort:{field:'title',direction:'asc'},timeZone:'America/Los_Angeles'}));
  assert.equal(response.status,200,JSON.stringify(response));
  assert.deepEqual(response.groups.filter(group=>group.total).map(group=>group.id),['today']);
  assert.equal(response.data[0].title,'West-coast today');
});

test('linked helper status grouping fails closed until display-status projection has parity',async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium','open',1,'all')");
  const source=Number(insert.run('Source').lastInsertRowid);
  const helper=Number(insert.run('Helper').lastInsertRowid);
  f.d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(source,helper);
  const result=await f.call('GET',url({groupMode:'status',sort:{field:'title',direction:'asc'},statusOrder:['open','in_progress','done','archived']}));
  assert.equal(result.status,409);
  assert.equal(result.reason,'unsupported_view');
});
