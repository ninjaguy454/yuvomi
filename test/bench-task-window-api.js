// Opt-in disposable local API benchmark: node --experimental-sqlite --test test/bench-task-window-api.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

const pct=(values,p)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return Number(sorted[Math.ceil(p*sorted.length)-1].toFixed(1));
};
test('measure authorized first page, continuation, and full list at 20/250/1000 roots',{timeout:180000},async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium','open',1,'all')");
  const url=offset=>`/tasks/window?view=${encodeURIComponent(JSON.stringify({groupMode:'none',sort:{field:'title',direction:'asc'},locale:'en',limit:30,offset}))}`;
  let size=0;
  for(const target of [20,250,1000]){
    f.d.transaction(()=>{while(size<target)insert.run(`Task ${String(++size).padStart(4,'0')}`);})();
    const first=[],next=[],full=[],writes=f.changes();
    for(let n=0;n<20;n++){
      let at=performance.now();const page=await f.call('GET',url(0));first.push(performance.now()-at);
      assert.equal(page.status,200,JSON.stringify(page));
      assert.equal(page.data.length,Math.min(target,30));
      if(page.next_cursor){
        at=performance.now();const more=await f.call('GET',`${url(30)}&page_cursor=${encodeURIComponent(page.next_cursor)}`);
        next.push(performance.now()-at);assert.equal(more.status,200);assert.ok(more.data.length);
      }
    }
    for(let n=0;n<3;n++){
      const at=performance.now();const response=await f.call('GET','/tasks?include_future=1');
      full.push(performance.now()-at);assert.equal(response.status,200);assert.equal(response.data.length,target);
    }
    assert.equal(f.changes(),writes,'reads write no Task data');
    process.stdout.write(`WINDOW_API size=${target} page_n=${first.length} page_p50=${pct(first,.5)} page_p95=${pct(first,.95)} page_p99=${pct(first,.99)} page_max=${pct(first,1)} next_n=${next.length} next_p50=${next.length?pct(next,.5):'na'} next_p95=${next.length?pct(next,.95):'na'} full_n=${full.length} full_p50=${pct(full,.5)} full_p95=${pct(full,.95)} writes=0 ms\n`);
  }
});
