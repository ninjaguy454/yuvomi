import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-shared-skip';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
const {saveRotationGroup}=await import('../server/services/rotation.js');
const {saveRotationGroupUsage,reconcileSharedRotationPeriods}=await import('../server/services/rotation-shared.js');
const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');
const {taskSeriesState,appendSeriesDefinition}=await import('../server/services/task-series.js');
let d,server,base,actor,group,directory,path;
test.beforeEach(async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T23:00:00Z')});
 directory=t.name.startsWith('concurrent')?mkdtempSync(join(tmpdir(),'vidamia-shared-skip-')):null;
 path=directory?join(directory,'synthetic.db'):':memory:';d=new Database(path);d.pragma('foreign_keys=ON');
 if(directory){d.pragma('journal_mode=WAL');d.pragma('busy_timeout=15000');}
 for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
 _setTestDatabase(d);d.exec(`INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'parent','Parent','x','admin','parent'),(2,'child-a','Child A','x','member','child'),(3,'child-b','Child B','x','member','child'); INSERT INTO reward_participants(user_id,enabled) VALUES(2,1),(3,1); INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York');`);
 group=saveRotationGroupUsage(d,{name:'Shared order',member_ids:[2,3],usage_mode:'shared',shared_config:{strategy:'rotating_order',direction:'last_to_first',starting_member_id:2,effective_date:'2026-10-10',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},{actorId:1});
 actor=1;const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=actor;req.authRole=actor===1?'admin':'member';req.authMethod='session';req.session={userId:actor};next();});app.use('/tasks',router);
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/tasks`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));_setTestDatabase(null);d.close();if(directory){assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});}});
const rows=(sql,...args)=>d.prepare(sql).all(...args),read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
async function call(method,path='',body){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()};}
const binding=(id=group.id)=>({purpose_key:'shower_order',label:'Shower Order',group_id:id,strategy:'rotating_order',direction:'last_to_first',advance_policy:'on_finalized',advance_on_skip:false,period_date_offset_days:0});
async function fixture(extra={}){actor=1;const result=await call('POST','',{title:'Synthetic bedtime',assigned_to:[2],start_date:'2026-10-10',start_time:'19:00',due_date:'2026-10-10',due_time:'20:30',due_date_offset_days:0,is_recurring:true,recurrence_from_completion:true,recurrence_rule:'FREQ=DAILY',expiration_policy:'keep_overdue',points:2,scoring_mode:'subtasks',subtasks:[{title:'First action',points:2},{title:'Second action',points:3}],rotation_bindings:[binding()],...extra});assert.equal(result.status,201,JSON.stringify(result));assert.deepEqual(result.data.subtasks.map(x=>x.points),[2,3]);return result.data;}
const request=(task,operation_id=`shared-skip-${task.id}`)=>({operation_id,expected_revision:read(task.id).revision});
const skip=(task,body=request(task))=>call('POST',`/${task.id}/skip`,body);
const next=id=>{const found=rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',id);assert.equal(found.length,1);return found[0];};
const groupState=()=>Object.fromEntries(['rotation_groups','rotation_group_members','rotation_group_schedules','rotation_group_schedule_versions','rotation_group_periods','rotation_tracks','rotation_occurrences','rotation_events','rotation_occurrence_supersessions'].map(table=>[table,rows(`SELECT * FROM ${table} ORDER BY rowid`)]));
const taskTree=id=>rows('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree p ON t.parent_task_id=p.id) SELECT t.* FROM tasks t JOIN tree p ON p.id=t.id ORDER BY t.id',id);
const refs=id=>({links:rows('SELECT * FROM task_rotation_occurrences WHERE task_id=? ORDER BY id',id),periods:rows('SELECT * FROM task_rotation_periods WHERE task_id=? ORDER BY id',id)});
const ledger=()=>rows('SELECT * FROM reward_ledger ORDER BY id');
const tick=now=>reconcileSharedRotationPeriods(d,{now:new Date(now),groupId:group.id,onError:error=>{throw error;}});

// A blanket rotation guard, completion-based Skip or group-wide finalizer fails this.
test('shared resolved order permits one activity Skip with partial earned points and sibling history preserved',async()=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]});actor=2;
 const child=read(task.subtasks[0].id);assert.equal((await call('PATCH',`/${child.id}/status`,{status:'done',expected_revision:child.revision,expected_parent_revision:read(task.id).revision})).status,200);actor=1;
 const state=groupState(),siblingBefore=taskTree(sibling.id),savedRefs=refs(task.id),rewards=ledger(),completions=rows('SELECT * FROM task_completions ORDER BY rowid'),definitions=rows('SELECT * FROM task_recurrence_definitions ORDER BY id'),grants=rows('SELECT * FROM access_capabilities ORDER BY rowid');
 assert.ok(rewards.some(row=>row.task_id===child.id));const detail=await call('GET',`/${task.id}`);assert.equal(detail.data.permissions.skip_occurrence,true);assert.equal(detail.data.can_skip_occurrence,true);
 const body=request(task),result=await skip(task,body);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.status,'skipped');assert.equal(result.recurrence_pending,false);
 assert.equal(read(child.id).status,'done');assert.equal(read(task.subtasks[1].id).status,'skipped');assert.deepEqual(ledger(),rewards);assert.deepEqual(rows('SELECT * FROM task_completions ORDER BY rowid'),completions);
 assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.deepEqual(refs(task.id),savedRefs);assert.deepEqual(rows('SELECT * FROM task_recurrence_definitions ORDER BY id'),definitions);assert.deepEqual(rows('SELECT * FROM access_capabilities ORDER BY rowid'),grants);
 const successor=next(task.id);assert.equal(successor.start_date,'2026-10-11');assert.equal(successor.due_date,'2026-10-11');assert.equal(successor.status,'open');assert.equal(successor.rotation_bindings_json,read(task.id).rotation_bindings_json);assert.equal(refs(successor.id).periods[0].occurrence_id,null);
 const replay=await skip(task,body);assert.equal(replay.status,200);assert.equal(replay.replayed,true);assert.equal(next(task.id).id,successor.id);assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.deepEqual(ledger(),rewards);
 assert.equal(rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='skipped'",task.id).length,1);assert.equal(rows('SELECT * FROM task_skip_receipts').length,1);
 assert.equal((await skip(task,request(task,'different-operation'))).status,409);
});

test('shared finalized order stays finalized and advances neither its cursor nor a sibling when Skip creates the currently open next period',async t=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]});t.mock.timers.setTime(Date.parse('2026-10-11T07:00:00Z'));tick('2026-10-11T07:00:00Z');
 assert.equal(groupState().rotation_occurrences[0].status,'finalized');assert.equal(groupState().rotation_tracks[0].advance_count,1);
 t.mock.timers.setTime(Date.parse('2026-10-11T23:00:00Z'));const state=groupState(),siblingBefore=taskTree(sibling.id),savedRefs=refs(task.id);
 const result=await skip(task);assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.deepEqual(refs(task.id),savedRefs);assert.equal(next(task.id).due_date,'2026-10-11');assert.equal(refs(next(task.id).id).periods[0].occurrence_id,null);
 tick('2026-10-11T23:00:00Z');assert.equal(groupState().rotation_occurrences.length,2);assert.equal(groupState().rotation_tracks[0].advance_count,1);assert.ok(refs(next(task.id).id).periods[0].occurrence_id);
 tick('2026-10-12T07:00:00Z');tick('2026-10-12T07:00:00Z');assert.equal(groupState().rotation_tracks[0].advance_count,2);assert.equal(read(task.id).status,'skipped');assert.equal(read(sibling.id).status,'open');
});

test('shared provisional references permit Skip before activation without creating or consuming a group period',async t=>{
 t.mock.timers.setTime(Date.parse('2026-10-10T17:00:00Z'));const task=await fixture(),sibling=await fixture({assigned_to:[3]});assert.equal(refs(task.id).periods[0].occurrence_id,null);
 const state=groupState(),siblingBefore=taskTree(sibling.id);assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,true);
 assert.equal((await skip(task)).status,200);assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.equal(next(task.id).due_date,'2026-10-11');assert.equal(ledger().length,0);
});

test('shared overdue Skip advances exactly one nominal slot and preserves existing scheduled orders',async t=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]});t.mock.timers.setTime(Date.parse('2026-10-13T17:00:00Z'));tick('2026-10-13T17:00:00Z');
 const state=groupState(),siblingBefore=taskTree(sibling.id);const result=await skip(task);assert.equal(result.status,200,JSON.stringify(result));assert.equal(next(task.id).due_date,'2026-10-11');assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.equal(ledger().length,0);
});

test('shared Skip commits one receipt on failed materialization and recovers consumer-only without changing an open group period',async t=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]}),body=request(task);
 d.exec(`CREATE TRIGGER synthetic_shared_skip_failure BEFORE INSERT ON tasks WHEN NEW.recurrence_origin_id=${task.id} BEGIN SELECT RAISE(ABORT,'Synthetic shared failure'); END;`);
 const result=await skip(task,body);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.recurrence_pending,true);assert.equal(read(task.id).status,'skipped');assert.equal((await skip(task,body)).recurrence_pending,true);d.exec('DROP TRIGGER synthetic_shared_skip_failure');
 t.mock.timers.setTime(Date.parse('2026-10-11T07:00:00Z'));tick('2026-10-11T07:00:00Z');t.mock.timers.setTime(Date.parse('2026-10-11T23:00:00Z'));const state=groupState(),siblingBefore=taskTree(sibling.id);
 assert.equal(reconcileTaskExpirations(d,{onError:error=>{throw error;}}).failed,0);assert.equal(next(task.id).due_date,'2026-10-11');assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.equal((await skip(task,body)).recurrence_pending,false);assert.equal(rows('SELECT * FROM task_skip_receipts').length,1);
 const successorBefore=taskTree(next(task.id).id),successorRefs=refs(next(task.id).id);reconcileTaskExpirations(d,{onError:error=>{throw error;}});assert.deepEqual(taskTree(next(task.id).id),successorBefore);assert.deepEqual(refs(next(task.id).id),successorRefs);assert.deepEqual(groupState(),state);
});

test('shared ownership exception retains independent rotations and round-robin exclusions without effects',async()=>{
 const independent=saveRotationGroup(d,{name:'Independent order',member_ids:[2,3]},{actorId:1});
 for(const extra of [{rotation_bindings:[binding(independent.id)]},{assignment_mode:'round_robin',rotation_user_ids:[2,3]}]){
   const task=await fixture(extra),state=groupState(),before=taskTree(task.id);assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,false);const result=await skip(task);assert.equal(result.status,409);assert.equal(result.reason,'skip_unsupported');assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(task.id),before);
 }
 assert.equal(rows('SELECT * FROM task_skip_receipts').length,0);
});

test('shared ownership exception rejects orphan purposes, retained independent links and authoritative independent definitions',async()=>{
 const independent=saveRotationGroup(d,{name:'Independent history',member_ids:[2,3]},{actorId:1}),legacy=await fixture({rotation_bindings:[binding(independent.id)]}),oldLink=refs(legacy.id).links[0];
 for(const mode of ['orphan','retired-independent','definition-independent']){
   const task=await fixture();
   if(mode==='orphan'){d.prepare('DELETE FROM task_rotation_occurrences WHERE task_id=?').run(task.id);d.prepare('DELETE FROM task_rotation_periods WHERE task_id=?').run(task.id);}
   if(mode==='retired-independent')d.prepare("INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id,retired_at) VALUES(?,?,?,?,?,'2026-10-10T23:00:00Z')").run(task.id,'legacy_independent',oldLink.track_id,oldLink.occurrence_id,task.id);
   if(mode==='definition-independent'){const state=taskSeriesState(d,task.id),definition=structuredClone(state.definition.data);definition.task.rotation_bindings_json=JSON.stringify([binding(independent.id)]);appendSeriesDefinition(d,task.id,{actorId:1,definition,effectiveGeneration:state.occurrence.generation+1,force:true});}
   const state=groupState(),before=taskTree(task.id);assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,false);assert.equal((await skip(task)).status,409);assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(task.id),before);
 }
});

const template=(strategy='subject_skill')=>Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,subject_required,active,created_by,rotation_bindings_json) VALUES(?,?,?,1,1,1,?)`).run(`Synthetic ${strategy}`,'Synthetic subject bedtime',strategy,JSON.stringify([binding()])).lastInsertRowid);
test('shared subject-based template Skip retains the subject and template assignment cursors',async()=>{
 const id=template(),task=await fixture({activity_template_id:id,activity_subject_user_id:2,assigned_to:undefined}),sibling=await fixture({activity_template_id:id,activity_subject_user_id:3,assigned_to:undefined});
 const state=groupState(),siblingBefore=taskTree(sibling.id),cursors=rows('SELECT * FROM activity_rotation_state ORDER BY rowid');assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,true);
 const result=await skip(task);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.recurrence_pending,false);assert.equal(next(task.id).assigned_to,2);assert.equal(next(task.id).due_date,'2026-10-11');assert.deepEqual(rows('SELECT * FROM activity_rotation_state ORDER BY rowid'),cursors);assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);
});

