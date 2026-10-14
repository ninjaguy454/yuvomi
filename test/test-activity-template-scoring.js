import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
const {default:automation}=await import('../server/routes/automation.js');
const {instantiateWorkflow,resolveActivityTemplate}=await import('../server/services/activity-workflows.js');
const {captureActivityTemplateDefinition}=await import('../server/services/task-activity-snapshot.js');
const {ALL_MIGRATIONS}=await import('../server/db.js');

async function fixture(t){
  const f=await scoringFixture(t),app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=1;req.authRole='admin';req.authMethod='session';req.session={userId:1,role:'admin'};next();});app.use('/automation',automation);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  f.template=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/automation/admin/activity-templates${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,...await r.json()};};return f;
}
const input=(mode='subtasks')=>({name:'Reusable scored homework',title_template:'Scored homework',assignment_strategy:'fixed',fixed_user_id:2,subject_required:false,presence_policy:'ignore',points:8,scoring_mode:mode,checklist:[{title_template:'Math',points:2,skill_ids:[],is_optional:0},{title_template:'Read',points:3,skill_ids:[],is_optional:1}]});
const earnings=(f,id)=>f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) ORDER BY task_id,id").all(id,id);

test('template API round-trips active and inactive point values, optional/order and an explicit scoring mode',async t=>{
  const f=await fixture(t),r=await f.template('POST','',input());assert.equal(r.status,201,JSON.stringify(r));
  assert.equal(r.data.scoring_mode,'subtasks');assert.deepEqual(r.data.checklist.map(c=>c.points),[2,3]);
  const edited=await f.template('PUT','/'+r.data.id,{scoring_mode:'whole_task',points:0,checklist:[{...r.data.checklist[1],points:0},{...r.data.checklist[0],points:7}]});
  assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(edited.data.scoring_mode,'whole_task');assert.equal(edited.data.points,0);assert.deepEqual(edited.data.checklist.map(c=>[c.title_template,c.points,c.is_optional]),[['Read',0,1],['Math',7,0]]);
  const partial=await f.template('PUT','/'+r.data.id,{name:'Renamed scored homework'});assert.equal(partial.status,200);assert.deepEqual(partial.data.checklist.map(c=>c.points),[0,7]);assert.equal(partial.data.scoring_mode,'whole_task');
  const resolved=resolveActivityTemplate(f.d,r.data.id,{actorId:1});assert.equal(resolved.data.scoring_mode,'whole_task');assert.equal(resolved.data.points,0);assert.deepEqual(resolved.data.checklist.map(c=>c.points),[0,7]);
  const snapshot=captureActivityTemplateDefinition(f.d,r.data.id);assert.equal(snapshot.scoring_mode,'whole_task');assert.deepEqual(snapshot.checklist.map(c=>c.points),[0,7]);
});

for(const mode of ['whole_task','subtasks'])test(`template ${mode} creates Task and Workflow owners with the same recipients and one selected award source`,async t=>{
  const f=await fixture(t),r=await f.template('POST','',input(mode));assert.equal(r.status,201);const id=r.data.id;
  const direct=await f.call('POST','/tasks',{activity_template_id:id});assert.equal(direct.status,201,JSON.stringify(direct));
  assert.equal(direct.data.scoring_mode,mode);assert.equal(direct.data.points,8);assert.deepEqual(direct.data.subtasks.map(c=>c.points),[2,3]);
  // Complete the optional action before the last required action closes work.
  for(const child of [...direct.data.subtasks].reverse())assert.equal((await f.finish(child.id)).status,200);await f.finish(direct.data.id);await f.finish(direct.data.id);
  assert.deepEqual(earnings(f,direct.data.id),mode==='whole_task'?[{user_id:2,delta:8}]:[{user_id:2,delta:2},{user_id:2,delta:3}]);
  const workflow=Number(f.d.prepare("INSERT INTO workflow_templates(name,subject_required,created_by) VALUES('Scored homework workflow',0,1)").run().lastInsertRowid);f.d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key) VALUES(?,?,'homework')").run(workflow,id);
  const instance=instantiateWorkflow(f.d,workflow,{createdBy:1,startDate:'2026-11-01'}),owner=f.d.prepare("SELECT t.* FROM tasks t JOIN workflow_instance_tasks wit ON wit.task_id=t.id WHERE wit.workflow_instance_id=? AND wit.role='primary'").get(instance.id);
  assert.equal(owner.scoring_mode,mode);assert.equal(owner.points,8);const children=f.d.prepare('SELECT id,points FROM tasks WHERE parent_task_id=? ORDER BY id').all(owner.id);assert.deepEqual(children.map(c=>c.points),[2,3]);
  for(const child of [...children].reverse())assert.equal((await f.finish(child.id)).status,200);await f.finish(owner.id);await f.finish(owner.id);
  assert.deepEqual(earnings(f,owner.id),mode==='whole_task'?[{user_id:2,delta:8}]:[{user_id:2,delta:2},{user_id:2,delta:3}]);
});

