import Database from 'better-sqlite3-multiple-ciphers';
import {performance} from 'node:perf_hooks';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='rotation-local-query-probe';
const {ALL_MIGRATIONS}=await import('../../server/db.js');
const R=await import('../../server/services/rotation.js');
const T=await import('../../server/services/task-rotation.js');
const {instantiateWorkflow}=await import('../../server/services/activity-workflows.js');
export function rotationQueryProbe() {
 let recording=false,queries=[];
 const d=new Database(':memory:',{verbose(sql){if(recording&&/^\s*SELECT\b/i.test(sql))queries.push(sql);}});
 try {
  for(const migration of ALL_MIGRATIONS){if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
  const users=['Parent','Grace','Eleanor','Frankie'].map((name,index)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'test',?,?)").run(name,name,index?'member':'admin',index?'child':'parent').lastInsertRowid));
  const group=R.saveRotationGroup(d,{name:'Probe members',member_ids:users.slice(1)},{actorId:users[0]});
  const track=key=>R.configureRotationTrack(d,{consumer_type:'probe',consumer_id:key,purpose_key:'order',group_id:group.id,strategy:'rotating_order'},{actorId:users[0]});
  function measure(name,fn) {
   queries=[];recording=true;const start=performance.now();const result=fn();const elapsedMs=performance.now()-start;recording=false;
   return {name,elapsedMs,selects:queries.length,groupReads:queries.filter(sql=>sql.includes('SELECT * FROM rotation_groups')).length,
    membershipReads:queries.filter(sql=>sql.includes('FROM rotation_group_members m')).length,householdScans:queries.filter(sql=>sql.includes('LEFT JOIN birthdays b')).length,
    parentTaskReads:queries.filter(sql=>/^SELECT \* FROM tasks WHERE id=/i.test(sql)).length,result};
  }
  const resolution=track('Resolution'),resolved=measure('resolve one 3-member Track',()=>R.resolveRotation(d,resolution.id,'night-0',{actorId:users[0]}));
  R.finalizeRotation(d,resolved.result.id,{actorId:users[0],expectedRevision:1});
  const measures=[resolved];const duration=[];
  for(let n=1;n<=110;n++) {
   const sample=measure('warm resolve',()=>R.resolveRotation(d,resolution.id,`night-${n}`,{actorId:users[0]}));
   if(n>10)duration.push(sample.elapsedMs);
   R.finalizeRotation(d,sample.result.id,{actorId:users[0],expectedRevision:1});
  }
  measures.push(measure('history 100 occurrences',()=>R.rotationHistory(d,resolution.id)));
  measures.push(measure('inspect next and three previews',()=>R.inspectRotationTrack(d,resolution.id)));
  const independent=[track('Independent1'),track('Independent2'),track('Independent3')];
  measures.push(measure('resolve 3 independent Tracks within one transaction',()=>d.transaction(()=>independent.map(t=>R.resolveRotation(d,t.id,'night',{actorId:users[0]})))()));
  const binding=JSON.stringify([{purpose_key:'order',group_id:group.id,strategy:'rotating_order'}]);
  const owner=Number(d.prepare("INSERT INTO tasks(title,created_by,rotation_bindings_json) VALUES('Parent',?,?)").run(users[0],binding).lastInsertRowid);
  T.bindTaskRotations(d,owner,{actorId:users[0]});
  const parent=d.prepare('SELECT * FROM tasks WHERE id=?').get(owner);
  const children=Array.from({length:30},(_,index)=>{
   const id=Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,assigned_to) VALUES('Child',?,?,?)").run(users[0],owner,users[index%3+1]).lastInsertRowid);
   return d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  });
  for(const count of [3,30])measures.push(measure(`context projection ${count} children`,()=>{const cache=new Map();T.taskRotationContexts(d,parent,null,cache);return children.slice(0,count).map(child=>T.taskRotationContexts(d,child,null,cache));}));
  const activity=Number(d.prepare("INSERT INTO activity_templates(name,title_template,subject_required,assignment_strategy,assignment_policy,category) VALUES('Bedtime','Bedtime {{order.position}}',0,'fixed','fixed','misc')").run().lastInsertRowid);
  const workflow=Number(d.prepare("INSERT INTO workflow_templates(name,subject_required,rotation_bindings_json) VALUES('Shared bedtime',0,?)").run(binding).lastInsertRowid);
  users.slice(1).forEach((user,index)=>d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order,assignment_policy_override,assignment_user_id) VALUES(?,?,?,?,?,?)").run(workflow,activity,`child_${index}`,index,'fixed',user));
  const materialization=[];let materializationSelects;
  for(let n=0;n<55;n++) {
   const sample=measure('shared Workflow materialization',()=>instantiateWorkflow(d,workflow,{createdBy:users[0],startDate:'2026-09-19',requestKey:`probe_workflow_${n}`}));
   if(n>=5)materialization.push(sample.elapsedMs);materializationSelects=sample.selects;
   const occurrence=sample.result.rotations[0].occurrence;R.finalizeRotation(d,occurrence.id,{actorId:users[0],expectedRevision:occurrence.revision});
  }
  duration.sort((a,b)=>a-b);materialization.sort((a,b)=>a-b);
  return {environment:'local in-memory SQLite; synthetic 3-member household; resolution 10 warmups/100 measured; shared Workflow materialization 5 warmups/50 measured; no production/network/device claims',
   measurements:measures.map(({result,...sample})=>sample),resolutionLatency:{samples:duration.length,medianMs:duration[49],p95Ms:duration[94]},
   materializationLatency:{samples:materialization.length,medianMs:materialization[24],p95Ms:materialization[47],lastSelects:materializationSelects}};
 } finally {d.close();}
}
