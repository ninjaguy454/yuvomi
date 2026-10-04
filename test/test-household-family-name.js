import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import {persistPreferenceActor} from './helpers/preferences-actor-fixture.js';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-household-name-tests';
const {get}=await import('../server/db.js');
const {default:preferences}=await import('../server/routes/preferences.js');
const {deviceAppPreferences}=await import('../server/services/device-app.js');
const d=get(),actor={role:'admin',userId:1};
const app=express();app.use(express.json());
app.use((req,_res,next)=>{req.authRole=actor.role;req.authUserId=actor.userId;persistPreferenceActor(d,req);next();});
app.use('/preferences',preferences);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));d.close();});
async function call(method='GET',body,role='admin') {
  actor.role=role;actor.userId=role==='admin'?1:2;
  const response=await fetch(`http://127.0.0.1:${server.address().port}/preferences`,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
test('family name starts empty, admin saves and clears it without changing app branding',async()=>{
  assert.equal((await call()).body.data.family_name,'');
  const saved=await call('PUT',{family_name:'  Maple Grove  '});
  assert.equal(saved.status,200);assert.equal(saved.body.data.family_name,'Maple Grove');
  assert.equal((await call()).body.data.family_name,'Maple Grove');
  assert.equal((await call()).body.data.app_name,'Vidamia');
  assert.equal((await call('PUT',{family_name:''})).body.data.family_name,'');
});
test('non-admin family-name writes fail before any accompanying preference mutation',async()=>{
  const before=(await call()).body.data.visible_meal_types;
  const denied=await call('PUT',{family_name:'Unauthorized',visible_meal_types:['snack']},'member');
  assert.equal(denied.status,403);
  assert.equal((await call()).body.data.family_name,'');
  assert.deepEqual((await call()).body.data.visible_meal_types,before);
});
test('family name rejects wrong types, excessive length and control characters',async()=>{
  for(const value of [null,123,{},'x'.repeat(81),'Name\nOther'])assert.equal((await call('PUT',{family_name:value})).status,400);
  assert.equal((await call()).body.data.family_name,'');
});
test('paired preferences read only the active household name, never personal overrides or another database',()=>{
  const other=new Database(':memory:');other.exec('CREATE TABLE sync_config(key TEXT PRIMARY KEY,value TEXT)');
  const principal={preferences:{},permissions:{modules:{}}};
  try {
    d.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run('family_name','Maple');
    d.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run('family_name:user:1','PRIVATE NAME');
    other.prepare('INSERT INTO sync_config(key,value) VALUES(?,?)').run('family_name','Willow');
    assert.equal(deviceAppPreferences(d,principal).family_name,'Maple');
    assert.equal(deviceAppPreferences(other,principal).family_name,'Willow');
    assert.equal(deviceAppPreferences(d,principal).family_name,'Maple');
    assert.doesNotMatch(JSON.stringify(deviceAppPreferences(d,principal)),/PRIVATE NAME|Willow/);
  } finally { other.close(); }
});
