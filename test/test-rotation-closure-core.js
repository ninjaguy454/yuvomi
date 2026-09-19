import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='rotation-closure-core-isolated';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const R=await import('../server/services/rotation.js');
const {replaceSubjectPermissions}=await import('../server/permissions.js');
const {taskCapabilities}=await import('../server/services/task-access.js');
const {default:router}=await import('../server/routes/rotations.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {normalizeVariableValue,resolveVariables}=await import('../server/services/variable-resolution.js');
const {bindTaskRotations,taskRotationContexts}=await import('../server/services/task-rotation.js');
async function fixture(run) {
 const d=new Database(':memory:');
 for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
 d.pragma('foreign_keys=ON');_setTestDatabase(d);
 const add=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'test',?)").run(name,name,role).lastInsertRowid);
 const admin=add('Parent','admin'),viewer=add('Viewer'),departed=add('Departed');
 replaceSubjectPermissions(d,'user',viewer,{capabilities:{'rotations.view':'allow','rotations.history':'allow','rotations.override':'allow','rotations.correct':'allow','rotations.advance':'allow','tasks.view_own':'allow','tasks.view_household':'none'}});
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=Number(req.headers['x-user'])||viewer;req.authRole=req.authUserId===admin?'admin':'member';req.session={userId:req.authUserId,role:req.authRole};next();});app.use(router);app.use('/automation',automationRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const request=async(path,{method='GET',body,user=viewer}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'x-user':String(user),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 try{await run({d,admin,viewer,departed,request});assert.deepEqual(d.pragma('foreign_key_check'),[]);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();}
}
test('F1 private consumer full payloads are absent from Group usage and denied on every contextual read and mutation',()=>fixture(async({d,admin,viewer,request})=>{
 const group=R.saveRotationGroup(d,{name:'Shared Group',member_ids:[viewer]},{actorId:admin});
 const owner=Number(d.prepare("INSERT INTO tasks(title,created_by,visibility,start_date,due_date) VALUES('Private medical appointment',?,'private','2026-10-15','2026-10-16')").run(admin).lastInsertRowid);
 assert.equal(taskCapabilities(d,viewer,d.prepare('SELECT * FROM tasks WHERE id=?').get(owner)).view,false);
 const track=R.configureRotationTrack(d,{consumer_type:'task',consumer_id:String(owner),purpose_key:'private_medical_purpose',label:'Private medical purpose',group_id:group.id,strategy:'rotating_order'},{actorId:admin});
 const occurrence=R.resolveRotation(d,track.id,'private-visit-key',{actorId:admin,context:{task_id:owner,start_date:'2026-10-15',start_time:'10:13',due_date:'2026-10-16',due_time:'11:17',subject_user_id:admin,label:'Private medical occurrence'}});
 const groupResponse=await request(`/rotation-groups/${group.id}`);assert.equal(groupResponse.status,200);assert.equal(groupResponse.body.data.name,'Shared Group');assert.deepEqual(groupResponse.body.data.tracks,[]);
 for(const path of [`/rotation-tracks/${track.id}`,`/rotation-tracks/${track.id}/history`,`/rotation-occurrences/${occurrence.id}`,`/rotation-occurrences/${occurrence.id}/history`]) {
  const response=await request(path);assert.equal(response.status,404,path);assert.deepEqual(response.body,{error:'Rotation not found.',code:404});
 }
 for(const [path,body] of [[`/rotation-occurrences/${occurrence.id}/override`,{expected_revision:1,member_ids:[viewer]}],[`/rotation-occurrences/${occurrence.id}/finalize`,{expected_revision:1}],[`/rotation-occurrences/${occurrence.id}/skip`,{expected_revision:1}],[`/rotation-occurrences/${occurrence.id}/recheck`,{expected_revision:1}],[`/rotation-tracks/${track.id}/correct`,{expected_revision:2,next_member_id:viewer}],[`/rotation-groups/${group.id}/preview`,{strategy:'rotating_order',context:{task_id:owner}}]]) {
  const response=await request(path,{method:'POST',body});assert.equal(response.status,404,path);
 }
 assert.equal(R.getRotationOccurrence(d,occurrence.id).status,'resolved');assert.equal(R.getRotationTrack(d,track.id).advance_count,0);
 const picker=await request('/automation/quick-add');assert.equal(picker.status,200);
 assert.deepEqual(picker.body.rotation_occurrences,[],'typed picker does not expose private occurrence identities');
 assert.throws(()=>normalizeVariableValue(d,{id:'night',type:'rotation_occurrence'},occurrence.id,{actor:viewer}),error=>error.status===404);
 assert.throws(()=>resolveVariables(d,[{id:'night',type:'rotation_occurrence'}],{night:occurrence.id},{actor:viewer}),error=>error.status===404);
 assert.equal(normalizeVariableValue(d,{id:'group',type:'rotation_group'},group.id,{actor:viewer}).id,group.id);
 const legitimate=await request(`/rotation-occurrences/${occurrence.id}`,{user:admin});assert.equal(legitimate.status,200);assert.equal(legitimate.body.data.context.start_time,'10:13');
 d.prepare("UPDATE tasks SET visibility='all',assigned_to=? WHERE id=?").run(viewer,owner);
 assert.equal((await request(`/rotation-tracks/${track.id}`)).status,200,'new visibility takes effect immediately');
 d.prepare('DELETE FROM tasks WHERE id=?').run(owner);
 assert.equal((await request(`/rotation-occurrences/${occurrence.id}`)).status,404,'deleted owning Task cannot authorize retained consumer context');
 assert.equal((await request(`/rotation-occurrences/${occurrence.id}`,{user:admin})).status,200,'authorized administrator retains historical inspection');
}));
test('F1 visible Workflow template does not expose an inaccessible generated owning Task snapshot',()=>fixture(async({d,admin,viewer,request})=>{
 const group=R.saveRotationGroup(d,{name:'Group',member_ids:[viewer]},{actorId:admin});
 const workflow=Number(d.prepare("INSERT INTO workflow_templates(name) VALUES('Public reusable workflow')").run().lastInsertRowid);
 const task=Number(d.prepare("INSERT INTO tasks(title,created_by,visibility) VALUES('Private generated occurrence',?,'private')").run(admin).lastInsertRowid);
 const track=R.configureRotationTrack(d,{consumer_type:'workflow',consumer_id:String(workflow),purpose_key:'order',group_id:group.id},{actorId:admin});
 const occurrence=R.resolveRotation(d,track.id,'night-private',{context:{task_id:task,start_date:'2026-10-20',subject_user_id:admin},actorId:admin});
 replaceSubjectPermissions(d,'user',viewer,{capabilities:{'rotations.view':'allow','rotations.history':'allow','workflows.view':'allow','tasks.view_own':'allow','tasks.view_household':'none'}});
 const groupResult=await request(`/rotation-groups/${group.id}`);assert.deepEqual(groupResult.body.data.tracks,[]);
 for(const path of [`/rotation-tracks/${track.id}`,`/rotation-tracks/${track.id}/history`,`/rotation-occurrences/${occurrence.id}`])assert.equal((await request(path)).status,404,path);
}));
test('F5 empty historical Group can deactivate without losing references; creation and activation still require a current member',()=>fixture(async({d,admin,departed})=>{
 const group=R.saveRotationGroup(d,{name:'Departed Group',member_ids:[departed]},{actorId:admin});
 const track=R.configureRotationTrack(d,{consumer_type:'test',consumer_id:'departed',purpose_key:'order',group_id:group.id},{actorId:admin});
 const occurrence=R.resolveRotation(d,track.id,'past',{actorId:admin});R.finalizeRotation(d,occurrence.id,{actorId:admin,expectedRevision:occurrence.revision});
 d.prepare('DELETE FROM users WHERE id=?').run(departed);
 const snapshot=R.getRotationOccurrence(d,occurrence.id),membership=d.prepare('SELECT id FROM rotation_group_members WHERE group_id=?').get(group.id);
 const retired=R.saveRotationGroup(d,{active:false},{id:group.id,expectedRevision:1,actorId:admin});assert.equal(retired.active,0);
 assert.deepEqual(R.getRotationOccurrence(d,occurrence.id),snapshot);assert.ok(d.prepare('SELECT 1 FROM rotation_group_members WHERE id=?').get(membership.id));
 assert.throws(()=>R.saveRotationGroup(d,{active:true},{id:group.id,expectedRevision:retired.revision,actorId:admin}),/at least one/);
 assert.throws(()=>R.saveRotationGroup(d,{name:'Empty new',active:false,member_ids:[]},{actorId:admin}),/at least one/);
 assert.throws(()=>R.resolveRotation(d,track.id,'new',{actorId:admin}),error=>error.code==='rotation_group_inactive');
}));
test('F1 a visible descendant does not expose its private owner Rotation context',()=>fixture(async({d,admin,viewer})=>{
 const group=R.saveRotationGroup(d,{name:'Shared members',member_ids:[admin,viewer]},{actorId:admin});
 const owner=Number(d.prepare("INSERT INTO tasks(title,created_by,visibility,rotation_bindings_json) VALUES('Private owner',?,'private',?)")
  .run(admin,JSON.stringify([{group_id:group.id,purpose_key:'private_purpose',label:'Private order',strategy:'rotating_order'}])).lastInsertRowid);
 bindTaskRotations(d,owner,{actorId:admin});
 const child=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,visibility) VALUES('Visible child',?,?,?,'all')").run(admin,viewer,owner).lastInsertRowid);
 assert.equal(taskCapabilities(d,viewer,{id:child}).view,true);assert.equal(taskCapabilities(d,viewer,{id:owner}).view,false);
 assert.deepEqual(taskRotationContexts(d,child,viewer),[]);assert.equal(taskRotationContexts(d,child,admin).length,1);
 d.prepare("UPDATE tasks SET visibility='all',assigned_to=? WHERE id=?").run(viewer,owner);
 assert.equal(taskRotationContexts(d,child,viewer).length,1);
}));
