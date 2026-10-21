import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';
import { taskListWhere, readTaskListDescriptors, readOrderedTaskWindow } from '../server/services/task-list-query.js';

test('lightweight candidate query uses the same authorized filters as full Task cards', async t => {
  const f = await scoringFixture(t);
  const first = await f.create({ title: 'First', priority: 'high', assigned_to: [2] });
  const second = await f.create({ title: 'Second', priority: 'low', assigned_to: [3] });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  f.d.prepare('INSERT INTO task_tags(task_id,tag,tag_key) VALUES(?,?,?)').run(first.data.id, 'Chores', 'chores');
  const cases = ['', 'status=open', 'priority=high', 'assigned_to=2', 'status=done', 'tag=Chores'];
  for (const actor of [1, 2]) for (const query of cases) {
    const params = new URLSearchParams(query);
    const filter = Object.fromEntries([...params.keys()].map(key => [key, params.getAll(key).length > 1 ? params.getAll(key) : params.get(key)]));
    const { where, values } = taskListWhere(f.d, actor, filter);
    const lightweight = f.d.prepare(`SELECT t.id FROM tasks t ${where}`).all(...values).map(row => row.id).sort((a,b) => a-b);
    const response = await f.call('GET', `/tasks?include_future=1${query ? '&' + query : ''}`, undefined, actor);
    assert.equal(response.status, 200, `${actor}: ${query}`);
    const full = response.data.map(row => row.id).sort((a,b) => a-b);
    assert.deepEqual(lightweight, full, `${actor}: ${query}`);
    const descriptors = readTaskListDescriptors(f.d, actor, filter);
    assert.deepEqual(descriptors.rows.map(row => row.id).sort((a,b) => a-b), full, `descriptors: ${actor}: ${query}`);
  }
});

test('descriptor search and start visibility match full authorized cards', async t => {
  const f = await scoringFixture(t);
  const visible = await f.create({ title: 'Gröceries', description: 'Milk', assigned_to: [2] });
  const future = await f.create({ title: 'Future milk', assigned_to: [2], start_date: '2026-11-02' });
  assert.equal(visible.status, 201); assert.equal(future.status, 201);
  f.d.prepare('INSERT INTO task_tags(task_id,tag,tag_key) VALUES(?,?,?)').run(visible.data.id, 'Bäckerei', 'bäckerei');
  for (const search of ['milk', 'GRÖC', 'future', 'BÄCK']) {
    const all = await f.call('GET', '/tasks', undefined, 1);
    const full = all.data.filter(row =>
      (row.title || '').toLowerCase().includes(search.toLowerCase()) ||
      (row.description || '').toLowerCase().includes(search.toLowerCase()) ||
      (row.tags || []).some(tag => tag.toLowerCase().includes(search.toLowerCase()))
    ).map(row => row.id).sort((a,b) => a-b);
    const descriptors = readTaskListDescriptors(f.d, 1, { search });
    assert.deepEqual(descriptors.rows.map(row => row.id).sort((a,b) => a-b), full, search);
  }
});

test('private descriptors never reveal a creator-only Task to a different member', async t => {
  const f = await scoringFixture(t);
  const secret = await f.create({ title: 'Private note', visibility: 'private', assigned_to: [2] });
  assert.equal(secret.status, 201);
  const full = await f.call('GET', '/tasks', undefined, 3);
  assert.equal(full.status, 200);
  assert.ok(!full.data.some(row => row.id === secret.data.id));
  assert.ok(!readTaskListDescriptors(f.d, 3).rows.some(row => row.id === secret.data.id));
});

test('descriptor wake boundary includes an authorized future child of a visible parent', async t => {
  const f = await scoringFixture(t);
  const created = await f.create({ title: 'Visible parent', assigned_to: [2] });
  assert.equal(created.status, 201, JSON.stringify(created));
  const childId = f.d.prepare(`INSERT INTO tasks(title,category,priority,status,created_by,visibility,parent_task_id,start_date)
    VALUES('Tomorrow','Sonstiges','none','open',1,'all',?,'2026-11-02')`).run(created.data.id).lastInsertRowid;
  const full = await f.call('GET', '/tasks');
  assert.equal(full.status, 200);
  assert.ok(full.visibility.next_start_at > Date.parse('2026-11-01T12:00:00Z'), JSON.stringify(full.visibility));
  const descriptors = readTaskListDescriptors(f.d, 1);
  assert.equal(descriptors.visibility.next_start_at, full.visibility.next_start_at);
  f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(childId);
  const restricted = await f.call('GET', '/tasks', undefined, 2);
  assert.equal(restricted.status, 200);
  assert.equal(readTaskListDescriptors(f.d, 2).visibility.next_start_at, restricted.visibility.next_start_at);
});

