// Opt-in disposable local API benchmark: node --experimental-sqlite --test test/bench-task-window-api.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {captureTaskListClock,recordTaskListDelta} from '../server/services/task-list-delta.js';

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
    const originalPrepare=f.d.prepare;let initialPrepares=0,initial;
    f.d.prepare=function(...args){initialPrepares++;return originalPrepare.apply(this,args);};
    try{initial=await f.call('GET',url(0));}finally{delete f.d.prepare;}
    assert.equal(initial.status,200);
    const initialBytes=Buffer.byteLength(JSON.stringify(initial));
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
    process.stdout.write(`WINDOW_API size=${target} initial_cards=${initial.data.length} initial_bytes=${initialBytes} initial_sql_prepares=${initialPrepares} page_n=${first.length} page_p50=${pct(first,.5)} page_p95=${pct(first,.95)} page_p99=${pct(first,.99)} page_max=${pct(first,1)} next_n=${next.length} next_p50=${next.length?pct(next,.5):'na'} next_p95=${next.length?pct(next,.95):'na'} full_n=${full.length} full_p50=${pct(full,.5)} full_p95=${pct(full,.95)} writes=0 ms\n`);
    let loaded=initial.data.length,page=initial;
    const count=Math.min(target,Number(process.env.VIDAMIA_WINDOW_BENCH_LOADED||250));
    while(page.next_cursor&&loaded<count){
      const view={groupMode:'none',sort:{field:'title',direction:'asc'},locale:'en',limit:Math.min(100,count-loaded),offset:page.next_offset};
      page=await f.call('GET',`/tasks/window?view=${encodeURIComponent(JSON.stringify(view))}&page_cursor=${encodeURIComponent(page.next_cursor)}&known_cursor=${encodeURIComponent(page.delta_cursor)}`);
      assert.equal(page.status,200,JSON.stringify(page));loaded+=page.data.length;
    }
    let cursor=page.delta_cursor,deltaPrepares=0,deltaBytes=0;
    const delta=[];
    for(let n=0;n<20;n++){
      f.d.transaction(()=>{
        const before=captureTaskListClock(f.d);
        f.d.prepare('UPDATE tasks SET title=?,revision=revision+1 WHERE id=1').run(`Task ${String(n%2?1:0).padStart(4,'0')}`);
        recordTaskListDelta(f.d,before,[1]);
      })();
      const original=f.d.prepare;let prepares=0;
      f.d.prepare=function(...args){prepares++;return original.apply(this,args);};
      const at=performance.now();let answer;
      try{answer=await f.call('GET',`/tasks/window?view=${encodeURIComponent(JSON.stringify({groupMode:'none',sort:{field:'title',direction:'asc'},locale:'en',limit:30,offset:0}))}&window_count=${loaded}&window_delta=${encodeURIComponent(cursor)}`);}
      finally{delete f.d.prepare;}
      delta.push(performance.now()-at);
      assert.equal(answer.status,200,JSON.stringify(answer));assert.equal(answer.delta,true);
      cursor=answer.delta_cursor;deltaPrepares+=prepares;deltaBytes+=Buffer.byteLength(JSON.stringify(answer));
    }
    process.stdout.write(`WINDOW_DELTA size=${target} loaded=${loaded} delta_n=${delta.length} delta_p50=${pct(delta,.5)} delta_p95=${pct(delta,.95)} delta_p99=${pct(delta,.99)} delta_max=${pct(delta,1)} mean_sql_prepares=${Math.round(deltaPrepares/delta.length)} mean_bytes=${Math.round(deltaBytes/delta.length)} ms\n`);
  }
});
