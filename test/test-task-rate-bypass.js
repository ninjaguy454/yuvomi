import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { ordinaryTaskSessionBypass, withOrdinaryTaskSessionBypass } from '../server/services/task-rate-bypass.js';

const request=(method,path,session=null)=>({method,originalUrl:path,session,sessionID:session?'signed-session':undefined,
  query:Object.fromEntries(new URL(path,'http://localhost').searchParams)});

test('only signed-session ordinary Task reads and status/edit writes bypass the blanket quota',()=>{
  const session={userId:2};
  for(const [method,path] of [
    ['GET','/api/v1/tasks'],['GET','/api/v1/tasks?delta=signed'],['GET','/api/v1/tasks/window'],['GET','/api/v1/tasks/42'],
    ['GET','/api/v1/tasks/42/comments'],['GET','/api/v1/reminders?entity_type=task&entity_id=42'],
    ['PUT','/api/v1/tasks/42'],['PATCH','/api/v1/tasks/42/status'],
  ])assert.equal(ordinaryTaskSessionBypass(request(method,path,session)),true,`${method} ${path}`);
  for(const [method,path] of [
    ['POST','/api/v1/tasks'],['DELETE','/api/v1/tasks/42'],
    ['GET','/api/v1/auth/me'],['POST','/api/v1/auth/login'],['POST','/api/v1/device/pair'],
    ['GET','/api/v1/openapi.json'],['GET','/api/v1/tasks/categories'],
    ['GET','/api/v1/reminders?entity_type=note&entity_id=42'],['GET','/api/v1/reminders?entity_type=task'],
    ['POST','/api/v1/tasks/42/comments'],
    ['PATCH','/api/v1/tasks/42'],['PUT','/api/v1/tasks/42/documents'],
  ])assert.equal(ordinaryTaskSessionBypass(request(method,path,session)),false,`${method} ${path}`);
  assert.equal(ordinaryTaskSessionBypass(request('PATCH','/api/v1/tasks/42/status')),false);
  assert.equal(ordinaryTaskSessionBypass(request('PATCH','/api/v1/tasks/42/status',{userId:null})),false);
  assert.equal(ordinaryTaskSessionBypass({method:'GET',originalUrl:'/api/v1/tasks',session:{userId:2}}),false,'a session without a verified middleware ID retains the IP limit');
});

test('ordinary session mutations continue after other API calls exhaust the unchanged quota',async t=>{
  const app=express(),limiter=rateLimit({windowMs:60_000,max:2,standardHeaders:false,legacyHeaders:false});
  const signedLimiter=rateLimit({windowMs:60_000,max:3,standardHeaders:false,legacyHeaders:false,keyGenerator:req=>req.sessionID});
  app.use((req,_res,next)=>{if(req.get('X-Test-Session')==='yes'){req.session={userId:2};req.sessionID='synthetic-signed-session';}next();});
  app.use('/api/',withOrdinaryTaskSessionBypass(limiter,signedLimiter));
  app.all('/api/*splat',(req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(path,method='GET',session=false)=>fetch(base+path,{method,headers:session?{'X-Test-Session':'yes'}:{}});
  assert.equal((await call('/api/v1/auth/me')).status,200);
  assert.equal((await call('/api/v1/auth/me')).status,200);
  assert.equal((await call('/api/v1/auth/me')).status,429);
  assert.equal((await call('/api/v1/tasks/42/status','PATCH',true)).status,200);
  assert.equal((await call('/api/v1/tasks/42','PUT',true)).status,200);
  assert.equal((await call('/api/v1/tasks','GET',true)).status,200);
  assert.equal((await call('/api/v1/tasks/42','GET',true)).status,429,'a separate session guard bounds expensive ordinary operations');
  assert.equal((await call('/api/v1/tasks/42/status','PATCH',false)).status,429);
  assert.equal((await call('/api/v1/auth/login','POST',true)).status,429);
});

test('a longer signed Task session keeps Task detail ancillary reads off the shared quota',async t=>{
  const app=express(),counts=new Map();
  const limiter=rateLimit({windowMs:60_000,max:300,standardHeaders:false,legacyHeaders:false});
  const signed=rateLimit({windowMs:60_000,max:1200,standardHeaders:false,legacyHeaders:false,keyGenerator:req=>req.sessionID});
  app.use((req,_res,next)=>{req.session={userId:2};req.sessionID='synthetic-long-session';next();});
  app.use('/api/',withOrdinaryTaskSessionBypass(limiter,signed));
  app.all('/api/*splat',(req,res)=>{const key=`${req.method} ${req.path}`;counts.set(key,(counts.get(key)||0)+1);res.json({ok:true});});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  let attempts=0,limited=0;
  async function call(path,method='GET'){
    attempts++;const response=await fetch(base+path,{method});
    if(response.status===429)limited++;
    return response.status;
  }
  // 140 rapid parent open/complete/reopen cycles plus coalesced shell reads.
  // This checks limiter routing, not browser/network or database performance.
  for(let id=1;id<=140;id++){
    assert.equal(await call(`/api/v1/tasks/${id}/status`,'PATCH'),200);
    assert.equal(await call(`/api/v1/tasks/${id}`),200);
    assert.equal(await call(`/api/v1/tasks/${id}/comments`),200);
    assert.equal(await call(`/api/v1/reminders?entity_type=task&entity_id=${id}`),200);
    assert.equal(await call(`/api/v1/tasks/${id}/status`,'PATCH'),200);
    assert.equal(await call('/api/v1/dashboard'),200);
    if(id%2===0)assert.equal(await call('/api/v1/tasks'),200);
  }
  assert.equal(attempts,910);assert.equal(limited,0);
  assert.equal(counts.get('GET /api/v1/dashboard'),140);
  for(let n=0;n<430;n++)assert.equal(await call('/api/v1/tasks/window'),200);
  assert.equal(attempts,1340);
  assert.equal(limited,0,'all ordinary Task requests through the signed 1200-request budget succeeded');
  assert.equal(await call('/api/v1/tasks/window'),429,'the separate signed-session resource guard still bounds abuse');
  for(let n=0;n<160;n++)await call('/api/v1/dashboard');
  assert.equal(await call('/api/v1/dashboard'),429,'the unchanged shared quota still applies to Dashboard');
});