for(const removeFuturePurposes of [false,true])test(removeFuturePurposes
 ?'shared future purpose removal cannot consume either template assignment cursor during Skip'
 :'shared subject helper resolution cannot consume an independent activity assignment turn during Skip',async()=>{
 const id=template(),skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic skill',0,'supervised',1)").run().lastInsertRowid);
 d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id,sort_order) VALUES(?,?,0)').run(id,skill);
 for(const [userId,proficiency] of [[1,'normal'],[2,'excluded'],[3,'normal']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(userId,skill,proficiency);
 const task=await fixture({activity_template_id:id,activity_subject_user_id:2,assigned_to:undefined});
 if(removeFuturePurposes){const occurrence=taskSeriesState(d,task.id),definition=structuredClone(occurrence.definition.data);definition.task.rotation_bindings_json='[]';appendSeriesDefinition(d,task.id,{actorId:1,definition,effectiveGeneration:occurrence.occurrence.generation+1,force:true});}
 const cursors=rows('SELECT * FROM activity_rotation_state ORDER BY rowid'),assignmentCursors=rows('SELECT * FROM assignment_rotation_state ORDER BY rowid');assert.ok(cursors.length>0,'the fixture must contain a real assignment cursor');const state=groupState();assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,true);
 const result=await skip(task);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.recurrence_pending,false);assert.equal(next(task.id).due_date,'2026-10-11');assert.equal(next(task.id).rotation_bindings_json,removeFuturePurposes?'[]':read(task.id).rotation_bindings_json);assert.deepEqual(rows('SELECT * FROM activity_rotation_state ORDER BY rowid'),cursors);assert.deepEqual(rows('SELECT * FROM assignment_rotation_state ORDER BY rowid'),assignmentCursors);assert.deepEqual(groupState(),state);assert.equal(ledger().length,0);
});

