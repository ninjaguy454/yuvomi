import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {_setTestDatabase}=await import('../../server/db.js');
const {acceptTask}=await import('../../server/services/task-acceptance.js');
const d=new Database(process.env.ACCEPTANCE_FIXTURE);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');_setTestDatabase(d);
process.on('message',message=>{
  try{process.send({result:acceptTask(d,message.actor,message.id,message.body)});}
  catch(error){process.send({error:{status:error.status,message:error.message,code:error.code}});}
});
process.send({ready:true});
