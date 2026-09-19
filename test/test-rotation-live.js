import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='rotation-live-isolated';process.env.LOG_LEVEL='error';
const db=await import('../server/db.js'),d=db.get();
const {default:router}=await import('../server/routes/rotations.js');
const {saveRotationGroup,configureRotationTrack,resolveRotation,finalizeRotation,overrideRotation}=await import('../server/services/rotation.js');
const {replaceSubjectPermissions}=await import('../server/permissions.js');
const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'x',?)").run(name,name,role).lastInsertRowid);
const admin=user('Rotation parent','admin'),member=user('Rotation observer','member');
d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
replaceSubjectPermissions(d,'user',member,{capabilities:{'rotations.view':'allow'}});
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=member;req.authRole='member';req.authMethod=req.headers['x-auth']||'session';req.sessionID=req.headers['x-session'];req.session={userId:member,role:'member'};next();});app.use('/automation',router);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/automation`;
test.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));d.close();});
let n=0;
async function stream(){const sid=`rotation-test-${++n}`;d.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sid,JSON.stringify({userId:member}),Date.now()+60000);
  const abort=new AbortController(),response=await fetch(`${base}/rotation-changes`,{headers:{'x-session':sid},signal:abort.signal});assert.equal(response.status,200);
  const reader=response.body.getReader();return {sid,abort,reader,async read(){const result=await reader.read();if(result.done)return null;
    const text=new TextDecoder().decode(result.value);assert.doesNotMatch(text,/Rotation parent|Rotation observer|member_ids|order|name|title/);
    const value=JSON.parse(text.match(/data: (.+)/)[1]);assert.deepEqual(Object.keys(value),['version']);return value.version;}};
}
async function ended(s){const timer=setTimeout(()=>s.abort.abort(),3500);try{while(!(await s.reader.read()).done){};}finally{clearTimeout(timer);s.abort.abort();}}
test('two authenticated clients receive payload-free Group, override and advancement invalidation',async()=>{
  const a=await stream(),b=await stream();
  try{const initialA=await a.read(),initialB=await b.read();assert.equal(initialA,initialB);
    const group=saveRotationGroup(d,{name:'Private household group',member_ids:[admin,member]},{actorId:admin});
    const versions=await Promise.all([a.read(),b.read()]);assert.ok(versions[0]>initialA);assert.equal(versions[0],versions[1]);
    const track=configureRotationTrack(d,{consumer_type:'test',consumer_id:'live',purpose_key:'order',group_id:group.id,strategy:'rotating_order'},{actorId:admin});
    const occurrence=resolveRotation(d,track.id,'one');const changed=overrideRotation(d,occurrence.id,{actorId:admin,expected_revision:1,member_ids:[member,admin]});
    const afterOverride=await Promise.all([a.read(),b.read()]);assert.ok(afterOverride[0]>versions[0]);assert.equal(afterOverride[0],afterOverride[1]);
    finalizeRotation(d,occurrence.id,{actorId:admin,expectedRevision:changed.revision});const afterAdvance=await Promise.all([a.read(),b.read()]);assert.ok(afterAdvance[0]>afterOverride[0]);assert.equal(afterAdvance[0],afterAdvance[1]);
  }finally{a.abort.abort();b.abort.abort();}
});
test('permission revocation and expired persisted sessions close already-open rotation streams',async()=>{
  const a=await stream();await a.read();replaceSubjectPermissions(d,'user',member,{capabilities:{'rotations.view':'none'}});await ended(a);
  replaceSubjectPermissions(d,'user',member,{capabilities:{'rotations.view':'allow'}});
  const b=await stream();await b.read();d.prepare('UPDATE sessions SET expired_at=0 WHERE sid=?').run(b.sid);await ended(b);
});
test('a token or a forged unpersisted session cannot open a rotation stream',async()=>{
  for(const headers of [{'x-auth':'token'},{'x-session':'not-a-real-session'}])assert.equal((await fetch(`${base}/rotation-changes`,{headers})).status,403);
});
