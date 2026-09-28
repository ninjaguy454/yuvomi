import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const router=readFileSync(new URL('../public/router.js',import.meta.url),'utf8');
test('auth bootstrap does not turn a 502 or timeout into a login redirect',async()=>{
  const source=router.slice(router.indexOf('    // Auth-Guard'),router.indexOf('    if (currentUser && isWallModeEnabled()'));
  for(const status of [502,503,429,0,401]){
    const redirected=[],rendered=[];
    const error=Object.assign(new Error('upstream unavailable'),{status});
    const context={route:{requiresAuth:true},currentUser:null,auth:{me:async()=>{throw error}},
      currentPath:'/tasks',isNavigating:true,_pendingLoginRedirect:false,_setupRequired:false,
      document:{getElementById:()=>({remove(){}})},renderError:(_el,e)=>rendered.push(e),navigate:p=>redirected.push(p)};
    await runInNewContext('(async()=>{'+source+'})()',context);
    assert.deepEqual(redirected,status===401?['/login']:[],String(status));
    assert.equal(rendered.length,status===401?0:1);
    assert.equal(context.isNavigating,false);
  }
});
test('service-worker replacement never reloads an open draft on a timer',()=>{
  const source=readFileSync(new URL('../public/sw-register.js',import.meta.url),'utf8').replace('export function clearApiCache()','function clearApiCache()');
  const handlers={},events=[];let reloads=0;
  runInNewContext(source,{navigator:{serviceWorker:{addEventListener:(name,cb)=>handlers[name]=cb}},document:{addEventListener(){}},
    window:{addEventListener(){},dispatchEvent:e=>events.push(e.type),location:{reload:()=>reloads++}},
    CustomEvent:class{constructor(type){this.type=type}},setTimeout:cb=>cb(),console});
  handlers.controllerchange();handlers.controllerchange();
  assert.equal(reloads,0);
  assert.deepEqual(events,['app:update-available']);
});

