/** Independent boundary regressions: HTTP aliases and revoked pending pairing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs/promises';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET||='device-adversarial-isolated';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {beginPairing,approvePairing,claimPairing,revokeDevice,deviceBoundary,normalizeDevicePermissions}=await import('../server/services/devices.js');
const {default:readerRouter}=await import('../server/routes/reader.js');
const {default:backupRouter}=await import('../server/routes/backup.js');
let d,admin;
test.beforeEach(()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);}
  _setTestDatabase(d);
  d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
  admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('admin','Admin','x','admin')").run().lastInsertRowid);
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});

test('case-insensitive Express aliases cannot bypass device denial for Reader, token-only feeds or public API surfaces',async()=>{
  const pairing=beginPairing(d);approvePairing(d,pairing.code,{name:'Display'},admin);const credential=claimPairing(d,pairing.secret);
  d.prepare("INSERT INTO tasks(title,created_by,visibility) VALUES('PRIVATE READER SENTINEL',?,'private')").run(admin);
  const app=express();app.use(express.json());
  // Deliberately lingering personal session must never authorize a device.
  app.use((req,res,next)=>{req.session={userId:admin,role:'admin',csrfToken:'x'.repeat(64)};req.sessionID='lingering-personal';next();});
  app.use((req,res,next)=>deviceBoundary(d,req,res,next));app.use('/reader',readerRouter);
  app.get('/feed/calendar/:token.ics',(_req,res)=>res.send('PRIVATE PERSONAL FEED SENTINEL'));
  app.get('/feed/inventory-deadlines/:token.ics',(_req,res)=>res.send('PRIVATE PERSONAL FEED SENTINEL'));
  app.post('/api/v1/auth/invites/accept',(_req,res)=>res.json({forbiddenMutation:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`,headers={cookie:`vidamia.device=${credential.token}`,'content-type':'application/json'};
    for(const path of ['/reader?view=tasks','/Reader?view=tasks','/READER/?view=tasks']) {
      const res=await fetch(base+path,{headers});const body=await res.text();assert.equal(res.status,403,path);assert.ok(!body.includes('PRIVATE READER SENTINEL'),path);
    }
    for(const path of ['/feed/calendar/synthetic.ics','/FEED/CALENDAR/synthetic.ics','/feed/inventory-deadlines/synthetic.ics']) {
      const res=await fetch(base+path,{headers});const body=await res.text();assert.equal(res.status,403,path);assert.ok(!body.includes('PRIVATE PERSONAL FEED SENTINEL'),path);
    }
    for(const path of ['/api/v1/auth/invites/accept','/API/V1/AUTH/INVITES/ACCEPT']) {
      const res=await fetch(base+path,{method:'POST',headers,body:'{}'});const body=await res.text();assert.ok(res.status>=400,path);assert.ok(!body.includes('forbiddenMutation'),path);
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('access replacement invalidates an earlier approved pairing that has not been claimed',()=>{
  const earlier=beginPairing(d),device=approvePairing(d,earlier.code,{name:'Old display'},admin);
  const replacement=beginPairing(d);approvePairing(d,replacement.code,{replace_device_id:device.id,revision:device.revision},admin);
  assert.throws(()=>claimPairing(d,earlier.secret),/expired|approved|revoked|replaced/i);
  const current=claimPairing(d,replacement.secret);assert.equal(current.device.id,device.id);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM device_credentials WHERE device_id=? AND revoked_at IS NULL').get(device.id).n,1);
});

test('revocation followed by replacement never revives an earlier unclaimed pairing',()=>{
  const earlier=beginPairing(d),device=approvePairing(d,earlier.code,{name:'Old display'},admin);
  revokeDevice(d,device.id,device.revision,admin);
  const replacement=beginPairing(d);approvePairing(d,replacement.code,{replace_device_id:device.id,revision:device.revision+1},admin);
  assert.throws(()=>claimPairing(d,earlier.secret),/expired|approved|revoked|replaced/i);
  assert.equal(claimPairing(d,replacement.secret).device.id,device.id);
});

test('admin/body identity and unsupported member capabilities never become device permissions',()=>{
  const permissions=normalizeDevicePermissions({admin:true,role:'admin',authUserId:admin});assert.equal(permissions.admin,false);
  assert.equal(permissions.capabilities['tasks.create'],'none');
  for(const key of ['admin.permissions','workflows.run','activities.create','tasks.complete_others','rotations.advance'])
    assert.throws(()=>normalizeDevicePermissions({capabilities:{[key]:'allow'}}),/personal access/);
});

test('database restore requires an ordinary personal browser before any file operation; other admin backup reads remain available',async t=>{
  let fileOperations=0;
  t.mock.method(fs,'mkdtemp',async()=>{fileOperations++;throw new Error('ISOLATED RESTORE DISPATCH');});
  const app=express();
  app.use((req,res,next)=>{
    req.authRole='admin';req.authUserId=admin;req.session={userId:admin};
    if(req.headers['x-fixture-context']==='bound-session')req.session.deviceCredentialId=7;
    if(req.headers['x-fixture-context']==='temporary')req.deviceContext={credential:{temporary_user_id:admin}};
    next();
  });
  app.use('/api/v1/backup',backupRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/v1/backup`;
    for(const context of ['device-cookie','bound-session','temporary']) {
      const headers={'content-type':'application/octet-stream','x-fixture-context':context,
        ...(context==='device-cookie'?{cookie:'vidamia.device=isolated-fixture'}:{})};
      const response=await fetch(url+'/restore',{method:'POST',headers,body:Buffer.from('not an actual backup')});
      assert.equal(response.status,403,context);
      assert.deepEqual(await response.json(),{
        error:'Restore the database from an ordinary personal browser, not a paired display. Restoring replaces the sessions used to secure temporary access.',
        reason:'device_restore_requires_personal_browser',
      });
    }
    assert.equal(fileOperations,0);
    assert.equal((await fetch(url+'/status',{headers:{'x-fixture-context':'temporary'}})).status,200);
    const ordinary=await fetch(url+'/restore',{method:'POST',headers:{'content-type':'application/octet-stream'},body:Buffer.from('isolated fixture')});
    assert.equal(ordinary.status,400);assert.equal(fileOperations,1);
    assert.equal((await ordinary.json()).error,'ISOLATED RESTORE DISPATCH');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
