import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='rotation-consumer-labels-isolated';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {saveRotationGroup,configureRotationTrack,resolveRotation}=await import('../server/services/rotation.js');
const {replaceSubjectPermissions}=await import('../server/permissions.js');
const {default:router}=await import('../server/routes/rotations.js');

async function fixture(run) {
 const d=new Database(':memory:');
 for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
 d.pragma('foreign_keys=ON');_setTestDatabase(d);
 const addUser=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'test',?)").run(name,name,role).lastInsertRowid);
 const admin=addUser('Parent','admin'),child=addUser('Child','member');
 replaceSubjectPermissions(d,'user',child,{capabilities:{'rotations.view':'allow','rotations.history':'allow','workflows.view':'allow','tasks.view_own':'allow','tasks.view_household':'none'},modules:{meals:'read'}});
 const group=saveRotationGroup(d,{name:'Kids',member_ids:[child]},{actorId:admin});
 const track=(type,identity,label='Shower Order')=>configureRotationTrack(d,{consumer_type:type,consumer_id:String(identity),purpose_key:'order',label,group_id:group.id,strategy:'rotating_order'},{actorId:admin});
 const task=(title,{visibility='all',assignedTo=null}={})=>Number(d.prepare('INSERT INTO tasks(title,created_by,visibility,assigned_to) VALUES(?,?,?,?)').run(title,admin,visibility,assignedTo).lastInsertRowid);
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=Number(req.headers['x-user'])||admin;req.session={userId:req.authUserId};next();});app.use('/automation',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const get=async(path,user=admin)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/automation${path}`,{headers:{'x-user':String(user)}});assert.equal(response.status,200);return(await response.json()).data;};
 const denied=async(path,user=child)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/automation${path}`,{headers:{'x-user':String(user)}});assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'Rotation not found.',code:404});};
 try{await run({d,admin,child,group,track,task,get,denied});assert.deepEqual(d.pragma('foreign_key_check'),[]);}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();}
}

test('Group and Track reads identify the authoritative recurring definition, without mutations or title matching',()=>fixture(async({d,group,track,task,get})=>{
 const source=task('One occurrence edited title'),series=source;
 d.prepare('INSERT INTO task_recurrence_series(series_id) VALUES(?)').run(series);
 d.prepare('INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id) VALUES(?,0,?,?)')
  .run(series,JSON.stringify({task:{title:'Get Ready for Bed'},subtasks:[]}),source);
 d.prepare("INSERT INTO task_recurrence_occurrences(task_id,series_id,generation,occurrence_key) VALUES(?,?,0,'2026-09-19')").run(source,series);
 const first=track('task_series',series),unrelated=track('task_series',99999);
 const before=d.prepare('SELECT total_changes() n').get().n;
 const data=await get(`/rotation-groups/${group.id}`),record=data.tracks.find(t=>t.id===first.id);
 assert.equal(record.display_label,'Get Ready for Bed · Shower Order');assert.equal(record.consumer_status,'active');
 assert.equal(data.tracks.find(t=>t.id===unrelated.id).display_label,'Previous consumer · Shower Order');
 assert.equal((await get(`/rotation-tracks/${first.id}`)).display_label,record.display_label);
 assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
 d.prepare("UPDATE tasks SET archived_at='2026-09-19' WHERE id=?").run(source);
 assert.equal((await get(`/rotation-tracks/${first.id}`)).consumer_status,'archived');
 d.prepare('DELETE FROM tasks WHERE id=?').run(source);
 const deleted=await get(`/rotation-tracks/${first.id}`);assert.equal(deleted.consumer_status,'previous');assert.equal(deleted.consumer_label,'Previous consumer');
}));

test('Current and exception Task payloads require canonical Task visibility; permission changes apply immediately',()=>fixture(async({d,child,track,task,get,denied})=>{
 const source=task('Private appointment',{visibility:'assignees'});
 for(const [type,id] of [['task',String(source)],['task_exception',`${source}:stable-signature`]]) {
  const t=track(type,id);await denied(`/rotation-tracks/${t.id}`);
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(child,source);
  assert.equal((await get(`/rotation-tracks/${t.id}`,child)).display_label,'Private appointment · Shower Order');
  d.prepare('UPDATE tasks SET assigned_to=NULL WHERE id=?').run(source);
 }
 const malformed=track('task',`${source}:not-a-task-identity`);assert.equal((await get(`/rotation-tracks/${malformed.id}`)).consumer_status,'previous');
}));

