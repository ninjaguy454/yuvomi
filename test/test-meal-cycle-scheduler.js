import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ensure,review,saveCycleSettings,main,decision,submitAll,cycles} from './meal-cycle-finalization-fixture.js';
import * as finalization from '../server/services/meal-cycle-finalization.js';
const api=await import('../server/services/meal-cycle-scheduler.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
test('scheduler starts with an immediate sweep and exposes an idempotent stop',()=>{
  const d=fixture();let reads=0;const getDatabase=()=>{reads++;return d;};
  const stop=api.startMealCycleScheduler({getDatabase,now:()=>new Date('2034-03-03T07:59:59Z')});
  assert.equal(reads,1);assert.equal(api.startMealCycleScheduler({getDatabase}),stop);stop();stop();d.close();
});
test('scheduler generates at exact household instant and deduplicates blocked follow-up',()=>{
  assert.equal(typeof api.runMealCycleScheduler,'function');const d=fixture({finalization_mode:'automatic'});
  api.runMealCycleScheduler(d,{now:'2034-03-03T07:59:59Z'});assert.equal(d.prepare('SELECT count(*) n FROM meal_cycles').get().n,0);
  api.runMealCycleScheduler(d,{now:'2034-03-03T08:00:00Z'});assert.equal(d.prepare('SELECT count(*) n FROM meal_cycles').get().n,1);
  api.runMealCycleScheduler(d,{now:'2034-03-04T19:00:00Z'});api.runMealCycleScheduler(d,{now:'2034-03-04T19:01:00Z'});
  assert.equal(d.prepare('SELECT attempt_status FROM meal_cycles').get().attempt_status,'blocked');
  assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_task_links WHERE purpose='automatic_followup'").get().n,1);d.close();
});

function answer(d,id) {
  main(d,id);for(const p of [1,2,3])decision(d,id,p);submitAll(d,id);
  finalization.acknowledgeCycleGaps(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'ack',mealIds:review(d,id).occurrences.map(x=>x.id)});
}
test('missed confirmation before first meal catches up; corrected inputs retry without duplicate follow-up',()=>{
  const d=fixture({finalization_mode:'automatic'});api.runMealCycleScheduler(d,{now:'2034-03-04T20:00:00Z'});
  const id=d.prepare('SELECT id FROM meal_cycles').get().id;assert.equal(review(d,id).cycle.attempt_status,'blocked');answer(d,id);
  const result=api.runMealCycleScheduler(d,{now:'2034-03-05T12:00:00Z'});assert.equal(result.finalized.length,1);
  api.runMealCycleScheduler(d,{now:'2034-03-05T12:01:00Z'});
  assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_results WHERE kind='finalization'").get().n,1);
  assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_task_links WHERE purpose='automatic_followup'").get().n,1);d.close();
});
test('missed first governed meal blocks automatic catchup even when answers were ready',()=>{
  const d=fixture({finalization_mode:'automatic'}),id=ensure(d).cycle_id;answer(d,id);
  api.runMealCycleScheduler(d,{now:'2034-03-06T18:00:00Z'});const cycle=review(d,id).cycle;
  assert.equal(cycle.state,'open');assert.equal(cycle.attempt_status,'review_required');assert.ok(JSON.parse(cycle.blockers_json).some(x=>x.code==='MANUAL_REVIEW_REQUIRED'));d.close();
});
test('revoked Task create cannot be bypassed for scheduler blocked follow-up',()=>{
  const d=fixture({finalization_mode:'automatic'}),id=ensure(d).cycle_id;
  d.exec("UPDATE users SET role='member' WHERE id=1; INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','1','tasks.create','none')");
  api.runMealCycleScheduler(d,{now:'2034-03-04T19:00:00Z'});assert.equal(review(d,id).cycle.attempt_status,'blocked');
  assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_task_links WHERE purpose='automatic_followup'").get().n,0);d.close();
});
test('scheduler rechecks pause and explicit reschedule instead of stale selected candidates',()=>{
  const d=fixture({finalization_mode:'automatic'}),id=ensure(d).cycle_id;answer(d,id);const revision=review(d,id).revision;
  finalization.rescheduleCycle(d,id,{actorId:1,expectedRevision:revision,requestKey:'move',schedule:{confirmation:{day_offset:-1,time:'09:00'}},now:'2034-03-04T18:00:00Z',confirmDueNow:true});
  api.runMealCycleScheduler(d,{now:'2034-03-04T19:00:00Z'});assert.equal(review(d,id).cycle.state,'open');
  saveCycleSettings(d,{enabled:false},{actorId:1,expectedRevision:1,requestKey:'pause-again'});
  finalization.withAutomaticCycleInvocation(d,()=>assert.throws(()=>finalization.finalizeCycle(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'stale-worker',trigger:'automatic',now:'2034-03-05T10:00:00Z'}),/paused|due/));
  const result=finalization.finalizeCycle(d,id,{actorId:1,expectedRevision:review(d,id).revision,requestKey:'manual-paused',now:'2034-03-04T19:00:00Z'});assert.equal(result.cycle_id,id);d.close();
});
test('invalid per-period timing persists deduplicated visible generation error before cycle exists',()=>{
  const d=fixture({finalization_mode:'automatic'});const s=JSON.parse(d.prepare('SELECT settings_json FROM meal_cycle_settings').get().settings_json);
  s.confirmation={day_offset:-3,time:'19:00'};d.prepare('UPDATE meal_cycle_settings SET settings_json=?').run(JSON.stringify(s));
  api.runMealCycleScheduler(d,{now:'2034-03-03T08:00:00Z'});api.runMealCycleScheduler(d,{now:'2034-03-03T08:01:00Z'});
  const errors=api.listMealCycleGenerationFailures(d);assert.equal(errors.length,1);assert.equal(errors[0].code,'CYCLE_TIMING_ORDER');assert.equal(d.prepare('SELECT count(*) n FROM meal_cycles').get().n,0);
  const before=d.prepare('SELECT total_changes() n').get().n;api.listMealCycleGenerationFailures(d);assert.equal(d.prepare('SELECT total_changes() n').get().n,before);d.close();
});
test('a newly adopted already-begun meal never auto-confirms or creates historical chores',()=>{
  const d=fixture({finalization_mode:'automatic'});api.runMealCycleScheduler(d,{now:'2034-03-06T18:00:00Z'});
  const c=d.prepare('SELECT * FROM meal_cycles').get();assert.equal(c.state,'open');assert.equal(c.attempt_status,'review_required');
  assert.equal(d.prepare('SELECT count(*) n FROM meal_execution_tasks').get().n,0);assert.equal(d.prepare('SELECT count(*) n FROM meal_grocery_runs').get().n,0);d.close();
});
test('settings pause and future timing changes preserve existing cycle snapshot',()=>{
  const d=fixture({finalization_mode:'automatic'}),id=ensure(d).cycle_id,before=review(d,id).cycle;
  saveCycleSettings(d,{enabled:false},{actorId:1,expectedRevision:1,requestKey:'pause'});
  assert.equal(typeof api.runMealCycleScheduler,'function');api.runMealCycleScheduler(d,{now:'2034-03-04T19:00:00Z'});
  const after=review(d,id).cycle;assert.equal(after.state,'open');assert.equal(after.confirmation_at,before.confirmation_at);d.close();
});
