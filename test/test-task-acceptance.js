import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-task-acceptance';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');
const {taskOfferState,listTaskOffers}=await import('../server/services/task-offers.js');
const {acceptanceOptions}=await import('../server/services/task-acceptance-policy.js');
const {acceptTask}=await import('../server/services/task-acceptance.js');
const {addTaskAcceptanceSchema}=await import('../server/services/task-acceptance-schema.js');
const d=get();addTaskAcceptanceSchema(d);
for(const [id,name,role] of [[1,'author','admin'],[2,'claimant','member'],[3,'helper','member'],[4,'other','member']])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'synthetic',?)").run(id,name,name,role);
const grant=(id,key,value)=>d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,?) ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access").run(String(id),key,value);
grant(2,'tasks.change_assignment','none');grant(2,'tasks.reassign','none');grant(2,'tasks.accept_with_helpers','none');
const task=(title,extra={})=>{const id=Number(d.prepare('INSERT INTO tasks(title,created_by,parent_task_id,visibility,status,assigned_to) VALUES(?,1,?,?,?,?)').run(title,extra.parent??null,extra.visibility??'all',extra.status??'open',extra.assigned??null).lastInsertRowid);return id;};
let serial=0;
const request=(id,extra={})=>{const options=acceptanceOptions(d,2,id);return {operation_id:`synthetic-${++serial}`,expected_revision:options.expected_revision,coassignee_ids:[],subtask_snapshot:options.subtask_snapshot,subtask_assignments:[],...extra};};

test('ordinary offers are pure authorized projections and exclude every canonical assigned representation',()=>{
  const open=task('Offer'),legacy=task('Legacy assigned',{assigned:3}),relation=task('Relation assigned'),responsibility=task('Responsibility assigned'),privateId=task('Hidden',{visibility:'private'}),child=task('Child',{parent:open}),done=task('Done',{status:'done'}),managed=task('Fixed policy');
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,3)').run(relation);
  d.prepare("INSERT INTO task_responsibilities(task_id,user_id,role) VALUES(?,3,'primary')").run(responsibility);
  d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state) VALUES(?,'fixed','unavailable')").run(managed);
  const before=d.prepare('SELECT total_changes() n').get().n,ids=listTaskOffers(d,2).map(t=>t.id);
  assert.ok(ids.includes(open));for(const id of [legacy,relation,responsibility,privateId,child,done,managed])assert.ok(!ids.includes(id),String(id));
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(taskOfferState(d,2,d.prepare('SELECT * FROM tasks WHERE id=?').get(open)).claimable,true);
});
test('solo acceptance preserves regular status/points and adds canonical assignment once',()=>{
  const id=task('Solo'),body=request(id),result=acceptTask(d,2,id,body);
  assert.equal(result.task_id,id);assert.equal(result.replayed,false);
  assert.deepEqual(d.prepare('SELECT assigned_to,status FROM tasks WHERE id=?').get(id),{assigned_to:2,status:'open'});
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(id),[{user_id:2}]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_assignment_context WHERE task_id=?').get(id).n,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(id).n,0);
  const before=d.prepare('SELECT total_changes() n').get().n;assert.equal(acceptTask(d,2,id,body).replayed,true);assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.throws(()=>acceptTask(d,2,id,{...body,coassignee_ids:[3]}),e=>e.status===409);
});
test('helpers require bounded authority, support optional zero allocation and cannot impersonate the human primary',()=>{
  const id=task('Helpers'),child=task('Unassigned child',{parent:id});let body=request(id,{coassignee_ids:[3]});
  assert.throws(()=>acceptTask(d,2,id,body),e=>e.status===403);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,null);
  grant(2,'tasks.accept_with_helpers','allow');
  try{
    assert.throws(()=>acceptTask(d,2,id,{...body,primary_user_id:3}),e=>e.status===403);
    acceptTask(d,2,id,body);
    assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id),[{user_id:2},{user_id:3}]);
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(child).assigned_to,null);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_assignments WHERE task_id=?').get(child).n,0);
  }finally{grant(2,'tasks.accept_with_helpers','none');}
});
test('subtask allocation is atomic and preserves source=subtasks participants and responsibilities',()=>{
  grant(2,'tasks.accept_with_helpers','allow');
  try{
    const id=task('Allocate'),a=task('A',{parent:id}),b=task('B',{parent:id}),other=task('Unrelated');
    const body=request(id,{coassignee_ids:[3],subtask_assignments:[{id:a,user_id:3},{id:b,user_id:null}]});
    assert.throws(()=>acceptTask(d,2,id,{...body,subtask_assignments:[{id:a,user_id:3},{id:other,user_id:2}]}),e=>e.status===400||e.status===409);
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,null);
    acceptTask(d,2,id,body);
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(a).assigned_to,3);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM task_responsibilities WHERE task_id=? AND user_id=3 AND role='subtask_assignee'").get(a).n,1);
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(b).assigned_to,null);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{grant(2,'tasks.accept_with_helpers','none');}
});
test('stale parent, changed/added/deleted child and competing claims do not partially assign',()=>{
  for(const change of ['edit','add','delete']){
    const id=task(`Stale ${change}`),child=task('Child',{parent:id}),body=request(id);
    if(change==='edit')d.prepare("UPDATE tasks SET title='Changed' WHERE id=?").run(child);
    if(change==='add')task('New child',{parent:id});if(change==='delete')d.prepare('DELETE FROM tasks WHERE id=?').run(child);
    assert.throws(()=>acceptTask(d,2,id,body),e=>e.status===409);
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,null);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts WHERE task_id=?').get(id).n,0);
  }
  const id=task('Race'),body=request(id);acceptTask(d,2,id,body);
  assert.throws(()=>acceptTask(d,4,id,{...body,operation_id:'another-claimant'}),e=>e.status===409);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,2);
});
test('replay reauthorizes visibility and claim permissions rather than serving a cached body',()=>{
  const id=task('Replay'),body=request(id);acceptTask(d,2,id,body);
  grant(2,'tasks.claim','none');try{assert.throws(()=>acceptTask(d,2,id,body),e=>e.status===403);}finally{grant(2,'tasks.claim','allow');}
  d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(id);
  assert.throws(()=>acceptTask(d,2,id,body),e=>e.status===404);
});
