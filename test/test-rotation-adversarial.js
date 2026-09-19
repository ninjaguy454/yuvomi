import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='rotation-adversarial-isolated-test';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const R=await import('../server/services/rotation.js');
const {default:router}=await import('../server/routes/rotations.js');
const {default:automationRouter}=await import('../server/routes/automation.js');

function fixture(path=':memory:') {
  const d=new Database(path);d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS) {
    if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
    if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
  }
  const add=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'test',?,?)")
    .run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  const admin=add('Parent','admin'),kids=['Grace','Eleanor','Frankie'].map(n=>add(n));
  const group=R.saveRotationGroup(d,{name:'Kids',member_ids:kids},{actorId:admin});
  const track=(key,config={})=>R.configureRotationTrack(d,{consumer_type:'test',consumer_id:key,purpose_key:'order',group_id:group.id,strategy:'rotating_order',...config},{actorId:admin});
  const resolve=(t,key,options={})=>R.resolveRotation(d,t.id,key,{actorId:admin,...options});
  const finish=(o,options={})=>R.finalizeRotation(d,o.id,{actorId:admin,expectedRevision:o.revision,...options});
  return {d,admin,kids,group,track,resolve,finish,add};
}
const withFixture=fn=>async()=>{const f=fixture();try{await fn(f);assert.deepEqual(f.d.pragma('foreign_key_check'),[]);}finally{f.d.close();}};
const changes=d=>d.prepare('SELECT total_changes() n').get().n;

test('keep-position distinguishes permanent household departure from temporary unavailability',withFixture(({d,kids,track,resolve,finish})=>{
  const t=track('departed',{eligibility_behavior:'keep_position'});
  const historical=finish(resolve(t,'night1'));
  assert.equal(R.previewRotation(d,t.id).member_ids[0],kids[1]);
  d.prepare('DELETE FROM users WHERE id=?').run(kids[1]);
  const preview=R.previewRotation(d,t.id);
  assert.deepEqual(preview.member_ids,[kids[2],kids[0]]);
  assert.deepEqual(resolve(t,'night2').member_ids,[kids[2],kids[0]]);
  assert.deepEqual(R.getRotationOccurrence(d,historical.id).member_ids,kids);
  assert.equal(R.getRotationOccurrence(d,historical.id).order[1].display_name,'Eleanor');
}));

test('hypothetical previews never advance through an unavailable retained position',withFixture(({d,kids,track})=>{
  const t=track('waiting',{eligibility_behavior:'keep_position'});
  const before=changes(d);
  const previews=R.previewRotationSequence(d,t.id,{eligibleUserIds:kids.slice(1)});
  assert.deepEqual(previews.map(p=>p.member_ids),[[],[],[]]);
  assert.ok(previews.every(p=>p.state==='unavailable'));
  assert.equal(changes(d),before);
  assert.equal(R.getRotationTrack(d,t.id).advance_count,0);
}));

test('noncyclic rotating-order override advances to effective planned second member without changing Group order',withFixture(({d,admin,kids,group,track,resolve,finish})=>{
  const t=track('override'),o=resolve(t,'night1');
  const overridden=R.overrideRotation(d,o.id,{member_ids:[kids[2],kids[1],kids[0]],expected_revision:o.revision,actorId:admin});
  finish(overridden);
  assert.deepEqual(R.getRotationGroup(d,group.id).members.map(m=>m.id),kids);
  assert.deepEqual(resolve(t,'night2').member_ids,[kids[1],kids[2],kids[0]]);
  assert.deepEqual(R.getRotationOccurrence(d,o.id).original_order.map(m=>m.id),kids);
}));

test('unresolved eligibility retry rechecks current Group without rewriting original resolution',withFixture(({d,admin,kids,group,track,resolve,finish,add})=>{
  const t=track('refresh'),o=resolve(t,'night1',{eligibleUserIds:[]});
  const extra=add('Sage');
  const revised=R.saveRotationGroup(d,{member_ids:[extra,kids[2],kids[0]]},{id:group.id,actorId:admin,expectedRevision:group.revision});
  const resolved=R.refreshRotationOccurrence(d,o.id,{actorId:admin,trusted:true,expectedRevision:o.revision,eligibleUserIds:[extra,kids[0],kids[2]]});
  assert.ok(resolved.member_ids.includes(extra));
  assert.ok(!resolved.member_ids.includes(kids[1]));
  assert.deepEqual(resolved.original_order,[]);
  assert.equal(resolved.group_revision,revised.revision);
  const audit=JSON.parse(d.prepare("SELECT details_json FROM rotation_events WHERE occurrence_id=? AND event_type='eligibility_rechecked'").get(o.id).details_json);
  assert.equal(audit.previous.group_revision,group.revision);
  assert.deepEqual(audit.previous.members.map(m=>m.id),kids);
  assert.throws(()=>R.refreshRotationOccurrence(d,o.id,{actorId:admin,trusted:true,expectedRevision:o.revision,eligibleUserIds:kids}),e=>e.code==='rotation_stale');
  finish(resolved);assert.equal(R.getRotationTrack(d,t.id).advance_count,1);
}));

