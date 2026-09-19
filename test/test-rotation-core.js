import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='rotation-core-isolated-test';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const R=await import('../server/services/rotation.js');
const {default:router}=await import('../server/routes/rotations.js');
const {moduleForPath}=await import('../server/scopes.js');

function fixture(path=':memory:') {
  const d=new Database(path);d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  const user=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)").run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  const admin=user('Parent','admin'),kids=['Grace','Eleanor','Frankie'].map(name=>user(name)),extra=user('Sage');
  const group=R.saveRotationGroup(d,{name:'Kids',member_ids:kids},{actorId:admin});
  const track=(key,config={})=>R.configureRotationTrack(d,{consumer_type:'test',consumer_id:key,purpose_key:'order',label:key,group_id:group.id,strategy:'rotating_order',...config},{actorId:admin});
  const resolve=(t,key,options={})=>R.resolveRotation(d,t.id,key,{actorId:admin,...options});
  const finish=(o,options={})=>R.finalizeRotation(d,o.id,{actorId:admin,expectedRevision:o.revision,...options});
  return {d,admin,kids,extra,group,track,resolve,finish};
}
function withFixture(fn){return async()=>{const f=fixture();try{await fn(f);assert.deepEqual(f.d.pragma('foreign_key_check'),[]);}finally{f.d.close();}};}
const count=(d,table)=>d.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const changes=d=>d.prepare('SELECT total_changes() n').get().n;

test('Groups validate membership and preserve stable membership identity through edits',withFixture(({d,admin,kids,extra,group})=>{
  for(const ids of [[],[kids[0],kids[0]],[999999]])assert.throws(()=>R.saveRotationGroup(d,{name:'Invalid',member_ids:ids},{actorId:admin}));
  assert.throws(()=>R.saveRotationGroup(d,{name:'Kids',member_ids:kids},{actorId:admin}),/already/);
  const before=changes(d);assert.deepEqual(R.saveRotationGroup(d,{name:'Kids',member_ids:kids},{id:group.id,actorId:admin,expectedRevision:1}),group);assert.equal(changes(d),before);
  const updated=R.saveRotationGroup(d,{name:'Children',member_ids:[extra,kids[2],kids[0]]},{id:group.id,actorId:admin,expectedRevision:1});
  assert.equal(updated.members.find(m=>m.id===kids[0]).membership_id,group.members[0].membership_id);
  assert.equal(count(d,'rotation_group_members'),4);assert.equal(d.prepare('SELECT active FROM rotation_group_members WHERE user_id=?').get(kids[1]).active,0);
  assert.throws(()=>R.saveRotationGroup(d,{name:'Stale'},{id:group.id,actorId:admin,expectedRevision:1}),/changed elsewhere/);
  assert.equal(R.getRotationGroup(d,group.id).name,'Children');
}));
test('three independent consumers share membership without sharing a cursor',withFixture(({d,kids,track,resolve,finish})=>{
  const shower=track('Shower'),meal=track('Meal',{strategy:'round_robin'}),chore=track('Chore',{strategy:'round_robin'});
  const night=resolve(shower,'night1');assert.deepEqual(night.member_ids,kids);
  assert.deepEqual(resolve(meal,'meal1').member_ids,[kids[0]]);finish(resolve(meal,'meal1'));
  assert.deepEqual(resolve(meal,'meal2').member_ids,[kids[1]]);assert.deepEqual(resolve(chore,'chore1').member_ids,[kids[0]]);
  assert.equal(R.getRotationTrack(d,shower.id).advance_count,0);finish(night);
  assert.deepEqual(resolve(shower,'night2').member_ids,[kids[1],kids[2],kids[0]]);assert.equal(R.getRotationTrack(d,meal.id).advance_count,1);
}));
test('four rotating-order nights wrap and retries have one result and one advance',withFixture(({d,kids,track,resolve,finish})=>{
  const t=track('Four nights');
  for(let n=0;n<4;n++){const o=resolve(t,`night${n}`);assert.deepEqual(o.member_ids,[...kids.slice(n%3),...kids.slice(0,n%3)]);
    assert.deepEqual(resolve(t,`night${n}`),o);finish(o);finish(o);}
  assert.equal(count(d,'rotation_occurrences'),4);assert.equal(R.getRotationTrack(d,t.id).advance_count,4);
  assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE event_type='finalized'").get().n,4);
}));
test('fixed order never advances and supports independent open occurrences',withFixture(({d,kids,track,resolve,finish})=>{
  const t=track('Fixed',{strategy:'fixed_order'});const a=resolve(t,'a'),b=resolve(t,'b');assert.deepEqual(a.member_ids,kids);assert.deepEqual(b.member_ids,kids);
  finish(a);finish(b);assert.equal(R.getRotationTrack(d,t.id).advance_count,0);
}));
test('manual and completion-only policies distinguish finalization from success',withFixture(({d,kids,track,resolve,finish})=>{
  const t=track('Manual',{advance_policy:'manual'});let a=finish(resolve(t,'a'));assert.equal(a.advanced,0);
  a=finish(a,{manual:true});assert.equal(a.advanced,1);assert.deepEqual(resolve(t,'b').member_ids,[kids[1],kids[2],kids[0]]);
  const c=track('Completion',{advance_policy:'on_completed'});const o=finish(resolve(c,'a'));assert.equal(o.advanced,0);
  assert.throws(()=>resolve(c,'b'),error=>error.code==='rotation_pending');
  finish(o,{outcome:'completed'});assert.equal(R.getRotationTrack(d,c.id).advance_count,1);
  assert.deepEqual(resolve(c,'b').member_ids,[kids[1],kids[2],kids[0]]);
}));
test('skip conservatively retains position unless explicitly configured',withFixture(({d,kids,track,resolve,finish})=>{
  for(const advance of [false,true]){const t=track(`Skip ${advance}`,{advance_on_skip:advance});const o=resolve(t,'a');finish(o,{outcome:'skipped'});finish(o,{outcome:'skipped'});
    assert.equal(R.getRotationTrack(d,t.id).advance_count,advance?1:0);assert.equal(resolve(t,'b').member_ids[0],kids[advance?1:0]);}
}));