test('ordinary descriptor participants match assigned and responsible people on full cards',async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({title:'Shared work',assigned_to:[2,3]});
  assert.equal(created.status,201);
  const full=await f.call('GET','/tasks',undefined,1);
  assert.equal(full.status,200);
  const card=full.data.find(row=>row.id===created.data.id);
  const expected=[...new Set([...(card.assigned_users||[]),...(card.activity_responsibilities||[])].map(row=>Number(row.id??row.user_id)))].sort((a,b)=>a-b);
  const descriptors=readTaskListDescriptors(f.d,1,{}, { participants:true });
  const row=descriptors.rows.find(row=>row.id===created.data.id);
  assert.deepEqual(row.participant_ids,expected);
});

test('authorized assignee-count sort matches full ordinary Task cards without exposing a member pool',async t=>{
  const f=await scoringFixture(t);
  const one=await f.create({title:'Solo',assigned_to:[2]});
  const two=await f.create({title:'Shared',assigned_to:[2,3]});
  assert.equal(one.status,201);assert.equal(two.status,201);
  const full=await f.call('GET','/tasks',undefined,1);
  const matching=full.data.filter(row=>[one.data.id,two.data.id].includes(row.id));
  assert.deepEqual(matching.map(row=>[row.id,(row.assigned_users||[]).length]).sort((a,b)=>a[1]-b[1]).map(row=>row[0]),[one.data.id,two.data.id]);
  const page=readOrderedTaskWindow(f.d,1,{}, {groupMode:'none',sort:{field:'assignees',direction:'asc'},limit:20});
  assert.deepEqual(page.ids.filter(id=>[one.data.id,two.data.id].includes(id)),[one.data.id,two.data.id]);
});

test('internal page recomputes entry, refill, and row ACL before selecting IDs',async t=>{
  const f=await scoringFixture(t);
  const ids=[];
  for(const title of ['Alpha','Bravo','Charlie','Delta']){
    const response=await f.create({title,assigned_to:[2]});
    assert.equal(response.status,201);ids.push(response.data.id);
  }
  const view={groupMode:'none',sort:{field:'title',direction:'asc'},offset:0,limit:2};
  const page=()=>readOrderedTaskWindow(f.d,2,{},view);
  const initial=page();assert.deepEqual(initial.ids,ids.slice(0,2));
  assert.deepEqual(readOrderedTaskWindow(f.d,2,{}, {...view,offset:2,expectedClock:initial.clock,
    expectedScopeKey:initial.scope_key}).ids,ids.slice(2));
  assert.equal(readOrderedTaskWindow(f.d,2,{}, {...view,locale:'de',offset:2,
    expectedScopeKey:initial.scope_key}).reason,'query_changed');
  f.d.prepare("UPDATE tasks SET title='Aardvark' WHERE id=?").run(ids[3]);
  assert.equal(readOrderedTaskWindow(f.d,2,{}, {...view,offset:2,expectedClock:initial.clock}).reset_required,true,
    'page two cannot continue across a changed ordering snapshot');
  assert.deepEqual(page().ids,[ids[3],ids[0]],'off-page edit enters visible boundary');
  f.d.prepare('UPDATE tasks SET archived_at=? WHERE id=?').run('2026-11-01T12:00:00Z',ids[3]);
  assert.deepEqual(page().ids,ids.slice(0,2),'archive refills boundary');
  f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(ids[0]);
  assert.deepEqual(page().ids,[ids[1],ids[2]],'private row is removed without an ID leak');
  assert.equal(page().total,2);
  assert.throws(()=>readOrderedTaskWindow(f.d,2,{}, {...view,sort:{field:'progress'}}),/not ready/);
  assert.throws(()=>readOrderedTaskWindow(f.d,2,{}, {...view,sort:{field:'default'}}),/Viewer time zone/);
});

test('descriptor location label and place identity match full authorized card',async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({title:'Meet at gate',assigned_to:[2]});
  assert.equal(created.status,201);
  f.d.prepare(`INSERT INTO task_locations(task_id,kind,user_label,manual_address,created_by)
    VALUES(?,'manual','West gate','Rose Street',1)`).run(created.data.id);
  const full=await f.call('GET','/tasks');assert.equal(full.status,200);
  const card=full.data.find(row=>row.id===created.data.id);
  const descriptor=readTaskListDescriptors(f.d,1,{}, {location:true}).rows.find(row=>row.id===created.data.id);
  assert.equal(descriptor.location_label,card.location?.label||card.location?.address||card.activity_place_name||'');
  assert.equal(descriptor.location_place_id,card.location?.place_id||null);
});