test('administrative correction survives an unresolved occurrence retry and finalization',withFixture(({d,admin,kids,track,resolve,finish})=>{
  const t=track('correct-retry'),o=resolve(t,'night1',{eligibleUserIds:[]});
  let current=R.getRotationTrack(d,t.id);
  current=R.correctRotationTrack(d,t.id,{actorId:admin,expected_revision:current.revision,next_member_id:kids[2],reason:'Explicit next-position correction'});
  const resolved=R.refreshRotationOccurrence(d,o.id,{actorId:admin,trusted:true,expectedRevision:o.revision,eligibleUserIds:kids});
  assert.equal(resolved.member_ids[0],kids[2]);
  const done=finish(resolved);
  assert.equal(done.advance_reason,'administrative_correction');
  assert.equal(done.advanced,0);
  assert.equal(R.getRotationTrack(d,t.id).next_membership_id,current.next_membership_id);
}));

for(const kind of ['Skill','Place'])test(`deleted ${kind} reference fails closed without breaking read-only Track inspection`,withFixture(({d,admin,track})=>{
  const table=kind==='Skill'?'skills':'places';
  const id=Number(d.prepare(`INSERT INTO ${table}(name,created_by) VALUES('Rotation-only requirement',?)`).run(admin).lastInsertRowid);
  const configuration=kind==='Skill'?{eligibility:{skill_ids:[id]}}:{eligibility:{presence_policy:'must_be_at_location',place_id:id}};
  const t=track(`missing-${kind}`,configuration);
  d.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  const before=changes(d);
  const preview=R.previewRotation(d,t.id);
  assert.deepEqual(preview.order,[]);
  assert.match(preview.explanation,/configuration|skill|place/i);
  const inspected=R.inspectRotationTrack(d,t.id);
  assert.deepEqual(inspected.next.order,[]);
  const unchanged=R.configureRotationTrack(d,{...R.getRotationTrack(d,t.id)},{actorId:admin});
  assert.equal(unchanged.id,t.id);
  assert.equal(changes(d),before);
  assert.throws(()=>track(`invalid-new-${kind}`,configuration));
  assert.throws(()=>R.configureRotationTrack(d,{...unchanged,label:'Changed config',expected_revision:unchanged.revision},{actorId:admin}));
  const occurrence=R.resolveRotation(d,t.id,'missing-reference',{actorId:admin});
  assert.deepEqual(occurrence.order,[]);
  assert.ok(occurrence.skipped.every(member=>/reconfigure/i.test(member.reason)));
  const settled=R.finalizeRotation(d,occurrence.id,{actorId:admin,expectedRevision:occurrence.revision,outcome:'completed'});
  assert.equal(settled.advanced,0);
  assert.equal(R.getRotationTrack(d,t.id).advance_count,0);
}));

test('provisional override cannot newly choose a departed household member while old snapshots remain intact',withFixture(({d,admin,kids,track,resolve})=>{
  const t=track('departed-override',{strategy:'round_robin'}),o=resolve(t,'one');
  d.prepare('DELETE FROM users WHERE id=?').run(kids[1]);
  const before=changes(d);
  assert.throws(()=>R.overrideRotation(d,o.id,{member_ids:[kids[1]],actorId:admin,expected_revision:o.revision}),/eligible|household|member/i);
  assert.equal(changes(d),before);
  assert.equal(R.getRotationOccurrence(d,o.id).eligible[1].display_name,'Eleanor');
  assert.deepEqual(R.getRotationOccurrence(d,o.id).member_ids,[kids[0]]);
}));

test('provisional override rechecks current proficiency instead of authorizing a new excluded selection from history',withFixture(({d,admin,kids,track,resolve})=>{
  const skill=Number(d.prepare("INSERT INTO skills(name,created_by) VALUES('Explicit capability',?)").run(admin).lastInsertRowid);
  for(const kid of kids)d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'normal','manual',?)").run(kid,skill,admin);
  const t=track('changed-proficiency',{strategy:'round_robin',eligibility:{skill_ids:[skill]}}),o=resolve(t,'one');
  d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id=?").run(kids[1],skill);
  const before=changes(d);
  assert.throws(()=>R.overrideRotation(d,o.id,{member_ids:[kids[1]],actorId:admin,expected_revision:o.revision}),/eligible|skill|member/i);
  assert.equal(changes(d),before);
  assert.ok(R.getRotationOccurrence(d,o.id).eligible.some(member=>member.id===kids[1]));
  assert.deepEqual(R.getRotationOccurrence(d,o.id).member_ids,[kids[0]]);
}));

