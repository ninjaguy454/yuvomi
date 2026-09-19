import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'rotation-meals-isolated-test-secret';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { saveRotationGroup, configureRotationTrack, resolveRotation, finalizeRotation, getRotationTrack, getRotationOccurrence, refreshRotationOccurrence } = await import('../server/services/rotation.js');
const { createMealPlan, updateMealPlan, getMealPlan, materializeMealPlanOccurrences, repairMealChooser, advanceMealChooserFallback } = await import('../server/services/meal-plans.js');
let d, admin, grace, eleanor, frankie, group;
test.beforeEach(() => {
 d = new Database(':memory:');
 d.pragma('foreign_keys = ON');
 for (const migration of ALL_MIGRATIONS) {
  typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
  migration.afterUp?.(d);
 }
 _setTestDatabase(d);
 const user = (name, role = 'member') => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(name,name,role).lastInsertRowid);
 admin=user('Parent','admin'); grace=user('Grace'); eleanor=user('Eleanor'); frankie=user('Frankie');
 for (const id of [admin,grace,eleanor,frankie]) d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) SELECT ?,id,'normal','manual' FROM skills WHERE system_key IS NOT NULL").run(id);
 group=saveRotationGroup(d,{name:'Kids',member_ids:[grace,eleanor,frankie]},{actorId:admin});
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});
function plan(extra = {}) {
 return createMealPlan(d,{name:'Dinner',rules:[{weekdays:[0,1,2,3],meal_type:'dinner',policy:'round_robin',chooser_rotation_group_id:group.id,
  participant_ids:[grace,eleanor,frankie],cook_strategy:'none',supervisor_strategy:'none',...extra}]},admin);
}
function generate(from='2026-09-21',to=from){return materializeMealPlanOccurrences(d,{from,to,actorId:admin});}
function assignments(){return d.prepare('SELECT oa.*,m.date FROM meal_occurrence_assignments oa JOIN meals m ON m.id=oa.meal_id ORDER BY m.date,oa.id').all();}

test('Meal Chooser and Shower Order share membership while each keeps an independent Track',()=>{
 const shower=configureRotationTrack(d,{consumer_type:'activity_series',consumer_id:'bedtime',purpose_key:'shower_order',label:'Shower Order',group_id:group.id,strategy:'rotating_order',advance_policy:'on_finalized'},{actorId:admin});
 const night=resolveRotation(d,shower.id,'night-1');
 assert.deepEqual(night.member_ids,[grace,eleanor,frankie]);
 finalizeRotation(d,night.id,{outcome:'finalized',expectedRevision:night.revision,actorId:admin});
 const before=JSON.stringify(getRotationTrack(d,shower.id));
 plan();generate('2026-09-21','2026-09-24');
 assert.deepEqual(assignments().map(row=>row.assigned_user_id),[grace,eleanor,frankie,grace]);
 assert.equal(JSON.stringify(getRotationTrack(d,shower.id)),before);
 const second=resolveRotation(d,shower.id,'night-2');
 assert.deepEqual(second.member_ids,[eleanor,frankie,grace]);
 assert.equal(d.prepare("SELECT COUNT(*) n FROM rotation_tracks WHERE consumer_type='meal_plan'").get().n,1,'weekdays share one stable slot Track');
 for(const row of assignments()) assert.equal(getRotationOccurrence(d,row.rotation_occurrence_id).selected_member.id,row.assigned_user_id);
});

test('meal retry reuses one committed occurrence and never consumes another turn',()=>{
 plan();generate();const before=assignments();const track=d.prepare("SELECT * FROM rotation_tracks WHERE consumer_type='meal_plan'").get();
 assert.equal(generate().created,0);assert.deepEqual(assignments(),before);
 assert.deepEqual(d.prepare('SELECT * FROM rotation_tracks WHERE id=?').get(track.id),track);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,1);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM assignment_rotation_state').get().n,0,'new Group does not mutate legacy cursor aliases');
});

