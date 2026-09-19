import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import {saveRotationGroup,resolveRotation} from '../../server/services/rotation.js';
const {path,gate,actorId,job}=workerData,d=new Database(path,{timeout:15000});
d.pragma('foreign_keys=ON');parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(gate),0,0);
try {
  const value=job.type==='group'
    ?saveRotationGroup(d,{member_ids:job.members},{id:job.groupId,expectedRevision:job.revision,actorId})
    :resolveRotation(d,job.trackId,job.key,{actorId});
  parentPort.postMessage({ok:true,value});
} catch(error) {parentPort.postMessage({ok:false,message:error.message,status:error.status});}
finally {d.close();}