test('shared exception excludes an independent template assignment policy even after the next definition removes shared purposes',async()=>{
 const id=template(),task=await fixture({activity_template_id:id,activity_subject_user_id:2});const state=taskSeriesState(d,task.id),definition=structuredClone(state.definition.data);
 definition.binding.snapshot.assignment_strategy='eligible_round_robin';definition.binding.assignment_override_user_id=null;definition.task.rotation_bindings_json='[]';appendSeriesDefinition(d,task.id,{actorId:1,definition,effectiveGeneration:state.occurrence.generation+1,force:true});
 const before=groupState(),cursors=rows('SELECT * FROM activity_rotation_state ORDER BY rowid');assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,false);assert.equal((await skip(task)).status,409);assert.deepEqual(groupState(),before);assert.deepEqual(rows('SELECT * FROM activity_rotation_state ORDER BY rowid'),cursors);
});

test('shared Skip recovery pauses after an authoritative independent edit and resumes once shared ownership is restored',async()=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]}),body=request(task),original=structuredClone(taskSeriesState(d,task.id).definition.data);
 d.exec(`CREATE TRIGGER synthetic_shared_edit_failure BEFORE INSERT ON tasks WHEN NEW.recurrence_origin_id=${task.id} BEGIN SELECT RAISE(ABORT,'Synthetic shared edit failure'); END;`);const result=await skip(task,body);assert.equal(result.status,200);assert.equal(result.recurrence_pending,true);d.exec('DROP TRIGGER synthetic_shared_edit_failure');
 const independent=saveRotationGroup(d,{name:'Independent future',member_ids:[2,3]},{actorId:1}),definition=structuredClone(original);definition.task.rotation_bindings_json=JSON.stringify([binding(independent.id)]);const state=taskSeriesState(d,task.id);appendSeriesDefinition(d,task.id,{actorId:1,definition,effectiveGeneration:state.occurrence.generation+1,force:true});
 const before=groupState(),siblingBefore=taskTree(sibling.id),errors=[];assert.equal(reconcileTaskExpirations(d,{onError:error=>errors.push(error)}).failed,1);assert.match(errors[0].message,/Rotation work/);assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',task.id).length,0);assert.equal((await skip(task,body)).recurrence_pending,true);assert.deepEqual(groupState(),before);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.equal(rows('SELECT * FROM task_skip_receipts').length,1);
 appendSeriesDefinition(d,task.id,{actorId:1,definition:original,effectiveGeneration:state.occurrence.generation+1,force:true});assert.equal(reconcileTaskExpirations(d,{onError:error=>{throw error;}}).failed,0);assert.equal(next(task.id).due_date,'2026-10-11');assert.deepEqual(groupState(),before);assert.deepEqual(taskTree(sibling.id),siblingBefore);
});