test('Workflow retry records do not prohibit deleting a source template or departed initiating account',withFixture(({d,admin,kids,track,resolve,finish,add})=>{
  const actor=add('Workflow runner');
  const template=Number(d.prepare("INSERT INTO workflow_templates(name,created_by) VALUES('Disposable source',?)").run(admin).lastInsertRowid);
  const instance=Number(d.prepare("INSERT INTO workflow_instances(workflow_template_id,created_by) VALUES(?,?)").run(template,actor).lastInsertRowid);
  d.prepare('INSERT INTO rotation_workflow_requests(workflow_template_id,actor_user_id,request_key,input_hash,workflow_instance_id,response_json) VALUES(?,?,?,?,?,?)')
    .run(template,actor,'request-identity','hash',instance,'{}');
  const occurrence=finish(resolve(track('retained-workflow-history'),'request-identity'));
  d.prepare('DELETE FROM users WHERE id=?').run(actor);
  d.prepare('DELETE FROM workflow_templates WHERE id=?').run(template);
  assert.deepEqual(R.getRotationOccurrence(d,occurrence.id).member_ids,kids);
  assert.equal(d.prepare('SELECT workflow_template_id FROM workflow_instances WHERE id=?').get(instance).workflow_template_id,null);
}));

test('public recheck cannot supply trusted context, eligibility or actor and revoked capabilities are enforced immediately',withFixture(async({d,admin,kids,group,track,resolve})=>{
  _setTestDatabase(d);
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=Number(req.headers['x-user'])||admin;req.session={userId:req.authUserId};next();});app.use('/automation',router);app.use('/automation',automationRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const request=async(method,path,body,user=admin)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/automation${path}`,{method,headers:{'Content-Type':'application/json','x-user':String(user)},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:response.status===204?null:await response.json()};
  };
  try {
    const occurrence=resolve(track('consumer-controlled'),'one',{context:{label:'Trusted owner context'},eligibleUserIds:[]});
    const before=changes(d);
    const attack=await request('POST',`/rotation-occurrences/${occurrence.id}/recheck`,{expected_revision:occurrence.revision,trusted:true,eligibleUserIds:kids,context:{label:'Injected'},actorId:admin});
    assert.equal(attack.status,409);assert.equal(changes(d),before);
    assert.equal(R.getRotationOccurrence(d,occurrence.id).context.label,'Trusted owner context');
    d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'rotations.view','none')").run(String(kids[0]));
    assert.equal((await request('GET',`/rotation-groups/${group.id}`,null,kids[0])).status,403);
    assert.equal((await request('POST',`/rotation-tracks/${occurrence.track_id}/correct`,{next_member_id:kids[1],expected_revision:2,actorId:admin},kids[0])).status,403);
    assert.equal(R.getRotationTrack(d,occurrence.track_id).correction_revision,0);
    const template=Number(d.prepare("INSERT INTO workflow_templates(name,created_by) VALUES('Delete via existing API',?)").run(admin).lastInsertRowid);
    d.prepare('INSERT INTO rotation_workflow_requests(workflow_template_id,actor_user_id,request_key,input_hash,response_json) VALUES(?,?,?,?,?)').run(template,admin,'api-deletion-retry','hash','{}');
    assert.equal((await request('DELETE',`/admin/workflow-templates/${template}`)).status,204);
    assert.ok(R.getRotationOccurrence(d,occurrence.id));
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));_setTestDatabase(null);}
}));

test('concurrent Group edit and resolution produce one coherent membership revision snapshot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rotation-membership-race-')),path=join(dir,'isolated.db'),f=fixture(path);
  try {
    f.d.pragma('journal_mode=WAL');
    const t=f.track('group-race'),extra=f.add('Sage'),revised=[extra,f.kids[2],f.kids[0]];
    const gate=new SharedArrayBuffer(4),lock=new Int32Array(gate);
    const jobs=[{type:'group',groupId:f.group.id,revision:f.group.revision,members:revised},
      {type:'resolve',trackId:t.id,key:'simultaneous-occurrence'}];
    let ready=0;
    const results=await Promise.all(jobs.map(job=>new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./workers/rotation-adversarial-worker.js',import.meta.url),{workerData:{path,gate,actorId:f.admin,job}});
      worker.on('message',message=>{if(message.ready){if(++ready===jobs.length){Atomics.store(lock,0,1);Atomics.notify(lock,0);}}else resolve(message);});
      worker.on('error',reject);worker.on('exit',code=>{if(code)reject(new Error(`Membership worker exited ${code}`));});
    })));
    assert.ok(results.every(r=>r.ok),JSON.stringify(results));
    const occurrence=R.getRotationOccurrence(f.d,results[1].value.id);
    const expected=occurrence.group_revision===f.group.revision?f.kids:revised;
    assert.deepEqual(occurrence.members.map(m=>m.id),expected);
    assert.deepEqual([...occurrence.member_ids].sort(),[...expected].sort());
    assert.equal(f.d.prepare('SELECT count(*) n FROM rotation_occurrences WHERE track_id=?').get(t.id).n,1);
    f.finish(occurrence);
    assert.equal(R.getRotationTrack(f.d,t.id).advance_count,1);
    assert.ok(revised.includes(R.previewRotation(f.d,t.id).member_ids[0]));
    assert.deepEqual(f.d.pragma('integrity_check'),[{integrity_check:'ok'}]);
    assert.deepEqual(f.d.pragma('foreign_key_check'),[]);
  } finally {f.d.close();rmSync(dir,{recursive:true,force:true});}
});
