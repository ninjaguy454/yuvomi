import {workerData,parentPort} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET||='device-worker-tests';
const {_setTestDatabase}=await import('../../server/db.js');
const {deviceTaskCreateOnce}=await import('../../server/services/device-task-definitions.js');
const d=new Database(workerData.path);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');_setTestDatabase(d);
const gate=new Int32Array(workerData.gate);parentPort.postMessage({ready:true});Atomics.wait(gate,0,0);
try {
  const result=deviceTaskCreateOnce(d,workerData.principal,workerData.body,workerData.key);
  parentPort.postMessage({id:result.data.id,replayed:result.replayed});
}catch(error){parentPort.postMessage({error:error.message});}
finally {_setTestDatabase(null);d.close();}