test('trip display deadline follows the next authorized active child',async t=>{
  const f=await scoringFixture(t);
  const root=await f.create({title:'Prepare trip',assigned_to:[2],due_date:'2026-11-30'});
  assert.equal(root.status,201);
  f.d.prepare("INSERT INTO trip_plans(name,starts_at,ends_at,created_by) VALUES('Synthetic trip','2026-11-20T09:00','2026-11-25T18:00',1)").run();
  f.d.prepare('INSERT INTO trip_task_groups(trip_id,parent_task_id,coordinator_id) VALUES(1,?,1)').run(root.data.id);
  const child=f.d.prepare(`INSERT INTO tasks(title,category,priority,status,created_by,visibility,parent_task_id,due_date)
    VALUES('Pack','misc','medium','open',1,'all',?,'2026-11-02')`).run(root.data.id).lastInsertRowid;
  f.d.prepare("INSERT INTO trip_task_steps(trip_id,step_key,task_id,phase,recipe_json) VALUES(1,'pack',?,'before_departure','{}')").run(child);
  const full=await f.call('GET','/tasks');assert.equal(full.status,200);
  const card=full.data.find(row=>row.id===root.data.id);
  const descriptor=readTaskListDescriptors(f.d,1,{}, {tripDue:true}).rows.find(row=>row.id===root.data.id);
  assert.equal(descriptor.display_due_date,card.display_due_date);
  assert.equal(descriptor.display_due_time,card.display_due_time);
  assert.equal(descriptor.trip_group?.trip_id,card.trip_group?.trip_id);
  f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(child);
  const member=await f.call('GET','/tasks',undefined,2);assert.equal(member.status,200);
  const memberCard=member.data.find(row=>row.id===root.data.id);
  const memberDescriptor=readTaskListDescriptors(f.d,2,{}, {tripDue:true}).rows.find(row=>row.id===root.data.id);
  assert.equal(memberDescriptor.display_due_date,memberCard.display_due_date);
  assert.equal(memberDescriptor.display_due_date,null,'hidden child does not reveal its deadline');
  f.d.prepare("UPDATE tasks SET visibility='all' WHERE id=?").run(child);
  const other=await f.create({title:'Other',assigned_to:[2],due_date:'2026-11-10'});
  assert.equal(other.status,201);
  const localSort=new Map([[`list:category:${root.data.category}`,{field:'due',direction:'asc'}]]);
  const view={groupMode:'category',categories:[{key:root.data.category}],categoryLabel:key=>key,
    sort:{field:'title',direction:'asc'},
    bucketSorts:localSort,limit:10,timeZone:'UTC'};
  assert.throws(()=>readOrderedTaskWindow(f.d,1,{}, {...view,timeZone:null}),/Viewer time zone/);
  const page=readOrderedTaskWindow(f.d,1,{},view);
  assert.deepEqual(page.ids.slice(0,2),[root.data.id,other.data.id],
    'bucket due override orders Trip by its displayed next step, not saved parent deadline');
});

test('ordinary progress descriptor matches authorized future and optional child projection',async t=>{
  const f=await scoringFixture(t);
  const root=await f.create({title:'Checklist',assigned_to:[2]});assert.equal(root.status,201);
  const add=f.d.prepare(`INSERT INTO tasks(title,category,priority,status,created_by,visibility,parent_task_id,start_date,is_optional,points)
    VALUES(?,'misc','medium',?,1,?, ?, ?, ?, 0)`);
  add.run('Finished','done','all',root.data.id,null,0);
  add.run('Tomorrow','open','all',root.data.id,'2026-11-02',0);
  add.run('Extra','open','all',root.data.id,null,1);
  add.run('Hidden','open','private',root.data.id,null,0);
  for(const actor of [1,2]){
    const full=await f.call('GET','/tasks',undefined,actor);assert.equal(full.status,200);
    const card=full.data.find(row=>row.id===root.data.id);
    const descriptor=readTaskListDescriptors(f.d,actor,{}, {progress:true}).rows.find(row=>row.id===root.data.id);
    assert.equal(descriptor.subtask_total,card.subtask_total);
    const required=card.subtasks.filter(child=>!child.is_optional);
    const total=required.length+(card.scheduled_subtask_total||0);
    const done=required.filter(child=>child.status==='done').length+(card.scheduled_subtask_done||0);
    assert.equal(descriptor.progress,total?done/total:0);
  }
});