test('skip, override and correction preserve complete history and exactly one attributed audit event per action',withFixture(({d,admin,kids,track,resolve,finish})=>{
 const t=track('Auditable actions'),skipped=resolve(t,'skipped');
 const skippedResult=finish(skipped,{outcome:'skipped'});finish(skippedResult,{outcome:'skipped'});
 const eventRows=type=>d.prepare('SELECT * FROM rotation_events WHERE track_id=? AND event_type=? ORDER BY id').all(t.id,type);
 const skipEvents=eventRows('skipped');assert.equal(skipEvents.length,1);assert.equal(skipEvents[0].actor_user_id,admin);assert.ok(!Number.isNaN(Date.parse(skipEvents[0].created_at)));
 assert.equal(skippedResult.advanced,0);assert.equal(R.getRotationTrack(d,t.id).advance_count,0);
 const current=resolve(t,'override');assert.deepEqual(current.member_ids,kids);
 const beforeOriginal=current.original_order_json;
 const overridden=R.overrideRotation(d,current.id,{member_ids:[kids[2],kids[0],kids[1]],expected_revision:current.revision,actorId:admin});
 R.overrideRotation(d,current.id,{member_ids:overridden.member_ids,expected_revision:overridden.revision,actorId:admin});
 assert.equal(overridden.original_order_json,beforeOriginal);assert.equal(overridden.override_actor_id,admin);assert.ok(!Number.isNaN(Date.parse(overridden.overridden_at)));
 const overrides=eventRows('overridden');assert.equal(overrides.length,1);assert.equal(overrides[0].actor_user_id,admin);assert.ok(!Number.isNaN(Date.parse(overrides[0].created_at)));
 const overrideDetails=JSON.parse(overrides[0].details_json);assert.deepEqual(overrideDetails.previous_order,current.order);assert.deepEqual(overrideDetails.order,overridden.order);
 const done=finish(overridden),past=d.prepare('SELECT * FROM rotation_occurrences WHERE track_id=? ORDER BY id').all(t.id);
 const trackNow=R.getRotationTrack(d,t.id),corrected=R.correctRotationTrack(d,t.id,{actorId:admin,expected_revision:trackNow.revision,next_member_id:kids[1],reason:'Household correction'});
 assert.throws(()=>R.correctRotationTrack(d,t.id,{actorId:admin,expected_revision:trackNow.revision,next_member_id:kids[1]}),error=>error.status===409);
 const corrections=R.rotationTrackEvents(d,t.id);assert.equal(corrections.length,1);assert.equal(corrections[0].actor_user_id,admin);assert.equal(corrections[0].actor_name,'Parent');assert.ok(!Number.isNaN(Date.parse(corrections[0].created_at)));
 assert.equal(corrections[0].details.reason,'Household correction');assert.equal(corrections[0].details.next_member_id,kids[1]);assert.equal(corrections[0].details.next_member_name,'Eleanor');
 assert.equal(corrections[0].details.previous_next_membership_id,trackNow.next_membership_id);
 assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences WHERE track_id=? ORDER BY id').all(t.id),past);
 assert.equal(R.getRotationOccurrence(d,done.id).advanced,1);assert.equal(corrected.advance_count,1);
 assert.deepEqual(resolve(t,'after-correction').member_ids,[kids[1],kids[2],kids[0]]);
}));
test('preview, inspect, history and three-step projection are read-only',withFixture(({d,kids,track,resolve})=>{
  const t=track('Preview');resolve(t,'a');const before=changes(d);
  const preview=R.previewRotationSequence(d,t.id);assert.deepEqual(preview.map(p=>p.member_ids[0]),kids);
  R.inspectRotationTrack(d,t.id);R.rotationHistory(d,t.id);R.listRotationGroups(d);
  assert.equal(changes(d),before);assert.equal(count(d,'rotation_occurrences'),1);
}));
test('unavailability can skip or retain the stable next member without removing membership',withFixture(({d,kids,track,resolve,finish,group})=>{
  const skip=track('Skip temporarily');const a=resolve(skip,'a',{eligibleUserIds:kids.slice(1)});assert.deepEqual(a.member_ids,kids.slice(1));finish(a);
  assert.equal(R.previewRotation(d,skip.id).member_ids[0],kids[2]);
  const keep=track('Keep temporarily',{eligibility_behavior:'keep_position'});const b=resolve(keep,'a',{eligibleUserIds:kids.slice(1)});
  assert.deepEqual(b.member_ids,[]);assert.equal(b.advanced,0);assert.equal(R.getRotationGroup(d,group.id).members.length,3);
  assert.throws(()=>resolve(keep,'b'),error=>error.code==='rotation_pending');
}));
test('Skills and supervised proficiency reuse the current canonical eligibility resolver',withFixture(({d,admin,kids,track,resolve})=>{
  const skill=Number(d.prepare("INSERT INTO skills(name,created_by) VALUES('Household safety',?)").run(admin).lastInsertRowid);
  for(const [index,proficiency] of ['excluded','supervised','normal'].entries())d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(kids[index],skill,proficiency,admin);
  const plain=resolve(track('Skills',{eligibility:{skill_ids:[skill]}}),'a');assert.deepEqual(plain.member_ids,[kids[2]]);assert.equal(plain.skipped.length,2);
  const supervised=resolve(track('Supervised',{eligibility:{skill_ids:[skill],include_supervised:true}}),'a');assert.deepEqual(supervised.member_ids,[kids[1],kids[2]]);
  assert.ok(plain.skipped.every(m=>m.reason.includes('Household safety')));
}));
test('Availability uses household-local DST-safe occurrence window and fresh eligibility on retry',withFixture(({d,admin,kids,track,resolve})=>{
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  const t=track('Availability',{eligibility:{presence_policy:'available_before_due',presence_window:'completion'}});
  const context={start_date:'2026-11-01',start_time:'07:00',due_date:'2026-11-01',due_time:'08:00'};
  for(const kid of kids)d.prepare("INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,category) VALUES(?,'manual','busy','2026-11-01T12:00:00Z','2026-11-01T13:00:00Z','general')").run(kid);
  const unavailable=resolve(t,'dst-night',{context});assert.deepEqual(unavailable.member_ids,[]);assert.equal(unavailable.skipped.length,3);
  d.prepare('DELETE FROM availability_periods WHERE user_id=?').run(kids[1]);
  const refreshed=R.refreshRotationOccurrence(d,unavailable.id,{actorId:admin,expected_revision:unavailable.revision});assert.deepEqual(refreshed.member_ids,[kids[1]]);
}));
test('completion-relative finalization can settle skipped without success or advancement',withFixture(({d,track,resolve,finish})=>{
  const t=track('Paused',{advance_policy:'on_completed'}),o=finish(resolve(t,'a'));
  const skipped=finish(o,{outcome:'skipped'});assert.equal(skipped.status,'skipped');assert.equal(skipped.advanced,0);
  assert.equal(R.getRotationTrack(d,t.id).advance_count,0);assert.ok(resolve(t,'b'));
}));
test('empty resolution can be rechecked only through its trusted consumer eligibility boundary',withFixture(({d,admin,kids,track,resolve,finish})=>{
  const t=track('Meal');const o=resolve(t,'a',{eligibleUserIds:[],eligibilityExplanations:{[kids[0]]:{eligible:false,reason:'Travel cohort exclusion'}}});
  assert.equal(o.member_ids.length,0);assert.throws(()=>R.refreshRotationOccurrence(d,o.id,{actorId:admin,expected_revision:o.revision}),/consumer/);
  const refreshed=R.refreshRotationOccurrence(d,o.id,{actorId:admin,trusted:true,expectedRevision:o.revision,eligibleUserIds:[kids[1]]});
  assert.deepEqual(refreshed.member_ids,[kids[1]]);assert.deepEqual(refreshed.original_order,[]);finish(refreshed);assert.equal(R.getRotationTrack(d,t.id).advance_count,1);
}));
test('deactivation preserves history but blocks new resolution and configuration',withFixture(({d,admin,kids,group,track,resolve,finish})=>{
  const t=track('Retained');const o=resolve(t,'a');finish(o);
  R.saveRotationGroup(d,{active:false},{id:group.id,actorId:admin,expectedRevision:group.revision});
  assert.equal(resolve(t,'a').id,o.id);assert.throws(()=>resolve(t,'b'),error=>error.code==='rotation_group_inactive');
  assert.throws(()=>track('New'),error=>error.code==='rotation_group_inactive');assert.deepEqual(R.getRotationOccurrence(d,o.id).member_ids,kids);
  assert.equal(R.listRotationGroups(d).length,0);assert.equal(R.listRotationGroups(d,{includeInactive:true}).length,1);
}));
test('membership insert/reorder preserves next identity and removal moves to the next survivor',withFixture(({d,admin,kids,extra,group,track,resolve,finish})=>{
  const t=track('Membership');finish(resolve(t,'a'));const history=R.rotationHistory(d,t.id);
  let g=R.saveRotationGroup(d,{member_ids:[extra,kids[2],kids[1],kids[0]]},{id:group.id,actorId:admin,expectedRevision:1});
  assert.equal(R.previewRotation(d,t.id).member_ids[0],kids[1]);
  g=R.saveRotationGroup(d,{member_ids:[extra,kids[2],kids[0]]},{id:group.id,actorId:admin,expectedRevision:g.revision});
  assert.equal(R.previewRotation(d,t.id).member_ids[0],kids[0]);assert.deepEqual(R.rotationHistory(d,t.id),history);
}));
test('a deleted household member does not reset the next pointer to the first member',withFixture(({d,kids,track,resolve,finish})=>{
  const t=track('Departure');finish(resolve(t,'a'));d.prepare('DELETE FROM users WHERE id=?').run(kids[1]);
  const p=R.previewRotation(d,t.id);assert.deepEqual(p.member_ids,[kids[2],kids[0]]);assert.ok(p.skipped.some(m=>m.reason.includes('household')));
  const old=R.rotationHistory(d,t.id)[0];assert.equal(old.order[1].display_name,'Eleanor');assert.equal(old.order[1].id,kids[1]);
}));
test('occurrence override preserves original plan, revision and historical immutability',withFixture(({d,admin,kids,track,resolve,finish})=>{
  const t=track('Override');const o=resolve(t,'a');
  const overridden=R.overrideRotation(d,o.id,{member_ids:[kids[2],kids[0],kids[1]],expected_revision:o.revision,actorId:admin});
  assert.deepEqual(overridden.original_order.map(m=>m.id),kids);assert.equal(overridden.override_actor_id,admin);
  assert.throws(()=>R.overrideRotation(d,o.id,{member_ids:kids,expected_revision:o.revision,actorId:admin}),/changed elsewhere/);
  const done=finish(overridden);assert.equal(resolve(t,'b').member_ids[0],kids[0]);
  assert.throws(()=>R.overrideRotation(d,o.id,{member_ids:kids,expected_revision:done.revision,actorId:admin}),/Historical/);
}));
test('explicit override retention uses original next while default uses effective planned leader',withFixture(({kids,track,resolve,finish,d,admin})=>{
  const t=track('Retain',{override_affects_next:false});const o=resolve(t,'a');finish(R.overrideRotation(d,o.id,{member_ids:[kids[2],kids[0],kids[1]],expected_revision:o.revision,actorId:admin}));
  assert.equal(resolve(t,'b').member_ids[0],kids[1]);
}));
test('administrative correction is revision protected and an older pending occurrence cannot overwrite it',withFixture(({d,admin,kids,track,resolve,finish})=>{
  const t=track('Correction');const o=resolve(t,'a'),current=R.getRotationTrack(d,t.id);
  const corrected=R.correctRotationTrack(d,t.id,{next_member_id:kids[2],expected_revision:current.revision,reason:'Corrected household order',actorId:admin});
  assert.throws(()=>R.correctRotationTrack(d,t.id,{next_member_id:kids[1],expected_revision:current.revision,actorId:admin}),/changed elsewhere/);
  const settled=finish(o);assert.equal(settled.advance_reason,'administrative_correction');assert.equal(settled.advanced,0);
  assert.equal(R.getRotationTrack(d,t.id).next_membership_id,corrected.next_membership_id);assert.equal(resolve(t,'b').member_ids[0],kids[2]);
  const e=d.prepare("SELECT details_json FROM rotation_events WHERE event_type='track_corrected'").get();assert.equal(JSON.parse(e.details_json).reason,'Corrected household order');
}));
test('an old manual result cannot advance over a newer resolved occurrence',withFixture(({track,resolve,finish})=>{
  const t=track('Manual history',{advance_policy:'manual'});const a=finish(resolve(t,'a'));resolve(t,'b');
  assert.throws(()=>finish(a,{manual:true}),error=>error.code==='rotation_stale');
}));
test('configuration stale writes are rejected without reinterpreting historical occurrences',withFixture(({d,admin,kids,track,resolve,finish,group})=>{
  const t=track('Config');const a=resolve(t,'a');finish(a);
  assert.throws(()=>R.configureRotationTrack(d,{...t,expected_revision:t.revision,strategy:'round_robin'},{actorId:admin}),/changed elsewhere/);
  const fresh=R.getRotationTrack(d,t.id);R.configureRotationTrack(d,{...fresh,expected_revision:fresh.revision,strategy:'round_robin'},{actorId:admin});
  assert.deepEqual(R.getRotationOccurrence(d,a.id).member_ids,kids);assert.equal(resolve(t,'b').member_ids.length,1);assert.equal(R.getRotationGroup(d,group.id).revision,1);
}));
test('Group/Track/Occurrence capability guards deny a restricted member',withFixture(({d,kids,track,resolve,group})=>{
  const t=track('Permissions'),o=resolve(t,'a'),actorId=kids[0];
  for(const fn of [()=>R.saveRotationGroup(d,{name:'Unauthorized',member_ids:kids},{actorId}),()=>R.configureRotationTrack(d,{...t},{actorId}),
    ()=>R.overrideRotation(d,o.id,{actorId,expected_revision:1,member_ids:kids}),()=>R.finalizeRotation(d,o.id,{actorId,expectedRevision:1}),
    ()=>R.correctRotationTrack(d,t.id,{actorId,next_member_id:kids[1],expected_revision:2})])assert.throws(fn,/permissions/);
  assert.equal(R.getRotationGroup(d,group.id).revision,1);assert.equal(R.getRotationOccurrence(d,o.id).status,'resolved');
}));
test('HTTP API enforces revisions/capabilities and rejects client attempts to bypass consumer eligibility',withFixture(async({d,admin,kids,group,track,resolve})=>{
  _setTestDatabase(d);const app=express();app.use(express.json());app.use((req,_res,next)=>{const id=Number(req.headers['x-user'])||admin;const role=d.prepare('SELECT role FROM users WHERE id=?').get(id)?.role;req.authUserId=id;req.authRole=role;req.session={userId:id,role};next();});app.use('/automation',router);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const request=async(method,path,body,user=admin)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/automation${path}`,{method,headers:{'Content-Type':'application/json','x-user':String(user)},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()};};
  try{
    assert.equal((await request('POST','/rotation-groups',{name:'Bad',member_ids:kids},kids[0])).status,403);
    assert.equal((await request('PUT',`/rotation-groups/${group.id}`,{name:'Bad',member_ids:kids,expected_revision:0})).status,409);
    const t=track('Owner eligibility'),o=resolve(t,'a',{eligibleUserIds:[]});
    assert.equal((await request('POST',`/rotation-occurrences/${o.id}/recheck`,{expected_revision:1,trusted:true,eligibleUserIds:kids})).status,409);
    const before=changes(d);const view=await request('GET',`/rotation-groups/${group.id}`);assert.equal(view.status,200);assert.equal(view.body.data.tracks.length,1);assert.equal(changes(d),before);
    assert.equal(moduleForPath('/automation/rotation-groups'),'family');assert.equal(moduleForPath('/automation/rotation-occurrences/1/override'),'family');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));_setTestDatabase(null);}
}));

async function runConcurrent(path,jobs) {
  const gate=new SharedArrayBuffer(4),lock=new Int32Array(gate);
  const workers=jobs.map(job=>new Worker(new URL('./workers/rotation-worker.js',import.meta.url),{workerData:{path,gate,job}}));
  let ready=0;const results=workers.map(worker=>new Promise((resolve,reject)=>{
    worker.on('message',message=>{if(message.ready){if(++ready===jobs.length){Atomics.store(lock,0,1);Atomics.notify(lock,0);}}else resolve(message);});worker.on('error',reject);
    worker.on('exit',code=>{if(code)reject(new Error(`Rotation worker exited ${code}`));});
  }));return Promise.all(results);
}
test('real concurrent SQLite callers resolve and finalize exactly once',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rotation-race-')),path=join(dir,'database.db'),f=fixture(path);
  try{const t=f.track('Concurrent');f.d.pragma('journal_mode=WAL');
    const jobs=[0,1,2,3].map(()=>({type:'resolve',trackId:t.id,key:'same',actorId:f.admin}));const result=await runConcurrent(path,jobs);
    assert.ok(result.every(r=>r.ok),JSON.stringify(result));assert.equal(new Set(result.map(r=>r.value.id)).size,1);assert.equal(count(f.d,'rotation_occurrences'),1);
    const occurrence=result[0].value;const finals=await runConcurrent(path,[0,1,2,3].map(()=>({type:'finalize',occurrenceId:occurrence.id,expectedRevision:occurrence.revision,actorId:f.admin})));
    assert.ok(finals.every(r=>r.ok),JSON.stringify(finals));assert.equal(R.getRotationTrack(f.d,t.id).advance_count,1);
    assert.equal(f.d.prepare("SELECT count(*) n FROM rotation_events WHERE event_type='finalized'").get().n,1);assert.deepEqual(f.d.pragma('foreign_key_check'),[]);
  }finally{f.d.close();rmSync(dir,{recursive:true,force:true});}
});
test('override/finalize and correction/finalize races cannot lose the authoritative result',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rotation-cas-')),path=join(dir,'database.db'),f=fixture(path);
  try{f.d.pragma('journal_mode=WAL');const t=f.track('CAS'),o=f.resolve(t,'a');
    const results=await runConcurrent(path,[{type:'override',occurrenceId:o.id,expectedRevision:o.revision,actorId:f.admin,memberIds:[f.kids[2],f.kids[0],f.kids[1]]},
      {type:'finalize',occurrenceId:o.id,expectedRevision:o.revision,actorId:f.admin}]);
    assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).status,409);
    let saved=R.getRotationOccurrence(f.d,o.id);if(saved.status==='resolved')f.finish(saved);
    const b=f.resolve(t,'b'),revision=R.getRotationTrack(f.d,t.id).revision;
    const corrected=await runConcurrent(path,[{type:'correct',trackId:t.id,actorId:f.admin,expectedRevision:revision,nextMember:f.kids[2]},
      {type:'finalize',occurrenceId:b.id,actorId:f.admin,expectedRevision:b.revision}]);
    assert.ok(corrected.some(r=>r.ok));assert.ok(corrected.every(r=>r.ok||r.status===409));
    if(corrected[0].ok)assert.equal(R.previewRotation(f.d,t.id).member_ids[0],f.kids[2]);
    assert.deepEqual(f.d.pragma('integrity_check'),[{integrity_check:'ok'}]);assert.deepEqual(f.d.pragma('foreign_key_check'),[]);
  }finally{f.d.close();rmSync(dir,{recursive:true,force:true});}
});

test('independent Tracks resolve and advance concurrently against one Group without sharing state',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rotation-independent-')),path=join(dir,'database.db'),f=fixture(path);
 try {
  f.d.pragma('journal_mode=WAL');const tracks=[f.track('Shower'),f.track('Meal',{strategy:'round_robin'}),f.track('Chore',{strategy:'round_robin'})];
  const results=await runConcurrent(path,tracks.flatMap(track=>[0,1].map(()=>({type:'resolve',trackId:track.id,key:'same-logical-key',actorId:f.admin}))));
  assert.ok(results.every(result=>result.ok),JSON.stringify(results));assert.equal(count(f.d,'rotation_occurrences'),3);
  const occurrences=tracks.map(track=>R.rotationHistory(f.d,track.id)[0]);
  assert.deepEqual(occurrences[0].member_ids,f.kids);assert.deepEqual(occurrences[1].member_ids,[f.kids[0]]);assert.deepEqual(occurrences[2].member_ids,[f.kids[0]]);
  const firstFinals=await runConcurrent(path,[0,1].map(()=>({type:'finalize',occurrenceId:occurrences[1].id,expectedRevision:1,actorId:f.admin})));
  assert.ok(firstFinals.every(result=>result.ok));assert.deepEqual(tracks.map(track=>R.getRotationTrack(f.d,track.id).advance_count),[0,1,0]);
  const finals=await runConcurrent(path,[0,2].flatMap(index=>[0,1].map(()=>({type:'finalize',occurrenceId:occurrences[index].id,expectedRevision:1,actorId:f.admin}))));
  assert.ok(finals.every(result=>result.ok),JSON.stringify(finals));assert.deepEqual(tracks.map(track=>R.getRotationTrack(f.d,track.id).advance_count),[1,1,1]);
  for(const track of tracks) {
   assert.equal(f.d.prepare("SELECT COUNT(*) n FROM rotation_events WHERE track_id=? AND event_type='resolved'").get(track.id).n,1);
   assert.equal(f.d.prepare("SELECT COUNT(*) n FROM rotation_events WHERE track_id=? AND event_type='finalized'").get(track.id).n,1);
   assert.equal(R.previewRotation(f.d,track.id).member_ids[0],f.kids[1]);
   assert.throws(()=>R.correctRotationTrack(f.d,track.id,{actorId:f.admin,expected_revision:1,next_member_id:f.kids[2]}),error=>error.status===409);
  }
  assert.equal(count(f.d,'rotation_occurrences'),3);assert.deepEqual(f.d.pragma('integrity_check'),[{integrity_check:'ok'}]);assert.deepEqual(f.d.pragma('foreign_key_check'),[]);
 } finally {f.d.close();rmSync(dir,{recursive:true,force:true});}
});
