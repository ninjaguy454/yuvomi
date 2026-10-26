import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {readTaskAssigneePolicy} from '../server/services/task-assignee-policy.js';
import {previewTaskActivityBinding} from '../server/services/task-activity-bindings.js';
import {prepareSeriesOccurrenceWork} from '../server/services/task-series.js';
import express from 'express';
import automationRouter from '../server/routes/automation.js';
import {instantiateWorkflow} from '../server/services/activity-workflows.js';
const people=(f,id)=>f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(x=>x.user_id);
const cursors=f=>f.d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all();
const createGroup=f=>saveRotationGroup(f.d,{name:'Synthetic Owners',member_ids:[2,3]},{actorId:1});
test('Group Owner plus ordered extras persists independently; edits and replay never consume an Owner turn',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),made=await f.create({assignment_group:{group_id:g.id},additional_assignee_ids:[3,2,3],assigned_to:[]});
 assert.equal(made.status,201,JSON.stringify(made));const id=made.data.id;
 assert.equal(f.row(id).assigned_to,2);assert.deepEqual(people(f,id),[2,3]);
 assert.deepEqual(JSON.parse(f.row(id).additional_assignee_ids_json),[3,2]);
 const cursor=cursors(f);assert.equal((await f.edit(id,{additional_assignee_ids:[1,2]})).status,200);
 assert.equal(f.row(id).assigned_to,2);assert.deepEqual(people(f,id),[1,2]);assert.deepEqual(cursors(f),cursor);
 const n=f.changes(),times=[];for(let i=0;i<10;i++){const start=performance.now();assert.equal((await f.edit(id,{additional_assignee_ids:[1,2]})).status,200);times.push(performance.now()-start);}assert.equal(f.changes()-n,0);
 times.sort((a,b)=>a-b);t.diagnostic(`10 no-op saves: median ${times[5].toFixed(2)} ms, p95 ${times[9].toFixed(2)} ms; 0 SQLite changes; 0 cursor changes`);
 assert.deepEqual(cursors(f),cursor);assert.deepEqual(readTaskAssigneePolicy(f.d,id).direct_assignee_ids,[1,2]);
});
test('recurrence snapshots extras and awards only actual people, preserving extras when they become Owner',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),made=await f.create({assignment_group:{group_id:g.id},additional_assignee_ids:[3],assigned_to:[],points:2,scoring_mode:'whole_task',is_recurring:1,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01'});
 assert.equal(made.status,201,JSON.stringify(made));const id=made.data.id;assert.equal((await f.finish(id)).status,200);
 const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
 assert.equal(next.assigned_to,3);assert.deepEqual(people(f,next.id),[3]);assert.deepEqual(JSON.parse(next.additional_assignee_ids_json),[3]);
 assert.deepEqual(readTaskAssigneePolicy(f.d,next.id).direct_assignee_ids,[3]);
 assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY user_id").all(id),[{user_id:2,delta:2},{user_id:3,delta:2}]);
});
test('extras cannot bypass category limits or assignment permissions and failed changes roll back',async t=>{
 const f=await scoringFixture(t),g=createGroup(f);f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
 const before=f.snapshot(),bad=await f.create({category:'school',assignment_group:{group_id:g.id},additional_assignee_ids:[3]});assert.equal(bad.status,400,JSON.stringify(bad));assert.equal(f.snapshot(),before);
 const made=await f.create({assignment_group:{group_id:g.id},additional_assignee_ids:[]});assert.equal(made.status,201);f.grant('change_assignment','none');
 const saved=f.snapshot(),denied=await f.edit(made.data.id,{additional_assignee_ids:[3]},2);assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),saved);
});
test('bound Group Template snapshots extras; extras edits preserve current Owner and future source',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,assignment_group_json,additional_assignee_ids_json) VALUES('Group activity','Group activity','eligible_round_robin','group_rotation',0,?,?)").run(JSON.stringify({group_id:g.id}),'[3]').lastInsertRowid);
 const before=f.snapshot(),preview=previewTaskActivityBinding(f.d,{activityTemplateId:template});assert.deepEqual(preview.resolution.participants.map(x=>x.id),[2,3]);assert.equal(f.snapshot(),before);
 const made=await f.create({activity_template_id:template,is_recurring:1,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'});assert.equal(made.status,201,JSON.stringify(made));const id=made.data.id;
 assert.deepEqual(people(f,id),[2,3]);assert.deepEqual(made.data.additional_assignee_ids,[3]);
 const cursor=cursors(f);const previewEdit=await f.preview(id,{additional_assignee_ids:[1]});assert.equal(previewEdit.status,200,JSON.stringify(previewEdit));assert.deepEqual(cursors(f),cursor);
 const edited=await f.edit(id,{additional_assignee_ids:[1],assignment_group:{group_id:g.id,direction:'last_to_first'}});assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(f.row(id).assigned_to,2);assert.deepEqual(people(f,id),[1,2]);assert.deepEqual(cursors(f),cursor);
 const n=f.changes();assert.equal((await f.edit(id,{additional_assignee_ids:[1]})).status,200);assert.equal(f.changes()-n,0);
 f.d.prepare("UPDATE activity_templates SET additional_assignee_ids_json='[]' WHERE id=?").run(template);
 assert.equal((await f.finish(id)).status,200);const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.equal(next.assigned_to,3);assert.deepEqual(people(f,next.id),[3]);assert.deepEqual(JSON.parse(next.additional_assignee_ids_json),[3]);
});
test('future-only extras edit keeps this occurrence and cursor; next generation uses new extras',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),made=await f.create({assignment_group:{group_id:g.id},additional_assignee_ids:[3],assigned_to:[],is_recurring:1,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'});assert.equal(made.status,201);const id=made.data.id,cursor=cursors(f),current=f.row(id),saved=people(f,id);
 const patch={edit_scope:'future_only',future_patch:{fields:{additional_assignee_ids:[1]}}};
 const peek=await f.preview(id,patch);assert.equal(peek.status,200,JSON.stringify(peek));assert.deepEqual(cursors(f),cursor);
 const edited=await f.edit(id,patch);assert.equal(edited.status,200,JSON.stringify(edited));assert.deepEqual(f.row(id),current);assert.deepEqual(people(f,id),saved);assert.deepEqual(cursors(f),cursor);
 assert.equal((await f.finish(id)).status,200);const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.equal(next.assigned_to,3);assert.deepEqual(people(f,next.id),[1,3]);assert.deepEqual(JSON.parse(next.additional_assignee_ids_json),[1]);
});
test('unresolved Group Owner stays null even with qualified extras',()=>{
 const result=prepareSeriesOccurrenceWork({id:1,assigned_to:null},{task:{assignment_group_json:'{"group_id":1}',additional_assignee_ids_json:'[3]'},rotation_user_ids:[],assigned_user_ids:[],skill_ids:[],subtasks:[]},{due_date:'2026-11-01'},{qualify:ids=>ids,resolveGroupAssignment:()=>null});
 assert.equal(result.primary_user_id,null);assert.deepEqual(result.assigned_user_ids,[3]);
});
test('editing extras on a saved unresolved Group occurrence never promotes the first extra',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),made=await f.create({assignment_group:{group_id:g.id},additional_assignee_ids:[]});assert.equal(made.status,201);const id=made.data.id;
 f.d.prepare('UPDATE tasks SET assigned_to=NULL WHERE id=?').run(id);f.d.prepare('DELETE FROM task_assignments WHERE task_id=?').run(id);f.d.prepare('DELETE FROM task_direct_assignees WHERE task_id=?').run(id);const cursor=cursors(f);
 const changed=await f.edit(id,{additional_assignee_ids:[3]});assert.equal(changed.status,200,JSON.stringify(changed));assert.equal(f.row(id).assigned_to,null);assert.deepEqual(people(f,id),[3]);assert.deepEqual(cursors(f),cursor);
});
test('Template API persists ordered policy, workflow materializes only extras, and later edits preserve launched snapshots',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=1;req.authRole='admin';req.authMethod='session';req.session={userId:1,role:'admin'};next();});app.use('/automation',automationRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const call=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/automation`+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,...await r.json()};};
 const made=await call('POST','/admin/activity-templates',{name:'Saved extra policy',title_template:'Saved extra policy',assignment_strategy:'group_rotation',subject_required:false,assignment_group:{group_id:g.id},additional_assignee_ids:[3,1,3],subtask_candidate_pool:{person_ids:[2,3],group_ids:[]}});
 assert.equal(made.status,201,JSON.stringify(made));assert.deepEqual(made.data.additional_assignee_ids,[3,1]);const template=made.data.id;
 const workflow=Number(f.d.prepare("INSERT INTO workflow_templates(name,category,subject_required,input_schema_json,created_by) VALUES('Extra workflow','household',0,'[]',1)").run().lastInsertRowid);f.d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order) VALUES(?,?,'work',0)").run(workflow,template);
 const instance=instantiateWorkflow(f.d,workflow,{createdBy:1});const actual=f.d.prepare('SELECT t.* FROM tasks t JOIN workflow_instance_tasks w ON w.task_id=t.id WHERE w.workflow_instance_id=? AND w.role=\'primary\'').get(instance.id);
 assert.ok(actual,JSON.stringify(instance));assert.deepEqual(JSON.parse(actual.additional_assignee_ids_json),[3,1]);assert.deepEqual(people(f,actual.id),[1,2,3]);
 const launched=await f.create({activity_template_id:template});assert.equal(launched.status,201,JSON.stringify(launched));
 assert.equal((await call('PUT','/admin/activity-templates/'+template,{additional_assignee_ids:[]})).status,200);assert.deepEqual(people(f,launched.data.id),[1,2,3]);assert.deepEqual(JSON.parse(f.row(launched.data.id).additional_assignee_ids_json),[3,1]);
});
test('extras respect root skills and candidate-only people gain no work, points or notifications',async t=>{
 const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Owner only',member_ids:[2]},{actorId:1});
 const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Independent work',0,'normal',1)").run().lastInsertRowid);
 f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(3,?,'excluded','manual',1)").run(skill);
 const before=f.snapshot(),bad=await f.create({assignment_group:{group_id:g.id},additional_assignee_ids:[3],skill_ids:[skill]});assert.equal(bad.status,400,JSON.stringify(bad));assert.equal(f.snapshot(),before);
 const made=await f.create({assignment_group:{group_id:g.id},additional_assignee_ids:[],subtask_candidate_pool:{person_ids:[3],group_ids:[]},points:2,scoring_mode:'whole_task'});assert.equal(made.status,201,JSON.stringify(made));assert.deepEqual(people(f,made.data.id),[2]);assert.equal((await f.finish(made.data.id)).status,200);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(made.data.id),[{user_id:2,delta:2}]);
 assert.equal(f.d.prepare('SELECT count(*) n FROM task_responsibilities WHERE task_id=? AND user_id=3').get(made.data.id).n,0);assert.equal(f.d.prepare('SELECT count(*) n FROM planning_obligations WHERE task_id=? AND responsible_user_id=3').get(made.data.id).n,0);
});
test('Group extras share direct limits without counting separate child workers; repeated full editor echoes are no-ops',async t=>{
 const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'One Owner',member_ids:[2]},{actorId:1});f.d.prepare("UPDATE task_categories SET max_assignees=2 WHERE key='school'").run();
 const made=await f.create({category:'school',assignment_group:{group_id:g.id},additional_assignee_ids:[1],assigned_to:[],subtasks:[{title:'Separate worker',assigned_user_ids:[3]}]});assert.equal(made.status,201,JSON.stringify(made));const id=made.data.id;
 assert.deepEqual(readTaskAssigneePolicy(f.d,id).direct_assignee_ids,[1,2]);assert.deepEqual(people(f,id),[1,2,3]);
 const n=f.changes(),cursor=cursors(f),echo=await f.edit(id,{assignment_group:JSON.parse(f.row(id).assignment_group_json),assigned_to:[],additional_assignee_ids:[1]});assert.equal(echo.status,200,JSON.stringify(echo));assert.equal(f.changes()-n,0);assert.deepEqual(cursors(f),cursor);
 assert.equal((await f.edit(id,{additional_assignee_ids:[]})).status,200);assert.deepEqual(people(f,id),[2,3]);assert.deepEqual(readTaskAssigneePolicy(f.d,id).direct_assignee_ids,[2]);
});
test('bound future-only extras and combined Group behavior edits keep their snapshots and Owner',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,assignment_group_json,additional_assignee_ids_json) VALUES('Future extras','Future extras','eligible_round_robin','group_rotation',0,?,'[3]')").run(JSON.stringify({group_id:g.id})).lastInsertRowid);
 const made=await f.create({activity_template_id:template,is_recurring:1,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'});assert.equal(made.status,201,JSON.stringify(made));const id=made.data.id,cursor=cursors(f),current=f.row(id);
 const changed=await f.edit(id,{edit_scope:'future_only',future_patch:{fields:{additional_assignee_ids:[1]}}});assert.equal(changed.status,200,JSON.stringify(changed));assert.deepEqual(f.row(id),current);assert.deepEqual(cursors(f),cursor);
 assert.equal((await f.finish(id)).status,200);const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.equal(next.assigned_to,3);assert.deepEqual(people(f,next.id),[1,3]);assert.deepEqual(JSON.parse(next.additional_assignee_ids_json),[1]);
});
test('editing extras on an already materialized future bound occurrence preserves its consumed Owner turn and reconciles direct roles',async t=>{
 const f=await scoringFixture(t),g=createGroup(f),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,assignment_group_json,additional_assignee_ids_json) VALUES('Existing future','Existing future','eligible_round_robin','group_rotation',0,?,'[3]')").run(JSON.stringify({group_id:g.id})).lastInsertRowid);
 const made=await f.create({activity_template_id:template,is_recurring:1,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'});assert.equal(made.status,201);const id=made.data.id;assert.equal((await f.finish(id)).status,200);const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id),cursor=cursors(f),past=f.row(id);
 const edited=await f.edit(id,{edit_scope:'future_only',future_patch:{fields:{additional_assignee_ids:[1]}}});assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(f.row(next.id).assigned_to,next.assigned_to);assert.deepEqual(cursors(f),cursor);assert.deepEqual(f.row(id),past);
 assert.deepEqual(people(f,next.id),[1,3]);assert.deepEqual(readTaskAssigneePolicy(f.d,next.id).direct_assignee_ids,[1,3]);assert.deepEqual(f.d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='participant' AND source='activity_template' AND status='active' ORDER BY user_id").all(next.id).map(row=>row.user_id),[1,3]);
});