test('template edit affects new instances while current recurrence snapshots and settled history remain intact',async t=>{
  const f=await fixture(t),r=await f.template('POST','',input('subtasks')),id=r.data.id;
  const created=await f.call('POST','/tasks',{activity_template_id:id,due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'});assert.equal(created.status,201);const root=created.data.id;
  const current=f.row(root),children=created.data.subtasks.map(c=>({id:c.id,points:c.points}));
  assert.equal((await f.template('PUT','/'+id,{scoring_mode:'whole_task',points:11,checklist:[{title_template:'New work',points:9,is_optional:0,skill_ids:[]}]})).status,200);
  assert.equal(f.row(root).scoring_mode,current.scoring_mode);assert.equal(f.row(root).points,current.points);assert.deepEqual(children.map(c=>f.row(c.id).points),[2,3]);
  for(const child of children)await f.finish(child.id);await f.finish(root);const frozen=f.d.prepare('SELECT * FROM task_scoring_settlements ORDER BY id').all(),ledger=f.d.prepare('SELECT * FROM reward_ledger ORDER BY id').all();
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root);assert.equal(next.scoring_mode,'subtasks');assert.equal(next.points,8);assert.deepEqual(f.d.prepare('SELECT points FROM tasks WHERE parent_task_id=? ORDER BY id').all(next.id).map(c=>c.points),[2,3]);
  const fresh=await f.call('POST','/tasks',{activity_template_id:id});assert.equal(fresh.data.scoring_mode,'whole_task');assert.equal(fresh.data.points,11);assert.deepEqual(fresh.data.subtasks.map(c=>c.points),[9]);
  assert.deepEqual(f.d.prepare('SELECT * FROM task_scoring_settlements ORDER BY id').all(),frozen);assert.deepEqual(f.d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),ledger);
});

test('legacy templates retain null mode, zero child defaults and Workflow fallback until explicitly reviewed',async t=>{
  const f=await fixture(t),id=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('Legacy scored work','Legacy work','fixed','fixed',2,0,'ignore',1,6)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template) VALUES(?,'Legacy checklist')").run(id);
  const edited=await f.template('PUT','/'+id,{name:'Legacy renamed'});assert.equal(edited.status,200);assert.equal(edited.data.scoring_mode,null);assert.equal(edited.data.checklist[0].points,0);
  const workflow=Number(f.d.prepare("INSERT INTO workflow_templates(name,subject_required,created_by) VALUES('Legacy workflow',0,1)").run().lastInsertRowid);f.d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key) VALUES(?,?,'legacy')").run(workflow,id);
  const instance=instantiateWorkflow(f.d,workflow,{createdBy:1}),owner=f.d.prepare("SELECT t.* FROM tasks t JOIN workflow_instance_tasks wit ON wit.task_id=t.id WHERE wit.workflow_instance_id=? AND wit.role='primary'").get(instance.id);assert.equal(owner.scoring_mode,'legacy');
  const reviewed=await f.template('PUT','/'+id,{scoring_mode:'subtasks',checklist:[{title_template:'Earned work',points:4,skill_ids:[],is_optional:0}]});assert.equal(reviewed.status,200);assert.equal(reviewed.data.scoring_mode,'subtasks');assert.equal(f.row(owner.id).scoring_mode,'legacy');
});

