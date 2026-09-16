import {mock} from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
const config=JSON.parse(process.argv[2]);
process.env.DB_PATH=':memory:';
process.env.LOG_LEVEL='error';
process.env.TZ='UTC';
process.env.SESSION_SECRET='task-expiration-race-worker';
mock.timers.enable({apis:['Date'],now:new Date(config.now)});
const {_setTestDatabase}=await import('../server/db.js');
const {reconcileTaskRecurrence}=await import('../server/routes/tasks.js');
const {expireTask,changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');
const d=new Database(config.path);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=15000');
_setTestDatabase(d);
process.once('message',()=>{
  let outcome;
  try {
    const now=new Date(config.now);
    const value=config.mode==='complete'
      ? changeTaskStatus(d,config.taskId,'done',{actorId:config.actorId,authorize:false,requireRevision:false,now,body:{complete_remaining:true}})
      : config.mode==='expire'
        ? expireTask(d,config.taskId,{now})
        : config.mode==='sweep'
          ? reconcileTaskExpirations(d,{now,onError:error=>{throw error;}})
          : reconcileTaskRecurrence(config.taskId);
    outcome={ok:true,value};
  } catch(error) {
    outcome={ok:false,error:{message:error.message,status:error.status,details:error.details}};
  } finally {
    _setTestDatabase(null);d.close();mock.timers.reset();
  }
  process.send({type:'result',outcome},()=>process.disconnect());
});
process.send({type:'ready'});
