import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fixture,ensure,review,main,decision,cycles,submitAll,save} from './meal-cycle-finalization-fixture.js';
import {createOrRefreshGroceryRun,finalizeGroceryRun,publishGroceryRun} from '../server/services/meal-grocery-runs.js';
import {ensureMealExecution} from '../server/services/meal-execution.js';
import {createMealPlan,attachMealPlanToContext} from '../server/services/meal-plans.js';
import {savePlanningContext} from '../server/services/planning-contexts.js';
import {taskCapabilities} from '../server/services/task-access.js';
import {withCycleMealWrite} from '../server/services/meal-cycle-guards.js';
const api=await import('../server/services/meal-cycle-finalization.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
const now='2034-03-04T19:00:00.000Z';
function ready(overrides={}) {const d=fixture(overrides),id=ensure(d).cycle_id;main(d,id);for(const p of [1,2,3])decision(d,id,p);submitAll(d,id);return {d,id};}
function options(d,id,key='finalize'){return {actorId:1,expectedRevision:review(d,id,1).revision,requestKey:key,now};}
function acknowledge(d,id){assert.equal(typeof api.acknowledgeCycleGaps,'function');return api.acknowledgeCycleGaps(d,id,{...options(d,id,'ack'),mealIds:review(d,id).occurrences.map(x=>x.id)});}
test('missing choices and ingredient review block; acknowledgment permits immutable idempotent finalization',()=>{
  assert.equal(typeof api.finalizeCycle,'function');const d=fixture(),id=ensure(d).cycle_id;
  assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),/ready|choice|response/i);
  main(d,id);for(const p of [1,2,3])decision(d,id,p);
  assert.ok(api.reviewCycleReadiness(d,id,{actorId:1,now}).blockers.some(x=>x.code==='PERSONAL_SUBMISSION_REQUIRED'));submitAll(d,id);
  assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),/ingredient|ready/i);
  acknowledge(d,id);const o=options(d,id),a=api.finalizeCycle(d,id,o);assert.deepEqual(api.finalizeCycle(d,id,o),a);
  assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_results WHERE kind='finalization'").get().n,1);
  assert.equal(d.prepare("SELECT status FROM tasks WHERE id=(SELECT task_id FROM meal_cycle_task_links WHERE purpose='review')").get().status,'done');
  assert.throws(()=>decision(d,id,3,{},'late'),/confirmed|adjustment/i);d.close();
});
test('readiness is pure and fresh; coordinator authorization and revisions cannot be bypassed',()=>{
  const {d,id}=ready();assert.equal(typeof api.reviewCycleReadiness,'function');const before=d.prepare('SELECT total_changes() n').get().n;
  api.reviewCycleReadiness(d,id,{actorId:1,now});assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.throws(()=>api.finalizeCycle(d,id,{...options(d,id),actorId:3,trigger:'automatic'}),/permission|coordinator|trigger/i);
  const old=options(d,id);acknowledge(d,id);assert.throws(()=>api.finalizeCycle(d,id,old),/revision/i);
  d.exec("UPDATE meals SET title='External edit'");assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),/ready|source/i);d.close();
});
test('old prepare and grocery paths cannot publish cycle-owned sources',()=>{
  const {d,id}=ready(),meal=review(d,id).occurrences[0];d.exec('UPDATE meal_execution_settings SET enabled=1');
  assert.throws(()=>ensureMealExecution(d,meal.id,1),/cycle/i);
  assert.throws(()=>createOrRefreshGroceryRun(d,{listId:1,from:meal.date,to:meal.date,userId:1}),/cycle/i);d.close();
});
test('explicit empty and disjoint grocery scopes persist through freshness and publication',()=>{
  const d=fixture();d.exec("INSERT INTO meals(id,date,meal_type,title,created_by) VALUES(501,'2034-03-06','dinner','A',1),(502,'2034-03-06','dinner','B',1); INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES(501,'Rice','1 kg'),(502,'Beans','2 kg')");
  const make=(ids,key)=>createOrRefreshGroceryRun(d,{listId:1,from:'2034-03-06',to:'2034-03-06',userId:1,logicalKey:key,mealIds:ids}).run;
  assert.equal(make([],'empty').items.length,0);const a=make([501],'one'),b=make([502],'two');
  assert.deepEqual(a.items.flatMap(x=>x.sources.map(s=>s.meal_id)),[501]);assert.equal(b.items[0].name,'Beans');
  d.exec("UPDATE meal_ingredients SET quantity='3 kg' WHERE meal_id=502");finalizeGroceryRun(d,a.id);publishGroceryRun(d,a.id);
  assert.throws(()=>finalizeGroceryRun(d,b.id),/changed/i);assert.equal(d.prepare('SELECT count(*) n FROM shopping_items').get().n,1);d.close();
});
export {ready,options,acknowledge,now};

