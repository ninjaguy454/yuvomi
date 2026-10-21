import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';
import { inspectTaskSupervision } from '../server/services/task-supervision.js';

test('unskilled leaf Task read returns empty supervision without repeated timezone lookups', async t => {
  const fixture = await scoringFixture(t);
  const id = Number(fixture.d.prepare("INSERT INTO tasks(title,created_by,assigned_to,status) VALUES('Ordinary Task',1,1,'open')")
    .run().lastInsertRowid);
  let configReads = 0;
  const original = fixture.d.prepare.bind(fixture.d);
  fixture.d.prepare = (sql, ...args) => {
    if (String(sql).includes('SELECT value FROM sync_config WHERE key = ?')) configReads++;
    return original(sql, ...args);
  };
  const view = inspectTaskSupervision(fixture.d, id);
  assert.equal(view.state, 'none');
  assert.equal(view.display_reason, null);
  assert.deepEqual(view.actions, []);
  assert.equal(configReads, 0);
});
