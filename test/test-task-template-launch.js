import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
const {default:idempotencyMiddleware}=await import('../server/middleware/idempotency.js');
const {previewTemplateLaunch}=await import('../server/services/task-template-launch.js');

async function fixture(t,{limit=1,override=1,subject=1,recurring=false}={}){
  const f=await scoringFixture(t);
  f.d.exec("UPDATE users SET first_name='Alex' WHERE id=2; UPDATE users SET first_name='Sam' WHERE id=3; INSERT INTO household_variable_definitions(variable_key,label,type,kind) VALUES('assignee','Assignee','household_member','value')");
  f.d.prepare("INSERT INTO task_categories(key,name,max_assignees) VALUES('launch-personal','Personal',?)").run(limit);
  const id=Number(f.d.prepare(`INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,subject_required,allow_assignment_override,presence_policy,created_by,points,scoring_mode,recurrence_rule,due_date_offset_days)
    VALUES('Morning','{{assignee.first_name}} morning','launch-personal','fixed','fixed',2,?,?,'ignore',1,8,'subtasks',?,0)`).run(subject,override,recurring?'FREQ=DAILY':null).lastInsertRowid);
  f.d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template,points) VALUES(?,'{{assignee.first_name}} prepare',3)").run(id);
  f.launch=(suffix,body={},actor=1)=>f.call('POST','/tasks/template-launch/'+suffix,{activity_template_id:id,recipient_user_ids:[2,3],mode:limit===1?'individual':'shared',...(limit===1?{}:{primary_user_id:2}),start_date:'2026-11-01',inputs:{},...body},actor);
  return {...f,templateId:id};
}

test('personal preview resolves each scalar person and changes no stored data or rotation state',async t=>{
  const f=await fixture(t),before=f.snapshot(),changes=f.changes();
  const r=await f.launch('preview');assert.equal(r.status,200,JSON.stringify(r));
  assert.equal(r.data.mode,'individual');assert.equal(r.data.task_count,2);
  assert.deepEqual(r.data.activities.map(row=>[row.recipient_user_ids,row.primary_user_id,row.title]),[[[2],2,'Alex morning'],[[3],3,'Sam morning']]);
  assert.equal(f.snapshot(),before);assert.equal(f.changes(),changes);
});

test('personal creation is atomic and retry-safe with independent checklist, subject, scoring and recurrence identities',async t=>{
  const f=await fixture(t,{recurring:true});
  const r=await f.launch('create',{request_key:'morning-one'});assert.equal(r.status,201,JSON.stringify(r));
  assert.equal(r.data.tasks.length,2);const [a,b]=r.data.tasks;
  assert.notEqual(a.id,b.id);assert.deepEqual([a.assigned_to,b.assigned_to],[2,3]);
  assert.deepEqual([a.direct_assignee_ids,b.direct_assignee_ids],[[2],[3]]);
  assert.deepEqual([a.title,b.title],['Alex morning','Sam morning']);
  assert.deepEqual([a.subtasks[0].title,b.subtasks[0].title],['Alex prepare','Sam prepare']);
  assert.deepEqual(f.d.prepare('SELECT subject_user_id FROM task_activity_bindings ORDER BY task_id').all().map(r=>r.subject_user_id),[2,3]);
  assert.notEqual(a.recurrence_series_id,b.recurrence_series_id);assert.equal(a.scoring_mode,'subtasks');
  const before=f.snapshot(),retry=await f.launch('create',{request_key:'morning-one'});
  assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.data.replayed,true);assert.deepEqual(retry.data.tasks.map(t=>t.id),[a.id,b.id]);assert.equal(f.snapshot(),before);
  await f.finish(a.subtasks[0].id);await f.finish(b.subtasks[0].id);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' ORDER BY user_id,id").all(),[{user_id:2,delta:3},{user_id:3,delta:3}]);
  const next=f.d.prepare('SELECT id,assigned_to FROM tasks WHERE parent_task_id IS NULL AND id NOT IN (?,?) ORDER BY id').all(a.id,b.id);assert.equal(next.length,2);assert.deepEqual(next.map(r=>r.assigned_to),[2,3]);
});

test('durable replay rejects a changed request and never recreates deleted results',async t=>{
  const f=await fixture(t),r=await f.launch('create',{request_key:'durable'});assert.equal(r.status,201);
  const before=f.snapshot(),conflict=await f.launch('create',{request_key:'durable',recipient_user_ids:[2]});assert.equal(conflict.status,409);assert.equal(f.snapshot(),before);
  f.d.prepare('DELETE FROM tasks WHERE id=?').run(r.data.tasks[0].id);
  const deleted=f.snapshot(),retry=await f.launch('create',{request_key:'durable'});assert.equal(retry.status,410);assert.equal(f.snapshot(),deleted);
});

test('completed launch retries reauthorize current access and survive later template/category edits',async t=>{
  const f=await fixture(t),r=await f.launch('create',{request_key:'live-access'},2);assert.equal(r.status,201,JSON.stringify(r));
  f.d.prepare('UPDATE activity_templates SET active=0 WHERE id=?').run(f.templateId);
  f.d.exec("UPDATE task_categories SET max_assignees=4 WHERE key='launch-personal'");
  const before=f.snapshot(),retry=await f.launch('create',{request_key:'live-access'},2);assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(f.snapshot(),before);
  f.grant('create','none');const denied=f.snapshot();assert.equal((await f.launch('create',{request_key:'live-access'},2)).status,403);assert.equal(f.snapshot(),denied);
});

