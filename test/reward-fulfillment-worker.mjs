import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-prize-worker';
const {createParentPrizeRedemption,undoPrizeRedemption,decideParentPrizeRedemption}=await import('../server/services/reward-fulfillment.js');
const d=new Database(workerData.path);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');
parentPort.postMessage({ready:true});
Atomics.wait(new Int32Array(workerData.gate),0,0);
try {
  const operation={purchase:createParentPrizeRedemption,undo:undoPrizeRedemption,decision:decideParentPrizeRedemption}[workerData.kind];
  parentPort.postMessage({result:operation(d,workerData.args)});
}catch(error){parentPort.postMessage({error:error.message,status:error.status});}
finally{d.close();}
