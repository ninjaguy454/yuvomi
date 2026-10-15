import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {_setTestDatabase}=await import('../../server/db.js');
await import('../../server/routes/tasks.js');
const {changeTaskStatus}=await import('../../server/services/task-lifecycle.js');
const d=new Database(process.env.SUBTASK_REWARD_FIXTURE);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');_setTestDatabase(d);
process.on('message',message=>{
  try{const result=changeTaskStatus(d,message.id,message.status,{actorId:1,body:message.body});process.send({status:200,task_status:result.task.status});}
  catch(error){process.send({status:error.status||500,message:error.message});}
});
process.send({ready:true});