test('a late failure rolls back every created task, child, assignment, notification and receipt',async t=>{
  const f=await fixture(t);
  f.d.exec("CREATE TRIGGER reject_second_launch BEFORE UPDATE OF assigned_to ON tasks WHEN NEW.assigned_to=3 BEGIN SELECT RAISE(ABORT,'Synthetic second member failure'); END");
  const before=f.snapshot(),r=await f.launch('create',{request_key:'must-rollback'});assert.equal(r.status,500,JSON.stringify(r));assert.equal(f.snapshot(),before);
});

test('template assignment and category permissions are checked at preview and create',async t=>{
  const f=await fixture(t,{override:0}),before=f.snapshot();
  assert.equal((await f.launch('preview')).status,400);assert.equal((await f.launch('create',{request_key:'fixed-denied'})).status,400);assert.equal(f.snapshot(),before);
  assert.equal((await f.launch('create',{request_key:'fixed-one',recipient_user_ids:[2]})).status,201);
  f.grant('change_assignment','none');const denied=f.snapshot();assert.equal((await f.launch('create',{request_key:'assignment-denied',recipient_user_ids:[2]},2)).status,403);assert.equal(f.snapshot(),denied);
});

test('invalid, duplicate, unknown and excessive selections fail atomically instead of truncating',async t=>{
  const f=await fixture(t);
  for(const recipient_user_ids of [[],[2,2],[2,999],[true],[2,'3'],Array.from({length:101},(_,i)=>i+1)]){
    const before=f.snapshot(),r=await f.launch('create',{request_key:'invalid',recipient_user_ids});assert.equal(r.status,400,JSON.stringify(r));assert.equal(f.snapshot(),before);
  }
  for(const extra of [{mode:'shared',primary_user_id:2},{category:'misc'},{title:'Injection'},{activity_subject_user_id:[2,3]},{request_key:''}]){
    const before=f.snapshot(),r=await f.launch('create',{request_key:'bad-shape',...extra});assert.equal(r.status,400,JSON.stringify(r));assert.equal(f.snapshot(),before);
  }
});

test('shared launch requires explicit primary and creates one canonical task with all selected direct assignees',async t=>{
  const f=await fixture(t,{limit:3}),before=f.snapshot();
  assert.equal((await f.launch('preview',{primary_user_id:undefined})).status,400);assert.equal(f.snapshot(),before);
  const preview=await f.launch('preview',{primary_user_id:3});assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(preview.data.task_count,1);assert.equal(preview.data.activities[0].title,'Sam morning');assert.deepEqual(preview.data.activities[0].recipient_user_ids,[3,2]);assert.equal(f.snapshot(),before);
  const r=await f.launch('create',{primary_user_id:3,request_key:'shared-one'});assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.data.tasks.length,1);
  const root=r.data.tasks[0];assert.equal(root.assigned_to,3);assert.deepEqual(root.direct_assignee_ids,[2,3]);assert.deepEqual(root.assigned_users.map(u=>u.id).sort(),[2,3]);assert.equal(root.subtasks.length,1);
  await f.finish(root.subtasks[0].id);assert.equal(f.d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn'").get().n,2,'one canonical child source, existing shared scoring recipients');
});

test('shared recurrence retains the chosen roster and template edits do not rewrite current activities',async t=>{
  const f=await fixture(t,{limit:null,recurring:true}),r=await f.launch('create',{primary_user_id:3,request_key:'shared-series'});assert.equal(r.status,201,JSON.stringify(r));const root=r.data.tasks[0];
  f.d.prepare("UPDATE activity_templates SET title_template='New template',fixed_user_id=1 WHERE id=?").run(f.templateId);
  await f.finish(root.subtasks[0].id);await f.finish(root.id);
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root.id);assert.ok(next);assert.equal(next.assigned_to,3);
  const read=await f.call('GET','/tasks/'+next.id);assert.deepEqual(read.data.direct_assignee_ids,[2,3]);assert.equal(read.data.title,'Sam morning');assert.equal(f.row(root.id).title,'Sam morning');
});

test('category limit and eligibility are revalidated between preview and create without converting records',async t=>{
  const f=await fixture(t,{limit:3}),preview=await f.launch('preview');assert.equal(preview.status,200);
  f.d.exec("UPDATE task_categories SET max_assignees=1 WHERE key='launch-personal'");
  const before=f.snapshot(),r=await f.launch('create',{request_key:'changed-category'});assert.equal(r.status,400);assert.equal(f.snapshot(),before);
});

test('replay returns current authorized data and denies newly inaccessible results without cached private content',async t=>{
  const f=await fixture(t),r=await f.launch('create',{request_key:'current-data'},2);assert.equal(r.status,201);
  f.d.prepare("UPDATE tasks SET title='Current authorized title' WHERE id=?").run(r.data.tasks[0].id);
  const retry=await f.launch('create',{request_key:'current-data'},2);assert.equal(retry.status,200);assert.equal(retry.data.tasks[0].title,'Current authorized title');
  f.grant('view_household','none');f.grant('view_own','none');const before=f.snapshot(),denied=await f.launch('create',{request_key:'current-data'},2);assert.equal(denied.status,403);assert.ok(!denied.data);assert.equal(f.snapshot(),before);
});

test('launch previews and durable creates bypass generic HTTP response caching and deny anonymous display principals',async t=>{
  const f=await fixture(t),before=f.snapshot();
  for(const path of ['/tasks/template-launch/preview','/tasks/template-launch/create']){
    let next=false;idempotencyMiddleware({path,method:'POST',authUserId:1,get:()=> 'generic-cache-key'}, {},()=>{next=true;});assert.equal(next,true);assert.equal(f.snapshot(),before);
  }
  assert.throws(()=>previewTemplateLaunch(f.d,{authUserId:1,authRole:'admin',devicePrincipal:{kind:'device'}},{}),error=>error.status===403);assert.equal(f.snapshot(),before);
});
