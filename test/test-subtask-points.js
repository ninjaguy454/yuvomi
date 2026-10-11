import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import {modernTaskFetch} from './helpers/task-client-revision-fixture.js';
import {hasTaskDefinitionChanges} from '../public/utils/task-edit-scope.js';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='synthetic-subtask-points-only';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
const {taskSeriesState}=await import('../server/services/task-series.js');
let d,server,base,actor;
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T12:00:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);actor=1;
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'Synthetic Parent','Synthetic Parent','x','admin','parent'),(2,'Synthetic Member','Synthetic Member','x','member','other')");
  d.exec("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','UTC'),('task_default_points','9')");
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=actor;req.authRole=actor===1?'admin':'member';req.session={userId:actor,role:req.authRole};next();});app.use('/tasks',router);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));_setTestDatabase(null);d.close();});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const grant=(key,value)=>d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2',?,?) ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access").run(key,value);
async function call(method,path,body){const r=await modernTaskFetch(d,base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,...await r.json()};}
async function create(body){const r=await call('POST','/tasks',{title:'Synthetic routine',points:0,...body});assert.equal(r.status,201,JSON.stringify(r));return r.data;}
async function edit(task,body){const r=await call('PUT','/tasks/'+task.id,body);assert.equal(r.status,200,JSON.stringify(r));return r.data;}
const children=task=>task.subtasks.map(({id,title,points})=>({id,title,points}));
const noAwards=()=>{assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);};
test('inline create persists independent zero, nonzero and omitted points without household defaults or awards',async()=>{
 const task=await create({points:5,scoring_mode:'subtasks',subtasks:[{title:'Zero',points:0},{title:'Seven',points:7},{title:'Omitted'}]});
 assert.deepEqual(task.subtasks.map(s=>s.points),[0,7,0]);assert.equal(row(task.id).points,5);noAwards();
});
test('inline edit persists points-only changes, explicit zero, repeated add/remove/reorder and stable IDs',async()=>{
 let task=await create({subtasks:[{title:'A',points:3},{title:'B',points:7}]});const a=task.subtasks[0].id,b=task.subtasks[1].id;
 task=await edit(task,{subtasks:[{id:a,title:'A',points:4},{id:b,title:'B',points:0}]});assert.deepEqual(task.subtasks.map(s=>s.points),[4,0]);
 for(let i=0;i<3;i++){task=await edit(task,{subtasks:[{id:b,title:'B'},{title:'Temporary',points:8},{id:a,title:'A'}]});assert.deepEqual(children(task),[{id:b,title:'B',points:0},{id:task.subtasks[1].id,title:'Temporary',points:8},{id:a,title:'A',points:4}]);task=await edit(task,{subtasks:[{id:a,title:'A'},{id:b,title:'B'}]});}
 assert.deepEqual(children(task),[{id:a,title:'A',points:4},{id:b,title:'B',points:0}]);noAwards();
});
for(const points of [-1,1.5,10001,'no',{},true])test('invalid inline points reject atomically: '+JSON.stringify(points),async()=>{
 const before=d.prepare('SELECT COUNT(*) n FROM tasks').get().n;const r=await call('POST','/tasks',{title:'Reject',subtasks:[{title:'Valid',points:2},{title:'Bad',points}]});assert.equal(r.status,400,JSON.stringify(r));assert.match(r.error,/subtask.*points/i);assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);
 const task=await create({subtasks:[{title:'Saved',points:6}]});const updated=await call('PUT','/tasks/'+task.id,{title:'Must not save',subtasks:[{id:task.subtasks[0].id,title:'Saved',points}]});assert.equal(updated.status,400,JSON.stringify(updated));assert.equal(row(task.id).title,'Synthetic routine');assert.equal(row(task.subtasks[0].id).points,6);noAwards();
});
test('numeric strings and upper bound persist; unchanged old-client edit retains saved points',async()=>{
 let task=await create({subtasks:[{title:'Maximum',points:'10000'}]});assert.equal(task.subtasks[0].points,10000);task=await edit(task,{subtasks:[{id:task.subtasks[0].id,title:'Renamed'}]});assert.equal(task.subtasks[0].points,10000);noAwards();
});
test('inline create, existing edit and newly added points enforce change_points',async()=>{
 grant('tasks.create','allow');grant('tasks.edit','allow');grant('tasks.change_points','none');actor=2;
 const denied=await call('POST','/tasks',{title:'Denied',points:0,subtasks:[{title:'Earn',points:5}]});assert.equal(denied.status,403,JSON.stringify(denied));
 actor=1;const task=await create({subtasks:[{title:'Saved',points:3}]});actor=2;
 assert.equal((await call('PUT','/tasks/'+task.id,{subtasks:[{id:task.subtasks[0].id,title:'Saved',points:4}]})).status,403);
 assert.equal((await call('PUT','/tasks/'+task.id,{subtasks:[{id:task.subtasks[0].id,title:'Saved'},{title:'New',points:4}]})).status,403);
 assert.equal((await call('PUT','/tasks/'+task.id,{subtasks:[{id:task.subtasks[0].id,title:'Renamed'}]})).status,200);assert.equal(row(task.subtasks[0].id).points,3);noAwards();
});
test('subtask points participate in the recurring scope comparison',()=>{
 const before={title:'Routine',subtasks:[{id:3,title:'Step',points:2}]};assert.equal(hasTaskDefinitionChanges(before,{...before,subtasks:[{id:3,title:'Step',points:5}]}),true);
 assert.equal(hasTaskDefinitionChanges(before,{...before,subtasks:[{id:3,title:'Step',points:'2'}]}),false);
});
for(const relative of [false,true])for(const scope of ['occurrence','future'])test('recurring '+(relative?'completion-relative ':'calendar ')+scope+' points preserve the intended successor definition and award nothing on edit',async()=>{
 let task=await create({assigned_to:[1],start_date:'2026-11-01',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',recurrence_from_completion:relative?1:0,subtasks:[{title:'Step',points:2}]});
 const state=taskSeriesState(d,task.id);task=await edit(task,{edit_scope:scope,expected_series_revision:state.revision,subtasks:[{id:task.subtasks[0].id,title:'Step',points:5}]});
 assert.equal(task.subtasks[0].points,5);assert.equal(taskSeriesState(d,task.id).definition.data.subtasks[0].task.points,scope==='future'?5:2);noAwards();
 const done=await call('PATCH','/tasks/'+task.id+'/status',{status:'done',complete_remaining:true});assert.equal(done.status,200,JSON.stringify(done));
 const next=d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(task.id);assert.ok(next);const loaded=await call('GET','/tasks/'+next.id);assert.equal(loaded.data.subtasks[0].points,scope==='future'?5:2);
});
test('historical future points edits preserve completed occurrence and prior awards',async()=>{
 let task=await create({assigned_to:[1],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Step',points:2}]});
 assert.equal((await call('PATCH','/tasks/'+task.id+'/status',{status:'done',complete_remaining:true})).status,200);
 const awards=JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all());const state=taskSeriesState(d,task.id);
 const result=await call('PUT','/tasks/'+task.id,{edit_scope:'future',expected_series_revision:state.revision,subtasks:[{id:task.subtasks[0].id,title:'Step',points:6}]});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.series_edit.current_preserved,true);
 assert.equal(row(task.subtasks[0].id).points,2);assert.equal(taskSeriesState(d,task.id).definition.data.subtasks[0].task.points,6);assert.equal(JSON.stringify(d.prepare('SELECT * FROM reward_ledger').all()),awards);
 const next=d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(task.id);assert.equal((await call('GET','/tasks/'+next.id)).data.subtasks[0].points,6);
});

test('editing settled leaf points rejects without changing progress or prior awards',async()=>{
 d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(1,1)').run();
 let task=await create({assigned_to:[1],subtasks:[{title:'Earned',points:3},{title:'Remaining',points:0}]});const leaf=task.subtasks[0].id;
 await edit({id:leaf},{assigned_to:[1]});
 assert.equal((await call('PATCH','/tasks/'+leaf+'/status',{status:'done'})).status,200);
 const before=JSON.stringify({ledger:d.prepare('SELECT * FROM reward_ledger').all(),awards:d.prepare('SELECT * FROM reward_task_awards').all(),completions:d.prepare('SELECT * FROM task_completions').all()});
 assert.ok(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n>0);
 const rejected=await call('PUT','/tasks/'+task.id,{subtasks:[{id:leaf,title:'Earned',points:9},{id:task.subtasks[1].id,title:'Remaining',points:0}]});
 assert.equal(rejected.status,409);assert.equal(rejected.reason,'settled_rewards');
 assert.equal(row(leaf).status,'done');assert.equal(row(leaf).points,3);
 assert.equal(JSON.stringify({ledger:d.prepare('SELECT * FROM reward_ledger').all(),awards:d.prepare('SELECT * FROM reward_task_awards').all(),completions:d.prepare('SELECT * FROM task_completions').all()}),before);
});