test('chooser, cook, and supervisor use independent Tracks and snapshot provenance',()=>{
 plan({cook_strategy:'round_robin',supervisor_strategy:'round_robin',cook_rotation_group_id:group.id,supervisor_rotation_group_id:group.id});
 generate('2026-09-21','2026-09-22');
 assert.deepEqual(assignments().map(row=>row.assigned_user_id),[grace,eleanor]);
 const roles=d.prepare('SELECT r.*,m.date FROM meal_occurrence_role_assignments r JOIN meal_occurrence_assignments a ON a.id=r.occurrence_assignment_id JOIN meals m ON m.id=a.meal_id ORDER BY m.date,r.role').all();
 assert.deepEqual(roles.map(row=>row.assigned_user_id),[grace,grace,eleanor,eleanor]);
 for(const row of roles) assert.equal(getRotationOccurrence(d,row.rotation_occurrence_id).selected_member.id,row.assigned_user_id);
 assert.equal(d.prepare("SELECT COUNT(*) n FROM rotation_tracks WHERE consumer_type='meal_plan'").get().n,3);
});

test('configured Group IDs and legacy aliases persist independently across plan revisions',()=>{
 const created=plan({rotation_group:'old-family-alias'});
 assert.ok(created.rules.every(row=>row.chooser_rotation_group_id===group.id));
 const updated=updateMealPlan(d,created.id,{name:'Renamed dinner'},admin);
 assert.ok(updated.rules.every(row=>row.chooser_rotation_group_id===group.id&&row.rotation_group==='old-family-alias'));
 generate();const occurrence=getRotationOccurrence(d,assignments()[0].rotation_occurrence_id);
 const old=JSON.stringify(occurrence);
 const other=saveRotationGroup(d,{name:'Other order',member_ids:[frankie,eleanor]},{actorId:admin});
 updateMealPlan(d,created.id,{rules:updated.rules.map(row=>({...row,chooser_rotation_group_id:other.id}))},admin);
 generate('2026-09-22');
 assert.equal(JSON.stringify(getRotationOccurrence(d,occurrence.id)),old,'new Group configuration never rewrites historical result');
 assert.equal(assignments()[1].assigned_user_id,frankie,'switching to a different Group starts its explicitly chosen baseline');
});

test('rotation consumer configuration is checked server-side',()=>{
 assert.throws(()=>createMealPlan(d,{name:'Forbidden',rules:[{weekday:0,meal_type:'dinner',policy:'round_robin',chooser_rotation_group_id:group.id}]},grace),/permission/i);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_plans').get().n,0);
});

test('eligible pool is the intersection of the configured Group and canonical Meal skills',()=>{
 d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run(grace);
 plan();generate();
 assert.equal(assignments()[0].assigned_user_id,eleanor);
 const occurrence=getRotationOccurrence(d,assignments()[0].rotation_occurrence_id);
 assert.ok(!occurrence.member_ids.includes(grace));
});

test('a downstream generation failure rolls back Track, occurrence, and Meal together',()=>{
 plan();d.exec("CREATE TRIGGER fail_meal BEFORE INSERT ON meals BEGIN SELECT RAISE(ABORT,'controlled meal failure'); END");
 assert.throws(()=>generate(),/controlled meal failure/);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_tracks').get().n,0);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,0);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM meal_occurrence_assignments').get().n,0);
 d.exec('DROP TRIGGER fail_meal');generate();assert.equal(assignments()[0].assigned_user_id,grace);
});
function travel(planId, ids, key='trip:rotation') {
 const contextId=Number(d.prepare("INSERT INTO planning_contexts(context_key,name,context_type,starts_at,ends_at,created_by) VALUES(?,'Trip','travel','2026-09-21T00:00:00','2026-09-22T00:00:00',?)").run(key,admin).lastInsertRowid);
 for(const userId of ids)d.prepare('INSERT INTO planning_context_members(planning_context_id,user_id,added_by) VALUES(?,?,?)').run(contextId,userId,admin);
 d.prepare('INSERT INTO planning_context_meal_plans(planning_context_id,meal_plan_id,created_by) VALUES(?,?,?)').run(contextId,planId,admin);
 return contextId;
}