test('template scoring validates malformed mode and points atomically instead of clamping or silently dropping values',async t=>{
  const f=await fixture(t);
  for(const body of [{scoring_mode:'legacy'},{scoring_mode:null},{scoring_mode:'bogus'},{points:10001},{points:true},{points:1.5},{points:-1},{checklist:[{title_template:'Invalid',points:1.5}]},{checklist:[{title_template:'Invalid',points:true}]},{checklist:[{title_template:'Invalid',points:10001}]},{checklist:[{title_template:'Invalid',points:''}]}]){
    const before=f.snapshot(),r=await f.template('POST','',{...input(),...body});assert.equal(r.status,400,JSON.stringify({body,response:r}));assert.equal(f.snapshot(),before);
  }
  const r=await f.template('POST','',{...input(),scoring_mode:undefined});assert.equal(r.status,201);assert.equal(r.data.scoring_mode,'whole_task');
});

test('legacy sparse edits preserve old overall points and ambiguous checklist identity never invents an amount',async t=>{
  const f=await fixture(t),legacy=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('Large legacy default','Legacy','fixed','fixed',2,0,'ignore',1,100000)").run().lastInsertRowid);
  const renamed=await f.template('PUT','/'+legacy,{name:'Untouched legacy amount'});assert.equal(renamed.status,200);assert.equal(renamed.data.points,100000);assert.equal(renamed.data.scoring_mode,null);
  const created=await f.template('POST','',{...input(),checklist:[{title_template:'Repeated',points:2},{title_template:'Repeated',points:3}]});assert.equal(created.status,201);
  const before=f.snapshot(),ambiguous=await f.template('PUT','/'+created.data.id,{checklist:[{title_template:'Repeated'},{title_template:'Repeated'}]});
  assert.equal(ambiguous.status,400,'without row IDs or amounts an old client cannot distinguish duplicate titles');assert.equal(f.snapshot(),before);
});

test('append-only template scoring migration preserves operational Tasks, ledger and legacy templates on upgrade and retry',()=>{
  const d=new Database(':memory:');try{
    const migration=ALL_MIGRATIONS.find(m=>m.description==='Activity Templates: explicit scoring modes and checklist point amounts');assert.ok(migration,'scoring migration is registered');
    for(const m of ALL_MIGRATIONS.filter(m=>m.version<migration.version)){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
    d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'synthetic-upgrade','Synthetic Upgrade','x','admin'); INSERT INTO activity_templates(id,name,title_template,created_by,points) VALUES(1,'Old template','Old work',1,5); INSERT INTO activity_template_checklist_items(activity_template_id,title_template) VALUES(1,'Old step'); INSERT INTO tasks(id,title,points,scoring_mode) VALUES(1,'Old paid Task',5,'whole_task'); INSERT INTO reward_ledger(user_id,delta,type,task_id) VALUES(1,5,'earn',1)");
    const tasks=d.prepare('SELECT * FROM tasks').all(),ledger=d.prepare('SELECT * FROM reward_ledger').all();migration.up(d);migration.up(d);
    assert.equal(d.prepare('SELECT scoring_mode FROM activity_templates WHERE id=1').get().scoring_mode,null);assert.equal(d.prepare('SELECT points FROM activity_template_checklist_items').get().points,0);assert.deepEqual(d.prepare('SELECT * FROM tasks').all(),tasks);assert.deepEqual(d.prepare('SELECT * FROM reward_ledger').all(),ledger);
  }finally{d.close();}
});