function executionReady(strategies={cooking:'eligible_round_robin'},all=false) {
  const d=fixture({}, {generate_preparation:all,generate_cooking:true,generate_supervision:all,generate_serving:all,generate_cleanup:all,execution_assignment_strategies:strategies});
  d.exec(`UPDATE meal_execution_settings SET enabled=1,generate_preparation=${Number(all)},generate_cooking=1,generate_supervision=${Number(all)},generate_serving=${Number(all)},generate_cleanup=${Number(all)}`);
  const id=ensure(d).cycle_id;main(d,id);for(const p of [1,2,3])decision(d,id,p);submitAll(d,id);return {d,id};
}
const reseal=(d,id)=>d.prepare('UPDATE meal_cycles SET source_fingerprint=? WHERE id=?').run(cycles.cycleSourceFingerprint(d,id),id);
test('all configured roles use pure eligibility preview and explicit claimable roles can finalize',()=>{
  const strategies=Object.fromEntries(['preparation','cooking','supervision','serving','cleanup'].map(x=>[x,'open_claimable']));
  const {d,id}=executionReady(strategies,true);acknowledge(d,id);
  const before=d.prepare('SELECT total_changes() n').get().n,r=api.reviewCycleReadiness(d,id,{actorId:1,now});
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);assert.equal(r.executions[0].roles.filter(x=>x.required).length,5);
  assert.ok(r.executions[0].roles.every(x=>x.strategy==='open_claimable'&&x.status==='ready'));
  const result=api.finalizeCycle(d,id,options(d,id));assert.equal(result.execution_task_ids.length,5);
  assert.equal(d.prepare('SELECT count(*) n FROM task_claim_eligibility').get().n,15);d.close();
});
test('missing required roles, destination and revoked review completion are visible blockers',()=>{
  const {d,id}=executionReady({cooking:'supervisor'});let r=api.reviewCycleReadiness(d,id,{actorId:1,now});
  assert.ok(r.blockers.some(x=>x.code==='EXECUTION_ASSIGNEE_REQUIRED'&&x.role==='cooking'));
  d.exec('DELETE FROM shopping_lists WHERE id=1');r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.ok(r.blockers.some(x=>x.code==='SHOPPING_DESTINATION_REQUIRED'));d.close();
  const a=ready();a.d.exec("UPDATE users SET role='member' WHERE id=1; INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','1','tasks.complete_own','none')");
  assert.ok(api.reviewCycleReadiness(a.d,a.id,{actorId:1,now}).blockers.some(x=>x.code==='REVIEW_TASK_PERMISSION_REQUIRED'));a.d.close();
});
test('round robin preview consumes no writes; mid-publication failure rolls back groceries, Tasks, inbox, rotation, result and receipt',()=>{
  const {d,id}=executionReady();const meal=review(d,id).occurrences[0];
  d.prepare("INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES(?,'Rice','1 kg')").run(meal.id);reseal(d,id);
  const before=d.prepare('SELECT total_changes() n').get().n;api.reviewCycleReadiness(d,id,{actorId:1,now});assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  const tables=['meal_grocery_runs','meal_grocery_items','shopping_items','meal_execution_snapshots','meal_execution_tasks','tasks','notification_inbox','assignment_rotation_state','meal_cycle_results','meal_cycle_requests','task_completions'];
  const counts=()=>Object.fromEntries(tables.map(t=>[t,d.prepare(`SELECT count(*) n FROM ${t}`).get().n]));const baseline=counts();
  d.exec("CREATE TRIGGER fail_after_execution AFTER INSERT ON meal_execution_tasks BEGIN SELECT RAISE(ABORT,'injected after output'); END");
  assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),/injected after output/);assert.deepEqual(counts(),baseline);assert.equal(review(d,id).cycle.state,'open');
  assert.equal(d.prepare('SELECT on_shopping_list FROM meal_ingredients').get().on_shopping_list,0);
  d.exec('DROP TRIGGER fail_after_execution');const result=api.finalizeCycle(d,id,options(d,id));assert.equal(result.execution_task_ids.length,1);assert.equal(d.prepare('SELECT count(*) n FROM shopping_items').get().n,1);d.close();
});
test('latest committed response and reductions determine exact demand; alternatives do not duplicate main chores',()=>{
  const {d,id}=executionReady();for(const p of [1,2,3])decision(d,id,p,{choice_kind:'backup',selected_meal_title:`Alternative ${p}`,menu_item_ids:[]},`alternative-${p}`);
  let r=api.reviewCycleReadiness(d,id,{actorId:1,now});const root=review(d,id).occurrences[0].id;
  assert.ok(!r.ids.includes(root));assert.equal(r.ids.length,3);assert.ok(!r.executions.some(x=>x.meal_id===root));
  for(const p of [1,2,3])decision(d,id,p,{participation:'not_participating'},`away-${p}`);
  r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.deepEqual(r.ids,[]);const result=api.finalizeCycle(d,id,options(d,id));assert.deepEqual(result.execution_task_ids,[]);assert.deepEqual(result.grocery_runs,[]);d.close();
});
test('changed custom dish invalidates saved acknowledgment; explicit empty ingredients remain a gap',()=>{
  const {d,id}=ready();acknowledge(d,id);main(d,id,'Different dinner','different');
  assert.ok(api.reviewCycleReadiness(d,id,{actorId:1,now}).gaps.some(x=>!x.acknowledged));
  d.exec("INSERT INTO recipes(id,title,created_by) VALUES(900,'Structured',1); INSERT INTO recipe_ingredients(recipe_id,name,quantity) VALUES(900,'Rice','1 kg')");
  const meal=review(d,id).occurrences[0];d.prepare('UPDATE meals SET recipe_id=900,ingredients_manual_override=1 WHERE id=?').run(meal.id);reseal(d,id);
  const r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.ok(r.gaps.some(x=>x.meal_id===meal.id));assert.ok(r.warnings.some(x=>x.code==='LEGACY_RECIPE_BATCH'));d.close();
});
test('existing grocery family adoption conflict rolls back ownership and preserves legacy refresh',()=>{
  const d=fixture();d.exec("INSERT INTO meals(id,date,meal_type,title,scope,scheduled_time,created_by) VALUES(800,'2034-03-06','dinner','Existing','household','18:00',1); INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES(800,'Rice','2 kg')");
  const opts={listId:1,from:'2034-03-06',to:'2034-03-12',userId:1};const run=createOrRefreshGroceryRun(d,opts).run;
  assert.throws(()=>ensure(d),/existing Shopping flow|ownership/i);assert.equal(d.prepare('SELECT count(*) n FROM meal_cycle_memberships').get().n,0);
  assert.equal(createOrRefreshGroceryRun(d,opts).run.id,run.id);finalizeGroceryRun(d,run.id);publishGroceryRun(d,run.id);d.close();
});
test('reschedule requires explicit due-now confirmation, bumps revision and rejects stale/finalized changes',()=>{
  const {d,id}=ready();const old=options(d,id);const opts={...old,requestKey:'reschedule',schedule:{confirmation:{day_offset:-3,time:'21:00'}},now};
  assert.throws(()=>api.rescheduleCycle(d,id,opts),/confirmDueNow/);
  const r=api.rescheduleCycle(d,id,{...opts,confirmDueNow:true});assert.equal(r.revision,old.expectedRevision+1);
  assert.throws(()=>api.finalizeCycle(d,id,old),/revision/);acknowledge(d,id);api.finalizeCycle(d,id,options(d,id));
  assert.throws(()=>api.rescheduleCycle(d,id,{...opts,requestKey:'late',expectedRevision:review(d,id).revision,confirmDueNow:true}),/confirmed|adjustment/);d.close();
});
test('separate SQLite workers overlap manual/automatic confirmation and a racing response without duplicate outputs',async()=>{
  const {d,id}=ready({finalization_mode:'automatic'});acknowledge(d,id);const revision=review(d,id).revision,mealId=review(d,id).occurrences[0].id;
  const directory=mkdtempSync(join(tmpdir(),'kitchen-cycle-race-')),path=join(directory,'synthetic.sqlite');
  writeFileSync(path,d.serialize());d.close();const gate=new SharedArrayBuffer(4),workers=[];
  const create=mode=>{
    const worker=new Worker(new URL('./meal-cycle-race-worker.js',import.meta.url),{workerData:{path,gate,mode,cycleId:id,revision,mealId}});workers.push(worker);
    const messages=[],waiters=[];worker.on('message',m=>{messages.push(m);for(const wake of waiters.splice(0))wake();});
    const next=async type=>{while(!messages.some(m=>m.type===type))await new Promise((resolve,reject)=>{waiters.push(resolve);worker.once('error',reject);});return messages.find(m=>m.type===type);};
    return {worker,next};
  };
  try {
    const manual=create('manual'),automatic=create('automatic'),response=create('response');
    await Promise.all([manual.next('ready'),automatic.next('ready'),response.next('ready')]);manual.worker.postMessage('start');await manual.next('holding');
    automatic.worker.postMessage('start');response.worker.postMessage('start');await Promise.all([automatic.next('attempting'),response.next('attempting')]);
    await new Promise(resolve=>setTimeout(resolve,180));Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
    const [a,b,c]=await Promise.all([manual.next('result'),automatic.next('result'),response.next('result')]);
    assert.equal(a.error,undefined);assert.equal(b.error,undefined);assert.deepEqual(a.result,b.result);assert.match(c.error,/confirmed|adjustment/);assert.ok(b.elapsed>=150&&c.elapsed>=150,'competing connections actually waited while first publication transaction was open');
    const {default:Database}=await import('better-sqlite3-multiple-ciphers');const check=new Database(path);
    assert.equal(check.prepare("SELECT count(*) n FROM meal_cycle_results WHERE kind='finalization'").get().n,1);
    assert.equal(check.prepare('SELECT count(*) n FROM meal_grocery_runs').get().n,1);
    assert.equal(check.prepare("SELECT count(*) n FROM task_activity_events WHERE event_type='completed' AND action_task_id=(SELECT task_id FROM meal_cycle_task_links WHERE purpose='review')").get().n,1);check.close();
  } finally {Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);await Promise.all(workers.map(w=>w.terminate()));assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});}
});
test('administrator can confirm after configured coordinator loses creation permission; scheduler cannot impersonate that administrator',()=>{
  const {d,id}=ready({coordinator_id:2,finalization_mode:'automatic'});acknowledge(d,id);
  d.exec("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','tasks.create','none')");
  api.withAutomaticCycleInvocation(d,()=>assert.throws(()=>api.finalizeCycle(d,id,{...options(d,id),actorId:2,trigger:'automatic'}),/permission/i));
  assert.equal(api.finalizeCycle(d,id,options(d,id)).cycle_id,id);d.close();
});
test('unsubmitted active personal Tasks still require truthful submission when everyone opts out',()=>{
  const d=fixture(),id=ensure(d).cycle_id;main(d,id);for(const p of [1,2,3])decision(d,id,p,{participation:'not_participating'});
  const r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.equal(r.blockers.filter(x=>x.code==='PERSONAL_SUBMISSION_REQUIRED').length,3);
  assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),/submit/i);submitAll(d,id);assert.equal(api.finalizeCycle(d,id,options(d,id)).cycle_id,id);d.close();
});
test('finalization receipt never bypasses revoked actor permissions and output policy edits invalidate preflight',()=>{
  const {d,id}=ready();acknowledge(d,id);const o=options(d,id);
  assert.throws(()=>api.finalizeCycle(d,id,{...o,actorId:3}),/permission/i);
  api.finalizeCycle(d,id,o);d.exec("UPDATE users SET role='member' WHERE id=1; INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','1','module','meals','none')");
  assert.throws(()=>api.finalizeCycle(d,id,o),/permission/i);d.close();
  const b=ready();acknowledge(b.d,b.id);b.d.exec('UPDATE meal_execution_settings SET enabled=1-enabled');
  assert.throws(()=>api.finalizeCycle(b.d,b.id,options(b.d,b.id)),/sources changed/i);b.d.close();
});
test('started snapshot freezes missing roles before assignment resolution or new outputs',()=>{
  const d=fixture();d.exec("INSERT INTO meals(id,date,meal_type,title,scope,scheduled_time,selection_status,created_by) VALUES(800,'2034-03-06','dinner','Existing','household','18:00','selected',1); INSERT INTO meal_participants(meal_id,user_id,role,status) VALUES(800,1,'participant','participating'); UPDATE meal_execution_settings SET enabled=1,generate_preparation=0,generate_cooking=1,generate_supervision=0,generate_serving=0,generate_cleanup=0");
  const first=ensureMealExecution(d,800,1);assert.equal(first.tasks.length,1);d.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(first.tasks[0].task_id);
  d.exec('UPDATE meal_execution_settings SET generate_preparation=1,generate_cleanup=1');const frozen=ensureMealExecution(d,800,1);assert.equal(frozen.tasks.length,1);assert.ok(frozen.frozen_at);
  assert.throws(()=>ensure(d),/Started execution history/);assert.equal(d.prepare('SELECT count(*) n FROM meal_cycle_memberships').get().n,0);d.close();
});
for(const track of [true,false])test(`Home/trip scopes publish each active personal source once, with trip tracking ${track}`,()=>{
  const d=fixture(),context=savePlanningContext(d,{context_key:'trip-finalization',name:'Trip',context_type:'travel',starts_at:'2034-03-06T00:00:00',ends_at:'2034-03-07T00:00:00',member_ids:[3]},1);
  const plan=createMealPlan(d,{name:'Trip Dinner',home_enabled:false,rules:[{weekday:0,meal_type:'dinner',policy:'fixed',fixed_user_id:3,participant_ids:[3],preferred_time:'18:00'}]},1);
  attachMealPlanToContext(d,plan.id,context.id,{},1);
  d.prepare('INSERT OR REPLACE INTO planning_context_grocery_settings(planning_context_id,track_groceries) VALUES(?,?)').run(context.id,Number(track));
  const id=ensure(d).cycle_id;
  for(const p of [1,2,3])for(const req of review(d,id,p).personal.requirements.filter(x=>x.kind==='main'))save(d,id,[{meal_id:req.meal_id,kind:'main',title:`Main ${p}`,recipe_id:null}],`main-${p}`,p);
  for(const p of [1,2,3])for(const req of review(d,id,p).personal.requirements.filter(x=>x.kind==='decision'&&x.status!=='away')) {
    const meal=review(d,id,p).occurrences.find(x=>x.id===req.meal_id);
    save(d,id,[{meal_id:meal.id,kind:'decision',decision:{participation:'participating',choice_kind:p===1?'backup':'household',confirmed:true,selected_meal_title:p===1?'Personal Soup':undefined,menu_item_ids:p===1?[]:meal.menu_items.filter(x=>x.item_type==='entree').map(x=>x.id)}}],`answer-${p}`,p);
  }
  submitAll(d,id);
  for(const meal of d.prepare('SELECT id FROM meals').all())d.prepare("INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES(?,'Rice','1 kg')").run(meal.id);
  reseal(d,id);const r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.equal(r.gaps.length,0,'structured ingredients are not missing when grocery tracking is off');
  const result=api.finalizeCycle(d,id,options(d,id));assert.equal(result.grocery_runs.length,track?2:1);
  const sources=d.prepare('SELECT source_key,meal_id FROM meal_grocery_item_sources').all();assert.equal(new Set(sources.map(x=>x.source_key)).size,sources.length);assert.equal(sources.length,track?3:2);
  const trip=review(d,id).occurrences.find(x=>x.planning_context_id===context.id);assert.equal(sources.some(x=>x.meal_id===trip.id),track);d.close();
});

