/** Durable deadline reconciliation; no browser or read route participates. */
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { expireTask, resumeExpiredTaskRecurrence } from './task-lifecycle.js';
import { taskExpirationDue } from './task-window.js';
import { todayKey } from '../utils/timezone.js';

const log=createLogger('TaskExpiration');
let stop=null;

export function reconcileTaskExpirations(d,{now=new Date(),maxOccurrences=500,onError=(error,id)=>log.error(`Task ${id}:`,error.message)}={}) {
  const result={expired:0,failed:0,limited:false};
  const attempted=new Set();
  // Recover a crash/eligibility failure between terminalization and creating the
  // next occurrence. Only latest durable frontiers can advance, including a
  // manually archived expiration; archive does not silently stop its series.
  // Scan every frontier: ended rules are harmless no-ops and must not consume
  // a retry limit that would permanently starve a later recoverable series.
  const pending=d.prepare(`SELECT t.id FROM tasks t JOIN task_recurrence_occurrences o ON o.task_id=t.id
    WHERE t.status='expired' AND o.state='materialized'
      AND NOT EXISTS(SELECT 1 FROM task_recurrence_occurrences later WHERE later.series_id=o.series_id
        AND later.state='materialized' AND later.generation>o.generation)`).all();
  for(const {id} of pending)try {resumeExpiredTaskRecurrence(d,id);}
    catch(error){result.failed++;onError(error,id);}
  // A restart may cover several missed dates. Walk the anchored frontier in
  // bounded batches, retaining each occurrence rather than shifting the series.
  while(result.expired<maxOccurrences) {
    const candidates=d.prepare(`SELECT * FROM tasks WHERE expiration_policy='expire_incomplete'
      AND status IN ('open','in_progress') AND archived_at IS NULL AND due_date<=?
      ORDER BY due_date,due_time,id`).all(todayKey(d,now))
      .filter(task=>!attempted.has(task.id)&&taskExpirationDue(d,task,now));
    if(!candidates.length)return result;
    for(const task of candidates) {
      if(result.expired>=maxOccurrences){result.limited=true;return result;}
      attempted.add(task.id);
      try {
        const transition=expireTask(d,task.id,{now});
        if(transition.expired)result.expired++;
        if(transition.recurrenceError){result.failed++;onError(transition.recurrenceError,task.id);}
      }
      catch(error){result.failed++;onError(error,task.id);}
    }
  }
  result.limited=true;return result;
}

export function startTaskExpiration({getDatabase=()=>db.get(),now=()=>new Date(),pollMs=5000}={}) {
  if(stop)return stop;
  const tick=()=>{try{return reconcileTaskExpirations(getDatabase(),{now:now()});}
    catch(error){log.error('Expiration reconciliation failed:',error.message);}};
  const timer=setInterval(tick,pollMs);timer.unref?.();
  tick();
  stop=()=>{clearInterval(timer);stop=null;};
  return stop;
}