test('home and travel scopes consume independent Tracks within the same Group',()=>{
 const mealPlan=plan();travel(mealPlan.id,[grace]);generate();
 const rows=assignments();
 assert.equal(rows.find(row=>row.planning_context_id==null).assigned_user_id,eleanor);
 assert.equal(rows.find(row=>row.planning_context_id!=null).assigned_user_id,grace);
 assert.equal(d.prepare("SELECT COUNT(*) n FROM rotation_tracks WHERE consumer_type='meal_plan'").get().n,2);
 generate('2026-09-22');
 assert.equal(assignments().find(row=>row.date==='2026-09-22').assigned_user_id,grace,'permanent Home Track was never consumed by scoped output');
 assert.equal(d.prepare("SELECT COUNT(*) n FROM rotation_tracks WHERE consumer_type='meal_plan'").get().n,3);
});

test('late travel reconciles pending projection without rewriting or rewinding its finalized Rotation history',()=>{
 const mealPlan=plan();generate();const initial=assignments()[0];
 const history=JSON.stringify(getRotationOccurrence(d,initial.rotation_occurrence_id));
 const before=d.prepare("SELECT * FROM rotation_tracks WHERE consumer_type='meal_plan'").get();
 travel(mealPlan.id,[grace]);generate();
 const after=assignments().find(row=>row.id===initial.id);
 assert.equal(after.meal_id,initial.meal_id);assert.equal(after.assigned_user_id,eleanor);
 assert.equal(after.rotation_occurrence_id,initial.rotation_occurrence_id);
 assert.equal(JSON.stringify(getRotationOccurrence(d,initial.rotation_occurrence_id)),history);
 assert.deepEqual(d.prepare('SELECT * FROM rotation_tracks WHERE id=?').get(before.id),before);
 assert.ok(d.prepare("SELECT 1 FROM planning_obligation_events WHERE event='planning_context_reassigned'").get(),'current reassignment has separate existing Meal audit');
 const counts=d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n;
 generate();assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,counts);
});

test('editing membership preserves next stable identity and old meal results',()=>{
 plan();generate();const old=JSON.stringify(getRotationOccurrence(d,assignments()[0].rotation_occurrence_id));
 saveRotationGroup(d,{name:'Kids',member_ids:[frankie,grace,eleanor]},{id:group.id,actorId:admin,expectedRevision:group.revision});
 generate('2026-09-22');assert.equal(assignments()[1].assigned_user_id,eleanor);
 assert.equal(JSON.stringify(getRotationOccurrence(d,assignments()[0].rotation_occurrence_id)),old);
});

test('skipping a planned date creates no Rotation occurrence and consumes no turn',()=>{
 const mealPlan=plan();
 const monday=mealPlan.rules.find(rule=>rule.weekday===0);
 d.prepare("INSERT INTO meal_plan_occurrence_exceptions(meal_plan_rule_id,context_scope,date,action,created_by) VALUES(?,'base','2026-09-21','skip',?)").run(monday.id,admin);
 generate('2026-09-21','2026-09-22');
 assert.equal(assignments().length,1);assert.equal(assignments()[0].assigned_user_id,grace);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,1);
});

test('no eligible member preserves unresolved history and leaves later meals needing assignment without consuming turns',()=>{
 plan();
 d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run();
 generate('2026-09-21','2026-09-24');
 assert.equal(assignments().length,4);
 assert.ok(assignments().every(row=>row.assigned_user_id==null));
 const history=d.prepare('SELECT * FROM rotation_occurrences').all();
 assert.equal(history.length,1);assert.equal(history[0].status,'resolved');assert.equal(history[0].advanced,0);
 assert.equal(d.prepare('SELECT advance_count FROM rotation_tracks').get().advance_count,0);
 const reasons=d.prepare('SELECT provenance_json FROM meals').all().map(row=>JSON.parse(row.provenance_json).rotations.chooser);
 assert.ok(reasons.every(item=>item.state==='needs_assignment'&&item.reason));
});

