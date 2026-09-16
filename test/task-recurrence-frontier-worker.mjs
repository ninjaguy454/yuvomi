import {workerData,parentPort} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.TZ='UTC';process.env.SESSION_SECRET='recurrence-frontier-worker';
const {_setTestDatabase}=await import('../server/db.js');
const {reconcileTaskRecurrence}=await import('../server/routes/tasks.js');
const d=new Database(workerData.path);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=15000');_setTestDatabase(d);
try {
  const result=workerData.mode==='delete'?d.transaction(()=>d.prepare('DELETE FROM tasks WHERE id=139').run()).immediate():reconcileTaskRecurrence(81);
  parentPort.postMessage(result);
} finally {_setTestDatabase(null);d.close();}
