import * as db from '../db.js';
import {createLogger} from '../logger.js';
import {getCycleSettings} from './meal-cycle-settings.js';
import {dueCyclePeriods} from './meal-cycle-schedule.js';
import {ensureCycle,createCyclePlanningTask,registerMealCycleTaskLifecycle} from './meal-cycles.js';
import {finalizeCycle,withAutomaticCycleInvocation,authorizeCycleCoordinator} from './meal-cycle-finalization.js';
import {drainCycleReconciliation} from './meal-cycle-reconciliation.js';
const log=createLogger('MealCycles');

/** Read-only setup/generation errors, including errors before a cycle can exist. */
export function listMealCycleGenerationFailures(d) {
  return d.prepare('SELECT * FROM meal_cycle_generation_failures ORDER BY last_attempt_at DESC LIMIT 100').all();
}
function generationFailure(d,settings,period,error,now) {
  d.transaction(()=>{
    d.prepare('INSERT INTO meal_cycle_generation_failures(settings_revision,period_start,code,message,last_attempt_at) VALUES(?,?,?,?,?) ON CONFLICT(settings_revision,period_start) DO UPDATE SET code=excluded.code,message=excluded.message,last_attempt_at=excluded.last_attempt_at').run(settings.revision,period||settings.first_period_start||'setup',error.code||'CYCLE_GENERATION_FAILED',error.message,now);
    d.exec('DELETE FROM meal_cycle_generation_failures WHERE rowid NOT IN (SELECT rowid FROM meal_cycle_generation_failures ORDER BY last_attempt_at DESC,rowid DESC LIMIT 100)');
  }).immediate();
}
function blocked(d,c,error,now) {
  d.transaction(()=>{
    const current=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(c.id);
    // An older failed attempt cannot replace a concurrent success or newer edit.
    if(current.state!=='open'||current.revision!==c.revision)return;
    const blockers=error.blockers||[{code:error.code||'CYCLE_FINALIZATION_FAILED',message:error.message}];
    d.prepare('UPDATE meal_cycles SET attempt_status=?,last_attempt_at=?,attempt_fingerprint=?,blockers_json=? WHERE id=?').run(blockers.some(x=>x.code==='MANUAL_REVIEW_REQUIRED')?'review_required':'blocked',now,c.source_fingerprint,JSON.stringify(blockers),c.id);
    const settings=JSON.parse(c.settings_json);
    try {authorizeCycleCoordinator(d,c,settings.coordinator_id);} catch {return;}
    if(!d.prepare("SELECT 1 FROM meal_cycle_task_links WHERE cycle_id=? AND purpose='automatic_followup'").get(c.id))createCyclePlanningTask(d,c,'automatic_followup',settings.coordinator_id,blockers);
  }).immediate();
}
export function runMealCycleScheduler(d,{now=new Date().toISOString()}={}) {
  now=new Date(now).toISOString();registerMealCycleTaskLifecycle();
  const settings=getCycleSettings(d),result={created:[],finalized:[],blocked:[],generation_errors:[]};
  drainCycleReconciliation(d,{now});
  if(!settings.enabled)return result;
  let periods=[];
  try {periods=dueCyclePeriods(settings,now);} catch(error) {
    generationFailure(d,settings,error.period_start,error,now);result.generation_errors.push(error.code||'CYCLE_GENERATION_FAILED');
  }
  for(const t of periods) {
    if(d.prepare('SELECT 1 FROM meal_cycles WHERE period_start=?').get(t.period.start))continue;
    try {
      const c=ensureCycle(d,{start:t.period.start,actorId:settings.coordinator_id,expectedSettingsRevision:settings.revision,requestKey:`scheduler:${settings.revision}:${t.period.start}`,now});
      result.created.push(c.cycle_id);
      d.prepare('DELETE FROM meal_cycle_generation_failures WHERE settings_revision=? AND period_start=?').run(settings.revision,t.period.start);
    } catch(error) {generationFailure(d,settings,t.period.start,error,now);result.generation_errors.push(error.code||'CYCLE_GENERATION_FAILED');}
  }
  for(const c of d.prepare("SELECT * FROM meal_cycles WHERE state='open' AND finalization_mode='automatic' AND confirmation_at<=? ORDER BY id").all(now)) {
    try {
      const r=withAutomaticCycleInvocation(d,()=>finalizeCycle(d,c.id,{actorId:JSON.parse(c.settings_json).coordinator_id,expectedRevision:c.revision,requestKey:`automatic:${c.revision}`,trigger:'automatic',now}));result.finalized.push(r);
    } catch(error) {blocked(d,c,error,now);result.blocked.push({cycle_id:c.id,code:error.code||'CYCLE_FINALIZATION_FAILED'});}
  }
  return result;
}
let stop=null;
export function startMealCycleScheduler({getDatabase=()=>db.get(),now=()=>new Date()}={}) {
  if(stop)return stop;
  const tick=()=>{try {runMealCycleScheduler(getDatabase(),{now:now()});} catch(error) {log.error('Kitchen cycle sweep failed:',error.message);}};
  const timer=setInterval(tick,60000);timer.unref?.();tick();
  stop=()=>{clearInterval(timer);stop=null;};return stop;
}
