import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {buildSubtaskOccurrenceSnapshot,resolveSubtaskOccurrence} from '../server/services/subtask-occurrence-resolution.js';
import {planSubtaskAssignments} from '../server/services/subtask-assignment-plan.js';
const stats=values=>{const n=[...values].sort((a,b)=>a-b),at=p=>+n[Math.min(n.length-1,Math.ceil(n.length*p)-1)].toFixed(2);
  return {n:n.length,p50_ms:at(.5),p95_ms:at(.95),p99_ms:at(.99),max_ms:+n.at(-1).toFixed(2)};};
for(const count of [32,50])test(`synthetic ${count} children, overlapping pools, skill and fixed workload`,{skip:!process.env.BENCH_SUBTASK_MODES},async t=>{
  const f=await scoringFixture(t);f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  for(let id=4;id<=21;id++)f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,'x','member','other')").run(id,'bench'+id,'Bench '+id);
  const groups=Array.from({length:12},(_,i)=>saveRotationGroup(f.d,{name:'Overlap '+i,member_ids:Array.from({length:8},(_,n)=>2+(i*2+n)%20)},{actorId:1}));
  const skills=Array.from({length:3},(_,i)=>Number(f.d.prepare('INSERT INTO skills(name,minimum_age,created_by) VALUES(?,0,1)').run('Bench skill '+i).lastInsertRowid));
  for(const skill of skills)for(let id=1;id<=21;id++)f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,id===1?'normal':id%7===0?'excluded':id%9===0?'supervised':'normal');
  const made=await f.create({title:'Benchmark',due_date:'2026-11-01',scoring_mode:'subtasks',subtasks:Array.from({length:count},(_,i)=>({title:'Child '+i,points:i%5?2:0,assigned_user_ids:i<2?[2,3]:[]}))});
  assert.equal(made.status,201,JSON.stringify(made));
  const rows=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(made.data.id);
  for(const [i,row] of rows.entries())if(i>=2){f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(row.id,skills[i%3]);
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)').run(row.id,JSON.stringify({kind:'group',group_id:groups[i%12].id,mode:'smart'}));}
  const costs={reads:0,writes:0};
  const traced=new Proxy(f.d,{get(target,key){if(key==='prepare')return sql=>new Proxy(target.prepare(sql),{get(statement,operation){
    if(['all','get','run'].includes(operation))return(...args)=>{costs[operation==='run'?'writes':'reads']++;return statement[operation](...args);};
    const value=statement[operation];return typeof value==='function'?value.bind(statement):value;
  }});const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const snapshot=[],planner=[];for(let n=0;n<23;n++){
    const begin=performance.now(),input=buildSubtaskOccurrenceSnapshot(traced,made.data.id);if(n>=3)snapshot.push(performance.now()-begin);
    const start=performance.now();planSubtaskAssignments({snapshotVersion:input.input_hash,occurrenceKey:'task:'+made.data.id,
      rows:input.rows.map(row=>({...row,eligible_user_ids:[...row.normal_user_ids,...row.supervised_candidates.map(item=>item.user_id)]}))});
    if(n>=3)planner.push(performance.now()-start);
  }
  // Reset each persistence sample with a caller-owned rollback, preserving an
  // identical real DB fixture. A separate durable commit follows these probes.
  const resolver=[],persistCalls=[],persistChanges=[],rollback=Symbol('benchmark-reset');
  for(let n=0;n<23;n++){
    costs.reads=0;costs.writes=0;const before=f.changes();
    try{f.d.transaction(()=>{const begin=performance.now();resolveSubtaskOccurrence(traced,{rootTaskId:made.data.id,actorId:1,idempotencyKey:'benchmark-sample'});
      if(n>=3){resolver.push(performance.now()-begin);persistCalls.push({...costs});persistChanges.push(f.changes()-before);}throw rollback;})();}
    catch(error){if(error!==rollback)throw error;}
  }
  costs.reads=0;costs.writes=0;const before=f.changes(),begin=performance.now();
  const receipt=resolveSubtaskOccurrence(traced,{rootTaskId:made.data.id,actorId:1,idempotencyKey:'benchmark-once'});
  const commit_ms=performance.now()-begin,commit_changes=f.changes()-before,commit_calls={...costs};
  const replay=[];costs.reads=0;costs.writes=0;const replayBefore=f.changes();
  for(let n=0;n<23;n++){const start=performance.now();resolveSubtaskOccurrence(traced,{rootTaskId:made.data.id,actorId:1,idempotencyKey:'benchmark-once'});if(n>=3)replay.push(performance.now()-start);}
  assert.equal(f.changes(),replayBefore);assert.equal(costs.writes,0);assert.equal(receipt.conflicts.length,0);
  assert.ok(commit_calls.reads<8000,'assignment notifications must share one supervision inspection per occurrence');
  t.diagnostic(JSON.stringify({children:count,groups:12,people:20,skills:3,snapshot:stats(snapshot),pure_planner:stats(planner),
    resolver_rollback_samples:stats(resolver),sample_counted_changes:[...new Set(persistChanges)],sample_calls:persistCalls[0],
    durable_commit_ms:+commit_ms.toFixed(2),commit_changes,commit_calls,replay:stats(replay),replay_writes:0,replay_read_calls:costs.reads/23}));
});
