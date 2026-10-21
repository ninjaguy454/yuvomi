// Opt-in synthetic benchmark. Run with the repository's Node 24 runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';
import { readTaskListDescriptors, readOrderedTaskWindow } from '../server/services/task-list-query.js';

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a,b) => a-b);
  return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1] * 10) / 10;
};

test('synthetic descriptor versus full-card read by fixture size', { timeout: 120000 }, async t => {
  const f = await scoringFixture(t);
  const insert = f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'Sonstiges','medium','open',1,'all')");
  const childInsert = f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility,parent_task_id) VALUES('Action','Sonstiges','medium','open',1,'all',?)");
  let size = 0;
  for (const target of [20,250,1000]) {
    f.d.transaction(() => { while (size < target) { size++; insert.run(`Window Task ${size}`); } })();
    if (target >= 250) f.d.transaction(() => {
      const roots=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id IS NULL ORDER BY id LIMIT ?').all(target===250?25:100);
      for(const row of roots.slice(target===250?0:25))for(let n=0;n<2;n++)childInsert.run(row.id);
    })();
    const descriptor = [], page = [], full = [], writes = f.changes();
    for (let n = 0; n < 5; n++) {
      let at = performance.now();
      const window = readTaskListDescriptors(f.d, 1);
      descriptor.push(performance.now() - at);
      assert.equal(window.rows.length, target);
      at = performance.now();
      const first=readOrderedTaskWindow(f.d,1,{}, {groupMode:'none',sort:{field:'title',direction:'asc'},limit:30});
      page.push(performance.now() - at);
      assert.equal(first.ids.length,Math.min(target,30));assert.equal(first.total,target);
      at = performance.now();
      const response = await f.call('GET', '/tasks?include_future=1');
      full.push(performance.now() - at);
      assert.equal(response.status, 200); assert.equal(response.data.length, target);
    }
    const warmed=[];
    for(let n=0;n<30;n++){
      const at=performance.now();
      readOrderedTaskWindow(f.d,1,{}, {groupMode:'none',sort:{field:'title',direction:'asc'},limit:30});
      warmed.push(performance.now()-at);
    }
    assert.equal(f.changes(), writes, 'reads must make zero writes');
    const originalPrepare = f.d.prepare;
    const calls = { prepare: 0, get: 0, all: 0, run: 0 };
    f.d.prepare = function(sql) {
      calls.prepare++;
      const statement = originalPrepare.call(this, sql);
      return new Proxy(statement, { get(target, property) {
        if (['get','all','run'].includes(property)) return (...args) => {
          calls[property]++; return target[property](...args);
        };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    try { readTaskListDescriptors(f.d, 1); } finally { f.d.prepare = originalPrepare; }
    process.stdout.write(`WINDOW_BENCH size=${target} roots=${target} nested=${target<250?0:target===250?50:200} page_n=30 page_p50=${percentile(warmed,.5)} page_p95=${percentile(warmed,.95)} page_p99=${percentile(warmed,.99)} page_max=${Math.round(Math.max(...warmed)*10)/10} full_n=5 full_p50=${percentile(full,.5)} full_p95=${percentile(full,.95)} prepares=${calls.prepare} gets=${calls.get} alls=${calls.all} writes=0 ms\n`);
  }
});
