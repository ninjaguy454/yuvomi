// Opt in with VIDAMIA_ARCHIVE_BENCH=1. Two cloned synthetic SQLite databases
// share one loopback server, then reads alternate pre/post archival states.
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {_setTestDatabase} from '../server/db.js';
import {reconcileTaskAutoArchive} from '../server/services/task-auto-archive.js';
import {taskListWhere} from '../server/services/task-list-query.js';

const enabled=process.env.VIDAMIA_ARCHIVE_BENCH==='1';
const page='/tasks/window?view='+encodeURIComponent(JSON.stringify({groupMode:'none',sort:{field:'title',direction:'asc'},locale:'en',limit:30,offset:0}));
const pct=(values,p)=>{const a=[...values].sort((x,y)=>x-y);return +(a[Math.ceil(a.length*p)-1]||0).toFixed(1);};
const summary=values=>({n:values.length,p50:pct(values,.5),p95:pct(values,.95),p99:pct(values,.99),max:pct(values,1)});

test('paired interleaved Task archive window', {skip:!enabled,timeout:180000}, async t=>{
  const f=await scoringFixture(t);
  const count=Number(process.env.ARCHIVE_PAIRED_COUNT||250),old=Math.floor(count*.7);
  if(!Number.isSafeInteger(count)||count<30||count>2000)throw new RangeError('Invalid synthetic archive size');
  const insert=f.d.prepare("INSERT INTO tasks(title,category,priority,status,created_by,visibility) VALUES(?,'misc','medium',?,1,'all')");
  const complete=f.d.prepare('INSERT INTO task_completions(task_id,series_id,user_id,completed_at) VALUES(?,?,1,?)');
  const child=f.d.prepare("INSERT INTO tasks(title,category,status,created_by,parent_task_id) VALUES('Step','misc','done',1,?)");
  f.d.transaction(()=>{for(let n=0;n<count;n++){
    const title=n<old?`Z historical ${String(n).padStart(4,'0')}`:`A active ${String(n).padStart(4,'0')}`;
    const id=Number(insert.run(title,n<old?'done':'open').lastInsertRowid);
    if(n<old)complete.run(id,id,'2026-09-01T12:00:00Z');
    if(n<old&&n%10===0)child.run(id);
  }})();
  const scratch=mkdtempSync(join(tmpdir(),'vidamia-archive-paired-'));
  const before=join(scratch,'pre.db'),after=join(scratch,'post.db');
  let preDb,postDb;
  try{
    await f.d.backup(before);
    await f.d.backup(after);
    preDb=new Database(before);postDb=new Database(after);
    for(const d of [preDb,postDb])d.pragma('foreign_keys=ON');
    let swept=0;
    while(swept<old){const result=reconcileTaskAutoArchive(postDb,{now:new Date('2026-11-01T12:00:00Z'),maxBatch:100});
      assert.deepEqual(result.failedIds,[]);assert.ok(result.archivedIds.length);swept+=result.archivedIds.length;}
    const journal={pre:preDb.pragma('journal_mode',{simple:true}),post:postDb.pragma('journal_mode',{simple:true})};
    if(process.env.ARCHIVE_PAIRED_CHECKPOINT==='1')postDb.pragma('wal_checkpoint(TRUNCATE)');
    const times={pre:[],post:[]},cpu={pre:[],post:[]};
    for(const state of ['pre','post'])for(let i=0;i<5;i++){
      _setTestDatabase(state==='pre'?preDb:postDb);
      assert.equal((await f.call('GET',page)).status,200);
    }
    const cycles=Math.min(100,Math.max(1,Number(process.env.ARCHIVE_PAIRED_CYCLES)||20));
    for(let n=0;n<cycles;n++)for(const state of ['pre','post','post','pre']){
      _setTestDatabase(state==='pre'?preDb:postDb);
      const used=process.cpuUsage(),at=performance.now();
      const response=await f.call('GET',page);
      const elapsed=process.cpuUsage(used);
      assert.equal(response.status,200,JSON.stringify(response));
      assert.equal(response.data.length,30);
      times[state].push(performance.now()-at);
      cpu[state].push((elapsed.user+elapsed.system)/1000);
    }
    const plans={};
    for(const [state,d] of [['pre',preDb],['post',postDb]]){
      const {where,values}=taskListWhere(d,1,{});
      plans[state]=d.prepare(`EXPLAIN QUERY PLAN SELECT t.id FROM tasks t ${where}`).all(...values);
    }
    const profiles={};
    if(process.env.ARCHIVE_PAIRED_PROFILE==='1')for(const [state,d] of [['pre',preDb],['post',postDb]]){
      _setTestDatabase(d);
      const original=d.prepare,totals=new Map();
      d.prepare=function(sql,...args){
        const statement=original.call(this,sql,...args),key=String(sql).replace(/\s+/g,' ').slice(0,130);
        return new Proxy(statement,{get(target,prop){
          const value=target[prop];
          if(typeof value!=='function')return value;
          if(!['get','all','run'].includes(prop))return value.bind(target);
          return (...params)=>{const at=performance.now();try{return value.apply(target,params);}finally{
            const entry=totals.get(key)||{calls:0,ms:0};entry.calls++;entry.ms+=performance.now()-at;totals.set(key,entry);
          }};
        }});
      };
      try{for(let i=0;i<5;i++)assert.equal((await f.call('GET',page)).status,200);}
      finally{delete d.prepare;}
      profiles[state]=[...totals].sort((a,b)=>b[1].ms-a[1].ms).slice(0,15)
        .map(([sql,row])=>({sql,calls:row.calls,ms:+row.ms.toFixed(1)}));
    }
    process.stdout.write(`AUTO_ARCHIVE_PAIRED ${JSON.stringify({count,old,pre:summary(times.pre),post:summary(times.post),
      cpu_pre:summary(cpu.pre),cpu_post:summary(cpu.post),journal,plans:plans.pre.length===plans.post.length&&plans.pre.every((row,i)=>row.detail===plans.post[i].detail)?'identical':plans,
      ...(process.env.ARCHIVE_PAIRED_PROFILE==='1'?{profiles}:{})})}\n`);
  }finally{
    _setTestDatabase(f.d);
    preDb?.close();postDb?.close();
    rmSync(scratch,{recursive:true,force:true});
  }
});