test('shared next nominal period cannot cross an approved independent mode boundary',async()=>{
 const task=await fixture();const schedule=d.prepare('SELECT id FROM rotation_group_schedules WHERE group_id=?').get(group.id);
 d.prepare(`INSERT INTO rotation_group_schedule_versions(schedule_id,usage_mode,effective_date,timezone,config_json,members_json,independent_starts_json,actor_user_id) SELECT schedule_id,'independent','2026-10-11',timezone,config_json,members_json,'[]',1 FROM rotation_group_schedule_versions WHERE schedule_id=? ORDER BY id DESC LIMIT 1`).run(schedule.id);
 const before=groupState(),taskBefore=taskTree(task.id);assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,false);assert.equal((await skip(task)).status,409);assert.deepEqual(groupState(),before);assert.deepEqual(taskTree(task.id),taskBefore);
});

test('shared Skip keeps child, device, archived, stale-revision and completed-state protections',async()=>{
 const task=await fixture(),body=request(task);actor=2;assert.equal((await skip(task,body)).status,403);actor=1;assert.equal((await skip(task,{...body,expected_revision:body.expected_revision+1})).status,409);
 const {skipTaskOccurrence}=await import('../server/services/task-skip.js');assert.throws(()=>skipTaskOccurrence(d,task.id,{principal:{kind:'device',id:1},body}),{status:403});
 assert.equal((await call('PATCH',`/${task.id}/archive`,{archived:true,expected_revision:read(task.id).revision})).status,200);assert.equal((await skip(task)).status,409);assert.equal(read(task.id).status,'open');assert.equal(rows('SELECT * FROM task_skip_receipts').length,0);
 const completed=await fixture();assert.equal((await call('PATCH',`/${completed.id}/status`,{status:'done',complete_remaining:true,expected_revision:read(completed.id).revision})).status,200);const rewards=ledger();assert.equal((await skip(completed)).status,409);assert.deepEqual(ledger(),rewards);
});

