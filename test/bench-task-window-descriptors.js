// Opt-in synthetic benchmark. Run with the repository's Node 24 runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';
import { readTaskListDescriptors } from '../server/services/task-list-query.js';

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a,b) => a-b);
  return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1] * 10) / 10;
};

test('synthetic descriptor versus full-card read by fixture size', { timeout: 120000 }, async t => {
  const f = await scoringFixture(t);
  const insert = f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'Sonstiges','medium','open',1,'all')");
  let size = 0;
  for (const target of [20,250,1000]) {
    f.d.transaction(() => { while (size < target) { size++; insert.run(`Window Task ${size}`); } })();
    const descriptor = [], full = [], writes = f.changes();
    for (let n = 0; n < 5; n++) {
      let at = performance.now();
      const window = readTaskListDescriptors(f.d, 1);
      descriptor.push(performance.now() - at);
      assert.equal(window.rows.length, target);
      at = performance.now();
      const response = await f.call('GET', '/tasks?include_future=1');
      full.push(performance.now() - at);
      assert.equal(response.status, 200); assert.equal(response.data.length, target);
    }
    assert.equal(f.changes(), writes, 'reads must make zero writes');
    process.stdout.write(`WINDOW_BENCH size=${target} n=5 descriptor_p50=${percentile(descriptor,.5)} descriptor_p95=${percentile(descriptor,.95)} full_p50=${percentile(full,.5)} full_p95=${percentile(full,.95)} ms\n`);
  }
});
