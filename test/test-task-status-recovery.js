import test from 'node:test';
import assert from 'node:assert/strict';
let recoverTaskStatus;
try { ({recoverTaskStatus}=await import('../public/utils/task-status-recovery.js')); }
catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }
const unknown=()=>Object.assign(new Error('Connection interrupted'),{status:0,outcome:'unknown'});
const rejected=(status=409)=>Object.assign(new Error('Changed or forbidden'),{status,outcome:'rejected',data:{reason:'stale_revision'}});
function fixture(overrides={}) {
  const task={id:2,status:'open',revision:3,parent_task_id:1,parent_revision:9,permissions:{complete:true}};
  const body={status:'done',expected_revision:3,expected_parent_revision:9};
  const writes=[],reads=[],delays=[];let notices=0;
  const options={task,body,write:async value=>{writes.push(structuredClone(value));return{data:{...task,status:'done',revision:4}};},
    read:async()=>{reads.push(1);return{data:structuredClone(task)};},wait:async ms=>delays.push(ms),
    onUncertain:()=>notices++,isCurrent:()=>true,...overrides};
  return {task,body,writes,reads,delays,options,get notices(){return notices;},
    run(){assert.equal(typeof recoverTaskStatus,'function','status recovery must exist');return recoverTaskStatus(options);}};
}
test('normal success performs one write and no recovery read',async()=>{
  const f=fixture();assert.equal((await f.run()).data.status,'done');assert.equal(f.writes.length,1);assert.equal(f.reads.length,0);
});
test('failure before commit reads fresh state and resends only the frozen original CAS request',async()=>{
  const f=fixture();let calls=0;
  f.options.write=async body=>{f.writes.push(structuredClone(body));if(++calls===1){f.body.expected_revision=99;throw unknown();}return{data:{...f.task,status:'done',revision:4}};};
  assert.equal((await f.run()).data.status,'done');assert.equal(f.reads.length,1);assert.equal(f.notices,1);
  assert.deepEqual(f.writes,[{status:'done',expected_revision:3,expected_parent_revision:9},{status:'done',expected_revision:3,expected_parent_revision:9}]);
});
test('a committed write with a lost response is confirmed by a read without another write',async()=>{
  const f=fixture();f.options.write=async()=>{f.writes.push(1);f.task.status='done';f.task.revision++;throw unknown();};
  assert.equal((await f.run()).data.status,'done');assert.equal(f.writes.length,1);assert.equal(f.reads.length,1);
});
test('the original can commit after the read: stale replay reconciles instead of rebasing',async()=>{
  const f=fixture();let calls=0;
  f.options.write=async body=>{f.writes.push(structuredClone(body));if(++calls===1)throw unknown();f.task.status='done';f.task.revision++;throw rejected();};
  assert.equal((await f.run()).data.status,'done');assert.equal(f.writes.length,2);assert.equal(f.reads.length,2);
  assert.deepEqual(f.writes[0],f.writes[1]);
});
for(const field of ['revision','parent_revision'])test(`a changed ${field} stops recovery without another mutation`,async()=>{
  const f=fixture();f.options.write=async()=>{f.writes.push(1);f.task[field]++;throw unknown();};
  await assert.rejects(f.run(),error=>error.status===409);assert.equal(f.writes.length,1);
});
test('same-revision permission revocation ends recovery without a write',async()=>{
  const f=fixture();f.options.write=async()=>{f.writes.push(1);f.task.permissions.complete=false;throw unknown();};
  await assert.rejects(f.run(),error=>error.status===403);assert.equal(f.writes.length,1);
});
test('authentication switching during a fresh read prevents a replay',async()=>{
  const f=fixture();let current=true;f.options.isCurrent=()=>current;
  f.options.write=async()=>{f.writes.push(1);throw unknown();};f.options.read=async()=>{current=false;return{data:f.task};};
  await assert.rejects(f.run(),error=>error.data?.reason==='auth_context_changed');assert.equal(f.writes.length,1);
});
test('disposing during recovery stops automatic work',async()=>{
  const controller=new AbortController(),f=fixture({signal:controller.signal});
  f.options.write=async()=>{f.writes.push(1);throw unknown();};f.options.read=async()=>{controller.abort();throw unknown();};
  await assert.rejects(f.run(),error=>error.data?.reason==='status_recovery_stopped');assert.equal(f.writes.length,1);
});
test('unavailable fresh reads back off and cannot authorize another mutation',async()=>{
  const f=fixture();let writeCount=0,readCount=0;
  f.options.write=async body=>{f.writes.push(body);if(++writeCount===1)throw unknown();return{data:{...f.task,status:'done'}};};
  f.options.read=async()=>{readCount++;if(readCount<3)throw Object.assign(unknown(),{data:{reason:'stale_response'}});return{data:f.task};};
  await f.run();assert.equal(f.writes.length,2);assert.equal(readCount,3);assert.ok(f.delays.length>=2);assert.ok(f.delays.every(ms=>ms>=1000&&ms<=30000));
});
test('a real API read 503 with outcome rejected remains a temporary read outage',async()=>{
  const f=fixture();let writes=0,reads=0;
  f.options.write=async body=>{f.writes.push(body);if(++writes===1)throw unknown();return{data:{...f.task,status:'done'}};};
  f.options.read=async()=>{if(++reads===1)throw Object.assign(new Error('Unavailable'),{status:503,outcome:'rejected',transient:true});return{data:f.task};};
  assert.equal((await f.run()).data.status,'done');assert.equal(f.writes.length,2);assert.equal(reads,2);assert.equal(f.delays.length,1);
});
test('a hung write is bounded and its exact recovery can finish',async()=>{
  const f=fixture({requestTimeoutMs:10});let calls=0;
  f.options.write=async body=>{f.writes.push(body);if(++calls===1)return new Promise(()=>{});return{data:{...f.task,status:'done'}};};
  assert.equal((await f.run()).data.status,'done');assert.equal(f.writes.length,2);
});
test('a timed out response after commit confirms without another write',async()=>{
  const f=fixture({requestTimeoutMs:10});
  f.options.write=async body=>{f.writes.push(body);f.task.status='done';f.task.revision++;return new Promise(()=>{});};
  assert.equal((await f.run()).data.status,'done');assert.equal(f.writes.length,1);
});
test('a definite initial rejection does not trigger recovery',async()=>{
  const f=fixture();f.options.write=async()=>{throw rejected(403);};await assert.rejects(f.run(),error=>error.status===403);assert.equal(f.reads.length,0);
});
test('legacy writes without both required revision guards are never retried',async()=>{
  const f=fixture();delete f.body.expected_parent_revision;f.options.write=async()=>{f.writes.push(1);throw unknown();};
  await assert.rejects(f.run(),error=>error.outcome==='unknown');assert.equal(f.writes.length,1);assert.equal(f.reads.length,0);
});
