import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import {finalizeCycle,withAutomaticCycleInvocation} from '../server/services/meal-cycle-finalization.js';
import {saveCyclePerson} from '../server/services/meal-cycles.js';
const d=new Database(workerData.path,{timeout:10000}),gate=new Int32Array(workerData.gate);
d.pragma('foreign_keys=ON');
if(workerData.mode==='manual') {
  d.function('hold_cycle_publication',()=>{
    parentPort.postMessage({type:'holding'});
    if(Atomics.wait(gate,0,0,10000)==='timed-out')throw new Error('Race gate timed out');
    return 1;
  });
  d.exec('CREATE TEMP TRIGGER hold_publication AFTER INSERT ON meal_grocery_runs BEGIN SELECT hold_cycle_publication(); END');
}
parentPort.postMessage({type:'ready'});
parentPort.once('message',()=>{
  const start=Date.now();parentPort.postMessage({type:'attempting',mode:workerData.mode});
  try {
    const options={actorId:1,expectedRevision:workerData.revision,requestKey:`race-${workerData.mode}`,now:'2034-03-04T19:00:00.000Z'};
    const result=workerData.mode==='response'
      ?saveCyclePerson(d,workerData.cycleId,{...options,actorId:3,beneficiaryId:3,changes:[{meal_id:workerData.mealId,kind:'decision',decision:{participation:'not_participating'}}]})
      :workerData.mode==='automatic'
        ?withAutomaticCycleInvocation(d,()=>finalizeCycle(d,workerData.cycleId,{...options,trigger:'automatic'}))
        :finalizeCycle(d,workerData.cycleId,options);
    parentPort.postMessage({type:'result',result,elapsed:Date.now()-start});
  } catch(error) {parentPort.postMessage({type:'result',error:error.message,elapsed:Date.now()-start});}
  finally {d.close();parentPort.close();}
});