for(const denial of ['module','completion'])test(`execution recipients need current ${denial} permission across all five required roles`,()=>{
  const roles=['preparation','cooking','supervision','serving','cleanup'];
  const {d,id}=executionReady(Object.fromEntries(roles.map(role=>[role,'cook'])),true);
  d.exec("UPDATE meal_participants SET user_id=2 WHERE role='cook'");reseal(d,id);acknowledge(d,id);
  assert.equal(api.reviewCycleReadiness(d,id,{actorId:1,now}).ready,true);
  if(denial==='module')d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','tasks','none')");
  else d.exec("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','tasks.complete_own','none')");
  const before=d.prepare('SELECT total_changes() n').get().n,r=api.reviewCycleReadiness(d,id,{actorId:1,now});
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.deepEqual(r.blockers.filter(x=>x.code==='EXECUTION_ASSIGNEE_REQUIRED').map(x=>x.role),roles);
  assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),/eligible|ready/i);
  assert.equal(d.prepare('SELECT count(*) n FROM meal_execution_tasks').get().n,0);assert.equal(d.prepare('SELECT count(*) n FROM meal_cycle_results').get().n,0);
  d.exec(denial==='module'?"DELETE FROM access_permissions WHERE subject_id='2'":"DELETE FROM access_capabilities WHERE subject_id='2'");
  const result=api.finalizeCycle(d,id,options(d,id));assert.equal(result.execution_task_ids.length,5);
  for(const taskId of result.execution_task_ids)assert.equal(taskCapabilities(d,2,d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)).complete,true);d.close();
});
for(const deniedCapability of ['tasks.claim','tasks.complete_own'])test(`unclaimed output excludes sole skill-qualified recipient denied ${deniedCapability}`,()=>{
  const {d,id}=executionReady({cooking:'open_claimable'});
  d.exec("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id IN (1,3) AND skill_id=(SELECT id FROM skills WHERE system_key='cooking')");reseal(d,id);acknowledge(d,id);
  d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2',?,'none')").run(deniedCapability);
  const before=d.prepare('SELECT total_changes() n').get().n,r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.ok(r.blockers.some(x=>x.code==='EXECUTION_ASSIGNEE_REQUIRED'));assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),/eligible|ready/i);
  assert.equal(d.prepare('SELECT count(*) n FROM task_claim_eligibility').get().n,0);
  d.exec("DELETE FROM access_capabilities WHERE subject_id='2'");const result=api.finalizeCycle(d,id,options(d,id));const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(result.execution_task_ids[0]);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_claim_eligibility WHERE task_id=?').all(task.id),[{user_id:2}]);assert.equal(taskCapabilities(d,2,task).claim,true);
  assert.equal(taskCapabilities(d,2,{visibility:'all',assigned_to:2,created_by:1}).complete,true);d.close();
});
for(const strategy of ['eligible_round_robin','open_claimable'])test(`${strategy} retains permitted alternatives without requiring coordinator capabilities`,()=>{
  const {d,id}=executionReady({cooking:strategy});acknowledge(d,id);
  d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','tasks','read'); INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','3','tasks.create','none'),('user','3','tasks.edit_others','none'),('user','3','tasks.change_assignment','none'),('user','3','tasks.change_dates','none')");
  const r=api.reviewCycleReadiness(d,id,{actorId:1,now}),role=r.executions[0].roles.find(x=>x.role==='cooking');assert.equal(r.ready,true);assert.deepEqual(role.eligible_ids,[1,3]);
  const result=api.finalizeCycle(d,id,options(d,id)),task=d.prepare('SELECT * FROM tasks WHERE id=?').get(result.execution_task_ids[0]);
  if(strategy==='open_claimable')assert.deepEqual(d.prepare('SELECT user_id FROM task_claim_eligibility WHERE task_id=? ORDER BY user_id').all(task.id),[{user_id:1},{user_id:3}]);
  else assert.notEqual(task.assigned_to,2);d.close();
});
for(const strategy of [null,'cook'])test(`unresolved cook prerequisite is pure and actionable for ${strategy||'legacy'} strategy`,()=>{
  const {d,id}=executionReady(strategy?{cooking:strategy}:{});d.exec("DELETE FROM meal_participants WHERE role='cook'");
  d.prepare('UPDATE meals SET provenance_json=?').run(JSON.stringify({rotations:{cook:{state:'needs_assignment'}}}));reseal(d,id);acknowledge(d,id);
  const before=d.prepare('SELECT total_changes() n').get().n,r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.ok(r.blockers.some(x=>x.code==='MEAL_COOK_ROTATION_UNRESOLVED'));assert.equal(r.ready,false);
  assert.throws(()=>api.finalizeCycle(d,id,options(d,id)),error=>error.blockers?.some(x=>x.code==='MEAL_COOK_ROTATION_UNRESOLVED'));
  assert.equal(d.prepare('SELECT count(*) n FROM meal_grocery_runs').get().n,0);
  d.prepare('UPDATE meals SET provenance_json=?').run(JSON.stringify({rotations:{cook:{state:'assigned'}}}));d.prepare("INSERT INTO meal_participants(meal_id,user_id,role,status) VALUES(?,2,'cook','participating')").run(review(d,id).occurrences[0].id);reseal(d,id);
  assert.equal(api.reviewCycleReadiness(d,id,{actorId:1,now}).ready,true);assert.equal(api.finalizeCycle(d,id,options(d,id)).execution_task_ids.length,1);d.close();
});
test('unresolved cook does not block independent strategies, disabled roles or captured output history',()=>{
  for(const scenario of ['independent','disabled','captured']) {
    const {d,id}=executionReady(scenario==='independent'?{cooking:'eligible_round_robin'}:{}),mealId=review(d,id).occurrences[0].id;
    if(scenario==='disabled')d.exec('UPDATE meal_execution_settings SET generate_cooking=0');
    if(scenario==='captured')withCycleMealWrite(d,id,()=>ensureMealExecution(d,mealId,1));
    d.prepare('UPDATE meals SET provenance_json=?').run(JSON.stringify({rotations:{cook:{state:'needs_assignment'}}}));reseal(d,id);acknowledge(d,id);
    const r=api.reviewCycleReadiness(d,id,{actorId:1,now});assert.ok(!r.blockers.some(x=>x.code==='MEAL_COOK_ROTATION_UNRESOLVED'));assert.equal(r.ready,true);
    const result=api.finalizeCycle(d,id,options(d,id));assert.equal(result.execution_task_ids.length,scenario==='disabled'?0:1);d.close();
  }
});
test('recipient revocation never rewrites started or completed execution history',()=>{
  for(const status of ['in_progress','done']) {
    const {d,id}=executionReady({cooking:'cook'}),mealId=review(d,id).occurrences[0].id;
    d.exec("UPDATE meal_participants SET user_id=2 WHERE role='cook'");reseal(d,id);
    const first=withCycleMealWrite(d,id,()=>ensureMealExecution(d,mealId,1)),taskId=first.tasks[0].task_id;
    d.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,taskId);
    d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','tasks','none')");
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),outputs=d.prepare('SELECT * FROM meal_execution_tasks WHERE meal_id=?').all(mealId);
    withCycleMealWrite(d,id,()=>ensureMealExecution(d,mealId,1));
    assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),task);assert.deepEqual(d.prepare('SELECT * FROM meal_execution_tasks WHERE meal_id=?').all(mealId),outputs);d.close();
  }
});
test('an already-claimed output requires completion but no longer requires permission to claim',()=>{
  const {d,id}=executionReady({cooking:'open_claimable'}),mealId=review(d,id).occurrences[0].id;
  const first=withCycleMealWrite(d,id,()=>ensureMealExecution(d,mealId,1)),taskId=first.tasks[0].task_id;
  d.prepare('UPDATE tasks SET assigned_to=2 WHERE id=?').run(taskId);d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(taskId);
  d.exec("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','tasks.claim','none')");acknowledge(d,id);
  assert.equal(api.reviewCycleReadiness(d,id,{actorId:1,now}).ready,true);const result=api.finalizeCycle(d,id,options(d,id));assert.deepEqual(result.execution_task_ids,[taskId]);assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(taskId).assigned_to,2);d.close();
});
