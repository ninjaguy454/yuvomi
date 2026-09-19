import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const S=await import('../../server/services/rotation-shared.js');
const R=await import('../../server/services/rotation.js');
const {path,gate,job}=workerData,d=new Database(path,{timeout:15000});d.pragma('foreign_keys=ON');
let changeTaskStatus;
if(job.type==='task') {
  const {_setTestDatabase}=await import('../../server/db.js');_setTestDatabase(d);
  ({changeTaskStatus}=await import('../../server/services/task-lifecycle.js'));
}
parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(gate),0,0);
try {
  const options={...job.options,now:new Date(job.options.now)};
  let value;
  if(job.type==='resolve')value=S.resolveSharedRotation(d,job.groupId,options);
  if(job.type==='reconcile')value=S.reconcileSharedRotationPeriods(d,{...options,groupId:job.groupId});
  if(job.type==='skip')value=R.skipRotation(d,job.occurrenceId,{actorId:1,expectedRevision:job.revision,sharedSchedule:true});
  if(job.type==='override')value=R.overrideRotation(d,job.occurrenceId,{actorId:1,expected_revision:job.revision,member_ids:[4,2,3]});
  if(job.type==='correct')value=R.correctRotationTrack(d,job.trackId,{actorId:1,expected_revision:job.revision,next_member_id:4});
  if(job.type==='task')value=changeTaskStatus(d,job.taskId,'done',{actorId:1,body:{expected_revision:job.revision}});
  parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,status:error.status,code:error.code,message:error.message});}finally{d.close();}
