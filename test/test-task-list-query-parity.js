import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';
import { taskListWhere, readTaskListDescriptors } from '../server/services/task-list-query.js';

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
