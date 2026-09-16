import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import { awardForCompletion, createRedemption, decideRedemption } from '../server/services/rewards.js';
const d=new Database(workerData.path);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');
const gate=new Int32Array(workerData.gate);
parentPort.postMessage({ready:true});
Atomics.wait(gate,0,0);
try {
  const result=workerData.kind==='award'?awardForCompletion(d,...workerData.args)
    :workerData.kind==='decision'?decideRedemption(d,workerData.args):createRedemption(d,workerData.args);
  parentPort.postMessage({result});
} catch(error) { parentPort.postMessage({error:error.message,status:error.status}); }
finally {d.close();}
