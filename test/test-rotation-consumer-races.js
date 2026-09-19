import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {saveRotationGroup,getRotationTrack}=await import('../server/services/rotation.js');
const {bindTaskRotations,taskRotationContexts}=await import('../server/services/task-rotation.js');
function fixture(path){
  const d=new Database(path);d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d)})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'learner','Learner','x','member'); INSERT INTO reward_participants(user_id,enabled) VALUES(2,1)");
  const group=saveRotationGroup(d,{name:'Members',member_ids:[2,1]},{actorId:1});
  const binding={purpose_key:'order',label:'Order',group_id:group.id,strategy:'rotating_order',advance_policy:'on_completed'};
  d.pragma('journal_mode=WAL');return {d,binding};
}
async function race(path,jobs){
  const gate=new SharedArrayBuffer(4),lock=new Int32Array(gate);let ready=0;
  return Promise.all(jobs.map(job=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./workers/rotation-consumer-worker.js',import.meta.url),{workerData:{path,gate,job}});
    worker.on('message',result=>{if(result.ready){if(++ready===jobs.length){Atomics.store(lock,0,1);Atomics.notify(lock,0)}}else resolve(result)});
    worker.on('error',reject);worker.on('exit',code=>{if(code)reject(new Error(`worker exit ${code}`))});
  })));
}
test('four genuinely concurrent Workflow retries create one atomic instance and reuse its occurrence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rotation-workflow-race-')),path=join(dir,'test.db'),{d,binding}=fixture(path);
  try {
    d.exec("INSERT INTO activity_templates(id,name,title_template,subject_required,assignment_strategy,assignment_policy,fixed_user_id) VALUES(1,'Bedtime','Bedtime',0,'fixed','fixed',2)");
    d.prepare("INSERT INTO workflow_templates(id,name,subject_required,rotation_bindings_json) VALUES(1,'Shared night',0,?)").run(JSON.stringify([binding]));
    d.exec("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order) VALUES(1,1,'child',0)");
    const results=await race(path,Array.from({length:4},()=>({type:'workflow',workflowId:1,actorId:1,requestKey:'concurrent_night'})));
    assert.ok(results.every(result=>result.ok),JSON.stringify(results));assert.equal(new Set(results.map(result=>result.value.id)).size,1);
    for(const table of ['workflow_instances','rotation_workflow_requests','rotation_occurrences'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,1,table);
    assert.equal(d.prepare('SELECT count(*) n FROM tasks').get().n,2);
    assert.equal(d.prepare('SELECT advance_count FROM rotation_tracks').get().advance_count,0);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
test('four concurrent retries of an authored Workflow finalize operation advance once without changing Task lifecycle or rewards',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rotation-workflow-operation-race-')),path=join(dir,'test.db'),{d,binding}=fixture(path);
  try {
    const authored={...binding,advance_policy:'on_finalized',workflow_operations:['resolve','finalize','skip']};
    d.exec("INSERT INTO activity_templates(id,name,title_template,subject_required,assignment_strategy,assignment_policy,fixed_user_id,points) VALUES(1,'Bedtime','Bedtime',0,'fixed','fixed',2,2)");
    d.prepare("INSERT INTO workflow_templates(id,name,subject_required,rotation_bindings_json) VALUES(1,'Shared night',0,?)").run(JSON.stringify([authored]));
    d.exec("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order) VALUES(1,1,'child',0)");
    const [created]=await race(path,[{type:'workflow',workflowId:1,actorId:1,requestKey:'authored_operation_night'}]);
    assert.equal(created.ok,true,JSON.stringify(created));
    const instance=created.value,owner=d.prepare('SELECT * FROM tasks WHERE id=?').get(instance.parent_task_id);
    const occurrence=taskRotationContexts(d,owner)[0].occurrence;
    const preservedTables=['tasks','task_assignments','task_completions','reward_ledger','task_activity_events','task_rotation_occurrences'];
    const snapshot=()=>Object.fromEntries(preservedTables.map(table=>[table,d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before=snapshot();
    const results=await race(path,Array.from({length:4},()=>({type:'workflow_operation',instanceId:instance.id,purpose:'order',actorId:1,
      expectedTaskRevision:owner.revision,expectedOccurrenceRevision:occurrence.revision})));
    assert.ok(results.every(result=>result.ok),JSON.stringify(results));
    for(const result of results){assert.equal(result.value[0].occurrence.id,occurrence.id);assert.equal(result.value[0].occurrence.status,'finalized');assert.equal(result.value[0].occurrence.advanced,1);}
    assert.equal(getRotationTrack(d,occurrence.track_id).advance_count,1);
    const events=d.prepare("SELECT * FROM rotation_events WHERE occurrence_id=? AND event_type='finalized'").all(occurrence.id);
    assert.equal(events.length,1);assert.equal(events[0].actor_user_id,1);assert.ok(Number.isFinite(Date.parse(events[0].created_at)));
    for(const table of ['workflow_instances','rotation_workflow_requests','rotation_occurrences'])assert.equal(d.prepare(`SELECT count(*) n FROM ${table}`).get().n,1,table);
    assert.deepEqual(snapshot(),before,'Rotation finalization must preserve all Task lifecycle, progress, history, reward and binding rows');
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
test('actual authorized Task completion races canonical finalization without duplicate rewards, history or advancement',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rotation-task-race-')),path=join(dir,'test.db'),{d,binding}=fixture(path);
  try {
    d.prepare("INSERT INTO tasks(id,title,created_by,assigned_to,points,rotation_bindings_json) VALUES(1,'Routine',1,2,2,?)").run(JSON.stringify([binding]));
    d.exec('INSERT INTO task_assignments(task_id,user_id) VALUES(1,2)');bindTaskRotations(d,1,{actorId:1});
    const occurrence=taskRotationContexts(d,1)[0].occurrence,revision=d.prepare('SELECT revision FROM tasks WHERE id=1').get().revision;
    const results=await race(path,[{type:'task',taskId:1,actorId:1,expectedRevision:revision},{type:'finalize',occurrenceId:occurrence.id,actorId:1,expectedRevision:occurrence.revision}]);
    assert.ok(results.every(result=>result.ok),JSON.stringify(results));assert.equal(d.prepare('SELECT status FROM tasks WHERE id=1').get().status,'done');
    assert.equal(getRotationTrack(d,occurrence.track_id).advance_count,1);
    assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE occurrence_id=? AND event_type='completed'").get(occurrence.id).n,1);
    assert.equal(d.prepare("SELECT count(*) n FROM task_activity_events WHERE action_task_id=1 AND event_type='completed'").get().n,1);
    assert.equal(d.prepare("SELECT count(*) n FROM reward_ledger WHERE task_id=1 AND type='earn'").get().n,1);
    const stale=await race(path,[{type:'task',taskId:1,actorId:1,expectedRevision:revision}]);assert.equal(stale[0].status,409);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d.close();rmSync(dir,{recursive:true,force:true});}
});
