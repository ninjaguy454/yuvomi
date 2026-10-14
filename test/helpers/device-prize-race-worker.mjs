import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
const {createDevicePrizeRedemption}=await import('../../server/services/device-prizes.js');
const d=new Database(workerData.filename,{timeout:10000});d.pragma('foreign_keys=ON');
parentPort.once('message',()=>{
  try{
    const req={headers:{cookie:`vidamia.device=${workerData.token}`,'x-auth-context':workerData.context},sessionID:'synthetic-writer-session',session:{},get(name){return this.headers[name.toLowerCase()];}};
    parentPort.postMessage({ok:true,result:createDevicePrizeRedemption(d,req,workerData.body||{catalog_id:1,user_id:2,expected_cost:10},{requestKey:workerData.key})});
  }catch(error){parentPort.postMessage({ok:false,status:error.status,reason:error.reason,error:error.message});}
  finally{d.close();}
});
parentPort.postMessage({ready:true});
