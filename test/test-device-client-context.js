import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const contextSource=readFileSync(new URL('../public/utils/device-context.js',import.meta.url),'utf8');
const apiSource=readFileSync(new URL('../public/api.js',import.meta.url),'utf8');
function harness(fetch){
  const storage=new Map(),events=[],context=vm.createContext({
    fetch,AbortController,Date,Math,Map,Set,JSON,Number,String,Object,Promise,
    window:{dispatchEvent:event=>events.push(event.type)},document:{cookie:'csrf-token=test',documentElement:{style:{}}},navigator:{},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
    clearApiCache(){},setPermissions(){},clearPermissions(){},setHouseholdSize(){},clearHouseholdSize(){},forgetLayoutHint(){},broadcastSessionChange(){},setWallModeEnabled(){},
  });
  vm.runInContext(contextSource.replaceAll('export ',''),context);
  vm.runInContext(apiSource.replace(/^import .*;\r?\n/gm,'').replace(/^export \{.*\};\r?\n?/gm,''),context);
  return {context,events,run:code=>vm.runInContext(code,context)};
}
const response=(data,status=200,headers={})=>({status,ok:status>=200&&status<300,headers:{get:key=>headers[key]||null},json:async()=>data});
test('a queued device request remains bound to its original context and late private JSON never escapes',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve),requests=[];
  const app=harness(async(url,options)=>{requests.push(options);return pending;});
  app.run("acceptAuthentication({authContext:'device-one',principal:{kind:'device'},device:{name:'Kitchen Wall'}})");
  const request=app.run("api.patch('/device/tasks/7/status',{status:'done'})");
  assert.equal(requests[0].headers['X-Auth-Context'],'device-one');
  app.run("acceptAuthentication({authContext:'personal-two',user:{id:1},device:{name:'Kitchen Wall'},temporary:{}})");
  assert.equal(requests[0].signal.aborted,true);
  release(response({private:'must not publish','csrfToken':'private-token'}));
  await assert.rejects(request,error=>error.data.reason==='auth_context_changed');
  assert.equal(app.run('_csrfToken'),'');
});
test('CSRF retry keeps the old context and refuses a response changing principal',async()=>{
  const requests=[];const app=harness(async(url,options)=>{
    requests.push({url,options});
    return requests.length===1?response({error:'csrf'},403):response({authContext:'changed-context',csrfToken:'new'});
  });
  app.run("acceptAuthentication({authContext:'device-one',principal:{kind:'device'},device:{}})");
  await assert.rejects(app.run("api.patch('/device/tasks/7/status',{status:'done'})"),error=>error.data.reason==='auth_context_changed');
  assert.equal(requests.length,2,'no mutation retry with new privilege');
  assert.ok(requests.every(request=>request.options.headers['X-Auth-Context']==='device-one'));
});
test('a context change while body parsing is pending suppresses response and token publication',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const app=harness(async()=>({...response({}),json:()=>pending,headers:{get:()=> 'private-token'}}));
  app.run("acceptAuthentication({authContext:'personal',device:{},temporary:{}})");
  const request=app.run("api.get('/tasks')");await Promise.resolve();
  app.run("acceptAuthentication({authContext:'device',device:{},principal:{kind:'device'}})");release({secret:'private'});
  await assert.rejects(request,error=>error.data.reason==='auth_context_changed');assert.equal(app.run('_csrfToken'),'');
});
test('ordinary personal API requests retain existing behavior without device context',async()=>{
  let headers;const app=harness(async(_url,options)=>{headers=options.headers;return response({data:[1,2]});});
  const result=await app.run("api.get('/tasks')");assert.deepEqual(result,{data:[1,2]});assert.equal(headers['X-Auth-Context'],undefined);
});
test('paired unauthorized responses signal immediate context teardown before generic expiry',async()=>{
  const app=harness(async()=>response({reason:'device_revoked'},401));
  app.run("acceptAuthentication({authContext:'temporary',device:{},temporary:{}})");
  await assert.rejects(app.run("api.get('/tasks')"));
  assert.deepEqual(app.events.slice(-2),['auth:context-rejected','auth:expired']);
});

test('revoked launch/context bootstrap stays on the neutral recovery page instead of redirect looping',async()=>{
  for(const path of ['/device/launch','/device/context']){
    const app=harness(async()=>response({error:'Access revoked',reason:'device_revoked'},401));
    app.run("acceptAuthentication({authContext:'device',device:{},principal:{kind:'device'}})");
    const before=app.events.length;await assert.rejects(app.run(`api.get('${path}')`),error=>error.status===401);
    assert.deepEqual(app.events.slice(before),[]);
  }
});
