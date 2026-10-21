// Opt-in synthetic comparison: set VIDAMIA_ARCHIVE_BENCH=1, then run with Node 24
// --experimental-sqlite --test test/bench-task-auto-archive.js.
// The pre-sweep path has the same active-list SQL as pinned c5741a44.
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {reconcileTaskAutoArchive} from '../server/services/task-auto-archive.js';
import {taskListWhere} from '../server/services/task-list-query.js';

const pct=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return +(sorted[Math.ceil(sorted.length*p)-1]||0).toFixed(1);};
const page='/tasks/window?view='+encodeURIComponent(JSON.stringify({groupMode:'none',sort:{field:'title',direction:'asc'},locale:'en',limit:30,offset:0}));
const enabled=process.env.VIDAMIA_ARCHIVE_BENCH==='1';

for (const count of [20,250,1000]) test(`Task archive synthetic ${count} roots`,{timeout:180000,skip:!enabled},async t=>{
  const f=await scoringFixture(t);
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium',?,1,'all')");
  const complete=f.d.prepare('INSERT INTO task_completions(task_id,series_id,user_id,completed_at) VALUES(?,?,1,?)');
  const child=f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Step','misc','done',1,?)");
  const old=Math.floor(count*.7);
  f.d.transaction(()=>{for(let n=0;n<count;n++){
    const title=n<old?`Z historical ${String(n).padStart(4,'0')}`:`A active ${String(n).padStart(4,'0')}`;
    const id=Number(insert.run(title,n<old?'done':'open').lastInsertRowid);
    if(n<old)complete.run(id,id,'2026-09-01T12:00:00Z');
    if(n<old&&n%10===0)child.run(id);
  }})();
  const measure=async label=>{
    const pageTimes=[],fullTimes=[];
    let initialBytes=0,prepares=0,topSql=[];
    for(let i=0;i<5;i++)assert.equal((await f.call('GET',page)).status,200);
    for(let n=0;n<20;n++){
      const original=f.d.prepare;let calls=0;const tally=new Map();
      if(n===0)f.d.prepare=function(...args){calls++;const key=String(args[0]).replace(/\s+/g,' ').slice(0,100);tally.set(key,(tally.get(key)||0)+1);return original.apply(this,args);};
      const at=performance.now();let response;
      try{response=await f.call('GET',page);}finally{if(n===0){delete f.d.prepare;prepares=calls;topSql=[...tally].sort((a,b)=>b[1]-a[1]).slice(0,8);}}
      pageTimes.push(performance.now()-at);
      assert.equal(response.status,200,JSON.stringify(response));
      if(n===0)initialBytes=Buffer.byteLength(JSON.stringify(response));
      assert.equal(response.data.length,Math.min(30,label==='pre'?count:count-old));
    }
    for(let n=0;n<5;n++){
      const at=performance.now();const response=await f.call('GET','/tasks?include_future=1');
      fullTimes.push(performance.now()-at);assert.equal(response.status,200);
      assert.equal(response.data.length,label==='pre'?count:count-old);
    }
    return {page_n:pageTimes.length,page_p50:pct(pageTimes,.5),page_p95:pct(pageTimes,.95),page_p99:pct(pageTimes,.99),
      page_max:pct(pageTimes,1),full_n:fullTimes.length,full_p50:pct(fullTimes,.5),full_p95:pct(fullTimes,.95),
      initial_bytes:initialBytes,initial_prepares:prepares,...(process.env.ARCHIVE_BENCH_DEBUG?{top_sql:topSql}: {})};
  };
  const pre=await measure('pre');
  if(process.env.ARCHIVE_BENCH_DEBUG){const {where,values}=taskListWhere(f.d,1,{});process.stdout.write(`ARCHIVE_PLAN_PRE ${count} ${JSON.stringify(f.d.prepare(`EXPLAIN QUERY PLAN SELECT t.id FROM tasks t ${where}`).all(...values))}\n`);}
  const start=performance.now(),changesBefore=f.changes();
  let archived=0,batches=0;
  while(archived<old){
    const result=reconcileTaskAutoArchive(f.d,{now:new Date('2026-11-01T12:00:00Z'),maxBatch:100});
    assert.deepEqual(result.failedIds,[]);assert.ok(result.archivedIds.length);
    archived+=result.archivedIds.length;batches++;
  }
  const sweepMs=+(performance.now()-start).toFixed(1),sweepChanges=f.changes()-changesBefore;
  const noOpBefore=f.changes(),noOpAt=performance.now();
  assert.deepEqual(reconcileTaskAutoArchive(f.d,{now:new Date('2026-11-01T12:00:00Z'),maxBatch:100}).archivedIds,[]);
  const noOpMs=+(performance.now()-noOpAt).toFixed(1),noOpChanges=f.changes()-noOpBefore;
  const post=await measure('post');
  if(process.env.ARCHIVE_BENCH_DEBUG){const {where,values}=taskListWhere(f.d,1,{});process.stdout.write(`ARCHIVE_PLAN_POST ${count} ${JSON.stringify(f.d.prepare(`EXPLAIN QUERY PLAN SELECT t.id FROM tasks t ${where}`).all(...values))}\n`);}
  process.stdout.write(`AUTO_ARCHIVE_BENCH ${JSON.stringify({count,old,active_after:count-old,batches,sweep_ms:sweepMs,sweep_changes:sweepChanges,no_op_ms:noOpMs,no_op_changes:noOpChanges,pre,post})}\n`);
});