test('Recurring-series source privacy is enforced before exposing definition snapshots',()=>fixture(async({d,track,task,denied})=>{
 const source=task('Private concrete title',{visibility:'private'});
 d.prepare('INSERT INTO task_recurrence_series(series_id) VALUES(?)').run(source);
 d.prepare('INSERT INTO task_recurrence_definitions(series_id,effective_generation,definition_json,source_task_id) VALUES(?,0,?,?)')
  .run(source,JSON.stringify({task:{title:'Private recurring definition'},subtasks:[]}),source);
 const t=track('task_series',source);await denied(`/rotation-tracks/${t.id}`);
}));

test('Workflow and step contexts use stable source IDs, retain removed-step history and honor Workflow access',()=>fixture(async({d,child,track,get,denied})=>{
 const workflow=Number(d.prepare("INSERT INTO workflow_templates(name) VALUES('Get Ready for Bed')").run().lastInsertRowid);
 const activity=Number(d.prepare("INSERT INTO activity_templates(name,title_template,category) VALUES('Bedtime checklist','Bedtime checklist','misc')").run().lastInsertRowid);
 d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,title_override) VALUES(?,?,'child_1','Eleanor bedtime')").run(workflow,activity);
 const root=track('workflow',workflow),step=track('workflow_step',`${workflow}:child_1`);
 assert.equal((await get(`/rotation-tracks/${root.id}`,child)).display_label,'Get Ready for Bed · Shower Order');
 assert.equal((await get(`/rotation-tracks/${step.id}`,child)).display_label,'Get Ready for Bed · Eleanor bedtime · Shower Order');
 d.prepare('UPDATE workflow_templates SET active=0 WHERE id=?').run(workflow);assert.equal((await get(`/rotation-tracks/${root.id}`)).consumer_status,'inactive');
 d.prepare('DELETE FROM workflow_template_steps WHERE workflow_template_id=?').run(workflow);
 const removed=await get(`/rotation-tracks/${step.id}`);assert.equal(removed.consumer_status,'previous');assert.equal(removed.display_label,'Get Ready for Bed · Previous step · Shower Order');
 replaceSubjectPermissions(d,'user',child,{capabilities:{'rotations.view':'allow','workflows.view':'none'}});
 await denied(`/rotation-tracks/${root.id}`);
}));

test('Deleted Workflow source uses authorized retained Task evidence, never private historical payloads',()=>fixture(async({d,admin,child,track,task,get,denied})=>{
 const workflow=Number(d.prepare("INSERT INTO workflow_templates(name) VALUES('Original source')").run().lastInsertRowid);
 const t=track('workflow',workflow),owner=task('Historical bedtime',{visibility:'assignees',assignedTo:child});
 const occurrence=resolveRotation(d,t.id,'shared-night',{actorId:admin,context:{task_id:owner}});
 d.prepare('INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id) VALUES(?,?,?,?,?)').run(owner,'order',t.id,occurrence.id,owner);
 d.prepare('DELETE FROM workflow_templates WHERE id=?').run(workflow);
 const previous=await get(`/rotation-tracks/${t.id}`,child);assert.equal(previous.display_label,'Historical bedtime · Shower Order');assert.equal(previous.consumer_status,'previous');
 d.prepare('UPDATE tasks SET assigned_to=NULL WHERE id=?').run(owner);
 await denied(`/rotation-tracks/${t.id}`);await denied(`/rotation-tracks/${t.id}/history`);
 assert.equal((await get(`/rotation-tracks/${t.id}/history`))[0].id,occurrence.id);
}));

test('Scoped Meal Tracks show the owning plan and role while preserving archived/deleted context and module privacy',()=>fixture(async({d,child,track,get,denied})=>{
 const plan=Number(d.prepare("INSERT INTO meal_plans(name) VALUES('Weeknight dinners')").run().lastInsertRowid);
 const t=track('meal_plan',`${plan}:dinner-slot:context:4`,'Dinner · Chooser');
 assert.equal((await get(`/rotation-tracks/${t.id}`,child)).display_label,'Weeknight dinners · Dinner · Chooser');
 d.prepare("UPDATE meal_plans SET status='archived' WHERE id=?").run(plan);assert.equal((await get(`/rotation-tracks/${t.id}`,child)).consumer_status,'archived');
 d.prepare("UPDATE meal_plans SET status='deleted' WHERE id=?").run(plan);assert.equal((await get(`/rotation-tracks/${t.id}`,child)).consumer_status,'previous');
 replaceSubjectPermissions(d,'user',child,{modules:{meals:'none'},capabilities:{'rotations.view':'allow'}});
 await denied(`/rotation-tracks/${t.id}`);
 d.prepare('DELETE FROM meal_plans WHERE id=?').run(plan);assert.equal((await get(`/rotation-tracks/${t.id}`)).consumer_label,'Previous consumer');
}));