async function race(task,modes,now){
 const revision=read(task.id).revision;const workers=modes.map(mode=>{
   const child=fork(fileURLToPath(new URL('./task-skip-shared-race-worker.mjs',import.meta.url)),[JSON.stringify({path,actorId:1,taskId:task.id,revision,mode,now,groupId:group.id})],{execPath:process.execPath,env:{...process.env,DB_PATH:':memory:'},stdio:['ignore','pipe','pipe','ipc']});
   let readyResolve,readyReject,resultResolve,resultReject,outcome,output='';const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;}),result=new Promise((r,j)=>{resultResolve=r;resultReject=j;});result.catch(()=>{});const timer=setTimeout(()=>child.kill(),30000);
   child.on('message',message=>{if(message.type==='ready')readyResolve();else if(message.type==='result')outcome=message.outcome;});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-6000));
   child.on('error',error=>{clearTimeout(timer);readyReject(error);resultReject(error);});child.on('exit',code=>{clearTimeout(timer);if(code===0&&outcome)resultResolve(outcome);else{const error=new Error(`${mode} worker ${code}: ${output}`);readyReject(error);resultReject(error);}});return {child,ready,result};
 });
 try{await Promise.all(workers.map(worker=>worker.ready));for(const worker of workers)worker.child.send({run:true});return await Promise.all(workers.map(worker=>worker.result));}catch(error){for(const worker of workers)worker.child.kill();throw error;}
}

