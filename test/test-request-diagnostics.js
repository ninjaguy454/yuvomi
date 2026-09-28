import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {requestDiagnostics} from '../server/middleware/request-diagnostics.js';

function fixture(options = {}) {
  let time = 0;
  const records = [];
  const middleware = requestDiagnostics({now:()=>time,log:{warn:(message,data)=>records.push({message,data})},...options});
  const request = (url='/api/v1/tasks/123?token=secret&title=private') => {
    const req={url,method:'PATCH',body:{secret:'password'},headers:{authorization:'private'}};
    const res=new EventEmitter(); res.statusCode=200;res.headers={};res.setHeader=(k,v)=>res.headers[k]=v;
    let next=0;middleware(req,res,()=>next++);assert.equal(next,1);
    return res;
  };
  return {request,records,tick:ms=>time+=ms};
}
test('diagnostics record response classification and timing without URL/identity/body/headers',()=>{
  const f=fixture();
  for(const [status,outcome] of [[401,'unauthenticated'],[403,'forbidden'],[409,'conflict'],[429,'rate_limited'],[500,'server_error'],[502,'server_error']]){
    const r=f.request(); f.tick(25);r.statusCode=status;r.emit('finish');r.emit('close');
    assert.equal(f.records.at(-1).data.outcome,outcome);
    assert.equal(f.records.at(-1).data.durationMs,25);
    assert.equal(f.records.at(-1).data.resource,'tasks');
    assert.match(r.headers['X-Request-ID'],/^[a-f0-9-]{36}$/);
  }
  assert.equal(f.records.length,6);
  assert.doesNotMatch(JSON.stringify(f.records),/secret|private|password|authorization|123/);
  assert.deepEqual(Object.keys(f.records[0].data).sort(),['durationMs','method','outcome','requestId','resource','status']);
});
test('successful interactive requests are silent unless slow; normal SSE close is silent',()=>{
  const f=fixture();
  let r=f.request();f.tick(50);r.emit('finish');
  r=f.request('/api/v1/tasks/changes?context=private');f.tick(120000);r.emit('close');
  assert.equal(f.records.length,0);
  r=f.request();f.tick(2100);r.emit('finish');assert.equal(f.records[0].data.outcome,'slow');
});
test('aborted response is unknown transport outcome and not logged twice',()=>{
  const f=fixture(),r=f.request();f.tick(100);r.emit('close');r.emit('close');
  assert.equal(f.records.length,1);
  assert.equal(f.records[0].data.outcome,'connection_closed_before_response');
});
test('logging rate is bounded with a summary; disable avoids listeners and correlation header',()=>{
  const f=fixture({limit:2});
  for(let i=0;i<8;i++){const r=f.request();r.statusCode=503;r.emit('finish');}
  assert.equal(f.records.length,2);
  f.tick(60001);const r=f.request();r.statusCode=429;r.emit('finish');
  assert.equal(f.records.length,4);assert.deepEqual(f.records[2],{message:'Request diagnostics suppressed',data:{count:6}});
  const disabled=fixture({enabled:false}),s=disabled.request();
  assert.equal(s.listenerCount('finish'),0);assert.equal(Object.keys(s.headers).length,0);
  assert.equal(f.request('/tasks').listenerCount('finish'),0);
});

