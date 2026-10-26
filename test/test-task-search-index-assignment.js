import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

test('assignment-only Task edits preserve searchable text without rebuilding the FTS document',async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({title:'Searchable assignment title',description:'Searchable assignment detail'});
  assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id;
  const search=()=>f.d.prepare("SELECT title,body FROM search_index WHERE entity='task' AND entity_id=?").get(id);
  assert.match(search().title,/Searchable assignment title/);
  assert.match(search().body,/Searchable assignment detail/);
  const before=f.changes();
  f.d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(2,id);
  const assignmentChanges=f.changes()-before;
  assert.ok(assignmentChanges<20,`assignment-only edit caused ${assignmentChanges} database changes`);
  assert.match(search().title,/Searchable assignment title/);
  f.d.prepare("UPDATE tasks SET title='Changed searchable title',description='Changed searchable detail' WHERE id=?").run(id);
  assert.match(search().title,/Changed searchable title/);
  assert.match(search().body,/Changed searchable detail/);
  f.d.prepare("INSERT INTO task_tags(task_id,tag,tag_key) VALUES(?,'special-tag','special-tag')").run(id);
  assert.match(search().body,/special-tag/);
});
