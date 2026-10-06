import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-acceptance-policy';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');
const {acceptTask}=await import('../server/services/task-acceptance.js');
const {acceptanceOptions}=await import('../server/services/task-acceptance-policy.js');
const {listTaskOffers}=await import('../server/services/task-offers.js');
const {createDevice,devicePrincipal,updateDevice}=await import('../server/services/devices.js');
const {deviceAppMiddleware}=await import('../server/services/device-app.js');
const {default:router}=await import('../server/routes/tasks.js');
const {default:idempotency}=await import('../server/middleware/idempotency.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {setTags}=await import('../server/utils/task-tags.js');
const d=get();
for(const [id,name,role] of [[1,'Author','admin'],[2,'Claimant','member'],[3,'Helper','member'],[4,'Outsider','member']])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'x',?)").run(id,name,name,role);
const grant=(id,key,access)=>d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,?) ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access").run(String(id),key,access);
grant(2,'tasks.change_assignment','none');grant(2,'tasks.reassign','none');grant(2,'tasks.accept_with_helpers','allow');
const seed=(name,extra={})=>Number(d.prepare('INSERT INTO tasks(title,created_by,parent_task_id,visibility,locked) VALUES(?,1,?,?,?)').run(name,extra.parent??null,extra.visibility||'all',extra.locked||0).lastInsertRowid);
let serial=0;
const body=(id,p=2,primary)=>{const options=acceptanceOptions(d,p,id,primary);return {operation_id:`policy-${++serial}`,expected_revision:options.expected_revision,...(primary?{primary_user_id:primary}:{}),coassignee_ids:[],subtask_snapshot:options.subtask_snapshot,subtask_assignments:[]};};
const display=createDevice(d,{name:'Scoped claimant',scope:{member_ids:[2,3]},permissions:{capabilities:{'device_tasks.claim':'allow','device_tasks.accept_with_helpers':'allow'}}},1);
const principal=()=>devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=?').get(display.id));
let actor=2,asDevice=false;
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=asDevice?null:actor;req.session={userId:asDevice?null:actor};if(asDevice)req.devicePrincipal=principal();next();});
app.use('/api/v1',deviceAppMiddleware,idempotency);app.use('/api/v1/tasks',router);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(()=>{server.closeAllConnections();server.close();});
async function call(method,path,body,headers={}){const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};}

test('acceptance photos retain human profile access and the paired display name/color boundary',async()=>{
  const photo='data:image/png;base64,aGVsbG8=';
  const before=d.prepare('SELECT id,avatar_data,avatar_color FROM users WHERE id IN (2,3,4)').all();
  d.prepare('UPDATE users SET avatar_data=?,avatar_color=? WHERE id IN (2,3,4)').run(photo,'#235678');
  const id=seed('Avatar selection');
  try{
    const human=await call('GET',`/${id}/acceptance`);assert.equal(human.status,200);
    assert.equal(human.body.data.primary_candidates[0].avatar_data,photo);
    assert.equal(human.body.data.coassignee_candidates.find(m=>m.id===3).avatar_data,photo);
    asDevice=true;
    const paired=await call('GET',`/${id}/acceptance?primary_user_id=2`);assert.equal(paired.status,200);
    assert.deepEqual(paired.body.data.primary_candidates.map(m=>m.id),[2,3]);
    assert.deepEqual(paired.body.data.coassignee_candidates.map(m=>m.id),[3]);
    for(const person of [...paired.body.data.primary_candidates,...paired.body.data.coassignee_candidates]){
      assert.equal(person.avatar_color,'#235678');assert.equal(Object.hasOwn(person,'avatar_data'),false);
      assert.deepEqual(Object.keys(person).sort(),['avatar_color','display_name','id']);
    }
    assert.ok(!JSON.stringify(paired.body).includes(photo));
  }finally{asDevice=false;for(const person of before)d.prepare('UPDATE users SET avatar_data=?,avatar_color=? WHERE id=?').run(person.avatar_data,person.avatar_color,person.id);}
});

