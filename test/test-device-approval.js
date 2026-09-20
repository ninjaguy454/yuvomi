import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='isolated-device-approval-tests';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
await import('../server/routes/tasks.js');
const {createDevice,deviceHash,DEVICE_COOKIE,updateDevice,returnToDevice}=await import('../server/services/devices.js');
const {beginDeviceApproval,validateDeviceApproval,completeDeviceApproval,readDeviceApproval,cancelDeviceApproval}=await import('../server/services/device-approval.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
let d,req,device,root,step,token,dir;
test.beforeEach(()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'vidamia-approval-'));
  d=new Database(path.join(dir,'fixture.db'));d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');
  for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);}
  _setTestDatabase(d);
  for(const [id,name,role] of [[1,'Qualified Parent','admin'],[2,'Eleanor','member'],[3,'Other Parent','admin']])
    d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,'x',?,?)").run(id,name,name,role,role==='admin'?'parent':'child');
  device=createDevice(d,{name:'Kitchen Wall'},1);token='synthetic-device-credential';
  d.prepare("INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,'original-device-context')").run(device.id,deviceHash(token));
  req={headers:{cookie:`${DEVICE_COOKIE}=${token}`,'x-auth-context':'original-device-context'},sessionID:'isolated-device-session',session:{}};
  root=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by,points,visibility) VALUES('Routine',2,1,2,'all')").run().lastInsertRowid);
  step=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility) VALUES('Supervised step',?,1,'all')").run(root).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(root);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(2,1)').run();
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Fixture skill',0,'normal',1)").run().lastInsertRowid);
  for(const [id,proficiency] of [[1,'normal'],[2,'supervised'],[3,'excluded']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,skill,proficiency);
  setTaskSkills(d,step,[skill]);reconcileTaskSupervision(d,root);
});
test.afterEach(()=>{_setTestDatabase(null);d.close();fs.rmSync(dir,{recursive:true,force:true});});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
function revisions(id=step){const task=row(id);return {expected_revision:task.revision,...(task.parent_task_id?{expected_parent_revision:row(task.parent_task_id).revision}:{})};}
const begin=()=>beginDeviceApproval(d,req,step,revisions());
const count=table=>d.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test('single authenticated supervised approval preserves device identity and records human actor, device source, learner points once',()=>{
  const start=begin();assert.equal(start.approval.state,'pending');assert.equal(req.session.userId,undefined);
  const result=completeDeviceApproval(d,req,{id:1});
  assert.equal(result.data.status,'done');assert.equal(result.data.parent_task.status,'done');
  assert.equal(result.approval.actorName,'Qualified Parent');assert.equal(result.user,undefined);assert.equal(result.permissions,undefined);
  assert.equal(req.session.userId,undefined);assert.equal(req.session.role,undefined);
  const credential=d.prepare('SELECT * FROM device_credentials').get();assert.equal(credential.temporary_sid,null);assert.equal(credential.context_key,'original-device-context');
  assert.deepEqual(d.prepare('SELECT user_id,delta,created_by FROM reward_ledger').all(),[{user_id:2,delta:2,created_by:1}]);
  const completions=d.prepare('SELECT user_id,source_device_id,source_device_name FROM task_completions').all();
  assert.ok(completions.every(event=>event.user_id===1&&event.source_device_id===device.id&&event.source_device_name==='Kitchen Wall'));
  const events=d.prepare("SELECT actor_user_id,details_json FROM task_activity_events WHERE event_type='completed'").all();
  assert.ok(events.every(event=>event.actor_user_id===1&&JSON.parse(event.details_json).source_device.name==='Kitchen Wall'));
  assert.equal(count('reward_ledger'),1);assert.equal(count('device_task_approvals'),1);
  assert.deepEqual(completeDeviceApproval(d,req,{id:1}),result);assert.deepEqual(readDeviceApproval(d,req),result);
  assert.equal(count('reward_ledger'),1);assert.equal(d.prepare("SELECT COUNT(*) n FROM device_audit_events WHERE event_type='task_approved'").get().n,1);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('approval proves the assigned qualified person, not merely administrator identity, and failed writes roll back',()=>{
  begin();const before=count('task_activity_events');
  assert.throws(()=>completeDeviceApproval(d,req,{id:3}),/assigned qualified/);
  assert.throws(()=>completeDeviceApproval(d,req,{id:2}),/assigned qualified/);
  assert.equal(row(step).status,'open');assert.equal(count('task_activity_events'),before);assert.equal(count('reward_ledger'),0);
  assert.equal(d.prepare('SELECT status FROM device_task_approvals').get().status,'pending');
  completeDeviceApproval(d,req,{id:1});
});

test('approval is action-only: ordinary steps, whole parents, bulk/reset and mutation payloads cannot become grants',()=>{
  const normal=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by,visibility) VALUES('Independent',2,1,'all')").run().lastInsertRowid);
  for(const id of [normal,root])assert.throws(()=>beginDeviceApproval(d,req,id,revisions(id)),/incomplete supervised/);
  for(const extra of [{status:'open'},{complete_remaining:true},{points:100},{assigned_to:1},{reset_progress:true}])
    assert.throws(()=>beginDeviceApproval(d,req,step,{...revisions(),...extra}),/only this existing action/);
  assert.equal(count('device_task_approvals'),0);
});

test('delegated helper action keeps canonical human ownership and learner reward recipient',()=>{
  d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=2").run();
  const view=reconcileTaskSupervision(d,root),action=view.actions.find(item=>item.action_task_id===step);
  assert.equal(action.execution_mode,'delegated');
  beginDeviceApproval(d,req,action.counterpart_task_id,revisions(action.counterpart_task_id));
  const result=completeDeviceApproval(d,req,{id:1});assert.equal(result.data.status,'done');assert.equal(row(step).status,'done');
  assert.equal(d.prepare('SELECT user_id FROM reward_ledger').get().user_id,2);
});

test('Task and parent revision changes, expiry and canonical start-window rejection preserve pending progress',()=>{
  begin();d.prepare("UPDATE tasks SET title='Renamed after confirmation' WHERE id=?").run(step);
  assert.throws(()=>completeDeviceApproval(d,req,{id:1}),/changed/);assert.equal(row(step).status,'open');
  begin();d.prepare("UPDATE tasks SET description='Parent changed' WHERE id=?").run(root);
  assert.throws(()=>completeDeviceApproval(d,req,{id:1}),/changed/);
  begin();d.prepare('UPDATE device_task_approvals SET expires_at=? WHERE status=\'pending\'').run(Date.now()-1);
  assert.throws(()=>completeDeviceApproval(d,req,{id:1}),/expired/);
  d.prepare("UPDATE tasks SET is_recurring=1,start_date='2099-01-01',start_time='07:00',recurrence_rule='FREQ=DAILY' WHERE id=?").run(root);
  reconcileTaskSupervision(d,root);
  begin();assert.throws(()=>completeDeviceApproval(d,req,{id:1}),/start time/);assert.equal(row(step).status,'open');assert.equal(count('reward_ledger'),0);
});

test('cancel and supersession invalidate previous authentication proofs and clear pending 2FA/OIDC',()=>{
  const first=begin();req.session.pendingTwoFactor={userId:1};req.session.oidc={state:'old-proof'};
  const second=begin();assert.notEqual(first.approval.id,second.approval.id);
  assert.equal(req.session.pendingTwoFactor,undefined);assert.equal(req.session.oidc,undefined);
  assert.throws(()=>completeDeviceApproval(d,req,{id:1},{expectedId:first.approval.id}),/changed/);
  assert.equal(d.prepare('SELECT status FROM device_task_approvals WHERE id=?').get(first.approval.id).status,'cancelled');
  req.session.pendingTwoFactor={approvalId:second.approval.id,userId:1};req.session.oidc={deviceApprovalId:second.approval.id,state:'new-proof'};
  cancelDeviceApproval(d,req,{expectedId:first.approval.id});
  assert.equal(req.session.deviceApprovalIntent.id,second.approval.id);assert.equal(req.session.pendingTwoFactor.approvalId,second.approval.id);
  assert.equal(req.session.oidc.deviceApprovalId,second.approval.id);assert.equal(d.prepare('SELECT status FROM device_task_approvals WHERE id=?').get(second.approval.id).status,'pending');
  cancelDeviceApproval(d,req);assert.deepEqual(readDeviceApproval(d,req),{approval:null});
  assert.throws(()=>completeDeviceApproval(d,req,{id:1}),/changed/);assert.equal(row(step).status,'open');
});

test('pending authentication status exposes only the current proof requirement and a fixed safe error',()=>{
  const started=begin();req.session.pendingTwoFactor={approvalId:started.approval.id,userId:1,expiresAt:Date.now()+60_000};
  req.session.deviceApprovalError={id:started.approval.id,message:'PRIVATE PROVIDER TOKEN AND SUBJECT'};
  const result=readDeviceApproval(d,req);assert.equal(result.approval.twoFactorRequired,true);
  assert.equal(result.approval.error,'Authentication could not be completed. Try again.');assert.equal(result.data,undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('userId'));
  req.session.pendingTwoFactor.approvalId='old-proof';assert.equal(readDeviceApproval(d,req).approval.twoFactorRequired,false);
});

test('credential, session, context, current capability and private scope are checked for actions and cached receipts',()=>{
  begin();const other={...req,sessionID:'other-session'};
  assert.throws(()=>completeDeviceApproval(d,other,{id:1}),/sign-in changed/);
  completeDeviceApproval(d,req,{id:1});
  d.prepare("UPDATE tasks SET visibility='private',description='PRIVATE MARKER' WHERE id=?").run(root);
  assert.throws(()=>readDeviceApproval(d,req),/not available/);
  d.prepare("UPDATE tasks SET visibility='all' WHERE id=?").run(root);
  const settings=JSON.parse(d.prepare('SELECT permissions_json FROM household_devices').get().permissions_json);
  settings.capabilities['device_tasks.complete']='none';d.prepare('UPDATE household_devices SET permissions_json=?').run(JSON.stringify(settings));
  assert.throws(()=>readDeviceApproval(d,req),/does not permit/);
});

test('device permission change or temporary sign-in context transition invalidates an outstanding approval',()=>{
  begin();updateDevice(d,device.id,{revision:device.revision,name:'Updated Wall'},1);
  assert.throws(()=>completeDeviceApproval(d,req,{id:1}),/sign-in changed/);assert.equal(row(step).status,'open');
  req.headers['x-auth-context']=d.prepare('SELECT context_key FROM device_credentials').get().context_key;begin();
  returnToDevice(d,d.prepare('SELECT * FROM device_credentials').get());
  assert.throws(()=>validateDeviceApproval(d,req),/sign-in changed/);assert.equal(count('reward_ledger'),0);
});

test('separate simultaneous SQLite workers consume one proof once and return a scoped receipt on retry',async()=>{
  begin();const control=new SharedArrayBuffer(12),state=new Int32Array(control);
  const workers=[0,1].map(()=>new Worker(new URL('./helpers/device-approval-worker.mjs',import.meta.url),{workerData:{filename:path.join(dir,'fixture.db'),req,control}}));
  const results=workers.map(worker=>new Promise((resolve,reject)=>{worker.on('message',resolve);worker.on('error',reject);worker.on('exit',code=>{if(code)reject(new Error(`worker exit ${code}`));});}));
  const deadline=Date.now()+30_000;while(Atomics.load(state,0)<2){if(Date.now()>deadline)throw new Error('Workers failed to initialize');await new Promise(resolve=>setTimeout(resolve,20));}
  Atomics.store(state,1,1);Atomics.notify(state,1,2);
  const output=await Promise.all(results);assert.ok(output.every(item=>item.ok),JSON.stringify(output));assert.deepEqual(output[0].receipt,output[1].receipt);
  assert.equal(count('reward_ledger'),1);assert.equal(d.prepare("SELECT COUNT(*) n FROM device_task_approvals WHERE status='completed'").get().n,1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM device_audit_events WHERE event_type='task_approved'").get().n,1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(step).n,1);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('cancellation racing authenticated completion has a single coherent committed outcome',async()=>{
  begin();const control=new SharedArrayBuffer(12),state=new Int32Array(control);
  const workers=['complete','cancel'].map(operation=>new Worker(new URL('./helpers/device-approval-worker.mjs',import.meta.url),{workerData:{filename:path.join(dir,'fixture.db'),req,control,operation}}));
  const results=workers.map(worker=>new Promise((resolve,reject)=>{worker.on('message',resolve);worker.on('error',reject);worker.on('exit',code=>{if(code)reject(new Error(`worker exit ${code}`));});}));
  const deadline=Date.now()+30_000;while(Atomics.load(state,0)<2){if(Date.now()>deadline)throw new Error('Workers failed to initialize');await new Promise(resolve=>setTimeout(resolve,20));}
  Atomics.store(state,1,1);Atomics.notify(state,1,2);const output=await Promise.all(results);
  assert.equal(output[1].ok,true);const approval=d.prepare('SELECT status FROM device_task_approvals').get();
  assert.ok(['completed','cancelled'].includes(approval.status));
  assert.equal(row(step).status,approval.status==='completed'?'done':'open');
  assert.equal(count('reward_ledger'),approval.status==='completed'?1:0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM device_audit_events WHERE event_type='task_approved'").get().n,approval.status==='completed'?1:0);
  assert.equal(output[0].ok,approval.status==='completed');assert.deepEqual(d.pragma('foreign_key_check'),[]);
});
