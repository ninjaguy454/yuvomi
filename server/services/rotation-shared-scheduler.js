import * as db from '../db.js';
import {createLogger} from '../logger.js';
import {reconcileSharedRotationPeriods} from './rotation-shared.js';
const log=createLogger('SharedRotation');
let stop=null;
export function startSharedRotationScheduler({getDatabase=()=>db.get(),now=()=>new Date(),pollMs=5000}={}) {
  if(stop)return stop;
  const tick=()=>{try{return reconcileSharedRotationPeriods(getDatabase(),{now:now(),onError:(error,group)=>log.error(`Group ${group}:`,error.message)});}
    catch(error){log.error('Shared Rotation reconciliation failed:',error.message);}};
  const timer=setInterval(tick,pollMs);timer.unref?.();tick();
  stop=()=>{clearInterval(timer);stop=null;};return stop;
}
