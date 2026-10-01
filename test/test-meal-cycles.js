import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {saveCycleSettings}=await import('../server/services/meal-cycle-settings.js');
const plans=await import('../server/services/meal-plans.js');
// Dynamic import permits a useful assertion when the new service is absent.
const cycles=await import('../server/services/meal-cycles.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {savePlanningContext}=await import('../server/services/planning-contexts.js');
const {default:router}=await import('../server/routes/meals.js');
const template=new Database(':memory:');
for(const migration of ALL_MIGRATIONS) {
  if(typeof migration.up==='function')migration.up(template);else template.exec(migration.up);
  migration.afterUp?.(template);
}
const schema=template.serialize();template.close();
function fixture(overrides={}) {
  const d=new Database(schema);d.pragma('foreign_keys=ON');
  for(let i=1;i<=3;i++)d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,'x',?,'parent')").run(i,`cycle${i}`,`Person ${i}`,i===1?'admin':'member');
  d.exec("INSERT INTO shopping_lists(id,name,created_by) VALUES(1,'Home',1); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','Europe/Berlin')");
  for(let i=1;i<=3;i++)d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) SELECT ?,id,'normal','manual',1 FROM skills WHERE system_key IS NOT NULL").run(i);
  saveCycleSettings(d,{enabled:true,timezone:'Europe/Berlin',cadence:'weekly',first_period_start:'2034-03-06',creation:{day_offset:-3,time:'09:00'},response:{day_offset:-3,time:'20:00'},confirmation:{day_offset:-2,time:'20:00'},shopping:{day_offset:-1,time:'10:00'},coordinator_id:1,shopping_assignee_id:1,shopping_list_id:1,finalization_mode:'manual',...overrides},{actorId:1,expectedRevision:0,requestKey:'settings'});
  plans.createMealPlan(d,{name:'Dinners',rules:[{weekday:0,meal_type:'dinner',policy:'fixed',fixed_user_id:2,participant_ids:[1,2,3],preferred_time:'18:00',max_side_choices:2}]},1);
  return d;
}
function ensure(d,extra={}) {assert.equal(typeof cycles.ensureCycle,'function','ensureCycle service must exist');return cycles.ensureCycle(d,{start:'2034-03-06',actorId:1,requestKey:'ensure',expectedSettingsRevision:1,...extra});}
const review=(d,id,person=2)=>cycles.reviewCycle(d,id,{actorId:person,beneficiaryId:person});
const save=(d,id,changes,key='save',person=2,extra={})=>cycles.saveCyclePerson(d,id,{actorId:person,beneficiaryId:person,expectedRevision:review(d,id,person).revision,requestKey:key,changes,...extra});
function main(d,id,title='Pasta',key='main') {const m=review(d,id).occurrences[0];return save(d,id,[{meal_id:m.id,kind:'main',title,recipe_id:null}],key);}
function decision(d,id,person=2,patch={},key=`decision-${person}`) {
  const m=review(d,id,person).occurrences[0];
  return save(d,id,[{meal_id:m.id,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,menu_item_ids:m.menu_items.filter(x=>x.item_type==='entree').map(x=>x.id),...patch}}],key,person);
}
test('ensure is unique, adopts authoritative occurrences and links personal/review/shopping Tasks',()=>{
  const d=fixture();const a=ensure(d);assert.deepEqual(ensure(d),a);assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_cycles').get().n,1);
  assert.equal(a.occurrences.length,1);assert.equal(a.tasks.length,5);assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_cycle_memberships').get().n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_execution_snapshots').get().n,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_grocery_runs').get().n,0);d.close();
});
test('ensure rejects unanchored starts, stale settings and overlapping coverage atomically',()=>{
  const d=fixture();assert.throws(()=>ensure(d,{start:'2034-03-07'}),/anchor|cadence/i);
  assert.throws(()=>ensure(d,{expectedSettingsRevision:0}),/revision/i);const a=ensure(d);
  d.prepare("UPDATE meal_cycles SET period_end='2034-03-20' WHERE id=?").run(a.cycle.id);
  assert.throws(()=>ensure(d,{start:'2034-03-13',requestKey:'overlap'}),/overlap/i);d.close();
});
test('review is a coherent read with no total_changes or output creation',()=>{
  const d=fixture();const a=ensure(d);const before=d.prepare('SELECT total_changes() n').get().n;
  const r=review(d,a.cycle.id);assert.equal(d.prepare('SELECT total_changes() n').get().n,before);assert.equal(r.fingerprint,a.fingerprint);
  assert.ok(r.personal.requirements.some(x=>x.kind==='main'));assert.ok(r.personal.requirements.some(x=>x.kind==='decision'));d.close();
});
test('chooser publishes shared main independently then eats an alternative or opts out without declining duty',()=>{
  const d=fixture();const id=ensure(d).cycle.id;main(d,id);decision(d,id,2,{choice_kind:'backup',selected_meal_title:'Toast',menu_item_ids:[]});
  let r=review(d,id);assert.equal(r.occurrences[0].title,'Pasta');assert.equal(r.occurrences[0].chooser_status,'fulfilled');assert.equal(r.occurrences[0].my_decision.choice_kind,'backup');
  decision(d,id,2,{participation:'not_participating',menu_item_ids:[]},'skip');r=review(d,id);assert.equal(r.occurrences[0].chooser_status,'fulfilled');assert.equal(r.occurrences[0].title,'Pasta');assert.equal(r.personal.requirements.find(x=>x.kind==='decision').contribution,0);d.close();
});
test('pending shared main blocks dependent diner submission',()=>{
  const d=fixture();const id=ensure(d).cycle.id;decision(d,id,3);
  assert.throws(()=>cycles.submitCyclePerson(d,id,{actorId:3,beneficiaryId:3,expectedRevision:review(d,id,3).revision,requestKey:'submit'}),/incomplete|pending|answer/i);d.close();
});
test('main replacement preserves sides and other diners alternatives',()=>{
  const d=fixture();plans.materializeMealPlanOccurrences(d,{from:'2034-03-06',to:'2034-03-12',actorId:1});
  const meal=d.prepare('SELECT id FROM meals WHERE parent_meal_id IS NULL').get();plans.createMealMenuItem(d,meal.id,{item_type:'side',title:'Peas'},2);
  const id=ensure(d).cycle.id;main(d,id);decision(d,id,3,{choice_kind:'backup',selected_meal_title:'Soup',menu_item_ids:[]});
  const old=d.prepare('SELECT * FROM meal_person_decisions WHERE beneficiary_user_id=3').get();main(d,id,'Rice','main-2');
  assert.ok(review(d,id).occurrences[0].menu_items.some(x=>x.item_type==='side'&&x.title==='Peas'));
  assert.deepEqual(d.prepare('SELECT * FROM meal_person_decisions WHERE beneficiary_user_id=3').get(),old);d.close();
});
test('late chooser deadline remains editable while cycle open',()=>{
  const d=fixture();plans.materializeMealPlanOccurrences(d,{from:'2034-03-06',to:'2034-03-12',actorId:1});
  d.exec("UPDATE planning_obligations SET response_deadline='2000-01-01T00:00:00' WHERE entity_type='meal'");const id=ensure(d).cycle.id;
  assert.equal(main(d,id).occurrences[0].title,'Pasta');assert.equal(review(d,id).occurrences[0].menu_locked,false);d.close();
});
test('own/admin authorization, fresh permission checks on retry, revision and payload identity',()=>{
  const d=fixture();const id=ensure(d).cycle.id;const m=review(d,id).occurrences[0];const changes=[{meal_id:m.id,kind:'main',title:'Rice',recipe_id:null}];
  assert.throws(()=>save(d,id,changes,'forged',2,{actorId:3}),/permission|another/i);
  const options={actorId:1,beneficiaryId:2,expectedRevision:1,requestKey:'admin',changes};const a=cycles.saveCyclePerson(d,id,options);assert.deepEqual(cycles.saveCyclePerson(d,id,options),a);
  assert.throws(()=>cycles.saveCyclePerson(d,id,{...options,changes:[]}),/request/i);
  assert.throws(()=>cycles.saveCyclePerson(d,id,{...options,requestKey:'stale'}),/revision/i);
  d.exec("UPDATE users SET role='member' WHERE id=1; INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','1','module','meals','none')");
  assert.throws(()=>cycles.saveCyclePerson(d,id,options),/permission|access/i);d.close();
});
test('submission uses canonical lifecycle once; direct completion validates the same obligation',()=>{
  const d=fixture();const id=ensure(d).cycle.id;let r=review(d,id);let t=d.prepare('SELECT * FROM tasks WHERE id=?').get(r.personal.task_id);
  assert.throws(()=>changeTaskStatus(d,t.id,'done',{actorId:2,body:{expected_revision:t.revision}}),/incomplete|pending|answer/i);
  main(d,id);decision(d,id);r=review(d,id);const opts={actorId:2,beneficiaryId:2,expectedRevision:r.revision,requestKey:'submit'};
  const a=cycles.submitCyclePerson(d,id,opts);assert.deepEqual(cycles.submitCyclePerson(d,id,opts),a);assert.equal(a.personal.submitted,true);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(t.id).n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(t.id).n,1);
  decision(d,id,3,{participation:'not_participating'},'skip3');r=review(d,id,3);t=d.prepare('SELECT * FROM tasks WHERE id=?').get(r.personal.task_id);
  changeTaskStatus(d,t.id,'done',{actorId:3,body:{expected_revision:t.revision}});assert.equal(review(d,id,3).personal.submitted,true);d.close();
});
test('review Task cannot confirm and changed personal assignee cannot impersonate beneficiary',()=>{
  const d=fixture();const a=ensure(d);const r=a.tasks.find(x=>x.purpose==='review');let t=d.prepare('SELECT * FROM tasks WHERE id=?').get(r.task_id);
  assert.throws(()=>changeTaskStatus(d,t.id,'done',{actorId:1,body:{expected_revision:t.revision}}),/confirm|finaliz/i);
  const p=review(d,a.cycle.id).personal.task_id;d.prepare('UPDATE tasks SET assigned_to=3 WHERE id=?').run(p);t=d.prepare('SELECT * FROM tasks WHERE id=?').get(p);
  assert.throws(()=>changeTaskStatus(d,p,'done',{actorId:3,body:{expected_revision:t.revision}}),/permission|another|beneficiary/i);d.close();
});
test('legacy canonical writers cannot bypass cycle revision using JSON cycleId or after finalization',()=>{
  const d=fixture();const a=ensure(d),m=a.occurrences[0];
  assert.throws(()=>plans.saveMealDecision(d,m.id,{cycleId:a.cycle.id,participation:'not_participating'},{actorId:2}),/cycle/i);
  assert.throws(()=>plans.createMealMenuItem(d,m.id,{title:'Bypass',item_type:'entree',cycleId:a.cycle.id},2),/cycle/i);
  d.prepare("UPDATE meal_cycles SET state='finalized' WHERE id=?").run(a.cycle.id);assert.throws(()=>main(d,a.cycle.id),/confirmed|adjustment/i);d.close();
});
test('configured same-day deadlines use actual meal time and missing time is actionable',()=>{
  const d=fixture({cadence:'daily',creation:{day_offset:0,time:'08:00'},response:{day_offset:0,time:'10:00'},confirmation:{day_offset:0,time:'11:00'},shopping:{day_offset:0,time:'12:00'}});
  const a=ensure(d);assert.ok(!a.blockers.some(x=>['CYCLE_DEADLINE_AFTER_MEAL','MEAL_TIME_REQUIRED'].includes(x.code)));
  d.prepare("UPDATE meals SET scheduled_time=NULL,latest_time=NULL,preferred_time=NULL,earliest_time=NULL WHERE id=?").run(a.occurrences[0].id);
  assert.ok(review(d,a.cycle.id).blockers.some(x=>x.code==='MEAL_TIME_REQUIRED'));d.close();
});
test('cycle routes reauthorize URL beneficiary and guard direct meal/ingredient mutation',async()=>{
  const d=fixture();_setTestDatabase(d);const a=ensure(d);let actor=2;const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=actor;req.authRole=actor===1?'admin':'member';next();});app.use(router);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}`;
  try {
    let res=await fetch(`${url}/cycles/${a.cycle.id}?beneficiary_id=3`);assert.equal(res.status,403);
    res=await fetch(`${url}/${a.occurrences[0].id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'bypass',cycleId:a.cycle.id})});assert.equal(res.status,409);
    res=await fetch(`${url}/cycles/${a.cycle.id}`);assert.equal(res.status,200);assert.equal((await res.json()).data.cycle.id,a.cycle.id);
  } finally {await new Promise(r=>server.close(r));d.close();}
});
test('Home and trip slices retain canonical identity and traveler has zero Home contribution',()=>{
  const d=fixture();const context=savePlanningContext(d,{context_key:'cycle-trip',name:'Trip',context_type:'travel',starts_at:'2034-03-06T00:00:00',ends_at:'2034-03-07T00:00:00',member_ids:[3]},1);
  const plan=plans.createMealPlan(d,{name:'Trip Dinner',home_enabled:false,rules:[{weekday:0,meal_type:'dinner',policy:'personal_choice',participant_ids:[3],preferred_time:'18:00'}]},1);
  plans.attachMealPlanToContext(d,plan.id,context.id,{},1);const a=ensure(d);const trip=a.occurrences.find(x=>x.planning_context_id===context.id),home=a.occurrences.find(x=>!x.planning_context_id);
  assert.ok(trip&&home);assert.ok(!home.participants.some(x=>x.user_id===3&&x.status==='participating'));assert.equal(review(d,a.cycle.id,3).personal.requirements.find(x=>x.meal_id===home.id&&x.kind==='decision')?.contribution??0,0);
  assert.ok(a.destinations.find(x=>x.context_id===context.id).meal_ids.includes(trip.id));assert.ok(!a.destinations.find(x=>x.context_id===null).meal_ids.includes(trip.id));d.close();
});
test('unsupported snack slots remain legacy and are not materialized or governed by cycle ensure',()=>{
  const d=fixture();plans.createMealPlan(d,{name:'Snacks',rules:[{weekday:0,meal_type:'snack',policy:'fixed',fixed_user_id:2,participant_ids:[2]}]},1);
  const snack=Number(d.prepare("INSERT INTO meals(date,meal_type,title,created_by) VALUES('2034-03-07','snack','Existing snack',1)").run().lastInsertRowid);
  const a=ensure(d);assert.ok(Array.isArray(a.exclusions),'review must expose excluded legacy meals');assert.ok(a.exclusions.some(x=>x.meal_id===snack));assert.ok(!a.occurrences.some(x=>x.meal_type==='snack'));
  assert.equal(d.prepare("SELECT COUNT(*) n FROM meals WHERE meal_type='snack'").get().n,1);d.close();
});
test('midperiod adoption retains historical meals without personal obligations or historical generation',()=>{
  const today=new Date();const day=offset=>new Date(today.getTime()+offset*86400000).toISOString().slice(0,10);const start=day(-1);
  const d=fixture({first_period_start:start});
  const insert=(date,title)=>Number(d.prepare("INSERT INTO meals(date,meal_type,title,scheduled_time,created_by) VALUES(?,'dinner',?,'18:00',1)").run(date,title).lastInsertRowid);
  const old=insert(start,'Recorded'),future=insert(day(1),'Future');for(const id of [old,future])d.prepare("INSERT INTO meal_participants(meal_id,user_id,role,status,source) VALUES(?,3,'participant','participating','manual')").run(id);
  const a=ensure(d,{start});assert.equal(a.occurrences.find(x=>x.id===old).adopted_history,true);assert.ok(!review(d,a.cycle.id,3).personal.requirements.some(x=>x.meal_id===old));
  assert.ok(!a.destinations.flatMap(x=>x.source_meal_ids).includes(old));assert.ok(a.destinations.flatMap(x=>x.source_meal_ids).includes(future));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM meals WHERE date=?').get(start).n,1);d.close();
});
test('parent bulk completion cannot bypass an incomplete cycle personal Task',()=>{
  const d=fixture();const a=ensure(d);const child=review(d,a.cycle.id).personal.task_id;
  const parent=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by) VALUES('Parent',2,1)").run().lastInsertRowid);d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(parent,child);
  const t=d.prepare('SELECT * FROM tasks WHERE id=?').get(parent);assert.throws(()=>changeTaskStatus(d,parent,'done',{actorId:2,body:{expected_revision:t.revision,complete_remaining:true}}),/incomplete|pending|answer/i);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'open');assert.equal(review(d,a.cycle.id).personal.submitted,false);d.close();
});
test('atomic ordered save rolls back earlier changes when a later change is invalid',()=>{
  const d=fixture();const a=ensure(d),before=review(d,a.cycle.id),meal=a.occurrences[0];
  assert.throws(()=>save(d,a.cycle.id,[{meal_id:meal.id,kind:'main',title:'Rice',recipe_id:null},{meal_id:meal.id,kind:'decision',decision:{portion_amount:-1}}]),/portion/i);
  assert.equal(review(d,a.cycle.id).fingerprint,before.fingerprint);assert.equal(review(d,a.cycle.id).revision,before.revision);assert.equal(d.prepare("SELECT COUNT(*) n FROM meal_cycle_requests WHERE operation='person.save'").get().n,0);d.close();
});
test('external recipe and source changes are visible read-only and block stale writes',()=>{
  const d=fixture();const recipe=Number(d.prepare("INSERT INTO recipes(title,created_by) VALUES('Rice',1)").run().lastInsertRowid);const a=ensure(d),meal=a.occurrences[0];save(d,a.cycle.id,[{meal_id:meal.id,kind:'main',title:'Rice',recipe_id:recipe}]);
  const before=review(d,a.cycle.id);d.prepare('UPDATE recipes SET yield_portions=4 WHERE id=?').run(recipe);
  const changes=d.prepare('SELECT total_changes() n').get().n,after=review(d,a.cycle.id);assert.notEqual(after.fingerprint,before.fingerprint);assert.equal(after.revision,before.revision);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes);
  assert.ok(after.blockers.some(x=>x.code==='CYCLE_SOURCE_CHANGED'));assert.throws(()=>decision(d,a.cycle.id),/sources changed/i);d.close();
});
test('valid editing after submission retains completion; legacy portion 1.10 survives unrelated save',()=>{
  const d=fixture();const id=ensure(d).cycle.id;main(d,id);decision(d,id,2,{portion_amount:1.10});const r=review(d,id);cycles.submitCyclePerson(d,id,{actorId:2,beneficiaryId:2,expectedRevision:r.revision,requestKey:'submit'});
  const meal=review(d,id).occurrences[0];save(d,id,[{meal_id:meal.id,kind:'decision',decision:{notes:'Updated'}}],'notes');const after=review(d,id);
  assert.equal(after.personal.submitted,true);assert.equal(after.personal.needs_correction,false);assert.equal(after.occurrences[0].my_decision.portion_amount,1.10);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(after.personal.task_id).status,'done');d.close();
});
test('fingerprint ignores private event bodies, attachments and provider transport metadata',()=>{
  const d=fixture();const event=Number(d.prepare("INSERT INTO calendar_events(title,start_datetime,end_datetime,created_by) VALUES('Private','2034-03-06T10:00:00','2034-03-06T11:00:00',1)").run().lastInsertRowid);const a=ensure(d),before=review(d,a.cycle.id);
  d.prepare("UPDATE calendar_events SET description='private body',target_caldav_calendar_url='https://invalid.test/private',attachment_data=? WHERE id=?").run(Buffer.from('private'),event);
  assert.equal(review(d,a.cycle.id).fingerprint,before.fingerprint);d.close();
});
test('same-date cutoff after the actual meal blocks review readiness and disabled cycles remain readable',()=>{
  const d=fixture({cadence:'daily',creation:{day_offset:0,time:'08:00'},response:{day_offset:0,time:'19:00'},confirmation:{day_offset:0,time:'20:00'},shopping:{day_offset:0,time:'21:00'}});const a=ensure(d);assert.ok(a.blockers.some(x=>x.code==='CYCLE_DEADLINE_AFTER_MEAL'));
  saveCycleSettings(d,{enabled:false},{actorId:1,expectedRevision:1,requestKey:'pause'});assert.equal(review(d,a.cycle.id).cycle.id,a.cycle.id);assert.equal(ensure(d,{expectedSettingsRevision:2,requestKey:'existing'}).cycle.id,a.cycle.id);d.close();
});
test('legacy timeout processing does not close an open cycle menu at its personal deadline',async()=>{
  const d=fixture();plans.materializeMealPlanOccurrences(d,{from:'2034-03-06',to:'2034-03-12',actorId:1});d.exec("UPDATE planning_obligations SET response_deadline='2000-01-01T00:00:00' WHERE entity_type='meal'");const a=ensure(d);_setTestDatabase(d);
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=1;req.authRole='admin';req.session={userId:1,role:'admin'};next();});app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {const res=await fetch(`http://127.0.0.1:${server.address().port}/selection-requests/process-timeouts`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(res.status,200);assert.equal((await res.json()).data.processed,0);assert.equal(review(d,a.cycle.id).fingerprint,a.fingerprint);}
  finally{await new Promise(r=>server.close(r));d.close();}
});
test('legacy series edit through an unowned sibling cannot rewrite an owned occurrence',async()=>{
  const d=fixture();const a=ensure(d),meal=d.prepare('SELECT * FROM meals WHERE id=?').get(a.occurrences[0].id);const templateId=Number(d.prepare("INSERT INTO meal_recurrence_templates(start_date,weekday,meal_type,title,created_by) VALUES('2034-02-27',0,'dinner','Series',1)").run().lastInsertRowid);
  d.prepare('UPDATE meals SET recurrence_template_id=? WHERE id=?').run(templateId,meal.id);const sibling=Number(d.prepare("INSERT INTO meals(date,meal_type,title,created_by,recurrence_template_id) VALUES('2034-02-27','dinner','Earlier',1,?)").run(templateId).lastInsertRowid);_setTestDatabase(d);
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=1;req.authRole='admin';req.session={userId:1,role:'admin'};next();});app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {const res=await fetch(`http://127.0.0.1:${server.address().port}/${sibling}?scope=series`,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"title":"Bypass"}'});assert.equal(res.status,409);assert.equal(d.prepare('SELECT title FROM meals WHERE id=?').get(meal.id).title,meal.title);}
  finally{await new Promise(r=>server.close(r));d.close();}
});
test('manual household meals without diners are adopted visibly but block confirmation; standalone personal meals are excluded',()=>{
  const d=fixture();const manual=Number(d.prepare("INSERT INTO meals(date,meal_type,title,scheduled_time,created_by) VALUES('2034-03-07','dinner','Manual','18:00',1)").run().lastInsertRowid);
  const personal=Number(d.prepare("INSERT INTO meals(date,meal_type,title,scope,scheduled_time,created_by) VALUES('2034-03-07','lunch','Private','personal','12:00',1)").run().lastInsertRowid);
  const a=ensure(d);assert.ok(a.occurrences.some(m=>m.id===manual));assert.ok(a.blockers.some(b=>b.code==='ADOPTION_REVIEW_REQUIRED'&&b.meal_id===manual));assert.ok(a.exclusions.some(x=>x.meal_id===personal));d.close();
});
test('ensure materializes legacy recurring household meals once through their canonical identities',()=>{
  const d=fixture();const templateId=Number(d.prepare("INSERT INTO meal_recurrence_templates(start_date,weekday,meal_type,title,created_by) VALUES('2034-03-06',1,'lunch','Legacy lunch',1)").run().lastInsertRowid);
  const a=ensure(d);const m=a.occurrences.find(x=>x.recurrence_template_id===templateId);assert.ok(m,'legacy recurrence must be materialized by explicit ensure');assert.equal(m.source_key,`legacy-recurrence:${templateId}:2034-03-07`);assert.deepEqual(ensure(d),a);d.close();
});
test('adoption without a meal time compares creation day in the household timezone',()=>{
  const d=fixture();const a=ensure(d);d.prepare("UPDATE meal_cycles SET created_at='2034-03-06T23:30:00.000Z' WHERE id=?").run(a.cycle.id);d.prepare('UPDATE meals SET scheduled_time=NULL,preferred_time=NULL,latest_time=NULL,earliest_time=NULL WHERE id=?').run(a.occurrences[0].id);
  assert.equal(review(d,a.cycle.id).occurrences[0].adopted_history,true);d.close();
});
for(const [name,permission] of [
  ['tasks.create',"INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','tasks.create','none')"],
  ['Tasks write',"INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','tasks','read')"],
])test(`ensure revalidates coordinator ${name} after settings save`,()=>{
  const d=fixture({coordinator_id:2});d.exec(permission);
  for(const actorId of [1,2])assert.throws(()=>ensure(d,{actorId}),/coordinator|permission/i);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_cycles').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);d.close();
});
test('ensure revalidates the shopping assignee before generating linked work',()=>{
  const d=fixture({shopping_assignee_id:3});d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','3','module','shopping','none')");
  assert.throws(()=>ensure(d),/shopping|permission/i);assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_cycles').get().n,0);d.close();
});