test('Group deactivation preserves existing outputs and records new Meal needs-assignment without a new resolution',()=>{
 plan();generate();const initial=JSON.stringify(assignments());
 saveRotationGroup(d,{active:false},{id:group.id,actorId:admin,expectedRevision:group.revision});
 generate();assert.equal(JSON.stringify(assignments()),initial);
 generate('2026-09-22');assert.equal(assignments()[1].assigned_user_id,null);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,1);
 const reason=JSON.parse(d.prepare("SELECT provenance_json FROM meals WHERE date='2026-09-22'").get().provenance_json).rotations.chooser;
 assert.equal(reason.reason_code,'rotation_group_inactive');
});

test('authorized Repair chooser rechecks an unresolved occurrence through Meal eligibility and advances once',()=>{
 plan();d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run();
 generate('2026-09-21','2026-09-22');const rows=assignments();const pending=rows[0].rotation_occurrence_id;
 assert.equal(advanceMealChooserFallback(d,rows[0].meal_id,{actorId:admin}).status,'unresolved');
 assert.throws(()=>repairMealChooser(d,rows[0].meal_id,{actorId:grace}),/permission/i);
 d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run(eleanor);
 const repaired=repairMealChooser(d,rows[0].meal_id,{actorId:admin});assert.equal(repaired.fallback.user_id,eleanor);
 assert.equal(assignments()[0].rotation_occurrence_id,pending);assert.equal(getRotationOccurrence(d,pending).advanced,1);
 const before=d.prepare('SELECT * FROM rotation_tracks').all();repairMealChooser(d,rows[0].meal_id,{actorId:admin});
 assert.deepEqual(d.prepare('SELECT * FROM rotation_tracks').all(),before);
 const next=repairMealChooser(d,rows[1].meal_id,{actorId:admin});assert.equal(next.fallback.user_id,eleanor);
 assert.equal(d.prepare('SELECT advance_count FROM rotation_tracks').get().advance_count,2);
});

test('public refresh cannot drop a Meal consumer’s role eligibility',()=>{
 plan();d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run();generate();
 const occurrence=getRotationOccurrence(d,assignments()[0].rotation_occurrence_id);
 assert.throws(()=>refreshRotationOccurrence(d,occurrence.id,{expected_revision:occurrence.revision,actorId:admin}),/consumer|Meal|Activity|Workflow/i);
 assert.deepEqual(getRotationOccurrence(d,occurrence.id),occurrence);
});

test('Recheck rotations independently restores an unavailable Cook without advancing the chooser again',()=>{
 plan({cook_strategy:'round_robin',cook_rotation_group_id:group.id});
 d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE skill_id IN(SELECT id FROM skills WHERE system_key='cooking')").run();generate();
 const chooser=d.prepare("SELECT * FROM rotation_tracks WHERE purpose_key='chooser'").get();
 d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='cooking')").run(eleanor);
 const repaired=repairMealChooser(d,assignments()[0].meal_id,{actorId:admin});assert.equal(repaired.status,'assigned');
 assert.equal(d.prepare("SELECT assigned_user_id FROM meal_occurrence_role_assignments WHERE role='cook'").get().assigned_user_id,eleanor);
 assert.deepEqual(d.prepare('SELECT * FROM rotation_tracks WHERE id=?').get(chooser.id),chooser);
});

test('context reads cannot silently resolve previously unavailable rotation after eligibility changes',()=>{
 const mealPlan=plan();travel(mealPlan.id,[grace]);
 d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run(grace);
 generate();const initial=assignments().find(row=>row.planning_context_id!=null);assert.equal(initial.assigned_user_id,null);
 d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run(grace);
 generate();assert.equal(assignments().find(row=>row.id===initial.id).assigned_user_id,null);
 const repaired=repairMealChooser(d,initial.meal_id,{actorId:admin});assert.equal(repaired.fallback.user_id,grace);
});
