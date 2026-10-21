import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {captureTaskListClock,recordTaskListDelta} from '../server/services/task-list-delta.js';

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

test('signed loaded-window delta hydrates only changed or entering cards and refills order',async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium','open',1,'all')");
  const ids=['Alpha','Beta','Charlie','Delta'].map(title=>Number(insert.run(title).lastInsertRowid));
  const first=await f.call('GET',url());
  assert.equal(first.status,200);
  assert.deepEqual(first.data.map(row=>row.id),ids.slice(0,2));
  assert.ok(first.delta_cursor);
  const deltaUrl=cursor=>`${url()}&window_count=2&window_delta=${encodeURIComponent(cursor)}`;
  const quiet=await f.call('GET',deltaUrl(first.delta_cursor));
  assert.deepEqual({delta:quiet.delta,no_change:quiet.no_change,data:quiet.data},{delta:true,no_change:true,data:undefined});
  f.d.transaction(()=>{
    const before=captureTaskListClock(f.d);
    f.d.prepare('UPDATE tasks SET title=?,revision=revision+1 WHERE id=?').run('Aardvark',ids[2]);
    recordTaskListDelta(f.d,before,[ids[2]]);
  })();
  const writes=f.changes();
  const changed=await f.call('GET',deltaUrl(first.delta_cursor));
  assert.equal(changed.status,200,JSON.stringify(changed));
  assert.equal(changed.delta,true);
  assert.deepEqual(changed.ordered_ids,[ids[2],ids[0]]);
  assert.deepEqual(changed.removed,[ids[1]]);
  assert.deepEqual(changed.data.map(row=>row.id),[ids[2]]);
  assert.ok(changed.delta_cursor);
  assert.equal(f.changes(),writes,'delta reads do not add writes after the tracked edit');
  const stable=await f.call('GET',deltaUrl(changed.delta_cursor));
  assert.equal(stable.no_change,true);
  const page2=await f.call('GET',`${url({offset:2})}&page_cursor=${encodeURIComponent(changed.next_cursor)}&known_cursor=${encodeURIComponent(changed.delta_cursor)}`);
  assert.equal(page2.status,200,JSON.stringify(page2));
  assert.deepEqual(page2.data.map(row=>row.id),[ids[1],ids[3]]);
  assert.ok(page2.delta_cursor,'page continuation extends the signed loaded set');
  const allQuiet=await f.call('GET',`${url()}&window_count=4&window_delta=${encodeURIComponent(page2.delta_cursor)}`);
  assert.equal(allQuiet.no_change,true);
});

test('filtered Task leaving loaded window refills by delta without retaining stale card',async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium','open',1,'all')");
  const ids=['Alpha','Beta','Charlie'].map(title=>Number(insert.run(title).lastInsertRowid));
  const filtered=`${url()}&status=open`;
  const first=await f.call('GET',filtered);
  assert.deepEqual(first.data.map(row=>row.id),ids.slice(0,2));
  f.d.transaction(()=>{
    const before=captureTaskListClock(f.d);
    f.d.prepare("UPDATE tasks SET status='done',revision=revision+1 WHERE id=?").run(ids[0]);
    recordTaskListDelta(f.d,before,[ids[0]]);
  })();
  const delta=await f.call('GET',`${filtered}&window_count=2&window_delta=${encodeURIComponent(first.delta_cursor)}`);
  assert.equal(delta.status,200,JSON.stringify(delta));
  assert.equal(delta.delta,true);
  assert.deepEqual(delta.ordered_ids,[ids[1],ids[2]]);
  assert.deepEqual(delta.removed,[ids[0]]);
  assert.deepEqual(delta.data.map(row=>row.id),[ids[2]]);
});

test('loaded-window delta covers 500 cards, then falls back safely beyond 600 IDs',async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium','open',1,'all')");
  const ids=[];
  f.d.transaction(()=>{for(let n=0;n<605;n++)ids.push(Number(insert.run(`Bounded ${String(n).padStart(3,'0')}`).lastInsertRowid));})();
  let cursor=null,known=null,knownAt500=null,loaded=0;
  for(let offset=0;offset<=600;offset+=100){
    const query=`${url({offset,limit:100})}`+(cursor?`&page_cursor=${encodeURIComponent(cursor)}&known_cursor=${encodeURIComponent(known)}`:'');
    const page=await f.call('GET',query,undefined,2);
    assert.equal(page.status,200,JSON.stringify(page).slice(0,200));
    loaded+=page.data.length;
    assert.equal(loaded,Math.min(605,offset+100));
    if(offset===400){
      assert.ok(page.delta_cursor);
      assert.ok(page.delta_cursor.length<6000,'the 500-ID signed receipt fits the URL guard');
      knownAt500=page.delta_cursor;
      const quiet=await f.call('GET',`${url({offset:0,limit:100})}&window_count=500&window_delta=${encodeURIComponent(page.delta_cursor)}`,undefined,2);
      assert.equal(quiet.no_change,true);
    }
    if(offset===500)assert.ok(page.delta_cursor,'600 loaded IDs remain covered');
    if(offset===600)assert.equal(page.delta_cursor,null,'larger loaded windows use bounded snapshot refill');
    known=page.delta_cursor;cursor=page.next_cursor;
  }
  f.d.transaction(()=>{
    const before=captureTaskListClock(f.d);
    f.d.prepare('UPDATE tasks SET title=?,revision=revision+1 WHERE id=?').run('Aardvark enters',ids[604]);
    recordTaskListDelta(f.d,before,[ids[604]]);
  })();
  const writes=f.changes();
  const changed=await f.call('GET',`${url({offset:0,limit:100})}&window_count=500&window_delta=${encodeURIComponent(knownAt500)}`,undefined,2);
  assert.equal(changed.status,200,JSON.stringify(changed).slice(0,200));
  assert.equal(changed.delta,true);
  assert.equal(changed.ordered_ids.length,500);
  assert.equal(changed.ordered_ids[0],ids[604]);
  assert.deepEqual(changed.data.map(row=>row.id),[ids[604]],'only the entering card is hydrated');
  assert.deepEqual(changed.removed,[ids[499]],'the displaced boundary card is removed by ID');
  assert.equal(f.changes(),writes,'the larger delta read writes no Task data');
  f.d.transaction(()=>{
    const before=captureTaskListClock(f.d);
    f.d.prepare("UPDATE tasks SET visibility='private',revision=revision+1 WHERE id=?").run(ids[604]);
    recordTaskListDelta(f.d,before,[ids[604]]);
  })();
  const revoked=await f.call('GET',`${url({offset:0,limit:100})}&window_count=500&window_delta=${encodeURIComponent(changed.delta_cursor)}`,undefined,2);
  assert.equal(revoked.reset_required,true,'revoking a loaded card invalidates the signed window');
  assert.equal(revoked.reason,'visibility_changed');
  assert.ok(!revoked.data,'revocation returns no Task data');
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
  const revokedDelta=await f.call('GET',`${url()}&window_count=2&window_delta=${encodeURIComponent(first.delta_cursor)}`,undefined,2);
  assert.equal(revokedDelta.reset_required,true);
  assert.ok(!revokedDelta.data,'a revoked loaded row cannot survive in a delta response');
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