test('concurrent shared same-operation Skip writers make one receipt, audit and successor without group or sibling writes',async()=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]}),state=groupState(),siblingBefore=taskTree(sibling.id);const outcomes=await race(task,['skip','skip'],'2026-10-10T23:00:00Z');assert.ok(outcomes.every(row=>row.ok),JSON.stringify(outcomes));assert.equal(outcomes.filter(row=>row.value.replayed).length,1);assert.equal(rows('SELECT * FROM task_skip_receipts').length,1);assert.equal(rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='skipped'",task.id).length,1);assert.equal(next(task.id).due_date,'2026-10-11');assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);assert.equal(ledger().length,0);
});

test('concurrent shared completion and Skip serialize into one result and one valid successor',async()=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]}),state=groupState(),siblingBefore=taskTree(sibling.id);const outcomes=await race(task,['skip','complete'],'2026-10-10T23:00:00Z');const status=read(task.id).status;assert.ok(['done','skipped'].includes(status),JSON.stringify(outcomes));assert.equal(outcomes.filter(row=>row.ok).length,1);assert.equal(next(task.id).due_date,'2026-10-11');assert.equal(rows("SELECT * FROM reward_ledger WHERE task_id=? AND type='earn'",task.id).length,status==='done'?1:0);assert.deepEqual(groupState(),state);assert.deepEqual(taskTree(sibling.id),siblingBefore);
});

test('concurrent shared scheduler and Skip leave scheduler sole owner of finalization and advance exactly once',async()=>{
 const task=await fixture(),sibling=await fixture({assigned_to:[3]}),siblingBefore=taskTree(sibling.id);const outcomes=await race(task,['skip','schedule'],'2026-10-11T07:00:00Z');assert.ok(outcomes.every(row=>row.ok),JSON.stringify(outcomes));assert.equal(read(task.id).status,'skipped');assert.equal(next(task.id).due_date,'2026-10-11');assert.equal(groupState().rotation_tracks[0].advance_count,1);assert.equal(groupState().rotation_occurrences[0].status,'finalized');assert.deepEqual(taskTree(sibling.id),siblingBefore);tick('2026-10-11T07:00:00Z');assert.equal(groupState().rotation_tracks[0].advance_count,1);assert.equal(ledger().length,0);
});
