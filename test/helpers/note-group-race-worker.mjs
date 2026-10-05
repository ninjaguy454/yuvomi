import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import * as service from '../../server/services/note-groups.js';
const d=new Database(workerData.file);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');
parentPort.postMessage({ready:true});
parentPort.once('message',()=>{
  try{parentPort.postMessage({status:200,value:service.applyNoteGroupCommand(d,1,workerData.command)});}
  catch(error){parentPort.postMessage({status:error.status||500,error:error.message});}
  finally{d.close();}
});
