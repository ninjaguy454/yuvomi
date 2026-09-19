import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='rotation-consumer-race';
const {path,gate,job}=workerData,d=new Database(path,{timeout:15000});d.pragma('foreign_keys=ON');
const {_setTestDatabase}=await import('../../server/db.js');_setTestDatabase(d);
const {instantiateWorkflow}=await import('../../server/services/activity-workflows.js');
const {changeTaskStatus}=await import('../../server/services/task-lifecycle.js');
const {finalizeRotation}=await import('../../server/services/rotation.js');
const {executeWorkflowRotationOperation}=await import('../../server/services/workflow-rotation-operations.js');
parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(gate),0,0);
try {
  let value;
  if(job.type==='workflow')value=instantiateWorkflow(d,job.workflowId,{createdBy:job.actorId,startDate:'2026-09-19',requestKey:job.requestKey});
  if(job.type==='task')value=changeTaskStatus(d,job.taskId,'done',{actorId:job.actorId,body:{expected_revision:job.expectedRevision}});
  if(job.type==='finalize')value=finalizeRotation(d,job.occurrenceId,{actorId:job.actorId,expectedRevision:job.expectedRevision,outcome:'completed'});
  if(job.type==='workflow_operation')value=executeWorkflowRotationOperation(d,job.instanceId,job.purpose,'finalize',{
    actor:job.actorId,actorId:job.actorId,expectedTaskRevision:job.expectedTaskRevision,expectedOccurrenceRevision:job.expectedOccurrenceRevision});
  parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,status:error.status,code:error.code,message:error.message});}
finally{_setTestDatabase(null);d.close();}