test('authorized offer detail reveals no independently private child or hidden revision',async()=>{
  const id=seed('Visible parent'),visible=seed('Visible child',{parent:id}),hidden=seed('SECRET child',{parent:id,visibility:'private'});
  const before=d.prepare('SELECT total_changes() n').get().n,detail=await call('GET',`/${id}/acceptance`);
  assert.equal(detail.status,200,JSON.stringify(detail.body));assert.deepEqual(detail.body.data.subtask_snapshot.map(c=>c.id),[visible]);
  assert.ok(!JSON.stringify(detail.body).includes('SECRET'));assert.ok(!detail.body.data.task.subtasks.some(c=>c.id===hidden));
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  const request=body(id);d.prepare("UPDATE tasks SET title='SECRET changed' WHERE id=?").run(hidden);
  assert.equal((await call('POST',`/${id}/accept`,request)).status,409);
});
test('normal task detail preserves the offer action and removes it immediately after acceptance',async()=>{
  const id=seed('Detail offer');
  const before=await call('GET',`/${id}`);assert.equal(before.status,200);assert.equal(before.body.data.is_offer,true);assert.equal(before.body.data.permissions.accept,true);
  const accepted=await call('POST',`/${id}/accept`,body(id));assert.equal(accepted.status,200);
  const after=await call('GET',`/${id}`);assert.equal(after.body.data.is_offer,false);assert.equal(after.body.data.permissions.accept,false);
});
test('HTTP Idempotency-Key cannot bypass current acceptance permission or replay private response bodies',async()=>{
  const id=seed('HTTP accept'),request=body(id),headers={'Idempotency-Key':'same-wire-key'};
  const first=await call('POST',`/${id}/accept`,request,headers);assert.equal(first.status,200,JSON.stringify(first.body));
  const retry=await call('POST',`/${id}/accept`,request,headers);assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM idempotency_keys').get().n,0);
  grant(2,'tasks.claim','none');try{assert.equal((await call('POST',`/${id}/accept`,request,headers)).status,403);}finally{grant(2,'tasks.claim','allow');}
});
test('encoded task identifiers also bypass global response caching',async()=>{
  const id=seed('Encoded accept'),request=body(id),path=`/${String(id).split('').map(c=>`%${c.charCodeAt(0).toString(16)}`).join('')}/accept`,headers={'Idempotency-Key':'encoded-wire-key'};
  assert.equal((await call('POST',path,request,headers)).status,200);
  grant(2,'tasks.claim','none');try{assert.equal((await call('POST',path,request,headers)).status,403);}finally{grant(2,'tasks.claim','allow');}
  assert.equal(d.prepare('SELECT COUNT(*) n FROM idempotency_keys').get().n,0);
});
test('helper permission revocation blocks receipt replay and late failures roll back every persisted side effect',()=>{
  const id=seed('Helper receipt'),request={...body(id),coassignee_ids:[3]};acceptTask(d,2,id,request);
  grant(2,'tasks.accept_with_helpers','none');try{assert.throws(()=>acceptTask(d,2,id,request),e=>e.status===403);}finally{grant(2,'tasks.accept_with_helpers','allow');}
  const failed=seed('Fault rollback'),child=seed('Fault child',{parent:failed}),pending={...body(failed),coassignee_ids:[3],subtask_assignments:[{id:child,user_id:3}]};
  const tables=['tasks','task_assignments','task_responsibilities','task_activity_events','task_acceptance_receipts','notification_inbox'];
  const snapshot=()=>Object.fromEntries(tables.map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()]));
  const before=snapshot();d.exec("CREATE TRIGGER acceptance_test_fault BEFORE INSERT ON task_acceptance_receipts BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END");
  try{assert.throws(()=>acceptTask(d,2,failed,pending),/synthetic transaction failure/);}finally{d.exec('DROP TRIGGER acceptance_test_fault');}
  assert.deepEqual(snapshot(),before);
});
test('device picker/options/commit use scoped members without borrowing their authenticated permissions',async()=>{
  asDevice=true;
  try{
    const id=seed('Device offer'),child=seed('Device child',{parent:id});
    const options=await call('GET',`/${id}/acceptance`);assert.equal(options.status,200,JSON.stringify(options.body));assert.equal(options.body.data.primary_mode,'choose');assert.deepEqual(options.body.data.primary_candidates.map(m=>m.id).sort(),[2,3]);
    const request=body(id,principal(),2);request.coassignee_ids=[3];request.subtask_assignments=[{id:child,user_id:3}];
    assert.equal((await call('POST',`/${id}/accept`,{...request,primary_user_id:4})).status,403);
    assert.equal((await call('POST',`/${id}/accept`,{...request,coassignee_ids:[4]})).status,403);
    const result=await call('POST',`/${id}/accept`,request);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.assigned_to,2);
    const event=d.prepare("SELECT actor_user_id,details_json FROM task_activity_events WHERE task_id=? AND event_type='claimed'").get(id);assert.equal(event.actor_user_id,null);assert.equal(JSON.parse(event.details_json).source_device.id,display.id);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,4);
  }finally{asDevice=false;}
});
test('device receipt and draft cannot survive permission/scope changes',()=>{
  const id=seed('Device revocation'),old=principal(),request=body(id,old,2);acceptTask(d,old,id,request);
  updateDevice(d,display.id,{revision:old.revision,scope:{member_ids:[3]}},1);
  assert.throws(()=>acceptTask(d,old,id,request),e=>e.status===409);
  assert.throws(()=>acceptTask(d,principal(),id,request),e=>[403,404,409].includes(e.status));
  const current=principal();updateDevice(d,display.id,{revision:current.revision,scope:{member_ids:[2,3]}},1);
});
test('narrow helpers cannot override locked instructions, reassign existing work or grant ordinary edit rights',()=>{
  const id=seed('Locked offer',{locked:1});assert.equal(acceptanceOptions(d,2,id).can_add_helpers,false);
  assert.throws(()=>acceptTask(d,2,id,{...body(id),coassignee_ids:[3]}),e=>e.status===403);
  acceptTask(d,2,id,body(id));assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,2);
});
test('managed open_claimable work retains explicit pool eligibility and policy context',()=>{
  const id=seed('Managed offer');d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state,source) VALUES(?,'open_claimable','open','planning_context')").run(id);d.prepare('INSERT INTO task_claim_eligibility(task_id,user_id) VALUES(?,2)').run(id);
  assert.throws(()=>acceptanceOptions(d,3,id),e=>e.status===409);
  const request=body(id);assert.throws(()=>acceptTask(d,2,id,{...request,coassignee_ids:[3]}),e=>e.status===409);
  acceptTask(d,2,id,request);assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state,'assigned');
});
test('managed acceptance reevaluates current availability after opening the draft',()=>{
  const id=seed('Scheduled offer');d.prepare("UPDATE tasks SET due_date='2030-01-01',due_time='10:00' WHERE id=?").run(id);
  d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state,source) VALUES(?,'open_claimable','open','planning_context')").run(id);
  d.prepare('INSERT INTO task_claim_eligibility(task_id,user_id) VALUES(?,2)').run(id);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy) VALUES(?,'available_before_due')").run(id);
  const request=body(id);
  const shift=Number(d.prepare("INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state) VALUES('Acceptance busy','00:00','23:59','busy')").run().lastInsertRowid);
  const pattern=Number(d.prepare("INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES(2,'Acceptance shift','2030-01-01',1)").run().lastInsertRowid);
  d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,0,?)').run(pattern,shift);
  try{
    assert.throws(()=>acceptTask(d,2,id,request),e=>e.status===409);assert.throws(()=>acceptanceOptions(d,2,id),e=>e.status===409);
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,null);assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state,'open');
  }finally{d.prepare('DELETE FROM schedule_patterns WHERE id=?').run(pattern);d.prepare('DELETE FROM schedule_shift_types WHERE id=?').run(shift);}
});
test('skills reject excluded primary/helper/child recipients and rollback the whole request',()=>{
  const id=seed('Skill offer'),child=seed('Skill action',{parent:id});
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Acceptance skill',0,'normal',1)").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(3,?,'excluded','manual',1)").run(skill);setTaskSkills(d,child,[skill]);
  const request=body(id);assert.throws(()=>acceptTask(d,2,id,{...request,coassignee_ids:[3],subtask_assignments:[{id:child,user_id:3}]}),e=>e.status===409);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,null);
  setTaskSkills(d,id,[skill]);assert.throws(()=>acceptanceOptions(d,3,id),e=>e.status===409);
});
test('offer visibility honors own-only viewers, household starts and due expiration without mutating work',()=>{
  const future=seed('Future'),expired=seed('Expired deadline'),overdue=seed('Keep overdue');
  d.prepare("UPDATE tasks SET start_date='2999-01-01' WHERE id=?").run(future);
  d.prepare("UPDATE tasks SET due_date='2000-01-01',expiration_policy='expire_incomplete' WHERE id=?").run(expired);
  d.prepare("UPDATE tasks SET due_date='2000-01-01',expiration_policy='keep_overdue' WHERE id=?").run(overdue);
  const ids=listTaskOffers(d,2).map(row=>row.id);assert.ok(!ids.includes(future));assert.ok(!ids.includes(expired));assert.ok(ids.includes(overdue));
  grant(2,'tasks.view_household','none');try{assert.deepEqual(listTaskOffers(d,2),[]);}finally{grant(2,'tasks.view_household','allow');}
});
test('human and device offer lists schedule authorized future starts without disclosing future or private work',async t=>{
  const now=Date.parse('2026-10-03T12:00:00Z'),starts=Date.parse('2026-10-03T13:00:00Z');t.mock.timers.enable({apis:['Date'],now});
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','UTC') ON CONFLICT(key) DO UPDATE SET value='UTC'").run();
  const future=seed('SCHEDULED OFFER SECRET'),privateId=seed('PRIVATE FUTURE SECRET',{visibility:'private'}),assigned=seed('ASSIGNED FUTURE');
  d.prepare("UPDATE tasks SET start_date='2026-10-03',start_time='13:00' WHERE id=?").run(future);
  d.prepare("UPDATE tasks SET start_date='2026-10-03',start_time='12:15' WHERE id=?").run(privateId);
  d.prepare("UPDATE tasks SET start_date='2026-10-03',start_time='12:30',assigned_to=2 WHERE id=?").run(assigned);
  try{
    for(const device of [false,true]){
      asDevice=device;const response=await call('GET','?offers=1');assert.equal(response.status,200,JSON.stringify(response.body));
      assert.deepEqual(response.body.visibility,{server_now:now,next_start_at:starts});
      assert.ok(!response.body.data.some(row=>[future,privateId,assigned].includes(row.id)));assert.ok(!JSON.stringify(response.body).includes('SECRET'));
    }
    t.mock.timers.setTime(starts);
    for(const device of [false,true]){asDevice=device;const response=await call('GET','?offers=1');assert.ok(response.body.data.some(row=>row.id===future));}
  }finally{asDevice=false;t.mock.timers.reset();}
});
test('offer filters narrow human and device lists with ordinary OR groups and AND tags',async()=>{
  const a=seed('Filtered A'),b=seed('Filtered B'),c=seed('Filtered C'),hidden=seed('Hidden filtered',{visibility:'private'});
  for(const id of [a,b,c,hidden])d.prepare("UPDATE tasks SET category='acceptance-filter',priority='high' WHERE id=?").run(id);
  d.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(b);d.prepare("UPDATE tasks SET priority='low' WHERE id=?").run(c);
  setTags(d,a,['Yard, tools','Summer']);setTags(d,b,['Yard, tools']);setTags(d,c,['Summer']);setTags(d,hidden,['Yard, tools','Summer']);
  try{for(const device of [false,true]){asDevice=device;
    const ids=async filter=>(await call('GET',`?offers=1&category=acceptance-filter${filter}`)).body.data.map(row=>row.id).sort((x,y)=>x-y);
    assert.deepEqual(await ids('&status=open&priority=high'),[a]);
    assert.deepEqual(await ids('&status=open&status=in_progress&priority=high'),[a,b]);
    assert.deepEqual(await ids('&tag=yard%2C%20tools&tag=SUMMER'),[a]);
    assert.deepEqual(await ids('&assigned_to=2'),[]);assert.deepEqual(await ids('&archived=only'),[]);
    assert.deepEqual(await ids('&category=another-category'),[a,b,c]);
  }}finally{asDevice=false;}
});
