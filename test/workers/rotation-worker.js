import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import * as R from '../../server/services/rotation.js';
const {path,gate,job}=workerData,d=new Database(path,{timeout:15000});d.pragma('foreign_keys=ON');
parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(gate),0,0);
try{
  let value;
  if(job.type==='resolve')value=R.resolveRotation(d,job.trackId,job.key,{actorId:job.actorId});
  if(job.type==='finalize')value=R.finalizeRotation(d,job.occurrenceId,{actorId:job.actorId,expectedRevision:job.expectedRevision});
  if(job.type==='override')value=R.overrideRotation(d,job.occurrenceId,{actorId:job.actorId,expected_revision:job.expectedRevision,member_ids:job.memberIds});
  if(job.type==='correct')value=R.correctRotationTrack(d,job.trackId,{actorId:job.actorId,expected_revision:job.expectedRevision,next_member_id:job.nextMember});
  parentPort.postMessage({ok:true,value});
}catch(error){parentPort.postMessage({ok:false,status:error.status,code:error.code,message:error.message});}finally{d.close();}
