import {mock} from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
const config=JSON.parse(process.argv[2]);
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.TZ='UTC';
mock.timers.enable({apis:['Date'],now:new Date(config.now)});
const {_setTestDatabase}=await import('../server/db.js');
await import('../server/routes/tasks.js');
const {skipTaskOccurrence}=await import('../server/services/task-skip.js');
const {expireTask,changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const d=new Database(config.path);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=15000');_setTestDatabase(d);
process.once('message',()=>{
  let outcome;
  try {
    const now=new Date(config.now);
    const value=config.mode==='skip'
      ? skipTaskOccurrence(d,config.taskId,{principal:config.actorId,now,body:{operation_id:'same-concurrent-operation',expected_revision:config.revision}})
      : config.mode==='complete'
        ? changeTaskStatus(d,config.taskId,'done',{actorId:config.actorId,now,requireRevision:false,body:{complete_remaining:true}})
        : expireTask(d,config.taskId,{now});
    outcome={ok:true,value};
  } catch(error){outcome={ok:false,error:{message:error.message,status:error.status,details:error.details}};}
  finally {_setTestDatabase(null);d.close();mock.timers.reset();}
  process.send({type:'result',outcome},()=>process.disconnect());
});
process.send({type:'ready'});
