import {workerData,parentPort} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='isolated-device-approval-tests';
const {_setTestDatabase}=await import('../../server/db.js');
await import('../../server/routes/tasks.js');
const {completeDeviceApproval,cancelDeviceApproval}=await import('../../server/services/device-approval.js');
const d=new Database(workerData.filename);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');_setTestDatabase(d);
const state=new Int32Array(workerData.control);Atomics.add(state,0,1);Atomics.wait(state,1,0);
try{parentPort.postMessage({ok:true,receipt:workerData.operation==='cancel'?cancelDeviceApproval(d,workerData.req):completeDeviceApproval(d,workerData.req,{id:1})});}
catch(error){parentPort.postMessage({ok:false,error:error.message,stack:error.stack});}
finally{_setTestDatabase(null);d.close();}
